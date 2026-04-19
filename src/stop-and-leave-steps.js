/**
 * reset operational subsystems before full stop.
 * Порядок вызовов задается вызывающей стороной.
 *
 * @param {string} guildId
 * @param {{
 *   invalidateAutoplaySpawn: (guildId: string) => void,
 *   resetAutoplayRecoveryStreak: (guildId: string) => void,
 *   clearVarietyState: (guildId: string) => void,
 *   clearIdleNavigationState: (guildId: string) => void,
 * }} deps
 */
export function resetStopAndLeaveOperationalState(guildId, deps) {
  deps.invalidateAutoplaySpawn(guildId);
  deps.resetAutoplayRecoveryStreak(guildId);
  deps.clearVarietyState(guildId);
  deps.clearIdleNavigationState(guildId);
}

/**
 * clear guild-level runtime caches/flags for full stop.
 *
 * @param {string} guildId
 * @param {{
 *   repeatByGuild: Set<string>,
 *   autoplayByGuild: Set<string>,
 *   clearAutoplaySessionState: (guildId: string) => void,
 *   currentQueueItemByGuild: Map<string, unknown>,
 *   currentPlayingUrlByGuild: Map<string, string>,
 *   currentPlayingLabelByGuild: Map<string, string>,
 *   clearAutoLeaveTimer: (guildId: string) => void,
 *   clearSignalBuffer: (guildId: string) => void,
 *   resetPlaybackMetricsSession: (guildId: string) => void,
 *   clearQueue: (guildId: string) => void,
 *   clearPrefetchPool?: (guildId: string) => void,
 * }} deps
 */
export function clearStopAndLeaveRuntimeState(guildId, deps) {
  deps.repeatByGuild.delete(guildId);
  deps.autoplayByGuild.delete(guildId);
  deps.clearAutoplaySessionState(guildId);
  deps.currentQueueItemByGuild.delete(guildId);
  deps.currentPlayingUrlByGuild.delete(guildId);
  deps.currentPlayingLabelByGuild.delete(guildId);
  deps.clearAutoLeaveTimer(guildId);
  deps.clearSignalBuffer(guildId);
  deps.resetPlaybackMetricsSession(guildId);
  deps.clearQueue(guildId);
  if (typeof deps.clearPrefetchPool === 'function') {
    deps.clearPrefetchPool(guildId);
  }
}

/**
 * release player/connection resources for a guild.
 *
 * Очередь больше не живёт на `s` (Шаг 4: queue-manager.js — единственный владелец).
 * VoiceConnection тоже больше не живёт на `s` (Шаг 5: voice-adapter.js —
 * единственный владелец): `leaveConnection` через DI делегирует уничтожение
 * соединения адаптеру, который параллельно дёрнет onVoiceGone → orchestrator
 * → endSession/setBotVoiceState.
 *
 * AudioPlayer + флаг `playing` тоже не на `s` (Шаг 6a: player-controller.js —
 * единственный владелец): `stopPlayer` через DI делегирует остановку контроллеру,
 * который атомарно сбрасывает internal `playing` и зовёт `player.stop(true)`.
 *
 * `s` остаётся только как контейнер процессов yt-dlp/ffmpeg для killYtdlp —
 * уедет в audio-pipeline на Шаге 7.
 *
 * @param {any} s
 * @param {(s: any) => void} killYtdlp
 * @param {() => void} stopPlayer
 * @param {() => void} leaveConnection
 */
export function teardownGuildPlaybackState(s, killYtdlp, stopPlayer, leaveConnection) {
  if (s) killYtdlp(s);
  if (typeof stopPlayer === 'function') {
    try {
      stopPlayer();
    } catch {
      /* ignore — контроллер сам логирует */
    }
  }
  if (typeof leaveConnection === 'function') {
    try {
      leaveConnection();
    } catch {
      /* ignore — адаптер сам логирует */
    }
  }
}
