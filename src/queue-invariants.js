/**
 * Инварианты очереди воспроизведения.
 *
 * Очередь хранит QueueItem ({ url, source }), не сырые строки.
 * Дедуп по providerTrackId (multi-source canonical identity).
 * Для YouTube это `youtube:VIDEO_ID`; для SoundCloud `soundcloud:artist/slug`;
 * для прочих прямых URL `direct:URL`; для search-query дедуп по trim-строке.
 */

import { providerTrackIdFromUrl } from './track-provider.js';

/**
 * @typedef {'single' | 'autoplay' | 'navigation'} TrackSource
 */

/**
 * @typedef {{
 *   url: string,
 *   source: TrackSource,
 *   providerTrackId?: string | null,
 *   spawnId?: string | null,
 *   requestedBy?: string | null,
 *   requestedByName?: string | null,
 *   title?: string | null,
 *   channelName?: string | null,
 * }} QueueItem
 */

/**
 * @param {string} url
 * @returns {string | null} 11-символьный id или null
 */
export function extractYoutubeVideoId(url) {
  if (url == null || typeof url !== 'string') return null;
  const s = url.trim();
  if (!s.startsWith('http')) return null;
  try {
    const u = new URL(s);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Canonical dedup key for a URL.
 * Uses providerTrackId when available; falls back to trim-normalized URL.
 * @param {string} url
 * @returns {string}
 */
function dedupKey(url) {
  return providerTrackIdFromUrl(url) ?? String(url ?? '').trim();
}

/**
 * Один и тот же трек (по providerTrackId или строке).
 * Заменяет sameYoutubeContent — работает для YouTube, SoundCloud, direct URL, query.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameTrackContent(a, b) {
  return dedupKey(a) === dedupKey(b);
}

/**
 * Обратная совместимость — делегирует к sameTrackContent.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameYoutubeContent(a, b) {
  return sameTrackContent(a, b);
}

/**
 * unshift только если голова очереди — не тот же трек.
 * @param {QueueItem[]} queue
 * @param {QueueItem} item
 * @returns {boolean} true если вставили
 */
export function unshiftQueueIfNewHead(queue, item) {
  const h0 = queue[0];
  if (h0 != null && sameTrackContent(h0.url, item.url)) return false;
  queue.unshift(item);
  return true;
}

/**
 * Добавить в хвост, если такого трека ещё нет в очереди (для автоплея).
 * @param {QueueItem[]} queue
 * @param {QueueItem} item
 * @returns {boolean} true если добавили
 */
export function pushQueueIfNotQueued(queue, item) {
  if (queue.some((u) => sameTrackContent(u.url, item.url))) return false;
  queue.push(item);
  return true;
}
