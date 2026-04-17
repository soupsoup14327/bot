/**
 * Юнит-тесты для player-idle-verdict.js.
 *
 * resolveIdleVerdict — чистая функция-арбитр, решающая реакцию на
 * AudioPlayerStatus.Idle. Snapshot входов (wasPlaying, streamFailed,
 * suppressFinished, repeatOn) → плоский verdict без enum-а.
 *
 * Цели тестов:
 *   1. Полная таблица 2⁴ = 16 комбинаций — гарантия тотального покрытия.
 *   2. Инварианты: ignore ⇔ !wasPlaying; scheduleNext ⇔ !ignore;
 *      emitTrackFinished ⇒ wasPlaying && !streamFailed && !suppressFinished;
 *      forceSkipFromQueue ⇒ wasPlaying && streamFailed && repeatOn.
 *   3. «Документированные» кейсы, которые важно не поломать случайно:
 *      - suppressFinished + repeatOn → forceSkipFromQueue=false (чтобы не
 *        было двойного shift с pre-stop applySkipRepeatHeadShift).
 *      - streamFailed + repeatOn → forceSkipFromQueue=true (иначе петля
 *        упавшего трека при repeat).
 *      - streamFailed + !repeatOn → forceSkipFromQueue=false (очередь
 *        двигается в runPlayNext по обычному пути).
 *      - ignore-ветка — все флаги false, scheduleNext=false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdleVerdict } from '../src/player-idle-verdict.js';

/**
 * Перебор всех 16 комбинаций boolean-входов.
 * @returns {{ input: { wasPlaying: boolean, streamFailed: boolean, suppressFinished: boolean, repeatOn: boolean }, label: string }[]}
 */
function allCombinations() {
  const out = [];
  for (const wasPlaying of [false, true]) {
    for (const streamFailed of [false, true]) {
      for (const suppressFinished of [false, true]) {
        for (const repeatOn of [false, true]) {
          out.push({
            input: { wasPlaying, streamFailed, suppressFinished, repeatOn },
            label: `wasPlaying=${wasPlaying} streamFailed=${streamFailed} suppressFinished=${suppressFinished} repeatOn=${repeatOn}`,
          });
        }
      }
    }
  }
  return out;
}

test('resolveIdleVerdict: verdict имеет ровно 4 boolean поля', () => {
  const v = resolveIdleVerdict({ wasPlaying: true, streamFailed: false, suppressFinished: false, repeatOn: false });
  assert.deepEqual(
    Object.keys(v).sort(),
    ['emitTrackFinished', 'forceSkipFromQueue', 'ignore', 'scheduleNext'],
  );
  for (const k of Object.keys(v)) {
    assert.equal(typeof v[k], 'boolean', `${k} должен быть boolean`);
  }
});

test('resolveIdleVerdict: null/undefined input → ignore verdict', () => {
  for (const bad of [null, undefined]) {
    const v = resolveIdleVerdict(bad);
    assert.equal(v.ignore, true);
    assert.equal(v.emitTrackFinished, false);
    assert.equal(v.forceSkipFromQueue, false);
    assert.equal(v.scheduleNext, false);
  }
});

test('resolveIdleVerdict: полная таблица 2⁴ = 16 комбинаций', () => {
  for (const { input, label } of allCombinations()) {
    const v = resolveIdleVerdict(input);

    if (!input.wasPlaying) {
      assert.deepEqual(
        v,
        { ignore: true, emitTrackFinished: false, forceSkipFromQueue: false, scheduleNext: false },
        `[${label}] !wasPlaying должен дать ignore-verdict`,
      );
      continue;
    }

    assert.equal(v.ignore, false, `[${label}] wasPlaying=true → ignore=false`);
    assert.equal(v.scheduleNext, true, `[${label}] wasPlaying=true → scheduleNext=true`);

    const expectedEmit = !input.streamFailed && !input.suppressFinished;
    assert.equal(
      v.emitTrackFinished,
      expectedEmit,
      `[${label}] emitTrackFinished = !streamFailed && !suppressFinished`,
    );

    const expectedForceSkip = input.streamFailed && input.repeatOn;
    assert.equal(
      v.forceSkipFromQueue,
      expectedForceSkip,
      `[${label}] forceSkipFromQueue = streamFailed && repeatOn`,
    );
  }
});

test('resolveIdleVerdict: инвариант — ignore ⇔ !wasPlaying', () => {
  for (const { input } of allCombinations()) {
    const v = resolveIdleVerdict(input);
    assert.equal(v.ignore, !input.wasPlaying);
  }
});

test('resolveIdleVerdict: инвариант — scheduleNext ⇔ !ignore', () => {
  for (const { input } of allCombinations()) {
    const v = resolveIdleVerdict(input);
    assert.equal(v.scheduleNext, !v.ignore);
  }
});

test('resolveIdleVerdict: инвариант — emitTrackFinished ⇒ wasPlaying && !streamFailed && !suppressFinished', () => {
  for (const { input } of allCombinations()) {
    const v = resolveIdleVerdict(input);
    if (v.emitTrackFinished) {
      assert.ok(input.wasPlaying, 'emitTrackFinished → wasPlaying');
      assert.ok(!input.streamFailed, 'emitTrackFinished → !streamFailed');
      assert.ok(!input.suppressFinished, 'emitTrackFinished → !suppressFinished');
    }
  }
});

test('resolveIdleVerdict: инвариант — forceSkipFromQueue ⇒ wasPlaying && streamFailed && repeatOn', () => {
  for (const { input } of allCombinations()) {
    const v = resolveIdleVerdict(input);
    if (v.forceSkipFromQueue) {
      assert.ok(input.wasPlaying, 'forceSkip → wasPlaying');
      assert.ok(input.streamFailed, 'forceSkip → streamFailed');
      assert.ok(input.repeatOn, 'forceSkip → repeatOn');
    }
  }
});

test('resolveIdleVerdict: natural finish — emit + scheduleNext, без force-skip', () => {
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: false, suppressFinished: false, repeatOn: false,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: true,
    forceSkipFromQueue: false,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: natural finish + repeatOn — всё равно без force-skip (repeat сохраняет трек)', () => {
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: false, suppressFinished: false, repeatOn: true,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: true,
    forceSkipFromQueue: false,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: skip_suppressed — НЕТ emit, НЕТ force-skip (pre-stop уже сдвинул)', () => {
  // suppressFinished=true + repeatOn=true — именно тот кейс, где раньше мог
  // соблазнить «force-skip здесь». Нельзя: applySkipRepeatHeadShift уже сделал
  // queue.shift() в pre-stop. Двойной shift = пропуск лишнего трека.
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: false, suppressFinished: true, repeatOn: true,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: false,
    forceSkipFromQueue: false,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: skip_suppressed (repeatOff) — так же без force-skip', () => {
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: false, suppressFinished: true, repeatOn: false,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: false,
    forceSkipFromQueue: false,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: stream_error + repeatOn → force-skip (защита от петли упавшего трека)', () => {
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: true, suppressFinished: false, repeatOn: true,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: false,
    forceSkipFromQueue: true,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: stream_error + repeatOff → без force-skip (очередь двигает runPlayNext)', () => {
  const v = resolveIdleVerdict({
    wasPlaying: true, streamFailed: true, suppressFinished: false, repeatOn: false,
  });
  assert.deepEqual(v, {
    ignore: false,
    emitTrackFinished: false,
    forceSkipFromQueue: false,
    scheduleNext: true,
  });
});

test('resolveIdleVerdict: stream_error + suppressFinished — не emit, force-skip зависит только от repeatOn', () => {
  // Бывший редкий кейс: yt-dlp упал ровно в момент ручного skip.
  // suppressFinished не должен подавлять защиту от repeat-петли при stream_error.
  const vRepeat = resolveIdleVerdict({
    wasPlaying: true, streamFailed: true, suppressFinished: true, repeatOn: true,
  });
  assert.equal(vRepeat.forceSkipFromQueue, true);
  assert.equal(vRepeat.emitTrackFinished, false);

  const vNoRepeat = resolveIdleVerdict({
    wasPlaying: true, streamFailed: true, suppressFinished: true, repeatOn: false,
  });
  assert.equal(vNoRepeat.forceSkipFromQueue, false);
  assert.equal(vNoRepeat.emitTrackFinished, false);
});

test('resolveIdleVerdict: !wasPlaying — игнор независимо от остальных флагов', () => {
  for (const streamFailed of [false, true]) {
    for (const suppressFinished of [false, true]) {
      for (const repeatOn of [false, true]) {
        const v = resolveIdleVerdict({ wasPlaying: false, streamFailed, suppressFinished, repeatOn });
        assert.deepEqual(v, {
          ignore: true,
          emitTrackFinished: false,
          forceSkipFromQueue: false,
          scheduleNext: false,
        });
      }
    }
  }
});

test('resolveIdleVerdict: pure — одинаковый input даёт одинаковый verdict', () => {
  const input = { wasPlaying: true, streamFailed: false, suppressFinished: false, repeatOn: true };
  const v1 = resolveIdleVerdict(input);
  const v2 = resolveIdleVerdict(input);
  assert.deepEqual(v1, v2);
  assert.notEqual(v1, v2, 'возвращает новый объект, не мутирует');
});

test('resolveIdleVerdict: не мутирует input', () => {
  const input = Object.freeze({ wasPlaying: true, streamFailed: true, suppressFinished: false, repeatOn: true });
  assert.doesNotThrow(() => resolveIdleVerdict(input));
});
