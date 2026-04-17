/**
 * Дописывание строки автоплея в список: при METRICS_TXT=1 → data/metrics/music-ui.txt; иначе console.
 * Док: docs/НАБЛЮДАЕМОСТЬ.md
 *
 * music-panel.js — сессионный UI музыкального плеера.
 *
 * Отвечает за:
 *  - единственное сообщение-список (Список:) на гильдию
 *  - единственное сообщение-панель с кнопками на гильдию
 *  - синхронизацию контента при смене трека, idle, autoplay
 *  - placeholder-replace: raw-query строка → реальное название трека
 *    при старте воспроизведения (через QueueEntry.tag)
 *
 * Инициализация: вызови initMusicUi(client) до регистрации обработчиков.
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

/** Инициализирует модуль клиентом Discord. */
export function initMusicUi(client) {
  cl = client;

  setOnMusicForceStop((guildId) => {
    void deleteAllMusicUi(guildId);
  });
  setOnPlayingTrackDisplay((guildId, label) => {
    // PlayerState уже PLAYING (выставлен music.js).
    // Сначала — replace placeholder в списке (raw query → реальное название),
    // затем общий refresh панели.
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
    // Переходное состояние (LOADING): fire-and-forget, не через очередь.
    // Иначе обновление выполнится после того как стейт уже PLAYING и LOADING не покажется.
    immediateRefreshPanel(guildId);
  });
}

// --- Утилиты ----------------------------------------------------------------

const MAX_MSG = 2000;

function _clip(s) {
  return s.length <= MAX_MSG ? s : `${s.slice(0, MAX_MSG - 1)}…`;
}

function _safeLine(s, max = 380) {
  return String(s).replace(/@/g, '@\u200b').trim().slice(0, max);
}

// --- Состояние ------------------------------------------------------------

/**
 * @typedef {{ type: 'single', id: number, addedBy: string | null }} SingleTag
 * @typedef {'user' | 'autoplay' | null} QueueEntrySource
 * @typedef {{ text: string, tag: SingleTag | null, source: QueueEntrySource }} QueueEntry
 *
 * Note on `source` (WP8a prep):
 *   Tracks origin of each queue entry. Currently only used as metadata —
 *   UI renders all entries uniformly. Prepared for the upcoming recommender
 *   UX (Apple-Music-style "Up Next" preview) where user-added and
 *   recommender-produced entries will be visually distinguished or split
 *   into sections. Keeping the field now lets us attach source at insertion
 *   time across many call sites; the UI change becomes a local render diff
 *   instead of a cross-cutting migration.
 */

/**
 * Factory for queue entries — centralises defaults so a future `source` or
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
 * Единственное сессионное сообщение-список очереди на гильдию.
 *
 * lines — типизированные записи. Поле `tag` нужно для надёжного
 * placeholder-replace: строка с raw query получает уникальный
 * tag.id; при старте воспроизведения находим её по id (не по тексту)
 * и заменяем на реальное название. Устойчиво к дубликатам
 * raw-query и MAX_QUEUE_LINES-эвикции.
 *
 * @type {Map<string, { channelId: string, messageId: string, lines: QueueEntry[] }>}
 */
const sessionQueueByGuild = new Map();

/**
 * FIFO-очередь id'шек ожидающих placeholder-replace на guild.
 * Треки стартуют в порядке добавления, registerPendingSingleLine
 * вызывается в том же порядке — FIFO-порядок гарантирован.
 *
 * @type {Map<string, number[]>}
 */
const pendingSingleIdsByGuild = new Map();

/** Monotonic counter for unique placeholder tag ids. */
let _nextSingleTagId = 1;

/** Единственное сообщение-панель с кнопками на гильдию. */
/** @type {Map<string, { channelId: string, messageId: string }>} */
const sessionPanelByGuild = new Map();

/** Максимум строк в очереди (скользящее окно при переполнении). */
const MAX_QUEUE_LINES = 25;

/** Тексты статуса панели — один источник для контента и fragment. */
const PANEL_LOADING = 'Загрузка трека…';
const PANEL_IDLE = 'Сейчас ничего не воспроизводится.';
const PANEL_AUTOPLAY_WAIT = 'Подбираем следующий трек…';
const PANEL_AUTOPLAY_ERROR = 'Автоподбор ничего не нашёл. Добавь трек вручную.';
const PANEL_PAUSE_FALLBACK = 'На паузе.';

/**
 * Зарегистрировать placeholder. Находит в session.lines первую
 * UNTAGGED запись с text === placeholderText, навешивает тег.
 * id тега идёт в FIFO-очередь pendingSingleIdsByGuild.
 *
 * ДОЛЖНО вызываться ПОСЛЕ того как строка уже попала в
 * lines (через addTracksAndUpdateUI → appendToSessionQueue).
 *
 * Если untagged-совпадения нет (например, строка была
 * panelHint) — тег не регистрируем.
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
 * Резолвит статус-строку панели по PlayerState + StatusReason.
 * Единственный switch — логика состояний здесь не дублируется.
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
      // Матрица (autoplay, statusReason):
      //   autoplay ON  + AUTOPLAY_ERROR → «Автоподбор ничего не нашёл»
      //   autoplay ON  + no error       → «Подбираем следующий трек…»
      //   autoplay OFF                  → PANEL_IDLE
      if (ts?.autoplay) {
        return statusReason === StatusReason.AUTOPLAY_ERROR
          ? PANEL_AUTOPLAY_ERROR
          : PANEL_AUTOPLAY_WAIT;
      }
      return PANEL_IDLE;
    }

    case PlayerState.PAUSED:
      // Fallback: _panelContent обычно показывает «На паузе: X»,
      // сюда приходим только если label потерялся.
      return PANEL_PAUSE_FALLBACK;

    default:
      return PANEL_IDLE;
  }
}

/**
 * Label текущего трека с fallback-цепочкой:
 *   getRepeatableTrackLabel → currentPlayingLabelByGuild → null.
 * Редкая гонка: PAUSED/PLAYING без записанного label —
 * fallback на прямое чтение Map.
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

// --- Строители контента ------------------------------------------------

/** @param {QueueEntry[]} entries */
function _buildQueueContent(entries) {
  return _clip('**Список:**\n' + entries.map((e) => e.text).join('\n') + '\n\u200b');
}

function _panelContent(guildId) {
  if (!guildId) return _safeLine(_clip(PANEL_IDLE), 2000);
  const { playerState } = resolvePlayerUIState(guildId);

  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = _resolveActiveLabel(guildId);
    if (label != null) {
      const info = getCurrentPlaybackInfo(guildId);
      const prefix = playerState === PlayerState.PAUSED ? 'На паузе: ' : 'Сейчас играет: ';
      const queueFrag = info?.queueDepth > 0 ? ` · ещё ${info.queueDepth} в очереди` : '';
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

// --- Публичное API -----------------------------------------------------------

/**
 * Добавляет строки в сессионное сообщение очереди.
 * Если сообщения ещё нет — создаёт; если есть — редактирует.
 *
 * @param {string} guildId
 * @param {string} channelId
 * @param {QueueEntrySource} [source=null] - origin metadata (WP8a prep)
 * @param {string[]} newLines — сырые тексты, оборачиваются в untagged entries
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
 * Обновляет или создаёт сессионную панель с кнопками.
 * Если панель уже есть — редактирует на месте. Иначе — отправляет.
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

/** Удаляет сессионные сообщения (список + панель) из Discord и очищает стейт. */
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
 * Заменить placeholder-строку на настоящее название
 * трека. Вызывается из onPlayingTrackDisplay.
 *
 * Алгоритм:
 *   1. Поп первый id из pendingSingleIdsByGuild (FIFO).
 *   2. Найти в session.lines запись с tag.id === popped.
 *      Если нет — строку эвикнул MAX_QUEUE_LINES или
 *      удалил deleteAllMusicUi — no-op.
 *   3. Заменить text на formatSingleQueueLine(realLabel, { addedBy }),
 *      снять tag (запись становится «обычной»).
 *   4. Отредактировать Discord-сообщение.
 *
 * Устойчиво к дубликатам raw-query и гонкам FIFO:
 * ищем по уникальному числовому tag.id, не по тексту.
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
 * Обновляет кнопки/контент на сообщении панели по interaction
 * (после deferUpdate). Ставит редактирование в очередь
 * — предотвращает гонку с фоновыми refreshSessionPanelFromState.
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
 * Общая логика перечитывания панели из Discord и редактирования
 * по актуальному стейту.
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
 * Перечитывает и обновляет панель без очереди — для переходных
 * состояний (LOADING). Fire-and-forget: стейт читается раньше,
 * чем может поменяться с LOADING на PLAYING.
 */
function immediateRefreshPanel(guildId) {
  void _doRefreshPanelAsync(String(guildId)).catch((e) => console.warn('[music] refresh panel', e));
}

/**
 * Перечитывает панель через очередь — для финальных состояний
 * (PLAYING, IDLE). Очередь защищает от гонок с syncInteractionMusicPanel.
 */
function refreshSessionPanelFromState(guildId) {
  const id = String(guildId);
  schedulePanelUpdate(id, () => _doRefreshPanelAsync(id).catch((e) => console.warn('[music] refresh panel', e)));
}

/** Очередь доиграла / смена состояния — перерисовать панель. */
export function applyIdleMusicUi(guildId) {
  if (sessionPanelByGuild.has(String(guildId))) {
    refreshSessionPanelFromState(guildId);
  }
}

/**
 * Фрагмент для панели: текущий трек или статус-строка.
 */
export function panelFragmentForMusicUi(guildId, fallback = '') {
  if (guildId == null) return fallback;
  const { playerState } = resolvePlayerUIState(guildId);
  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = _resolveActiveLabel(guildId);
    if (label != null) {
      const prefix = playerState === PlayerState.PAUSED ? 'На паузе: ' : 'Сейчас играет: ';
      return `${prefix}**${_safeLine(String(label), 200)}**`;
    }
  }
  return _panelStatusLine(guildId);
}

/**
 * Добавляет треки в сессионный список и обновляет панель.
 * Эфемерный ответ на interaction сразу удаляется (список
 * обновился визуально).
 */
export async function addTracksAndUpdateUI(interaction, queueLines, panelHint) {
  const gid = interaction.guildId;
  const chId = interaction.channelId;
  if (!gid || !chId) return;

  await appendToSessionQueue(gid, chId, queueLines, 'user');

  /**
   * Панель всегда показывает «сейчас играет», если что-то играет.
   * Подсказка «В очереди: …» только для списка.
   */
  const ph = panelHint && String(panelHint).trim() ? String(panelHint).trim() : '';
  const playingFrag = panelFragmentForMusicUi(gid);
  let effectiveHint;
  if (ph.startsWith('В очереди:') && playingFrag) {
    effectiveHint = playingFrag;
  } else if (ph) {
    effectiveHint = ph;
  } else {
    effectiveHint = playingFrag;
  }
  await ensureSessionPanel(gid, chId, effectiveHint);

  await interaction.deleteReply().catch(() => {});
}

// --- Внутренние коллбэки (вызываются из initMusicUi) -------------------------

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
      /* оставляем title из поиска */
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
