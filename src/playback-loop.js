/**
 * playback-loop.js — ядро воспроизведения, вынесено из music.js в Шаге 10.
 *
 * Владеет:
 *   - `guildState` Map<guildId, GuildMusicState> — per-guild proc tracker
 *     (ytdlp / ffmpeg-normalize / StreamHandle / lastEndReason).
 *   - реакцией на события AudioPlayer (Idle / Error / StateChange) через
 *     регистрацию callbacks в player-controller.
 *   - циклом `runPlayNext` → сериализацией через `schedulePlayNext`.
 *   - streaming-шагом `streamUrl` (audio-pipeline → процессы → StreamHandle →
 *     запись metrics / session history).
 *   - callback'ами UI и панели, которые потребляются **только** этим loop'ом:
 *     `onPlaybackUiRefresh`, `onPlayingTrackDisplay`, `onPlaybackIdle`,
 *     `onAutoplaySpawned` (+ `createAutoplaySpawner` init).
 *
 * Остальные модули (music.js, orchestrator, index) дёргают публичный API
 * этого файла: `ensureGuildMusicState`, `getGuildMusicState`, `killYtdlp`,
 * `schedulePlayNext`, плюс setOn* для регистрации колбэков.
 *
 * Границы ответственности — см. docs/АРХИТЕКТУРА.md (Шаг 10).
 */

import {
  awaitReady as awaitVoiceReady,
  isConnectionAlive,
} from './voice-adapter.js';
import {
  ensurePlayer,
  isPlaying as isPlayerPlaying,
  markNotPlaying,
  playResource,
  registerPlayerControllerCallbacks,
} from './player-controller.js';
import { createSchedulePlayNext } from './playback-schedule.js';
import {
  getQueueLength,
  peekNext,
  removeItem as removeQueueItem,
  shiftIfHead,
} from './queue-manager.js';
import { isDirectUrl } from './track-provider.js';
import {
  pickDistinctTrackVideos,
  pickTracksForArtist,
  resolveYoutubeCanonicalTitle,
  resolveYoutubeFromQuery,
  tryNormalizeYoutubeUrl,
} from './youtube-search.js';
import { emitSignal, sourceToTriggeredBy } from './music-signals.js';
import {
  logTrackStarted,
  logStreamEnd,
} from './playback-metrics.js';
import { createStream as createAudioStream } from './audio-pipeline.js';
import { recordPlaybackHistory } from './playback-history.js';
import {
  baselineAutoplaySpawnBegin,
  baselineAutoplaySpawnEnd,
  baselinePlaybackStarted,
  baselinePlaybackAborted,
  baselineStreamFail,
} from './autoplay-baseline.js';
import {
  clearPlayabilityBadOnSuccessfulPlay,
  isPlayabilityHardSkipEnabled,
  isUrlMarkedBad,
  recordPlayabilityFailure,
} from './playability-cache.js';
import {
  appendAutoplaySessionTitle,
  buildAutoplayPivotSeed,
  buildAutoplaySeedForGroq,
} from './autoplay-session-state.js';
import { createAutoplaySpawner, isYoutubeUrlBlockedForAutoplaySpawns } from './autoplay-spawn.js';
import { runProactivePrefetch } from './autoplay-prefetch-runner.js';
import {
  consumeSuppressHistoryPush,
  consumeSuppressTrackFinishedOnce,
  deleteIdleBackForwardTail,
  deleteIdleNavCursor,
  getPastTrackUrls,
  getSessionPlayedWatchUrls,
  setPastTrackUrls,
  setSessionPlayedWatchUrls,
} from './idle-navigation-state.js';
import { resolveIdleVerdict } from './player-idle-verdict.js';
import {
  confirmAutoplayEscapeBranch,
  getAutoplayEscapeSnapshot,
  markAutoplayEscapeTrackStarted,
} from './autoplay-escape-state.js';
import {
  autoplayByGuild,
  currentPlayingLabelByGuild,
  currentPlayingUrlByGuild,
  currentQueueItemByGuild,
  repeatByGuild,
  getListenersCount,
  getSessionId,
  setPlayerState,
  PlayerState,
  StatusReason,
} from './guild-session-state.js';

/**
 * @typedef {{
 *   ytdlp: import('child_process').ChildProcess | null,
 *   ffmpegNormalize: import('child_process').ChildProcess | null,
 *   streamHandle?: import('./stream-handle.js').StreamHandle | null,
 *   lastEndReason?: import('./stream-handle.js').EndReason | null,
 * }} GuildMusicState
 *
 * Per-guild proc tracker. Всё остальное ушло в специализированные модули:
 *   - Очередь → queue-manager.js (Шаг 4)
 *   - VoiceConnection → voice-adapter.js (Шаг 5)
 *   - AudioPlayer + playing flag → player-controller.js (Шаг 6a)
 *   - Здесь остаются только процессы yt-dlp / ffmpeg-normalize + StreamHandle.
 */

/** @type {Map<string, GuildMusicState>} */
const guildState = new Map();

const PAST_TRACKS_CAP = 50;
const SESSION_PLAYED_CAP = 80;

// ─── Callbacks (потребляются только внутри loop'а) ───────────────────────────

/** @type {((guildId: string) => void) | null} */
let onPlaybackUiRefresh = null;

/** Панель: обновить текст/кнопки при смене «загрузка / играет / простой». */
export function setOnPlaybackUiRefresh(fn) {
  onPlaybackUiRefresh = fn;
}

function notifyPlaybackUiRefresh(guildId) {
  if (onPlaybackUiRefresh) {
    try {
      onPlaybackUiRefresh(String(guildId));
    } catch (e) {
      console.warn('[playback-loop] onPlaybackUiRefresh', e);
    }
  }
}

/** @type {((guildId: string, items: {title: string, url: string}[], query: string) => void) | null} */
let onAutoplaySpawned = null;

/** Вызывается когда автоплей успешно добавил новую подборку в очередь. */
export function setOnAutoplaySpawned(fn) {
  onAutoplaySpawned = fn;
}

/** @type {((guildId: string, label: string) => void) | null} */
let onPlayingTrackDisplay = null;

/** Смена трека (skip / следующий из очереди) — обновить текст панели в чате. */
export function setOnPlayingTrackDisplay(fn) {
  onPlayingTrackDisplay = fn;
}

/** @type {((guildId: string) => void) | null} */
let onPlaybackIdle = null;

/** Очередь закончилась (или скип последнего), голос ещё подключён — панель в режим ожидания (сообщения в чате не удаляются). */
export function setOnPlaybackIdle(fn) {
  onPlaybackIdle = fn;
}

// ─── Autoplay spawn pipeline ──────────────────────────────────────────────────
// Шаг 8: spawn вынесен в src/autoplay-spawn.js (createAutoplaySpawner),
// здесь — locally-scoped callback onAutoplaySpawned; spawner читает его через
// getter, чтобы setOnAutoplaySpawned после init всё ещё работал.

const { spawnAutoplayPlaylist } = createAutoplaySpawner({
  notifyPlaybackUiRefresh,
  getOnAutoplaySpawned: () => onAutoplaySpawned,
});

// ─── Proc lifecycle ──────────────────────────────────────────────────────────

export function killYtdlp(s) {
  if (!s) return;
  if (s.ffmpegNormalize) {
    try {
      s.ffmpegNormalize.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    s.ffmpegNormalize = null;
  }
  if (!s.ytdlp) return;
  try {
    s.ytdlp.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  s.ytdlp = null;
}

// ─── Player event handlers ───────────────────────────────────────────────────

/**
 * Реакция на AudioPlayerStatus.Idle — вызывается из player-controller через
 * зарегистрированный колбэк.
 *
 * Решение «что делать» вынесено в чистый арбитр `resolveIdleVerdict` (Шаг 6b,
 * `./player-idle-verdict.js`). Здесь — только snapshot входов, teardown
 * текущего потока и тривиальный диспатч побочек по verdict.
 *
 * Семантика «почему Idle» через StreamHandle.EndReason разводится в 6c.
 *
 * @param {string} id
 */
function handlePlayerIdle(id) {
  const s = guildState.get(id);
  if (!s) return;

  /**
   * Snapshot входов арбитра ДО teardown.
   *
   * `wasPlaying` захватываем до markNotPlaying: если трек реально воспроизводился,
   * планируем следующий. Иначе — это «эхо» Idle (например, Broken pipe прилетел
   * после того как player.stop() уже выдал первый Idle и playing стал false).
   * Без этого двойной Idle → двойной schedulePlayNext → дубликаты треков при
   * ⏮ / ⏭ с включённым repeat.
   *
   * `suppressFinished` — consuming-read (Set.delete). Выполняется здесь, не в
   * арбитре: арбитр остаётся чистым (одинаковый input → одинаковый verdict).
   *
   * `streamFailed` — Шаг 6c-b: единственный источник истины — `StreamHandle`.
   *   - `s.lastEndReason?.kind === 'fatal'` — verdict classifier'а после close
   *     всех процессов (через `handle.whenEnded`).
   *   - `s.streamHandle?.pendingFatal != null` — мгновенный fallback: Idle прилетел
   *     раньше close, но stderr-ERROR уже классифицирован как fatal.
   */
  const wasPlaying = isPlayerPlaying(id);
  const endReason = s.lastEndReason ?? null;
  const pendingFatal = s.streamHandle?.pendingFatal ?? null;
  const streamFailed = endReason?.kind === 'fatal' || pendingFatal != null;
  const suppressFinished = consumeSuppressTrackFinishedOnce(id);
  const repeatOn = repeatByGuild.has(id);

  markNotPlaying(id);
  s.lastEndReason = null;
  killYtdlp(s);

  const verdict = resolveIdleVerdict({ wasPlaying, streamFailed, suppressFinished, repeatOn });
  if (verdict.ignore) return;

  if (verdict.emitTrackFinished) {
    const finUrl = currentPlayingUrlByGuild.get(id) ?? '';
    const finTitle = currentPlayingLabelByGuild.get(id) ?? '';
    const finItem = currentQueueItemByGuild.get(id);
    const escapeSnapshot = getAutoplayEscapeSnapshot(id);
    if (
      (escapeSnapshot.phase === 'trial' || escapeSnapshot.phase === 'provisional') &&
      finItem?.spawnId != null &&
      escapeSnapshot.currentSpawnId === finItem.spawnId
    ) {
      confirmAutoplayEscapeBranch(id, {
        reason: 'playback_track_finished',
        source: finItem.source ?? null,
        title: finTitle,
      });
    }
    void recordPlaybackHistory({
      eventType: 'finished',
      guildId: id,
      sessionId: getSessionId(id),
      requestedBy: finItem?.requestedBy ?? null,
      triggeredBy: sourceToTriggeredBy(finItem?.source),
      spawnId: finItem?.spawnId ?? null,
      listenersCount: getListenersCount(id),
      url: finUrl,
      title: finTitle,
    });
    void emitSignal('track_finished', {
      guildId: id,
      sessionId: getSessionId(id),
      actor: null,                                           // natural finish — no user actor
      requestedBy: finItem?.requestedBy ?? null,
      triggeredBy: sourceToTriggeredBy(finItem?.source),
      spawnId: finItem?.spawnId ?? null,
      listenersCount: getListenersCount(id),
      url: finUrl,
      title: finTitle,
    });
  }

  if (verdict.forceSkipFromQueue) {
    const currentItem = currentQueueItemByGuild.get(id);
    if (currentItem) {
      if (!shiftIfHead(id, currentItem)) removeQueueItem(id, currentItem);
    }
    console.warn('[playback-loop] stream error with repeat ON — forcing skip', id);
  }

  if (verdict.scheduleNext) {
    void schedulePlayNext(id, 'player-idle');
  }
}

/**
 * Реакция на 'error' event от AudioPlayer. Логика 1:1 с legacy.
 * @param {string} id
 * @param {Error} err
 */
function handlePlayerError(id, err) {
  console.error('AudioPlayer error', id, err);
  killYtdlp(guildState.get(id));
}

/**
 * Observer для активного StreamHandle.
 *
 * Транслирует AudioPlayerStatus в доменный статус handle'а (FLOWING → STABLE
 * через stability-timer, финальный Idle → maybe-resolve при закрытых procs).
 * handle.whenEnded → `s.lastEndReason` → `handlePlayerIdle::streamFailed`.
 *
 * @param {string} id
 * @param {'Playing'|'Paused'|'AutoPaused'|'Idle'|'Buffering'|null} mapped
 */
function handlePlayerStateChange(id, mapped) {
  if (!mapped) return;
  const s = guildState.get(id);
  const handle = s?.streamHandle;
  if (!handle) return;
  try {
    handle.notifyPlayerState(mapped);
  } catch {
    /* handle-observer не должен ломать стрим */
  }
}

registerPlayerControllerCallbacks({
  onIdle: handlePlayerIdle,
  onPlayerError: handlePlayerError,
  onPlayerStateChange: handlePlayerStateChange,
});

// ─── Per-guild state accessors (public API) ──────────────────────────────────

/**
 * Get-or-create per-guild playback state. Ensures AudioPlayer exists.
 * Пришло на замену внутреннего `getState` из music.js.
 * @param {string} guildId
 */
export function ensureGuildMusicState(guildId) {
  const id = String(guildId);
  if (!guildState.has(id)) {
    guildState.set(id, {
      ytdlp: null,
      ffmpegNormalize: null,
    });
  }
  ensurePlayer(id);
  return guildState.get(id);
}

/**
 * Read-only getter: returns state if exists, без создания.
 * Используется в stopAndLeave / skip / previousTrack (им нужен `s` для teardown,
 * но они не должны «оживлять» state гильдии без плеера).
 * @param {string} guildId
 * @returns {GuildMusicState | undefined}
 */
export function getGuildMusicState(guildId) {
  return guildState.get(String(guildId));
}

// yt-dlp semaphore + spawn переехали в audio-pipeline.js (Шаг 3).

async function runPlayNext(guildId) {
  const id = String(guildId);
  const s = guildState.get(id);
  if (!s) return;
  if (!isConnectionAlive(id)) {
    if (getQueueLength(id) === 0 && onPlaybackIdle) {
      try {
        onPlaybackIdle(id);
      } catch (e) {
        console.warn('[playback-loop] onPlaybackIdle', e);
      }
    }
    return;
  }
  /** Не shift до успешного старта трека — между треками очередь не пуста, лишний Idle не считает сессию завершённой. */
  const nextItem = peekNext(id);
  if (!nextItem) {
    /** Очередь кончилась естественно — сбрасываем repeat, чтобы не светилась кнопка при idle. */
    repeatByGuild.delete(id);
    currentQueueItemByGuild.delete(id);

    /**
     * Автоплей: await внутри той же цепочки runPlayNext — пока идёт поиск, не вызываем второй
     * schedulePlayNext из параллельного микротаска (иначе гонка: старый трек + новый спавн).
     */
    if (autoplayByGuild.has(id)) {
      const seed = buildAutoplaySeedForGroq(id) ?? currentPlayingLabelByGuild.get(id);
      if (seed) {
        setPlayerState(id, PlayerState.LOADING); // autoplay is searching
        // METRICS:BASELINE spawn_end, idle_to_play (autoplay-baseline.js, AUTOPLAY_BASELINE_LOG=1)
        baselineAutoplaySpawnBegin(id);
        const _spawnT0 = Date.now();
        console.log(`[autoplay] spawn start guild=${id}`);
        const outcome = await spawnAutoplayPlaylist(id, seed);
        console.log(`[autoplay] spawn end guild=${id} outcome=${outcome} elapsed=${Date.now()-_spawnT0}ms`);
        baselineAutoplaySpawnEnd(id, outcome);
        const sAfter = guildState.get(id);
        if (!sAfter) return;
        if (getQueueLength(id) > 0) {
          /** Нельзя `return schedulePlayNext(id)` и await — deadlock: см. playback-schedule.js, JOURNAL. */
          void schedulePlayNext(id, 'autoplay-after-spawn');
          return;
        }
        // autoplay found nothing — exhausted with reason.
        // If user turned ∞ off while spawn was running, don't carry the AUTOPLAY_ERROR
        // reason: the user explicitly disabled autoplay, so idle state is expected.
        const autoplayStillOn = autoplayByGuild.has(id);
        setPlayerState(id, PlayerState.IDLE_EXHAUSTED, autoplayStillOn ? StatusReason.AUTOPLAY_ERROR : StatusReason.NONE);
        if (!sAfter.playing && onPlaybackIdle) {
          try {
            onPlaybackIdle(id);
          } catch (e) {
            console.warn('[playback-loop] onPlaybackIdle', e);
          }
        }
        return;
      }
    }

    setPlayerState(id, PlayerState.IDLE_EXHAUSTED);
    if (onPlaybackIdle) {
      try {
        onPlaybackIdle(id);
      } catch (e) {
        console.warn('[playback-loop] onPlaybackIdle', e);
      }
    }
    return;
  }
  try {
    setPlayerState(id, PlayerState.LOADING); // resolving URL / awaiting voice ready
    notifyPlaybackUiRefresh(id);
    const itemUrl = tryNormalizeYoutubeUrl(String(nextItem.url)) ?? String(nextItem.url);
    let url = itemUrl;
    let label = itemUrl;

    const _t0 = Date.now();
    console.log(`[play] ▶ guild=${id} src=${nextItem.source} url=${itemUrl.slice(-20)} title="${nextItem.title?.slice(0,40) ?? '(none)'}"`);

    if (isDirectUrl(itemUrl)) {
      url = itemUrl;
      if (isPlayabilityHardSkipEnabled() && isUrlMarkedBad(url)) {
        console.warn('[playback-loop] hard-skip known-bad URL', id, url);
        dequeueQueueItemAndScheduleNext(id, nextItem, 'playability-hard-skip');
        return;
      }
      // Skip video_basic_info when title is already known (autoplay/prefetch tracks).
      // For user-added URLs without a stored title, fetch the canonical title as before.
      if (nextItem.title) {
        label = String(nextItem.title);
        console.log(`[play] title from queue (${Date.now()-_t0}ms)`);
      } else {
        console.log(`[play] fetching title via video_basic_info…`);
        label = await resolveYoutubeCanonicalTitle(itemUrl, itemUrl);
        console.log(`[play] title fetched (${Date.now()-_t0}ms): "${label.slice(0,50)}"`);
      }
    } else {
      console.log(`[play] resolveYoutubeFromQuery…`);
      const resolved = await resolveYoutubeFromQuery(nextItem.url);
      console.log(`[play] query resolved (${Date.now()-_t0}ms): ${resolved.url.slice(-20)}`);
      url = resolved.url;
      if (isPlayabilityHardSkipEnabled() && isUrlMarkedBad(url)) {
        console.warn('[playback-loop] hard-skip known-bad URL (from query)', id, url);
        dequeueQueueItemAndScheduleNext(id, nextItem, 'playability-hard-skip');
        return;
      }
      if (nextItem.title) {
        label = String(nextItem.title);
      } else {
        label = await resolveYoutubeCanonicalTitle(resolved.url, resolved.label);
        console.log(`[play] title fetched (${Date.now()-_t0}ms)`);
      }
    }

    console.log(`[play] starting stream (${Date.now()-_t0}ms)…`);
    await streamUrl(id, url, label);
    console.log(`[play] stream started (${Date.now()-_t0}ms) label="${label.slice(0,50)}"`);

    /** Запомним QueueItem сейчас играющего — нужно для toggleRepeat в середине трека. */
    currentQueueItemByGuild.set(id, nextItem);
    const escapeSnapshot = getAutoplayEscapeSnapshot(id);
    if (
      escapeSnapshot.phase === 'trial' &&
      nextItem.spawnId != null &&
      escapeSnapshot.currentSpawnId === nextItem.spawnId
    ) {
      markAutoplayEscapeTrackStarted(id, nextItem.spawnId, {
        reason: 'playback_track_started',
        source: nextItem.source,
        title: label,
      });
    }
    setPlayerState(id, PlayerState.PLAYING);
    /** Source теперь известен — emit после set. */
    void emitSignal('track_started', {
      guildId: id,
      sessionId: getSessionId(id),
      actor: null,                                           // started by playback loop, not a user action
      requestedBy: nextItem.requestedBy ?? null,
      triggeredBy: sourceToTriggeredBy(nextItem.source),
      spawnId: nextItem.spawnId ?? null,
      listenersCount: getListenersCount(id),
      url: currentPlayingUrlByGuild.get(id) ?? nextItem.url,
      title: currentPlayingLabelByGuild.get(id) ?? nextItem.url,
    });
    // Proactive prefetch: while the track plays, pre-fill the candidate pool in the background.
    // Only triggered when autoplay is on and pool is below threshold.
    // Fire-and-forget — never awaited, never blocks playback.
    void runProactivePrefetch(id, currentPlayingLabelByGuild.get(id) ?? nextItem.url, {
      isAutoplayOn:   () => autoplayByGuild.has(id),
      buildPivotSeed: () => buildAutoplayPivotSeed(id),
      searchByQuery:  pickDistinctTrackVideos,
      searchByArtist: pickTracksForArtist,
      isUrlBlocked:   (url) => isYoutubeUrlBlockedForAutoplaySpawns(id, url),
    });
    // METRICS:TXT session-tracks.txt
    void logTrackStarted({
      guildId: id,
      url: currentPlayingUrlByGuild.get(id) ?? nextItem.url,
      title: currentPlayingLabelByGuild.get(id) ?? nextItem.url,
      source: nextItem.source,
    });

    /** Повтор: не сдвигаем очередь — nextItem остаётся на queue[0] и сыграет снова. */
    if (!repeatByGuild.has(id)) {
      if (!shiftIfHead(id, nextItem)) removeQueueItem(id, nextItem);
    }
  } catch (e) {
    console.error('playNext', e);
    // METRICS:BASELINE playback_abort | METRICS:PLAYABILITY (кэш bad)
    baselinePlaybackAborted(id, 'playNext_catch', nextItem?.url ?? '', e);
    recordPlayabilityFailure({
      guildId: id,
      watchUrl: nextItem?.url ?? '',
      kind: 'playback_catch',
      detail: e instanceof Error ? e.message : String(e),
    });
    markNotPlaying(id);
    killYtdlp(s);
    /** При ошибке всегда сдвигаем — иначе зависший трек будет повторяться бесконечно. */
    if (!shiftIfHead(id, nextItem)) removeQueueItem(id, nextItem);
    void schedulePlayNext(id, 'play-error-recovery');
  }
}

export const schedulePlayNext = createSchedulePlayNext(runPlayNext);

/**
 * Снять элемент из очереди и запланировать следующий трек (без ошибки плеера).
 * Используется для hard gate по playability-кэшу.
 *
 * @param {string} guildId
 * @param {import('./queue-invariants.js').QueueItem} queueItem
 * @param {string} reason
 */
function dequeueQueueItemAndScheduleNext(guildId, queueItem, reason) {
  const id = String(guildId);
  if (!shiftIfHead(id, queueItem)) removeQueueItem(id, queueItem);
  void schedulePlayNext(id, reason);
}

async function streamUrl(guildId, url, label) {
  const id = String(guildId);

  const s = guildState.get(id);
  if (!s || !isConnectionAlive(id)) {
    throw new Error('Нет голосового соединения');
  }
  await awaitVoiceReady(id, 15_000);

  killYtdlp(s);

  /**
   * Разделение обязанностей (Шаг 6c-b: shadow-слой выключен):
   *
   * audio-pipeline владеет:
   *   - yt-dlp semaphore, процессом yt-dlp и опциональным ffmpeg-normalize;
   *   - созданием StreamHandle и подпиской его на **все** process/stderr события;
   *   - classifier-логом (pure observation через stream-error-classifier).
   *
   * playback-loop владеет (т.е. этот модуль):
   *   - хранением procs/handle в per-guild state (`s.ytdlp`, `s.ffmpegNormalize`,
   *     `s.streamHandle`) для teardown и forwarding AudioPlayer состояния;
   *   - реакцией на `handle.whenEnded` — записью типизированного `lastEndReason`
   *     (читается в `handlePlayerIdle` как единственный источник истины),
   *     вызовом метрик `baselineStreamFail` / `recordPlayabilityFailure` **один
   *     раз при kind==='fatal'**, и диагностическим `logStreamEnd`;
   *   - per-guild nulling процессов на их `close` (чтобы `killYtdlp` оставался
   *     идемпотентным). Идентификация `=== ytdlpProc` отсекает «эхо» от
   *     прошлых процессов при быстром skip.
   */
  const { handle, resource, ytdlpProc, ffmpegProc } = await createAudioStream({
    url,
    label,
    guildId: id,
  });

  s.ytdlp = ytdlpProc;
  if (ffmpegProc) s.ffmpegNormalize = ffmpegProc;

  // Новый стрим → отменяем предыдущий handle (cancelled EndReason), обнуляем
  // lastEndReason. Procs предыдущего стрима к этому моменту убиты через killYtdlp
  // выше.
  try { s.streamHandle?.cancel?.(); } catch { /* noop */ }
  s.streamHandle = handle;
  s.lastEndReason = null;

  // Единственная реакция playback-loop на lifecycle handle'а.
  void handle.whenEnded.then((endReason) => {
    if (s.streamHandle === handle) {
      s.lastEndReason = endReason;
      s.streamHandle = null;
    }

    if (endReason.kind === 'fatal') {
      const detail = `${endReason.class}:${endReason.context}`.slice(0, 400);
      try { baselineStreamFail(id, url, endReason.class, detail); } catch { /* metrics must not throw */ }
      try {
        recordPlayabilityFailure({
          guildId: id,
          watchUrl: url,
          kind: endReason.class,
          detail,
        });
      } catch { /* metrics must not throw */ }
      console.error(`[playback-loop] stream fatal guild=${id} class=${endReason.class} ctx=${endReason.context}`);
    }

    try {
      logStreamEnd({ guildId: id, url, endReason, snapshot: handle.snapshot() });
    } catch { /* metrics logging must not throw */ }
  });

  // Минимальные nulling-listener'ы — per-guild process tracker, НЕ legacy-флаги.
  // Гарантируют, что `killYtdlp` на closed proc не отправит SIGKILL мёртвой ссылке
  // и не засорит state. Identity-guard защищает от race при быстром skip.
  ytdlpProc.on('close', (code) => {
    if (s.ytdlp === ytdlpProc) s.ytdlp = null;
    if (code !== 0 && code !== null) {
      console.warn('[playback-loop] yt-dlp exited', id, 'code', code);
    }
  });
  ytdlpProc.on('error', (err) => {
    console.error('[playback-loop] yt-dlp process error', id, err);
  });

  if (ffmpegProc) {
    ffmpegProc.on('close', (code) => {
      if (s.ffmpegNormalize === ffmpegProc) s.ffmpegNormalize = null;
      if (code !== 0 && code !== null) {
        console.warn('[playback-loop] ffmpeg normalize exited', id, 'code', code);
      }
    });
    ffmpegProc.on('error', (err) => {
      console.error('[playback-loop] ffmpeg normalize process error', id, err);
    });
  }

  const urlLeftForHistory = currentPlayingUrlByGuild.get(id);
  const skipStackPush = consumeSuppressHistoryPush(id);
  /**
   * Если skipStackPush (= навигация ⏮/⏭) — курсор оставляем: следующий ⏮/⏭ должен
   * продолжить по той же сессии. При обычном новом треке (skip в середине, новый запрос
   * через следующий schedulePlayNext) — курсор сбрасываем, начинаем сессию заново.
   */
  if (!skipStackPush) {
    deleteIdleNavCursor(id);
    deleteIdleBackForwardTail(id);
  }
  /** Не класть в стек тот же URL (повтор после доигрывания) — иначе «назад» даёт дубликаты в очереди. */
  if (!skipStackPush && urlLeftForHistory && urlLeftForHistory !== url) {
    const stack = getPastTrackUrls(id);
    stack.push(urlLeftForHistory);
    while (stack.length > PAST_TRACKS_CAP) stack.shift();
    setPastTrackUrls(id, stack);
  }

  playResource(id, resource);
  // METRICS:BASELINE idle_to_play (после spawn автоплея; см. baselinePlaybackStarted)
  baselinePlaybackStarted(id, url);
  // METRICS:PLAYABILITY soft_ok при успешном старте (shadow)
  clearPlayabilityBadOnSuccessfulPlay(url);
  currentPlayingUrlByGuild.set(id, url);
  currentPlayingLabelByGuild.set(id, String(label));
  /** Не добавлять в историю сессии при навигации — иначе hist растёт и курсор сбивается. */
  if (!skipStackPush) {
    const sess = getSessionPlayedWatchUrls(id);
    if (sess.length === 0 || sess[sess.length - 1] !== url) {
      sess.push(url);
      while (sess.length > SESSION_PLAYED_CAP) sess.shift();
      setSessionPlayedWatchUrls(id, sess);
    }
    console.log(`[session] guild=${id} sess=[${sess.map(u => '…' + u.slice(-8)).join(', ')}]`);
    /** Копим все названия сессии для Groq-контекста автоплея (всегда, не только при ∞). */
    // Санитизируем: оставляем только ASCII + кирилл + латиница + пробелы/пунктуация
    const cleanTitle = String(label)
      .replace(/[\u0000-\u001F\uFFFD]/g, '')   // control chars & replacement char
      .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, ' ') // всё что не буква/цифра/пункт/пробел
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (cleanTitle) appendAutoplaySessionTitle(id, cleanTitle);
  }
  console.log(`[playback-loop] ${id} playing: ${label}`);
  if (onPlayingTrackDisplay) {
    try {
      onPlayingTrackDisplay(id, String(label));
    } catch (e) {
      console.warn('[playback-loop] onPlayingTrackDisplay', e);
    }
  }
}
