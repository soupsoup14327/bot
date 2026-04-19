/**
 * autoplay-spawn.js
 *
 * Выделен из `music.js` в Шаге 8.
 *
 * Содержит полный pipeline подбора следующего трека для автоплея:
 *   - `isYoutubeUrlBlockedForAutoplaySpawns` — recent-history guard (used тж. в `runPlayNext`/prefetch).
 *   - `createAutoplaySpawnStaleGuard` — фаза-aware guard против запоздавших результатов.
 *   - `createAutoplaySpawner(deps)` — фабрика, возвращает `{ spawnAutoplayPlaylist(guildId, seedQuery) }`.
 *
 * Почему фабрика (а не прямая функция):
 *   `spawn` дергает два music-local callback'а, которые нельзя разрезолвить импортом:
 *     - `notifyPlaybackUiRefresh(guildId)` — triggers UI refresh (setOnPlaybackUiRefresh).
 *     - `getOnAutoplaySpawned()` — читает текущее значение registered-callback из music.js.
 *   Все остальные зависимости — чистые импорты из domain-модулей (voice-adapter,
 *   player-controller, queue-manager, autoplay-engine, autoplay-prefetch и т.д.) и
 *   не ходят через deps, чтобы не раздувать контракт.
 *
 * Поведение 1:1 с pre-extract music.js::spawnAutoplayPlaylist. Рефакторинг чисто
 * структурный: ни одна ветка решения, ни одна строка метрики не изменилась. Ссылки
 * на типизированные outcome'ы (`queued`/`skip`/`fail`) и форматы `logAutoplaySpawn`
 * — идентичны до декомпозиции.
 */

import { isConnectionAlive } from './voice-adapter.js';
import { isPlaying as isPlayerPlaying } from './player-controller.js';
import {
  enqueueTrackIfNotQueued,
  getQueueLength,
  getQueueOps,
} from './queue-manager.js';
import { sameYoutubeContent } from './queue-invariants.js';
import {
  autoplayByGuild,
  currentPlayingLabelByGuild,
  currentPlayingUrlByGuild,
  getPrefetchGeneration,
  getSessionId,
  incrementPrefetchGeneration,
} from './guild-session-state.js';
import {
  getAutoplaySessionSnapshot,
  beginAutoplayResolving,
  endAutoplayResolving,
  pushAutoplayUsedQuery,
  buildAutoplayPivotSeed,
} from './autoplay-session-state.js';
import {
  attachAutoplayEscapeSpawnId,
  consumeAutoplayEscapeDFallbackPending,
  getAutoplayEscapeSnapshot,
} from './autoplay-escape-state.js';
import {
  isAutoplayEscapeContrastActivePhase,
  resolveAutoplayEscapeRetrievalOverride,
} from './autoplay-escape-retrieval.js';
import { buildAutoplaySpawnContext } from './autoplay-spawn-context.js';
import {
  bumpAutoplaySpawnGeneration,
  checkAutoplaySpawnStaleDiscard,
} from './autoplay-stale-guard.js';
import {
  recordAutoplaySpawnBadOutcome,
  recordAutoplaySpawnSuccess,
} from './autoplay-recovery.js';
import {
  computeVarietyRankPenalty,
  isVarietyControllerEnabled,
  recordVarietyStateAfterSpawn,
} from './autoplay-variety.js';
import {
  autoplayDebug,
  getAutoplayArtistCooldownWindow,
  isAutoplayArtistCooldownEnabled,
} from './autoplay-telemetry.js';
import {
  detectDominantArtist,
  extractLeadArtistTokenFromTitle as extractLeadArtistToken,
} from './autoplay-artist-tokens.js';
import {
  consumeAutoplayArtistQuarantineSpawn,
  filterAutoplayCandidatesByArtistQuarantine,
  isAutoplayArtistQuarantineEnabled,
  isArtistQuarantined,
} from './autoplay-artist-quarantine.js';
import { buildDistinctArtistShortlist } from './autoplay-distinct-artists.js';
import { baselineGroqCall } from './autoplay-baseline.js';
import { pickAutoplayRetrieval } from './autoplay-engine.js';
import { rankAutoplayCandidates } from './candidate-ranker.js';
import { getNegativeContext, getPositiveContext, syncAndGetHints } from './recommendation-bridge.js';
import {
  isPlayabilityHardSkipEnabled,
  isUrlMarkedBad,
} from './playability-cache.js';
import { isPlaybackMetricsEnabled, logAutoplaySpawn } from './playback-metrics.js';
import { getSessionPlayedWatchUrls } from './idle-navigation-state.js';
import {
  countTrailingAlternateStreak,
  getAutoplayAltStreakMin,
  normalizeTitleForContext,
  pickDistinctTrackVideos,
  pickTracksForArtist,
} from './youtube-search.js';
import { getPoolSize, popBestCandidate, storeSurplus } from './autoplay-prefetch.js';

function buildAutoplaySpawnId(sessionId, spawnGen) {
  return `spawn:${String(sessionId ?? 'no-session')}:${Number(spawnGen)}`;
}

/**
 * Escape trial/provisional and one-shot D fallback must always go through the
 * engine retrieval path. Prefetch pool candidates were produced from an older
 * context and would skip the contrast/D override if consumed directly.
 *
 * @param {import('./autoplay-escape-state.js').AutoplayEscapeSnapshot | null | undefined} escapeSnapshot
 * @returns {boolean}
 */
export function shouldBypassAutoplayPrefetchFastPath(escapeSnapshot) {
  return (
    Boolean(escapeSnapshot?.dFallbackPending)
    || (
      (escapeSnapshot?.prefetchMode ?? 'normal') !== 'normal'
      && isAutoplayEscapeContrastActivePhase(escapeSnapshot?.phase ?? null)
    )
  );
}

/**
 * Confirmed escape branches add one secondary positive anchor back into the
 * normal retrieval path. Trial/provisional still rely on contrast override and
 * must not extend the regular positive context.
 *
 * @param {string[]} positiveCtx
 * @param {import('./autoplay-escape-state.js').AutoplayEscapeSnapshot | null | undefined} escapeSnapshot
 * @returns {string[]}
 */
export function buildAutoplayRetrievalPositiveContext(positiveCtx, escapeSnapshot) {
  if (
    escapeSnapshot?.phase !== 'confirmed'
    || !Array.isArray(escapeSnapshot.confirmedAnchors)
    || escapeSnapshot.confirmedAnchors.length === 0
  ) {
    return positiveCtx;
  }
  return [...positiveCtx, ...escapeSnapshot.confirmedAnchors];
}

/**
 * Compact escape telemetry payload attached to autoplay-spawn metrics.
 *
 * @param {import('./autoplay-escape-state.js').AutoplayEscapeSnapshot | null | undefined} escapeSnapshot
 * @param {{ mode?: string | null } | null | undefined} retrievalMode
 * @returns {{
 *   phase: string | null,
 *   mode: string,
 *   branchId: string | null,
 *   confirmedAnchorsCount: number,
 *   dFallbackUsed: boolean,
 *   cooldownRemaining: number,
 * }}
 */
export function buildAutoplaySpawnEscapeTelemetry(escapeSnapshot, retrievalMode) {
  return {
    phase: escapeSnapshot?.phase ?? null,
    mode: typeof retrievalMode?.mode === 'string' && retrievalMode.mode.trim()
      ? retrievalMode.mode.trim()
      : 'normal',
    branchId: escapeSnapshot?.branchId ?? null,
    confirmedAnchorsCount: Array.isArray(escapeSnapshot?.confirmedAnchors)
      ? escapeSnapshot.confirmedAnchors.length
      : 0,
    dFallbackUsed: retrievalMode?.mode === 'd_fallback',
    cooldownRemaining: Math.max(0, Number(escapeSnapshot?.cooldownSpawnsRemaining) || 0),
  };
}

/**
 * Consume pool candidates until we find one whose artist is not quarantined.
 * Quarantined pool hits are intentionally discarded: they were generated from
 * an older context and must not immediately resurface after a quick skip.
 *
 * @param {{
 *   popCandidate: () => any | null,
 *   quarantinedArtists: Iterable<string> | null | undefined,
 *   extractLeadArtistToken: (title: string, meta?: { channelName?: string | null } | null) => string | null,
 *   maxAttempts?: number,
 * }} p
 * @returns {{ candidate: any | null, rejectedByArtistQuarantine: number }}
 */
export function pickAutoplayPrefetchCandidateRespectingArtistQuarantine(p) {
  const popCandidate = typeof p?.popCandidate === 'function' ? p.popCandidate : (() => null);
  const maxAttempts = Math.max(1, Number(p?.maxAttempts) || 24);
  const extractArtist = typeof p?.extractLeadArtistToken === 'function'
    ? p.extractLeadArtistToken
    : (() => null);

  let rejectedByArtistQuarantine = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = popCandidate();
    if (!candidate) {
      return {
        candidate: null,
        rejectedByArtistQuarantine,
      };
    }

    const artist = extractArtist(
      String(candidate?.title ?? ''),
      { channelName: candidate?.channel?.name ?? null },
    );
    if (isArtistQuarantined(p?.quarantinedArtists ?? [], artist)) {
      rejectedByArtistQuarantine++;
      continue;
    }

    return {
      candidate,
      rejectedByArtistQuarantine,
    };
  }

  return {
    candidate: null,
    rejectedByArtistQuarantine,
  };
}

/**
 * Автоплей: не ставить тот же watch URL, что сейчас числится как «играющий» или
 * недавно уже был в сессии (очередь между треками пуста — дедуп только по queue
 * раньше пропускал повтор).
 */
const AUTOPLAY_RECENT_URL_BLOCK = 24;

/**
 * @param {string | null | undefined} guildId
 * @param {string} url
 * @returns {boolean}
 */
export function isYoutubeUrlBlockedForAutoplaySpawns(guildId, url) {
  if (guildId == null) return false;
  const id = String(guildId);
  const cur = currentPlayingUrlByGuild.get(id);
  if (cur && sameYoutubeContent(cur, url)) return true;
  const hist = getSessionPlayedWatchUrls(id);
  for (const u of hist.slice(-AUTOPLAY_RECENT_URL_BLOCK)) {
    if (sameYoutubeContent(u, url)) return true;
  }
  return false;
}

/**
 * Единый stale-guard для spawn pipeline.
 * Фазы остаются явными в месте вызова (after_retrieval / after_search / before_enqueue).
 *
 * @param {{
 *   guildId: string,
 *   spawnGen: number,
 *   staleCtx: { isConnectionAlive: (gid: string) => boolean, isPlaying: (gid: string) => boolean, hasAutoplay: (gid: string) => boolean, getQueueLength: (gid: string) => number },
 *   logSpawn: (outcome: string, extra?: Record<string, unknown>) => void,
 * }} p
 */
export function createAutoplaySpawnStaleGuard(p) {
  return function guard(phase, outcome) {
    const staleReason = checkAutoplaySpawnStaleDiscard(p.guildId, p.spawnGen, phase, p.staleCtx);
    if (!staleReason) return false;
    autoplayDebug(p.guildId, 'final', { reason: 'stale_discard', detail: staleReason });
    p.logSpawn(outcome, { detail: String(staleReason) });
    return true;
  };
}

/**
 * Prepare retrieval mode for a concrete spawn after the prefetch fast-path has
 * already had a chance to short-circuit. This keeps `currentSpawnId`
 * synchronized with the actual spawn id that goes through the engine path.
 *
 * @param {{
 *   guildId: string,
 *   spawnId: string,
 *   escapeSnapshot: import('./autoplay-escape-state.js').AutoplayEscapeSnapshot,
 *   seedQuery: string,
 *   effectiveSeed: string,
 *   pivotToAnchor: boolean,
 *   lastIntent: string | null,
 *   initialSeed: string | null,
 *   topic: string | null,
 *   identityIntent: string | null,
 *   currentPlayingLabel: string | null,
 * }} p
 */
export function prepareAutoplayRetrievalModeForSpawn(p) {
  const useDFallback = consumeAutoplayEscapeDFallbackPending(p.guildId);
  if (isAutoplayEscapeContrastActivePhase(p.escapeSnapshot.phase)) {
    attachAutoplayEscapeSpawnId(p.guildId, p.spawnId);
    autoplayDebug(p.guildId, 'escape-retrieval', {
      phase: p.escapeSnapshot.phase,
      from: p.escapeSnapshot.contrastHint?.from ?? null,
      anchor: p.escapeSnapshot.contrastHint?.anchor ?? null,
      spawnId: p.spawnId,
    });
  }

  return resolveAutoplayEscapeRetrievalOverride({
    escapeSnapshot: p.escapeSnapshot,
    seedQuery: String(p.seedQuery),
    currentPlayingLabel: p.currentPlayingLabel,
    effectiveSeed: String(p.effectiveSeed),
    pivotToAnchor: p.pivotToAnchor,
    lastIntent: p.lastIntent,
    initialSeed: p.initialSeed,
    topic: p.topic,
    identityIntent: p.identityIntent,
    currentPlayingLabelForRetrieval: p.currentPlayingLabel,
    useDFallback,
  });
}

/**
 * @typedef {Object} AutoplaySpawnerDeps
 * @property {(guildId: string) => void} notifyPlaybackUiRefresh
 *   Триггер перерисовки панели. Зовётся до/после spawn, чтобы UI показал
 *   "resolving…". Реализуется в music.js как обёртка над `onPlaybackUiRefresh`.
 * @property {() => ((guildId: string, items: {title: string, url: string}[], query: string) => void) | null} getOnAutoplaySpawned
 *   Getter (не значение): spawn читает registered-callback КАЖДЫЙ раз, чтобы
 *   `setOnAutoplaySpawned` после создания фабрики всё ещё работал.
 */

/**
 * Создаёт spawner для автоплея. Возвращает объект с единственным методом
 * `spawnAutoplayPlaylist(guildId, seedQuery)` → `Promise<'queued'|'skip'|'fail'>`.
 *
 * @param {AutoplaySpawnerDeps} deps
 */
export function createAutoplaySpawner(deps) {
  if (!deps || typeof deps.notifyPlaybackUiRefresh !== 'function' || typeof deps.getOnAutoplaySpawned !== 'function') {
    throw new Error('createAutoplaySpawner: invalid deps (notifyPlaybackUiRefresh, getOnAutoplaySpawned required)');
  }

  /**
   * Ищет трек для автоплея и кладёт URL в очередь. Не вызывает schedulePlayNext — это делает runPlayNext.
   * @param {string} guildId
   * @param {string} seedQuery
   * @returns {Promise<'queued' | 'skip' | 'fail'>}
   */
  async function spawnAutoplayPlaylist(guildId, seedQuery) {
    const id = String(guildId);
    beginAutoplayResolving(id);
    deps.notifyPlaybackUiRefresh(id);
    try {
      return await _spawnAutoplayPlaylistImpl(id, seedQuery, deps);
    } finally {
      endAutoplayResolving(id);
      deps.notifyPlaybackUiRefresh(id);
    }
  }

  return Object.freeze({ spawnAutoplayPlaylist });
}

/**
 * Тело spawnAutoplayPlaylist: Groq/поиск и постановка в очередь.
 *
 * @param {string} id
 * @param {string} seedQuery
 * @param {AutoplaySpawnerDeps} deps
 * @returns {Promise<'queued' | 'skip' | 'fail'>}
 */
async function _spawnAutoplayPlaylistImpl(id, seedQuery, deps) {
  const session = getAutoplaySessionSnapshot(id);
  const {
    sessionTitles,
    initialSeed,
    lastIntent,
    playedTitles,
    positiveCtx,
    negativeCtx,
    usedQueries,
    pivotDominant,
    pivotToAnchor,
    effectiveSeed,
  } = buildAutoplaySpawnContext({
    guildId: id,
    seedQuery,
    session,
    normalizeTitle: normalizeTitleForContext,
    getPositiveContext,
    getNegativeContext,
    detectDominantArtist,
    buildAutoplayPivotSeed,
  });
  const mySpawnGen = bumpAutoplaySpawnGeneration(id);
  const sessionId = getSessionId(id) ?? '';
  const spawnId = buildAutoplaySpawnId(sessionId, mySpawnGen);
  const escapeSnapshot = getAutoplayEscapeSnapshot(id);
  const quarantinedArtists = isAutoplayArtistQuarantineEnabled()
    ? consumeAutoplayArtistQuarantineSpawn(id)
    : [];
  const staleCtx = {
    isConnectionAlive: (gid) => isConnectionAlive(gid),
    isPlaying: (gid) => isPlayerPlaying(gid),
    hasAutoplay: (gid) => autoplayByGuild.has(gid),
    getQueueLength: (gid) => getQueueLength(gid),
  };
  autoplayDebug(id, 'seed', {
    initialSeed: initialSeed ? String(initialSeed).slice(0, 120) : null,
    lastIntent: lastIntent ? String(lastIntent).slice(0, 120) : null,
    pivotToAnchor,
    pivotDominantArtist: pivotDominant?.artist ?? null,
    effectiveSeed: String(effectiveSeed).replace(/\s+/g, ' ').slice(0, 200),
  });
  autoplayDebug(id, 'context-sizes', {
    playedTitles: playedTitles.length,
    positiveCtx: positiveCtx.length,
    negativeCtx: negativeCtx.length,
    usedQueries: usedQueries.length,
  });
  // ─── Prefetch pool fast path ──────────────────────────────────────────────
  // If a previous spawn stored surplus candidates, use the pool to skip the
  // full Groq + YouTube search pipeline. Only bypasses retrieval — all
  // stale/connection guards still apply after popping from the pool.
  if (!shouldBypassAutoplayPrefetchFastPath(escapeSnapshot)) {
    const prefetchSelection = pickAutoplayPrefetchCandidateRespectingArtistQuarantine({
      popCandidate: () => popBestCandidate(id, {
        sessionId,
        generation: getPrefetchGeneration(id),
      }),
      quarantinedArtists,
      extractLeadArtistToken,
    });
    const prefetchCandidate = prefetchSelection.candidate;
    if (prefetchCandidate) {
      autoplayDebug(id, 'prefetch-hit', {
        title: prefetchCandidate.title?.slice(0, 80) ?? null,
        poolSizeAfter: getPoolSize(id),
        rejectedByArtistQuarantine: prefetchSelection.rejectedByArtistQuarantine,
      });
      if (!isConnectionAlive(id)) {
        return 'skip';
      }
      if (!autoplayByGuild.has(id)) return 'skip';
      if (isPlayerPlaying(id) || getQueueLength(id) > 0) return 'skip';
      // Note: session/generation freshness is already validated inside popBestCandidate.
      // isRecentBlocked: pool may contain a track that was recently played (e.g. stored as surplus
      // before the session history was updated). Reject it here and fall through to full spawn.
      if (isYoutubeUrlBlockedForAutoplaySpawns(id, prefetchCandidate.url)) {
        autoplayDebug(id, 'prefetch-recent-blocked', { url: prefetchCandidate.url });
        console.log(`[prefetch] pool_hit blocked by recent guard — fall through guild=${id}`);
        // continue to full spawn below (don't return 'skip' — pool may have had the only candidate)
      } else if (!enqueueTrackIfNotQueued(id, {
        url: prefetchCandidate.url,
        source: 'autoplay',
        spawnId: prefetchCandidate.spawnId ?? null,
        title: prefetchCandidate.title ?? null,
        channelName: prefetchCandidate.channel?.name ?? prefetchCandidate.channelName ?? null,
      })) {
        autoplayDebug(id, 'prefetch-dedup', { url: prefetchCandidate.url });
        // dedup: item already in queue — fall through to full engine
      } else {
        const onSpawned = deps.getOnAutoplaySpawned();
        if (onSpawned) {
          try { onSpawned(id, [prefetchCandidate], 'prefetch'); } catch {}
        }
        recordAutoplaySpawnSuccess(id);
        return 'queued';
      }
    } else if (prefetchSelection.rejectedByArtistQuarantine > 0) {
      autoplayDebug(id, 'prefetch-hit', {
        title: null,
        poolSizeAfter: getPoolSize(id),
        rejectedByArtistQuarantine: prefetchSelection.rejectedByArtistQuarantine,
      });
    }
  }

  /**
   * Serverside query-hints: fire-and-forget, timeout внутри syncAndGetHints.
   * При любой ошибке hints = [], поиск идёт без изменений.
   */
  const retrievalMode = prepareAutoplayRetrievalModeForSpawn({
    guildId: id,
    spawnId,
    escapeSnapshot,
    seedQuery: String(seedQuery),
    effectiveSeed: String(effectiveSeed),
    pivotToAnchor,
    lastIntent,
    initialSeed,
    topic: session.topicIntent,
    identityIntent: session.identityIntent,
    currentPlayingLabel: currentPlayingLabelByGuild.get(id) ?? null,
  });
  const retrievalPositiveCtx = buildAutoplayRetrievalPositiveContext(
    positiveCtx,
    escapeSnapshot,
  );
  const serverHints = await syncAndGetHints(id);
  /** Подсказки с сервера: при METRICS_TXT — bridge.txt (recommendation-bridge); дублировать здесь не нужно. */
  autoplayDebug(id, 'server-hints', { count: serverHints.length });

  /**
   * Retrieval + query policy: `autoplay-engine.js` (`pickAutoplayRetrieval`) — fast lane, Groq-цепочка, strategy queries, `applyAutoplayQueryPolicy`.
   */
  const sessionTitlesForFast = sessionTitles;
  const alternateStreakFast = countTrailingAlternateStreak(sessionTitlesForFast);
  const _groqT0 = Date.now();
  const { allQueries, usedToken, artistCandidates, policy, telemetry: retrievalTelemetry, groqTrace } =
    await pickAutoplayRetrieval(
    {
      guildId: id,
      effectiveSeed: retrievalMode.effectiveSeed,
      pivotToAnchor: retrievalMode.pivotToAnchor,
      playedTitles,
      positiveCtx: retrievalPositiveCtx,
      negativeCtx,
      usedQueries,
      lastIntent: retrievalMode.lastIntent,
      initialSeed: retrievalMode.initialSeed,
      topic: retrievalMode.topic,
      identityIntent: retrievalMode.identityIntent,
      sessionTitlesForFast,
      alternateStreakFast,
      currentPlayingLabel: retrievalMode.currentPlayingLabel,
      serverHints,
      escapeContrastHint: retrievalMode.escapeContrastHint,
      dFallbackPrompt: retrievalMode.dFallbackPrompt ?? null,
    },
    {
      onGroqCall: () => baselineGroqCall(id),
      debug: (stage, meta) => autoplayDebug(id, stage, meta),
    },
  );
  autoplayDebug(id, 'retrieval-telemetry', retrievalTelemetry ?? {});
  console.log(`[autoplay] groq done guild=${id} elapsed=${Date.now()-_groqT0}ms queries=${allQueries.length} artist=${artistCandidates.length}`);

  // METRICS:TXT autoplay-spawn.txt (logAutoplaySpawn / logSpawn)
  const retrievalSnap = {
    allQueries,
    usedToken,
    policy: policy ?? {},
    telemetry: retrievalTelemetry ?? {},
    groqTrace,
  };
  const escapeTelemetry = buildAutoplaySpawnEscapeTelemetry(
    escapeSnapshot,
    retrievalMode,
  );
  const logSpawn = (outcome, extra = {}) => {
    logAutoplaySpawn({
      guildId: id,
      outcome,
      groqTrace: retrievalSnap.groqTrace,
      allQueries: retrievalSnap.allQueries,
      usedToken: retrievalSnap.usedToken,
      telemetry: retrievalSnap.telemetry,
      policyMeta: retrievalSnap.policy?.meta ?? null,
      escape: escapeTelemetry,
      ...extra,
    });
  };
  const guardSpawnStale = createAutoplaySpawnStaleGuard({
    guildId: id,
    spawnGen: mySpawnGen,
    staleCtx,
    logSpawn,
  });

  if (guardSpawnStale('after_retrieval', 'stale_after_retrieval')) {
    return 'skip';
  }

  /** Track used description so Groq won't repeat the same struct next cycle. */
  pushAutoplayUsedQuery(id, usedToken);

  if (!isPlaybackMetricsEnabled()) {
    console.log(`[autoplay] spawning guild=${id}`);
  }
  try {
    /**
     * Несколько кандидатов с одного поискового запроса: иначе count=1 и тот же топ выдачи
     * снова попадает в пустую очередь (pushQueueIfNotQueued смотрит только очередь, не «что уже играло»).
     */
    const PICK_N = Math.min(12, Math.max(4, Number(process.env.AUTOPLAY_CANDIDATES_PER_QUERY) || 8));
    const rawSessionTitles = sessionTitles;
    const alternateStreak = countTrailingAlternateStreak(rawSessionTitles);
    autoplayDebug(id, 'alternate-streak', {
      streak: alternateStreak,
      streakMin: getAutoplayAltStreakMin(),
    });
    const _searchT0 = Date.now();
    const resultSets = await runAutoplaySearchStep({
      artistCandidates,
      allQueries,
      pickN: PICK_N,
      guildId: id,
      alternateStreak,
      searchByArtist: pickTracksForArtist,
      searchByQuery: pickDistinctTrackVideos,
    });
    console.log(`[autoplay] search done guild=${id} elapsed=${Date.now()-_searchT0}ms sets=${resultSets.length}`);
    if (guardSpawnStale('after_search', 'stale_after_search')) {
      return 'skip';
    }
    autoplayDebug(id, 'query-results', resultSets.map((set, i) => ({
      idx: i,
      returned: set.length,
    })));
    const { pickedResultIdx, items: rawItems } = pickFirstNonEmptyResultSet(resultSets);
    const quarantineFilter = filterAutoplayCandidatesByArtistQuarantine(rawItems, {
      quarantinedArtists,
      extractLeadArtistToken,
    });
    autoplayDebug(id, 'artist-quarantine', quarantineFilter.meta);
    const distinctShortlist = buildDistinctArtistShortlist(quarantineFilter.items, {
      extractLeadArtistToken,
    });
    autoplayDebug(id, 'distinct-artists', distinctShortlist.meta);
    const items = distinctShortlist.items.map((item) => ({
      ...item,
      spawnId,
    }));
    autoplayDebug(id, 'selected-query-index', { idx: pickedResultIdx });
    if (!items.length) throw new Error('empty result');

    if (!isConnectionAlive(id)) {
      autoplayDebug(id, 'final', { reason: 'skip_state_changed', detail: 'no_or_destroyed_connection' });
      logSpawn('skip_no_connection', {});
      return 'skip';
    }
    if (!autoplayByGuild.has(id)) {
      autoplayDebug(id, 'final', { reason: 'skip_state_changed', detail: 'autoplay_off' });
      logSpawn('skip_autoplay_off', {});
      return 'skip';
    }
    if (isPlayerPlaying(id) || getQueueLength(id) > 0) {
      autoplayDebug(id, 'final', { reason: 'skip_state_changed', detail: 'playback_already_resumed' });
      logSpawn('skip_playback_resumed', {});
      return 'skip';
    }

    if (guardSpawnStale('before_enqueue', 'stale_before_enqueue')) {
      return 'skip';
    }

    const applyResult = applyAutoplayCandidatesStep({
      items,
      queue: getQueueOps(id),
      guildId: id,
      sessionTitles,
      isPlayabilityHardSkipEnabled,
      isUrlMarkedBad,
      isRecentBlocked: (url) => isYoutubeUrlBlockedForAutoplaySpawns(id, url),
      getArtistCooldownWindow: getAutoplayArtistCooldownWindow,
      isArtistCooldownEnabled: isAutoplayArtistCooldownEnabled,
      detectDominantArtist,
      extractLeadArtistToken,
      isVarietyControllerEnabled,
      computeVarietyRankPenalty,
      rankAutoplayCandidates,
      spawnId,
    });
    const {
      added,
      skippedRecent,
      skippedArtistCooldown,
      skippedPlayability,
      pickedForNotify,
      dominantArtist,
      artistCooldownWindow,
      artistCooldownEnabled,
    } = applyResult;
    autoplayDebug(id, 'artist-cooldown', {
      enabled: artistCooldownEnabled,
      window: artistCooldownWindow,
      dominantArtist: dominantArtist?.artist ?? null,
      dominantCount: dominantArtist?.count ?? 0,
    });
    autoplayDebug(id, 'candidate-selection', {
      totalCandidates: items.length,
      rejectedPlayabilityCache: skippedPlayability,
      rejectedRecentUrl: skippedRecent,
      rejectedArtistCooldown: skippedArtistCooldown,
      selected: Boolean(pickedForNotify),
      selectedTitle: pickedForNotify?.title ?? null,
      selectedReason: pickedForNotify
        ? { search: pickedForNotify._debug ?? null, ranker: pickedForNotify._ranker ?? null }
        : null,
      policyQuarantineHit: Boolean(policy?.meta?.quarantineToken),
    });
    if (added === 0) {
      if (items.length > 0 && skippedPlayability === items.length) {
        recordAutoplaySpawnBadOutcome(id);
        if (!isPlaybackMetricsEnabled()) {
          console.warn('[autoplay] nothing queued — all candidates filtered by playability cache guild=', id, `skipped=${skippedPlayability}`);
        }
        autoplayDebug(id, 'final', { reason: 'skip_playability_cache' });
        logSpawn('skip_playability_cache', { pickedQueryIdx: pickedResultIdx });
        return 'skip';
      }
      if (skippedRecent > 0) {
        if (!isPlaybackMetricsEnabled()) {
          console.warn('[autoplay] nothing queued — all candidates were recent/current duplicates guild=', id, `skipped=${skippedRecent}`);
        }
        autoplayDebug(id, 'final', { reason: 'skip_recent_dup' });
        logSpawn('skip_recent_dup', { pickedQueryIdx: pickedResultIdx });
      } else if (skippedArtistCooldown > 0) {
        if (!isPlaybackMetricsEnabled()) {
          console.warn('[autoplay] nothing queued — artist cooldown filtered all candidates guild=', id, `skipped=${skippedArtistCooldown}`);
        }
        autoplayDebug(id, 'final', { reason: 'skip_artist_cooldown' });
        logSpawn('skip_artist_cooldown', { pickedQueryIdx: pickedResultIdx });
      } else {
        if (!isPlaybackMetricsEnabled()) {
          console.warn('[autoplay] nothing queued (deduped or empty) guild=', id);
        }
        autoplayDebug(id, 'final', { reason: 'skip_empty' });
        logSpawn('skip_empty', { pickedQueryIdx: pickedResultIdx });
      }
      return 'skip';
    }
    if (!isPlaybackMetricsEnabled()) {
      console.log(`[autoplay] queued ${added} tracks guild=${id}`);
    }
    autoplayDebug(id, 'final', {
      reason: 'queued',
      selectedTitle: pickedForNotify?.title ?? null,
      selectedReason: pickedForNotify
        ? { search: pickedForNotify._debug ?? null, ranker: pickedForNotify._ranker ?? null }
        : null,
    });
    const onSpawned = deps.getOnAutoplaySpawned();
    if (onSpawned && pickedForNotify) {
      try {
        onSpawned(id, [pickedForNotify], usedToken);
      } catch {}
    }
    if (isVarietyControllerEnabled() && pickedForNotify) {
      recordVarietyStateAfterSpawn(id, {
        pickedTitle: pickedForNotify.title,
        telemetry: retrievalTelemetry ?? {},
        firstQuery: allQueries[0] ?? null,
      });
    }
    recordAutoplaySpawnSuccess(id);
    logSpawn('queued', {
      pickedTitle: pickedForNotify?.title ?? null,
      pickedUrl: pickedForNotify?.url ?? null,
      pickedQueryIdx: pickedResultIdx >= 0 ? pickedResultIdx : null,
    });

    // Store surplus candidates in the prefetch pool.
    // rankAutoplayCandidates creates spread-copies, so `pickedForNotify` is a different object
    // reference from its counterpart in `items`. Filter by URL, not by reference, to correctly
    // exclude the picked track. Also exclude recently-played URLs so the pool never resurfaces
    // a track that isRecentBlocked would reject during a regular spawn.
    const pickedUrl = pickedForNotify?.url ?? null;
    const surplus = items.filter(
      (it) =>
        it?.url &&
        it?.title &&
        it.url !== pickedUrl &&
        !isYoutubeUrlBlockedForAutoplaySpawns(id, it.url),
    );
    if (surplus.length) {
      const newGen = incrementPrefetchGeneration(id);
      storeSurplus(id, {
        sessionId,
        generation: newGen,
        items: surplus,
      });
      autoplayDebug(id, 'prefetch-surplus', { stored: surplus.length, generation: newGen });
    }

    return 'queued';
  } catch (e) {
    recordAutoplaySpawnBadOutcome(id);
    if (!isPlaybackMetricsEnabled()) {
      console.warn('[autoplay] failed', id, e instanceof Error ? e.message : e);
    }
    logSpawn('fail', { error: e instanceof Error ? e.message : String(e) });
    return 'fail';
  }
}

// ─── Private pipeline helpers (Шаг 9: inlined from autoplay-spawn-search.js and
//   autoplay-spawn-apply.js; single-consumer pure шаги этого pipeline — жили
//   отдельно только ради размера music.js, но после выноса spawn в отдельный
//   модуль разделение больше не даёт читаемости, только indirection). ──────────

/**
 * Sequential search with early exit: перебираем запросы/артистов по одному,
 * останавливаемся на первом непустом наборе. Избегает запуска N×5 yt-dlp
 * процессов когда нужен только первый результат.
 *
 * Fallback: если все запросы вернули пусто — возвращаем все пустые наборы,
 * чтобы caller мог отличить exhaustion от «ещё не искали».
 *
 * @param {{
 *   artistCandidates: string[],
 *   allQueries: string[],
 *   pickN: number,
 *   guildId: string,
 *   alternateStreak: number,
 *   searchByArtist: (artist: string, pickN: number, opts: { guildId: string, alternateStreak: number }) => Promise<unknown[]>,
 *   searchByQuery: (query: string, pickN: number, opts: { guildId: string, alternateStreak: number }) => Promise<unknown[]>,
 * }} p
 * @returns {Promise<unknown[][]>}
 */
async function runAutoplaySearchStep(p) {
  const opts = { guildId: p.guildId, alternateStreak: p.alternateStreak };

  if (p.artistCandidates.length) {
    const resultSets = [];
    for (const artist of p.artistCandidates) {
      const set = await p.searchByArtist(artist, p.pickN, opts).catch(() => []);
      resultSets.push(set);
      if (set.length > 0) break; // early exit — found usable candidates
    }
    return resultSets;
  }

  const resultSets = [];
  for (const query of p.allQueries) {
    const set = await p.searchByQuery(query, p.pickN, opts).catch(() => []);
    resultSets.push(set);
    if (set.length > 0) break; // early exit — found usable candidates
  }
  return resultSets;
}

/**
 * Выбирает первый непустой набор кандидатов.
 * @param {unknown[][]} resultSets
 * @returns {{ pickedResultIdx: number, items: unknown[] }}
 */
function pickFirstNonEmptyResultSet(resultSets) {
  const pickedResultIdx = resultSets.findIndex((set) => Array.isArray(set) && set.length > 0);
  const items = pickedResultIdx >= 0 ? [...resultSets[pickedResultIdx]] : [];
  return { pickedResultIdx, items };
}

/**
 * Rank/filter/apply шаг для autoplay spawn без изменения policy.
 * Deps инжектятся снаружи, чтобы функция оставалась pure и не тянула живые
 * Map'ы состояния — spawner передаёт их из module-scope импортов.
 *
 * @typedef {import('./queue-manager.js').QueueOps} QueueOps
 *
 * @param {{
 *   items: any[],
 *   queue: QueueOps,
 *   guildId: string,
 *   sessionTitles: string[],
 *   isPlayabilityHardSkipEnabled: () => boolean,
 *   isUrlMarkedBad: (url: string) => boolean,
 *   isRecentBlocked: (url: string) => boolean,
 *   getArtistCooldownWindow: () => number,
 *   isArtistCooldownEnabled: () => boolean,
 *   detectDominantArtist: (titles: string[]) => { artist: string, count: number } | null,
 *   extractLeadArtistToken: (title: string) => string | null,
 *   isVarietyControllerEnabled: () => boolean,
 *   computeVarietyRankPenalty: (guildId: string, title: string) => number,
 *   rankAutoplayCandidates: (items: any[], opts: any) => any[],
 *   spawnId: string,
 * }} p
 */
function applyAutoplayCandidatesStep(p) {
  let added = 0;
  let skippedRecent = 0;
  let skippedArtistCooldown = 0;
  let skippedPlayability = 0;
  let pickedForNotify = null;

  const artistCooldownWindow = p.getArtistCooldownWindow();
  const artistCooldownEnabled = p.isArtistCooldownEnabled();
  const dominantArtist = artistCooldownEnabled
    ? p.detectDominantArtist(p.sessionTitles.slice(-artistCooldownWindow))
    : null;

  const rankedCandidates = p.rankAutoplayCandidates(p.items, {
    isMarkedBad: (url) => p.isPlayabilityHardSkipEnabled() && p.isUrlMarkedBad(url),
    isRecentBlocked: (url) => p.isRecentBlocked(url),
    isArtistCooldownBlocked: (title) => {
      if (!dominantArtist?.artist) return false;
      const candArtist = p.extractLeadArtistToken(title);
      return Boolean(candArtist && candArtist === dominantArtist.artist);
    },
    ...(p.isVarietyControllerEnabled()
      ? {
          variety: (title) => p.computeVarietyRankPenalty(p.guildId, title),
        }
      : {}),
  });

  for (const it of rankedCandidates) {
    const rejected = it?._ranker?.rejected;
    if (rejected === 'playability') {
      skippedPlayability++;
      continue;
    }
    if (rejected === 'recent') {
      skippedRecent++;
      continue;
    }
    if (rejected === 'artist_cooldown') {
      skippedArtistCooldown++;
      continue;
    }
    if (p.queue.pushIfNotQueued({
      url: it.url,
      source: 'autoplay',
      spawnId: p.spawnId,
      title: it.title ?? null,
      channelName: it.channel?.name ?? it.channelName ?? null,
    })) {
      added++;
      pickedForNotify = it;
      break;
    }
  }

  return {
    added,
    skippedRecent,
    skippedArtistCooldown,
    skippedPlayability,
    pickedForNotify,
    dominantArtist,
    artistCooldownWindow,
    artistCooldownEnabled,
  };
}
