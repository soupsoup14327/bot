/**
 * Лог результата обработки idle-tail в skip().
 * @param {string} guildId
 * @param {{ outcome: 'drop', reason?: string } | { outcome: 'dedup' } | { outcome: 'enqueued' }} result
 */
export function logSkipIdleTailOutcome(guildId, result) {
  if (result.outcome === 'drop') {
    console.log(`[music] skip idle-tail drop guild=${guildId} reason=${result.reason}`);
    return;
  }
  if (result.outcome === 'dedup') {
    console.log(`[music] skip idle-tail dedup guild=${guildId}`);
  }
}

/**
 * Общий stop-flow для ручной навигации (previous/skip):
 * сигнал + suppress track_finished + остановка текущего потока.
 *
 * actor     — userId кто нажал skip/previous (user action)
 * triggeredBy — всегда 'navigation' для ручной навигации
 *
 * @param {{
 *   guildId: string,
 *   actor?: string | null,
 *   sessionId?: string | null,
 *   listenersCount?: number,
 *   s: any,
 *   signalName: 'track_previous' | 'track_skipped',
 *   currentPlayingUrlByGuild: Map<string, string>,
 *   currentPlayingLabelByGuild: Map<string, string>,
 *   currentQueueItemByGuild: Map<string, { source?: string, requestedBy?: string | null }>,
 *   emitSignal: (signalName: string, payload: Record<string, unknown>) => Promise<void> | void,
 *   recordPlaybackHistory?: (payload: Record<string, unknown>) => Promise<unknown> | void,
 *   sourceToTriggeredBy?: (source: string | null | undefined) => string,
 *   markSuppressTrackFinishedOnce: (guildId: string) => void,
 *   killYtdlp: (s: any) => void,
 *   stopPlayer: (guildId: string) => void,
 * }} p
 */
export function stopWithNavigationSignal(p) {
  const url = p.currentPlayingUrlByGuild.get(p.guildId) ?? '';
  const title = p.currentPlayingLabelByGuild.get(p.guildId) ?? '';
  const item = p.currentQueueItemByGuild.get(p.guildId);
  if (p.recordPlaybackHistory) {
    void p.recordPlaybackHistory({
      eventType: p.signalName === 'track_previous' ? 'previous' : 'skipped',
      guildId: p.guildId,
      sessionId: p.sessionId ?? null,
      actor: p.actor ?? null,
      requestedBy: item?.requestedBy ?? null,
      triggeredBy: p.sourceToTriggeredBy ? p.sourceToTriggeredBy(item?.source) : 'navigation',
      listenersCount: p.listenersCount ?? 0,
      url,
      title,
    });
  }
  void p.emitSignal(p.signalName, {
    guildId: p.guildId,
    sessionId: p.sessionId ?? null,
    actor: p.actor ?? null,
    requestedBy: item?.requestedBy ?? null,
    triggeredBy: 'navigation',
    listenersCount: p.listenersCount ?? 0,
    url,
    title,
  });
  p.markSuppressTrackFinishedOnce(p.guildId);
  p.killYtdlp(p.s);
  p.stopPlayer(p.guildId);
}

/**
 * Лог результата idle-ветки previous().
 * @param {{ hist: string[], curCursor: number, prevCursor: number, prevUrl: string, inserted: boolean }} p
 */
export function logPreviousIdleOutcome(p) {
  console.log(
    `[prev/idle] hist=[${p.hist.map((u) => '…' + u.slice(-8)).join(', ')}] ` +
    `cursor ${p.curCursor}->${p.prevCursor} prevUrl=…${p.prevUrl.slice(-11)}${p.inserted ? '' : ' (dedup head)'}`,
  );
}
