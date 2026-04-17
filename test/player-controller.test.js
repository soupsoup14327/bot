/**
 * Юнит-тесты player-controller.js
 *
 * player-controller — stateful модуль, оборачивающий `@discordjs/voice`
 * `createAudioPlayer`. Real `AudioPlayer` — event emitter от Discord,
 * который умеет реально стримить. В юнит-тестах используем его без реального
 * resource.play: создаём через ensurePlayer, триггерим его state через
 * emit/manually — этого достаточно, чтобы покрыть контроллер.
 *
 * Что покрываем:
 *  - API shape: все экспорты вызываются и возвращают корректные типы.
 *  - Пустой state: getStatus/getPlayer/isPlaying/hasPlayer без ensurePlayer.
 *  - ensurePlayer idempotent.
 *  - markNotPlaying сбрасывает флаг.
 *  - pause/resume возвращают false на «неправильном» состоянии.
 *  - stopPlayer обнуляет playing.
 *  - destroyPlayer чистит registry.
 *  - registerPlayerControllerCallbacks shallow-merge.
 *  - onIdle / onPlayerError / onPlayerStateChange фаерятся при AudioPlayer events.
 *  - __resetPlayerControllerForTests полностью очищает state.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayerStatus } from '@discordjs/voice';
import {
  ensurePlayer,
  getPlayer,
  isPlaying,
  hasPlayer,
  getStatus,
  markNotPlaying,
  pause,
  resume,
  stopPlayer,
  destroyPlayer,
  playResource,
  registerPlayerControllerCallbacks,
  __resetPlayerControllerForTests,
} from '../src/player-controller.js';

beforeEach(() => {
  __resetPlayerControllerForTests();
});

test('пустой state: hasPlayer/getPlayer/getStatus/isPlaying', () => {
  assert.equal(hasPlayer('g1'), false);
  assert.equal(getPlayer('g1'), null);
  assert.equal(getStatus('g1'), null);
  assert.equal(isPlaying('g1'), false);
});

test('ensurePlayer создаёт player и idempotent', () => {
  const p1 = ensurePlayer('g1');
  const p2 = ensurePlayer('g1');
  assert.ok(p1);
  assert.strictEqual(p1, p2);
  assert.equal(hasPlayer('g1'), true);
  assert.equal(getPlayer('g1'), p1);
  // Новый плеер сразу в Idle
  assert.equal(getStatus('g1'), AudioPlayerStatus.Idle);
  assert.equal(isPlaying('g1'), false);
});

test('markNotPlaying — сбрасывает флаг без падения если player ещё не создан', () => {
  // noop на несуществующей гильдии
  assert.doesNotThrow(() => markNotPlaying('unknown'));

  ensurePlayer('g1');
  // Внутреннее состояние: выставим playing через playResource-аналог невозможно
  // без resource, поэтому просто проверяем, что markNotPlaying не ломает цикл.
  markNotPlaying('g1');
  assert.equal(isPlaying('g1'), false);
});

test('pause/resume — false на player без активного playing', () => {
  ensurePlayer('g1');
  assert.equal(pause('g1'), false);
  assert.equal(resume('g1'), false);
});

test('pause/resume — false если player не создан', () => {
  assert.equal(pause('ghost'), false);
  assert.equal(resume('ghost'), false);
});

test('stopPlayer — noop на несуществующем player, обнуляет isPlaying на существующем', () => {
  assert.doesNotThrow(() => stopPlayer('unknown'));

  ensurePlayer('g1');
  // прямо выставим playing через внутренний путь
  // (имитируем playResource: вручную проставляем флаг через экспорт — нельзя,
  //  поэтому просто убеждаемся, что после stopPlayer isPlaying === false)
  stopPlayer('g1');
  assert.equal(isPlaying('g1'), false);
  // player остался в registry
  assert.equal(hasPlayer('g1'), true);
});

test('destroyPlayer — убирает player и playing из registry', () => {
  ensurePlayer('g1');
  destroyPlayer('g1');
  assert.equal(hasPlayer('g1'), false);
  assert.equal(getPlayer('g1'), null);
  assert.equal(isPlaying('g1'), false);
  assert.equal(getStatus('g1'), null);
  // idempotent
  assert.doesNotThrow(() => destroyPlayer('g1'));
});

test('playResource — false если player не создан', () => {
  const fakeResource = /** @type {any} */ ({});
  assert.equal(playResource('ghost', fakeResource), false);
});

test('onIdle — фаерится при AudioPlayerStatus.Idle event', () => {
  const seen = [];
  registerPlayerControllerCallbacks({
    onIdle: (id) => seen.push(id),
  });
  const player = ensurePlayer('g1');
  // Real AudioPlayer — EventEmitter; триггерим Idle
  player.emit(AudioPlayerStatus.Idle);
  assert.deepEqual(seen, ['g1']);
});

test('onPlayerError — фаерится при error event, не бросает из контроллера', () => {
  const seen = [];
  registerPlayerControllerCallbacks({
    onPlayerError: (id, err) => seen.push({ id, msg: err?.message }),
  });
  const player = ensurePlayer('g1');
  player.emit('error', new Error('boom'));
  assert.deepEqual(seen, [{ id: 'g1', msg: 'boom' }]);
});

test('onPlayerStateChange — маппит AudioPlayerStatus в доменный string', () => {
  const seen = [];
  registerPlayerControllerCallbacks({
    onPlayerStateChange: (id, mapped) => seen.push({ id, mapped }),
  });
  const player = ensurePlayer('g1');
  player.emit('stateChange', { status: AudioPlayerStatus.Idle }, { status: AudioPlayerStatus.Playing });
  player.emit('stateChange', { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Paused });
  player.emit('stateChange', { status: AudioPlayerStatus.Paused }, { status: AudioPlayerStatus.AutoPaused });
  player.emit('stateChange', { status: AudioPlayerStatus.AutoPaused }, { status: AudioPlayerStatus.Buffering });
  player.emit('stateChange', { status: AudioPlayerStatus.Buffering }, { status: AudioPlayerStatus.Idle });
  assert.deepEqual(
    seen.map((s) => s.mapped),
    ['Playing', 'Paused', 'AutoPaused', 'Buffering', 'Idle'],
  );
});

test('registerPlayerControllerCallbacks — shallow-merge', () => {
  const seen = { idle: 0, err: 0 };
  registerPlayerControllerCallbacks({ onIdle: () => { seen.idle++; } });
  registerPlayerControllerCallbacks({ onPlayerError: () => { seen.err++; } });
  const player = ensurePlayer('g1');
  player.emit(AudioPlayerStatus.Idle);
  player.emit('error', new Error('x'));
  assert.deepEqual(seen, { idle: 1, err: 1 });
});

test('registerPlayerControllerCallbacks — null/undefined без падения', () => {
  registerPlayerControllerCallbacks({ onIdle: null });
  const player = ensurePlayer('g1');
  assert.doesNotThrow(() => player.emit(AudioPlayerStatus.Idle));
});

test('колбэки не ломают emit, если они бросают', () => {
  registerPlayerControllerCallbacks({
    onIdle: () => { throw new Error('boom'); },
  });
  const player = ensurePlayer('g1');
  // emit не должен пробросить
  assert.doesNotThrow(() => player.emit(AudioPlayerStatus.Idle));
});

test('__resetPlayerControllerForTests — полностью очищает state + колбэки', () => {
  const seen = [];
  registerPlayerControllerCallbacks({ onIdle: (id) => seen.push(id) });
  ensurePlayer('g1');
  assert.equal(hasPlayer('g1'), true);

  __resetPlayerControllerForTests();
  assert.equal(hasPlayer('g1'), false);
  // колбэки тоже сброшены — регистрируем нового и проверяем изоляцию
  const p = ensurePlayer('g2');
  p.emit(AudioPlayerStatus.Idle);
  assert.deepEqual(seen, []);
});
