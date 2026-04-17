/**
 * In-memory session facade for autoplay context.
 *
 * Scope:
 * - initial/last/topic/identity intents
 * - used autoplay queries
 * - session played titles for Groq context
 * - resolving flag for UI loading state
 */

/** @type {Map<string, string>} */
const initialSeedByGuild = new Map();
/** @type {Map<string, string>} */
const lastIntentByGuild = new Map();
/** @type {Map<string, string>} */
const topicIntentByGuild = new Map();
/** @type {Map<string, string>} */
const identityIntentByGuild = new Map();
/** @type {Map<string, string[]>} */
const usedQueriesByGuild = new Map();
/** @type {Map<string, string[]>} */
const sessionTitlesByGuild = new Map();
/** @type {Set<string>} */
const resolvingByGuild = new Set();

const USED_QUERIES_CAP = 30;
const SESSION_TITLES_CAP = 20;

function gid(guildId) {
  return String(guildId);
}

export function getAutoplaySessionSnapshot(guildId) {
  const id = gid(guildId);
  return {
    guildId: id,
    initialSeed: initialSeedByGuild.get(id) ?? null,
    lastIntent: lastIntentByGuild.get(id) ?? null,
    topicIntent: topicIntentByGuild.get(id) ?? null,
    identityIntent: identityIntentByGuild.get(id) ?? null,
    usedQueries: [...(usedQueriesByGuild.get(id) ?? [])],
    sessionTitles: [...(sessionTitlesByGuild.get(id) ?? [])],
    resolving: resolvingByGuild.has(id),
  };
}

export function isAutoplayResolving(guildId) {
  return resolvingByGuild.has(gid(guildId));
}

export function setAutoplayResolving(guildId, enabled) {
  if (enabled) beginAutoplayResolving(guildId);
  else endAutoplayResolving(guildId);
}

export function beginAutoplayResolving(guildId) {
  resolvingByGuild.add(gid(guildId));
}

export function endAutoplayResolving(guildId) {
  resolvingByGuild.delete(gid(guildId));
}

export function getAutoplayInitialSeed(guildId) {
  return initialSeedByGuild.get(gid(guildId)) ?? null;
}

export function setAutoplayInitialSeedIfAbsent(guildId, value) {
  const id = gid(guildId);
  if (!initialSeedByGuild.has(id)) initialSeedByGuild.set(id, String(value));
}

export function getAutoplayLastIntent(guildId) {
  return lastIntentByGuild.get(gid(guildId)) ?? null;
}

export function setAutoplayLastIntent(guildId, value) {
  lastIntentByGuild.set(gid(guildId), String(value));
}

export function getAutoplayTopicIntent(guildId) {
  return topicIntentByGuild.get(gid(guildId)) ?? null;
}

export function setAutoplayTopicIntent(guildId, value) {
  topicIntentByGuild.set(gid(guildId), String(value));
}

export function getAutoplayIdentityIntent(guildId) {
  return identityIntentByGuild.get(gid(guildId)) ?? null;
}

export function setAutoplayIdentityIntent(guildId, value) {
  identityIntentByGuild.set(gid(guildId), String(value));
}

function getAutoplayUsedQueries(guildId) {
  return usedQueriesByGuild.get(gid(guildId)) ?? [];
}

export function pushAutoplayUsedQuery(guildId, token) {
  const id = gid(guildId);
  const q = getAutoplayUsedQueries(id).slice(-USED_QUERIES_CAP + 1);
  q.push(String(token));
  usedQueriesByGuild.set(id, q);
}

function getAutoplaySessionTitles(guildId) {
  return sessionTitlesByGuild.get(gid(guildId)) ?? [];
}

export function appendAutoplaySessionTitle(guildId, title) {
  const id = gid(guildId);
  const titles = getAutoplaySessionTitles(id).slice();
  titles.push(String(title));
  while (titles.length > SESSION_TITLES_CAP) titles.shift();
  sessionTitlesByGuild.set(id, titles);
}

/**
 * Builds the Focus block passed to groqNextTrackQuery.
 *
 * The block uses labeled sections so the English prompt can parse priorities:
 *   - "Primary focus" (last user intent) → STRONG
 *   - "Session anchor" (first intent)    → MEDIUM background coherence
 *
 * When both differ, Groq is instructed (in the prompt) to BLEND them rather
 * than picking one — bridging mood/genre between the two themes.
 *
 * Pure reader над session-state; живёт тут (не в `autoplay-spawn.js`), потому что
 * зависит исключительно от getAutoplayInitialSeed/LastIntent/TopicIntent/IdentityIntent.
 *
 * @param {string} guildId
 * @returns {string | null}
 */
export function buildAutoplaySeedForGroq(guildId) {
  const initial = getAutoplayInitialSeed(guildId);
  const last = getAutoplayLastIntent(guildId);
  const topic = getAutoplayTopicIntent(guildId);
  const identity = getAutoplayIdentityIntent(guildId);
  if (!last && !initial) return null;
  if (!initial || !last || last === initial) {
    const lines = [`Primary focus (STRONG): ${last ?? initial}`];
    if (topic) lines.push(`Topic hint (MEDIUM): ${topic}`);
    if (identity) lines.push(`Identity hint (MEDIUM): ${identity}`);
    return lines.join('\n');
  }
  const lines = [
    `Primary focus (STRONG): ${last}\n` +
    `Session anchor (MEDIUM): ${initial}`,
  ];
  if (topic) lines.push(`Topic hint (MEDIUM): ${topic}`);
  if (identity) lines.push(`Identity hint (MEDIUM): ${identity}`);
  return lines.join('\n');
}

/**
 * Pivot seed: break artist streak. Two cases:
 * 1) Anchor ≠ last request → use anchor only (old behaviour).
 * 2) Anchor === last (or only one theme) → old code returned buildAutoplaySeedForGroq() — same
 *    string as non-pivot, so pivot did NOTHING and autoplay looped on one performer.
 *    Now we inject an explicit diversity instruction while keeping mood/genre.
 *
 * @param {string} guildId
 * @returns {string | null}
 */
export function buildAutoplayPivotSeed(guildId) {
  const initial = getAutoplayInitialSeed(guildId);
  const last = getAutoplayLastIntent(guildId);
  if (initial && last && initial !== last) {
    return `Primary focus (STRONG): ${initial}`;
  }
  const topic = String(initial ?? last ?? '').trim();
  if (topic) {
    return (
      `Primary focus (STRONG): Stay in the same overall mood, genre and era as: "${topic.slice(0, 280)}". ` +
      'CRITICAL diversity rule: the next pick must imply a **different lead artist or band** than the titles dominating recent session history — same genre is fine, same performer cluster is not.'
    );
  }
  return buildAutoplaySeedForGroq(guildId);
}

export function clearAutoplaySessionState(guildId) {
  const id = gid(guildId);
  initialSeedByGuild.delete(id);
  lastIntentByGuild.delete(id);
  topicIntentByGuild.delete(id);
  identityIntentByGuild.delete(id);
  usedQueriesByGuild.delete(id);
  sessionTitlesByGuild.delete(id);
  resolvingByGuild.delete(id);
}
