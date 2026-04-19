import {
  getAutoplayEscapeSnapshot,
  killAutoplayEscapeBranch,
  markAutoplayEscapeDFallbackPending,
  startAutoplayEscapeCooldown,
} from './autoplay-escape-state.js';

/**
 * Apply quick-skip lifecycle transitions for the currently active escape
 * branch. This helper is intentionally narrow: it only interprets what the
 * current quick-skip means for an existing branch and leaves any follow-up
 * policy (for example D-fallback) to later steps.
 *
 * Important semantics:
 * - only `trial` is actionable here;
 * - quick-skips for non-escape tracks are ignored;
 * - dwell uses `phaseStartedAt` (real playback start), not branch creation.
 *
 * @param {{
 *   guildId: string,
 *   currentItem?: { spawnId?: string | null, source?: string | null } | null,
 *   currentTitle?: string | null,
 *   elapsedMs: number,
 *   nowMs?: number,
 * }} input
 * @returns {{
 *   handled: boolean,
 *   transition: 'killed_before_t' | 'killed_after_t' | null,
 *   snapshot?: import('./autoplay-escape-state.js').AutoplayEscapeSnapshot,
 *   reason?: 'not_trial' | 'spawn_mismatch' | 'track_not_started',
 *   dwellMs?: number,
 * }}
 */
export function maybeApplyAutoplayEscapeQuickSkipTransitions({
  guildId,
  currentItem = null,
  currentTitle = null,
  elapsedMs,
  nowMs = Date.now(),
}) {
  const snapshot = getAutoplayEscapeSnapshot(guildId);
  if (snapshot.phase !== 'trial') {
    return { handled: false, transition: null, reason: 'not_trial' };
  }

  const currentSpawnId =
    typeof currentItem?.spawnId === 'string' && currentItem.spawnId.trim()
      ? currentItem.spawnId.trim()
      : null;

  if (currentSpawnId == null || snapshot.currentSpawnId !== currentSpawnId) {
    return { handled: false, transition: null, reason: 'spawn_mismatch' };
  }

  if (snapshot.phaseStartedAt == null) {
    return { handled: false, transition: null, reason: 'track_not_started' };
  }

  const dwellMs = Math.max(0, nowMs - snapshot.phaseStartedAt);
  const thresholdMs = snapshot.trialThresholdMs;
  const beforeThreshold = dwellMs < thresholdMs;
  const killReason = beforeThreshold
    ? 'trial_quick_skip_before_t'
    : 'trial_quick_skip_after_t';

  const killed = killAutoplayEscapeBranch(guildId, killReason, {
    meta: {
      requestsDFallback: beforeThreshold,
      dwellMs,
      elapsedMs,
      trialThresholdMs: thresholdMs,
      spawnId: currentSpawnId,
      source: currentItem?.source ?? null,
      title: currentTitle ?? null,
    },
  });

  if (beforeThreshold) {
    markAutoplayEscapeDFallbackPending(guildId, {
      reason: killReason,
      spawnId: currentSpawnId,
      title: currentTitle ?? null,
    });
    startAutoplayEscapeCooldown(guildId);
  }

  return {
    handled: true,
    transition: beforeThreshold ? 'killed_before_t' : 'killed_after_t',
    snapshot: killed,
    dwellMs,
  };
}
