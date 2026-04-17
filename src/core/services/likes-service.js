import { detectProvider, makeProviderTrackId, providerTrackIdFromUrl } from '../../track-provider.js';

/**
 * Likes service applies ADR-001 fail-policy to the raw repository:
 * - write path is soft-fail
 * - read path degrades to []
 * - caller never sees transport/storage exceptions
 *
 * The public contract matches the existing `personal-signals.js` seam so the
 * future wiring step can swap internals without changing button handlers.
 */

/**
 * @param {unknown[]} args
 */
function defaultWarn(...args) {
  console.warn(...args);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`likes service: ${field} is empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

/**
 * Build the DB key from the resolved current track URL.
 *
 * Note: likes are emitted for the currently playing track, so the input is
 * expected to be a resolved watch/stream URL rather than a raw `/play` query.
 * If canonical provider extraction fails, we still fall back to a direct key so
 * the user action stays persistable.
 *
 * @param {{
 *   userId: string,
 *   guildId?: string | null,
 *   url: string,
 *   title?: string | null,
 *   artist?: string | null,
 *   sessionId?: string | null,
 * }} payload
 * @param {() => Date} now
 */
function normalizeLikePayload(payload, now) {
  const userId = requireNonEmptyString(payload?.userId, 'userId');
  const sourceUrl = requireNonEmptyString(payload?.url, 'url');
  const detectedProvider = detectProvider(sourceUrl);
  const provider = detectedProvider === 'query' ? 'direct' : detectedProvider;
  const providerTrackId = providerTrackIdFromUrl(sourceUrl) ?? makeProviderTrackId('direct', sourceUrl);
  const title = String(payload?.title ?? '').trim() || sourceUrl;
  const artist = normalizeOptionalString(payload?.artist);
  const timestamp = now().toISOString();

  return {
    userId,
    guildId: payload?.guildId == null ? null : String(payload.guildId),
    sessionId: payload?.sessionId == null ? null : String(payload.sessionId),
    provider,
    providerTrackId,
    sourceUrl,
    title,
    artist,
    likedAt: timestamp,
    createdAt: timestamp,
  };
}

/**
 * @param {{
 *   repo: {
 *     getLike: (key: { userId: string, provider: string, providerTrackId: string }) => Promise<unknown>,
 *     addLike: (input: {
 *       userId: string,
 *       provider: string,
 *       providerTrackId: string,
 *       sourceUrl: string,
 *       title: string,
 *       artist?: string | null,
 *       likedAt: string,
 *       createdAt?: string,
 *     }) => Promise<unknown>,
 *     removeLike: (key: { userId: string, provider: string, providerTrackId: string }) => Promise<{ removed: boolean }>,
 *     listLikesByUser: (userId: string, options?: { limit?: number }) => Promise<unknown[]>,
 *   },
 *   warn?: (...args: unknown[]) => void,
 *   now?: () => Date,
 * }} options
 */
export function createLikesService({ repo, warn = defaultWarn, now = () => new Date() }) {
  if (!repo) {
    throw new Error('likes service: repo is required');
  }

  return Object.freeze({
    /**
     * Toggle like state for the current track.
     *
     * Fail-policy: soft fail. DB/storage errors are logged and converted into a
     * stable `{ ok:false }` result so music/UI code can degrade without
     * throwing.
     *
     * @param {{
     *   userId: string,
     *   guildId?: string | null,
     *   url: string,
     *   title?: string | null,
     *   artist?: string | null,
     *   sessionId?: string | null,
     * }} payload
     * @returns {Promise<{ ok: true, removed: boolean } | { ok: false, reason: 'db_error' }>}
     */
    async emitLike(payload) {
      try {
        const normalized = normalizeLikePayload(payload, now);
        const existing = await repo.getLike({
          userId: normalized.userId,
          provider: normalized.provider,
          providerTrackId: normalized.providerTrackId,
        });

        if (existing) {
          await repo.removeLike({
            userId: normalized.userId,
            provider: normalized.provider,
            providerTrackId: normalized.providerTrackId,
          });
          return { ok: true, removed: true };
        }

        await repo.addLike(normalized);
        return { ok: true, removed: false };
      } catch (error) {
        warn('[likes] emitLike soft-fail', error instanceof Error ? error.message : error);
        return { ok: false, reason: 'db_error' };
      }
    },

    /**
     * Fail-policy: soft fail. UI/read paths degrade to empty likes.
     *
     * @param {string} userId
     * @param {{ limit?: number }} [options]
     * @returns {Promise<unknown[]>}
     */
    async listLikes(userId, options = {}) {
      try {
        return await repo.listLikesByUser(requireNonEmptyString(userId, 'userId'), options);
      } catch (error) {
        warn('[likes] listLikes soft-fail', error instanceof Error ? error.message : error);
        return [];
      }
    },
  });
}
