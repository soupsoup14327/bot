import {
  applyIdlePreviousStep,
  applyLivePreviousQueueStep,
  applyLivePreviousSessionStep,
  applySkipRepeatHeadShift,
  prepareLivePreviousStep,
  processIdleSkipTail,
} from './idle-navigation-apply.js';
import { getIdleNavCursor, getPastTrackUrls, getSessionPlayedWatchUrls } from './idle-navigation-state.js';
import { computeIdlePreviousStep } from './idle-navigation-state-machine.js';
import { logPreviousIdleOutcome, logSkipIdleTailOutcome } from './navigation-stop-flow.js';

/**
 * @typedef {import('./queue-manager.js').QueueOps} QueueOps
 */

/**
 * Execute idle branch of previous() as one domain transition.
 *
 * @param {{ guildId: string, queue: QueueOps, currentUrl: string }} p
 * @returns {{ ok: false } | { ok: true, inserted: boolean }}
 */
export function executeIdlePreviousMachine(p) {
  const hist = getSessionPlayedWatchUrls(p.guildId);
  if (hist.length < 1) return { ok: false };
  const rawCursor = getIdleNavCursor(p.guildId);
  const prevStep = computeIdlePreviousStep({
    hist,
    rawCursor,
    currentUrl: p.currentUrl,
  });
  if (!prevStep.ok) return { ok: false };

  const curCursor = rawCursor != null ? rawCursor : hist.length;
  const { inserted } = applyIdlePreviousStep({
    guildId: p.guildId,
    queue: p.queue,
    hist,
    prevStep,
  });
  logPreviousIdleOutcome({
    hist,
    curCursor,
    prevCursor: prevStep.prevCursor,
    prevUrl: prevStep.prevUrl,
    inserted,
  });
  return { ok: true, inserted };
}

/**
 * Execute idle-tail path of skip() as one domain transition.
 *
 * @param {{
 *   guildId: string,
 *   queue: QueueOps,
 *   tail: string,
 *   currentUrl: string,
 *   sameYoutubeContent: (a: string, b: string) => boolean,
 * }} p
 * @returns {{ outcome: 'drop', reason?: string } | { outcome: 'dedup' } | { outcome: 'enqueued' }}
 */
export function executeSkipIdleTailMachine(p) {
  const result = processIdleSkipTail({
    guildId: p.guildId,
    queue: p.queue,
    tail: p.tail,
    hist: getSessionPlayedWatchUrls(p.guildId),
    cursor: getIdleNavCursor(p.guildId),
    currentUrl: p.currentUrl,
    sameYoutubeContent: p.sameYoutubeContent,
  });
  logSkipIdleTailOutcome(p.guildId, result);
  return result;
}

/**
 * Execute live branch of previous() as one domain transition.
 *
 * @param {{
 *   guildId: string,
 *   queue: QueueOps,
 *   currentUrl: string,
 *   currentOrigItem: unknown,
 * }} p
 * @returns {{ ok: false } | { ok: true }}
 */
export function executeLivePreviousMachine(p) {
  const stack = getPastTrackUrls(p.guildId);
  const liveStep = prepareLivePreviousStep({
    guildId: p.guildId,
    stack,
    currentUrl: p.currentUrl,
  });
  if (!liveStep.ok) return { ok: false };
  applyLivePreviousQueueStep({
    guildId: p.guildId,
    queue: p.queue,
    currentUrl: p.currentUrl,
    prevUrl: liveStep.prevUrl,
    currentOrigItem: p.currentOrigItem,
  });
  applyLivePreviousSessionStep({ guildId: p.guildId, currentUrl: p.currentUrl });
  return { ok: true };
}

/**
 * Execute pre-stop domain transition for skip():
 * repeat-head handling + optional idle-tail transition.
 *
 * @param {{
 *   guildId: string,
 *   queue: QueueOps,
 *   repeatEnabled: boolean,
 *   tail: string | null | undefined,
 *   currentUrl: string,
 *   sameYoutubeContent: (a: string, b: string) => boolean,
 * }} p
 */
export function executeSkipPreStopMachine(p) {
  applySkipRepeatHeadShift({
    queue: p.queue,
    repeatEnabled: p.repeatEnabled,
  });
  if (!p.tail) return;
  executeSkipIdleTailMachine({
    guildId: p.guildId,
    queue: p.queue,
    tail: String(p.tail),
    currentUrl: p.currentUrl,
    sameYoutubeContent: p.sameYoutubeContent,
  });
}
