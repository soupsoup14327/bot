const MAX_REPLY_CHARS = 1900;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRequiredString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

/**
 * @param {{
 *   title?: string | null,
 *   artist?: string | null,
 *   sourceUrl?: string | null,
 * }} like
 * @param {number} index
 */
function formatLikeEntry(like, index) {
  const title = normalizeRequiredString(like?.title) || normalizeRequiredString(like?.sourceUrl) || 'Без названия';
  const artist = normalizeOptionalString(like?.artist);
  const sourceUrl = normalizeOptionalString(like?.sourceUrl);
  const head = `${index}. ${title}${artist ? ` — ${artist}` : ''}`;
  return sourceUrl ? `${head}\n   <${sourceUrl}>` : head;
}

/**
 * Build ephemeral reply content for `/likes`.
 *
 * The command is a read-path convenience for the user, so the output is:
 * - short enough for Discord content limits
 * - actionable (keeps source URLs when they fit)
 * - stable under truncation (`…и ещё N`)
 *
 * @param {unknown[]} likes
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function buildLikesReply(likes, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 10));
  const items = Array.isArray(likes) ? likes.slice(0, limit) : [];
  if (items.length === 0) {
    return 'В избранном пока пусто. Нажми ❤ на треке, чтобы сохранить его.';
  }

  const lines = ['**Твоё избранное:**'];
  let shown = 0;

  for (const like of items) {
    const entry = formatLikeEntry(like, shown + 1);
    const candidate = [...lines, entry].join('\n');
    if (candidate.length > MAX_REPLY_CHARS) {
      break;
    }
    lines.push(entry);
    shown += 1;
  }

  if (shown < items.length) {
    lines.push(`…и ещё ${items.length - shown}`);
  }

  return lines.join('\n');
}
