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
  {
    const prefetchCandidate = popBestCandidate(id, {
      sessionId: getSessionId(id) ?? '',
      generation: getPrefetchGeneration(id),
    });
    if (prefetchCandidate) {
      autoplayDebug(id, 'prefetch-hit', {
        title: prefetchCandidate.title?.slice(0, 80) ?? null,
        poolSizeAfter: getPoolSize(id),
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
      } else if (!enqueueTrackIfNotQueued(id, { url: prefetchCandidate.url, source: 'autoplay', title: prefetchCandidate.title ?? null })) {
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
    }
  }

  /**
   * Serverside query-hints: fire-and-forget, timeout внутри syncAndGetHints.
   * При любой ошибке hints = [], поиск идёт без изменений.
   */
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
      effectiveSeed: String(effectiveSeed),
      pivotToAnchor,
      playedTitles,
      positiveCtx,
      negativeCtx,
      usedQueries,
      lastIntent,
      initialSeed,
      topic: session.topicIntent,
      identityIntent: session.identityIntent,
      sessionTitlesForFast,
      alternateStreakFast,
      currentPlayingLabel: currentPlayingLabelByGuild.get(id) ?? null,
      serverHints,
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
  const logSpawn = (outcome, extra = {}) => {
    logAutoplaySpawn({
      guildId: id,
      outcome,
      groqTrace: retrievalSnap.groqTrace,
      allQueries: retrievalSnap.allQueries,
      usedToken: retrievalSnap.usedToken,
      telemetry: retrievalSnap.telemetry,
      policyMeta: retrievalSnap.policy?.meta ?? null,
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
    const { pickedResultIdx, items } = pickFirstNonEmptyResultSet(resultSets);
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
        sessionId: getSessionId(id) ?? '',
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
    if (p.queue.pushIfNotQueued({ url: it.url, source: 'autoplay', title: it.title ?? null })) {
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
