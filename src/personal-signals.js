/**
 * personal-signals.js
 *
 * PersonalSignal events — user-authored intents (likes и т.п.).
 *
 * В текущей сборке DB-слой отсутствует (HTTP API / persistence-пласт ещё
 * не реализованы), поэтому emitLike работает как no-op: всегда возвращает
 * { ok: true, removed: false }. Это сохраняет совместимость с
 * button-handlers.js (BTN_LIKE) и UX ("добавлено в избранное"), но
 * фактически ничего не персистит.
 *
 * Когда появится реальный backend (SQLite/Postgres), тут вернётся
 * toggle-логика с retry × 3 и обязательной доставкой (must_persist).
 */

/**
 * @param {{
 *   userId:    string,
 *   guildId:   string,
 *   url:       string,
 *   title:     string,
 *   sessionId: string | null,
 * }} _params
 * @returns {Promise<{ ok: true, removed: boolean }>}
 */
export async function emitLike(_params) {
  return { ok: true, removed: false };
}
