function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Per-guild artist quarantine state:
 * Map<guildId, Map<artistToken, remainingSpawnCount>>
 *
 * Hard blocks the quick-skipped lead artist for the next N autoplay spawns.
 * This is intentionally separate from artist cooldown:
 *   - quarantine = hard reject before ranker
 *   - cooldown   = soft / ranker-aware suppression
 *
 * @type {Map<string, Map<string, number>>}
 */
const quarantinedArtistsByGuild = new Map();

function normalizeArtistToken(artist) {
  const value = String(artist ?? '').trim().toLowerCase();
  return value || null;
}

export function isAutoplayArtistQuarantineEnabled() {
  const value = String(process.env.AUTOPLAY_ARTIST_QUARANTINE_ENABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function getAutoplayArtistQuarantineSpawns() {
  return envNumber('AUTOPLAY_ARTIST_QUARANTINE_SPAWNS', 1, 1, 5);
}

/**
 * @param {string} guildId
 * @returns {Map<string, number>}
 */
function getOrCreateGuildQuarantine(guildId) {
  const id = String(guildId);
  let state = quarantinedArtistsByGuild.get(id);
  if (!state) {
    state = new Map();
    quarantinedArtistsByGuild.set(id, state);
  }
  return state;
}

/**
 * Hard-block an artist for the next N autoplay spawns.
 * Repeated quarantine calls extend the remaining window additively.
 *
 * @param {string} guildId
 * @param {string | null | undefined} artist
 * @param {number} [spawnCount]
 * @returns {boolean}
 */
export function quarantineArtistForNextSpawns(guildId, artist, spawnCount = getAutoplayArtistQuarantineSpawns()) {
  const normalizedArtist = normalizeArtistToken(artist);
  if (!normalizedArtist) return false;

  const clampedSpawns = Math.max(1, Math.min(5, Math.trunc(Number(spawnCount) || 0)));
  const state = getOrCreateGuildQuarantine(guildId);
  state.set(normalizedArtist, (state.get(normalizedArtist) ?? 0) + clampedSpawns);
  return true;
}

/**
 * Snapshot current active quarantined artists for one autoplay spawn and
 * decrement their remaining counters.
 *
 * The returned array is the authoritative quarantine set for this spawn.
 * Decrement happens even if the eventual spawn falls through or finds no
 * matching artists — quarantine is measured in spawn attempts, not checks.
 *
 * @param {string} guildId
 * @returns {string[]}
 */
export function consumeAutoplayArtistQuarantineSpawn(guildId) {
  const id = String(guildId);
  const state = quarantinedArtistsByGuild.get(id);
  if (!state || state.size === 0) return [];

  const activeArtists = [];
  for (const [artist, remaining] of state.entries()) {
    if (!artist || remaining <= 0) continue;
    activeArtists.push(artist);
    if (remaining <= 1) state.delete(artist);
    else state.set(artist, remaining - 1);
  }

  if (state.size === 0) {
    quarantinedArtistsByGuild.delete(id);
  }

  return activeArtists;
}

/**
 * @param {Iterable<string> | null | undefined} quarantinedArtists
 * @param {string | null | undefined} artist
 * @returns {boolean}
 */
export function isArtistQuarantined(quarantinedArtists, artist) {
  const normalizedArtist = normalizeArtistToken(artist);
  if (!normalizedArtist || quarantinedArtists == null) return false;

  if (quarantinedArtists instanceof Set) {
    return quarantinedArtists.has(normalizedArtist);
  }

  for (const candidate of quarantinedArtists) {
    if (normalizeArtistToken(candidate) === normalizedArtist) return true;
  }
  return false;
}

/**
 * @param {string} guildId
 * @returns {{ artist: string, remainingSpawns: number }[]}
 */
export function getAutoplayArtistQuarantineSnapshot(guildId) {
  const state = quarantinedArtistsByGuild.get(String(guildId));
  if (!state || state.size === 0) return [];
  return [...state.entries()]
    .filter(([artist, remainingSpawns]) => Boolean(artist) && remainingSpawns > 0)
    .map(([artist, remainingSpawns]) => ({ artist, remainingSpawns }));
}

/**
 * @template {{ title?: string | null, channel?: { name?: string | null } | null }} T
 * @param {T[]} items
 * @param {{
 *   quarantinedArtists: Iterable<string> | null | undefined,
 *   extractLeadArtistToken: (title: string, meta?: { channelName?: string | null } | null) => string | null,
 * }} opts
 * @returns {{
 *   items: T[],
 *   meta: {
 *     activeArtists: number,
 *     rejected: number,
 *   },
 * }}
 */
export function filterAutoplayCandidatesByArtistQuarantine(items, opts) {
  const source = Array.isArray(items) ? items : [];
  const activeArtists = [...new Set(Array.from(opts?.quarantinedArtists ?? []).map(normalizeArtistToken).filter(Boolean))];
  const extractLeadArtistToken = typeof opts?.extractLeadArtistToken === 'function'
    ? opts.extractLeadArtistToken
    : (() => null);

  if (activeArtists.length === 0 || source.length === 0) {
    return {
      items: [...source],
      meta: {
        activeArtists: activeArtists.length,
        rejected: 0,
      },
    };
  }

  const filtered = [];
  let rejected = 0;

  for (const item of source) {
    const artist = extractLeadArtistToken(
      String(item?.title ?? ''),
      { channelName: item?.channel?.name ?? null },
    );
    if (isArtistQuarantined(activeArtists, artist)) {
      rejected++;
      continue;
    }
    filtered.push(item);
  }

  return {
    items: filtered,
    meta: {
      activeArtists: activeArtists.length,
      rejected,
    },
  };
}

export function clearArtistQuarantineState(guildId = undefined) {
  if (guildId === undefined) {
    quarantinedArtistsByGuild.clear();
    return;
  }
  quarantinedArtistsByGuild.delete(String(guildId));
}
