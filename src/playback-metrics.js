/**
 * METRICS:TXT — единая запись наблюдаемости в bot/data/metrics/*.txt (append-only).
 * Выкл. полностью: METRICS_TXT_ENABLED=0 (тогда baseline/debug смотрите в stdout по старым флагам).
 *
 * Файлы и роли (без дублирования с консолью при METRICS_TXT_ENABLED≠0):
 *   queue-list.txt      — постановка в очередь (URL/запрос, заголовок)
 *   skips.txt           — скипы (обычный / quick)
 *   session-tracks.txt  — старт треков, тайминг сессии / усталость
 *   autoplay-spawn.txt  — итог спавна автоплея (Groq trace, запросы, outcome)
 *   baseline.txt        — AUTOPLAY_BASELINE_LOG: spawn_end, idle_to_play, abort, stream_fail
 *   playability.txt     — AUTOPLAY_PLAYABILITY_CACHE_SHADOW: shadow_put, soft_ok
 *   bridge.txt          — мост рекомендаций (hints, ошибки boost/сервера)
 *   autoplay-debug.txt  — AUTOPLAY_DEBUG: стадии autoplayDebug + groq_stage + stale guard
 *   music-ui.txt        — дописывание строки автоплея в список Discord
 *
 * Док: docs/НАБЛЮДАЕМОСТЬ.md
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_DIR = join(__dirname, '..', 'data', 'metrics');

function isEnabled() {
  return process.env.METRICS_TXT_ENABLED !== '0';
}

function quickSkipMs() {
  return Math.max(1000, Number(process.env.MUSIC_QUICK_SKIP_MS) || 5000);
}

function ts() {
  return new Date().toISOString();
}

function safeJson(obj, max = 12000) {
  try {
    const s = JSON.stringify(obj);
    return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length}]`;
  } catch {
    return String(obj);
  }
}

async function appendFileLine(filename, line) {
  if (!isEnabled()) return;
  try {
    await mkdir(METRICS_DIR, { recursive: true });
    await appendFile(join(METRICS_DIR, filename), `${line}\n`, 'utf8');
  } catch (e) {
    console.warn('[playback-metrics]', e instanceof Error ? e.message : e);
  }
}

/**
 * @param {{ guildId: string, urlOrQuery: string, title: string, source: string, resolvedWatchUrl?: string | null }} p
 */
export function logQueueAdd(p) {
  const gid = String(p.guildId);
  const resolved = p.resolvedWatchUrl ? ` resolved=${p.resolvedWatchUrl}` : '';
  void appendFileLine(
    'queue-list.txt',
    `${ts()} guild=${gid} source=${p.source} urlOrQuery=${safeJson(p.urlOrQuery)} title=${safeJson(p.title)}${resolved}`,
  );
}

/**
 * @param {{ guildId: string, url: string, title: string, source: string | null, elapsedMs: number | null, quickThresholdMs: number }} p
 */
export function logSkip(p) {
  const kind =
    p.elapsedMs == null ? 'skip_unknown_timing' : p.elapsedMs < p.quickThresholdMs ? 'quick_skip' : 'skip';
  void appendFileLine(
    'skips.txt',
    `${ts()} guild=${p.guildId} kind=${kind} elapsedMs=${p.elapsedMs ?? 'null'} thresholdMs=${p.quickThresholdMs} source=${p.source ?? ''} url=${safeJson(p.url)} title=${safeJson(p.title)}`,
  );
}

/** @type {Map<string, { sessionStart: number, trackIndex: number, lastTrackStart: number }>} */
const sessionByGuild = new Map();

export function resetPlaybackMetricsSession(guildId) {
  sessionByGuild.delete(String(guildId));
}

/**
 * @param {{ guildId: string, url: string, title: string, source: string | null }} p
 */
export function logTrackStarted(p) {
  const id = String(p.guildId);
  const now = Date.now();
  let st = sessionByGuild.get(id);
  if (!st) {
    st = { sessionStart: now, trackIndex: 0, lastTrackStart: now };
    sessionByGuild.set(id, st);
  }
  st.trackIndex += 1;
  const sinceSession = now - st.sessionStart;
  const sincePrev = st.trackIndex <= 1 ? 0 : now - st.lastTrackStart;
  st.lastTrackStart = now;
  void appendFileLine(
    'session-tracks.txt',
    `${ts()} guild=${id} track#=${st.trackIndex} sinceSessionMs=${sinceSession} sincePrevTrackMs=${sincePrev} source=${p.source ?? ''} url=${safeJson(p.url)} title=${safeJson(p.title)}`,
  );
}

/**
 * @param {{ guildId: string, outcome: string, usedToken?: string, allQueries?: string[], telemetry?: Record<string, unknown>, policyMeta?: unknown, groqTrace?: unknown, pickedTitle?: string | null, pickedUrl?: string | null, pickedQueryIdx?: number | null, [k: string]: unknown }} p
 */
export function logAutoplaySpawn(p) {
  const {
    guildId,
    outcome,
    usedToken,
    allQueries,
    telemetry,
    policyMeta,
    groqTrace,
    pickedTitle,
    pickedUrl,
    pickedQueryIdx,
    ...rest
  } = p;
  const base = {
    guildId,
    outcome,
    usedToken,
    allQueries,
    telemetry: telemetry ?? {},
    policyMeta: policyMeta ?? null,
    groqTrace: groqTrace ?? null,
    picked:
      pickedTitle != null && String(pickedTitle).length > 0
        ? { title: pickedTitle, url: pickedUrl ?? null, queryIdx: pickedQueryIdx ?? null }
        : null,
    ...rest,
  };
  void appendFileLine('autoplay-spawn.txt', `${ts()} ${safeJson(base)}`);
}

/** Baseline JSON (AUTOPLAY_BASELINE_LOG) — дублирует смысл бывшего stdout [autoplay:baseline]. */
export function logBaselineJson(obj) {
  void appendFileLine('baseline.txt', `${ts()} ${safeJson(obj)}`);
}

/** Shadow / soft_ok кэша воспроизводимости. */
export function logPlayabilityJson(obj) {
  void appendFileLine('playability.txt', `${ts()} ${safeJson(obj)}`);
}

/** Мост: hints, ошибки HTTP, boost. */
export function logBridgeLine(message) {
  void appendFileLine('bridge.txt', `${ts()} ${message}`);
}

/** autoplayDebug (AUTOPLAY_DEBUG), одна строка на событие. */
export function logAutoplayDebugLine(guildId, stage, meta = null) {
  const line =
    meta == null
      ? `${ts()} guild=${guildId} stage=${stage}`
      : `${ts()} guild=${guildId} stage=${stage} ${safeJson(meta)}`;
  void appendFileLine('autoplay-debug.txt', line);
}

/** groq.js — формы промптов автоплея. */
export function logAutoplayGroqDebugLine(stage, meta) {
  void appendFileLine('autoplay-debug.txt', `${ts()} groq_stage=${stage} ${safeJson(meta)}`);
}

/** stale guard — отброс устаревшего spawn. */
export function logStaleGuardLine(payload) {
  void appendFileLine('autoplay-debug.txt', `${ts()} stale ${safeJson(payload)}`);
}

/** UI: строка в списке очереди при автоспавне. */
export function logMusicUiLine(message) {
  void appendFileLine('music-ui.txt', `${ts()} ${message}`);
}

/**
 * Shadow-режим classifier'а (Шаг 1 рефакторинга): записывает пары input→result
 * параллельно со старой эвристикой stderr в music.js. См. docs/ПЛАН-РЕФАКТОРИНГА.md.
 *
 * @param {{
 *   guildId: string,
 *   url: string,
 *   input: import('./stream-error-classifier.js').ClassifyInput,
 *   result: import('./stream-error-classifier.js').ClassifyResult,
 * }} p
 */
export function logClassifierShadow(p) {
  const line = {
    guildId: p.guildId,
    url: p.url,
    source: p.input.source,
    phase: p.input.phase,
    processCode: p.input.processCode,
    signal: p.input.signal,
    linePreview: p.input.line ? String(p.input.line).slice(0, 300).replace(/\s+/g, ' ') : null,
    severity: p.result.severity,
    fatalClass: p.result.fatalClass,
    reason: p.result.reason,
  };
  void appendFileLine('classifier-shadow.txt', `${ts()} ${safeJson(line)}`);
}

/**
 * Production-лог завершения стрима (Шаг 6c-b рефакторинга): записывает
 * типизированный `EndReason` + snapshot `StreamHandle` для диагностики.
 *
 * До 6c-b назывался `logStreamHandleShadow` и писал `legacy` + `diverged`
 * для сравнения с эвристикой `s.ytdlpStreamError`. Теперь handle —
 * единственный источник истины; legacy-поля удалены.
 *
 * @param {{
 *   guildId: string,
 *   url: string,
 *   endReason: import('./stream-handle.js').EndReason,
 *   snapshot: ReturnType<import('./stream-handle.js').StreamHandle['snapshot']>,
 * }} p
 */
export function logStreamEnd(p) {
  const line = {
    guildId: p.guildId,
    url: p.url,
    endReason: p.endReason,
    phase: p.snapshot.phase,
    accumulatedPlayingMs: p.snapshot.accumulatedPlayingMs,
    cancelled: p.snapshot.cancelled,
    pendingFatal: p.snapshot.pendingFatal,
    procs: {
      ytdlp: {
        closed: p.snapshot.procs.ytdlp.closed,
        code: p.snapshot.procs.ytdlp.code,
        signal: p.snapshot.procs.ytdlp.signal,
      },
      ffmpeg: {
        closed: p.snapshot.procs.ffmpeg.closed,
        code: p.snapshot.procs.ffmpeg.code,
        signal: p.snapshot.procs.ffmpeg.signal,
      },
    },
  };
  void appendFileLine('stream-end.txt', `${ts()} ${safeJson(line)}`);
}

export function isPlaybackMetricsEnabled() {
  return isEnabled();
}

export function getQuickSkipThresholdMs() {
  return quickSkipMs();
}
