/**
 * Дописывание строки автоплея в список: при METRICS_TXT?0 > data/metrics/music-ui.txt; иначе console.
 * Док: docs/НАБЛЮДАЕМОСТЬ.md
 *
 * music-ui.js — сессионный UI музыкального плеера.
 *
 * Отвечает за:
 *  - единственное сообщение-список (Список:) на гильдию
 *  - единственное сообщение-панель с кнопками
 *  - синхронизацию контента при смене трека, idle, autoplay
 *
 * Инициализация: вызови initMusicUi(client) до регистрации коллбэков.
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
} from './guild-session-state.js';
import { formatAutoplayQueueLine } from './queue-line-format.js';
import { resolveYoutubeCanonicalTitle } from './youtube-search.js';

/** @type {import('discord.js').Client | null} */
let cl = null;

/** Инициализирует модуль клиентом Discord. Вызывать до регистрации обработчиков. */
export function initMusicUi(client) {
  cl = client;

  setOnMusicForceStop((guildId) => {
    void deleteAllMusicUi(guildId);
  });
  setOnPlayingTrackDisplay((guildId, _label) => {
    // PlayerState is already PLAYING (set by music.js before this callback fires).
    // _panelContent reads from resolvePlayerUIState — no need to pass label explicitly.
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

// --- Стейт ------------------------------------------------------------------

/**
 * Единственное сессионное сообщение-список очереди на гильдию.
 * @type {Map<string, {channelId:string, messageId:string, lines:string[]}>}
 */
const sessionQueueByGuild = new Map();

/**
 * Единственное сообщение-панель с кнопками на гильдию.
 * @type {Map<string, {channelId:string, messageId:string}>}
 */
const sessionPanelByGuild = new Map();

/** Максимум строк в очереди (скользящее окно при переполнении). */
const MAX_QUEUE_LINES = 25;

/** Тексты статуса панели — один источник для контента и fragment. */
const PANEL_LOADING = 'Загрузка трека…';
const PANEL_IDLE = 'Сейчас ничего не воспроизводится.';
const PANEL_AUTOPLAY_WAIT = 'Подбираем следующий трек…';

/**
 * Resolves the panel status line from PlayerState + StatusReason.
 * Single switch — music-ui.js never re-derives state logic itself.
 * @param {string} guildId
 * @returns {string}
 */
function _panelStatusLine(guildId) {
  const { playerState, statusReason } = resolvePlayerUIState(guildId);
  switch (playerState) {
    case PlayerState.LOADING:
      return PANEL_LOADING;
    case PlayerState.IDLE_EXHAUSTED:
      if (statusReason === StatusReason.AUTOPLAY_ERROR) {
        // Show "searching…" only while autoplay is actually on.
        // If user turned autoplay off mid-spawn, state may still carry AUTOPLAY_ERROR — fall back to idle.
        const ts = getMusicTransportState(guildId);
        return ts?.autoplay ? PANEL_AUTOPLAY_WAIT : PANEL_IDLE;
      }
      return PANEL_IDLE;
    case PlayerState.PAUSED:
      return PANEL_IDLE; // fallback — actual content shown separately when paused+label available
    default:
      return PANEL_IDLE;
  }
}

// --- Строители контента ------------------------------------------------------

function _buildQueueContent(lines) {
  return _clip('**Список:**\n' + lines.join('\n') + '\n\u200b');
}

function _panelContent(guildId) {
  if (!guildId) return _safeLine(_clip(PANEL_IDLE), 2000);
  const { playerState } = resolvePlayerUIState(guildId);
  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = getRepeatableTrackLabel(guildId);
    if (label != null && String(label).trim()) {
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
 */
export async function appendToSessionQueue(guildId, channelId, newLines) {
  const id = String(guildId);
  const session = sessionQueueByGuild.get(id);

  if (session) {
    session.lines.push(...newLines);
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
      const lines = [...newLines].slice(-MAX_QUEUE_LINES);
      const msg = await ch.send({ content: _buildQueueContent(lines) });
      sessionQueueByGuild.set(id, { channelId, messageId: msg.id, lines });
    }
  } catch (e) {
    console.warn('[queue] create failed', e);
  }
}

/**
 * Обновляет или создаёт сессионную панель с кнопками.
 * Если панель уже есть — редактирует на месте. Если нет — отправляет новую.
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
  for (const ref of [queue, panel].filter(Boolean)) {
    try {
      const ch = await cl.channels.fetch(ref.channelId).catch(() => null);
      if (ch?.isTextBased()) await ch.messages.delete(ref.messageId).catch(() => {});
    } catch { /* ignore */ }
  }
}

/**
 * Обновляет кнопки/контент на сообщении панели по interaction (после deferUpdate).
 * Ставит редактирование в очередь — предотвращает гонку с фоновыми refreshSessionPanelFromState.
 * Стейт читается в момент выполнения, а не в момент вызова этой функции.
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
 * Общая логика перечитывания панели из Discord и редактирования по актуальному стейту.
 * Используется двумя путями с разным поведением очередизации (см. ниже).
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
 * Перечитывает и обновляет панель без очереди — для переходных состояний (LOADING).
 *
 * Почему без очереди:
 *   notifyPlaybackUiRefresh вызывается во время коротких переходных состояний (загрузка URL,
 *   поиск autoplay). Если эти обновления ставить в очередь, они могут выполниться ПОСЛЕ того,
 *   как playerState уже стал PLAYING — и переходное состояние пропадёт для пользователя.
 *   Fire-and-forget запускает fetch немедленно (~200-400ms), чтение стейта происходит раньше,
 *   чем он успевает поменяться с LOADING на PLAYING.
 */
function immediateRefreshPanel(guildId) {
  void _doRefreshPanelAsync(String(guildId)).catch((e) => console.warn('[music] refresh panel', e));
}

/**
 * Перечитывает панель через очередь — для финальных состояний (PLAYING, IDLE).
 *
 * Почему через очередь:
 *   Эти обновления инициируются фоново (трек начался / трек закончился) и могут гоняться
 *   с syncInteractionMusicPanel (нажатие кнопки). Очередь гарантирует последовательное
 *   применение: последнее актуальное состояние всегда побеждает, без перезаписей из прошлого.
 */
function refreshSessionPanelFromState(guildId) {
  const id = String(guildId);
  schedulePanelUpdate(id, () => _doRefreshPanelAsync(id).catch((e) => console.warn('[music] refresh panel', e)));
}

/** Очередь доиграла / смена состояния — перерисовать панель по актуальному стейту (idle / autoplay-wait / загрузка). */
export function applyIdleMusicUi(guildId) {
  if (sessionPanelByGuild.has(String(guildId))) {
    refreshSessionPanelFromState(guildId);
  }
}

/**
 * Возвращает текущий fragment для панели.
 * Если что-то играет — текущий трек; иначе загрузка / idle / ожидание автоплея; при guildId == null — fallback.
 */
export function panelFragmentForMusicUi(guildId, fallback = '') {
  if (guildId == null) return fallback;
  const { playerState } = resolvePlayerUIState(guildId);
  if (playerState === PlayerState.PLAYING || playerState === PlayerState.PAUSED) {
    const label = getRepeatableTrackLabel(guildId);
    if (label != null && String(label).trim()) {
      return `Сейчас играет: **${_safeLine(String(label), 200)}**`;
    }
  }
  return _panelStatusLine(guildId);
}

/**
 * Добавляет треки в сессионный список и обновляет панель.
 * Эфемерный ответ на interaction сразу удаляется (список обновился визуально).
 */
export async function addTracksAndUpdateUI(interaction, queueLines, panelHint) {
  const gid = interaction.guildId;
  const chId = interaction.channelId;
  if (!gid || !chId) return;

  await appendToSessionQueue(gid, chId, queueLines);

  /**
   * Панель всегда показывает «сейчас играет», если что-то играет.
   * Подсказка «В очереди: …» только для списка — не подменяет заголовок текущего трека.
   * Для первого трека enqueue отдаёт «Сейчас играет» — её используем.
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
  await appendToSessionQueue(id, channelId, [formatAutoplayQueueLine(title)]);
  const line = `notify appended "${title.slice(0, 50)}"`;
  if (isPlaybackMetricsEnabled()) {
    logMusicUiLine(line);
  } else {
    console.log(`[autoplay] ${line}`);
  }
}
