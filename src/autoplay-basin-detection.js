/**
 * Pure basin detection for autoplay quick-skip sequences.
 *
 * Input is provided explicitly by the caller; this module does not read global
 * buffers or session state. That keeps it testable on recorded quick-skip
 * sequences and lets runtime call-sites decide where "recentQuickSkips" come
 * from (`music-signals`, future DB reads, etc.).
 *
 * MVP rules:
 * 1. same spawnId across the newest two quick-skips => basin=true, kind=same_spawn
 * 2. else same queryFamily across the newest two quick-skips => basin=true, kind=same_family
 * 3. else basin=false
 *
 * Both rules are windowed by timestamp so two skips hours apart are not linked.
 * `maxSkipsConsidered` currently only limits the input window; the detector still
 * compares only the newest pair. Larger values are reserved for future analysis.
 */

/** @typedef {'same_spawn' | 'same_family' | null} AutoplayBasinKind */

/**
 * @typedef {{
 *   timestamp: number,
 *   spawnId?: string | null,
 *   queryFamily?: string | null,
 *   url?: string | null,
 *   title?: string | null,
 * }} BasinQuickSkipEvent
 */

/**
 * @typedef {{
 *   basin: boolean,
 *   kind: AutoplayBasinKind,
 *   evidence: {
 *     compared: number,
 *     maxWindowMs: number,
 *     left?: BasinQuickSkipEvent,
 *     right?: BasinQuickSkipEvent,
 *     matchedSpawnId?: string,
 *     matchedQueryFamily?: string,
 *     reason?: 'insufficient_events' | 'outside_window' | 'no_match',
 *   },
 * }} AutoplayBasinDecision
 */

const DEFAULT_MAX_SKIPS_CONSIDERED = 2;
const DEFAULT_MAX_WINDOW_MS = 120_000;

function normalizeFamily(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeQuickSkipEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = /** @type {Record<string, unknown>} */ (raw);
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return null;
  return {
    timestamp: event.timestamp,
    spawnId:
      typeof event.spawnId === 'string' && event.spawnId.trim()
        ? event.spawnId.trim()
        : null,
    queryFamily: normalizeFamily(event.queryFamily),
    url: typeof event.url === 'string' && event.url.trim() ? event.url : null,
    title: typeof event.title === 'string' && event.title.trim() ? event.title : null,
  };
}

/**
 * @param {{
 *   recentQuickSkips: unknown[],
 *   nowMs?: number,
 *   maxSkipsConsidered?: number,
 *   maxWindowMs?: number,
 * }} input
 * @returns {AutoplayBasinDecision}
 */
export function detectAutoplayBasin({
  recentQuickSkips,
  nowMs = Date.now(),
  maxSkipsConsidered = DEFAULT_MAX_SKIPS_CONSIDERED,
  maxWindowMs = DEFAULT_MAX_WINDOW_MS,
}) {
  const windowMs = Number.isFinite(maxWindowMs) && maxWindowMs > 0
    ? Math.max(1_000, Math.floor(maxWindowMs))
    : DEFAULT_MAX_WINDOW_MS;
  const limit = Number.isFinite(maxSkipsConsidered) && maxSkipsConsidered > 0
    ? Math.max(2, Math.floor(maxSkipsConsidered))
    : DEFAULT_MAX_SKIPS_CONSIDERED;

  const valid = (Array.isArray(recentQuickSkips) ? recentQuickSkips : [])
    .map((event) => normalizeQuickSkipEvent(event))
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);
  const normalized = valid
    .filter((event) => nowMs - event.timestamp <= windowMs)
    .slice(0, limit);

  if (normalized.length < 2) {
    const reason =
      valid.length < 2
        ? 'insufficient_events'
        : 'outside_window';
    return {
      basin: false,
      kind: null,
      evidence: {
        compared: normalized.length,
        maxWindowMs: windowMs,
        reason,
      },
    };
  }

  const [left, right] = normalized;
  if (left.spawnId && right.spawnId && left.spawnId === right.spawnId) {
    return {
      basin: true,
      kind: 'same_spawn',
      evidence: {
        compared: 2,
        maxWindowMs: windowMs,
        left,
        right,
        matchedSpawnId: left.spawnId,
      },
    };
  }

  if (left.queryFamily && right.queryFamily && left.queryFamily === right.queryFamily) {
    return {
      basin: true,
      kind: 'same_family',
      evidence: {
        compared: 2,
        maxWindowMs: windowMs,
        left,
        right,
        matchedQueryFamily: left.queryFamily,
      },
    };
  }

  return {
    basin: false,
    kind: null,
    evidence: {
      compared: 2,
      maxWindowMs: windowMs,
      left,
      right,
      reason: 'no_match',
    },
  };
}
