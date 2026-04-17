/**
 * Unit tests for StreamHandle state machine.
 * Merge-blocker по docs/ПЛАН-РЕФАКТОРИНГА.md (Шаг 2).
 *
 * Используем встроенные fake timers из `node:test` (t.mock.timers).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StreamHandle } from '../src/stream-handle.js';

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Создаёт handle с дефолтами для теста и controlled now().
 */
function makeHandle(overrides = {}) {
  let now = 1_000_000;
  const handle = new StreamHandle({
    meta: { provider: 'youtube', resolvedUrl: 'https://yt/X', durationSec: 180, hasNormalize: false },
    handles: { hasYtdlp: true, hasFfmpeg: false },
    stabilityWindowMs: 2500,
    now: () => now,
    ...overrides,
  });
  return {
    handle,
    tick: (ms) => {
      now += ms;
    },
    getNow: () => now,
  };
}

// ─── Construction / initial state ─────────────────────────────────────────

describe('construction', () => {
  test('начальная фаза SPAWNED, meta заполнена', () => {
    const { handle } = makeHandle();
    assert.equal(handle.phase, 'SPAWNED');
    assert.equal(handle.meta.provider, 'youtube');
    assert.equal(handle.meta.resolvedUrl, 'https://yt/X');
    assert.equal(handle.meta.hasNormalize, false);
    assert.equal(typeof handle.meta.startedAt, 'number');
  });

  test('без процессов — сразу TERMINATED с natural', async () => {
    const h = new StreamHandle({
      meta: {},
      handles: { hasYtdlp: false, hasFfmpeg: false },
    });
    const reason = await h.whenEnded;
    assert.deepEqual(reason, { kind: 'natural' });
    assert.equal(h.phase, 'TERMINATED');
  });

  test('snapshot даёт читаемый объект', () => {
    const { handle } = makeHandle();
    const s = handle.snapshot();
    assert.equal(s.phase, 'SPAWNED');
    assert.equal(s.cancelled, false);
    assert.equal(s.pendingFatal, null);
    assert.equal(s.procs.ytdlp.closed, false);
    assert.equal(s.procs.ffmpeg.closed, true, 'ffmpeg не заведён → считается закрытым');
  });
});

// ─── Phase transitions (stability timer) ──────────────────────────────────

describe('phase transitions', () => {
  test('Playing → FLOWING, timer не фаерит раньше T', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle } = makeHandle();
    handle.notifyPlayerState('Playing');
    assert.equal(handle.phase, 'FLOWING');
    t.mock.timers.tick(2000);
    assert.equal(handle.phase, 'FLOWING');
    t.mock.timers.tick(499);
    assert.equal(handle.phase, 'FLOWING');
  });

  test('FLOWING → STABLE через T мс непрерывного Playing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle } = makeHandle();
    handle.notifyPlayerState('Playing');
    t.mock.timers.tick(2500);
    assert.equal(handle.phase, 'STABLE');
    await handle.whenStable; // не должен зависнуть
  });

  test('AutoPaused сбрасывает накопленное время', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();

    handle.notifyPlayerState('Playing');
    tick(2000);
    t.mock.timers.tick(2000);
    handle.notifyPlayerState('AutoPaused');

    // Возвращаемся в Playing: нужно снова копить T.
    tick(10);
    t.mock.timers.tick(10);
    handle.notifyPlayerState('Playing');
    tick(2000);
    t.mock.timers.tick(2000);
    assert.equal(handle.phase, 'FLOWING', 'ещё не STABLE: набрали 2000 < 2500');
    tick(600);
    t.mock.timers.tick(600);
    assert.equal(handle.phase, 'STABLE');
  });

  test('User Paused НЕ сбрасывает, после возобновления добивает до STABLE', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();

    handle.notifyPlayerState('Playing');
    tick(1500);
    t.mock.timers.tick(1500);
    handle.notifyPlayerState('Paused');
    assert.equal(handle.phase, 'FLOWING');

    tick(10_000); // долгая пауза не должна ничего сбросить
    t.mock.timers.tick(10_000);
    assert.equal(handle.phase, 'FLOWING');

    handle.notifyPlayerState('Playing');
    tick(1000);
    t.mock.timers.tick(1000);
    assert.equal(handle.phase, 'STABLE', '1500 + 1000 = 2500');
  });

  test('Buffering не сбрасывает (как user pause)', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();

    handle.notifyPlayerState('Playing');
    tick(2000);
    t.mock.timers.tick(2000);
    handle.notifyPlayerState('Buffering');

    tick(5);
    t.mock.timers.tick(5);
    handle.notifyPlayerState('Playing');
    tick(500);
    t.mock.timers.tick(500);
    assert.equal(handle.phase, 'STABLE');
  });

  test('Idle без процессов ещё активных → ждёт process exit', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();

    handle.notifyPlayerState('Playing');
    tick(3000);
    t.mock.timers.tick(3000);
    assert.equal(handle.phase, 'STABLE');

    handle.notifyPlayerState('Idle');
    assert.equal(handle.phase, 'STABLE', 'Idle один не ведёт в TERMINATED пока процесс живой');
    assert.equal(handle.isTerminated, false);
  });
});

// ─── End reasons ──────────────────────────────────────────────────────────

describe('whenEnded: natural', () => {
  test('exit 0 после STABLE → natural', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();
    handle.notifyPlayerState('Playing');
    tick(2500);
    t.mock.timers.tick(2500);
    handle.notifyPlayerState('Idle');
    handle.onProcessExit({ source: 'ytdlp', code: 0, signal: null });
    const reason = await handle.whenEnded;
    assert.deepEqual(reason, { kind: 'natural' });
    assert.equal(handle.isTerminated, true);
  });
});

describe('whenEnded: cancelled', () => {
  test('cancel() до закрытия процесса → ENDING, ждёт exit, потом cancelled', async () => {
    const { handle } = makeHandle();
    handle.cancel();
    assert.equal(handle.phase, 'ENDING');
    assert.equal(handle.isTerminated, false, 'процесс ещё живой');
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    const reason = await handle.whenEnded;
    assert.deepEqual(reason, { kind: 'cancelled' });
  });

  test('cancel побеждает даже при pending fatal', async () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: HTTP Error 403 Forbidden' });
    assert.notEqual(handle.pendingFatal, null);
    handle.cancel();
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    const reason = await handle.whenEnded;
    assert.deepEqual(reason, { kind: 'cancelled' });
  });

  test('exit с SIGKILL без явного cancel() → cancelled (caller-driven kill)', async () => {
    const { handle } = makeHandle();
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    const r = await handle.whenEnded;
    assert.deepEqual(r, { kind: 'cancelled' });
  });

  test('SIGKILL побеждает pending fatal (broken pipe после 403 не должен обманывать)', async () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: HTTP Error 403' });
    handle.onStderr({ source: 'ytdlp_stderr', line: 'Broken pipe' });
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    const r = await handle.whenEnded;
    assert.equal(
      r.kind,
      'cancelled',
      'caller убил процесс — мы не знаем, увидел ли бы пользователь fatal, не блэклистим URL',
    );
  });
});

describe('whenEnded: fatal', () => {
  test('provider verdict (403) + exit non-zero → fatal region_blocked', async () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: HTTP Error 403 Forbidden' });
    handle.onProcessExit({ source: 'ytdlp', code: 1, signal: null });
    const reason = await handle.whenEnded;
    assert.equal(reason.kind, 'fatal');
    assert.equal(reason.class, 'region_blocked');
  });

  test('video_unavailable сохраняется в EndReason', async () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: Private video' });
    handle.onProcessExit({ source: 'ytdlp', code: 1, signal: null });
    const r = await handle.whenEnded;
    assert.equal(r.kind, 'fatal');
    assert.equal(r.class, 'video_unavailable');
  });

  test('non-zero exit до STABLE без stderr → fatal:unknown_fatal', async () => {
    const { handle } = makeHandle();
    handle.onProcessExit({ source: 'ytdlp', code: 1, signal: null });
    const reason = await handle.whenEnded;
    assert.equal(reason.kind, 'fatal');
    assert.equal(reason.class, 'unknown_fatal');
  });

  test('первый fatal выигрывает (последующие stderr-строки не меняют класс)', async () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: HTTP Error 403' });
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: Video unavailable' });
    handle.onProcessExit({ source: 'ytdlp', code: 1, signal: null });
    const reason = await handle.whenEnded;
    assert.equal(reason.class, 'region_blocked');
  });

  test('process_error → fatal:network_error', async () => {
    const { handle } = makeHandle();
    handle.onProcessError({ source: 'ytdlp', error: new Error('spawn ENOENT') });
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: null });
    const reason = await handle.whenEnded;
    assert.equal(reason.kind, 'fatal');
    assert.equal(reason.class, 'network_error');
  });
});

describe('whenEnded: transient', () => {
  test('broken pipe после STABLE + exit non-zero → transient', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();
    handle.notifyPlayerState('Playing');
    tick(2500);
    t.mock.timers.tick(2500);
    assert.equal(handle.phase, 'STABLE');

    handle.onStderr({ source: 'ytdlp_stderr', line: 'Broken pipe' });
    handle.onProcessExit({ source: 'ytdlp', code: 137, signal: null });
    const reason = await handle.whenEnded;
    assert.equal(reason.kind, 'transient');
  });
});

// ─── Multi-process handling ───────────────────────────────────────────────

describe('multi-process (yt-dlp + ffmpeg normalize)', () => {
  test('ждёт закрытия обоих процессов', async () => {
    const h = new StreamHandle({
      meta: {},
      handles: { hasYtdlp: true, hasFfmpeg: true },
    });

    h.onProcessExit({ source: 'ytdlp', code: 0, signal: null });
    assert.equal(h.isTerminated, false, 'ffmpeg ещё не закрыт');

    h.onProcessExit({ source: 'ffmpeg', code: 0, signal: null });
    const r = await h.whenEnded;
    assert.deepEqual(r, { kind: 'natural' });
  });

  test('ffmpeg stderr с fatal → класс сохраняется', async () => {
    const h = new StreamHandle({
      meta: {},
      handles: { hasYtdlp: true, hasFfmpeg: true },
    });
    h.onStderr({ source: 'ffmpeg_stderr', line: 'ERROR: HTTP Error 404' });
    h.onProcessExit({ source: 'ytdlp', code: 0, signal: null });
    h.onProcessExit({ source: 'ffmpeg', code: 1, signal: null });
    const r = await h.whenEnded;
    assert.equal(r.kind, 'fatal');
    assert.equal(r.class, 'video_unavailable');
  });
});

// ─── Idempotency / robustness ─────────────────────────────────────────────

describe('robustness', () => {
  test('повторный cancel() не ломает', async () => {
    const { handle } = makeHandle();
    handle.cancel();
    handle.cancel();
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    const r = await handle.whenEnded;
    assert.equal(r.kind, 'cancelled');
  });

  test('повторный onProcessExit игнорируется', async () => {
    const { handle } = makeHandle();
    handle.onProcessExit({ source: 'ytdlp', code: 0, signal: null });
    handle.onProcessExit({ source: 'ytdlp', code: 1, signal: null });
    const r = await handle.whenEnded;
    assert.equal(r.kind, 'natural', 'первый exit зафиксирован, второй проигнорирован');
  });

  test('события после TERMINATED безопасны', async () => {
    const { handle } = makeHandle();
    handle.onProcessExit({ source: 'ytdlp', code: 0, signal: null });
    await handle.whenEnded;
    handle.notifyPlayerState('Playing');
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: anything' });
    handle.cancel();
    assert.equal(handle.phase, 'TERMINATED');
  });

  test('фаза не регрессирует (STABLE → не возвращается в FLOWING)', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle, tick } = makeHandle();
    handle.notifyPlayerState('Playing');
    tick(2500);
    t.mock.timers.tick(2500);
    assert.equal(handle.phase, 'STABLE');
    handle.notifyPlayerState('AutoPaused'); // reset accumulator
    assert.equal(handle.phase, 'STABLE', 'STABLE sticky — не возвращаемся в FLOWING');
    handle.notifyPlayerState('Playing');
    assert.equal(handle.phase, 'STABLE');
  });
});

// ─── Snapshot contents under various phases ───────────────────────────────

describe('snapshot', () => {
  test('после fatal stderr содержит pendingFatal', () => {
    const { handle } = makeHandle();
    handle.onStderr({ source: 'ytdlp_stderr', line: 'ERROR: Sign in to confirm your age' });
    const s = handle.snapshot();
    assert.equal(s.pendingFatal.class, 'age_restricted');
  });

  test('после cancel + exit содержит terminalReason', async () => {
    const { handle } = makeHandle();
    handle.cancel();
    handle.onProcessExit({ source: 'ytdlp', code: null, signal: 'SIGKILL' });
    await handle.whenEnded;
    const s = handle.snapshot();
    assert.deepEqual(s.terminalReason, { kind: 'cancelled' });
    assert.equal(s.phase, 'TERMINATED');
  });
});
