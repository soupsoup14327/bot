import { detectAutoplayBasin } from './autoplay-basin-detection.js';
import { buildAutoplayEscapeContrastHint } from './autoplay-escape-retrieval.js';
import { incrementAutoplayEscapeMetric } from './autoplay-escape-telemetry.js';
import {
  consumeAutoplayEscapeCooldownSpawn,
  getAutoplayEscapePhase,
  isAutoplayEscapeCooldownActive,
  isAutoplayEscapeEnabled,
  startAutoplayEscapeTrial,
} from './autoplay-escape-state.js';
import { getSignalsByType } from './music-signals.js';
import { getQuickSkipThresholdMs } from './playback-metrics.js';

const BASIN_SIGNAL_LIMIT = 4;

function isQuickSkipEvent(event, thresholdMs) {
  return event?.type === 'track_skipped'
    && typeof event.elapsedMs === 'number'
    && event.elapsedMs < thresholdMs;
}

/**
 * Quick-skip basin trigger wiring.
 *
 * Important semantics:
 * - feature flag short-circuits before any signal reads;
 * - cooldown is consumed before basin detection;
 * - basin-trigger is additive and does not replace the caller's existing
 *   quick-skip invalidation/generation-bump flow.
 *
 * @param {{
 *   guildId: string,
 *   sessionId?: string | null,
 *   currentItem?: { spawnId?: string | null, requestedBy?: string | null, source?: string | null } | null,
 *   currentUrl: string,
 *   currentTitle?: string | null,
 *   nowMs?: number,
 * }} input
 * @returns {{
 *   triggered: boolean,
 *   skippedByFlag?: boolean,
 *   skippedByCooldown?: boolean,
 *   decision?: import('./autoplay-basin-detection.js').AutoplayBasinDecision,
 *   snapshot?: import('./autoplay-escape-state.js').AutoplayEscapeSnapshot,
 * }}
 */
export function maybeTriggerAutoplayEscapeTrialFromQuickSkip({
  guildId,
  sessionId = null,
  currentItem = null,
  currentUrl,
  currentTitle = null,
  nowMs = Date.now(),
}) {
  const id = String(guildId);
  if (!isAutoplayEscapeEnabled()) {
    return { triggered: false, skippedByFlag: true };
  }

  if (isAutoplayEscapeCooldownActive(id)) {
    consumeAutoplayEscapeCooldownSpawn(id);
    incrementAutoplayEscapeMetric(id, 'trigger.skipped_by_cooldown');
    return { triggered: false, skippedByCooldown: true };
  }

  if (getAutoplayEscapePhase(id) != null) {
    return { triggered: false, skippedByActiveBranch: true };
  }

  const quickSkipThresholdMs = getQuickSkipThresholdMs();
  const recentQuickSkips = getSignalsByType(id, 'track_skipped', BASIN_SIGNAL_LIMIT)
    .filter((event) => isQuickSkipEvent(event, quickSkipThresholdMs));

  const decision = detectAutoplayBasin({
    nowMs,
    maxSkipsConsidered: 2,
    recentQuickSkips: [
      {
        timestamp: nowMs,
        spawnId: currentItem?.spawnId ?? null,
        queryFamily: null,
        url: currentUrl,
        title: currentTitle ?? null,
      },
      ...recentQuickSkips,
    ],
  });

  if (!decision.basin) {
    return { triggered: false, decision };
  }

  const snapshot = startAutoplayEscapeTrial(id, {
    basinKind: decision.kind,
    basinEvidence: decision.evidence,
    originSpawnId: currentItem?.spawnId ?? null,
    currentSpawnId: currentItem?.spawnId ?? null,
    contrastHint: buildAutoplayEscapeContrastHint(decision),
    sessionId: sessionId ?? null,
  });

  return {
    triggered: true,
    decision,
    snapshot,
  };
}
