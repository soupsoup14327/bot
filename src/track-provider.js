/**
 * track-provider.js — Provider detection and canonical track identity.
 *
 * Multi-source support is about technical identity, not musical identity.
 * We do NOT try to deduplicate "YouTube original = SoundCloud re-upload" here —
 * that requires audio fingerprinting which is a separate layer (future).
 *
 * Supported providers right now:
 *   youtube   — youtube.com, youtu.be, music.youtube.com, m.youtube.com
 *   soundcloud — soundcloud.com (streams via yt-dlp, no pipeline changes)
 *   direct    — any other http/https URL
 *   query     — non-URL string (search query → resolveYoutubeFromQuery)
 *
 * providerTrackId format: `provider:rawId`
 *   youtube:dQw4w9WgXcQ
 *   soundcloud:artist/title-123456
 *   direct:https://cdn.example.com/track.mp3
 *   (query strings don't get a providerTrackId)
 */

import { extractYoutubeVideoId } from './queue-invariants.js';

/**
 * Detect which provider a URL or query string belongs to.
 *
 * @param {string} input
 * @returns {'youtube' | 'soundcloud' | 'direct' | 'query'}
 */
export function detectProvider(input) {
  const s = String(input ?? '').trim();
  if (!s.startsWith('http')) return 'query';
  try {
    const { hostname } = new URL(s);
    const h = hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be' ||
        h === 'm.youtube.com' || h === 'music.youtube.com') {
      return 'youtube';
    }
    if (h === 'soundcloud.com') return 'soundcloud';
  } catch { /* unparseable URL → direct */ }
  return 'direct';
}

/**
 * Returns true for any URL that can be streamed directly without searching.
 * Equivalent to `detectProvider(url) !== 'query'`.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isDirectUrl(url) {
  return detectProvider(url) !== 'query';
}

/**
 * Canonical technical identity for deduplication, playability cache keys, and DB lookups.
 * Format: `provider:rawId`
 *
 * Not a musical identity — does not equate cross-provider reposts of the same song.
 *
 * @param {'youtube' | 'soundcloud' | 'direct'} provider
 * @param {string} rawId  — video id for youtube, path for soundcloud, URL for direct
 * @returns {string}
 */
export function makeProviderTrackId(provider, rawId) {
  return `${provider}:${rawId}`;
}

/**
 * Derive a providerTrackId from a URL.
 * Returns null for query strings (no stable identity before search).
 *
 * @param {string} url
 * @returns {string | null}
 */
export function providerTrackIdFromUrl(url) {
  const s = String(url ?? '').trim();
  const provider = detectProvider(s);
  if (provider === 'query') return null;

  if (provider === 'youtube') {
    const vid = extractYoutubeVideoId(s);
    if (vid) return makeProviderTrackId('youtube', vid);
    // Unusual YouTube URL (channel, playlist, etc.) — fall through to direct
    return makeProviderTrackId('direct', s);
  }

  if (provider === 'soundcloud') {
    try {
      const { pathname } = new URL(s);
      // pathname = /artist/track-slug
      const path = pathname.replace(/^\//, '').split('?')[0];
      if (path) return makeProviderTrackId('soundcloud', path);
    } catch { /* ignore */ }
    return makeProviderTrackId('soundcloud', s);
  }

  return makeProviderTrackId('direct', s);
}
