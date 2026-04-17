/**
 * Разбор «ведущего артиста» из заголовка трека — общий для `music.js` и `autoplay-variety.js`
 * (этап 11: без дублирования regex).
 */

/**
 * @param {string} title
 * @returns {string}
 */
export function extractLeadArtistTokenFromTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  const m = t.match(/^([^–\-|()\[\]]{2,40}?)(?:\s*[-–|]|\s+feat\.|\s+ft\.)/i);
  return m ? m[1].toLowerCase().trim() : '';
}

/**
 * Доминантный артист в последних треках (для pivot / cooldown).
 * @param {string[]} titles
 * @returns {{ artist: string, count: number } | null}
 */
export function detectDominantArtist(titles) {
  const artists = titles.map(extractLeadArtistTokenFromTitle).filter(Boolean);
  if (artists.length < 3) return null;
  const freq = new Map();
  for (const a of artists) freq.set(a, (freq.get(a) ?? 0) + 1);
  const [artist, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!artist || !count || count < 3) return null;
  return { artist, count };
}
