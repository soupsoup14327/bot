/**
 * autoplay-prefetch-runner.js — Two-Phase Proactive Candidate Prefetch
 *
 * Runs two background search phases when a track starts playing:
 *
 *   Phase 1 (fast) — fires after ~1 s
 *     • No Groq, no query fanout
 *     • 1 direct yt-dlp search on the normalised current-track title
 *     • 1–2 candidates, same quality guards as the full spawn
 *     • Calls storeFast → does NOT bump generation
 *     • Goal: populate the pool before a quick skip happens
 *
 *   Phase 2 (full) — fires after ~15 s
 *     • Full Groq retrieval + yt-dlp search (identical to regular spawn)
 *     • Calls storeFull → validates freshness, then bumps generation atomically
 *     • Supersedes fast pool automatically (gen mismatch makes fast stale)
 *     • Goal: supply higher-quality candidates for the next autoplay cycle
 *
 * Version model (no-conflict guarantee):
 *   - Both phases capture sessionId + prefetchGeneration at their own start.
 *   - Phase 1 writes at capturedGen (no bump) — stale guards protect correctness.
 *   - Phase 2 bumps gen inside storeFull; phase 1's entry then fails the gen check
 *     in popBestCandidate automatically (no explicit delete needed).
 *   - Any external gen bump (skip, user_enqueue, etc.) makes both phases abort
 *     via the stale check before store.
 *
 * Per-phase per-guild locks prevent duplicate concurrent runs of the same phase.
 *
 * @typedef {{
 *   isAutoplayOn:   () => boolean,
 *   buildPivotSeed: () => string | null,
 *   searchByQuery:  (query: string, opts: { pickN: number, guildId: string }) => Promise<import('./autoplay-prefetch.js').VideoInfo[]>,
 *   searchByArtist: (artist: string, opts: { pickN: number, guildId: string }) => Promise<import('./autoplay-prefetch.js').VideoInfo[]>,
 *   isUrlBlocked:   (url: string) => boolean,
 * }} PrefetchCtx
 */

import {
  getAutoplaySessionSnapshot,
  isAutoplayResolving,
} from './autoplay-session-state.js';
import { buildAutoplaySpawnContext } from './autoplay-spawn-context.js';
import { pickAutoplayRetrieval } from './autoplay-engine.js';
import { rankAutoplayCandidates } from './candidate-ranker.js';
import {
  isPlayabilityHardSkipEnabled,
  isUrlMarkedBad,
} from './playability-cache.js';
import {
  getSessionId,
  getPrefetchGeneration,
} from './guild-session-state.js';
import {
  storeFast,
  storeFull,
  getPoolSize,
} from './autoplay-prefetch.js';
import {
  normalizeTitleForContext,
  countTrailingAlternateStreak,
  searchOnceForPrefetch,
} from './youtube-search.js';
import { detectDominantArtist } from './autoplay-artist-tokens.js';
import { getNegativeContext, getPositiveContext } from './recommendation-bridge.js';
import { autoplayDebug } from './autoplay-telemetry.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Minimum pool depth before prefetch is worth running. */
const PROACTIVE_PREFETCH_MIN_POOL =
  Number(process.env.AUTOPLAY_PREFETCH_MIN_POOL) || 2;

/** Delay before fast phase starts (ms). Lets the track stabilise. */
const PREFETCH_FAST_DELAY_MS =
  Number(process.env.AUTOPLAY_PREFETCH_FAST_DELAY_MS) || 1_000;

/** Delay before full phase starts (ms). Groq-guided, higher quality. */
const PREFETCH_FULL_DELAY_MS =
  Number(process.env.AUTOPLAY_PREFETCH_FULL_DELAY_MS) || 15_000;

/** Results requested from yt-dlp for the fast phase (some will be filtered). */
const FAST_SEARCH_LIMIT = 8;

/** Max candidates stored from the fast phase (1–2, cheap by design). */
const FAST_CANDIDATES_MAX = 2;

/** Max candidates from the full phase (same as prior single-phase runner). */
const FULL_PICK_N = 4;

/** Results requested from yt-dlp for the full phase (filtered before storing). */
const FULL_SEARCH_LIMIT = 8;

// ─── Per-phase per-guild locks ────────────────────────────────────────────────

const _fastRunningByGuild = new Set();
const _fullRunningByGuild = new Set();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire both prefetch phases for a guild (synchronous launcher).
 * Call with `void` — never awaited.
 *
 * @param {string} guildId
 * @param {string} seedQuery  — title of the currently playing track
 * @param {PrefetchCtx} ctx   — runtime dependencies injected from music.js
 */
export function runProactivePrefetch(guildId, seedQuery, ctx) {
  const id = String(guildId);

  if (!ctx.isAutoplayOn()) {
    console.log(
      `[prefetch] пропуск — автоплей ВЫКЛ guild=${id} (включите ∞ для фонового поиска)`,
    );
    return;
  }
  if (isAutoplayResolving(id)) return;
  if (getPoolSize(id) >= PROACTIVE_PREFETCH_MIN_POOL) return;

  void _runFastPhase(id, seedQuery, ctx);
  void _runFullPhase(id, seedQuery, ctx);
}

// ─── Phase 1: Fast ────────────────────────────────────────────────────────────

/**
 * Fast phase: 1 direct yt-dlp search, no Groq, 1-2 candidates.
 * Writes to :fast bucket via storeFast (no gen bump).
 */
async function _runFastPhase(guildId, seedQuery, ctx) {
  const id = String(guildId);
  if (_fastRunningByGuild.has(id)) return;

  _fastRunningByGuild.add(id);
  const tStart = Date.now();
  try {
    // ── Brief delay: let the track stabilise ────────────────────────────────
    await _sleep(PREFETCH_FAST_DELAY_MS);

    if (!ctx.isAutoplayOn()) return;
    if (isAutoplayResolving(id)) return;
    if (getPoolSize(id) >= PROACTIVE_PREFETCH_MIN_POOL) return;

    // Snapshot version at phase start (after delay)
    const capturedSessionId = getSessionId(id);
    if (!capturedSessionId) return;
    const capturedGen = getPrefetchGeneration(id);

    // ── Semantic seed (cheap — no LLM) ──────────────────────────────────────
    const normalizedTitle = normalizeTitleForContext(String(seedQuery));
    if (!normalizedTitle) return;

    autoplayDebug(id, 'prefetch-fast', {
      phase:      'start',
      seed:       normalizedTitle.slice(0, 60),
      capturedGen,
    });
    console.log(
      `[prefetch:fast] поиск guild=${id} seed="${normalizedTitle.slice(0, 60)}"`,
    );

    // ── Single direct search — 1 yt-dlp process, no fanout ──────────────────
    const results = await searchOnceForPrefetch(normalizedTitle, FAST_SEARCH_LIMIT);

    // Stale check after search
    if (getSessionId(id) !== capturedSessionId || getPrefetchGeneration(id) !== capturedGen) {
      autoplayDebug(id, 'prefetch-fast', { phase: 'stale_after_search' });
      return;
    }
    if (!ctx.isAutoplayOn()) return;
    if (!results.length) {
      autoplayDebug(id, 'prefetch-fast', { phase: 'no_results' });
      return;
    }

    // ── Quality guards — same contract as full spawn, without variety penalty ─
    const ranked = rankAutoplayCandidates(results, {
      isMarkedBad:             (url) => isPlayabilityHardSkipEnabled() && isUrlMarkedBad(url),
      isRecentBlocked:         (url) => ctx.isUrlBlocked(url),
      isArtistCooldownBlocked: () => false,
    });
    const valid = ranked.filter((it) => !it._ranker?.rejected && it?.url && it?.title);

    if (!valid.length) {
      autoplayDebug(id, 'prefetch-fast', { phase: 'all_filtered' });
      return;
    }

    // Final stale check before store
    if (getSessionId(id) !== capturedSessionId || getPrefetchGeneration(id) !== capturedGen) {
      autoplayDebug(id, 'prefetch-fast', { phase: 'stale_before_store' });
      return;
    }

    // storeFast: writes to :fast, does NOT bump generation
    const toStore = valid.slice(0, FAST_CANDIDATES_MAX);
    storeFast(id, { sessionId: capturedSessionId, generation: capturedGen, candidates: toStore });

    const elapsed = Date.now() - tStart;
    autoplayDebug(id, 'prefetch-fast', {
      phase:      'stored',
      count:      toStore.length,
      generation: capturedGen,
      elapsed_ms: elapsed,
    });
    console.log(
      `[prefetch:fast] ✓ сохранено ${toStore.length} кандидатов guild=${id}` +
      ` gen=${capturedGen} (${elapsed}ms)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    autoplayDebug(id, 'prefetch-fast', { phase: 'error', error: msg });
    console.warn(`[prefetch:fast] ошибка guild=${id}:`, msg);
  } finally {
    _fastRunningByGuild.delete(id);
  }
}

// ─── Phase 2: Full ────────────────────────────────────────────────────────────

/**
 * Full phase: Groq retrieval + yt-dlp search, ~4 candidates.
 * Calls storeFull which validates session+gen freshness, bumps generation,
 * and writes to :full bucket — superseding the fast pool atomically.
 */
async function _runFullPhase(guildId, seedQuery, ctx) {
  const id = String(guildId);
  if (_fullRunningByGuild.has(id)) return;

  _fullRunningByGuild.add(id);
  try {
    // ── Startup delay ────────────────────────────────────────────────────────
    await _sleep(PREFETCH_FULL_DELAY_MS);

    if (!ctx.isAutoplayOn()) return;
    if (isAutoplayResolving(id)) return;

    // Snapshot version at phase start (after delay)
    const capturedSessionId = getSessionId(id);
    if (!capturedSessionId) return;
    const capturedGen = getPrefetchGeneration(id);

    autoplayDebug(id, 'prefetch-full', {
      phase:      'start',
      seed:       String(seedQuery).slice(0, 80),
      capturedGen,
    });
    console.log(
      `[prefetch:full] поиск guild=${id} seed="${String(seedQuery).slice(0, 60)}"`,
    );

    // ── Build spawn context (same as regular spawn) ──────────────────────────
    const session = getAutoplaySessionSnapshot(id);
    const {
      sessionTitles,
      initialSeed,
      lastIntent,
      playedTitles,
      positiveCtx,
      negativeCtx,
      usedQueries,
      pivotToAnchor,
      effectiveSeed,
    } = buildAutoplaySpawnContext({
      guildId:              id,
      seedQuery:            String(seedQuery),
      session,
      normalizeTitle:       normalizeTitleForContext,
      getPositiveContext,
      getNegativeContext,
      detectDominantArtist,
      buildAutoplayPivotSeed: ctx.buildPivotSeed,
    });

    // ── Groq retrieval ───────────────────────────────────────────────────────
    const alternateStreak = countTrailingAlternateStreak(sessionTitles);
    const { allQueries, artistCandidates } = await pickAutoplayRetrieval(
      {
        guildId:              id,
        effectiveSeed:        String(effectiveSeed),
        pivotToAnchor,
        playedTitles,
        positiveCtx,
        negativeCtx,
        usedQueries,
        lastIntent,
        initialSeed,
        topic:                session.topicIntent,
        identityIntent:       session.identityIntent,
        sessionTitlesForFast: sessionTitles,
        alternateStreakFast:   alternateStreak,
        serverHints:          [], // prefetch skips server-hints to reduce latency
      },
      {
        onGroqCall: () => {},
        debug:      (stage, meta) => autoplayDebug(id, `prefetch-full:${stage}`, meta),
      },
    );

    // Stale check after Groq
    if (getSessionId(id) !== capturedSessionId || getPrefetchGeneration(id) !== capturedGen) {
      autoplayDebug(id, 'prefetch-full', { phase: 'stale_after_groq' });
      console.log(`[prefetch:full] устарело после Groq guild=${id} — отбрасываем`);
      return;
    }
    if (isAutoplayResolving(id)) {
      autoplayDebug(id, 'prefetch-full', { phase: 'abort_spawn_in_progress' });
      return;
    }
    if (!ctx.isAutoplayOn()) return;

    // ── Single direct search: 1 yt-dlp process, no fanout ───────────────────
    // Prefetch must never saturate the search semaphore — the regular spawn needs
    // those slots. We pick the best available query: artist-mode first, else text query.
    const searchSeed = artistCandidates[0]
      ? `${artistCandidates[0]} song`
      : (allQueries[0] ?? normalizeTitleForContext(String(seedQuery)));

    const rawItems = await searchOnceForPrefetch(searchSeed, FULL_SEARCH_LIMIT);

    // Stale check after search
    if (getSessionId(id) !== capturedSessionId || getPrefetchGeneration(id) !== capturedGen) {
      autoplayDebug(id, 'prefetch-full', { phase: 'stale_after_search' });
      console.log(`[prefetch:full] устарело после поиска guild=${id} — отбрасываем`);
      return;
    }
    if (isAutoplayResolving(id)) {
      autoplayDebug(id, 'prefetch-full', { phase: 'abort_spawn_after_search' });
      return;
    }
    if (!ctx.isAutoplayOn()) return;

    const items = rawItems;
    if (!items.length) {
      autoplayDebug(id, 'prefetch-full', { phase: 'no_results' });
      return;
    }

    // ── Quality guards ───────────────────────────────────────────────────────
    const ranked = rankAutoplayCandidates(items, {
      isMarkedBad:             (url) => isPlayabilityHardSkipEnabled() && isUrlMarkedBad(url),
      isRecentBlocked:         (url) => ctx.isUrlBlocked(url),
      isArtistCooldownBlocked: () => false,
    });
    const valid = ranked.filter((it) => !it._ranker?.rejected && it?.url && it?.title);

    if (!valid.length) {
      autoplayDebug(id, 'prefetch-full', { phase: 'all_filtered' });
      return;
    }

    // ── storeFull: validates session+gen, bumps generation, writes :full ─────
    // If stale between the last check and here, storeFull returns { stored: false }.
    const storeResult = storeFull(id, {
      sessionId:         capturedSessionId,
      capturedGeneration: capturedGen,
      candidates:        valid,
    });

    if (!storeResult.stored) {
      autoplayDebug(id, 'prefetch-full', { phase: 'stale_at_store' });
      console.log(`[prefetch:full] стало устаревшим при записи guild=${id}`);
      return;
    }

    autoplayDebug(id, 'prefetch-full', {
      phase:      'stored',
      count:      valid.length,
      generation: storeResult.newGen,
    });
    console.log(
      `[prefetch:full] ✓ сохранено ${valid.length} кандидатов guild=${id} gen=${storeResult.newGen}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    autoplayDebug(id, 'prefetch-full', { phase: 'error', error: msg });
    console.warn(`[prefetch:full] ошибка guild=${id}:`, msg);
  } finally {
    _fullRunningByGuild.delete(id);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** @param {number} ms */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
