/**
 * queue-manager.js — единственный владелец очереди воспроизведения.
 *
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md, Шаг 4.
 *
 * Контракт:
 *   - Внутри модуля живёт `Map<guildId, QueueItem[]>`. Массив очереди НЕ утекает наружу
 *     как живая ссылка — снаружи доступны только API-функции этого модуля.
 *   - Все мутации (push/shift/unshift/splice) — только через этот API.
 *   - Dedup-инварианты (sameTrackContent по providerTrackId) применяются здесь, в точке
 *     входа — модули-потребители не должны их помнить.
 *
 * Политика:
 *   - `enqueueTrack`            — безусловный push (пользовательский enqueue).
 *   - `enqueueTrackIfNotQueued` — push только если трека ещё нет в очереди (autoplay/prefetch).
 *   - `unshiftTrack`            — безусловный unshift (live-previous восстанавливает голову).
 *   - `unshiftTrackIfNewHead`   — unshift, только если голова — другой трек (navigation dedup).
 *   - `shiftIfHead`             — shift, только если голова === переданной ссылке. Используется
 *                                  когда вызывающий уже держит ref на item, который хочет убрать.
 *   - `removeItem`              — удалить item по reference (равенство по ===) откуда угодно в очереди.
 *
 * Для библиотечных функций, которые делают несколько операций подряд (apply-step'ы в
 * idle-navigation / autoplay-spawn), есть `getQueueOps(guildId)` — возвращает замороженный
 * `QueueOps`, связанный с этой гильдией. Сам массив наружу всё равно не отдаётся.
 *
 * @typedef {import('./queue-invariants.js').QueueItem} QueueItem
 *
 * @typedef {Readonly<{
 *   length:           () => number,
 *   peek:             () => QueueItem | null,
 *   shift:            () => QueueItem | null,
 *   shiftIfHead:      (item: QueueItem) => boolean,
 *   unshift:          (item: QueueItem) => void,
 *   unshiftIfNewHead: (item: QueueItem) => boolean,
 *   push:             (item: QueueItem) => void,
 *   pushIfNotQueued:  (item: QueueItem) => boolean,
 *   removeItem:       (item: QueueItem) => boolean,
 * }>} QueueOps
 */

import { sameTrackContent } from './queue-invariants.js';

/** @type {Map<string, QueueItem[]>} */
const queuesByGuild = new Map();

/**
 * Получить (или лениво создать) очередь для гильдии. Не экспортируется — массив не утекает.
 * @param {string} guildId
 * @returns {QueueItem[]}
 */
function getOrCreate(guildId) {
  const id = String(guildId);
  let q = queuesByGuild.get(id);
  if (!q) {
    q = [];
    queuesByGuild.set(id, q);
  }
  return q;
}

/**
 * Безусловный push в конец очереди (пользовательский enqueue).
 * @param {string} guildId
 * @param {QueueItem} item
 */
export function enqueueTrack(guildId, item) {
  getOrCreate(guildId).push(item);
}

/**
 * Push в конец только если такого трека ещё нет в очереди (autoplay/prefetch dedup).
 * @param {string} guildId
 * @param {QueueItem} item
 * @returns {boolean} true если добавили
 */
export function enqueueTrackIfNotQueued(guildId, item) {
  const q = getOrCreate(guildId);
  if (q.some((existing) => sameTrackContent(existing.url, item.url))) return false;
  q.push(item);
  return true;
}

/**
 * Безусловный unshift (live-previous: подкладываем текущий и предыдущий URL как head).
 * @param {string} guildId
 * @param {QueueItem} item
 */
export function unshiftTrack(guildId, item) {
  getOrCreate(guildId).unshift(item);
}

/**
 * Unshift только если голова очереди — не тот же трек (navigation dedup).
 * @param {string} guildId
 * @param {QueueItem} item
 * @returns {boolean} true если вставили
 */
export function unshiftTrackIfNewHead(guildId, item) {
  const q = getOrCreate(guildId);
  const head = q[0];
  if (head != null && sameTrackContent(head.url, item.url)) return false;
  q.unshift(item);
  return true;
}

/**
 * Вернуть head очереди не мутируя.
 * @param {string} guildId
 * @returns {QueueItem | null}
 */
export function peekNext(guildId) {
  const q = queuesByGuild.get(String(guildId));
  return q && q.length > 0 ? q[0] : null;
}

/**
 * Снять и вернуть head. null если очередь пуста.
 * @param {string} guildId
 * @returns {QueueItem | null}
 */
export function dequeueNext(guildId) {
  const q = queuesByGuild.get(String(guildId));
  if (!q || q.length === 0) return null;
  return q.shift() ?? null;
}

/**
 * Shift только если head === переданной ссылке (идентичность, не equality).
 * Используется когда вызывающий держит ref на item, который хочет убрать,
 * и хочет «безопасно» снять его только если он ещё на голове.
 *
 * @param {string} guildId
 * @param {QueueItem} item
 * @returns {boolean} true если сняли
 */
export function shiftIfHead(guildId, item) {
  const q = queuesByGuild.get(String(guildId));
  if (!q || q.length === 0) return false;
  if (q[0] !== item) return false;
  q.shift();
  return true;
}

/**
 * Удалить item по reference откуда угодно в очереди. Возвращает true если удалили.
 * @param {string} guildId
 * @param {QueueItem} item
 * @returns {boolean}
 */
export function removeItem(guildId, item) {
  const q = queuesByGuild.get(String(guildId));
  if (!q || q.length === 0) return false;
  const ix = q.indexOf(item);
  if (ix < 0) return false;
  q.splice(ix, 1);
  return true;
}

/**
 * Полная очистка очереди (stop-and-leave, teardown).
 * @param {string} guildId
 */
export function clearQueue(guildId) {
  const q = queuesByGuild.get(String(guildId));
  if (!q) return;
  q.length = 0;
}

/**
 * Длина очереди. 0 если гильдия ещё не инициализирована.
 * @param {string} guildId
 * @returns {number}
 */
export function getQueueLength(guildId) {
  return queuesByGuild.get(String(guildId))?.length ?? 0;
}

/**
 * Снимок очереди — defensive copy. Мутации снимка не затрагивают внутренний массив.
 * @param {string} guildId
 * @returns {QueueItem[]}
 */
export function getQueueSnapshot(guildId) {
  const q = queuesByGuild.get(String(guildId));
  return q ? q.slice() : [];
}

/**
 * QueueOps — связанный с конкретной гильдией набор методов.
 * Используется библиотечными функциями (idle-navigation-apply, autoplay-spawn apply-step),
 * которые делают несколько операций подряд и не должны тянуть guildId в каждую.
 *
 * Возвращаемый объект заморожен — нельзя подменить методы извне.
 *
 * @param {string} guildId
 * @returns {QueueOps}
 */
export function getQueueOps(guildId) {
  const id = String(guildId);
  return Object.freeze({
    length: () => getQueueLength(id),
    peek: () => peekNext(id),
    shift: () => dequeueNext(id),
    shiftIfHead: (item) => shiftIfHead(id, item),
    unshift: (item) => unshiftTrack(id, item),
    unshiftIfNewHead: (item) => unshiftTrackIfNewHead(id, item),
    push: (item) => enqueueTrack(id, item),
    pushIfNotQueued: (item) => enqueueTrackIfNotQueued(id, item),
    removeItem: (item) => removeItem(id, item),
  });
}

/**
 * Сбросить вообще всю карту (тесты, диагностика). Не использовать в prod-коде.
 * @internal
 */
export function __resetAllQueuesForTests() {
  queuesByGuild.clear();
}
