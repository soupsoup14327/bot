/**
 * stream-handle.js
 *
 * Владелец lifecycle одной попытки воспроизведения одного ресурса.
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md раздел «Ключевые контракты» → `StreamHandle`.
 *
 * Введён в Шаге 2 в shadow-режиме (параллельный источник истины рядом с legacy
 * `s.ytdlpStreamError`). В Шагах 6c-a / 6c-b переведён в production: audio-pipeline
 * владеет handle'ом; `music.js::streamUrl` подписывается на `handle.whenEnded`
 * и пишет типизированный `EndReason` в `s.lastEndReason`, который читает
 * `handlePlayerIdle` как единственный источник `streamFailed`.
 *
 * Модуль чистый с точки зрения Discord: не импортирует discord.js / @discordjs/voice.
 * Принимает события как простые DTO.
 */

import { classify } from './stream-error-classifier.js';

/**
 * @typedef {'SPAWNED' | 'FLOWING' | 'STABLE' | 'ENDING' | 'TERMINATED'} Phase
 * @typedef {'ytdlp' | 'ffmpeg'} ProcessKind
 * @typedef {'Playing' | 'Paused' | 'AutoPaused' | 'Idle' | 'Buffering'} PlayerStatus
 *
 * @typedef {import('./stream-error-classifier.js').FatalClass} FatalClass
 *
 * @typedef {
 *    | { kind: 'natural' }
 *    | { kind: 'cancelled' }
 *    | { kind: 'fatal', class: FatalClass, context: string }
 *    | { kind: 'transient', context: string }
 * } EndReason
 *
 * @typedef {{
 *   provider: string,
 *   resolvedUrl: string,
 *   durationSec: number | null,
 *   hasNormalize: boolean,
 * }} StreamMeta
 */

/**
 * Статусы процесса, трекаемые handle'ом. `null` — процесс не был заведён (например,
 * ffmpeg normalize выключен) → считается закрытым с рождения.
 *
 * @typedef {{ closed: boolean, code: number | null, signal: string | null, hadError: boolean, lastStderr: string | null }} ProcState
 */

const DEFAULT_STABILITY_MS = 2500;

/** Безопасная текущая метка времени (инжектится для тестов). */
function defaultNow() {
  return Date.now();
}

export class StreamHandle {
  /**
   * @param {{
   *   meta: Partial<StreamMeta>,
   *   resource?: unknown,
   *   handles?: { hasYtdlp?: boolean, hasFfmpeg?: boolean },
   *   stabilityWindowMs?: number,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    const {
      meta = {},
      resource = null,
      handles = { hasYtdlp: true, hasFfmpeg: false },
      stabilityWindowMs = DEFAULT_STABILITY_MS,
      now = defaultNow,
    } = deps || {};

    this.resource = resource;
    this.meta = {
      provider: meta.provider ?? 'youtube',
      resolvedUrl: meta.resolvedUrl ?? '',
      durationSec: meta.durationSec ?? null,
      hasNormalize: !!meta.hasNormalize,
      startedAt: now(),
    };

    this._now = now;
    this._stabilityWindowMs = Math.max(0, stabilityWindowMs);

    /** @type {Phase} */
    this._phase = 'SPAWNED';

    this._accumulatedPlayingMs = 0;
    /** @type {number | null} */
    this._playingStartedAt = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._stabilityTimer = null;

    this._cancelled = false;
    /** @type {{ class: FatalClass, context: string } | null} */
    this._pendingFatal = null;
    /** @type {{ context: string } | null} */
    this._pendingTransient = null;

    /** @type {Record<ProcessKind, ProcState>} */
    this._procs = {
      ytdlp: this._initProcState(handles?.hasYtdlp !== false),
      ffmpeg: this._initProcState(handles?.hasFfmpeg === true),
    };

    this._endedResolved = false;
    /** @type {EndReason | null} */
    this._terminalReason = null;

    /** @type {(() => void) | null} */
    this._whenStableResolve = null;
    this.whenStable = new Promise((res) => {
      this._whenStableResolve = res;
    });

    /** @type {((r: EndReason) => void) | null} */
    this._whenEndedResolve = null;
    this.whenEnded = new Promise((res) => {
      this._whenEndedResolve = res;
    });

    // Если процессов не было совсем — немедленно переводим в TERMINATED с natural.
    if (this._procs.ytdlp.closed && this._procs.ffmpeg.closed) {
      this._resolveEnded({ kind: 'natural' });
    }
  }

  /** @param {boolean} expected */
  _initProcState(expected) {
    return {
      closed: !expected,
      code: null,
      signal: null,
      hadError: false,
      lastStderr: null,
    };
  }

  /** Текущая фаза. */
  get phase() {
    return this._phase;
  }

  /** True если whenEnded уже заразрешился. */
  get isTerminated() {
    return this._phase === 'TERMINATED';
  }

  /** Pending fatal, если есть (для shadow-логов / snapshot). */
  get pendingFatal() {
    return this._pendingFatal ? { ...this._pendingFatal } : null;
  }

  /** Snapshot для логов / наблюдаемости. Без side effects. */
  snapshot() {
    return {
      phase: this._phase,
      accumulatedPlayingMs: this._accumulatedPlayingMs,
      isCurrentlyPlaying: this._playingStartedAt != null,
      cancelled: this._cancelled,
      pendingFatal: this.pendingFatal,
      procs: {
        ytdlp: { ...this._procs.ytdlp },
        ffmpeg: { ...this._procs.ffmpeg },
      },
      ended: this._endedResolved,
      terminalReason: this._terminalReason,
      meta: { ...this.meta },
    };
  }

  // ───────────────────────── Events in ─────────────────────────

  /**
   * Уведомление о статусе AudioPlayer. Передаётся ИЗВНЕ (player-controller).
   *
   * @param {PlayerStatus} status
   */
  notifyPlayerState(status) {
    if (this._endedResolved) return;

    const wasPlaying = this._playingStartedAt != null;

    if (status === 'Playing') {
      if (this._phase === 'SPAWNED') this._setPhase('FLOWING');
      if (!wasPlaying) {
        this._playingStartedAt = this._now();
        this._scheduleStabilityTimer();
      }
      return;
    }

    // Любой выход из Playing: снимаем активный отсчёт.
    if (wasPlaying) {
      const delta = Math.max(0, this._now() - (this._playingStartedAt ?? this._now()));
      this._accumulatedPlayingMs += delta;
      this._playingStartedAt = null;
      this._clearStabilityTimer();
    }

    if (status === 'AutoPaused') {
      // AutoPaused — стрим спотыкается, сбрасываем накопленное.
      this._accumulatedPlayingMs = 0;
      return;
    }

    if (status === 'Paused' || status === 'Buffering') {
      // User-paused / buffering — накопление сохраняется, просто заморожено.
      return;
    }

    if (status === 'Idle') {
      // Player доиграл; ждём закрытие процессов для финальной резолюции.
      // Сам Idle не триггерит TERMINATED — процессы могут ещё закрываться.
      // Но если процессы уже были закрыты до Idle — ресолвим.
      this._maybeResolveIfAllClosed();
      return;
    }
  }

  /**
   * stderr строка от yt-dlp / ffmpeg. Handle классифицирует через classify() и
   * сохраняет самый «тяжёлый» наблюдаемый fatal (первый выигрывает).
   *
   * @param {{ source: 'ytdlp_stderr' | 'ffmpeg_stderr', line: string }} ev
   */
  onStderr(ev) {
    if (this._endedResolved) return;
    const kind = ev.source === 'ytdlp_stderr' ? 'ytdlp' : 'ffmpeg';
    this._procs[kind].lastStderr = String(ev.line ?? '').slice(0, 400);

    const res = classify({
      source: ev.source,
      line: ev.line ?? null,
      phase: this._phase,
      processCode: null,
      signal: null,
    });

    if (res.severity === 'fatal' && res.fatalClass && !this._pendingFatal) {
      this._pendingFatal = { class: res.fatalClass, context: res.reason };
    } else if (res.severity === 'transient' && !this._pendingTransient && !this._pendingFatal) {
      this._pendingTransient = { context: res.reason };
    }
  }

  /**
   * Событие закрытия процесса.
   *
   * @param {{ source: ProcessKind, code: number | null, signal: string | null }} ev
   */
  onProcessExit(ev) {
    if (this._endedResolved) return;
    const ps = this._procs[ev.source];
    if (!ps || ps.closed) return;
    ps.closed = true;
    ps.code = ev.code ?? null;
    ps.signal = ev.signal ?? null;

    // Классифицируем сам exit.
    const res = classify({
      source: 'process_exit',
      line: null,
      phase: this._phase,
      processCode: ev.code ?? null,
      signal: ev.signal ?? null,
    });
    if (res.severity === 'fatal' && res.fatalClass && !this._pendingFatal) {
      this._pendingFatal = { class: res.fatalClass, context: res.reason };
    } else if (res.severity === 'transient' && !this._pendingTransient && !this._pendingFatal) {
      this._pendingTransient = { context: res.reason };
    }

    this._maybeResolveIfAllClosed();
  }

  /**
   * Ошибка spawn/fs у процесса.
   *
   * @param {{ source: ProcessKind, error: unknown }} ev
   */
  onProcessError(ev) {
    if (this._endedResolved) return;
    const ps = this._procs[ev.source];
    if (!ps) return;
    ps.hadError = true;
    const msg = ev.error instanceof Error ? ev.error.message : String(ev.error);
    const res = classify({
      source: 'process_error',
      line: msg,
      phase: this._phase,
      processCode: null,
      signal: null,
    });
    if (res.severity === 'fatal' && res.fatalClass && !this._pendingFatal) {
      this._pendingFatal = { class: res.fatalClass, context: res.reason };
    }
  }

  // ───────────────────────── Commands ──────────────────────────

  /**
   * Отмена (orchestrator вызывает при skip / stop / nav). Фактический kill
   * процессов — отдельная забота caller'а; handle только трекает состояние.
   */
  cancel() {
    if (this._endedResolved) return;
    this._cancelled = true;
    if (this._phase !== 'ENDING' && this._phase !== 'TERMINATED') {
      this._setPhase('ENDING');
    }
    this._maybeResolveIfAllClosed();
  }

  // ───────────────────────── Internals ─────────────────────────

  /** @param {Phase} phase */
  _setPhase(phase) {
    if (this._phase === phase) return;
    // Защита от регресса по state machine.
    const order = { SPAWNED: 0, FLOWING: 1, STABLE: 2, ENDING: 3, TERMINATED: 4 };
    if (order[phase] < order[this._phase]) return;
    this._phase = phase;
  }

  _scheduleStabilityTimer() {
    if (this._phase === 'STABLE' || this._phase === 'ENDING' || this._phase === 'TERMINATED') return;
    this._clearStabilityTimer();
    const remaining = this._stabilityWindowMs - this._accumulatedPlayingMs;
    if (remaining <= 0) {
      this._onStabilityReached();
      return;
    }
    this._stabilityTimer = setTimeout(() => {
      this._stabilityTimer = null;
      this._onStabilityReached();
    }, remaining);
  }

  _clearStabilityTimer() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
  }

  _onStabilityReached() {
    if (this._phase !== 'FLOWING') return;
    this._setPhase('STABLE');
    if (this._whenStableResolve) {
      const resolve = this._whenStableResolve;
      this._whenStableResolve = null;
      resolve();
    }
  }

  _maybeResolveIfAllClosed() {
    if (this._endedResolved) return;
    if (!this._procs.ytdlp.closed || !this._procs.ffmpeg.closed) {
      // Если cancel вызван, ждём пока caller убьёт процессы — но ENDING уже выставлен.
      return;
    }
    this._resolveEnded(this._computeEndReason());
  }

  /**
   * @returns {EndReason}
   */
  _computeEndReason() {
    if (this._cancelled) {
      return { kind: 'cancelled' };
    }
    // SIGKILL / SIGTERM без явного cancel() — всё равно означает caller-driven teardown
    // (в production это `killYtdlp` на skip/stop). Классифицируем как cancelled, чтобы
    // playability cache не записывал этот URL как плохой.
    /** @type {ProcessKind[]} */
    const kinds = ['ytdlp', 'ffmpeg'];
    for (const kind of kinds) {
      const sig = this._procs[kind].signal;
      if (sig === 'SIGKILL' || sig === 'SIGTERM') {
        return { kind: 'cancelled' };
      }
    }
    if (this._pendingFatal) {
      return { kind: 'fatal', class: this._pendingFatal.class, context: this._pendingFatal.context };
    }
    if (this._pendingTransient) {
      return { kind: 'transient', context: this._pendingTransient.context };
    }
    // Нет накопленного fatal/transient — считаем natural, даже если exit code non-zero,
    // но ТОЛЬКО если phase ≥ STABLE. До STABLE non-zero exit уже классифицирован как fatal
    // через onProcessExit → pendingFatal, и сюда не дойдёт.
    return { kind: 'natural' };
  }

  /** @param {EndReason} reason */
  _resolveEnded(reason) {
    if (this._endedResolved) return;
    this._endedResolved = true;
    this._terminalReason = reason;
    this._clearStabilityTimer();
    // Если whenStable ещё не разрешён — оставляем его как-есть; pending Promise GC
    // не проблема, но чтобы не держать ссылку навсегда — не делаем ничего.
    this._setPhase('TERMINATED');
    if (this._whenEndedResolve) {
      const resolve = this._whenEndedResolve;
      this._whenEndedResolve = null;
      resolve(reason);
    }
  }
}
