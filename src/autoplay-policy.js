/**
 * autoplay-policy.js
 * Политика стабилизации автоплея: анти-loop по токенам и re-rank поисковых запросов.
 * Модуль не зависит от playback/Discord и не меняет очередь напрямую.
 */

const TOKEN_STOPWORDS = new Set([
  'official', 'audio', 'video', 'lyrics', 'lyric', 'full', 'song', 'music', 'live',
  'indie', 'jpop', 'mood', 'mellow', 'melancholic', 'dark', 'acoustic', 'new', 'similar',
  'classic', 'remix', 'remastered', 'version', 'the', 'and', 'feat', 'ft',
]);

function isAutoplayPolicyEnabled() {
  const v = String(process.env.AUTOPLAY_POLICY_ENABLED ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false') return false;
  return true;
}

function getTokenLoopMin() {
  const n = Number(process.env.AUTOPLAY_TOKEN_LOOP_MIN);
  return Number.isFinite(n) && n >= 2 ? Math.min(6, Math.floor(n)) : 3;
}

function getStrongAvoidMin() {
  const n = Number(process.env.AUTOPLAY_STRONG_AVOID_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.min(4, Math.floor(n)) : 2;
}

function getQueryQuarantineWindow() {
  const n = Number(process.env.AUTOPLAY_QUERY_QUARANTINE_WINDOW);
  return Number.isFinite(n) && n >= 3 ? Math.min(16, Math.floor(n)) : 8;
}

function getQueryFamilyMaxStreak() {
  const n = Number(process.env.AUTOPLAY_QUERY_FAMILY_MAX_STREAK);
  return Number.isFinite(n) && n >= 2 ? Math.min(6, Math.floor(n)) : 3;
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !TOKEN_STOPWORDS.has(w));
}

/**
 * @param {string[]} lines
 * @returns {{ token: string, count: number } | null}
 */
function detectDominantToken(lines) {
  const freq = new Map();
  for (const line of lines) {
    const uniq = new Set(tokenize(line));
    for (const t of uniq) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  if (freq.size === 0) return null;
  const [token, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!token || !count || count < getTokenLoopMin()) return null;
  return { token, count };
}

/**
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function collectAvoidTokens(lines) {
  const out = new Set();
  for (const line of lines) {
    for (const t of tokenize(line)) out.add(t);
  }
  return out;
}

/**
 * Tokens that appear repeatedly in quick-skipped titles.
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function collectStrongAvoidTokens(lines) {
  const min = getStrongAvoidMin();
  const freq = new Map();
  for (const line of lines) {
    const uniq = new Set(tokenize(line));
    for (const t of uniq) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const out = new Set();
  for (const [token, count] of freq.entries()) {
    if (count >= min) out.add(token);
  }
  return out;
}

/**
 * @param {string} query
 * @param {string} token
 * @returns {string}
 */
function removeDominantToken(query, token) {
  if (!token) return String(query).trim();
  const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig');
  return String(query).replace(re, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} query
 * @returns {string | null}
 */
function queryFamilyToken(query) {
  const tokens = tokenize(query);
  return tokens[0] ?? null;
}

/**
 * Re-rank queries so loop-driving token families go lower priority.
 *
 * @param {{ queries: string[], recentTitles?: string[], negativeTitles?: string[], usedQueries?: string[], identityAnchor?: string | null }} params
 * @returns {{ queries: string[], meta: Record<string, unknown> }}
 */
export function applyAutoplayQueryPolicy({
  queries,
  recentTitles = [],
  negativeTitles = [],
  usedQueries = [],
  identityAnchor = null,
}) {
  const cleanQueries = (Array.isArray(queries) ? queries : []).map((q) => String(q).trim()).filter(Boolean);
  if (!isAutoplayPolicyEnabled() || cleanQueries.length <= 1) {
    return { queries: cleanQueries, meta: { enabled: isAutoplayPolicyEnabled(), reordered: false } };
  }

  const dominant = detectDominantToken(recentTitles.slice(-8));
  const avoidTokens = collectAvoidTokens(negativeTitles.slice(0, 8));
  const strongAvoidTokens = collectStrongAvoidTokens(negativeTitles.slice(0, 8));
  const recentFamilies = usedQueries
    .slice(-getQueryQuarantineWindow())
    .map(queryFamilyToken)
    .filter(Boolean);
  let quarantineToken = null;
  if (recentFamilies.length) {
    const tail = recentFamilies[recentFamilies.length - 1];
    let streak = 1;
    for (let i = recentFamilies.length - 2; i >= 0; i--) {
      if (recentFamilies[i] !== tail) break;
      streak++;
    }
    if (streak >= getQueryFamilyMaxStreak()) quarantineToken = tail;
  }
  const recentUsed = new Set(
    usedQueries.slice(-10).map((q) => String(q).toLowerCase().replace(/\s+/g, ' ').trim()),
  );
  const identityTokens = tokenize(String(identityAnchor ?? '')).slice(0, 3);

  const scored = cleanQueries.map((query, idx) => {
    const tokens = new Set(tokenize(query));
    let score = 100 - idx * 5;
    let hitDominant = false;
    let hitAvoid = false;
    let hitStrongAvoid = false;

    if (dominant?.token && tokens.has(dominant.token)) {
      score -= 35;
      hitDominant = true;
    }
    for (const t of tokens) {
      if (avoidTokens.has(t)) {
        score -= 25;
        hitAvoid = true;
      }
    }
    for (const t of tokens) {
      if (strongAvoidTokens.has(t)) {
        score -= 40;
        hitStrongAvoid = true;
      }
    }
    if (quarantineToken && tokens.has(quarantineToken)) {
      score -= 65;
    }
    if (identityTokens.length > 0) {
      const hitIdentity = identityTokens.some((t) => tokens.has(t));
      if (!hitIdentity) score -= 55;
      else score += 18;
    }
    const norm = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (recentUsed.has(norm)) score -= 20;

    return { query, score, hitDominant, hitAvoid, hitStrongAvoid };
  });

  scored.sort((a, b) => b.score - a.score);
  let reordered = scored.map((s) => s.query);
  if (
    dominant?.token &&
    reordered.length > 0 &&
    reordered.every((q) => tokenize(q).includes(dominant.token))
  ) {
    const diversified = removeDominantToken(reordered[0], dominant.token);
    if (diversified && diversified.length >= 8) {
      reordered = [...reordered.slice(1), diversified];
    }
  }
  if (
    quarantineToken &&
    reordered.length > 0 &&
    reordered.every((q) => tokenize(q).includes(quarantineToken))
  ) {
    const diversified = removeDominantToken(reordered[0], quarantineToken);
    if (diversified && diversified.length >= 8) {
      reordered = [...reordered.slice(1), diversified];
    }
  }
  const changed = reordered.join(' || ') !== cleanQueries.join(' || ');

  return {
    queries: reordered,
    meta: {
      enabled: true,
      reordered: changed,
      dominantToken: dominant?.token ?? null,
      dominantCount: dominant?.count ?? 0,
      avoidTokenCount: avoidTokens.size,
      strongAvoidTokenCount: strongAvoidTokens.size,
      identityAnchor: identityTokens.join(' ') || null,
      quarantineToken,
      recentFamilyWindow: recentFamilies.slice(-getQueryQuarantineWindow()),
      familyMaxStreak: getQueryFamilyMaxStreak(),
      hitDominantCount: scored.filter((s) => s.hitDominant).length,
      hitAvoidCount: scored.filter((s) => s.hitAvoid).length,
      hitStrongAvoidCount: scored.filter((s) => s.hitStrongAvoid).length,
    },
  };
}

