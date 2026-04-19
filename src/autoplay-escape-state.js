/**
 * Escape branch FSM for autoplay.
 *
 * Contract:
 * - Session intent remains immutable; escape is a temporary branch.
 * - Basin-trigger logic lives elsewhere; this module only stores and advances branch state.
 * - Trial/provisional/confirmed separate operational latency from semantic commitment.
 * - Trial disables prefetch entirely; provisional allows only cheap prefetch.
 * - Depth cap is 2 (trial + one child trial from provisional).
 * - Cooldown is counted in autoplay spawns, not minutes.
 *
 * Public API (fixed here so later wiring is mechanical, not creative):
 * - startAutoplayEscapeTrial(guildId, meta?)
 *   Called when the next autoplay spawn should enter escape mode. Creates a new
 *   branch or advances a provisional branch into its one allowed child trial.
 * - promoteAutoplayEscapeToProvisional(guildId, meta?)
 *   Called after a trial survives dwell threshold T without a quick-skip.
 * - markAutoplayEscapeTrackStarted(guildId, spawnId, meta?)
 *   Called on the real playback `track_started` event when the queued item
 *   matches the active escape branch. This rebases `phaseStartedAt` from
 *   branch-creation time onto actual listening time.
 * - confirmAutoplayEscapeBranch(guildId, meta?)
 *   Called after a trial/provisional branch finishes successfully or gets an
 *   explicit positive signal. Keeps the branch snapshot in `confirmed` so the
 *   caller can harvest secondary context before clearing it.
 * - killAutoplayEscapeBranch(guildId, reason, options?)
 *   Idempotent branch teardown for explicit user actions, failed trials, stop,
 *   autoplay-off, or session reset.
 * - markAutoplayEscapeDFallbackPending(guildId, meta?)
 *   Marks exactly one pending D-fallback retrieval after a trial dies before T.
 * - consumeAutoplayEscapeDFallbackPending(guildId)
 *   Consumes that single pending D-fallback retrieval attempt.
 * - startAutoplayEscapeCooldown(guildId, spawnCount?)
 *   Starts escape cooldown in quick-skip trigger units after a failed D-fallback path.
 * - consumeAutoplayEscapeCooldownSpawn(guildId)
 *   Burns one cooldown spawn and returns the remaining count.
 * - getAutoplayEscapeSnapshot(guildId)
 *   Returns the current branch snapshot plus cooldown/prefetch helpers.
 * - getAutoplayEscapePhase(guildId)
 * - getAutoplayEscapePrefetchMode(guildId)
 * - shouldAutoplayEscapePrefetch(guildId)
 * - isAutoplayEscapeCooldownActive(guildId)
 * - isAutoplayEscapeEnabled()
 * - getAutoplayEscapeTrialThresholdMs()
 * - clearAutoplayEscapeState(guildId?)
 *   Runtime reset helper; when guildId is omitted, clears all branches/cooldowns.
 */

/** @typedef {'trial' | 'provisional' | 'confirmed'} AutoplayEscapePhase */
/** @typedef {'off' | 'cheap' | 'normal'} AutoplayEscapePrefetchMode */
/** @typedef {import('./autoplay-escape-retrieval.js').AutoplayEscapeContrastHint} AutoplayEscapeContrastHint */
import { recordAutoplayEscapeTransitionMetric } from './autoplay-escape-telemetry.js';

/**
 * @typedef {{
 *   branchId: string,
 *   guildId: string,
 *   phase: AutoplayEscapePhase,
 *   depth: number,
 *   originSpawnId: string | null,
 *   currentSpawnId: string | null,
 *   contrastHint: AutoplayEscapeContrastHint | null,
 *   confirmedAnchors: string[],
 *   startedAt: number,
 *   phaseStartedAt: number | null,
 *   trialThresholdMs: number,
 *   meta: Record<string, unknown>,
 * }} AutoplayEscapeBranch
 */

/**
 * @typedef {{
 *   guildId: string,
 *   branchId: string | null,
 *   phase: AutoplayEscapePhase | null,
 *   depth: number,
 *   originSpawnId: string | null,
 *   currentSpawnId: string | null,
 *   contrastHint: AutoplayEscapeContrastHint | null,
 *   confirmedAnchors: string[],
 *   startedAt: number | null,
 *   phaseStartedAt: number | null,
 *   trialThresholdMs: number,
 *   cooldownSpawnsRemaining: number,
 *   dFallbackPending: boolean,
 *   prefetchMode: AutoplayEscapePrefetchMode,
 *   meta: Record<string, unknown>,
 * }} AutoplayEscapeSnapshot
 */

const DEFAULT_TRIAL_THRESHOLD_MS = 15_000;
const DEFAULT_TRIAL_THRESHOLD_CAP_MS = 30_000;
const DEFAULT_COOLDOWN_SPAWNS = 2;
const ESCAPE_DEPTH_CAP = 2;

/** @type {Map<string, AutoplayEscapeBranch>} */
const activeBranchByGuild = new Map();
/** @type {Map<string, number>} */
const cooldownSpawnsByGuild = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const dFallbackPendingByGuild = new Map();
/** @type {Map<string, number>} */
const branchSequenceByGuild = new Map();

function gid(guildId) {
  return String(guildId);
}

function nowMs() {
  return Date.now();
}

function cloneMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  return { ...meta };
}

function normalizeContrastHint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hint = /** @type {Record<string, unknown>} */ (raw);
  if (hint.from !== 'same_spawn' && hint.from !== 'same_family') return null;
  return {
    from: hint.from,
    anchor:
      typeof hint.anchor === 'string' && hint.anchor.trim()
        ? hint.anchor.trim()
        : null,
  };
}

function normalizeConfirmedAnchors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function buildConfirmedAnchors(existing, meta) {
  const fromMetaTitle =
    typeof meta?.title === 'string' && meta.title.trim()
      ? [meta.title.trim()]
      : [];
  if (fromMetaTitle.length) return fromMetaTitle;
  return normalizeConfirmedAnchors(existing?.confirmedAnchors);
}

function nextBranchId(guildId) {
  const id = gid(guildId);
  const next = (branchSequenceByGuild.get(id) ?? 0) + 1;
  branchSequenceByGuild.set(id, next);
  return `escape:${id}:${next}`;
}

function getQuickSkipThresholdMs() {
  const n = Number(process.env.MUSIC_QUICK_SKIP_MS);
  if (Number.isFinite(n) && n > 0) return Math.max(1_000, Math.floor(n));
  return 5_000;
}

function sanitizeThresholdMs(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TRIAL_THRESHOLD_MS;
  return Math.min(
    DEFAULT_TRIAL_THRESHOLD_CAP_MS,
    Math.max(1_000, Math.floor(raw)),
  );
}

function buildTrialThresholdMs() {
  const override = Number(process.env.AUTOPLAY_ESCAPE_T_MS);
  if (Number.isFinite(override) && override > 0) {
    return sanitizeThresholdMs(override);
  }
  const derived = Math.max(
    12_000,
    Math.round(getQuickSkipThresholdMs() * 2.5),
  );
  return sanitizeThresholdMs(derived);
}

function buildCooldownSpawns() {
  const n = Number(process.env.AUTOPLAY_ESCAPE_COOLDOWN_SPAWNS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOLDOWN_SPAWNS;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

function buildPrefetchMode(branch) {
  if (!branch) return 'normal';
  if (branch.phase === 'trial') return 'off';
  if (branch.phase === 'provisional') return 'cheap';
  return 'normal';
}

function branchToSnapshot(guildId, branch) {
  const id = gid(guildId);
  const cooldownSpawnsRemaining = Math.max(0, cooldownSpawnsByGuild.get(id) ?? 0);
  const dFallbackPending = dFallbackPendingByGuild.has(id);
  return {
    guildId: id,
    branchId: branch?.branchId ?? null,
    phase: branch?.phase ?? null,
    depth: branch?.depth ?? 0,
    originSpawnId: branch?.originSpawnId ?? null,
    currentSpawnId: branch?.currentSpawnId ?? null,
    contrastHint: branch?.contrastHint ? { ...branch.contrastHint } : null,
    confirmedAnchors: normalizeConfirmedAnchors(branch?.confirmedAnchors),
    startedAt: branch?.startedAt ?? null,
    phaseStartedAt: branch?.phaseStartedAt ?? null,
    trialThresholdMs: branch?.trialThresholdMs ?? getAutoplayEscapeTrialThresholdMs(),
    cooldownSpawnsRemaining,
    dFallbackPending,
    prefetchMode: buildPrefetchMode(branch),
    meta: cloneMeta(branch?.meta),
  };
}

function logEscapeTransition(guildId, stage, meta = null) {
  recordAutoplayEscapeTransitionMetric(guildId, stage, meta);
  if (meta == null) {
    console.log(`[escape] guild=${guildId} stage=${stage}`);
    return;
  }
  try {
    console.log(`[escape] guild=${guildId} stage=${stage} ${JSON.stringify(meta)}`);
  } catch {
    console.log(`[escape] guild=${guildId} stage=${stage}`, meta);
  }
}

function assertBranchPhase(branch, allowedPhases, action) {
  if (!branch || !allowedPhases.includes(branch.phase)) {
    const actual = branch?.phase ?? 'none';
    throw new Error(`[escape] cannot ${action} from phase=${actual}`);
  }
}

function nextTrialBranch(guildId, meta) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id);
  const timestamp = nowMs();
  const branchMeta = cloneMeta(meta);
  const currentSpawnId =
    typeof branchMeta.currentSpawnId === 'string' ? branchMeta.currentSpawnId : null;
  const originSpawnId =
    typeof branchMeta.originSpawnId === 'string'
      ? branchMeta.originSpawnId
      : existing?.originSpawnId ?? currentSpawnId;
  const contrastHint = normalizeContrastHint(branchMeta.contrastHint) ?? existing?.contrastHint ?? null;

  if (!existing) {
    return {
      branchId: nextBranchId(id),
      guildId: id,
      phase: /** @type {AutoplayEscapePhase} */ ('trial'),
      depth: 1,
      originSpawnId,
      currentSpawnId,
      contrastHint,
      confirmedAnchors: [],
      startedAt: timestamp,
      phaseStartedAt: null,
      trialThresholdMs: getAutoplayEscapeTrialThresholdMs(),
      meta: branchMeta,
    };
  }

  assertBranchPhase(existing, ['provisional'], 'start child trial');
  if (existing.depth >= ESCAPE_DEPTH_CAP) {
    throw new Error(`[escape] depth cap reached for guild=${id}`);
  }

  return {
    ...existing,
    phase: 'trial',
    depth: existing.depth + 1,
    currentSpawnId,
    contrastHint,
    confirmedAnchors: normalizeConfirmedAnchors(existing.confirmedAnchors),
    phaseStartedAt: null,
    trialThresholdMs: getAutoplayEscapeTrialThresholdMs(),
    meta: { ...existing.meta, ...branchMeta },
  };
}

export function isAutoplayEscapeEnabled() {
  return String(process.env.AUTOPLAY_ESCAPE_ENABLED ?? '').trim() === '1';
}

export function getAutoplayEscapeTrialThresholdMs() {
  return buildTrialThresholdMs();
}

export function getAutoplayEscapeCooldownSpawns() {
  return buildCooldownSpawns();
}

export function getAutoplayEscapeDepthCap() {
  return ESCAPE_DEPTH_CAP;
}

/**
 * @param {string} guildId
 * @returns {AutoplayEscapePhase | null}
 */
export function getAutoplayEscapePhase(guildId) {
  return activeBranchByGuild.get(gid(guildId))?.phase ?? null;
}

/**
 * @param {string} guildId
 * @returns {AutoplayEscapePrefetchMode}
 */
export function getAutoplayEscapePrefetchMode(guildId) {
  return buildPrefetchMode(activeBranchByGuild.get(gid(guildId)));
}

export function shouldAutoplayEscapePrefetch(guildId) {
  return getAutoplayEscapePrefetchMode(guildId) !== 'off';
}

export function isAutoplayEscapeCooldownActive(guildId) {
  return (cooldownSpawnsByGuild.get(gid(guildId)) ?? 0) > 0;
}

export function isAutoplayEscapeDFallbackPending(guildId) {
  return dFallbackPendingByGuild.has(gid(guildId));
}

/**
 * @param {string} guildId
 * @returns {AutoplayEscapeSnapshot}
 */
export function getAutoplayEscapeSnapshot(guildId) {
  const id = gid(guildId);
  return branchToSnapshot(id, activeBranchByGuild.get(id) ?? null);
}

/**
 * @param {string} guildId
 * @param {Record<string, unknown>} [meta]
 * @returns {AutoplayEscapeSnapshot}
 */
export function startAutoplayEscapeTrial(guildId, meta = {}) {
  const branch = nextTrialBranch(guildId, meta);
  activeBranchByGuild.set(branch.guildId, branch);
  const snapshot = branchToSnapshot(branch.guildId, branch);
  logEscapeTransition(branch.guildId, 'trial_started', {
    branchId: branch.branchId,
    depth: branch.depth,
    originSpawnId: branch.originSpawnId,
    currentSpawnId: branch.currentSpawnId,
    contrastHint: branch.contrastHint,
  });
  return snapshot;
}

/**
 * @param {string} guildId
 * @param {string} spawnId
 * @param {Record<string, unknown>} [meta]
 * @returns {AutoplayEscapeSnapshot}
 */
export function markAutoplayEscapeTrackStarted(guildId, spawnId, meta = {}) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id);
  assertBranchPhase(existing, ['trial'], 'mark track started');
  if (existing.currentSpawnId !== String(spawnId)) {
    throw new Error(
      `[escape] cannot mark track started for spawn=${String(spawnId)} when currentSpawnId=${String(existing.currentSpawnId ?? 'null')}`,
    );
  }
  const branch = {
    ...existing,
    phaseStartedAt: nowMs(),
    meta: { ...existing.meta, ...cloneMeta(meta) },
  };
  activeBranchByGuild.set(id, branch);
  const snapshot = branchToSnapshot(id, branch);
  logEscapeTransition(id, 'track_started', {
    branchId: branch.branchId,
    depth: branch.depth,
    currentSpawnId: branch.currentSpawnId,
    phaseStartedAt: branch.phaseStartedAt,
  });
  return snapshot;
}

/**
 * @param {string} guildId
 * @param {Record<string, unknown>} [meta]
 * @returns {AutoplayEscapeSnapshot}
 */
export function promoteAutoplayEscapeToProvisional(guildId, meta = {}) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id);
  assertBranchPhase(existing, ['trial'], 'promote to provisional');
  const branch = {
    ...existing,
    phase: /** @type {AutoplayEscapePhase} */ ('provisional'),
    phaseStartedAt: nowMs(),
    meta: { ...existing.meta, ...cloneMeta(meta) },
  };
  activeBranchByGuild.set(id, branch);
  const snapshot = branchToSnapshot(id, branch);
  logEscapeTransition(id, 'provisional', {
    branchId: branch.branchId,
    depth: branch.depth,
    currentSpawnId: branch.currentSpawnId,
  });
  return snapshot;
}

/**
 * @param {string} guildId
 * @param {Record<string, unknown>} [meta]
 * @returns {AutoplayEscapeSnapshot}
 */
export function confirmAutoplayEscapeBranch(guildId, meta = {}) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id);
  assertBranchPhase(existing, ['trial', 'provisional'], 'confirm branch');
  const branch = {
    ...existing,
    phase: /** @type {AutoplayEscapePhase} */ ('confirmed'),
    confirmedAnchors: buildConfirmedAnchors(existing, meta),
    phaseStartedAt: nowMs(),
    meta: { ...existing.meta, ...cloneMeta(meta) },
  };
  activeBranchByGuild.set(id, branch);
  const snapshot = branchToSnapshot(id, branch);
  logEscapeTransition(id, 'confirmed', {
    branchId: branch.branchId,
    depth: branch.depth,
    currentSpawnId: branch.currentSpawnId,
  });
  return snapshot;
}

/**
 * @param {string} guildId
 * @param {string} reason
 * @param {{ startCooldown?: boolean, cooldownSpawns?: number | null, meta?: Record<string, unknown> }} [options]
 * @returns {AutoplayEscapeSnapshot}
 */
export function killAutoplayEscapeBranch(guildId, reason, options = {}) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id) ?? null;
  if (!existing) {
    if (options.startCooldown) {
      startAutoplayEscapeCooldown(id, options.cooldownSpawns ?? undefined);
    }
    logEscapeTransition(id, 'killed', {
      reason,
      branchId: null,
      noop: true,
      ...cloneMeta(options.meta),
    });
    return branchToSnapshot(id, null);
  }

  activeBranchByGuild.delete(id);
  if (options.startCooldown) {
    startAutoplayEscapeCooldown(id, options.cooldownSpawns ?? undefined);
  }
  logEscapeTransition(id, 'killed', {
    reason,
    branchId: existing.branchId,
    depth: existing.depth,
    phase: existing.phase,
    currentSpawnId: existing.currentSpawnId,
    ...cloneMeta(options.meta),
  });
  return branchToSnapshot(id, null);
}

/**
 * Mark exactly one pending D-fallback retrieval attempt.
 *
 * @param {string} guildId
 * @param {Record<string, unknown>} [meta]
 * @returns {boolean}
 */
export function markAutoplayEscapeDFallbackPending(guildId, meta = {}) {
  const id = gid(guildId);
  dFallbackPendingByGuild.set(id, {
    requestedAt: nowMs(),
    ...cloneMeta(meta),
  });
  logEscapeTransition(id, 'd_fallback_pending', cloneMeta(meta));
  return true;
}

/**
 * Consume the one-shot D-fallback retrieval attempt flag.
 *
 * @param {string} guildId
 * @returns {boolean}
 */
export function consumeAutoplayEscapeDFallbackPending(guildId) {
  const id = gid(guildId);
  const hadPending = dFallbackPendingByGuild.has(id);
  if (!hadPending) return false;
  dFallbackPendingByGuild.delete(id);
  logEscapeTransition(id, 'd_fallback_consumed');
  return true;
}

/**
 * Attach the concrete autoplay spawnId to the currently active escape branch.
 * Strict contract: throws when no branch is active.
 *
 * @param {string} guildId
 * @param {string} spawnId
 * @returns {AutoplayEscapeSnapshot}
 */
export function attachAutoplayEscapeSpawnId(guildId, spawnId) {
  const id = gid(guildId);
  const existing = activeBranchByGuild.get(id);
  assertBranchPhase(existing, ['trial', 'provisional', 'confirmed'], 'attach spawn id');
  const nextSpawnId = String(spawnId ?? '').trim();
  if (!nextSpawnId) {
    throw new Error('[escape] cannot attach empty spawn id');
  }
  const branch = {
    ...existing,
    currentSpawnId: nextSpawnId,
  };
  activeBranchByGuild.set(id, branch);
  const snapshot = branchToSnapshot(id, branch);
  logEscapeTransition(id, 'spawn_attached', {
    branchId: branch.branchId,
    phase: branch.phase,
    currentSpawnId: branch.currentSpawnId,
  });
  return snapshot;
}

export function startAutoplayEscapeCooldown(guildId, spawnCount = undefined) {
  const id = gid(guildId);
  const next = spawnCount == null ? getAutoplayEscapeCooldownSpawns() : Math.max(0, Math.floor(spawnCount));
  if (next <= 0) {
    cooldownSpawnsByGuild.delete(id);
    logEscapeTransition(id, 'cooldown_cleared');
    return 0;
  }
  cooldownSpawnsByGuild.set(id, next);
  logEscapeTransition(id, 'cooldown_started', { remaining: next });
  return next;
}

export function consumeAutoplayEscapeCooldownSpawn(guildId) {
  const id = gid(guildId);
  const current = cooldownSpawnsByGuild.get(id) ?? 0;
  if (current <= 0) return 0;
  const remaining = current - 1;
  if (remaining > 0) {
    cooldownSpawnsByGuild.set(id, remaining);
  } else {
    cooldownSpawnsByGuild.delete(id);
  }
  logEscapeTransition(id, 'cooldown_tick', { remaining });
  return remaining;
}

/**
 * Runtime reset helper.
 * @param {string | null | undefined} [guildId]
 */
export function clearAutoplayEscapeState(guildId = undefined) {
  if (guildId == null) {
    activeBranchByGuild.clear();
    cooldownSpawnsByGuild.clear();
    dFallbackPendingByGuild.clear();
    branchSequenceByGuild.clear();
    return;
  }
  const id = gid(guildId);
  activeBranchByGuild.delete(id);
  cooldownSpawnsByGuild.delete(id);
  dFallbackPendingByGuild.delete(id);
  branchSequenceByGuild.delete(id);
}
