/**
 * METRICS:PLAYABILITY — при shadow: stdout [playability:cache] JSON (shadow_put, soft_ok).
 * Кэш «неиграбельных» источников (этапы 1–2 autoplay).
 * Запись фейлов: `AUTOPLAY_PLAYABILITY_CACHE_SHADOW=1` и/или `AUTOPLAY_PLAYABILITY_HARD_SKIP_ENABLED=1`.
 * Hard gate: `AUTOPLAY_PLAYABILITY_HARD_SKIP_ENABLED=1` — пропуск bad URL при подборе и перед стримом.
 * Куда shadow-лог: при METRICS_TXT≠0 → data/metrics/playability.txt; иначе stdout
 * Док: docs/НАБЛЮДАЕМОСТЬ.md §5, AUTOPLAY-IMPLEMENTATION-PLAN.md
 */

import { isPlaybackMetricsEnabled, logPlayabilityJson } from './playback-metrics.js';
import { extractYoutubeVideoId } from './queue-invariants.js';
import { providerTrackIdFromUrl } from './track-provider.js';
import { tryNormalizeYoutubeUrl } from './youtube-search.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 8000;

/** @typedef {{ status: 'bad', reason: string, kind: string, expiresAt: number, lastSeen: number }} PlayabilityEntry */

/** @type {Map<string, PlayabilityEntry>} */
const store = new Map();

export function isPlayabilityCacheShadowEnabled() {
  return String(process.env.AUTOPLAY_PLAYABILITY_CACHE_SHADOW ?? '').trim() === '1';
}

/** Включён жёсткий пропуск известных bad URL (автоплей, runPlayNext, прямой URL в enqueue). */
export function isPlayabilityHardSkipEnabled() {
  return String(process.env.AUTOPLAY_PLAYABILITY_HARD_SKIP_ENABLED ?? '').trim() === '1';
}

/** Писать bad в кэш при фейлах (shadow и/или hard gate — иначе gate нечем питать). */
export function isPlayabilityRecordingEnabled() {
  return isPlayabilityCacheShadowEnabled() || isPlayabilityHardSkipEnabled();
}

function ttlMs() {
  const raw = Number(process.env.AUTOPLAY_PLAYABILITY_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
  return DEFAULT_TTL_MS;
}

/**
 * Canonical cache key for playability records.
 * Uses providerTrackId (multi-source) when resolvable, falls back to normalized URL.
 * Examples: `youtube:dQw4w9WgXcQ`, `soundcloud:artist/slug`, `direct:https://…`
 *
 * @param {string} watchUrl
 * @returns {string}
 */
export function playabilityCanonicalKey(watchUrl) {
  const s = String(watchUrl ?? '');
  // Try YouTube normalization first so music.youtube.com / youtu.be map to the same key.
  const norm = tryNormalizeYoutubeUrl(s) ?? s;
  const id = providerTrackIdFromUrl(norm);
  if (id) return id;
  return `url:${norm}`;
}

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt < now) store.delete(k);
  }
}

function evictIfNeeded() {
  purgeExpired();
  if (store.size <= MAX_ENTRIES) return;
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of store) {
    if (v.lastSeen < oldest) {
      oldest = v.lastSeen;
      oldestKey = k;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

/**
 * Зафиксировать неудачу стрима/воспроизведения (пишет в кэш при shadow или hard gate).
 * @param {{ watchUrl: string, kind: string, detail?: string, guildId?: string }} p
 */
export function recordPlayabilityFailure(p) {
  if (!isPlayabilityRecordingEnabled()) return;
  const watchUrl = String(p.watchUrl ?? '');
  if (!watchUrl) return;
  const kind = String(p.kind ?? 'unknown').slice(0, 80);
  const detail = String(p.detail ?? '').slice(0, 500);
  const key = playabilityCanonicalKey(watchUrl);
  const now = Date.now();
  const ttl = ttlMs();
  const expiresAt = now + ttl;
  const reason = detail ? `${kind}: ${detail}` : kind;
  store.set(key, {
    status: 'bad',
    reason: reason.slice(0, 600),
    kind,
    expiresAt,
    lastSeen: now,
  });
  evictIfNeeded();
  if (isPlayabilityCacheShadowEnabled()) {
    const row = {
      op: 'shadow_put',
      guildId: p.guildId != null ? String(p.guildId) : null,
      key,
      videoId: extractYoutubeVideoId(watchUrl) ?? null,
      status: 'bad',
      kind,
      ttlMs: ttl,
      expiresAt,
    };
    if (isPlaybackMetricsEnabled()) {
      logPlayabilityJson(row);
    } else {
      console.log(`[playability:cache] ${JSON.stringify(row)}`);
    }
  }
}

/**
 * Успешный старт воспроизведения: снять bad с этого источника (soft positive).
 * @param {string} watchUrl
 */
export function clearPlayabilityBadOnSuccessfulPlay(watchUrl) {
  const key = playabilityCanonicalKey(String(watchUrl ?? ''));
  if (!store.has(key)) return;
  store.delete(key);
  if (isPlayabilityCacheShadowEnabled()) {
    const row = {
      op: 'soft_ok',
      key,
      videoId: extractYoutubeVideoId(String(watchUrl)) ?? null,
    };
    if (isPlaybackMetricsEnabled()) {
      logPlayabilityJson(row);
    } else {
      console.log(`[playability:cache] ${JSON.stringify(row)}`);
    }
  }
}

/**
 * Для этапа 2 / проверок: активная запись bad и не истекла.
 * @param {string} watchUrl
 */
export function isUrlMarkedBad(watchUrl) {
  const key = playabilityCanonicalKey(watchUrl);
  const e = store.get(key);
  if (!e || e.status !== 'bad') return false;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return false;
  }
  return true;
}

