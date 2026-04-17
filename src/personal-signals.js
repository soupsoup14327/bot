/**
 * personal-signals.js — STUB (feature unavailable).
 *
 * Настоящая персистентность лайков появится вместе с БД приложения
 * (пользовательская БД — отдельный будущий модуль `src/db/*`). До тех пор
 * `emitLike` возвращает `{ ok: false, reason: 'not_implemented' }`, а
 * кнопка ❤ в UI показывает соответствующее сообщение об ошибке.
 *
 * Почему stub, а не локальный файл:
 *   - чтобы не плодить временный UX (pseudo-успех, затем миграция из
 *     файла в БД);
 *   - чтобы разница «лайки работают / лайки НЕ работают» была явной в
 *     логах и интерфейсе.
 *
 * Контракт — стабильный: будущая реализация вернёт `{ ok: true, removed }`,
 * вызывающий код уже обрабатывает оба варианта через поле `ok`.
 */

/**
 * @returns {Promise<{ ok: false, reason: 'not_implemented' }>}
 */
export async function emitLike() {
  return { ok: false, reason: 'not_implemented' };
}

/**
 * @returns {Promise<Array<never>>}
 */
export async function listLikes() {
  return [];
}
