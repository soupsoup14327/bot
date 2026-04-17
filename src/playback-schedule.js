/**
 * Единая точка планирования runPlayNext: сериализация по гильдии через цепочку Promise.
 * Не импортирует music.js — получает runPlayNext снаружи (избегаем циклических зависимостей).
 *
 * ВАЖНО: нельзя делать `return schedulePlayNext()` изнутри async runPlayNext и ждать —
 * см. deadlock в JOURNAL (void schedulePlayNext после await spawn автоплея).
 */

/**
 * @param {(guildId: string) => Promise<void>} runPlayNext
 */
export function createSchedulePlayNext(runPlayNext) {
  /** @type {Map<string, Promise<void>>} */
  const playNextChainTail = new Map();

  /**
   * @param {string} guildId
   * @param {string} [reason] — для DEBUG_PLAYBACK=1
   * @returns {Promise<void>}
   */
  function schedulePlayNext(guildId, reason = '') {
    const id = String(guildId);
    if (process.env.DEBUG_PLAYBACK === '1' && reason) {
      console.log(`[playback-schedule] guild=${id} reason=${reason}`);
    }
    const prev = playNextChainTail.get(id) ?? Promise.resolve();
    const job = prev.then(() => runPlayNext(id));
    playNextChainTail.set(id, job);
    void job.finally(() => {
      if (playNextChainTail.get(id) === job) {
        playNextChainTail.delete(id);
      }
    });
    return job;
  }

  return schedulePlayNext;
}
