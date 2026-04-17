/**
 * METRICS:DEBUG — стадии автоплея и формы промптов Groq.
 * Куда: при METRICS_TXT_ENABLED≠0 → data/metrics/autoplay-debug.txt; иначе stdout [autoplay:debug]
 * Вкл: AUTOPLAY_DEBUG=1
 * Док: docs/НАБЛЮДАЕМОСТЬ.md
 *
 * Централизованный helper для debug-логов и env-флагов автоплея.
 * Не содержит бизнес-логики подбора — только обвязка наблюдаемости.
 */

import {
  isPlaybackMetricsEnabled,
  logAutoplayDebugLine,
  logAutoplayGroqDebugLine,
} from './playback-metrics.js';

export function isAutoplayDebugEnabled() {
  return process.env.AUTOPLAY_DEBUG === '1';
}

/**
 * @param {string} guildId
 * @param {string} stage
 * @param {unknown} [meta]
 */
export function autoplayDebug(guildId, stage, meta = null) {
  if (!isAutoplayDebugEnabled()) return;
  if (isPlaybackMetricsEnabled()) {
    logAutoplayDebugLine(guildId, stage, meta);
    return;
  }
  if (meta == null) {
    console.log(`[autoplay:debug] guild=${guildId} stage=${stage}`);
    return;
  }
  try {
    console.log(`[autoplay:debug] guild=${guildId} stage=${stage} ${JSON.stringify(meta)}`);
  } catch {
    console.log(`[autoplay:debug] guild=${guildId} stage=${stage}`, meta);
  }
}

/**
 * @param {string} stage
 * @param {unknown} meta
 */
export function autoplayGroqDebug(stage, meta) {
  if (!isAutoplayDebugEnabled()) return;
  if (isPlaybackMetricsEnabled()) {
    logAutoplayGroqDebugLine(stage, meta);
    return;
  }
  try {
    console.log(`[autoplay:debug] groq_stage=${stage} ${JSON.stringify(meta)}`);
  } catch {
    console.log(`[autoplay:debug] groq_stage=${stage}`, meta);
  }
}

export function isAutoplayArtistCooldownEnabled() {
  const v = String(process.env.AUTOPLAY_ARTIST_COOLDOWN_ENABLED ?? '').toLowerCase().trim();
  return v === '1' || v === 'true';
}

export function getAutoplayArtistCooldownWindow() {
  const n = Number(process.env.AUTOPLAY_ARTIST_COOLDOWN_WINDOW);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 8;
}
