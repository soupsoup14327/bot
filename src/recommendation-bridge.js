/**
 * METRICS:BRIDGE — при METRICS_TXT≠0 → data/metrics/bridge.txt; иначе stdout [bridge]
 * Док: docs/НАБЛЮДАЕМОСТЬ.md §1
 *
 * recommendation-bridge.js
 * Слой между сигналами плеера и поиском YouTube.
 *
 * Два независимых режима (оба fail-open, не блокируют плеер):
 *
 *   1. LOCAL BOOST (работает всегда, без сервера)
 *      Читает buildSignalStats → перевзвешивает кандидатов из pickDistinctTrackVideos:
 *        • finished >> skipped (дослушал = хороший трек)
 *        • started  but NOT finished = слабый позитив (началось, но вышли)
 *        • repeated skips = жёсткий минус
 *
 *   2. SERVER SYNC (opt-in, fire-and-forget)
 *      При MUSIC_SIGNALS_ENDPOINT — отправляет пачку событий на внешний сервер.
 *      Ответ игнорируется: fail → тихий warn, не влияет на воспроизведение.
 *      В ответе сервер может вернуть { queryHints: string[] } — подмешиваются к Groq.
 *
 * Публичное API:
 *   isBridgeEnabled()                    → bool
 *   applyLocalBoost(guildId, videos)     → те же объекты, переставленные по сигналам
 *   getPositiveContext(guildId, limit)   → string[] — заголовки дослушанных треков
 *   syncAndGetHints(guildId)             → Promise<string[]> — query-hints от сервера (или [])
 *
 * Переменные окружения:
 *   MUSIC_BRIDGE_ENABLED=1              — 0 выключает весь мост (local + server)
 *   MUSIC_SIGNALS_ENDPOINT=https://...  — URL сервера сигналов (без него — только local)
 *   MUSIC_SIGNALS_API_KEY=...           — Bearer-токен для сервера
 *   MUSIC_BRIDGE_SERVER_TIMEOUT_MS=4000 — таймаут запроса к серверу
 */

import { isPlaybackMetricsEnabled, logBridgeLine } from './playback-metrics.js';
import { buildSignalStats, getSignalsByType, getQuickSkippedTitles } from './music-signals.js';

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

export function isBridgeEnabled() {
  return process.env.MUSIC_BRIDGE_ENABLED !== '0';
}

function getServerEndpoint() {
  return process.env.MUSIC_SIGNALS_ENDPOINT?.trim() || null;
}

function getServerTimeout() {
  const t = Number(process.env.MUSIC_BRIDGE_SERVER_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 4_000;
}

// ---------------------------------------------------------------------------
// 1. LOCAL BOOST
// ---------------------------------------------------------------------------

/**
 * Скоринговая дельта на основе сигналов.
 * finish >> start-without-finish >> neutral >> skip >> quickSkip.
 *
 * Note: liked weight removed — likes are now in the DB (favorites table), not
 * in the in-memory signal buffer. The recommendation layer will boost liked
 * tracks separately once the DB query path is wired up.
 *
 * @param {{ started: number, finished: number, skipped: number, quickSkipped: number }} stat
 */
function signalDelta(stat) {
  let delta = 0;
  delta += stat.finished    * 30;   // дослушал до конца — сильный позитив
  /** Начал, но не закончил: слабый позитив (лучше пустоты, но хуже finished). */
  const startedWithoutFinish = Math.max(0, stat.started - stat.finished - stat.skipped);
  delta += startedWithoutFinish * 8;
  delta -= stat.skipped     * 25;   // обычный скип — «не то»
  /**
   * Быстрый скип (< QUICK_SKIP_MS) — самый чёткий сигнал «точно не то».
   * Штраф больше обычного: трек даже не дали шанса, значит что-то резко не понравилось.
   * quickSkipped уже входит в skipped, поэтому добавляем только разницу.
   */
  delta -= stat.quickSkipped * 18;
  return delta;
}

/**
 * Применяет локальный boost к кандидатам из pickDistinctTrackVideos.
 * Fail-open: любое исключение → возвращает оригинальный массив без изменений.
 *
 * @template {{ url: string, title: string }} T
 * @param {string} guildId
 * @param {T[]} videos  — уже отранжированные кандидаты (лучшие первыми)
 * @returns {T[]}
 */
export function applyLocalBoost(guildId, videos) {
  if (!isBridgeEnabled() || !videos.length) return videos;
  try {
    const stats = buildSignalStats(String(guildId));
    if (stats.size === 0) return videos;

    const emptyStat = { started: 0, finished: 0, skipped: 0, quickSkipped: 0 };
    const scored = videos.map((v, originalRank) => ({
      v,
      score: -(originalRank * 10) + signalDelta(stats.get(v.url) ?? emptyStat),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.v);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isPlaybackMetricsEnabled()) {
      logBridgeLine(`WARN applyLocalBoost: ${msg}`);
    } else {
      console.warn('[bridge] applyLocalBoost error (fallback to original)', msg);
    }
    return videos;
  }
}

/**
 * Заголовки треков, которые пользователь дослушал до конца за сессию.
 * Используются как подсказка для Groq: «продолжай в этом направлении».
 *
 * @param {string} guildId
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getPositiveContext(guildId, limit = 6) {
  if (!isBridgeEnabled()) return [];
  try {
    const finished = getSignalsByType(String(guildId), 'track_finished', limit);
    return finished.map((e) => e.title).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Заголовки треков, скипнутых в первые QUICK_SKIP_MS — сильный сигнал «мимо».
 * Передаётся в Groq автоплея как `negativeContext` (если не выключено в groq.js).
 *
 * @param {string} guildId
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getNegativeContext(guildId, limit = 6) {
  if (!isBridgeEnabled()) return [];
  try {
    const id = String(guildId);
    const raw = getQuickSkippedTitles(id, Math.max(limit * 3, limit)).filter(Boolean);
    /** Уплотняем похожие заголовки: сохраняем рецентность, убираем шумный повтор одной формулировки. */
    const out = [];
    const seenCount = new Map();
    for (const title of raw) {
      const key = String(title)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!key) continue;
      const prefix = key.split(' ').slice(0, 4).join(' ');
      const c = seenCount.get(prefix) ?? 0;
      /** Сохраняем максимум 2 повторения префикса — это помогает policy видеть серию quick-skip. */
      if (c >= 2) continue;
      seenCount.set(prefix, c + 1);
      out.push(title);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. SERVER SYNC (fire-and-forget; только если MUSIC_SIGNALS_ENDPOINT задан)
// ---------------------------------------------------------------------------

/**
 * Отправляет накопленные сигналы на внешний сервер и возвращает query-hints.
 * Fail-open: любая ошибка → [] без брошенного исключения.
 *
 * Протокол:
 *   POST MUSIC_SIGNALS_ENDPOINT
 *   Body: { guildId, events: SignalEvent[] }
 *   Ответ (опционально): { queryHints?: string[] }
 *
 * @param {string} guildId
 * @returns {Promise<string[]>}
 */
export async function syncAndGetHints(guildId) {
  const endpoint = getServerEndpoint();
  if (!isBridgeEnabled() || !endpoint) return [];

  const id = String(guildId);
  try {
    const stats = buildSignalStats(id);
    if (stats.size === 0) return [];

    /** Сериализуем stats в массив для передачи серверу. */
    const events = Array.from(stats.entries()).map(([url, s]) => ({ url, ...s }));

    const apiKey = process.env.MUSIC_SIGNALS_API_KEY?.trim() || '';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ guildId: id, events }),
      signal: AbortSignal.timeout(getServerTimeout()),
    });

    if (!res.ok) {
      if (isPlaybackMetricsEnabled()) {
        logBridgeLine(`WARN server HTTP ${res.status}`);
      } else {
        console.warn(`[bridge] server responded ${res.status}`);
      }
      return [];
    }

    const data = await res.json().catch(() => ({}));
    const hints = Array.isArray(data?.queryHints) ? data.queryHints.filter((h) => typeof h === 'string' && h.trim()) : [];
    if (hints.length) {
      const line = `hints: ${hints.join(' | ')}`;
      if (isPlaybackMetricsEnabled()) {
        logBridgeLine(line);
      } else {
        console.log(`[bridge] server hints: ${hints.join(' | ')}`);
      }
    }
    return hints;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isPlaybackMetricsEnabled()) {
      logBridgeLine(`WARN syncAndGetHints: ${msg}`);
    } else {
      console.warn('[bridge] syncAndGetHints failed (no impact on playback)', msg);
    }
    return [];
  }
}
