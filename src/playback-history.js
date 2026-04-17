import { createHistoryService } from './core/services/history-service.js';
import { openDatabaseConnection } from './db/connection.js';
import { createHistoryRepository } from './db/repo/history.js';

/**
 * playback-history.js — runtime facade for best-effort playback history writes.
 *
 * Responsibilities:
 * - expose one narrow seam for playback/runtime code (`recordPlaybackHistory`)
 * - lazily bootstrap one process-local DB-backed history service
 * - degrade to fire-and-forget no-op style results if bootstrap/storage fails
 *
 * Non-goals:
 * - no schema ownership here
 * - no SQL here
 * - no UI/panel semantics here
 */

function defaultWarn(...args) {
  console.warn(...args);
}

const DEFAULT_DEPS = Object.freeze({
  openDatabaseConnection,
  createHistoryRepository,
  createHistoryService,
  warn: defaultWarn,
});

let runtimeDeps = DEFAULT_DEPS;
let runtimeConnection = null;
let runtimeConnectionPromise = null;
let runtimeHistoryServicePromise = null;

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
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return Math.max(0, Math.trunc(normalized));
}

async function getRuntimeConnection() {
  if (runtimeConnection) {
    return runtimeConnection;
  }

  if (!runtimeConnectionPromise) {
    runtimeConnectionPromise = runtimeDeps.openDatabaseConnection()
      .then((connection) => {
        runtimeConnection = connection;
        return connection;
      })
      .catch((error) => {
        runtimeConnectionPromise = null;
        throw error;
      });
  }

  return runtimeConnectionPromise;
}

async function getHistoryService() {
  if (!runtimeHistoryServicePromise) {
    runtimeHistoryServicePromise = (async () => {
      const connection = await getRuntimeConnection();
      const repo = runtimeDeps.createHistoryRepository(connection);
      return runtimeDeps.createHistoryService({
        repo,
        warn: runtimeDeps.warn,
      });
    })().catch((error) => {
      runtimeHistoryServicePromise = null;
      throw error;
    });
  }

  return runtimeHistoryServicePromise;
}

/**
 * Best-effort history write for playback/runtime events.
 *
 * User attribution rule:
 * - prefer `requestedBy` when the track has an explicit owner
 * - fall back to `actor` for manual skip/previous on tracks without owner
 * - if neither exists, skip persistence silently (`reason:'ignored'`)
 *
 * This keeps playback history honest for per-user recommenders without
 * inventing ownership for autoplay/group-listening tracks.
 *
 * @param {{
 *   eventType: string,
 *   guildId?: string | null,
 *   sessionId?: string | null,
 *   actor?: string | null,
 *   requestedBy?: string | null,
 *   triggeredBy?: string | null,
 *   listenersCount?: number | null,
 *   elapsedMs?: number | null,
 *   url: string,
 *   title?: string | null,
 *   artist?: string | null,
 * }} payload
 * @returns {Promise<
 *   { ok: true, playId: string } |
 *   { ok: false, reason: 'ignored' | 'db_error' }
 * >}
 */
export async function recordPlaybackHistory(payload) {
  const userId = normalizeOptionalString(payload?.requestedBy) ?? normalizeOptionalString(payload?.actor);
  const url = normalizeOptionalString(payload?.url);
  if (!userId || !url) {
    return { ok: false, reason: 'ignored' };
  }

  try {
    const service = await getHistoryService();
    return await service.recordPlay({
      userId,
      guildId: normalizeOptionalString(payload?.guildId),
      sessionId: normalizeOptionalString(payload?.sessionId),
      requestedBy: normalizeOptionalString(payload?.requestedBy),
      triggeredBy: normalizeOptionalString(payload?.triggeredBy) ?? 'user',
      listenersCount: normalizeOptionalInteger(payload?.listenersCount) ?? 0,
      elapsedMs: normalizeOptionalInteger(payload?.elapsedMs),
      eventType: normalizeOptionalString(payload?.eventType) ?? 'finished',
      url,
      title: normalizeOptionalString(payload?.title) ?? url,
      artist: normalizeOptionalString(payload?.artist),
    });
  } catch (error) {
    runtimeDeps.warn('[history] playback-history init failed', error instanceof Error ? error.message : error);
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * Test-only hook to swap runtime dependencies without touching call sites.
 *
 * @param {Partial<typeof DEFAULT_DEPS>} nextDeps
 */
export function __setPlaybackHistoryDepsForTests(nextDeps) {
  runtimeDeps = Object.freeze({
    ...DEFAULT_DEPS,
    ...nextDeps,
  });
  runtimeConnection = null;
  runtimeConnectionPromise = null;
  runtimeHistoryServicePromise = null;
}

export async function __resetPlaybackHistoryForTests() {
  const connection = runtimeConnection;
  runtimeDeps = DEFAULT_DEPS;
  runtimeConnection = null;
  runtimeConnectionPromise = null;
  runtimeHistoryServicePromise = null;

  if (connection?.close) {
    await connection.close().catch(() => {});
  }
}
