/**
 * guild-session-state.js
 *
 * Centralised in-memory state for per-guild playback sessions.
 * Does NOT know about Discord, voice connections, or yt-dlp.
 * Owned here so that future HTTP API / web app can read state
 * without importing the full music.js monolith.
 *
 * Ownership rule (hard constraint):
 *   - This module is the ONLY writer of canonical runtime UI state.
 *   - music.js calls setPlayerState(); it does not own UI state itself.
 *   - music-ui.js only reads via resolvePlayerUIState(); never computes state.
 *   - API snapshots read already-resolved state; they do not re-derive logic.
 *
 * Raw Map/Set exports are used directly by music.js (and stop-and-leave-steps.js
 * via dependency injection). New callers should prefer the named API functions
 * defined in the sections below.
 */

import { randomUUID } from 'node:crypto';

/**
 * @typedef {import('./queue-invariants.js').QueueItem} QueueItem
 */

// ─── Raw state (backward-compat exports) ─────────────────────────────────────

/** Repeat-mode per guild: true = don't advance queue on track end. */
/** @type {Set<string>} */
export const repeatByGuild = new Set();

/** Autoplay per guild: true = bot appends similar tracks when queue empties. */
/** @type {Set<string>} */
export const autoplayByGuild = new Set();

/** Watch URL of the currently playing (or last played) track. */
/** @type {Map<string, string>} */
export const currentPlayingUrlByGuild = new Map();

/** Human-readable label of the currently playing (or last played) track. */
/** @type {Map<string, string>} */
export const currentPlayingLabelByGuild = new Map();

/** QueueItem that is currently playing — needed for repeat-mid-track and signal attribution. */
/** @type {Map<string, QueueItem>} */
export const currentQueueItemByGuild = new Map();

// ─── Session identity ─────────────────────────────────────────────────────────

/** @type {Map<string, string>} guildId → sessionId (UUID) */
const sessionIdByGuild = new Map();

/**
 * Start a new playback session for a guild.
 * Called by music.js on first enqueue when bot was not in channel.
 * @param {string} guildId
 * @returns {string} new sessionId
 */
export function startSession(guildId) {
  const sessionId = randomUUID();
  sessionIdByGuild.set(String(guildId), sessionId);
  return sessionId;
}

/** @param {string} guildId @returns {string | null} */
export function getSessionId(guildId) {
  return sessionIdByGuild.get(String(guildId)) ?? null;
}

/**
 * End the playback session for a guild.
 *
 * Clears ALL voice-scoped runtime state — session id + "currently playing"
 * metadata maps. This is intentional: the semantics of a session ending
 * are "the voice context is gone, nothing is playing anymore". Leaving
 * `currentPlayingLabelByGuild` or `currentPlayingUrlByGuild` populated
 * after session end would surface as stale labels in `getGuildSessionSnapshot`
 * (e.g. the retrospective-like path reading a label from a session that
 * already ended).
 *
 * Idempotent: safe to call after `stopAndLeave` has already cleared the
 * same maps — all `.delete` ops are no-ops on missing keys.
 *
 * Paths that reach here:
 *   - `commands.stopAndLeave` → `stop-and-leave-steps` clears maps →
 *     voice-adapter.leave() → `onVoiceGone` → `endSession` (redundant clear, ok)
 *   - Auto-leave timer → same chain as above.
 *   - User drags bot out manually → voice-adapter detects disconnect →
 *     `onVoiceGone` → `endSession` (FIRST clear happens here — the
 *     `stopAndLeave` cleanup path didn't run in this scenario).
 *
 * NOTE: preserves `repeatByGuild` / `autoplayByGuild` — those are user
 * preferences that should survive a voice-gone (user comes back and expects
 * their toggles to still be as they left them).
 *
 * @param {string} guildId
 */
export function endSession(guildId) {
  const id = String(guildId);
  sessionIdByGuild.delete(id);
  currentPlayingUrlByGuild.delete(id);
  currentPlayingLabelByGuild.delete(id);
  currentQueueItemByGuild.delete(id);
}

// ─── Listeners count (updated via voiceStateUpdate in index.js) ───────────────

/** @type {Map<string, number>} */
const listenersCountByGuild = new Map();

/**
 * Called from index.js voiceStateUpdate handler.
 * Counts human listeners: excludes bots, server-deafened, self-deafened.
 * Self-muted users ARE counted — they can still hear music.
 * @param {string} guildId
 * @param {number} count
 */
export function updateListenersCount(guildId, count) {
  listenersCountByGuild.set(String(guildId), Math.max(0, count));
}

/** @param {string} guildId @returns {number} */
export function getListenersCount(guildId) {
  return listenersCountByGuild.get(String(guildId)) ?? 0;
}

// ─── PlayerState + StatusReason ───────────────────────────────────────────────

/**
 * Stable states of the player state machine.
 * AUTOPLAY_ERROR and TRACK_BLOCKED are NOT states — they are StatusReasons.
 */
export const PlayerState = Object.freeze({
  IDLE_EMPTY:     'idle_empty',     // bot connected, nothing queued
  LOADING:        'loading',        // resolving URL / joining voice
  PLAYING:        'playing',
  PAUSED:         'paused',
  IDLE_EXHAUSTED: 'idle_exhausted', // queue empty, autoplay off
});

/**
 * Transient error/status reason — orthogonal to playerState.
 * Cleared when the player moves to a new stable state.
 */
export const StatusReason = Object.freeze({
  NONE:          null,
  AUTOPLAY_ERROR: 'autoplay_error', // "лапки ничего не нашли"
  TRACK_BLOCKED:  'track_blocked',  // region-blocked track
  VOICE_ERROR:    'voice_error',    // failed to join voice channel
});

/** @type {Map<string, string>} */
const playerStateByGuild = new Map();
/** @type {Map<string, string | null>} */
const statusReasonByGuild = new Map();

/**
 * Set the canonical UI state for a guild.
 * Only this module and music.js (via this function) may write player state.
 * Broadcasts a `player_state_changed` delta to all WS subscribers.
 * @param {string} guildId
 * @param {string} state — PlayerState value
 * @param {string | null} [reason] — StatusReason value
 */
export function setPlayerState(guildId, state, reason = StatusReason.NONE) {
  const id = String(guildId);
  playerStateByGuild.set(id, state);
  statusReasonByGuild.set(id, reason);
}

/**
 * Resolve current UI state for a guild.
 * music-ui.js and API use this — they never re-derive state logic themselves.
 * @param {string} guildId
 * @returns {{ playerState: string, statusReason: string | null }}
 */
export function resolvePlayerUIState(guildId) {
  return {
    playerState:  playerStateByGuild.get(String(guildId)) ?? PlayerState.IDLE_EMPTY,
    statusReason: statusReasonByGuild.get(String(guildId)) ?? StatusReason.NONE,
  };
}

// ─── Bot voice connection state ───────────────────────────────────────────────
// music.js writes this; guild-session-state.js does not know about Discord.
// Kept here so HTTP API / snapshot can expose botConnected without importing music.js.

/** @type {Map<string, { connected: boolean, channelId: string | null }>} */
const botVoiceStateByGuild = new Map();

/**
 * Called by music.js when bot joins or leaves a voice channel.
 * @param {string} guildId
 * @param {{ connected: boolean, channelId?: string | null }} state
 */
export function setBotVoiceState(guildId, { connected, channelId = null }) {
  botVoiceStateByGuild.set(String(guildId), { connected, channelId: channelId ?? null });
}

/**
 * @param {string} guildId
 * @returns {{ connected: boolean, channelId: string | null }}
 */
export function getBotVoiceState(guildId) {
  return botVoiceStateByGuild.get(String(guildId)) ?? { connected: false, channelId: null };
}

// ─── Prefetch generation counter ─────────────────────────────────────────────

/** @type {Map<string, number>} */
const prefetchGenerationByGuild = new Map();

/** @param {string} guildId @returns {number} new generation */
export function incrementPrefetchGeneration(guildId) {
  const next = (prefetchGenerationByGuild.get(String(guildId)) ?? 0) + 1;
  prefetchGenerationByGuild.set(String(guildId), next);
  return next;
}

/** @param {string} guildId @returns {number} */
export function getPrefetchGeneration(guildId) {
  return prefetchGenerationByGuild.get(String(guildId)) ?? 0;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * Read-only snapshot of the current session state for a guild.
 * Safe to expose over HTTP API — returns plain data, no Discord refs.
 * Minimal set: only fields needed for command recheck, web UI, session validity.
 *
 * @param {string} guildId
 * @returns {{
 *   guildId: string,
 *   sessionId: string | null,
 *   botConnected: boolean,
 *   voiceChannelId: string | null,
 *   repeat: boolean,
 *   autoplay: boolean,
 *   currentUrl: string | null,
 *   currentLabel: string | null,
 *   currentTrackRequestedBy: string | null,
 *   currentTrackRequestedByName: string | null,
 *   currentTrackTriggeredBy: string | null,
 *   currentTrackSource: import('./queue-invariants.js').TrackSource | null,
 *   currentTrackSpawnId: string | null,
 *   playerState: string,
 *   statusReason: string | null,
 *   listenersCount: number,
 * }}
 */
export function getGuildSessionSnapshot(guildId) {
  const id = String(guildId);
  const item = currentQueueItemByGuild.get(id) ?? null;
  const { playerState, statusReason } = resolvePlayerUIState(id);
  const voice = botVoiceStateByGuild.get(id) ?? { connected: false, channelId: null };
  return {
    guildId: id,
    sessionId: sessionIdByGuild.get(id) ?? null,
    botConnected: voice.connected,
    voiceChannelId: voice.channelId,
    repeat: repeatByGuild.has(id),
    autoplay: autoplayByGuild.has(id),
    currentUrl: currentPlayingUrlByGuild.get(id) ?? null,
    currentLabel: currentPlayingLabelByGuild.get(id) ?? null,
    currentTrackRequestedBy: item?.requestedBy ?? null,
    currentTrackRequestedByName: item?.requestedByName ?? null,
    currentTrackTriggeredBy: item?.source ?? null,
    currentTrackSource: item?.source ?? null,
    currentTrackSpawnId: item?.spawnId ?? null,
    playerState,
    statusReason,
    listenersCount: listenersCountByGuild.get(id) ?? 0,
  };
}
