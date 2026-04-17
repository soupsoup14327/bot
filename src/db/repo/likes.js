import { and, desc, eq } from 'drizzle-orm';

import { getSchemaForBackend } from '../schema.js';

/**
 * Raw persistence for track likes.
 *
 * This layer owns SQL-shaped concerns only:
 * - table selection per backend
 * - idempotent insert/delete semantics
 * - stable ordering for read paths
 *
 * It intentionally does NOT implement fail-open behavior. ADR-001 §6 keeps that
 * policy in the service layer so callers can decide how to degrade.
 */

/**
 * @typedef {{
 *   userId: string,
 *   provider: string,
 *   providerTrackId: string,
 * }} LikeKey
 */

/**
 * @typedef {LikeKey & {
 *   sourceUrl: string,
 *   title: string,
 *   artist?: string | null,
 *   likedAt: string,
 *   createdAt?: string,
 * }} LikeRecordInput
 */

/**
 * @typedef {{
 *   userId: string,
 *   provider: string,
 *   providerTrackId: string,
 *   sourceUrl: string,
 *   title: string,
 *   artist: string | null,
 *   likedAt: string,
 * }} LikeRecord
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`likes repo: ${field} is empty`);
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
 * @param {{
 *   userId: string,
 *   provider: string,
 *   providerTrackId: string,
 *   sourceUrl: string,
 *   title: string,
 *   artist: string | null,
 *   likedAt: string,
 * }} row
 * @returns {LikeRecord}
 */
function mapLikeRow(row) {
  return {
    userId: String(row.userId),
    provider: String(row.provider),
    providerTrackId: String(row.providerTrackId),
    sourceUrl: String(row.sourceUrl),
    title: String(row.title),
    artist: row.artist == null ? null : String(row.artist),
    likedAt: String(row.likedAt),
  };
}

/**
 * @param {import('../connection.js').DatabaseConnection} connection
 */
export function createLikesRepository(connection) {
  if (!connection?.db || !connection?.backend) {
    throw new Error('likes repo: database connection is required');
  }

  const { db } = connection;
  const { users, trackLikes } = getSchemaForBackend(connection.backend);

  /**
   * @param {LikeKey} key
   * @returns {Promise<LikeRecord | null>}
   */
  async function getLike(key) {
    const userId = requireNonEmptyString(key?.userId, 'userId');
    const provider = requireNonEmptyString(key?.provider, 'provider');
    const providerTrackId = requireNonEmptyString(key?.providerTrackId, 'providerTrackId');

    const rows = await db
      .select()
      .from(trackLikes)
      .where(and(
        eq(trackLikes.userId, userId),
        eq(trackLikes.provider, provider),
        eq(trackLikes.providerTrackId, providerTrackId),
      ))
      .limit(1);

    return rows[0] ? mapLikeRow(rows[0]) : null;
  }

  return Object.freeze({
    getLike,

    /**
     * Idempotent write: second insert of the same logical like is a no-op.
     *
     * @param {LikeRecordInput} input
     * @returns {Promise<{ created: boolean, record: LikeRecord }>}
     */
    async addLike(input) {
      const userId = requireNonEmptyString(input?.userId, 'userId');
      const provider = requireNonEmptyString(input?.provider, 'provider');
      const providerTrackId = requireNonEmptyString(input?.providerTrackId, 'providerTrackId');
      const sourceUrl = requireNonEmptyString(input?.sourceUrl, 'sourceUrl');
      const title = requireNonEmptyString(input?.title, 'title');
      const artist = normalizeOptionalString(input?.artist);
      const likedAt = requireNonEmptyString(input?.likedAt, 'likedAt');
      const createdAt = requireNonEmptyString(input?.createdAt ?? likedAt, 'createdAt');

      const existing = await getLike({ userId, provider, providerTrackId });
      if (existing) {
        return { created: false, record: existing };
      }

      await db.insert(users).values({ userId, createdAt }).onConflictDoNothing();
      await db.insert(trackLikes).values({
        userId,
        provider,
        providerTrackId,
        sourceUrl,
        title,
        artist,
        likedAt,
      }).onConflictDoNothing();

      const stored = await getLike({ userId, provider, providerTrackId });
      if (!stored) {
        throw new Error('likes repo: insert completed without a persisted row');
      }

      return { created: true, record: stored };
    },

    /**
     * Idempotent delete: removing a missing like reports `removed:false`.
     *
     * @param {LikeKey} key
     * @returns {Promise<{ removed: boolean }>}
     */
    async removeLike(key) {
      const userId = requireNonEmptyString(key?.userId, 'userId');
      const provider = requireNonEmptyString(key?.provider, 'provider');
      const providerTrackId = requireNonEmptyString(key?.providerTrackId, 'providerTrackId');

      const existing = await getLike({ userId, provider, providerTrackId });
      if (!existing) {
        return { removed: false };
      }

      await db.delete(trackLikes).where(and(
        eq(trackLikes.userId, userId),
        eq(trackLikes.provider, provider),
        eq(trackLikes.providerTrackId, providerTrackId),
      ));

      return { removed: true };
    },

    /**
     * @param {string} userId
     * @param {{ limit?: number }} [options]
     * @returns {Promise<LikeRecord[]>}
     */
    async listLikesByUser(userId, options = {}) {
      const normalizedUserId = requireNonEmptyString(userId, 'userId');
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));

      const rows = await db
        .select()
        .from(trackLikes)
        .where(eq(trackLikes.userId, normalizedUserId))
        .orderBy(desc(trackLikes.likedAt))
        .limit(limit);

      return rows.map(mapLikeRow);
    },
  });
}
