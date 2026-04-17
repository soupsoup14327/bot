/**
 * groq.js — Groq API: autoplay query generation + chat.
 * Docs: https://console.groq.com/docs/openai
 *
 * All music-facing prompts are in English so the LLM can better reason
 * about style axes and artist relationships (Llama performs stronger
 * in English for music metadata).
 *
 * Env vars:
 *   GROQ_API_KEY               — required (console.groq.com)
 *   GROQ_MODEL                 — autoplay model  (default: llama-3.1-8b-instant)
 *   GROQ_CHAT_MODEL            — chat model      (default: llama-3.3-70b-versatile)
 *   GROQ_TIMEOUT_MS            — request timeout (default: 8000)
 *   GROQ_AUTOPLAY_TEMPERATURE  — 0–2, lower = more focused  (default: 0.55)
 *
 * METRICS:DEBUG — autoplayGroqDebug(...) → stdout при AUTOPLAY_DEBUG=1 (формы промптов автоплея).
 */

import { autoplayGroqDebug } from './autoplay-telemetry.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// ─── Shared negative content list (used in prompts and as safety guard) ───────

/**
 * Content categories that reliably produce non-music results on YouTube.
 * Split into STRONG (always reject) and SOFT (penalise in scoring) tiers.
 */
const NEGATIVE_CONTENT_TYPES = `\
- AMV, anime mix, anime fights, best fights
- mix, mixtape, megamix, mega mix, nightcore mix, phonk mix
- compilation, non-stop, marathon, 24/7, nonstop, full album
- top 10, best of, ranking, tier list
- tutorial, how to make, beat tutorial, teaches you
- teaser, trailer, preview, sneak peek, PV (promotional video)
- reaction, review, documentary, explained, lore video
- gameplay, walkthrough, speedrun
- топ, микс, реакция, обзор, туториал, тизер, трейлер, подборка, нарезка`;

// ─── Safety check on generated queries ────────────────────────────────────────

/**
 * Reject queries that almost certainly lead to AMV/top-lists/tutorials on YouTube.
 * @param {string} q
 */
function assertGroqSearchQueryOk(q) {
  const s = String(q);
  const bad =
    /\bamv\b|「\s*amv|anime\s+mix|anime\s+fights|best\s+anime\s+fights/i.test(s) ||
    /\bmix\b|микс/i.test(s) ||
    /tutorial|teaches\s+you|how\s+to\s+make|make\s+a\s+beat|beat\s+in\s+\d/i.test(s) ||
    /\b(top|топ)\s*\d+/i.test(s) ||
    /\b(best|лучш(ие|ий))\s+(anime\s+)?(opening|опенинг|fight)/i.test(s) ||
    /\b(teaser|trailer|preview|sneak\s*peek)\b/i.test(s) ||
    /тизер|трейлер|превью/i.test(s) ||
    /\b(compilation|сборник|подборка|нарезка)\b/i.test(s) ||
    /\b(реакция|реакт|обзор|туториал)\b/i.test(s);
  if (bad) throw new Error('Groq query failed safety check');
}

// ─── Shared context builder for autoplay functions ───────────────────────────

/** Включить блок «ранние скипы» в промпт автоплея (по умолчанию да; `0` / `false` — выкл). */
function isAutoplayNegativeGroqEnabled() {
  const v = process.env.GROQ_AUTOPLAY_NEGATIVE_CONTEXT;
  if (v === '0' || v === 'false') return false;
  return true;
}

function getAutoplayNegativeTitleLimit() {
  const n = Number(process.env.GROQ_AUTOPLAY_NEGATIVE_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.min(8, Math.floor(n)) : 4;
}

/**
 * Builds the context blocks shared by groqNextTrackQuery and groqNextTrackStruct.
 * Extracted to avoid duplicating ~60 lines of block-building logic.
 * @private
 */
function buildAutoplayContextBlocks(
  seedQuery,
  playedTitles,
  { positiveContext = [], usedQueries = [], pivotToAnchor = false, negativeContext = [] } = {},
) {
  const recentTitles = playedTitles.slice(-10);
  const lastFew      = recentTitles.slice(-5);

  const historyBlock = recentTitles.length
    ? `Session history (played tracks, oldest→newest):\n${recentTitles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}\n`
    : '';

  const listenedBlock = positiveContext.length
    ? `\nCompleted tracks — user listened to the end (MEDIUM priority, interest signal):\n${positiveContext.slice(0, 5).map((t) => `  • ${t}`).join('\n')}\n`
    : '';

  const usedBlock = usedQueries.length
    ? `\nDescriptions already used this session (avoid repeating or closely matching):\n${usedQueries.slice(-8).map((q) => `  • ${q}`).join('\n')}\n`
    : '';

  const negLimit = getAutoplayNegativeTitleLimit();
  const negTitles = (Array.isArray(negativeContext) ? negativeContext : [])
    .filter(Boolean)
    .slice(0, negLimit);
  const negativeBlock =
    isAutoplayNegativeGroqEnabled() && negTitles.length
      ? `\nEarly-skipped tracks — user skipped within the first seconds (avoid similar vibe, artist cluster, or energy; weaker than completed tracks):\n${negTitles.map((t) => `  • ${t}`).join('\n')}\n`
      : '';

  const dominantArtistNote = (() => {
    if (lastFew.length < 3) return '';
    const tokens = lastFew.map((t) => t.split(/[\s\-–—|]/)[0].toLowerCase().trim());
    const freq = new Map();
    for (const w of tokens) freq.set(w, (freq.get(w) ?? 0) + 1);
    const [top] = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    if (top && top[1] >= 3) {
      return `\nNote: recent tracks likely share the same lead artist; consider a different artist within the same genre.\n`;
    }
    return '';
  })();

  const focusBlock = pivotToAnchor
    ? [
        `\n── Session context (pivot) ──`,
        seedQuery,
        `Note: recent picks were too repetitive. This turn follows the priority order below`,
        `(anchor leads). Prefer abstract descriptor axes over specific artist names.`,
        `Diversity requirement: your JSON axes must describe a direction that yields a **different lead performer** than recent session titles — not another track by the same dominant artist.`,
      ].join('\n')
    : [
        `\n── Session context ──`,
        seedQuery,
        `Where the two themes diverge, look for something that bridges them by descriptor axes`,
        `rather than picking only one side.`,
      ].join('\n');

  const avoidLine = negativeBlock
    ? `\n5. AVOID   — If early-skipped tracks are listed above: do not repeat that direction; weaker signal than completed tracks.`
    : '';

  const exactFocusHint = (() => {
    const seed = String(seedQuery ?? '').toLowerCase();
    const tokens = seed
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length >= 3);
    const broad = /mood|genre|vibe|similar|official audio|same overall/i.test(seed);
    if (broad || tokens.length < 2) return '';
    return `\nExact-intent hint: if Primary focus implies a specific artist/track identity, avoid generic single-axis abstraction. Keep the first recommendation tightly aligned with that identity (substyle + era + intensity).`;
  })();

  const priorityBlock = (pivotToAnchor
    ? [
        `Priority order (pivot — anchor leads, diversity turn):`,
        `1. STRONG  — Session anchor (early-session theme).`,
        `2. MEDIUM  — Primary focus line: descriptor axes only — do not re-target the same lead artist as recent history.`,
        `3. MEDIUM  — Completed tracks: loose descriptor hints only; do NOT treat them as "play more of this performer".`,
        `4. CONTEXT — Session history titles: flavour only; avoid matching their lead artist.`,
      ]
    : [
        `Priority order:`,
        `1. STRONG  — Primary focus (latest user intent).`,
        `2. MEDIUM  — Completed tracks (interest signal).`,
        `3. MEDIUM  — Session anchor (background coherence).`,
        `4. CONTEXT — Session history as flavour only.`,
      ]
  ).join('\n') + avoidLine;

  return {
    historyBlock,
    listenedBlock,
    usedBlock,
    negativeBlock,
    dominantArtistNote,
    exactFocusHint,
    focusBlock,
    priorityBlock,
    meta: {
      playedTitlesCount: recentTitles.length,
      positiveCount: positiveContext.length,
      negativeCount: negTitles.length,
      usedQueriesCount: usedQueries.length,
      pivotToAnchor: Boolean(pivotToAnchor),
      hasDominantArtistNote: Boolean(dominantArtistNote),
      hasExactFocusHint: Boolean(exactFocusHint),
    },
  };
}

const IDENTITY_STOPWORDS = new Set([
  'official', 'audio', 'video', 'song', 'track', 'music', 'full', 'version', 'live', 'cover',
  'lyrics', 'lyric', 'remix', 'edit', 'mix', 'playlist', 'radio',
  'genre', 'style', 'mood', 'vibe', 'energetic', 'melancholic', 'similar',
  'jpop', 'kpop', 'rock', 'metal', 'phonk', 'trance', 'classical', 'indie',
]);

const AXIS_DESCRIPTOR_TOKENS = new Set([
  'melancholic', 'energetic', 'intense', 'ambient', 'sad', 'happy', 'dark', 'light',
  'chill', 'lofi', 'romantic', 'epic', 'acoustic', 'electronic', 'synth', 'vocal',
  'gothic', 'drill', 'phonk', 'trance', 'jazz', 'classical', 'post', 'punk',
  'jpop', 'kpop', 'indie', 'rock', 'metal', 'pop', 'anime',
  'modern', 'global', 'hit', 'anthem', 'opening', 'ending', 'ost', 'soundtrack',
]);

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenizeIdentity(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !IDENTITY_STOPWORDS.has(w));
}

/**
 * @param {string} seedQuery
 * @returns {boolean}
 */
function seedLikelyNeedsIdentity(seedQuery) {
  return classifySeedIntent(seedQuery) === 'identity';
}

/**
 * @param {string} seedQuery
 * @param {string[]} playedTitles
 * @returns {string}
 */
function inferIdentityAnchor(seedQuery, playedTitles = []) {
  const fromSeed = tokenizeIdentity(seedQuery).slice(0, 3).join(' ').trim();
  if (fromSeed.length >= 4) return fromSeed.slice(0, 80);
  const lead = new Map();
  for (const t of (Array.isArray(playedTitles) ? playedTitles : []).slice(-5)) {
    const m = String(t).match(/^([^–\-|()\[\]]{2,40}?)(?:\s*[-–|]|\s+feat\.|\s+ft\.)/i);
    const key = (m ? m[1] : '').toLowerCase().trim();
    if (key.length >= 2) lead.set(key, (lead.get(key) ?? 0) + 1);
  }
  const [artist, count] = [...lead.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (artist && count >= 2) return artist.slice(0, 80);
  return '';
}

/**
 * identity  — likely explicit performer/track anchor present
 * ambiguous — mostly descriptor tokens, can run with continuity probe
 * broad     — generic direction request (playlist/radio/mix-style)
 *
 * @param {string} seedQuery
 * @returns {'identity' | 'ambiguous' | 'broad'}
 */
function classifySeedIntent(seedQuery) {
  const seed = String(seedQuery ?? '').toLowerCase();
  if (/similar|same overall|playlist|mix|compilation|radio|genre|style|vibe|global|viral|top\s*\d+/.test(seed)) {
    return 'broad';
  }
  const t = tokenizeIdentity(seed);
  if (t.length === 0) return 'broad';
  const descriptorHits = t.filter((w) => AXIS_DESCRIPTOR_TOKENS.has(w)).length;
  if (descriptorHits >= Math.max(1, t.length - 1)) return 'ambiguous';
  if (t.length >= 2) return 'identity';
  return 'ambiguous';
}

/**
 * @param {string} candidate
 * @param {string} seedQuery
 * @param {string[]} playedTitles
 * @returns {string}
 */
function normalizeIdentityAnchor(candidate, seedQuery, playedTitles = []) {
  const c = String(candidate ?? '').trim().slice(0, 80);
  const seedTokens = tokenizeIdentity(seedQuery);
  const candTokens = tokenizeIdentity(c);
  const hasSeedOverlap =
    candTokens.length > 0 &&
    seedTokens.some((t) => candTokens.includes(t));
  if (seedTokens.length >= 2 && !hasSeedOverlap) {
    return inferIdentityAnchor(seedQuery, playedTitles);
  }
  // If candidate is pure descriptor noise, prefer inferred anchor.
  const descriptorOnly =
    candTokens.length > 0 &&
    candTokens.every((t) => AXIS_DESCRIPTOR_TOKENS.has(t));
  if (descriptorOnly) {
    return inferIdentityAnchor(seedQuery, playedTitles);
  }
  return c;
}

// ─── Autoplay: structured recommendation (primary) — explicit blend schema ───

/**
 * @typedef {{ axis_primary: string, axis_secondary: string }} MusicAxis
 * @typedef {{
 *   session_anchor: MusicAxis,
 *   primary_focus: MusicAxis,
 *   texture: string,
 *   identity_anchor: string,
 *   seed_class: 'identity' | 'ambiguous' | 'broad',
 *   merge_strategy: 'bridge' | 'favor_anchor' | 'favor_momentum',
 * }} TrackBlendStruct
 */

/**
 * Extract a top-level JSON object from model output (supports nested `{ ... }`).
 * @param {string} text
 * @returns {string | null}
 */
function extractJsonObject(text) {
  const start = String(text).indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Ask Groq for a **blend** recommendation: abstract axes (session anchor vs primary/momentum)
 * plus merge_strategy. The bot turns this into YouTube strings in buildSearchQueriesFromStruct.
 *
 * @param {string} seedQuery
 * @param {string[]} playedTitles
 * @param {{ positiveContext?: string[], usedQueries?: string[], pivotToAnchor?: boolean, negativeContext?: string[] }} [opts]
 * @returns {Promise<TrackBlendStruct>}
 */
export async function groqNextTrackStruct(seedQuery, playedTitles, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model     = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 8_000;

  const { historyBlock, listenedBlock, usedBlock, negativeBlock, dominantArtistNote, exactFocusHint, focusBlock, priorityBlock, meta }
    = buildAutoplayContextBlocks(seedQuery, playedTitles, opts);
  autoplayGroqDebug('struct-prompt-shape', {
    ...meta,
    mode: 'struct',
    hasNegativeBlock: Boolean(negativeBlock),
  });

  const userPrompt = [
    historyBlock,
    listenedBlock,
    usedBlock,
    negativeBlock,
    dominantArtistNote,
    exactFocusHint,
    focusBlock,
    `\n── Task (blend recommendation) ──`,
    `The seed above has "Primary focus" (latest user intent) and often "Session anchor" (early-session theme).`,
    `You must output ONE JSON object with abstract descriptor axes. Do not collapse everything into one generic axis.`,
    ``,
    `Output ONLY valid JSON (no markdown, no code fences, no explanation):`,
    `{"session_anchor":{"axis_primary":"...","axis_secondary":"..."},"primary_focus":{"axis_primary":"...","axis_secondary":"..."},"identity_anchor":"","texture":"","merge_strategy":"bridge"}`,
    ``,
    `Fields:`,
    `• session_anchor — two abstract axes that fit the Session anchor line (early-session coherence).`,
    `• primary_focus  — two abstract axes that fit the Primary focus line (latest intent / recent momentum).`,
    `• identity_anchor — specific identity token when clearly implied (artist, track, franchise). Use "" if absent.`,
    `• texture         — optional production texture (e.g. "synth", "acoustic"); "" if none.`,
    `• merge_strategy — how to combine the axes for the next pick:`,
    `    "bridge"           — balance both themes (default when anchor and focus differ).`,
    `    "favor_anchor"     — lean toward session anchor (e.g. user asked to return to the original vibe).`,
    `    "favor_momentum"   — lean toward primary focus / recent plays.`,
    `• Axis fields must stay abstract (no artist/song names there).`,
    ``,
    priorityBlock,
    ``,
    `Do not describe content in these categories:`,
    NEGATIVE_CONTENT_TYPES,
  ].join('\n');

  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You output a single JSON object describing abstract descriptor axes and how to merge them. ' +
            'Reply with only valid JSON — no markdown, no explanation.',
        },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 220,
      temperature: (() => {
        const t = Number(process.env.GROQ_AUTOPLAY_TEMPERATURE);
        return Number.isFinite(t) && t >= 0 && t <= 2 ? t : 0.55;
      })(),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw  = data?.choices?.[0]?.message?.content ?? '';

  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) throw new Error('No JSON object in Groq response');

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Invalid JSON from Groq: ${jsonStr.slice(0, 120)}`);
  }

  const sa = parsed.session_anchor && typeof parsed.session_anchor === 'object' ? parsed.session_anchor : {};
  const pf = parsed.primary_focus && typeof parsed.primary_focus === 'object' ? parsed.primary_focus : {};

  const session_anchor = {
    axis_primary: String(sa.axis_primary ?? sa.genre ?? '').trim().slice(0, 60),
    axis_secondary: String(sa.axis_secondary ?? sa.mood ?? '').trim().slice(0, 40),
  };
  const primary_focus = {
    axis_primary: String(pf.axis_primary ?? pf.genre ?? '').trim().slice(0, 60),
    axis_secondary: String(pf.axis_secondary ?? pf.mood ?? '').trim().slice(0, 40),
  };
  const texture = String(parsed.texture ?? parsed.style ?? '').trim().slice(0, 30);
  let identity_anchor = normalizeIdentityAnchor(parsed.identity_anchor ?? '', seedQuery, playedTitles);
  const seedClass = classifySeedIntent(seedQuery);
  if (!identity_anchor && seedClass === 'identity') {
    identity_anchor = inferIdentityAnchor(seedQuery, playedTitles);
  }
  if (!identity_anchor && seedClass === 'identity') {
    throw new Error('identity_anchor required but missing');
  }

  const ms = String(parsed.merge_strategy ?? 'bridge').toLowerCase();
  const merge_strategy =
    ms === 'favor_anchor' || ms === 'favor_momentum' ? ms : 'bridge';

  const hasA = session_anchor.axis_primary || session_anchor.axis_secondary;
  const hasP = primary_focus.axis_primary || primary_focus.axis_secondary;
  if (!hasA && !hasP) throw new Error('Empty blend struct from Groq');

  // If one axis missing, mirror the other so the bot can still build queries
  if (!hasA && hasP) {
    session_anchor.axis_primary = primary_focus.axis_primary;
    session_anchor.axis_secondary = primary_focus.axis_secondary;
  }
  if (!hasP && hasA) {
    primary_focus.axis_primary = session_anchor.axis_primary;
    primary_focus.axis_secondary = session_anchor.axis_secondary;
  }

  assertGroqSearchQueryOk(
    `${session_anchor.axis_primary} ${session_anchor.axis_secondary} ${primary_focus.axis_primary} ${primary_focus.axis_secondary} ${texture}`,
  );

  return {
    session_anchor,
    primary_focus,
    identity_anchor,
    seed_class: seedClass,
    texture,
    merge_strategy,
  };
}

/**
 * @typedef {{
 *   interest_tags: string[],
 *   weak_tags: string[],
 *   avoid_artists: string[],
 *   artist_candidates: Array<{ name: string, reason?: string, score?: number }>
 * }} ArtistRecommendationPack
 */

function sanitizeStringArray(v, maxItems = 8, maxLen = 48) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v) {
    const s = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLen);
    if (!s) continue;
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeArtistCandidates(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const reason = String(raw.reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const scoreNum = Number(raw.score);
    out.push({
      name,
      reason: reason || undefined,
      score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(1, scoreNum)) : undefined,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Ask Groq for artist-level recommendations (not free-text YouTube queries).
 *
 * @param {string} seedQuery
 * @param {string[]} playedTitles
 * @param {{ positiveContext?: string[], usedQueries?: string[], pivotToAnchor?: boolean, negativeContext?: string[] }} [opts]
 * @returns {Promise<ArtistRecommendationPack>}
 */
export async function groqRecommendArtists(seedQuery, playedTitles, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model     = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 8_000;
  const { historyBlock, listenedBlock, usedBlock, negativeBlock, focusBlock, priorityBlock, exactFocusHint, meta }
    = buildAutoplayContextBlocks(seedQuery, playedTitles, opts);

  autoplayGroqDebug('artist-pack-prompt-shape', {
    ...meta,
    mode: 'artist-pack',
    hasNegativeBlock: Boolean(negativeBlock),
  });

  const userPrompt = [
    historyBlock,
    listenedBlock,
    usedBlock,
    negativeBlock,
    exactFocusHint,
    focusBlock,
    `\n── Task (artist recommendations) ──`,
    `Return a JSON object with candidate ARTISTS/BANDS and avoid list.`,
    `Do not output YouTube query strings. Do not output track titles as primary recommendation objects.`,
    ``,
    `Output ONLY valid JSON (no markdown):`,
    `{"interest_tags":[""],"weak_tags":[""],"avoid_artists":[""],"artist_candidates":[{"name":"","reason":"","score":0.0}]}`,
    ``,
    `Rules:`,
    `• artist_candidates: 3-6 entries, globally known OR context-relevant artists.`,
    `• avoid_artists: artists over-represented in recent history or fast-skipped context.`,
    `• score: 0..1 confidence.`,
    `• Use semantic similarity, not token repetition.`,
    `• Keep artists diverse; do not repeat the same performer family.`,
    ``,
    priorityBlock,
    ``,
    `Do not target:`,
    NEGATIVE_CONTENT_TYPES,
  ].join('\n');

  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You output one valid JSON object with artist_candidates and avoid_artists. ' +
            'No prose, no markdown, no code fences.',
        },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 260,
      temperature: (() => {
        const t = Number(process.env.GROQ_AUTOPLAY_TEMPERATURE);
        return Number.isFinite(t) && t >= 0 && t <= 2 ? t : 0.55;
      })(),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) throw new Error('No JSON object in artist-pack response');

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Invalid artist-pack JSON: ${jsonStr.slice(0, 120)}`);
  }

  const pack = {
    interest_tags: sanitizeStringArray(parsed?.interest_tags, 8, 36),
    weak_tags: sanitizeStringArray(parsed?.weak_tags, 8, 36),
    avoid_artists: sanitizeStringArray(parsed?.avoid_artists, 10, 60),
    artist_candidates: sanitizeArtistCandidates(parsed?.artist_candidates),
  };
  if (pack.artist_candidates.length === 0) {
    throw new Error('Empty artist_candidates');
  }
  return pack;
}

// ─── Autoplay: next track query (fallback / legacy) ───────────────────────────

/**
 * Ask Groq to generate a single YouTube search query for the next autoplay track.
 * Kept as fallback when groqNextTrackStruct fails to produce valid JSON.
 *
 * @param {string} seedQuery
 * @param {string[]} playedTitles
 * @param {{ positiveContext?: string[], usedQueries?: string[], pivotToAnchor?: boolean, negativeContext?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function groqNextTrackQuery(seedQuery, playedTitles, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model     = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 8_000;

  const { historyBlock, listenedBlock, usedBlock, negativeBlock, dominantArtistNote, exactFocusHint, focusBlock, priorityBlock, meta }
    = buildAutoplayContextBlocks(seedQuery, playedTitles, opts);
  autoplayGroqDebug('legacy-prompt-shape', {
    ...meta,
    mode: 'legacy',
    hasNegativeBlock: Boolean(negativeBlock),
  });

  const userPrompt = [
    historyBlock,
    listenedBlock,
    usedBlock,
    negativeBlock,
    dominantArtistNote,
    exactFocusHint,
    focusBlock,
    `\n── Task ──`,
    `Output ONE YouTube search string for a single music track`,
    `(album cut, single, soundtrack cue, official upload — not a playlist or compilation).`,
    ``,
    priorityBlock,
    ``,
    `Output rules:`,
    `• Reply with the search string only — no explanation, no quotes.`,
    `• About 3–10 words. English or romanized non-Latin titles if needed; avoid Russian in the string.`,
    `• If disambiguation helps, append "official audio" or similar.`,
    `• Do not name a track from the played list; do not reuse an already-used description.`,
    ``,
    `Do not target:`,
    NEGATIVE_CONTENT_TYPES,
  ].join('\n');

  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You output one line: a YouTube search string for a single music track. ' +
            'Follow the user prompt priority order. No extra text.',
        },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 48,
      temperature: (() => {
        const t = Number(process.env.GROQ_AUTOPLAY_TEMPERATURE);
        return Number.isFinite(t) && t >= 0 && t <= 2 ? t : 0.55;
      })(),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw   = data?.choices?.[0]?.message?.content ?? '';
  const clean = raw.split('\n')[0].replace(/^["'«»]+|["'»«.]+$/g, '').trim();
  if (!clean || clean.length < 3) throw new Error('Empty response from Groq');
  assertGroqSearchQueryOk(clean);
  return clean;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * General-purpose Groq chat (used by /chat).
 *
 * @param {string} userText
 * @param {string} [systemPrompt]
 * @returns {Promise<string>}
 */
export async function chatGroq(userText, systemPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model     = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 30_000;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userText });

  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.8 }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

/** Returns true if GROQ_API_KEY is configured. */
export function isGroqConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}
