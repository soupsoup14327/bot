/**
 * Форматирование строк в сессионном списке музыки.
 * Отделено от playback-логики: иконки и подписи меняются здесь, не в music.js.
 */

const QUEUE_LINE_ICON = Object.freeze({
  single: '♪',
  autoplay: '∞',
});

/**
 * @param {'single' | 'autoplay'} source
 * @param {string} title
 * @param {{ addedBy?: string | null, max?: number }} [opts]
 * @returns {string}
 */
function formatQueueLine(source, title, opts = {}) {
  const max = typeof opts === 'number' ? opts : (opts.max ?? 100);
  const addedBy = typeof opts === 'number' ? null : (opts.addedBy ?? null);
  const icon = QUEUE_LINE_ICON[source] ?? '•';
  const safeTitle = String(title ?? '').trim().slice(0, max);
  const suffix = addedBy ? ` · ${String(addedBy).trim().slice(0, 32)}` : '';
  return `${icon} ${safeTitle}${suffix}`;
}

/**
 * @param {string} title
 * @param {{ addedBy?: string | null }} [opts]
 */
export function formatSingleQueueLine(title, opts = {}) {
  return formatQueueLine('single', title, { max: 200, addedBy: opts.addedBy ?? null });
}

export function formatAutoplayQueueLine(title) {
  return formatQueueLine('autoplay', title, { max: 100 });
}
