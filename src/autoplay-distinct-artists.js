function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function isDistinctArtistShortlistEnabled() {
  const value = String(process.env.AUTOPLAY_DISTINCT_ARTIST_SHORTLIST_ENABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function getDistinctArtistShortlistMinCandidates() {
  return envNumber('AUTOPLAY_DISTINCT_ARTIST_MIN_CANDIDATES', 4, 1, 20);
}

export function getDistinctArtistFallbackMaxPerArtist() {
  return envNumber('AUTOPLAY_DISTINCT_ARTIST_MAX_PER_ARTIST_FALLBACK', 2, 1, 4);
}

/**
 * Stable first-wins distinct pass.
 * Unknown artists (`null`) stay untouched and are never deduplicated together.
 *
 * @template T
 * @param {T[]} items
 * @param {{
 *   extractArtist: (item: T) => string | null,
 *   maxPerArtist?: number,
 * }} opts
 * @returns {T[]}
 */
export function selectDistinctByArtist(items, opts) {
  const maxPerArtist = Math.max(1, Number(opts?.maxPerArtist) || 1);
  const extractArtist = typeof opts?.extractArtist === 'function'
    ? opts.extractArtist
    : (() => null);

  const out = [];
  const seen = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const artist = extractArtist(item);
    if (!artist) {
      out.push(item);
      continue;
    }
    const count = seen.get(artist) ?? 0;
    if (count >= maxPerArtist) continue;
    seen.set(artist, count + 1);
    out.push(item);
  }

  return out;
}

/**
 * Distinct-by-artist shortlist before ranker scoring.
 * First pass keeps at most one item per known artist. If the resulting shortlist
 * is too small, a relaxed second pass allows a small number of repeats.
 *
 * @template {{ title?: string | null, channel?: { name?: string | null } | null }} T
 * @param {T[]} items
 * @param {{
 *   extractLeadArtistToken: (title: string, meta?: { channelName?: string | null } | null) => string | null,
 *   enabled?: boolean,
 *   minCandidates?: number,
 *   fallbackMaxPerArtist?: number,
 * }} opts
 * @returns {{
 *   items: T[],
 *   meta: {
 *     enabled: boolean,
 *     before: number,
 *     after: number,
 *     strategy: 'disabled' | 'distinct_1' | 'distinct_relaxed',
 *     minCandidates: number,
 *     fallbackMaxPerArtist: number,
 *   },
 * }}
 */
export function buildDistinctArtistShortlist(items, opts) {
  const source = Array.isArray(items) ? [...items] : [];
  const enabled = opts?.enabled ?? isDistinctArtistShortlistEnabled();
  const minCandidates = opts?.minCandidates ?? getDistinctArtistShortlistMinCandidates();
  const fallbackMaxPerArtist = opts?.fallbackMaxPerArtist ?? getDistinctArtistFallbackMaxPerArtist();
  const extractLeadArtistToken = typeof opts?.extractLeadArtistToken === 'function'
    ? opts.extractLeadArtistToken
    : (() => null);

  if (!enabled || source.length <= 1) {
    return {
      items: source,
      meta: {
        enabled: Boolean(enabled),
        before: source.length,
        after: source.length,
        strategy: 'disabled',
        minCandidates,
        fallbackMaxPerArtist,
      },
    };
  }

  const extractArtist = (item) => extractLeadArtistToken(
    String(item?.title ?? ''),
    { channelName: item?.channel?.name ?? null },
  );

  const primary = selectDistinctByArtist(source, {
    extractArtist,
    maxPerArtist: 1,
  });

  if (primary.length >= minCandidates || fallbackMaxPerArtist <= 1) {
    return {
      items: primary,
      meta: {
        enabled: true,
        before: source.length,
        after: primary.length,
        strategy: 'distinct_1',
        minCandidates,
        fallbackMaxPerArtist,
      },
    };
  }

  const relaxed = selectDistinctByArtist(source, {
    extractArtist,
    maxPerArtist: fallbackMaxPerArtist,
  });

  return {
    items: relaxed,
    meta: {
      enabled: true,
      before: source.length,
      after: relaxed.length,
      strategy: 'distinct_relaxed',
      minCandidates,
      fallbackMaxPerArtist,
    },
  };
}
