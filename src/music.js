/**
 * music.js — facade над модульной музыкальной подсистемой (Шаг 10).
 *
 * После рефакторинга (Шаги 4..10) этот файл больше НЕ содержит ни state'а
 * гильдий, ни процессов, ни цикла воспроизведения. Он только:
 *
 *   1. Собирает target'ы для `orchestrator.commands.*`:
 *      enqueue, skip, previousTrack, pauseMusic, resumeMusic,
 *      toggleRepeat, toggleAutoplay, stopAndLeave.
 *
 *   2. Отдаёт read-only query'и UI-слою:
 *      isGuildPlayingMusic, getMusicTransportState,
 *      getRepeatableTrackLabel, getCurrentPlaybackInfo.
 *
 *   3. Регистрирует пользовательский запрос как seed автоплея:
 *      registerAutoplayUserQuery.
 *
 *   4. Re-export'ит callback-setters из `playback-loop.js` плюс свой
 *      локальный `setOnMusicForceStop`, который вызывается при stopAndLeave
 *      (UI чистит свои сообщения).
 *
 * Владение state'ом:
 *   - Очередь          → queue-manager.js
 *   - VoiceConnection  → voice-adapter.js
 *   - AudioPlayer      → player-controller.js
 *   - Процессы + loop  → playback-loop.js
 *   - Сессия / PlayerState → guild-session-state.js
 *   - Автоплей state   → autoplay-session-state.js
 *   - Навигация        → idle-navigation-state.js + idle-navigation-machine-api.js
 *
 * Этот файл НЕ импортирует `@discordjs/voice`, `ffmpeg-static`, `yt-dlp`, play-dl
 * и т.п. — иначе ответственность начинает расползаться обратно.
 */

import {
  ensureVoiceConnection,
  leave as voiceLeave,
  isConnectionAlive,
  clearAutoLeaveTimer,
  checkVoiceChannelEmptyNow,
} from './voice-adapter.js';
import {
  ensurePlayer,
  isPlaying as isPlayerPlaying,
  pause as playerPause,
  resume as playerResume,
  stopPlayer,
  getStatus as getPlayerStatus,
} from './player-controller.js';
import {
  enqueueTrack,
  getQueueLength,
  getQueueOps,
  clearQueue,
} from './queue-manager.js';
import {
  ensureGuildMusicState,
  getGuildMusicState,
  killYtdlp,
  schedulePlayNext,
  setOnAutoplaySpawned,
  setOnPlaybackIdle,
  setOnPlaybackUiRefresh,
  setOnPlayingTrackDisplay,
} from './playback-loop.js';
import {
  autoplayByGuild,
  currentPlayingLabelByGuild,
  currentPlayingUrlByGuild,
  currentQueueItemByGuild,
  repeatByGuild,
  getListenersCount,
  getSessionId,
  PlayerState,
} from './guild-session-state.js';
import {
  setAutoplayInitialSeedIfAbsent,
  setAutoplayLastIntent,
  clearAutoplaySessionState,
} from './autoplay-session-state.js';
import { invalidateAutoplaySpawn } from './autoplay-stale-guard.js';
import { resetAutoplayRecoveryStreak } from './autoplay-recovery.js';
import { clearVarietyState } from './autoplay-variety.js';
import {
  clearIdleNavigationState,
  getIdleBackForwardTail,
  markSuppressTrackFinishedOnce,
  getPastTrackUrls,
  getSessionPlayedWatchUrls,
} from './idle-navigation-state.js';
import {
  executeIdlePreviousMachine,
  executeLivePreviousMachine,
  executeSkipPreStopMachine,
} from './idle-navigation-machine-api.js';
import { stopWithNavigationSignal } from './navigation-stop-flow.js';
import {
  clearSignalBuffer,
  emitSignal,
  sourceToTriggeredBy,
} from './music-signals.js';
import { recordPlaybackHistory } from './playback-history.js';
import { resetPlaybackMetricsSession } from './playback-metrics.js';
import { sameYoutubeContent } from './queue-invariants.js';
import {
  detectProvider,
  providerTrackIdFromUrl,
} from './track-provider.js';
import {
  resolvePlayerUIState,
} from './guild-session-state.js';
import {
  clearStopAndLeaveRuntimeState,
  resetStopAndLeaveOperationalState,
  teardownGuildPlaybackState,
} from './stop-and-leave-steps.js';

// ─── Re-export callback setters ─────────────────────────────────────────────
// music-panel.js подписывается через music.js фасад, чтобы не зависеть
// напрямую от playback-loop.js (он слой ниже).

export {
  setOnAutoplaySpawned,
  setOnPlaybackIdle,
  setOnPlaybackUiRefresh,
  setOnPlayingTrackDisplay,
};

/** @type {((guildId: string) => void) | null} */
let onMusicForceStop = null;

/**
 * UI-колбэк: гарантированно удалить все сообщения бота (панель / очередь)
 * при полной остановке сессии. Вызывается из stopAndLeave().
 *
 * Живёт здесь (а не в playback-loop.js), потому что это UX-решение уровня
 * всей сессии — не часть цикла воспроизведения.
 *
 * @param {(guildId: string) => void} fn
 */
export function setOnMusicForceStop(fn) {
  onMusicForceStop = fn;
}

function notifyForceStop(guildId) {
  if (!onMusicForceStop) return;
  try {
    onMusicForceStop(String(guildId));
  } catch (e) {
    console.warn('[music] onMusicForceStop threw', e);
  }
}

// ─── enqueue ─────────────────────────────────────────────────────────────────

/**
 * Поставить трек в очередь гильдии. Если бот не в голосе — подключиться
 * к `channel`. Если плеер не создан — создать. Автоплей seed обновляется
 * независимо от source (user add во время ∞ тоже двигает last intent).
 *
 * @param {import('discord.js').VoiceBasedChannel} channel
 * @param {string} query — URL или текстовый запрос
 * @param {'single' | 'autoplay' | 'navigation'} [source='single']
 * @param {string | null} [userId]
 * @param {string | null} [userDisplayName]
 * @returns {Promise<{ panelHint: string, trackLabel: string }>}
 */
export async function enqueue(
  channel,
  query,
  source = 'single',
  userId = null,
  userDisplayName = null,
) {
  if (!channel?.guild) throw new Error('Нужен голосовой канал');
  const rawQuery = String(query ?? '').trim();
  if (!rawQuery) throw new Error('Пустой запрос');

  const guildId = String(channel.guild.id);
  const normalizedSource = source === 'autoplay' || source === 'navigation' ? source : 'single';

  // 1. Player: создаём до соединения, чтобы voice-adapter мог subscribe.
  const player = ensurePlayer(guildId);

  // 2. VoiceConnection: atomic ensure. Попутно фаерит onVoiceReady →
  //    orchestrator.events.onVoiceReady → startSession + setBotVoiceState.
  await ensureVoiceConnection(channel, player);

  // 3. Per-guild playback state (процессы-контейнер).
  ensureGuildMusicState(guildId);

  // 4. Dedup identity + queue item.
  /** @type {import('./queue-invariants.js').QueueItem} */
  const item = {
    url: rawQuery,
    source: normalizedSource,
    providerTrackId: providerTrackIdFromUrl(rawQuery),
    requestedBy: userId ?? null,
    requestedByName: userDisplayName ?? null,
    title: null,
  };

  const queueWasEmpty = getQueueLength(guildId) === 0 && !isPlayerPlaying(guildId);
  enqueueTrack(guildId, item);

  // 5. Автоплей seed: первый запрос сессии становится anchor, каждый — last intent.
  //    Пишем всегда: если ∞ включится позднее, у движка уже будет контекст.
  if (normalizedSource !== 'autoplay') {
    setAutoplayInitialSeedIfAbsent(guildId, rawQuery);
    setAutoplayLastIntent(guildId, rawQuery);
  }

  // 6. Кто-то пришёл в канал — снимаем pending auto-leave, если он был.
  clearAutoLeaveTimer(guildId);
  try {
    checkVoiceChannelEmptyNow(channel.guild);
  } catch (e) {
    console.warn('[music] checkVoiceChannelEmptyNow threw', e);
  }

  // 7. Планируем следующий запуск через per-guild promise chain.
  void schedulePlayNext(guildId, 'enqueue');

  // 8. UI-хинт для панели. Если что-то уже играло — добавляем как "в очереди".
  //    Иначе — хинт пустой, music-panel возьмёт fragment из state (LOADING).
  const trackLabel = rawQuery;
  const panelHint = queueWasEmpty ? '' : `В очереди: **${trackLabel}**`;
  return { panelHint, trackLabel };
}

// ─── skip / previousTrack / pause / resume ───────────────────────────────────

/**
 * Пропустить текущий трек. Возвращает false, если ничего не играет.
 *
 * Семантика:
 *   - repeat ON  → убираем head из очереди, чтобы stopPlayer → Idle не
 *     запустил тот же трек снова (эту работу делает executeSkipPreStopMachine).
 *   - idle-tail  → если после доигрывания был прописан tail «вперёд» по
 *     сессионной истории (нажали ⏮ и потом ⏭), его надо положить в queue head.
 *   - эмит сигнала `track_skipped` + suppress `track_finished` (чтобы Idle
 *     не эмитил второй сигнал о том же треке).
 *
 * @param {string} guildId
 * @param {string | null} [actorUserId]
 * @returns {boolean}
 */
export function skip(guildId, actorUserId = null) {
  const id = String(guildId);

  // Разрешаем skip из playing И paused. Раньше был строгий гейт
  // `if (!isPlayerPlaying) return false` — он оставлял пользователя
  // в «пауза → нельзя пропустить, надо сначала resume» (лишний клик).
  // stopPlayer() на паузе корректно даёт Idle → playNext.
  const nowPlaying = isPlayerPlaying(id);
  const status = getPlayerStatus(id)?.toString?.() ?? '';
  const paused = status === 'paused' || status === 'autopaused';
  if (!nowPlaying && !paused) return false;

  const s = getGuildMusicState(id);
  const queue = getQueueOps(id);
  const currentUrl = currentPlayingUrlByGuild.get(id) ?? '';
  const tail = getIdleBackForwardTail(id);

  executeSkipPreStopMachine({
    guildId: id,
    queue,
    repeatEnabled: repeatByGuild.has(id),
    tail: tail ?? null,
    currentUrl,
    sameYoutubeContent: sameYoutubeContent,
  });

  stopWithNavigationSignal({
    guildId: id,
    actor: actorUserId,
    sessionId: getSessionId(id),
    listenersCount: getListenersCount(id),
    s,
    signalName: 'track_skipped',
    currentPlayingUrlByGuild,
    currentPlayingLabelByGuild,
    currentQueueItemByGuild,
    emitSignal,
    recordPlaybackHistory,
    sourceToTriggeredBy,
    markSuppressTrackFinishedOnce,
    killYtdlp,
    stopPlayer,
  });

  return true;
}

/**
 * Перейти на предыдущий трек сессии.
 *
 * Ветки:
 *   - live (играет/пауза, есть стек past) → подложить prev + current в head
 *     очереди, остановить поток и эмитить `track_previous`.
 *   - idle (бот в канале, плеер idle, есть sessionHistory) → восстановить
 *     через idle-navigation history и запланировать `playNext`.
 *   - иначе — false (сигнализируем UI что некуда).
 *
 * Семантика: prev ВСЕГДА «назад по истории». Repeat НЕ делает из prev
 * рестарт текущего трека — это дало бы UI-контракту «prev = назад» две
 * разных семантики в зависимости от репита. Симметрично UI-фиксу
 * canPrevious в getMusicTransportState.
 *
 * @param {string} guildId
 * @param {string | null} [actorUserId]
 * @returns {boolean}
 */
export function previousTrack(guildId, actorUserId = null) {
  const id = String(guildId);
  if (!isConnectionAlive(id)) return false;

  const s = getGuildMusicState(id);
  const queue = getQueueOps(id);
  const currentUrl = currentPlayingUrlByGuild.get(id) ?? '';
  const currentItem = currentQueueItemByGuild.get(id) ?? null;
  const nowPlaying = isPlayerPlaying(id);

  const paused = getPlayerStatus(id) != null && !nowPlaying
    && (getPlayerStatus(id)?.toString?.() === 'paused'
      || getPlayerStatus(id)?.toString?.() === 'autopaused');

  // Живая ветка: текущий трек играет/на паузе + есть past-стек.
  if ((nowPlaying || paused) && getPastTrackUrls(id).length > 0) {
    const res = executeLivePreviousMachine({
      guildId: id,
      queue,
      currentUrl,
      currentOrigItem: currentItem,
    });
    if (!res.ok) return false;

    stopWithNavigationSignal({
      guildId: id,
      actor: actorUserId,
      sessionId: getSessionId(id),
      listenersCount: getListenersCount(id),
      s,
      signalName: 'track_previous',
      currentPlayingUrlByGuild,
      currentPlayingLabelByGuild,
      currentQueueItemByGuild,
      emitSignal,
      recordPlaybackHistory,
      sourceToTriggeredBy,
      markSuppressTrackFinishedOnce,
      killYtdlp,
      stopPlayer,
    });
    return true;
  }

  // Idle ветка: плеер молчит, но есть сессионная история.
  if (!nowPlaying && getSessionPlayedWatchUrls(id).length > 0) {
    const idleRes = executeIdlePreviousMachine({
      guildId: id,
      queue,
      currentUrl,
    });
    if (!idleRes.ok) return false;
    // Эмитим сигнал «назад» и планируем play: remote plays уже в очереди как head.
    void emitSignal('track_previous', {
      guildId: id,
      sessionId: getSessionId(id),
      actor: actorUserId,
      requestedBy: currentItem?.requestedBy ?? null,
      triggeredBy: 'navigation',
      listenersCount: getListenersCount(id),
      url: currentUrl,
      title: currentPlayingLabelByGuild.get(id) ?? '',
    });
    void schedulePlayNext(id, 'previous-idle');
    return true;
  }

  return false;
}

/**
 * Пауза. Возвращает false, если пауза неприменима (ничего не играет / уже на паузе).
 * @param {string} guildId
 * @returns {boolean}
 */
export function pauseMusic(guildId) {
  return playerPause(String(guildId));
}

/**
 * Снять паузу. Возвращает false, если резюм неприменим.
 * @param {string} guildId
 * @returns {boolean}
 */
export function resumeMusic(guildId) {
  return playerResume(String(guildId));
}

// ─── toggles ─────────────────────────────────────────────────────────────────

/**
 * Переключить repeat. Взаимоисключается с autoplay.
 * @param {string} guildId
 * @returns {boolean} новое состояние
 */
export function toggleRepeat(guildId) {
  const id = String(guildId);
  if (repeatByGuild.has(id)) {
    repeatByGuild.delete(id);
    return false;
  }
  repeatByGuild.add(id);
  autoplayByGuild.delete(id);
  // Новый repeat цикл → старые прогнозы автоплея больше не нужны.
  invalidateAutoplaySpawn(id);
  return true;
}

/**
 * Переключить autoplay. Взаимоисключается с repeat.
 * @param {string} guildId
 * @returns {boolean} новое состояние
 */
export function toggleAutoplay(guildId) {
  const id = String(guildId);
  if (autoplayByGuild.has(id)) {
    autoplayByGuild.delete(id);
    // При выключении автоплея отбрасываем pending spawn'ы (чтобы по завершении
    // поиска, идущего прямо сейчас, в очередь не попала лишняя подборка).
    invalidateAutoplaySpawn(id);
    return false;
  }
  autoplayByGuild.add(id);
  repeatByGuild.delete(id);
  return true;
}

// ─── stopAndLeave ────────────────────────────────────────────────────────────

/**
 * Полный стоп сессии и выход из голоса. Идемпотентен — безопасно вызывать
 * повторно (например, из auto-leave callback'а, если пользователь уже нажал
 * «остановить»).
 *
 * Порядок важен:
 *   1. operational reset (чтобы pending spawn не материализовался после stop).
 *   2. runtime reset (очищаем Map'ы, очереди, signals, metrics).
 *   3. autoplay/navigation state cleanup.
 *   4. tear-down плеера и соединения (через voice-adapter.leave →
 *      onVoiceGone → orchestrator.events.onVoiceGone → endSession).
 *   5. UI: notify force stop → удалить сообщения панели/очереди.
 *
 * @param {string} guildId
 */
export function stopAndLeave(guildId) {
  const id = String(guildId);
  const s = getGuildMusicState(id);

  resetStopAndLeaveOperationalState(id, {
    invalidateAutoplaySpawn,
    resetAutoplayRecoveryStreak,
    clearVarietyState,
    clearIdleNavigationState,
  });

  clearStopAndLeaveRuntimeState(id, {
    repeatByGuild,
    autoplayByGuild,
    clearAutoplaySessionState,
    currentQueueItemByGuild,
    currentPlayingUrlByGuild,
    currentPlayingLabelByGuild,
    clearAutoLeaveTimer,
    clearSignalBuffer,
    resetPlaybackMetricsSession,
    clearQueue,
  });

  teardownGuildPlaybackState(
    s,
    killYtdlp,
    () => stopPlayer(id),
    () => voiceLeave(id, 'user_leave'),
  );

  notifyForceStop(id);
}

// ─── autoplay user intent ────────────────────────────────────────────────────

/**
 * Зарегистрировать пользовательский запрос как seed автоплея. Должен
 * вызываться из index.js слэш-команд /play перед enqueue, чтобы у автоплея
 * был human-readable контекст (query pre-resolve, без yt title-поиска).
 *
 * Первый запрос сессии фиксируется как initial seed (anchor). Каждый
 * следующий — как last intent (primary focus).
 *
 * @param {string} guildId
 * @param {string} query
 */
export function registerAutoplayUserQuery(guildId, query) {
  const id = String(guildId);
  const q = String(query ?? '').trim();
  if (!q) return;
  setAutoplayInitialSeedIfAbsent(id, q);
  setAutoplayLastIntent(id, q);
}

// ─── Read-only state queries (для UI) ────────────────────────────────────────

/**
 * Играет ли сейчас что-то в гильдии.
 * @param {string} guildId
 * @returns {boolean}
 */
export function isGuildPlayingMusic(guildId) {
  return isPlayerPlaying(String(guildId));
}

/**
 * UI-state для панели (buildMusicControlRows).
 *
 * Решения (зеркалят, что реально отработает при нажатии — чтобы disabled кнопки
 * совпадал с `return false` в соответствующей команде music.js):
 *
 *   - hasActiveTrack — плеер подключён и либо играет, либо пауза, либо только
 *     что доиграл трек с текущим label (LOADING — переходное). Гейтит pause/resume,
 *     repeat, autoplay, like (всё что теряет смысл без «активного» трека).
 *
 *   - canPrevious — ОТДЕЛЁН от hasActiveTrack. Семантика «назад по истории»:
 *       - playing/paused → pastLen > 0 (реальный стек предыдущих треков)
 *       - idle в войсе   → sessLen > 0 (сессионная история после доигрывания)
 *     repeat НЕ даёт shortcut'а: на первом треке с repeat prev остаётся
 *     disabled, даже хотя previousTrack() technically может перезапустить
 *     текущий трек. Пользователь воспринимает prev как «назад», не «рестарт».
 *     Блокируется во время LOADING-перехода.
 *
 *   - canSkipForward — (playing ‖ paused) && (очередь / ∞ / idle-tail). На
 *     паузе skip авто-resume'ит через playNext после stopPlayer → Idle.
 *
 *   - canRepeatToggle / canAutoplayToggle — ТОЛЬКО при активном треке
 *     (playing/paused). Симметрия: оба тоггла — про поведение «прямо сейчас»,
 *     без контекста играющего трека они семантический шум (юзер видит
 *     подсвеченную кнопку, но не понимает что она делает).
 *
 *     Почему НЕ держим pre-arm в IDLE_EXHAUSTED для ∞:
 *       1. Апликейшн с рекомендатором (планируется) заменит autoplay-toggle
 *          на «always-on radio preview», и continue-station как отдельное
 *          действие исчезнет — витрина Up-Next сразу видна.
 *       2. Текущий youtube-related автоподбор не знает истории/лайков, и
 *          продолжение станции одним кликом часто даёт нерелевантный трек
 *          (тот же seed, те же проблемы что до IDLE_EXHAUSTED).
 *     Итого: сейчас вариант B (симметрия с repeat), рекомендатор прилетит
 *     отдельным UX-апдейтом.
 *
 *   - canLike — enabled когда hasActiveTrack ИЛИ IDLE_EXHAUSTED + в
 *     currentPlayingLabelByGuild ещё помнится последний трек («ретроспективный
 *     лайк» сразу после доигрывания, до teardown'а).
 *
 *   - loading — плеер в состоянии resolving URL / ждёт voice ready.
 *   - paused — player в Paused/AutoPaused.
 *
 * @param {string} guildId
 * @returns {{
 *   hasActiveTrack: boolean,
 *   paused: boolean,
 *   canPrevious: boolean,
 *   canSkipForward: boolean,
 *   canRepeatToggle: boolean,
 *   canAutoplayToggle: boolean,
 *   canLike: boolean,
 *   repeat: boolean,
 *   autoplay: boolean,
 *   loading: boolean,
 * }}
 */
export function getMusicTransportState(guildId) {
  const id = String(guildId);
  const { playerState } = resolvePlayerUIState(id);
  const status = getPlayerStatus(id);
  const statusStr = status?.toString?.() ?? '';
  const paused = statusStr === 'paused' || statusStr === 'autopaused';
  const playing = isPlayerPlaying(id);
  const loading = playerState === PlayerState.LOADING;
  const inVoice = isConnectionAlive(id);

  const hasActiveTrack = (playing || paused || loading) && inVoice;

  const pastLen = getPastTrackUrls(id).length;
  const sessLen = getSessionPlayedWatchUrls(id).length;

  let canPrevious = false;
  if (inVoice && !loading) {
    if (playing || paused) {
      canPrevious = pastLen > 0;
    } else {
      canPrevious = sessLen > 0;
    }
  }

  const canSkipForward =
    (playing || paused) && inVoice && !loading && (
      getQueueLength(id) > 0 ||
      autoplayByGuild.has(id) ||
      getIdleBackForwardTail(id) != null
    );

  // Оба тоггла симметричны: только при активном треке. См. доку выше.
  const canRepeatToggle = (playing || paused) && inVoice && !loading;
  const canAutoplayToggle = (playing || paused) && inVoice && !loading;

  // Ретроспективный лайк: IDLE_EXHAUSTED пока currentPlayingLabelByGuild
  // ещё помнит последний трек (до stopAndLeave полного teardown'а).
  const hasRememberedTrack =
    playerState === PlayerState.IDLE_EXHAUSTED &&
    inVoice &&
    currentPlayingLabelByGuild.has(id);
  const canLike = hasActiveTrack || hasRememberedTrack;

  return {
    hasActiveTrack,
    paused,
    canPrevious,
    canSkipForward,
    canRepeatToggle,
    canAutoplayToggle,
    canLike,
    repeat: repeatByGuild.has(id),
    autoplay: autoplayByGuild.has(id),
    loading,
  };
}

/**
 * Label текущего (или только что сыгравшего) трека. Используется панелью как
 * «Сейчас играет: <label>» при repeat — отсюда и имя.
 *
 * @param {string} guildId
 * @returns {string | null}
 */
export function getRepeatableTrackLabel(guildId) {
  const id = String(guildId);
  const lbl = currentPlayingLabelByGuild.get(id);
  return lbl ? String(lbl) : null;
}

/**
 * Подробная инфа о текущем воспроизведении для фрагментов панели
 * (например, "· ещё X в очереди").
 *
 * @param {string} guildId
 * @returns {{ url: string | null, label: string | null, queueDepth: number } | null}
 */
export function getCurrentPlaybackInfo(guildId) {
  const id = String(guildId);
  const url = currentPlayingUrlByGuild.get(id) ?? null;
  const label = currentPlayingLabelByGuild.get(id) ?? null;
  if (!url && !label) return null;
  return {
    url,
    label,
    queueDepth: getQueueLength(id),
  };
}
