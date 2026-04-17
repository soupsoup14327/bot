/**
 * Apply-шаги для idle/live навигации и skip pre-stop.
 *
 * Все мутации очереди проходят через `QueueOps` (см. queue-manager.js) — не через
 * прямой доступ к массиву. Это гарантирует, что ни один шаг рефакторинга не
 * «протащит» живую ссылку на внутренний массив очереди.
 *
 * @typedef {import('./queue-manager.js').QueueOps} QueueOps
 */

import {
  deleteIdleBackForwardTail,
  deleteIdleNavCursor,
  getSessionPlayedWatchUrls,
  markSuppressHistoryPush,
  persistPastTrackUrls,
  setIdleBackForwardTail,
  setIdleNavCursor,
  setPastTrackUrls,
  setSessionPlayedWatchUrls,
} from './idle-navigation-state.js';
import { resolveIdleSkipTailStep } from './idle-navigation-state-machine.js';

/**
 * Применяет idle-prev переход к navigation state и очереди.
 * Поведение 1:1 с логикой в music.js (без policy изменений).
 *
 * @param {{ guildId: string, queue: QueueOps, hist: string[], prevStep: { prevCursor: number, prevUrl: string, nextTail: string } }} p
 * @returns {{ inserted: boolean }}
 */
export function applyIdlePreviousStep(p) {
  setIdleNavCursor(p.guildId, p.prevStep.prevCursor);
  setIdleBackForwardTail(p.guildId, p.prevStep.nextTail);
  setPastTrackUrls(p.guildId, p.hist.slice(0, p.prevStep.prevCursor));
  const inserted = p.queue.unshiftIfNewHead({ url: p.prevStep.prevUrl, source: 'navigation' });
  markSuppressHistoryPush(p.guildId);
  return { inserted };
}

/**
 * Применяет idle-skip-tail решение к navigation state и очереди.
 * Возвращает итоговое действие для логирования в orchestrator.
 *
 * @param {{ guildId: string, queue: QueueOps, tail: string, tailStep: { action: 'drop' | 'enqueue', reason?: string, nextCursor?: number, nextTail?: string } }} p
 * @returns {{ action: 'drop', reason?: string } | { action: 'enqueue', inserted: boolean }}
 */
export function applyIdleSkipTailStep(p) {
  if (p.tailStep.action === 'drop') {
    deleteIdleBackForwardTail(p.guildId);
    if (p.tailStep.reason === 'cursor_exhausted') {
      deleteIdleNavCursor(p.guildId);
    }
    return { action: 'drop', reason: p.tailStep.reason };
  }
  if (p.tailStep.nextCursor != null) setIdleNavCursor(p.guildId, p.tailStep.nextCursor);
  if (p.tailStep.nextTail) setIdleBackForwardTail(p.guildId, p.tailStep.nextTail);
  markSuppressHistoryPush(p.guildId);
  const inserted = p.queue.unshiftIfNewHead({ url: p.tail, source: 'navigation' });
  return { action: 'enqueue', inserted };
}

/**
 * Применяет live-ветку previous: перестройка queue head + suppress history push.
 * Логика 1:1 с текущим поведением: снять current (если на голове), затем
 * unshift current и prev, чтобы next playback стартовал с prev.
 *
 * @param {{ guildId: string, queue: QueueOps, currentUrl: string, prevUrl: string, currentOrigItem: unknown }} p
 */
export function applyLivePreviousQueueStep(p) {
  if (p.currentOrigItem) {
    // shiftIfHead — no-op если на голове другой item; сохраняет identity-check из legacy.
    p.queue.shiftIfHead(/** @type {import('./queue-invariants.js').QueueItem} */ (p.currentOrigItem));
  }
  p.queue.unshift({ url: p.currentUrl, source: 'navigation' });
  p.queue.unshift({ url: p.prevUrl, source: 'navigation' });
  markSuppressHistoryPush(p.guildId);
}

/**
 * Применяет session-side эффекты live-ветки previous:
 * - убирает текущий URL из конца session history (если там он).
 *
 * @param {{ guildId: string, currentUrl: string }} p
 */
export function applyLivePreviousSessionStep(p) {
  const sess = getSessionPlayedWatchUrls(p.guildId);
  if (sess.length > 0 && sess[sess.length - 1] === p.currentUrl) {
    sess.pop();
    setSessionPlayedWatchUrls(p.guildId, sess);
  }
}

/**
 * Поведение previous() при repeat+active:
 * не идём назад, а перезапускаем текущий трек.
 * @param {{ guildId: string, s: any, killYtdlp: (s: any) => void, stopPlayer: (guildId: string) => void }} p
 */
export function applyRepeatPreviousRestart(p) {
  markSuppressHistoryPush(p.guildId);
  p.killYtdlp(p.s);
  p.stopPlayer(p.guildId);
}

/**
 * Подготавливает live-ветку previous: сдвиг стека previous + очистка idle-tail.
 * @param {{ guildId: string, stack: string[], currentUrl: string }} p
 * @returns {{ ok: false } | { ok: true, prevUrl: string }}
 */
export function prepareLivePreviousStep(p) {
  deleteIdleBackForwardTail(p.guildId);
  const prevUrl = p.stack.pop();
  if (!prevUrl) return { ok: false };
  if (prevUrl === p.currentUrl) {
    p.stack.push(prevUrl);
    persistPastTrackUrls(p.guildId, p.stack);
    return { ok: false };
  }
  persistPastTrackUrls(p.guildId, p.stack);
  return { ok: true, prevUrl };
}

/**
 * Полный idle-tail проход для skip(): resolve + apply.
 * @param {{
 *   guildId: string,
 *   queue: QueueOps,
 *   tail: string,
 *   hist: string[],
 *   cursor: number | undefined,
 *   currentUrl: string,
 *   sameYoutubeContent: (a: string, b: string) => boolean,
 * }} p
 * @returns {{ outcome: 'drop', reason?: string } | { outcome: 'dedup' } | { outcome: 'enqueued' }}
 */
export function processIdleSkipTail(p) {
  const tailStep = resolveIdleSkipTailStep({
    tail: String(p.tail),
    hist: p.hist,
    cursor: p.cursor,
    currentUrl: p.currentUrl,
    sameYoutubeContent: p.sameYoutubeContent,
  });
  const applied = applyIdleSkipTailStep({
    guildId: p.guildId,
    queue: p.queue,
    tail: String(p.tail),
    tailStep,
  });
  if (applied.action === 'drop') return { outcome: 'drop', reason: applied.reason };
  if (!applied.inserted) return { outcome: 'dedup' };
  return { outcome: 'enqueued' };
}

/**
 * Pre-step для skip(): при repeat включённом удаляет текущий head из queue,
 * чтобы после stop() Idle не запустил тот же трек снова.
 *
 * @param {{ queue: QueueOps, repeatEnabled: boolean }} p
 * @returns {boolean} true если head был удалён
 */
export function applySkipRepeatHeadShift(p) {
  if (!p.repeatEnabled) return false;
  if (p.queue.length() === 0) return false;
  p.queue.shift();
  return true;
}
