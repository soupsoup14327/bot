/**
 * ˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜: ˜˜˜ METRICS_TXT=1 ? data/metrics/music-ui.txt; ˜˜˜˜˜ console.
 * ˜˜˜: docs/˜˜˜˜˜˜˜˜˜˜˜˜˜.md
 *
 * music-panel.js ˜ ˜˜˜˜˜˜˜˜˜˜ UI ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜.
 *
 * ˜˜˜˜˜˜˜˜ ˜˜:
 *  - ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜-˜˜˜˜˜˜ (˜˜˜˜˜˜:) ˜˜ ˜˜˜˜˜˜˜
 *  - ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜-˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜
 *  - ˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜ ˜˜˜˜˜, idle, autoplay
 *  - placeholder-replace: raw-query ˜˜˜˜˜˜ ? ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜˜˜
 *    ˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜ (˜˜˜˜˜ QueueEntry.tag)
 *
 * ˜˜˜˜˜˜˜˜˜˜˜˜˜: ˜˜˜˜˜˜ initMusicUi(client) ˜˜ ˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜.
 */

import { isPlaybackMetricsEnabled, logMusicUiLine } from './playback-metrics.js';
import { buildMusicControlRows } from './ui-components.js';
import { schedulePanelUpdate } from './panel-update-queue.js';
import {
  getMusicTransportState,
  getRepeatableTrackLabel,
  getCurrentPlaybackInfo,
  setOnAutoplaySpawned,
  setOnMusicForceStop,
  setOnPlaybackIdle,
  setOnPlaybackUiRefresh,
  setOnPlayingTrackDisplay,
} from './music.js';
import {
  resolvePlayerUIState,
  PlayerState,
  StatusReason,
  currentPlayingLabelByGuild,
} from './guild-session-state.js';
import { formatAutoplayQueueLine, formatSingleQueueLine } from './queue-line-format.js';
import { resolveYoutubeCanonicalTitle } from './youtube-search.js';

/** @type {import('discord.js').Client | null} */
let cl = null;

/** ˜˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ Discord. */
export function initMusicUi(client) {
  cl = client;

  setOnMusicForceStop((guildId) => {
    void deleteAllMusicUi(guildId);
  });
  setOnPlayingTrackDisplay((guildId, label) => {
    // PlayerState ˜˜˜ PLAYING (˜˜˜˜˜˜˜˜˜ music.js).
    // ˜˜˜˜˜˜˜ ˜ replace placeholder ˜ ˜˜˜˜˜˜ (raw query ? ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜),
    // ˜˜˜˜˜ ˜˜˜˜˜ refresh ˜˜˜˜˜˜.
    void _replacePendingSingleLineWithLabel(guildId, label);
    void refreshSessionPanelFromState(guildId);
  });
  setOnPlaybackIdle((guildId) => {
    void applyIdleMusicUi(guildId);
  });
  setOnAutoplaySpawned((guildId, items, _query) => {
    void _notifyAutoplaySpawned(guildId, items);
  });
  setOnPlaybackUiRefresh((guildId) => {
    // ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ (LOADING): fire-and-forget, ˜˜ ˜˜˜˜˜ ˜˜˜˜˜˜˜.
    // ˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜˜˜˜ ˜˜˜ ˜˜˜˜˜ ˜˜˜ PLAYING ˜ LOADING ˜˜ ˜˜˜˜˜˜˜˜˜.
    immediateRefreshPanel(guildId);
  });
}

// --- ˜˜˜˜˜˜˜ ----------------------------------------------------------------

const MAX_MSG = 2000;

function _clip(s) {
  return s.length <= MAX_MSG ? s : `${s.slice(0, MAX_MSG - 1)}˜`;
}

function _safeLine(s, max = 380) {
  return String(s).replace(/@/g, '@\u200b').trim().slice(0, max);
}

// --- ˜˜˜˜˜˜˜˜˜ ------------------------------------------------------------

/**
 * @typedef {{ type: 'single', id: number, addedBy: string | null }} SingleTag
 * @typedef {'user' | 'autoplay' | null} QueueEntrySource
 * @typedef {{ text: string, tag: SingleTag | null, source: QueueEntrySource }} QueueEntry
 *
 * Note on `source` (WP8a prep):
 *   Tracks origin of each queue entry. Currently only used as metadata ˜
 *   UI renders all entries uniformly. Prepared for the upcoming recommender
 *   UX (Apple-Music-style "Up Next" preview) where user-added and
 *   recommender-produced entries will be visually distinguished or split
 *   into sections. Keeping the field now lets us attach source at insertion
 *   time across many call sites; the UI change becomes a local render diff
 *   instead of a cross-cutting migration.
 */

/**
 * Factory for queue entries ˜ centralises defaults so a future `source` or
 * other metadata addition happens in one spot, not scattered across `.map`
 * callsites.
 *
 * @param {string} text
 * @param {QueueEntrySource} [source=null]
 * @returns {QueueEntry}
 */
function _makeEntry(text, source = null) {
  return { text: String(text), tag: null, source };
}

/**
 * ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜-˜˜˜˜˜˜ ˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜.
 *
 * lines ˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜. ˜˜˜˜ `tag` ˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜˜˜
 * placeholder-replace: ˜˜˜˜˜˜ ˜ raw query ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜
 * tag.id; ˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜ ˜ ˜˜ id (˜˜ ˜˜ ˜˜˜˜˜˜)
 * ˜ ˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜. ˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜
 * raw-query ˜ MAX_QUEUE_LINES-˜˜˜˜˜˜˜.
 *
 * @type {Map<string, { channelId: string, messageId: string, lines: QueueEntry[] }>}
 */
const sessionQueueByGuild = new Map();

/**
 * FIFO-˜˜˜˜˜˜˜ id'˜˜˜ ˜˜˜˜˜˜˜˜˜ placeholder-replace ˜˜ guild.
 * ˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜, registerPendingSingleLine
 * ˜˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜ ˜˜ ˜˜˜˜˜˜˜ ˜ FIFO-˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜.
 *
 * @type {Map<string, number[]>}
 */
const pendingSingleIdsByGuild = new Map();

/** Monotonic counter for unique placeholder tag ids. */
let _nextSingleTagId = 1;

/** ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜-˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜. */
/** @type {Map<string, { channelId: string, messageId: string }>} */
const sessionPanelByGuild = new Map();

/** ˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜ (˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜). */
const MAX_QUEUE_LINES = 25;

/** ˜˜˜˜˜˜ ˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜ ˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜˜˜ ˜ fragment. */
const PANEL_LOADING = '˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜';
const PANEL_IDLE = '˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜.';
const PANEL_AUTOPLAY_WAIT = '˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜';
const PANEL_AUTOPLAY_ERROR = '˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜. ˜˜˜˜˜˜ ˜˜˜˜ ˜˜˜˜˜˜˜.';
const PANEL_PAUSE_FALLBACK = '˜˜ ˜˜˜˜˜.';

/**
 * ˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜ placeholder. ˜˜˜˜˜˜˜ ˜ session.lines ˜˜˜˜˜˜
 * UNTAGGED ˜˜˜˜˜˜ ˜ text === placeholderText, ˜˜˜˜˜˜˜˜˜˜ ˜˜˜.
 * id ˜˜˜˜ ˜˜˜ ˜ FIFO-˜˜˜˜˜˜˜ pendingSingleIdsByGuild.
 *
 * ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜ ˜
 * lines (˜˜˜˜˜ addTracksAndUpdateUI ? appendToSessionQueue).
 *
 * ˜˜˜˜ untagged-˜˜˜˜˜˜˜˜˜˜ ˜˜˜ (˜˜˜˜˜˜˜˜, ˜˜˜˜˜˜ ˜˜˜˜
 * panelHint) ˜ ˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜.
 *
 * @param {string} guildId
 * @param {string} placeholderText
 * @param {string | null} [addedBy]
 */
export function registerPendingSingleLine(guildId, placeholderText, addedBy = null) {
  const id = String(guildId);
  const session = sessionQueueByGuild.get(id);
  if (!session) return;

  const idx = session.lines.findIndex(
    (e) => e.tag == null && e.text === placeholderText,
  );
  if (idx === -1) return;

  const tagId = _nextSingleTagId++;
  session.lines[idx] = {
    text: session.lines[idx].text,
    tag: {
      type: 'single',
      id: tagId,
      addedBy: addedBy == null ? null : String(addedBy),
    },
    source: session.lines[idx].source ?? null,
  };

  const list = pendingSingleIdsByGuild.get(id) ?? [];
  list.push(tagId);
  pendingSingleIdsByGuild.set(id, list);
}

function clearPendingSingleLines(guildId) {
  pendingSingleIdsByGuild.delete(String(guildId));
}

/**
 * ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜-˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ PlayerState + StatusReason.
 * ˜˜˜˜˜˜˜˜˜˜˜˜ switch ˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜˜˜.
 * @param {string} guildId
 * @returns {string}
 */
function _panelStatusLine(guildId) {
  const { playerState, statusReason } = resolvePlayerUIState(guildId);
  switch (playerState) {
    case PlayerState.LOADING:
      return PANEL_LOADING;

    case PlayerState.IDLE_EXHAUSTED: {
      const ts = getMusicTransportState(guildId);
      // ˜˜˜˜˜˜˜ (autoplay, statusReason):
      //   autoplay ON  + AUTOPLAY_ERROR ? ˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜
      //   autoplay ON  + no error       ? ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜?
      //   autoplay OFF                  ? PANEL_IDLE
      if (ts?.autoplay) {
        return statusReason === StatusReason.AUTOPLAY_ERROR
          ? PANEL_AUTOPLAY_ERROR
          : PANEL_AUTOPLAY_WAIT;
      }
      return PANEL_IDLE;
    }

    case PlayerState.PAUSED:
      // Fallback: _panelContent ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜: X˜,
      // ˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜ label ˜˜˜˜˜˜˜˜˜.
      return PANEL_PAUSE_FALLBACK;

    default:
      return PANEL_IDLE;
  }
}

/**
 * Label ˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜ fallback-˜˜˜˜˜˜˜˜:
 *   getRepeatableTrackLabel ? currentPlayingLabelByGuild ? null.
 * ˜˜˜˜˜˜ ˜˜˜˜˜: PAUSED/PLAYING ˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜ label ˜
 * fallback ˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜ Map.
 *
 * @param {string} guildId
 * @returns {string | null}
 */
function _resolveActiveLabel(guildId) {
  const direct = getRepeatableTrackLabel(guildId);
  if (direct != null && String(direct).trim()) return String(direct);
  const mapLabel = currentPlayingLabelByGuild.get(String(guildId));
  if (mapLabel != null && String(mapLabel).trim()) return String(mapLabel);
  return null;
}

// --- ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ------------------------------------------------

/** @param {QueueEntry[]} entries */
function _buildQueueContent(entries) {
  return _clip('**˜˜˜˜˜˜:**\n' + entries.map((e) => e.text).join('\n') + '\n\u200b');
}

function _panelContent(guildId) {
  if (!guildId) return _safeLine(_clip(PANEL_IDLE), 2000);
  const { playerState } = resolvePlayerUIState(guildId);

  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = _resolveActiveLabel(guildId);
    if (label != null) {
      const info = getCurrentPlaybackInfo(guildId);
      const prefix = playerState === PlayerState.PAUSED ? '˜˜ ˜˜˜˜˜: ' : '˜˜˜˜˜˜ ˜˜˜˜˜˜: ';
      const queueFrag = info?.queueDepth > 0 ? ` ˜ ˜˜˜ ${info.queueDepth} ˜ ˜˜˜˜˜˜˜` : '';
      return _safeLine(_clip(`${prefix}**${_safeLine(String(label), 180)}**${queueFrag}`), 2000);
    }
  }
  return _safeLine(_clip(_panelStatusLine(guildId)), 2000);
}

function _panelRows(guildId) {
  if (guildId == null) {
    return buildMusicControlRows({
      hasActiveTrack: false,
      paused: false,
      canPrevious: false,
      canSkipForward: false,
      canRepeatToggle: false,
      canAutoplayToggle: false,
      canLike: false,
      repeat: false,
      autoplay: false,
      loading: false,
    });
  }
  return buildMusicControlRows(getMusicTransportState(guildId));
}

// --- ˜˜˜˜˜˜˜˜˜ API -----------------------------------------------------------

/**
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜.
 * ˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜ ˜ ˜˜˜˜˜˜; ˜˜˜˜ ˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜˜.
 *
 * @param {string} guildId
 * @param {string} channelId
 * @param {QueueEntrySource} [source=null] - origin metadata (WP8a prep)
 * @param {string[]} newLines ˜ ˜˜˜˜˜ ˜˜˜˜˜˜, ˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜ untagged entries
 */
export async function appendToSessionQueue(guildId, channelId, newLines, source = null) {
  const id = String(guildId);
  const session = sessionQueueByGuild.get(id);
  const entries = newLines.map((t) => _makeEntry(t, source));

  if (session) {
    session.lines.push(...entries);
    while (session.lines.length > MAX_QUEUE_LINES) session.lines.shift();
    try {
      const ch = await cl.channels.fetch(session.channelId).catch(() => null);
      const msg = ch?.isTextBased()
        ? await ch.messages.fetch(session.messageId).catch(() => null)
        : null;
      if (msg?.editable) {
        await msg.edit({ content: _buildQueueContent(session.lines) });
        return;
      }
    } catch { /* fall through to create */ }
    sessionQueueByGuild.delete(id);
  }

  try {
    const ch = await cl.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) {
      const lines = entries.slice(-MAX_QUEUE_LINES);
      const msg = await ch.send({ content: _buildQueueContent(lines) });
      sessionQueueByGuild.set(id, { channelId, messageId: msg.id, lines });
    }
  } catch (e) {
    console.warn('[queue] create failed', e);
  }
}

/**
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜.
 * ˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜. ˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜.
 */
export async function ensureSessionPanel(guildId, channelId, panelHint) {
  const id = String(guildId);
  const existing = sessionPanelByGuild.get(id);
  const content = panelHint ? _safeLine(_clip(panelHint), 2000) : '\u200b';
  const rows = _panelRows(id);

  if (existing) {
    try {
      const ch = await cl.channels.fetch(existing.channelId).catch(() => null);
      const msg = ch?.isTextBased()
        ? await ch.messages.fetch(existing.messageId).catch(() => null)
        : null;
      if (msg?.editable) {
        await msg.edit({ content, components: rows });
        return;
      }
    } catch { /* fall through */ }
    sessionPanelByGuild.delete(id);
  }

  try {
    const ch = await cl.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ content, components: rows });
      sessionPanelByGuild.set(id, { channelId, messageId: msg.id });
    }
  } catch (e) {
    console.warn('[panel] create failed', e);
  }
}

/** ˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ (˜˜˜˜˜˜ + ˜˜˜˜˜˜) ˜˜ Discord ˜ ˜˜˜˜˜˜˜ ˜˜˜˜˜. */
export async function deleteAllMusicUi(guildId) {
  const id = String(guildId);
  const queue = sessionQueueByGuild.get(id);
  const panel = sessionPanelByGuild.get(id);
  sessionQueueByGuild.delete(id);
  sessionPanelByGuild.delete(id);
  clearPendingSingleLines(id);
  for (const ref of [queue, panel].filter(Boolean)) {
    try {
      const ch = await cl.channels.fetch(ref.channelId).catch(() => null);
      if (ch?.isTextBased()) await ch.messages.delete(ref.messageId).catch(() => {});
    } catch { /* ignore */ }
  }
}

/**
 * ˜˜˜˜˜˜˜˜ placeholder-˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜
 * ˜˜˜˜˜. ˜˜˜˜˜˜˜˜˜˜ ˜˜ onPlayingTrackDisplay.
 *
 * ˜˜˜˜˜˜˜˜:
 *   1. ˜˜˜ ˜˜˜˜˜˜ id ˜˜ pendingSingleIdsByGuild (FIFO).
 *   2. ˜˜˜˜˜ ˜ session.lines ˜˜˜˜˜˜ ˜ tag.id === popped.
 *      ˜˜˜˜ ˜˜˜ ˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜ MAX_QUEUE_LINES ˜˜˜
 *      ˜˜˜˜˜˜ deleteAllMusicUi ˜ no-op.
 *   3. ˜˜˜˜˜˜˜˜ text ˜˜ formatSingleQueueLine(realLabel, { addedBy }),
 *      ˜˜˜˜˜ tag (˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜).
 *   4. ˜˜˜˜˜˜˜˜˜˜˜˜˜˜˜ Discord-˜˜˜˜˜˜˜˜˜.
 *
 * ˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜ raw-query ˜ ˜˜˜˜˜˜ FIFO:
 * ˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ tag.id, ˜˜ ˜˜ ˜˜˜˜˜˜.
 *
 * @param {string} guildId
 * @param {string} realLabel
 */
async function _replacePendingSingleLineWithLabel(guildId, realLabel) {
  const id = String(guildId);
  const pending = pendingSingleIdsByGuild.get(id);
  if (!pending || pending.length === 0) return;
  const tagId = pending.shift();
  if (pending.length === 0) pendingSingleIdsByGuild.delete(id);

  const session = sessionQueueByGuild.get(id);
  if (!session) return;

  const idx = session.lines.findIndex(
    (e) => e.tag?.type === 'single' && e.tag.id === tagId,
  );
  if (idx === -1) return;

  const addedBy = session.lines[idx].tag?.addedBy ?? null;
  const prevSource = session.lines[idx].source ?? null;
  const newText = formatSingleQueueLine(String(realLabel), { addedBy });
  if (newText === session.lines[idx].text) {
    session.lines[idx] = { text: session.lines[idx].text, tag: null, source: prevSource };
    return;
  }
  session.lines[idx] = { text: newText, tag: null, source: prevSource };

  try {
    const ch = await cl.channels.fetch(session.channelId).catch(() => null);
    const msg = ch?.isTextBased()
      ? await ch.messages.fetch(session.messageId).catch(() => null)
      : null;
    if (msg?.editable) {
      await msg.edit({ content: _buildQueueContent(session.lines) });
    }
  } catch (e) {
    console.warn('[queue] replace placeholder failed', e);
  }
}

/**
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜/˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ interaction
 * (˜˜˜˜˜ deferUpdate). ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜
 * ˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜ refreshSessionPanelFromState.
 */
export function syncInteractionMusicPanel(interaction) {
  const msg = interaction.message;
  const gid = interaction.guildId;
  if (!msg?.editable || !gid) return Promise.resolve();
  return schedulePanelUpdate(gid, async () => {
    await msg.edit({ content: _panelContent(gid), components: _panelRows(gid) });
  });
}

/**
 * ˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜ Discord ˜ ˜˜˜˜˜˜˜˜˜˜˜˜˜˜
 * ˜˜ ˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜.
 */
async function _doRefreshPanelAsync(guildId) {
  const id = String(guildId);
  const panel = sessionPanelByGuild.get(id);
  if (!panel) return;
  const ch = await cl.channels.fetch(panel.channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
  if (!msg?.editable) return;
  await msg.edit({ content: _panelContent(id), components: _panelRows(id) });
}

/**
 * ˜˜˜˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜˜ ˜ ˜˜˜ ˜˜˜˜˜˜˜˜˜˜
 * ˜˜˜˜˜˜˜˜˜ (LOADING). Fire-and-forget: ˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜,
 * ˜˜˜ ˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜ LOADING ˜˜ PLAYING.
 */
function immediateRefreshPanel(guildId) {
  void _doRefreshPanelAsync(String(guildId)).catch((e) => console.warn('[music] refresh panel', e));
}

/**
 * ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜ ˜˜˜˜˜˜˜ ˜ ˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜
 * (PLAYING, IDLE). ˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜ ˜ syncInteractionMusicPanel.
 */
function refreshSessionPanelFromState(guildId) {
  const id = String(guildId);
  schedulePanelUpdate(id, () => _doRefreshPanelAsync(id).catch((e) => console.warn('[music] refresh panel', e)));
}

/** ˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ / ˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜. */
export function applyIdleMusicUi(guildId) {
  if (sessionPanelByGuild.has(String(guildId))) {
    refreshSessionPanelFromState(guildId);
  }
}

/**
 * ˜˜˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜: ˜˜˜˜˜˜˜ ˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜-˜˜˜˜˜˜.
 */
export function panelFragmentForMusicUi(guildId, fallback = '') {
  if (guildId == null) return fallback;
  const { playerState } = resolvePlayerUIState(guildId);
  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = _resolveActiveLabel(guildId);
    if (label != null) {
      const prefix = playerState === PlayerState.PAUSED ? '˜˜ ˜˜˜˜˜: ' : '˜˜˜˜˜˜ ˜˜˜˜˜˜: ';
      return `${prefix}**${_safeLine(String(label), 200)}**`;
    }
  }
  return _panelStatusLine(guildId);
}

/**
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜ ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜.
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜ ˜˜ interaction ˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜ (˜˜˜˜˜˜
 * ˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜).
 */
export async function addTracksAndUpdateUI(interaction, queueLines, panelHint) {
  const gid = interaction.guildId;
  const chId = interaction.channelId;
  if (!gid || !chId) return;

  await appendToSessionQueue(gid, chId, queueLines, 'user');

  /**
   * ˜˜˜˜˜˜ ˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜ ˜˜˜˜˜˜, ˜˜˜˜ ˜˜˜-˜˜ ˜˜˜˜˜˜.
   * ˜˜˜˜˜˜˜˜˜ ˜˜ ˜˜˜˜˜˜˜: ˜˜ ˜˜˜˜˜˜ ˜˜˜ ˜˜˜˜˜˜.
   */
  const ph = panelHint && String(panelHint).trim() ? String(panelHint).trim() : '';
  const playingFrag = panelFragmentForMusicUi(gid);
  let effectiveHint;
  if (ph.startsWith('˜ ˜˜˜˜˜˜˜:') && playingFrag) {
    effectiveHint = playingFrag;
  } else if (ph) {
    effectiveHint = ph;
  } else {
    effectiveHint = playingFrag;
  }
  await ensureSessionPanel(gid, chId, effectiveHint);

  await interaction.deleteReply().catch(() => {});
}

// --- ˜˜˜˜˜˜˜˜˜˜ ˜˜˜˜˜˜˜˜ (˜˜˜˜˜˜˜˜˜˜ ˜˜ initMusicUi) -------------------------

async function _notifyAutoplaySpawned(guildId, items) {
  const id = String(guildId);
  const session = sessionQueueByGuild.get(id);
  const panel = sessionPanelByGuild.get(id);
  const channelId = session?.channelId ?? panel?.channelId;
  if (!channelId) return;

  const first = items[0];
  let title = String(first?.title ?? '').slice(0, 100);
  if (first?.url) {
    try {
      const canon = await resolveYoutubeCanonicalTitle(first.url, first.title);
      if (canon) title = canon.slice(0, 100);
    } catch {
      /* ˜˜˜˜˜˜˜˜˜ title ˜˜ ˜˜˜˜˜˜ */
    }
  }
  await appendToSessionQueue(id, channelId, [formatAutoplayQueueLine(title)], 'autoplay');
  const line = `notify appended "${title.slice(0, 50)}"`;
  if (isPlaybackMetricsEnabled()) {
    logMusicUiLine(line);
  } else {
    console.log(`[autoplay] ${line}`);
  }
}

// --- Test-only API ---------------------------------------------------------

/** @internal */
export const __test__ = {
  reset() {
    sessionQueueByGuild.clear();
    sessionPanelByGuild.clear();
    pendingSingleIdsByGuild.clear();
    _nextSingleTagId = 1;
  },
  setClient(client) { cl = client; },
  getQueueState(guildId) { return sessionQueueByGuild.get(String(guildId)); },
  getPendingIds(guildId) { return [...(pendingSingleIdsByGuild.get(String(guildId)) ?? [])]; },
  /** Seed queue state without touching Discord API. */
  seedQueueState(guildId, state) {
    sessionQueueByGuild.set(String(guildId), state);
  },
  async triggerReplace(guildId, realLabel) {
    return _replacePendingSingleLineWithLabel(guildId, realLabel);
  },
};
