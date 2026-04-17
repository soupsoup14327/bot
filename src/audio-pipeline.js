/**
 * audio-pipeline.js
 *
 * Владелец создания стрим-ресурса для воспроизведения: yt-dlp процесс,
 * опциональный ffmpeg-normalize, yt-dlp semaphore, создание `AudioResource`,
 * и — самое главное — **wiring всех process-событий в StreamHandle**.
 *
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md, Шаг 3.
 *
 * Что этот модуль делает:
 *   1. Acquires слот семафора yt-dlp (лимит параллельных загрузок).
 *   2. Спавнит yt-dlp.
 *   3. Создаёт `StreamHandle` и подписывает его на process/stderr события yt-dlp.
 *   4. Если включён audio-normalize — спавнит ffmpeg и подписывает handle.
 *   5. Создаёт `AudioResource` для `@discordjs/voice`.
 *   6. Параллельно пишет classifier-shadow (pure observation).
 *
 * Что этот модуль НЕ делает (делает caller — `music.js`):
 *   - Не хранит ссылки на процессы — возвращает их caller'у, тот их держит
 *     для teardown (`killYtdlp`).
 *   - Не делает `VoiceConnection.subscribe(player)` — это зона voice-adapter.
 *   - Не пишет `stream-end.txt` — это делает caller через `logStreamEnd`
 *     в `handle.whenEnded.then(...)`.
 *
 * Pure относительно Discord: не импортирует `discord.js` / `@discordjs/voice`
 * как источник side-effects. `createAudioResource` использует `@discordjs/voice`,
 * но только как builder (без соединений/каналов).
 */

import { createAudioResource, StreamType } from '@discordjs/voice';
import youtubeDl from 'youtube-dl-exec';

import { isAudioNormalizeEnabled, spawnFfmpegNormalizeAfterYtdlp } from './audio-normalize.js';
import { StreamHandle } from './stream-handle.js';
import { classify as classifyStreamError } from './stream-error-classifier.js';
import { logClassifierShadow } from './playback-metrics.js';

// ─── yt-dlp semaphore ─────────────────────────────────────────────────────────
// Лимит параллельных процессов yt-dlp, чтобы не вычерпать ресурсы системы.
// Настраивается через MAX_CONCURRENT_YTDLP, по умолчанию 3.

const MAX_CONCURRENT_YTDLP = Math.max(1, Number(process.env.MAX_CONCURRENT_YTDLP) || 3);
let _ytdlpActive = 0;
/** @type {Array<() => void>} */
const _ytdlpQueue = [];

function acquireYtdlpSlot() {
  return new Promise((resolve) => {
    if (_ytdlpActive < MAX_CONCURRENT_YTDLP) {
      _ytdlpActive++;
      resolve();
    } else {
      _ytdlpQueue.push(resolve);
    }
  });
}

function releaseYtdlpSlot() {
  const next = _ytdlpQueue.shift();
  if (next) {
    next(); // передаём слот следующему в очереди, active не меняется
  } else {
    _ytdlpActive = Math.max(0, _ytdlpActive - 1);
  }
}

/**
 * Текущая загрузка семафора. Для диагностики / метрик.
 * @returns {{ active: number, max: number, queued: number }}
 */
export function getYtdlpSemaphoreState() {
  return { active: _ytdlpActive, max: MAX_CONCURRENT_YTDLP, queued: _ytdlpQueue.length };
}

/**
 * Spawn yt-dlp как длинный поток stdout аудио. Не привязан ни к какой guild/state —
 * caller отвечает за lifecycle процесса (kill, install в own state).
 *
 * @param {string} url
 */
function spawnYoutubeProcess(url) {
  return youtubeDl.exec(
    url,
    {
      output: '-',
      quiet: true,
      noWarnings: true,
      noPlaylist: true,
      format: 'bestaudio',
    },
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Одна попытка воспроизвести один URL.
 * Возвращает уже связанный `StreamHandle` + готовый `AudioResource` + process refs.
 *
 * Caller (music.js → player-controller):
 *   - сохраняет `ytdlpProc` / `ffmpegProc` в своём per-guild state для teardown;
 *   - использует `handle` для наблюдения за lifecycle (whenStable / whenEnded);
 *   - скармливает `resource` в `AudioPlayer.play(resource)`.
 *
 * Pipeline гарантирует:
 *   - yt-dlp слот будет освобождён ровно один раз (на close / error);
 *   - `handle.whenEnded` разрешится даже если ffmpeg не смог спавнить (artificial exit);
 *   - нет утечек listener'ов: они живут на тех же процессах что caller'ские.
 *
 * @param {{
 *   url: string,
 *   label?: string,
 *   normalizeEnabled?: boolean | null,
 *   stabilityWindowMs?: number,
 *   guildId?: string,
 * }} opts
 * @returns {Promise<{
 *   handle: StreamHandle,
 *   resource: import('@discordjs/voice').AudioResource,
 *   ytdlpProc: ReturnType<typeof spawnYoutubeProcess>,
 *   ffmpegProc: ReturnType<typeof spawnFfmpegNormalizeAfterYtdlp> | null,
 * }>}
 */
export async function createStream(opts) {
  const {
    url,
    label = '',
    normalizeEnabled = null,
    stabilityWindowMs = 2500,
    guildId = 'unknown',
  } = opts || {};
  if (!url || typeof url !== 'string') {
    throw new Error('audio-pipeline.createStream: url required');
  }

  const hasNormalize = normalizeEnabled == null ? isAudioNormalizeEnabled() : Boolean(normalizeEnabled);

  await acquireYtdlpSlot();
  const ytdlpProc = spawnYoutubeProcess(url);

  /** Подавляем unhandledRejection: youtube-dl-exec возвращает thenable ChildProcess, и когда
   *  мы убиваем его через killYtdlp, внутренний промис отклоняется с ChildProcessError(SIGKILL).
   *  Нам это не нужно — SIGKILL намеренный. */
  ytdlpProc.catch?.(() => {});

  // Семафор: освобождаем ровно один раз на первом из событий close/error.
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (!slotReleased) {
      slotReleased = true;
      releaseYtdlpSlot();
    }
  };
  ytdlpProc.on('close', releaseSlotOnce);
  ytdlpProc.on('error', releaseSlotOnce);

  /** @type {StreamHandle} */
  const handle = new StreamHandle({
    meta: {
      provider: 'youtube',
      resolvedUrl: url,
      durationSec: null,
      hasNormalize,
    },
    handles: { hasYtdlp: true, hasFfmpeg: hasNormalize },
    stabilityWindowMs,
  });

  // Shadow classifier — pure observation. Никакой policy-связи со старым кодом.
  const observeClassify = (input) => {
    try {
      const result = classifyStreamError(input);
      logClassifierShadow({ guildId, url, input, result });
    } catch { /* shadow не должен ломать стрим */ }
  };

  const feedHandle = (fn) => {
    try { fn(handle); } catch { /* shadow-ownership не должен ломать стрим */ }
  };

  // ── yt-dlp event wiring ──
  ytdlpProc.stderr?.on('data', (chunk) => {
    const line = String(chunk);
    observeClassify({ source: 'ytdlp_stderr', line, phase: handle.phase, processCode: null, signal: null });
    feedHandle((h) => h.onStderr({ source: 'ytdlp_stderr', line }));
  });
  ytdlpProc.on('error', (err) => {
    observeClassify({
      source: 'process_error',
      line: err instanceof Error ? err.message : String(err),
      phase: handle.phase,
      processCode: null,
      signal: null,
    });
    feedHandle((h) => h.onProcessError({ source: 'ytdlp', error: err }));
  });
  ytdlpProc.on('close', (code, signal) => {
    observeClassify({
      source: 'process_exit',
      line: null,
      phase: handle.phase,
      processCode: code ?? null,
      signal: signal ?? null,
    });
    feedHandle((h) => h.onProcessExit({ source: 'ytdlp', code: code ?? null, signal: signal ?? null }));
  });

  // Проверка что yt-dlp реально дал stdout. До этой точки handle уже подписан,
  // seamless error reporting уже работает.
  if (!ytdlpProc.stdout) {
    try { ytdlpProc.kill?.('SIGKILL'); } catch { /* noop */ }
    throw new Error('yt-dlp не вернул поток (установи/обнови yt-dlp: npm i в папке бота или winget install yt-dlp)');
  }

  /** yt-dlp → (опционально) ffmpeg -af → s16le 48k stereo; иначе Arbitrary. */
  let streamForPlayer = ytdlpProc.stdout;
  let inputType = StreamType.Arbitrary;
  /** @type {ReturnType<typeof spawnFfmpegNormalizeAfterYtdlp> | null} */
  let ffmpegProc = null;

  if (hasNormalize) {
    const ff = spawnFfmpegNormalizeAfterYtdlp(ytdlpProc);
    if (ff?.stdout) {
      ffmpegProc = ff;
      streamForPlayer = ff.stdout;
      inputType = StreamType.Raw;

      ff.stderr?.on('data', (chunk) => {
        const line = String(chunk);
        observeClassify({ source: 'ffmpeg_stderr', line, phase: handle.phase, processCode: null, signal: null });
        feedHandle((h) => h.onStderr({ source: 'ffmpeg_stderr', line }));
      });
      ff.on('error', (err) => {
        observeClassify({
          source: 'process_error',
          line: err instanceof Error ? err.message : String(err),
          phase: handle.phase,
          processCode: null,
          signal: null,
        });
        feedHandle((h) => h.onProcessError({ source: 'ffmpeg', error: err }));
      });
      ff.on('close', (code, signal) => {
        observeClassify({
          source: 'process_exit',
          line: null,
          phase: handle.phase,
          processCode: code ?? null,
          signal: signal ?? null,
        });
        feedHandle((h) => h.onProcessExit({ source: 'ffmpeg', code: code ?? null, signal: signal ?? null }));
      });
    } else {
      /**
       * Normalize был включён по env, но spawn ffmpeg не дал stdout.
       * handle ожидает close-события от ffmpeg (hasFfmpeg=true) — «закрываем»
       * искусственно, иначе whenEnded не разрешится.
       */
      feedHandle((h) => h.onProcessExit({ source: 'ffmpeg', code: null, signal: null }));
    }
  }

  const resource = createAudioResource(streamForPlayer, {
    inputType,
    metadata: { title: label },
  });

  return { handle, resource, ytdlpProc, ffmpegProc };
}
