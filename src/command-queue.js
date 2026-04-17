/**
 * command-queue.js
 *
 * Per-guild serialization for orchestrator.commands.* use-cases.
 *
 * Problem (without queue):
 *   Two users press different buttons at the same moment — e.g. A presses
 *   skip, B presses pause. orchestrator.commands.skip and .pause fire into
 *   music.js simultaneously. Each command reads state at entry, decides an
 *   action, mutates state and emits signals. Without ordering the final
 *   state can be inconsistent:
 *     - double "track_skipped" signal for one transition
 *     - pause applied after stopPlayer already kicked Idle
 *     - repeat/autoplay toggles racing with stop-and-leave teardown
 *
 * Solution:
 *   All commands for a single guildId queue up via a per-guild Promise
 *   chain (same pattern as panel-update-queue.js). Each command runs ONLY
 *   after the previous one has resolved. Chain never rejects — errors are
 *   caught inside and returned as Err Result to the specific caller that
 *   triggered them; the tail Promise continues to resolve so subsequent
 *   commands can run.
 *
 * Invariants:
 *   - scheduleCommand(guildId, fn) always returns a Promise<Result> that
 *     resolves (never rejects). If fn throws, returns Err with code
 *     'internal_error'.
 *   - Commands for different guildIds never block each other.
 *   - A command can observe state mutated by the previous command in the
 *     same guild (sequential consistency).
 *
 * Non-goals:
 *   - This is NOT a semaphore / rate limiter. Every command runs; they
 *     just run one at a time per guild.
 *   - This is NOT a cross-process lock. Only serialises within the
 *     current Node.js process.
 */

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * Schedules `fn` to run after all previously scheduled commands for this
 * guild have completed. Returns a Promise that resolves with fn's return
 * value, or an internal_error Result if fn throws.
 *
 * The tail Promise of the chain is always a non-rejecting Promise so that
 * a single failing command does not poison the queue.
 *
 * @template T
 * @param {string} guildId
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T | { ok: false, reason: string, code: 'internal_error' }>}
 */
export function scheduleCommand(guildId, fn) {
  const id = String(guildId);
  const prev = tails.get(id) ?? Promise.resolve();

  const job = prev.then(async () => {
    try {
      return await fn();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason, code: 'internal_error' };
    }
  });

  tails.set(id, job);
  void job.finally(() => {
    if (tails.get(id) === job) tails.delete(id);
  });
  return job;
}

/**
 * Returns the current chain-tail length for tests / observability.
 * Since tails only stores ONE pending Promise per guild (chain is collapsed),
 * this is either 0 or 1 per guild; it does not count enqueued items.
 * Useful only to assert "no pending work" in tests.
 *
 * @param {string} guildId
 * @returns {boolean} true if there is an unresolved command chain for this guild
 */
export function hasPendingCommands(guildId) {
  return tails.has(String(guildId));
}

/**
 * Test-only: clears all in-flight chain references. Does NOT cancel the
 * actual in-flight fn — callers must await jobs before reset.
 *
 * @internal
 */
export function __resetCommandQueueForTests() {
  tails.clear();
}
