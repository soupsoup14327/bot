/**
 * METRICS:SIGNALS — буфер событий + data/signals.json (см. MUSIC_SIGNALS_*).
 * METRICS:TXT — при track_skipped дополнительно пишется skips.txt (playback-metrics.logSkip).
 * Док: docs/НАБЛЮДАЕМОСТЬ.md §6
 *
 * music-signals.js
 * In-memory шина событий воспроизведения — изолирована от логики плеера.
 *
 * Принципы:
 *   • Все emit — fire-and-forget (void), никогда не await из runPlayNext.
 *   • При MUSIC_SIGNALS_ENABLED=0 emit() — no-op, overhead минимален.
 *   • Буфер на гильдию, кольцевая ротация (BUFFER_CAP записей).
 *   • Модуль не знает о Discord, плеере или очереди — только данные.
 *
 * Персистентность (Шаг E):
 *   • При старте загружает буфер из data/signals.json (события за последние 24 ч).
 *   • После каждого emitSignal ставит debounced-таймер на 5 с и сохраняет.
 *   • При clearSignalBuffer сохраняет немедленно.
 *   • Все I/O — fail-open: ошибки пишутся в warn, не ломают плеер.
 *
 * Типы событий:
 *   track_started   — плеер начал воспроизведение
 *   track_finished  — трек доиграл естественно (Idle после playing)
 *   track_skipped   — пользователь нажал ⏭ или /пропустить
 *   track_previous  — пользователь нажал ⏮
 *
 * Переменные окружения:
 *   MUSIC_SIGNALS_ENABLED     — 1 (по умолчанию) | 0 — выключить буфер
 *   MUSIC_SIGNALS_BUFFER      — размер кольцевого буфера на гильдию (по умолчанию 100)
 *   MUSIC_QUICK_SKIP_MS       — мс, меньше которого скип считается «быстрым» (по умолчанию 5000)
 *   MUSIC_SIGNALS_MAX_AGE_H   — сколько часов хранить события на диске (по умолчанию 24)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getQuickSkipThresholdMs, logSkip } from './playback-metrics.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNALS_FILE = join(__dirname, '..', 'data', 'signals.json');

/** @type {number} */
const BUFFER_CAP = Math.max(10, Math.min(1000, Number(process.env.MUSIC_SIGNALS_BUFFER) || 100));

/**
 * Порог «быстрого скипа» в миллисекундах.
 * Если трек скипнули раньше этого момента — это сильный сигнал «не то».
 */
const QUICK_SKIP_MS = Math.max(1000, Number(process.env.MUSIC_QUICK_SKIP_MS) || 5_000);

/**
 * Максимальный возраст события для загрузки с диска.
 * События старше этого срока отбрасываются при старте.
 */
const MAX_AGE_MS = Math.max(
  60 * 60 * 1000, // минимум 1 час
  (Number(process.env.MUSIC_SIGNALS_MAX_AGE_H) || 24) * 60 * 60 * 1000,
);

/**
 * @typedef {'track_started' | 'track_finished' | 'track_skipped' | 'track_previous'} SignalType
 *
 * Attribution model:
 *   actor       — who performed the action (skip/previous = userId, started/finished = null)
 *   requestedBy — who originally queued the track (from QueueItem.requestedBy)
 *   triggeredBy — origin type of the track; replaces the old `source` field in SignalEvent
 *
 * @typedef {'user' | 'autoplay' | 'playlist' | 'navigation'} TriggeredBy
 *
 * @typedef {{
 *   type:           SignalType,
 *   guildId:        string,
 *   sessionId:      string | null,
 *   actor:          string | null,
 *   requestedBy:    string | null,
 *   triggeredBy:    TriggeredBy,
 *   spawnId:        string | null,
 *   listenersCount: number,
 *   url:            string,
 *   title:          string,
 *   timestamp:      number,
 *   elapsedMs:      number | null,
 * }} SignalEvent
 */

/**
 * Maps QueueItem.source to SignalEvent.triggeredBy.
 * @param {import('./queue-invariants.js').TrackSource | null | undefined} source
 * @returns {TriggeredBy}
 */
export function sourceToTriggeredBy(source) {
  if (source === 'autoplay')   return 'autoplay';
  if (source === 'navigation') return 'navigation';
  return 'user'; // 'single' or unknown → user-initiated
}

/** @type {Map<string, SignalEvent[]>} */
const bufferByGuild = new Map();

/**
 * @param {string} guildId
 * @param {unknown} raw
 * @returns {SignalEvent | null}
 */
function normalizeSignalEvent(guildId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = /** @type {Record<string, unknown>} */ (raw);
  if (typeof event.type !== 'string') return null;
  if (typeof event.url !== 'string') return null;
  if (typeof event.title !== 'string') return null;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return null;

  return {
    type: /** @type {SignalType} */ (event.type),
    guildId: String(event.guildId ?? guildId),
    sessionId: event.sessionId == null ? null : String(event.sessionId),
    actor: event.actor == null ? null : String(event.actor),
    requestedBy: event.requestedBy == null ? null : String(event.requestedBy),
    triggeredBy:
      event.triggeredBy === 'autoplay' ||
      event.triggeredBy === 'playlist' ||
      event.triggeredBy === 'navigation'
        ? event.triggeredBy
        : 'user',
    spawnId: event.spawnId == null ? null : String(event.spawnId),
    listenersCount: Math.max(0, Number(event.listenersCount) || 0),
    url: String(event.url),
    title: String(event.title),
    timestamp: Number(event.timestamp),
    elapsedMs:
      typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs)
        ? event.elapsedMs
        : null,
  };
}

// ─── Disk persistence ─────────────────────────────────────────────────────────

/**
 * Writes bufferByGuild to disk. Fail-open — errors are only logged.
 * Called after a debounce delay (via scheduleSave) or immediately on clearSignalBuffer.
 */
async function persistToDisk() {
  try {
    await mkdir(dirname(SIGNALS_FILE), { recursive: true });
    /** @type {Record<string, SignalEvent[]>} */
    const obj = {};
    for (const [guildId, events] of bufferByGuild) {
      if (events.length) obj[guildId] = events;
    }
    await writeFile(SIGNALS_FILE, JSON.stringify(obj), 'utf-8');
  } catch (e) {
    console.warn('[signals] persist failed:', e instanceof Error ? e.message : e);
  }
}

/** Debounce handle — we save at most once every 5 seconds under normal traffic. */
let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void persistToDisk();
  }, 5_000);
}

/**
 * Loads persisted events from disk on startup. Drops events older than MAX_AGE_MS.
 * Events with missing/malformed fields are normalized or skipped via normalizeSignalEvent.
 * Silently skips if the file doesn't exist (first run).
 */
async function loadFromDisk() {
  try {
    const raw = await readFile(SIGNALS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const cutoff = Date.now() - MAX_AGE_MS;
    let total = 0;
    for (const [guildId, events] of Object.entries(data)) {
      if (!Array.isArray(events)) continue;
      // Keep only events within the age window; enforce buffer cap
      const fresh = events
        .map((e) => normalizeSignalEvent(String(guildId), e))
        .filter((e) => e && e.timestamp >= cutoff);
      const capped = fresh.slice(-BUFFER_CAP);
      if (capped.length) {
        bufferByGuild.set(String(guildId), capped);
        total += capped.length;
      }
    }
    if (total > 0) console.log(`[signals] loaded ${total} event(s) for ${bufferByGuild.size} guild(s) from disk`);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      console.warn('[signals] load failed (starting fresh):', e instanceof Error ? e.message : e);
    }
  }
}

// Load persisted data immediately when the module is imported.
await loadFromDisk();

// ─── Public API ───────────────────────────────────────────────────────────────

/** Возвращает true если буфер сигналов включён (по умолчанию да). */
export function isSignalsEnabled() {
  return process.env.MUSIC_SIGNALS_ENABLED !== '0';
}

/**
 * Добавляет событие в кольцевой буфер гильдии.
 * Безопасен для вызова без await — не бросает.
 *
 * Persistence class: best_effort — autoplay engine reads only the in-memory
 * buffer; DB writes (analytics) happen separately and may fail silently.
 *
 * @param {SignalType} type
 * @param {{
 *   guildId:        string,
 *   sessionId?:     string | null,
 *   actor?:         string | null,
 *   requestedBy?:   string | null,
 *   triggeredBy?:   TriggeredBy,
 *   spawnId?:       string | null,
 *   listenersCount?: number,
 *   url:            string,
 *   title:          string,
 * }} payload
 */
export function emitSignal(type, {
  guildId,
  sessionId = null,
  actor = null,
  requestedBy = null,
  triggeredBy = 'user',
  spawnId = null,
  listenersCount = 0,
  url,
  title,
}) {
  if (!isSignalsEnabled()) return;
  const id = String(guildId);
  const buf = bufferByGuild.get(id) ?? [];
  const now = Date.now();

  /**
   * elapsedMs for track_skipped and track_finished:
   * Time since the last track_started event for the same URL.
   * - track_skipped: distinguishes quick-skip (< QUICK_SKIP_MS) from normal skip
   * - track_finished: used to compute listened_ratio for North star metric
   * - track_previous: noop (neutral signal, not used in scoring)
   */
  let elapsedMs = null;
  if (type === 'track_skipped' || type === 'track_finished') {
    const normUrl = String(url);
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].type === 'track_started' && buf[i].url === normUrl) {
        elapsedMs = now - buf[i].timestamp;
        break;
      }
    }
  }

  const normalized = normalizeSignalEvent(id, {
    type,
    guildId: id,
    sessionId: sessionId ? String(sessionId) : null,
    actor: actor ? String(actor) : null,
    requestedBy: requestedBy ? String(requestedBy) : null,
    triggeredBy,
    spawnId: spawnId ? String(spawnId) : null,
    listenersCount: Math.max(0, listenersCount),
    url: String(url),
    title: String(title),
    timestamp: now,
    elapsedMs,
  });
  if (!normalized) return;
  buf.push(normalized);
  /** Кольцевой буфер: убираем самые старые при переполнении. */
  if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
  bufferByGuild.set(id, buf);
  /** Schedule a debounced disk write (max once per 5 s under normal traffic). */
  scheduleSave();

  // METRICS:TXT skips.txt (см. playback-metrics)
  if (type === 'track_skipped') {
    void logSkip({
      guildId: id,
      url: String(url),
      title: String(title),
      source: triggeredBy,   // triggeredBy replaced source; metrics log accepts any string
      elapsedMs,
      quickThresholdMs: getQuickSkipThresholdMs(),
    });
  }
}

/**
 * Последние N событий гильдии (любых типов), от новых к старым.
 * Пока не используется другими модулями — задел под лайки и персональные рекомендации.
 * @param {string} guildId
 * @param {number} [limit]
 * @returns {SignalEvent[]}
 */
export function getRecentSignals(guildId, limit = 20) {
  const buf = bufferByGuild.get(String(guildId)) ?? [];
  return buf.slice(-Math.min(limit, buf.length)).reverse();
}

/**
 * Последние N событий указанного типа, от новых к старым.
 * @param {string} guildId
 * @param {SignalType} type
 * @param {number} [limit]
 * @returns {SignalEvent[]}
 */
export function getSignalsByType(guildId, type, limit = 20) {
  const buf = bufferByGuild.get(String(guildId)) ?? [];
  const filtered = buf.filter((e) => e.type === type);
  return filtered.slice(-Math.min(limit, filtered.length)).reverse();
}

/**
 * Очищает буфер гильдии (при stopAndLeave или выходе из голоса).
 * Сразу сбрасывает файл на диск (без дебаунса — данные меняются значительно).
 * @param {string} guildId
 */
export function clearSignalBuffer(guildId) {
  bufferByGuild.delete(String(guildId));
  // Cancel any pending debounced save and write immediately so the cleared
  // state is persisted even if the process exits shortly after.
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  void persistToDisk();
}

/**
 * Test helper: replace one guild buffer in memory without touching disk.
 * @param {string} guildId
 * @param {unknown[]} events
 */
export function __replaceSignalBufferForTests(guildId, events) {
  const id = String(guildId);
  const normalized = (Array.isArray(events) ? events : [])
    .map((e) => normalizeSignalEvent(id, e))
    .filter(Boolean)
    .slice(-BUFFER_CAP);
  bufferByGuild.set(id, normalized);
}

/**
 * Сводная статистика по последним сигналам гильдии — для recommendation-bridge.
 * Возвращает url → { started, finished, skipped, quickSkipped } счётчики.
 *
 * quickSkipped — скип произошёл раньше QUICK_SKIP_MS от старта трека (сильный негатив).
 * liked — удалён: лайки хранятся в favorites (DB), не в session buffer.
 *
 * @param {string} guildId
 * @returns {Map<string, { started: number, finished: number, skipped: number, quickSkipped: number }>}
 */
export function buildSignalStats(guildId) {
  const buf = bufferByGuild.get(String(guildId)) ?? [];
  /** @type {Map<string, { started: number, finished: number, skipped: number, quickSkipped: number }>} */
  const stats = new Map();
  for (const e of buf) {
    const s = stats.get(e.url) ?? { started: 0, finished: 0, skipped: 0, quickSkipped: 0 };
    if (e.type === 'track_started') s.started++;
    else if (e.type === 'track_finished') s.finished++;
    else if (e.type === 'track_skipped') {
      s.skipped++;
      if (e.elapsedMs !== null && e.elapsedMs < QUICK_SKIP_MS) s.quickSkipped++;
    }
    stats.set(e.url, s);
  }
  return stats;
}

/**
 * Миллисекунды между последним `track_started` для данного URL и «сейчас».
 * Возвращает null, если track_started не найден в буфере (напр., бот только
 * что стартанул и буфера нет, или трек уже вытеснен кольцом).
 *
 * Используется в `music.js::skip` чтобы отличить quick-skip от обычного skip
 * БЕЗ дублирования логики, живущей в `emitSignal`.
 *
 * @param {string} guildId
 * @param {string} url
 * @returns {number | null}
 */
export function getElapsedSinceLastStart(guildId, url) {
  const buf = bufferByGuild.get(String(guildId)) ?? [];
  const needle = String(url);
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].type === 'track_started' && buf[i].url === needle) {
      return Date.now() - buf[i].timestamp;
    }
  }
  return null;
}

/**
 * Заголовки треков которые были скипнуты в первые QUICK_SKIP_MS секунд — «точно не понравилось».
 * Используется recommendation-bridge для передачи Groq «негативного контекста».
 *
 * @param {string} guildId
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getQuickSkippedTitles(guildId, limit = 10) {
  const buf = bufferByGuild.get(String(guildId)) ?? [];
  const result = [];
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    const e = buf[i];
    if (e.type === 'track_skipped' && e.elapsedMs !== null && e.elapsedMs < QUICK_SKIP_MS && e.title) {
      result.push(e.title);
    }
  }
  return result;
}
