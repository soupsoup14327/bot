import { and, desc, eq, notExists, notInArray } from 'drizzle-orm';

import { getSchemaForBackend } from '../schema.js';

/**
 * Raw persistence for playback history.
 *
 * This layer owns SQL-shaped concerns only:
 * - table selection per backend
 * - canonical track upsert into `tracks`
 * - immutable play inserts into `track_plays`
 * - stable read ordering and optional filtering
 *
 * Fail-open policy stays in the service layer, matching ADR-001.
 */

const DEFAULT_MAX_PLAYS_PER_USER = 500;
const MAX_RETENTION_CAP = 100_000;

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`history repo: ${field} is empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized)) {
    throw new Error(`history repo: ${field} must be an integer`);
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
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeOptionalInteger(value) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isInteger(normalized)) {
    throw new Error('history repo: elapsedMs must be an integer');
  }
  return normalized;
}

/**
 * Keep only the most recent N `track_plays` rows per user.
 * `0` disables pruning.
 *
 * @param {unknown} value
 * @returns {number}
 */
function resolveMaxPlaysPerUser(value) {
  if (value == null || value === '') {
    return DEFAULT_MAX_PLAYS_PER_USER;
  }

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error('history repo: TRACK_PLAYS_RETENTION_PER_USER must be a non-negative integer');
  }

  return Math.min(normalized, MAX_RETENTION_CAP);
}

/**
 * @param {{
 *   playId: unknown,
 *   userId: unknown,
 *   trackKey: unknown,
 *   provider: unknown,
 *   sourceUrl: unknown,
 *   title: unknown,
 *   artist: unknown,
 *   guildId: unknown,
 *   sessionId: unknown,
 *   requestedBy: unknown,
 *   triggeredBy: unknown,
 *   listenersCount: unknown,
 *   elapsedMs: unknown,
 *   eventType: unknown,
 *   playedAt: unknown,
 * }} row
 */
function mapHistoryRow(row) {
  return {
    playId: String(row.playId),
    userId: String(row.userId),
    trackKey: String(row.trackKey),
    provider: String(row.provider),
    sourceUrl: String(row.sourceUrl),
    title: String(row.title),
    artist: row.artist == null ? null : String(row.artist),
    guildId: row.guildId == null ? null : String(row.guildId),
    sessionId: row.sessionId == null ? null : String(row.sessionId),
    requestedBy: row.requestedBy == null ? null : String(row.requestedBy),
    triggeredBy: String(row.triggeredBy),
    listenersCount: Number(row.listenersCount),
    elapsedMs: row.elapsedMs == null ? null : Number(row.elapsedMs),
    eventType: String(row.eventType),
    playedAt: String(row.playedAt),
  };
}

/**
 * @param {import('../connection.js').DatabaseConnection} connection
 * @param {{ maxPlaysPerUser?: number }} [options]
 */
export function createHistoryRepository(connection, options = {}) {
  if (!connection?.db || !connection?.backend) {
    throw new Error('history repo: database connection is required');
  }

  const { db } = connection;
  const { users, tracks, trackPlays } = getSchemaForBackend(connection.backend);
  const maxPlaysPerUser = resolveMaxPlaysPerUser(
    options.maxPlaysPerUser ?? process.env.TRACK_PLAYS_RETENTION_PER_USER,
  );

  /**
   * Best-effort local retention:
   * - keep only newest N play rows per user
   * - delete canonical tracks that no longer have any play rows
   *
   * This stays in the repo because it is persistence-shaped lifecycle policy,
   * not playback/UI domain logic.
   *
   * @param {string} userId
   */
  async function pruneUserHistory(userId) {
    if (maxPlaysPerUser <= 0) {
      return;
    }

    const retained = await db
      .select({ playId: trackPlays.playId })
      .from(trackPlays)
      .where(eq(trackPlays.userId, userId))
      .orderBy(desc(trackPlays.playedAt), desc(trackPlays.playId))
      .limit(maxPlaysPerUser);

    const retainedIds = retained.map((row) => String(row.playId));
    if (retainedIds.length === 0) {
      return;
    }

    await db.delete(trackPlays).where(and(
      eq(trackPlays.userId, userId),
      notInArray(trackPlays.playId, retainedIds),
    ));

    await db.delete(tracks).where(notExists(
      db
        .select({ playId: trackPlays.playId })
        .from(trackPlays)
        .where(eq(trackPlays.trackKey, tracks.trackKey)),
    ));
  }

  async function getPlayById(playId) {
    const normalizedPlayId = requireNonEmptyString(playId, 'playId');

    const rows = await db
      .select({
        playId: trackPlays.playId,
        userId: trackPlays.userId,
        trackKey: trackPlays.trackKey,
        provider: tracks.provider,
        sourceUrl: tracks.sourceUrl,
        title: tracks.title,
        artist: tracks.artist,
        guildId: trackPlays.guildId,
        sessionId: trackPlays.sessionId,
        requestedBy: trackPlays.requestedBy,
        triggeredBy: trackPlays.triggeredBy,
        listenersCount: trackPlays.listenersCount,
        elapsedMs: trackPlays.elapsedMs,
        eventType: trackPlays.eventType,
        playedAt: trackPlays.playedAt,
      })
      .from(trackPlays)
      .innerJoin(tracks, eq(trackPlays.trackKey, tracks.trackKey))
      .where(eq(trackPlays.playId, normalizedPlayId))
      .limit(1);

    return rows[0] ? mapHistoryRow(rows[0]) : null;
  }

  return Object.freeze({
    getPlayById,

    /**
     * Record one immutable play event while keeping `tracks` canonical.
     *
     * @param {{
     *   playId: string,
     *   userId: string,
     *   trackKey: string,
     *   provider: string,
     *   sourceUrl: string,
     *   title: string,
     *   artist?: string | null,
     *   guildId?: string | null,
     *   sessionId?: string | null,
     *   requestedBy?: string | null,
     *   triggeredBy: string,
     *   listenersCount: number,
     *   elapsedMs?: number | null,
     *   eventType: string,
     *   playedAt: string,
     *   createdAt?: string,
     * }} input
     */
    async addPlay(input) {
      const playId = requireNonEmptyString(input?.playId, 'playId');
      const userId = requireNonEmptyString(input?.userId, 'userId');
      const trackKey = requireNonEmptyString(input?.trackKey, 'trackKey');
      const provider = requireNonEmptyString(input?.provider, 'provider');
      const sourceUrl = requireNonEmptyString(input?.sourceUrl, 'sourceUrl');
      const title = requireNonEmptyString(input?.title, 'title');
      const artist = normalizeOptionalString(input?.artist);
      const guildId = normalizeOptionalString(input?.guildId);
      const sessionId = normalizeOptionalString(input?.sessionId);
      const requestedBy = normalizeOptionalString(input?.requestedBy);
      const triggeredBy = requireNonEmptyString(input?.triggeredBy, 'triggeredBy');
      const listenersCount = requireInteger(input?.listenersCount, 'listenersCount');
      const elapsedMs = normalizeOptionalInteger(input?.elapsedMs);
      const eventType = requireNonEmptyString(input?.eventType, 'eventType');
      const playedAt = requireNonEmptyString(input?.playedAt, 'playedAt');
      const createdAt = requireNonEmptyString(input?.createdAt ?? playedAt, 'createdAt');

      await db.insert(users).values({ userId, createdAt }).onConflictDoNothing();
      await db
        .insert(tracks)
        .values({
          trackKey,
          provider,
          sourceUrl,
          title,
          artist,
          createdAt,
        })
        .onConflictDoUpdate({
          target: tracks.trackKey,
          set: {
            provider,
            sourceUrl,
            title,
            artist,
          },
        });
      await db.insert(trackPlays).values({
        playId,
        userId,
        trackKey,
        guildId,
        sessionId,
        requestedBy,
        triggeredBy,
        listenersCount,
        elapsedMs,
        eventType,
        playedAt,
      });
      await pruneUserHistory(userId);

      const stored = await getPlayById(playId);
      if (!stored) {
        throw new Error('history repo: insert completed without a persisted row');
      }

      return stored;
    },

    /**
     * @param {string} userId
     * @param {{ limit?: number, eventType?: string | null }} [options]
     */
    async listRecentPlaysByUser(userId, options = {}) {
      const normalizedUserId = requireNonEmptyString(userId, 'userId');
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
      const eventType = normalizeOptionalString(options.eventType);

      const filter = eventType
        ? and(eq(trackPlays.userId, normalizedUserId), eq(trackPlays.eventType, eventType))
        : eq(trackPlays.userId, normalizedUserId);

      const rows = await db
        .select({
          playId: trackPlays.playId,
          userId: trackPlays.userId,
          trackKey: trackPlays.trackKey,
          provider: tracks.provider,
          sourceUrl: tracks.sourceUrl,
          title: tracks.title,
          artist: tracks.artist,
          guildId: trackPlays.guildId,
          sessionId: trackPlays.sessionId,
          requestedBy: trackPlays.requestedBy,
          triggeredBy: trackPlays.triggeredBy,
          listenersCount: trackPlays.listenersCount,
          elapsedMs: trackPlays.elapsedMs,
          eventType: trackPlays.eventType,
          playedAt: trackPlays.playedAt,
        })
        .from(trackPlays)
        .innerJoin(tracks, eq(trackPlays.trackKey, tracks.trackKey))
        .where(filter)
        .orderBy(desc(trackPlays.playedAt))
        .limit(limit);

      return rows.map(mapHistoryRow);
    },
  });
}
