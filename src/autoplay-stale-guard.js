/**
 * Stale guard для async автоплея (этап 6): токен поколения на гильдию.
 * Инвалидирует in-flight spawn при bump (stop / выход / выкл. ∞).
 *
 * Зависимости передаются через `ctx` — модуль не тянет ни `music.js`, ни
 * `voice-adapter.js` напрямую. Владельцы этих состояний подкладывают свои
 * геттеры.
 *
 * METRICS: при METRICS_TXT≠0 → data/metrics/autoplay-debug.txt (строка stale …);
 * иначе stdout [autoplay:stale]; если ещё AUTOPLAY_DEBUG=1 и метрики в консоли — autoplayDebug(stale_discard).
 */

import { isPlaybackMetricsEnabled, logStaleGuardLine } from './playback-metrics.js';
import { autoplayDebug } from './autoplay-telemetry.js';

/** @type {Map<string, number>} */
const spawnGenerationByGuild = new Map();

export function isAutoplayStaleGuardEnabled() {
  return String(process.env.AUTOPLAY_STALE_GUARD_ENABLED ?? '1').trim() !== '0';
}

/**
 * Новый запуск подбора: увеличить поколение и вернуть токен для проверок.
 * @param {string} guildId
 */
export function bumpAutoplaySpawnGeneration(guildId) {
  const id = String(guildId);
  const n = (spawnGenerationByGuild.get(id) ?? 0) + 1;
  spawnGenerationByGuild.set(id, n);
  return n;
}

/**
 * Инвалидировать текущий in-flight spawn (без нового «старта»).
 * @param {string} guildId
 */
export function invalidateAutoplaySpawn(guildId) {
  bumpAutoplaySpawnGeneration(guildId);
}

export function getAutoplaySpawnGeneration(guildId) {
  return spawnGenerationByGuild.get(String(guildId)) ?? 0;
}

/**
 * @param {string} guildId
 * @param {number} myGen — значение из начала этого spawn
 */
export function isAutoplaySpawnStaleToken(guildId, myGen) {
  return getAutoplaySpawnGeneration(guildId) !== myGen;
}

function logAutoplayStaleDiscard(id, phase, reason, extra = {}) {
  const payload = { guildId: id, phase, reason, ...extra };
  if (isPlaybackMetricsEnabled()) {
    logStaleGuardLine(payload);
  } else {
    console.warn(`[autoplay:stale] ${JSON.stringify(payload)}`);
    autoplayDebug(id, 'stale_discard', payload);
  }
}

/**
 * @param {string} id
 * @param {number} myGen
 * @param {string} phase
 * @param {{
 *   isConnectionAlive: (guildId: string) => boolean,
 *   isPlaying: (guildId: string) => boolean,
 *   hasAutoplay: (guildId: string) => boolean,
 *   getQueueLength: (guildId: string) => number,
 * }} ctx
 * @returns {'generation' | 'no_connection' | 'autoplay_off' | 'state' | null}
 */
export function checkAutoplaySpawnStaleDiscard(id, myGen, phase, ctx) {
  if (!isAutoplayStaleGuardEnabled()) return null;
  if (isAutoplaySpawnStaleToken(id, myGen)) {
    logAutoplayStaleDiscard(id, phase, 'generation');
    return 'generation';
  }
  if (!ctx.isConnectionAlive(id)) {
    logAutoplayStaleDiscard(id, phase, 'no_connection');
    return 'no_connection';
  }
  if (!ctx.hasAutoplay(id)) {
    logAutoplayStaleDiscard(id, phase, 'autoplay_off');
    return 'autoplay_off';
  }
  const queueLength = ctx.getQueueLength(id);
  const playing = ctx.isPlaying(id);
  if (playing || queueLength > 0) {
    logAutoplayStaleDiscard(id, phase, 'queue_or_playing', {
      queueLength,
      playing,
    });
    return 'state';
  }
  return null;
}
