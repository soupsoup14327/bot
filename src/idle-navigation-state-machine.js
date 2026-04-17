/**
 * State-machine helpers for idle navigation.
 * Pure transition logic only (no side effects, no storage access).
 */

/**
 * Рассчитать переход для ⏮ в idle-навигации.
 * Логика 1:1 с текущим поведением: стартовая позиция = hist.length.
 *
 * @param {{ hist: string[], rawCursor: number | undefined, currentUrl: string }} p
 * @returns {{ ok: false } | { ok: true, prevCursor: number, prevUrl: string, nextTail: string }}
 */
export function computeIdlePreviousStep(p) {
  const curCursor = p.rawCursor != null ? p.rawCursor : p.hist.length;
  const prevCursor = curCursor - 1;
  if (prevCursor < 0) return { ok: false };
  const prevUrl = p.hist[prevCursor];
  if (!prevUrl) return { ok: false };
  return {
    ok: true,
    prevCursor,
    prevUrl,
    nextTail: p.hist[curCursor] ?? p.currentUrl,
  };
}

/**
 * Обновить idle tail/cursor при ⏭ и вернуть решение:
 * - drop: tail нельзя использовать (tail_invalid/self_loop_same_as_current/cursor_exhausted)
 * - enqueue: tail валиден, его можно подставлять в очередь navigation head
 *
 * @param {{
 *   tail: string,
 *   hist: string[],
 *   cursor: number | undefined,
 *   currentUrl: string,
 *   sameYoutubeContent: (a: string, b: string) => boolean,
 * }} p
 * @returns {{
 *   action: 'drop' | 'enqueue',
 *   reason?: 'tail_invalid' | 'self_loop_same_as_current' | 'cursor_exhausted',
 *   nextCursor?: number,
 *   nextTail?: string,
 * }}
 */
export function resolveIdleSkipTailStep(p) {
  if (!String(p.tail).trim()) {
    return { action: 'drop', reason: 'tail_invalid' };
  }
  if (p.currentUrl && p.sameYoutubeContent(String(p.tail), p.currentUrl)) {
    return { action: 'drop', reason: 'self_loop_same_as_current' };
  }
  if (p.cursor == null) {
    return { action: 'drop', reason: 'cursor_exhausted' };
  }
  const nextCursor = p.cursor + 1;
  if (nextCursor < p.hist.length) {
    return {
      action: 'enqueue',
      nextCursor,
      nextTail: p.hist[nextCursor],
    };
  }
  return { action: 'drop', reason: 'cursor_exhausted' };
}

/**
 * Классификация runtime-режима для previous().
 *
 * @param {{ status: string, playing: boolean, queueLength: number }} p
 * @returns {{ playingOrPaused: boolean, endedAll: boolean }}
 */
export function classifyPreviousRuntimeMode(p) {
  const playingOrPaused =
    p.status === 'playing' ||
    p.status === 'paused' ||
    p.status === 'autopaused' ||
    p.status === 'buffering';
  const endedAll =
    p.status === 'idle' && !p.playing && p.queueLength === 0;
  return { playingOrPaused, endedAll };
}

/**
 * Выбрать ветку previous() на основе runtime mode и состояния стека.
 *
 * @param {{ endedAll: boolean, playingOrPaused: boolean, stackLength: number }} p
 * @returns {'idle' | 'live' | 'none'}
 */
export function selectPreviousBranch(p) {
  if (p.endedAll) return 'idle';
  if (!p.playingOrPaused) return 'none';
  if (p.stackLength === 0) return 'none';
  return 'live';
}
