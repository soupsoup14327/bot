import { createLikesService } from './core/services/likes-service.js';
import { openDatabaseConnection } from './db/connection.js';
import { createLikesRepository } from './db/repo/likes.js';

/**
 * personal-signals.js — runtime facade for user likes.
 *
 * Responsibilities:
 * - expose a stable seam for button/UI code (`emitLike`, `listLikes`)
 * - lazily bootstrap one process-local DB-backed likes service
 * - degrade to soft-fail results if bootstrap/storage is unavailable
 *
 * Non-goals:
 * - no schema ownership here
 * - no SQL here
 * - no Discord-specific formatting here
 */

function defaultWarn(...args) {
  console.warn(...args);
}

const DEFAULT_DEPS = Object.freeze({
  openDatabaseConnection,
  createLikesRepository,
  createLikesService,
  warn: defaultWarn,
});

let runtimeDeps = DEFAULT_DEPS;
let runtimeConnection = null;
let runtimeConnectionPromise = null;
let runtimeLikesServicePromise = null;

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

async function getLikesService() {
  if (!runtimeLikesServicePromise) {
    runtimeLikesServicePromise = (async () => {
      const connection = await getRuntimeConnection();
      const repo = runtimeDeps.createLikesRepository(connection);
      return runtimeDeps.createLikesService({
        repo,
        warn: runtimeDeps.warn,
      });
    })().catch((error) => {
      runtimeLikesServicePromise = null;
      throw error;
    });
  }

  return runtimeLikesServicePromise;
}

/**
 * Toggle like state for the current track.
 *
 * Bootstrap failures are soft-failed into the same stable contract as storage
 * errors so button handlers do not need a second error branch.
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
export async function emitLike(payload) {
  try {
    const service = await getLikesService();
    return await service.emitLike(payload);
  } catch (error) {
    runtimeDeps.warn('[likes] personal-signals init failed', error instanceof Error ? error.message : error);
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * @param {string} userId
 * @param {{ limit?: number }} [options]
 * @returns {Promise<unknown[]>}
 */
export async function listLikes(userId, options = {}) {
  try {
    const service = await getLikesService();
    return await service.listLikes(userId, options);
  } catch (error) {
    runtimeDeps.warn('[likes] personal-signals init failed', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Test-only hook to swap runtime dependencies without touching call sites.
 *
 * @param {Partial<typeof DEFAULT_DEPS>} nextDeps
 */
export function __setPersonalSignalsDepsForTests(nextDeps) {
  runtimeDeps = Object.freeze({
    ...DEFAULT_DEPS,
    ...nextDeps,
  });
  runtimeConnection = null;
  runtimeConnectionPromise = null;
  runtimeLikesServicePromise = null;
}

export async function __resetPersonalSignalsForTests() {
  const connection = runtimeConnection;
  runtimeDeps = DEFAULT_DEPS;
  runtimeConnection = null;
  runtimeConnectionPromise = null;
  runtimeLikesServicePromise = null;

  if (connection?.close) {
    await connection.close().catch(() => {});
  }
}
