/**
 * recommender.js — seam between the bot and a future recommender service.
 *
 * TL;DR: this is a STUB with a stable API surface. It intentionally returns
 * `[]` today. When the companion app with a real recommender endpoint
 * lands, only the body of `getNextTracks` changes — every caller already
 * uses the right signature.
 *
 * Why a separate module NOW (not later when we actually have an API):
 *
 *   1. Architectural seam. Without this, the "what plays next" decision
 *      lives in ad-hoc youtube-related search deep inside autoplay-spawn.js
 *      and playback-loop.js. Adding a real recommender later would require
 *      threading it through 3+ files and changing signatures mid-refactor.
 *      Better to have one stable seam from day one.
 *
 *   2. Planned UX ("Up Next" Apple-Music style). Product plan is a 5-track
 *      preview that updates live. That UX needs `getNextTracks(seed, {count})`
 *      — a bulk API, not the current "give me one next track" shape. The
 *      stub already returns `Track[]`, so migrating to bulk is a straight
 *      swap.
 *
 *   3. Encapsulation of fallback. When the real recommender errors, we want
 *      a sensible fallback (e.g. current youtube-related pick). That
 *      decision belongs in this module, not at every call site.
 *
 * What NOT to put here:
 *   - Playback decisions (what to do with the returned track). That's
 *     playback-loop's job.
 *   - User-facing UI state. That's music-panel's job.
 *   - Persistence of likes/history. That's the companion app's DB.
 *
 * The stub's behavior of returning `[]` means callers treat "no
 * recommendation available" the same as "recommender not yet wired",
 * which is correct — both cases mean "fall back to whatever logic you
 * had before this module existed".
 */

/**
 * @typedef {{
 *   url: string,
 *   title: string,
 *   durationSec?: number,
 *   provider?: 'youtube' | string,
 * }} Track
 */

/**
 * @typedef {{
 *   guildId: string,
 *   userId?: string | null,
 *   count?: number,
 *   sessionId?: string | null,
 *   excludeUrls?: string[],
 * }} NextTracksOptions
 */

/**
 * @typedef {{
 *   tracks: Track[],
 *   source: 'stub' | 'app-api' | 'fallback',
 *   requestId?: string,
 * }} NextTracksResult
 */

/**
 * Get the next N tracks to play based on a seed track/label.
 *
 * CURRENT BEHAVIOR (stub): always resolves to `{ tracks: [], source: 'stub' }`.
 * Callers must treat empty tracks as "no recommendation — use fallback".
 *
 * FUTURE BEHAVIOR: POST to `${APP_API_BASE}/recommend/next` with
 *   { seed, userId, guildId, count, excludeUrls }
 * and return its Track[] result, or delegate to local fallback on error.
 *
 * @param {string} seed — seed track label/url that the recommender uses as
 *   starting point. Typically the last played track.
 * @param {NextTracksOptions} options
 * @returns {Promise<NextTracksResult>}
 */
export async function getNextTracks(seed, options) {
  const _seed = String(seed ?? '').trim();
  const _count = Math.max(1, Math.min(20, options?.count ?? 5));
  // Intentional no-op. Real implementation will:
  //   1. Call companion app API with { seed: _seed, count: _count, ... }
  //   2. On non-2xx or timeout → fall through to youtube-related fallback.
  //   3. Dedupe against options.excludeUrls.
  void _seed;
  void _count;
  return { tracks: [], source: 'stub' };
}

/**
 * Is the recommender currently reachable? Used by UI to decide whether to
 * show the "Up Next" preview panel at all.
 *
 * Stub always returns false — panel should not render the preview until
 * a real implementation is wired up.
 *
 * @returns {boolean}
 */
export function isRecommenderAvailable() {
  return false;
}
