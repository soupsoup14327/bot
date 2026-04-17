import { randomUUID } from 'node:crypto';

import { detectProvider, makeProviderTrackId, providerTrackIdFromUrl } from '../../track-provider.js';

/**
 * Playback history service mirrors likes-service structure:
 * - normalize runtime payload into DB shape
 * - keep fail-open behavior in the service layer
 * - leave raw SQL semantics inside the repository
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
    throw new Error(`history service: ${field} is empty`);
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
    throw new Error('history service: integer field is invalid');
  }
  return normalized;
}

/**
 * @param {{
 *   userId: string,
 *   url: string,
 *   title?: string | null,
 *   artist?: string | null,
 *   guildId?: string | null,
 *   sessionId?: string | null,
 *   requestedBy?: string | null,
 *   triggeredBy: string,
 *   listenersCount?: number | null,
 *   elapsedMs?: number | null,
 *   eventType?: string | null,
 * }} payload
 * @param {() => Date} now
 * @param {() => string} makeId
 */
function normalizeHistoryPayload(payload, now, makeId) {
  const userId = requireNonEmptyString(payload?.userId, 'userId');
  const sourceUrl = requireNonEmptyString(payload?.url, 'url');
  const detectedProvider = detectProvider(sourceUrl);
  const provider = detectedProvider === 'query' ? 'direct' : detectedProvider;
  const trackKey = providerTrackIdFromUrl(sourceUrl) ?? makeProviderTrackId('direct', sourceUrl);
  const title = String(payload?.title ?? '').trim() || sourceUrl;
  const artist = normalizeOptionalString(payload?.artist);
  const timestamp = now().toISOString();

  return {
    playId: makeId(),
    userId,
    trackKey,
    provider,
    sourceUrl,
    title,
    artist,
    guildId: normalizeOptionalString(payload?.guildId),
    sessionId: normalizeOptionalString(payload?.sessionId),
    requestedBy: normalizeOptionalString(payload?.requestedBy),
    triggeredBy: requireNonEmptyString(payload?.triggeredBy, 'triggeredBy'),
    listenersCount: Number(payload?.listenersCount ?? 0),
    elapsedMs: normalizeOptionalInteger(payload?.elapsedMs),
    eventType: normalizeOptionalString(payload?.eventType) ?? 'finished',
    playedAt: timestamp,
    createdAt: timestamp,
  };
}

/**
 * @param {{
 *   repo: {
 *     addPlay: (input: {
 *       playId: string,
 *       userId: string,
 *       trackKey: string,
 *       provider: string,
 *       sourceUrl: string,
 *       title: string,
 *       artist?: string | null,
 *       guildId?: string | null,
 *       sessionId?: string | null,
 *       requestedBy?: string | null,
 *       triggeredBy: string,
 *       listenersCount: number,
 *       elapsedMs?: number | null,
 *       eventType: string,
 *       playedAt: string,
 *       createdAt?: string,
 *     }) => Promise<unknown>,
 *     listRecentPlaysByUser: (userId: string, options?: { limit?: number, eventType?: string | null }) => Promise<unknown[]>,
 *   },
 *   warn?: (...args: unknown[]) => void,
 *   now?: () => Date,
 *   makeId?: () => string,
 * }} options
 */
export function createHistoryService({
  repo,
  warn = defaultWarn,
  now = () => new Date(),
  makeId = () => randomUUID(),
}) {
  if (!repo) {
    throw new Error('history service: repo is required');
  }

  return Object.freeze({
    /**
     * Write path is soft-fail: playback and UI callers should not crash if DB
     * recording fails.
     *
     * @param {{
     *   userId: string,
     *   url: string,
     *   title?: string | null,
     *   artist?: string | null,
     *   guildId?: string | null,
     *   sessionId?: string | null,
     *   requestedBy?: string | null,
     *   triggeredBy: string,
     *   listenersCount?: number | null,
     *   elapsedMs?: number | null,
     *   eventType?: string | null,
     * }} payload
     * @returns {Promise<{ ok: true, playId: string } | { ok: false, reason: 'db_error' }>}
     */
    async recordPlay(payload) {
      try {
        const normalized = normalizeHistoryPayload(payload, now, makeId);
        await repo.addPlay(normalized);
        return { ok: true, playId: normalized.playId };
      } catch (error) {
        warn('[history] recordPlay soft-fail', error instanceof Error ? error.message : error);
        return { ok: false, reason: 'db_error' };
      }
    },

    /**
     * Read path is soft-fail: callers degrade to an empty list.
     *
     * @param {string} userId
     * @param {{ limit?: number, eventType?: string | null }} [options]
     */
    async listRecentHistory(userId, options = {}) {
      try {
        return await repo.listRecentPlaysByUser(requireNonEmptyString(userId, 'userId'), options);
      } catch (error) {
        warn('[history] listRecentHistory soft-fail', error instanceof Error ? error.message : error);
        return [];
      }
    },
  });
}
