/**
 * Сериализация всех msg.edit вызовов на панель с кнопками по гильдии.
 *
 * Проблема без очереди:
 *   - syncInteractionMusicPanel (кнопки) использует interaction.message.edit() — быстро
 *   - refreshSessionPanelFromState (autoplay/idle/track change) делает 2 fetch-запроса — медленно
 *   Оба пути стартуют параллельно и последний, кто добрался до Discord API, «побеждает».
 *   Итог: панель показывает стейт из прошлого, пока актуальный стейт уже другой.
 *
 * Решение:
 *   Все вызовы на одну гильдию выстраиваются в цепочку Promise (как playback-schedule.js).
 *   Каждый editFn читает стейт В МОМЕНТ ВЫПОЛНЕНИЯ — поэтому последний всегда видит актуальный стейт.
 *
 * Инвариант: editFn должна читать playerState / транспорт / лейбл при вызове, а не захватывать заранее.
 */

/** @type {Map<string, Promise<void>>} */
const tails = new Map();

/**
 * Ставит editFn в очередь для гильдии. Функции выполняются строго последовательно.
 *
 * @param {string} guildId
 * @param {() => Promise<void>} editFn  — читает стейт при выполнении, не при постановке в очередь
 * @returns {Promise<void>}             — резолвится после выполнения editFn (всегда resolve, не reject)
 */
export function schedulePanelUpdate(guildId, editFn) {
  const id = String(guildId);
  const prev = tails.get(id) ?? Promise.resolve();
  const job = prev
    .then(editFn)
    .catch((e) => console.warn('[panel-queue] guild=%s error=%s', id, e?.message ?? e));
  tails.set(id, job);
  void job.finally(() => {
    if (tails.get(id) === job) tails.delete(id);
  });
  return job;
}
