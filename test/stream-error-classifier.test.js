/**
 * Unit tests for stream-error-classifier.
 * Merge-blocker по docs/ПЛАН-РЕФАКТОРИНГА.md (Шаг 1).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, FATAL_CLASSES, SEVERITIES } from '../src/stream-error-classifier.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** @type {import('../src/stream-error-classifier.js').ClassifyInput} */
const baseInput = {
  source: 'ytdlp_stderr',
  line: null,
  phase: 'unknown',
  processCode: null,
  signal: null,
};

function withLine(line, extra = {}) {
  return { ...baseInput, line, ...extra };
}

// ─── Exports shape ────────────────────────────────────────────────────────

describe('exports', () => {
  test('FATAL_CLASSES содержит ожидаемые классы', () => {
    assert.ok(FATAL_CLASSES.includes('region_blocked'));
    assert.ok(FATAL_CLASSES.includes('video_unavailable'));
    assert.ok(FATAL_CLASSES.includes('age_restricted'));
    assert.ok(FATAL_CLASSES.includes('embed_disabled'));
    assert.ok(FATAL_CLASSES.includes('extractor_error'));
    assert.ok(FATAL_CLASSES.includes('network_error'));
    assert.ok(FATAL_CLASSES.includes('unknown_fatal'));
  });

  test('SEVERITIES содержит ровно 4 уровня', () => {
    assert.deepEqual([...SEVERITIES].sort(), ['fatal', 'transient', 'unknown', 'warning']);
  });

  test('FATAL_CLASSES и SEVERITIES frozen', () => {
    assert.equal(Object.isFrozen(FATAL_CLASSES), true);
    assert.equal(Object.isFrozen(SEVERITIES), true);
  });
});

// ─── Rule 1: signal-driven cancellation ───────────────────────────────────

describe('rule 1: signal cancellation', () => {
  test('SIGKILL → unknown, не fatal', () => {
    const r = classify({ ...baseInput, source: 'process_exit', processCode: null, signal: 'SIGKILL' });
    assert.equal(r.severity, 'unknown');
    assert.equal(r.fatalClass, null);
    assert.match(r.reason, /cancelled_by_signal:SIGKILL/);
  });

  test('SIGTERM → unknown, не fatal', () => {
    const r = classify({ ...baseInput, source: 'process_exit', signal: 'SIGTERM' });
    assert.equal(r.severity, 'unknown');
    assert.match(r.reason, /SIGTERM/);
  });

  test('SIGKILL даже с fatal-looking line — всё равно unknown', () => {
    const r = classify({
      ...baseInput,
      source: 'ytdlp_stderr',
      line: 'HTTP Error 403 Forbidden',
      signal: 'SIGKILL',
    });
    assert.equal(r.severity, 'unknown');
  });
});

// ─── Rule 2: provider verdict (fatal independent of phase) ────────────────

describe('rule 2: provider verdict', () => {
  test('HTTP Error 403 → region_blocked', () => {
    const r = classify(withLine('ERROR: unable to download video: HTTP Error 403: Forbidden'));
    assert.equal(r.severity, 'fatal');
    assert.equal(r.fatalClass, 'region_blocked');
  });

  test('HTTP Error 404 → video_unavailable', () => {
    const r = classify(withLine('ERROR: HTTP Error 404: Not Found'));
    assert.equal(r.fatalClass, 'video_unavailable');
  });

  test('HTTP Error 410 → video_unavailable', () => {
    const r = classify(withLine('WARNING: HTTP Error 410 Gone'));
    assert.equal(r.fatalClass, 'video_unavailable');
  });

  test('Video unavailable → video_unavailable', () => {
    const r = classify(withLine('ERROR: Video unavailable'));
    assert.equal(r.fatalClass, 'video_unavailable');
  });

  test('Private video → video_unavailable', () => {
    const r = classify(withLine('ERROR: Private video. Sign in if you\'ve been granted access'));
    assert.equal(r.fatalClass, 'video_unavailable');
  });

  test('Sign in to confirm your age → age_restricted', () => {
    const r = classify(withLine('ERROR: Sign in to confirm your age'));
    assert.equal(r.fatalClass, 'age_restricted');
  });

  test('Playback on other websites has been disabled → embed_disabled', () => {
    const r = classify(withLine('ERROR: Playback on other websites has been disabled by the video owner'));
    assert.equal(r.fatalClass, 'embed_disabled');
  });

  test('Unable to extract → extractor_error', () => {
    const r = classify(withLine('ERROR: Unable to extract initial player response; please report this'));
    assert.equal(r.fatalClass, 'extractor_error');
  });

  test('Unsupported URL → extractor_error', () => {
    const r = classify(withLine('ERROR: Unsupported URL: https://example.com/foo'));
    assert.equal(r.fatalClass, 'extractor_error');
  });

  test('provider verdict fatal независимо от phase', () => {
    for (const phase of ['SPAWNED', 'FLOWING', 'STABLE', 'ENDING', 'TERMINATED']) {
      const r = classify(withLine('ERROR: HTTP Error 403: Forbidden', { phase }));
      assert.equal(r.severity, 'fatal', `phase=${phase} должна быть fatal`);
      assert.equal(r.fatalClass, 'region_blocked', `phase=${phase} должна быть region_blocked`);
    }
  });
});

// ─── Rule 3: process exit code ────────────────────────────────────────────

describe('rule 3: process exit', () => {
  test('exit 0 → unknown', () => {
    const r = classify({ ...baseInput, source: 'process_exit', processCode: 0 });
    assert.equal(r.severity, 'unknown');
    assert.equal(r.reason, 'exit_ok');
  });

  test('exit non-zero, phase<STABLE → fatal:unknown_fatal', () => {
    for (const phase of ['SPAWNED', 'FLOWING', 'unknown']) {
      const r = classify({ ...baseInput, source: 'process_exit', processCode: 1, phase });
      assert.equal(r.severity, 'fatal', `phase=${phase}`);
      assert.equal(r.fatalClass, 'unknown_fatal');
    }
  });

  test('exit non-zero, phase≥STABLE → transient', () => {
    for (const phase of ['STABLE', 'ENDING', 'TERMINATED']) {
      const r = classify({ ...baseInput, source: 'process_exit', processCode: 137, phase });
      assert.equal(r.severity, 'transient', `phase=${phase}`);
      assert.equal(r.fatalClass, null);
    }
  });

  test('exit null + no signal → unknown', () => {
    const r = classify({ ...baseInput, source: 'process_exit', processCode: null });
    assert.equal(r.severity, 'unknown');
    assert.equal(r.reason, 'exit_no_code');
  });
});

// ─── Rule 4: process error event ──────────────────────────────────────────

describe('rule 4: process_error', () => {
  test('process_error без line → fatal:network_error', () => {
    const r = classify({ ...baseInput, source: 'process_error', line: null });
    assert.equal(r.severity, 'fatal');
    assert.equal(r.fatalClass, 'network_error');
  });

  test('process_error с details записывается в reason', () => {
    const r = classify({ ...baseInput, source: 'process_error', line: 'spawn ENOENT' });
    assert.equal(r.severity, 'fatal');
    assert.match(r.reason, /process_error:spawn ENOENT/);
  });

  test('process_error с очень длинным line обрезается', () => {
    const longDetails = 'x'.repeat(500);
    const r = classify({ ...baseInput, source: 'process_error', line: longDetails });
    assert.ok(r.reason.length < 300);
  });
});

// ─── Rule 5: transport noise ──────────────────────────────────────────────

describe('rule 5: transport noise', () => {
  test('Broken pipe + phase<STABLE → warning', () => {
    const r = classify(withLine('ffmpeg: error writing output: Broken pipe', { phase: 'FLOWING' }));
    assert.equal(r.severity, 'warning');
    assert.equal(r.fatalClass, null);
    assert.equal(r.reason, 'transport_noise_pre_stable');
  });

  test('Broken pipe + phase≥STABLE → transient', () => {
    const r = classify(withLine('Broken pipe', { phase: 'STABLE' }));
    assert.equal(r.severity, 'transient');
  });

  test('EPIPE pre-stable → warning', () => {
    const r = classify(withLine('write EPIPE', { phase: 'SPAWNED' }));
    assert.equal(r.severity, 'warning');
  });

  test('Invalid argument pre-stable → warning', () => {
    const r = classify(withLine('Invalid argument', { phase: 'FLOWING' }));
    assert.equal(r.severity, 'warning');
  });

  test('ECONNRESET post-stable → transient', () => {
    const r = classify(withLine('network ECONNRESET', { phase: 'STABLE' }));
    assert.equal(r.severity, 'transient');
  });

  test('transport noise НЕ переопределяет provider verdict', () => {
    const r = classify(withLine('ERROR: HTTP Error 403 Forbidden (Broken pipe follows)', { phase: 'STABLE' }));
    assert.equal(r.severity, 'fatal');
    assert.equal(r.fatalClass, 'region_blocked');
  });
});

// ─── Rule 6: unclassified error ───────────────────────────────────────────

describe('rule 6: generic error line', () => {
  test('generic ERROR без known pattern → warning', () => {
    const r = classify(withLine('ERROR: something unexpected happened', { phase: 'FLOWING' }));
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'unclassified_error_line');
  });

  test('WARNING line НЕ считается ошибкой (должно быть unknown/no_match)', () => {
    const r = classify(withLine('WARNING: deprecated feature', { phase: 'FLOWING' }));
    assert.equal(r.severity, 'unknown');
  });

  test('lowercase "error:" тоже ловится', () => {
    const r = classify(withLine('error: malformed input', { phase: 'SPAWNED' }));
    assert.equal(r.severity, 'warning');
  });
});

// ─── Rule 7: default unknown ──────────────────────────────────────────────

describe('rule 7: default unknown', () => {
  test('информационный stderr line → unknown', () => {
    const r = classify(withLine('[info] downloading format 251'));
    assert.equal(r.severity, 'unknown');
    assert.equal(r.reason, 'no_match');
  });

  test('null line + source=ytdlp_stderr → unknown', () => {
    const r = classify({ ...baseInput, source: 'ytdlp_stderr', line: null });
    assert.equal(r.severity, 'unknown');
  });

  test('пустая строка → unknown', () => {
    const r = classify(withLine(''));
    assert.equal(r.severity, 'unknown');
  });
});

// ─── Phase-specific regression tests ──────────────────────────────────────

describe('phase-aware behavior', () => {
  test('phase=unknown ведёт себя как pre-STABLE (безопасный default)', () => {
    // Transport noise + phase=unknown should be warning (pre-stable-like),
    // чтобы при отсутствии информации не скипать защитные меры.
    const r = classify(withLine('Broken pipe', { phase: 'unknown' }));
    assert.equal(r.severity, 'warning');
  });

  test('phase=unknown + non-zero exit → fatal (consrvative)', () => {
    const r = classify({ ...baseInput, source: 'process_exit', processCode: 1, phase: 'unknown' });
    assert.equal(r.severity, 'fatal');
  });
});

// ─── Invariant checks ─────────────────────────────────────────────────────

describe('invariants', () => {
  test('classify всегда возвращает object с тремя полями', () => {
    const inputs = [
      baseInput,
      withLine('anything'),
      { ...baseInput, source: 'process_exit', processCode: 0 },
      { ...baseInput, source: 'process_error', line: 'spawn ENOENT' },
    ];
    for (const inp of inputs) {
      const r = classify(inp);
      assert.equal(typeof r.severity, 'string');
      assert.ok(SEVERITIES.includes(r.severity), `severity=${r.severity}`);
      assert.ok(r.fatalClass === null || FATAL_CLASSES.includes(r.fatalClass));
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.length > 0);
    }
  });

  test('fatalClass заполнен только когда severity=fatal', () => {
    const inputs = [
      baseInput,
      withLine('[info] downloading'),
      withLine('Broken pipe', { phase: 'STABLE' }),
    ];
    for (const inp of inputs) {
      const r = classify(inp);
      if (r.severity !== 'fatal') {
        assert.equal(r.fatalClass, null, `severity=${r.severity} не должен иметь fatalClass`);
      }
    }
  });
});
