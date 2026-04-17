/**
 * METRICS:BASELINE — события замера автоплея (этап 0).
 * Куда: при METRICS_TXT_ENABLED≠0 → data/metrics/baseline.txt; иначе stdout [autoplay:baseline]
 * Вкл. записи: AUTOPLAY_BASELINE_LOG=1 — без флага все функции no-op.
 * Док: docs/НАБЛЮДАЕМОСТЬ.md, docs/AUTOPLAY-IMPLEMENTATION-PLAN.md
 *
 * События:
 *   spawn_end — завершение spawnAutoplayPlaylist (spawnMs, groqCalls, outcome)
 *   idle_to_play — от начала spawn до player.play() (totalMs, groqCalls, videoId)
 *   stream_fail — ошибка воспроизведения / стрима (videoId, reason)
 */

import { isPlaybackMetricsEnabled, logBaselineJson } from './playback-metrics.js';
import { extractYoutubeVideoId } from './queue-invariants.js';

export function isAutoplayBaselineLogEnabled() {
  return String(process.env.AUTOPLAY_BASELINE_LOG ?? '').trim() === '1';
}

/**
 * @param {Record<string, unknown>} obj
 */
function emitBaseline(obj) {
  if (isPlaybackMetricsEnabled()) {
    logBaselineJson(obj);
  } else {
    console.log(`[autoplay:baseline] ${JSON.stringify(obj)}`);
  }
}

/** @type {Map<string, { tSpawnStart: number, groqCalls: number }>} */
const pendingSpawn = new Map();

/**
 * Вызвать сразу перед `await spawnAutoplayPlaylist` (ветка автоплея).
 * @param {string} guildId
 */
export function baselineAutoplaySpawnBegin(guildId) {
  if (!isAutoplayBaselineLogEnabled()) return;
  const id = String(guildId);
  pendingSpawn.set(id, { tSpawnStart: Date.now(), groqCalls: 0 });
}

/**
 * Один HTTP-вызов Groq внутри цикла автоплея (struct / legacy / artist-pack).
 * @param {string} guildId
 */
export function baselineGroqCall(guildId) {
  if (!isAutoplayBaselineLogEnabled()) return;
  const s = pendingSpawn.get(String(guildId));
  if (s) s.groqCalls += 1;
}

/**
 * @param {string} guildId
 * @param {'queued' | 'skip' | 'fail'} outcome
 */
export function baselineAutoplaySpawnEnd(guildId, outcome) {
  if (!isAutoplayBaselineLogEnabled()) return;
  const id = String(guildId);
  const s = pendingSpawn.get(id);
  if (!s) return;
  const spawnMs = Date.now() - s.tSpawnStart;
  emitBaseline({
    event: 'spawn_end',
    guildId: id,
    outcome,
    spawnMs,
    groqCalls: s.groqCalls,
  });
  if (outcome !== 'queued') {
    pendingSpawn.delete(id);
  }
  /** при `queued` pending остаётся до playback или abort */
}

/**
 * После успешного `player.play` в streamUrl для замера idle→play.
 * @param {string} guildId
 * @param {string} watchUrl
 */
export function baselinePlaybackStarted(guildId, watchUrl) {
  if (!isAutoplayBaselineLogEnabled()) return;
  const id = String(guildId);
  const s = pendingSpawn.get(id);
  if (!s) return;
  const totalMs = Date.now() - s.tSpawnStart;
  const videoId = extractYoutubeVideoId(String(watchUrl)) ?? null;
  emitBaseline({
    event: 'idle_to_play',
    guildId: id,
    totalMs,
    groqCalls: s.groqCalls,
    videoId,
  });
  pendingSpawn.delete(id);
}

/**
 * Очистить pending (ошибка после queued, или сброс состояния).
 * @param {string} guildId
 * @param {string} reason
 * @param {string} [watchUrl]
 * @param {unknown} [err]
 */
export function baselinePlaybackAborted(guildId, reason, watchUrl = '', err = null) {
  if (!isAutoplayBaselineLogEnabled()) return;
  const id = String(guildId);
  const had = pendingSpawn.has(id);
  pendingSpawn.delete(id);
  if (!had) return;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  emitBaseline({
    event: 'playback_abort',
    guildId: id,
    reason: String(reason).slice(0, 120),
    videoId: watchUrl ? extractYoutubeVideoId(String(watchUrl)) ?? null : null,
    error: msg.slice(0, 400),
  });
}

/**
 * Неудача стрима / yt-dlp (для классификации причин в baseline).
 * @param {string} guildId
 * @param {string} watchUrl
 * @param {string} kind
 * @param {string} [detail]
 */
export function baselineStreamFail(guildId, watchUrl, kind, detail = '') {
  if (!isAutoplayBaselineLogEnabled()) return;
  const videoId = extractYoutubeVideoId(String(watchUrl)) ?? null;
  emitBaseline({
    event: 'stream_fail',
    guildId: String(guildId),
    videoId,
    kind: String(kind).slice(0, 80),
    detail: String(detail).slice(0, 500),
  });
}
