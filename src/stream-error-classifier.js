/**
 * stream-error-classifier.js
 *
 * Чистая функция `classify({...})` для классификации событий stream lifecycle
 * (yt-dlp / ffmpeg stderr, process exit, process error).
 *
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md раздел «Ключевые контракты» → `EndReason` / `FatalClass` / `classify`.
 *
 * Owner модуля: автономный, без зависимостей от Discord, music.js или процессов.
 *
 * Шаг 1 плана: используется в shadow-режиме — результаты пишутся в
 * data/metrics/classifier-shadow.txt параллельно со старой эвристикой в music.js.
 * Policy side effects (playability cache, repeat force-skip) пока не зависят от classify().
 *
 * Шаг 6: classify() становится единственным источником истины для policy.
 */

/**
 * @typedef {'region_blocked' | 'video_unavailable' | 'age_restricted' | 'embed_disabled' | 'extractor_error' | 'network_error' | 'unknown_fatal'} FatalClass
 * @typedef {'fatal' | 'transient' | 'warning' | 'unknown'} Severity
 * @typedef {'SPAWNED' | 'FLOWING' | 'STABLE' | 'ENDING' | 'TERMINATED' | 'unknown'} Phase
 * @typedef {'ytdlp_stderr' | 'ffmpeg_stderr' | 'process_exit' | 'process_error'} Source
 *
 * @typedef {{
 *   source: Source,
 *   line: string | null,
 *   phase: Phase,
 *   processCode: number | null,
 *   signal: string | null,
 * }} ClassifyInput
 *
 * @typedef {{
 *   severity: Severity,
 *   fatalClass: FatalClass | null,
 *   reason: string,
 * }} ClassifyResult
 */

/**
 * Считается ли phase «стабильной» — после STABLE любая transport noise уже не фатальна.
 * @param {Phase} phase
 */
function isPostStable(phase) {
  return phase === 'STABLE' || phase === 'ENDING' || phase === 'TERMINATED';
}

/**
 * Matches provider verdicts: YouTube/yt-dlp явно сообщил недоступность ресурса.
 * Fatal regardless of phase: если YouTube говорит 403/404/removed — URL не будет играть.
 *
 * @param {string} line
 * @returns {FatalClass | null}
 */
function matchProviderVerdict(line) {
  if (/HTTP Error 403/i.test(line)) return 'region_blocked';
  if (/HTTP Error 404/i.test(line)) return 'video_unavailable';
  if (/HTTP Error 410/i.test(line)) return 'video_unavailable';

  if (/Video unavailable/i.test(line)) return 'video_unavailable';
  if (/This video is not available/i.test(line)) return 'video_unavailable';
  if (/Video has been removed/i.test(line)) return 'video_unavailable';
  if (/Private video/i.test(line)) return 'video_unavailable';
  if (/This video has been removed by the uploader/i.test(line)) return 'video_unavailable';

  if (/Sign in to confirm your age/i.test(line)) return 'age_restricted';

  if (/Playback on other websites has been disabled/i.test(line)) return 'embed_disabled';

  if (/Unable to extract/i.test(line)) return 'extractor_error';
  if (/ERROR:\s+Unsupported URL/i.test(line)) return 'extractor_error';

  return null;
}

/**
 * Transport-noise паттерны: IO-симптомы, не причины.
 * Могут возникать и при intentional kill (SIGKILL) — значит сами по себе
 * не маркируют URL как плохой. Их severity зависит от phase.
 *
 * @param {string} line
 */
function matchTransportNoise(line) {
  return (
    /Broken pipe/i.test(line) ||
    /Invalid argument/i.test(line) ||
    /\bEPIPE\b/.test(line) ||
    /\bECONNRESET\b/.test(line) ||
    /\bECONNREFUSED\b/.test(line) ||
    /\bETIMEDOUT\b/.test(line)
  );
}

/**
 * Слабая проверка «строка выглядит как ошибка, но не известный паттерн».
 * Нужна чтобы отличить «просто debug-шум yt-dlp» от «что-то произошло, но мы не знаем что».
 *
 * @param {string} line
 */
function looksLikeGenericError(line) {
  if (/^WARNING:/i.test(line)) return false;
  return /\bERROR\b/.test(line) || /\berror:/i.test(line) || /\[error\]/i.test(line);
}

/**
 * Классифицирует событие stream lifecycle.
 *
 * Правила приоритета (сверху вниз):
 *   1. Смерть от сигнала SIGKILL/SIGTERM → intentional cancel, severity=unknown.
 *   2. Provider verdict (YouTube сказал нет) → fatal с конкретным FatalClass, independent of phase.
 *   3. Process exit code:
 *        0 → unknown (не наша забота, нет ошибки).
 *        non-zero + phase<STABLE → fatal:unknown_fatal.
 *        non-zero + phase≥STABLE → transient (стрим уже доиграл успешно, exit noise).
 *   4. Process error event → fatal:network_error.
 *   5. Transport noise:
 *        phase≥STABLE → transient (стрим стабилизировался, это уже шум).
 *        phase<STABLE → warning (подозрительно, но не окончательно).
 *   6. Generic error line → warning (не классифицировано, не маркируем URL).
 *   7. Всё остальное → unknown.
 *
 * @param {ClassifyInput} input
 * @returns {ClassifyResult}
 */
export function classify(input) {
  const { source, line, phase, processCode, signal } = input;

  if (signal === 'SIGKILL' || signal === 'SIGTERM') {
    return { severity: 'unknown', fatalClass: null, reason: `cancelled_by_signal:${signal}` };
  }

  if (line) {
    const fc = matchProviderVerdict(line);
    if (fc) {
      return { severity: 'fatal', fatalClass: fc, reason: `provider_verdict:${fc}` };
    }
  }

  if (source === 'process_exit') {
    if (processCode === 0) {
      return { severity: 'unknown', fatalClass: null, reason: 'exit_ok' };
    }
    if (processCode != null) {
      if (isPostStable(phase)) {
        return { severity: 'transient', fatalClass: null, reason: `exit_nonzero_post_stable:${processCode}` };
      }
      return { severity: 'fatal', fatalClass: 'unknown_fatal', reason: `exit_nonzero_pre_stable:${processCode}` };
    }
    return { severity: 'unknown', fatalClass: null, reason: 'exit_no_code' };
  }

  if (source === 'process_error') {
    return {
      severity: 'fatal',
      fatalClass: 'network_error',
      reason: `process_error:${(line ?? 'no_details').slice(0, 200)}`,
    };
  }

  if (line && matchTransportNoise(line)) {
    if (isPostStable(phase)) {
      return { severity: 'transient', fatalClass: null, reason: 'transport_noise_post_stable' };
    }
    return { severity: 'warning', fatalClass: null, reason: 'transport_noise_pre_stable' };
  }

  if (line && looksLikeGenericError(line)) {
    return { severity: 'warning', fatalClass: null, reason: 'unclassified_error_line' };
  }

  return { severity: 'unknown', fatalClass: null, reason: 'no_match' };
}

/**
 * FATAL_CLASSES — список для валидации снаружи (тесты, типы).
 * @type {readonly FatalClass[]}
 */
export const FATAL_CLASSES = Object.freeze([
  'region_blocked',
  'video_unavailable',
  'age_restricted',
  'embed_disabled',
  'extractor_error',
  'network_error',
  'unknown_fatal',
]);

/**
 * SEVERITIES — для валидации снаружи.
 * @type {readonly Severity[]}
 */
export const SEVERITIES = Object.freeze(['fatal', 'transient', 'warning', 'unknown']);
