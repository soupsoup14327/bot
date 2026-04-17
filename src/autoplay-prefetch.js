/**
 * autoplay-prefetch.js — Two-Phase Versioned Candidate Pools
 *
 * Stores candidates from two sources so the next autoplay spawn can skip
 * the full Groq + YouTube pipeline:
 *
 *   id:fast  — lightweight fast-phase prefetch (no Groq, cheap search)
 *   id:full  — full-phase prefetch OR regular-spawn surplus (Groq-guided)
 *
 * Design invariants:
 *
 * 1. Two independent pool buckets per guild: `${guildId}:fast` and `${guildId}:full`.
 *    No merge view — complexity lives at the read/write boundary, not inside.
 *
 * 2. Reading priority: full first, then fast, then null (→ inline spawn).
 *
 * 3. Write rules:
 *    storeSurplus  — written by music.js after successful spawn; gen bumped externally.
 *                    Writes to :full. Thin, no validation (caller already guarded).
 *    storeFull     — written by full prefetch phase. Validates session+gen freshness,
 *                    then bumps generation atomically with the write.
 *    storeFast     — written by fast prefetch phase. Never bumps generation.
 *                    Skipped if a matching :full already exists (same session + gen ≥ captured).
 *
 * 4. Version model:
 *    - storeFast stores at capturedGen (no bump). Pop checks pool.gen === currentGen.
 *    - storeFull bumps gen → :fast at old gen becomes stale automatically (gen mismatch).
 *      No explicit delete of :fast needed after full runs.
 *
 * 5. Invalidation rules:
 *    quick_skip       → clear both (strong negative: context is wrong)
 *    skip             → pop head from :full first, else from :fast (mild)
 *    stop             → clear both
 *    autoplay_off     → clear both
 *    user_enqueue     → clear both (new explicit request resets context)
 *    voice_disconnect → clear both
 *    session_reset    → clear both
 *
 * @typedef {{ url: string, title: string, [key: string]: unknown }} VideoInfo
 *
 * @typedef {{
 *   phase:      'fast' | 'full',
 *   sessionId:  string,
 *   generation: number,
 *   candidates: VideoInfo[],
 *   storedAt:   number,
 * }} CandidatePool
 */

import {
  getSessionId,
  getPrefetchGeneration,
  incrementPrefetchGeneration,
} from './guild-session-state.js';

/** Max candidates to hold per pool bucket. Caps memory per guild. */
const MAX_POOL_SIZE = 12;

/**
 * Max age before a pool is discarded regardless of version.
 * Prevents stale candidates surviving very long sessions.
 */
const MAX_POOL_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Central store. Keys: `${guildId}:fast` and `${guildId}:full`.
 * @type {Map<string, CandidatePool>}
 */
const _pools = new Map();

// ─── Write API ────────────────────────────────────────────────────────────────

/**
 * Store surplus candidates from a successful regular spawn.
 * Called by music.js AFTER `incrementPrefetchGeneration` — gen is already bumped.
 * Writes to the :full bucket unconditionally.
 *
 * @param {string} guildId
 * @param {{ sessionId: string, generation: number, items: VideoInfo[] }} opts
 */
export function storeSurplus(guildId, { sessionId, generation, items }) {
  if (!items?.length) return;
  _pools.set(`${String(guildId)}:full`, {
    phase:      'full',
    sessionId,
    generation,
    candidates: items.slice(0, MAX_POOL_SIZE),
    storedAt:   Date.now(),
  });
}

/**
 * Store full-phase prefetch results.
 * Validates session + generation freshness, then bumps generation and writes atomically.
 * Returns `{ stored: false }` if stale or empty — caller should log and abort.
 *
 * @param {string} guildId
 * @param {{ sessionId: string, capturedGeneration: number, candidates: VideoInfo[] }} opts
 * @returns {{ stored: boolean, newGen?: number }}
 */
export function storeFull(guildId, { sessionId, capturedGeneration, candidates }) {
  if (!candidates?.length) return { stored: false };
  const id = String(guildId);

  // Validate freshness before touching generation
  if (getSessionId(id) !== sessionId)              return { stored: false };
  if (getPrefetchGeneration(id) !== capturedGeneration) return { stored: false };

  // Observability: was fast pool already present when full arrived?
  const hadFast = _pools.has(`${id}:fast`);

  // Atomic: bump generation then write
  const newGen = incrementPrefetchGeneration(id);
  _pools.set(`${id}:full`, {
    phase:      'full',
    sessionId,
    generation: newGen,
    candidates: candidates.slice(0, MAX_POOL_SIZE),
    storedAt:   Date.now(),
  });

  // :fast at old capturedGeneration is now stale (gen mismatch on pop) — no explicit delete.
  console.log(
    `[prefetch] storeFull guild=${id} gen=${newGen} candidates=${candidates.length}` +
    (hadFast ? ' (fast pool superseded)' : ''),
  );
  return { stored: true, newGen };
}

/**
 * Store fast-phase prefetch results (no Groq, cheap search).
 * Does NOT bump generation — preserves the generation anchor for the full phase.
 * Skipped silently if a matching :full pool already exists for this session at gen >= capturedGen.
 *
 * @param {string} guildId
 * @param {{ sessionId: string, generation: number, candidates: VideoInfo[] }} opts
 */
export function storeFast(guildId, { sessionId, generation, candidates }) {
  if (!candidates?.length) return;
  const id = String(guildId);

  // Skip if a full pool for this session is already present and fresh
  const existingFull = _pools.get(`${id}:full`);
  if (existingFull?.sessionId === sessionId && existingFull.generation >= generation) {
    console.log(`[prefetch] storeFast skipped — full pool already present guild=${id}`);
    return;
  }

  _pools.set(`${id}:fast`, {
    phase:      'fast',
    sessionId,
    generation,
    candidates: candidates.slice(0, MAX_POOL_SIZE),
    storedAt:   Date.now(),
  });
  console.log(`[prefetch] storeFast guild=${id} gen=${generation} candidates=${candidates.length}`);
}

// ─── Read API ─────────────────────────────────────────────────────────────────

/**
 * Pop the best available candidate from the pool.
 * Tries :full first, then :fast. Returns null if both miss.
 * Logs `pool_hit=full|fast|miss` for observability.
 * Caller MUST verify returned candidate still passes playability check.
 *
 * @param {string} guildId
 * @param {{ sessionId: string, generation: number }} version
 * @returns {VideoInfo | null}
 */
export function popBestCandidate(guildId, { sessionId, generation }) {
  const id  = String(guildId);
  const now = Date.now();

  for (const phase of /** @type {const} */(['full', 'fast'])) {
    const key  = `${id}:${phase}`;
    const pool = _pools.get(key);
    if (!pool) continue;

    if (pool.sessionId !== sessionId || pool.generation !== generation) {
      _pools.delete(key); // clean up stale entry
      continue;
    }
    if (now - pool.storedAt > MAX_POOL_AGE_MS) {
      _pools.delete(key);
      continue;
    }
    if (!pool.candidates.length) {
      _pools.delete(key);
      continue;
    }

    const candidate = pool.candidates.shift();
    if (!pool.candidates.length) _pools.delete(key);

    console.log(
      `[prefetch] pool_hit=${phase} guild=${id}` +
      ` title="${String(candidate?.title ?? '').slice(0, 60)}"`,
    );
    return candidate ?? null;
  }

  return null;
}

/**
 * Peek at combined pool size across both buckets.
 * Used by prefetch runners to decide whether to start a new search.
 *
 * @param {string} guildId
 * @returns {number}
 */
export function getPoolSize(guildId) {
  const id = String(guildId);
  return (
    (_pools.get(`${id}:fast`)?.candidates.length ?? 0) +
    (_pools.get(`${id}:full`)?.candidates.length ?? 0)
  );
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

/**
 * @typedef {'quick_skip' | 'skip' | 'stop' | 'autoplay_off' | 'user_enqueue' | 'voice_disconnect' | 'session_reset'} InvalidationReason
 */

/**
 * Invalidate the pool for a guild.
 *
 *   quick_skip       → clear both (strong negative signal, context is wrong)
 *   skip             → pop head from :full, else from :fast (mild signal)
 *   stop             → clear both
 *   autoplay_off     → clear both
 *   user_enqueue     → clear both (explicit request resets session context)
 *   voice_disconnect → clear both
 *   session_reset    → clear both
 *
 * Note: generation bump on quick_skip is done externally by music.js
 * (`incrementPrefetchGeneration`) — this function only manages pool contents.
 *
 * @param {string} guildId
 * @param {InvalidationReason} reason
 */
export function invalidatePool(guildId, reason) {
  const id      = String(guildId);
  const fastKey = `${id}:fast`;
  const fullKey = `${id}:full`;

  if (reason === 'skip') {
    // Mild: drop head from :full first; if empty, drop from :fast
    const full = _pools.get(fullKey);
    if (full?.candidates.length) {
      full.candidates.shift();
      if (!full.candidates.length) _pools.delete(fullKey);
      return;
    }
    const fast = _pools.get(fastKey);
    if (fast?.candidates.length) {
      fast.candidates.shift();
      if (!fast.candidates.length) _pools.delete(fastKey);
    }
    return;
  }

  // All other reasons → clear both buckets
  _pools.delete(fastKey);
  _pools.delete(fullKey);
}

/**
 * Clear both pool buckets for a guild unconditionally.
 * Called on endSession / stopAndLeave.
 *
 * @param {string} guildId
 */
export function clearPool(guildId) {
  const id = String(guildId);
  _pools.delete(`${id}:fast`);
  _pools.delete(`${id}:full`);
}
