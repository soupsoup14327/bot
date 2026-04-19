/**
 * Lead-artist extraction shared by autoplay variety / cooldown logic.
 * Keep one source of truth here so candidate filters and session-level
 * heuristics read the same artist token.
 */

const JP_OPENING_BRACKETS = /[\u300c\u300e\u3010\[]/;
const TITLE_SEPARATORS = /\s(?:[-\u2013\u2014:|/])\s/;
const FEATURE_SPLIT = /\s+(?:feat\.?|ft\.?|with)\b/i;
const FEATURE_TAIL_RE = /\s+(?:feat\.?|ft\.?|with)\b.*$/i;
const COLLAB_TAIL_RE = /\s+(?:x|×)\s+.*$/i;
const TOPIC_CHANNEL_RE = /^(.{1,80}?)\s+-\s+topic$/i;
const NOISE_PREFIX_RE = /^(?:\[[^\]]*\]|\([^)]+\)|\u3010[^\u3011]*\u3011)\s*/gu;
const NOISE_SUFFIX_RE =
  /\s+(?:official(?:\s+(?:music\s+)?)?(?:video|audio)|music\s+video|official|audio|lyric(?:s)?\s+video|lyrics?|the\s+first\s+take|full\s+ver(?:sion)?\.?|full\s+version|dolby\s+atmos(?:\s+sound)?|tv\s+size|op(?:ening)?|ed(?:ending)?|mv)\b.*$/i;
const LABELISH_RE = /\b(?:entertainment|records?|label|channel|official|music(?:\s+entertainment)?|japan)\b/i;
const CLEARLY_NOT_ARTIST_RE =
  /\b(?:official(?:\s+(?:music\s+)?)?(?:video|audio)|official|music\s+video|lyric(?:s)?|the\s+first\s+take|full\s+ver(?:sion)?\.?|dolby\s+atmos|tv\s+size|opening|ending|op|ed|soundtrack|ost|topic|various\s+artists)\b/i;
const TRACKISH_TOKEN_RE = /[!?]{2,}|\b(?:the\s+first\s+take|lyrics?|official|music\s+video|audio)\b/i;

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/[\u2000-\u200b\u3000]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
function normalizeArtistCandidate(raw) {
  let value = normalizeWhitespace(raw);
  if (!value) return null;

  value = value.replace(NOISE_PREFIX_RE, '').trim();
  value = value.replace(NOISE_SUFFIX_RE, '').trim();
  value = value.replace(FEATURE_TAIL_RE, '').trim();
  value = value.replace(COLLAB_TAIL_RE, '').trim();
  value = value.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, '').trim();
  value = value.replace(/^[\[(\u300c\u300e\u3010]+|[\])\u300d\u300f\u3011]+$/gu, '').trim();
  if (!value) return null;

  const hasLetters = /\p{L}/u.test(value);
  if (!hasLetters) return null;
  if (value.length < 1 || value.length > 80) return null;
  if (CLEARLY_NOT_ARTIST_RE.test(value)) return null;
  if (LABELISH_RE.test(value) && value.split(/\s+/).length >= 3) return null;

  return value.toLowerCase();
}

/**
 * @param {string} title
 * @returns {string | null}
 */
function extractArtistFromTitle(title) {
  const value = normalizeWhitespace(title);
  if (!value) return null;

  const jpBracketIndex = value.search(JP_OPENING_BRACKETS);
  if (jpBracketIndex > 1) {
    const fromBracket = normalizeArtistCandidate(value.slice(0, jpBracketIndex));
    if (fromBracket) return fromBracket;
  }

  const separatorMatch = value.match(/^(.*?)\s([-\u2013\u2014:|/])\s(.+)$/);
  if (separatorMatch?.[1]) {
    const [, leftSide, separator, rightSide] = separatorMatch;
    const suspiciousSlash =
      separator === '/' &&
      (TRACKISH_TOKEN_RE.test(leftSide) || TRACKISH_TOKEN_RE.test(rightSide));
    if (suspiciousSlash) return null;
    const fromSeparator = normalizeArtistCandidate(leftSide);
    if (fromSeparator) return fromSeparator;
  }

  const featureMatch = value.match(FEATURE_SPLIT);
  if (featureMatch?.index && featureMatch.index > 1) {
    const fromFeature = normalizeArtistCandidate(value.slice(0, featureMatch.index));
    if (fromFeature) return fromFeature;
  }

  return normalizeArtistCandidate(value);
}

/**
 * Cheap structured fallback from current yt-dlp/play-dl payloads.
 * We only trust explicit Topic channels to avoid mistaking labels or
 * publisher channels for the lead artist.
 *
 * @param {string | null | undefined} channelName
 * @returns {string | null}
 */
function extractArtistFromTopicChannelName(channelName) {
  const value = normalizeWhitespace(channelName);
  if (!value) return null;
  const match = value.match(TOPIC_CHANNEL_RE);
  if (!match) return null;
  return normalizeArtistCandidate(match[1]);
}

/**
 * @param {string | { title?: string | null, channelName?: string | null }} input
 * @param {{ channelName?: string | null } | null} [meta]
 * @returns {string | null}
 */
export function extractLeadArtistToken(input, meta = null) {
  const title = typeof input === 'string' ? input : input?.title;
  const channelName =
    typeof input === 'string'
      ? meta?.channelName
      : (input?.channelName ?? meta?.channelName);

  return extractArtistFromTitle(title) ?? extractArtistFromTopicChannelName(channelName);
}

/**
 * Backward-compatible title-first helper used by current call-sites.
 *
 * @param {string} title
 * @param {{ channelName?: string | null } | null} [meta]
 * @returns {string | null}
 */
export function extractLeadArtistTokenFromTitle(title, meta = null) {
  return extractLeadArtistToken(title, meta);
}

/**
 * Dominant artist in recent tracks (used by pivot / cooldown).
 *
 * @param {string[]} titles
 * @returns {{ artist: string, count: number } | null}
 */
export function detectDominantArtist(titles) {
  const artists = titles.map((title) => extractLeadArtistTokenFromTitle(title)).filter(Boolean);
  if (artists.length < 3) return null;
  const freq = new Map();
  for (const artist of artists) freq.set(artist, (freq.get(artist) ?? 0) + 1);
  const [artist, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!artist || !count || count < 3) return null;
  return { artist, count };
}
