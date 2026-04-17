/**
 * candidate-ranker.js
 * Финальный ranker кандидатов autoplay (этап 4).
 * Query policy остаётся в autoplay-policy.js, этот слой — только про кандидатов.
 */

function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getCandidateRankerWeights() {
  return {
    searchScoreWeight: envNumber('AUTOPLAY_RANKER_SEARCH_WEIGHT', 1, 0, 3),
    signalWeight: envNumber('AUTOPLAY_RANKER_SIGNAL_WEIGHT', 0.35, 0, 2),
    exactPairBoostWeight: envNumber('AUTOPLAY_RANKER_EXACT_PAIR_WEIGHT', 1, 0, 2),
    anchorMissPenaltyWeight: envNumber('AUTOPLAY_RANKER_ANCHOR_MISS_WEIGHT', 1, 0, 2),
    fallbackPenalty: envNumber('AUTOPLAY_RANKER_FALLBACK_PENALTY', 8, 0, 40),
  };
}

/**
 * @typedef {{
 *   rejected?: 'playability' | 'recent' | 'artist_cooldown',
 *   searchScore: number,
 *   signalScore: number,
 *   totalScore: number,
 *   varietyPenalty?: number,
 *   varietyNotes?: Record<string, unknown>,
 * }} RankerMeta
 */

/**
 * @param {{ title: string, url: string, _debug?: Record<string, unknown> }[]} items
 * @param {{
 *   isMarkedBad: (url: string) => boolean,
 *   isRecentBlocked: (url: string) => boolean,
 *   isArtistCooldownBlocked: (title: string) => boolean,
 *   variety?: (title: string) => { penalty: number, notes?: Record<string, unknown> },
 * }} guards
 */
export function rankAutoplayCandidates(items, guards) {
  const w = getCandidateRankerWeights();
  const out = [];

  for (const raw of items) {
    const item = { ...raw };
    const debug = (raw && typeof raw._debug === 'object' && raw._debug) ? raw._debug : {};

    /** @type {RankerMeta} */
    const ranker = {
      searchScore: Number(debug.searchScore ?? 0) || 0,
      signalScore: 0,
      totalScore: 0,
    };

    if (guards.isMarkedBad(item.url)) {
      ranker.rejected = 'playability';
      ranker.totalScore = -1e9;
      item._ranker = ranker;
      out.push(item);
      continue;
    }
    if (guards.isRecentBlocked(item.url)) {
      ranker.rejected = 'recent';
      ranker.totalScore = -1e8;
      item._ranker = ranker;
      out.push(item);
      continue;
    }
    if (guards.isArtistCooldownBlocked(item.title)) {
      ranker.rejected = 'artist_cooldown';
      ranker.totalScore = -1e7;
      item._ranker = ranker;
      out.push(item);
      continue;
    }

    const intentAdjust = (debug && typeof debug.intentAdjust === 'object' && debug.intentAdjust) ? debug.intentAdjust : {};
    let signal = 0;

    if (Number(intentAdjust.exactPairBoost) > 0) signal += Number(intentAdjust.exactPairBoost) * w.exactPairBoostWeight;
    if (Number(intentAdjust.anchorMissPenalty) > 0) signal -= Number(intentAdjust.anchorMissPenalty) * w.anchorMissPenaltyWeight;
    if (debug.singleTrackFallback) signal -= w.fallbackPenalty;
    if (debug.pass2Relaxed) signal -= w.fallbackPenalty;

    let varietyPenalty = 0;
    /** @type {Record<string, unknown>} */
    let varietyNotes = {};
    if (typeof guards.variety === 'function') {
      const vr = guards.variety(item.title);
      if (vr && typeof vr === 'object') {
        varietyPenalty = Number(vr.penalty) || 0;
        if (vr.notes && typeof vr.notes === 'object') varietyNotes = vr.notes;
      }
    }

    ranker.signalScore = signal;
    ranker.totalScore =
      ranker.searchScore * w.searchScoreWeight + signal * w.signalWeight - varietyPenalty;
    if (varietyPenalty) ranker.varietyPenalty = varietyPenalty;
    if (Object.keys(varietyNotes).length) ranker.varietyNotes = varietyNotes;
    item._ranker = ranker;
    out.push(item);
  }

  out.sort((a, b) => {
    const as = Number(a?._ranker?.totalScore ?? -1e12);
    const bs = Number(b?._ranker?.totalScore ?? -1e12);
    return bs - as;
  });
  return out;
}
