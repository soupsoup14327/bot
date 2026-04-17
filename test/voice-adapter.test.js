/**
 * Юнит-тесты voice-adapter.js
 *
 * voice-adapter — stateful модуль, оборачивающий `@discordjs/voice`. Полноценное
 * тестирование ensureVoiceConnection/stateChange слушателей требует мока
 * `@discordjs/voice` (join, entersState, subscribe, VoiceConnection) — это
 * относится к интеграционным тестам (план рефакторинга: Шаг 5 — не blocker
 * по unit-покрытию). Здесь покрываем то, что можно:
 *
 *  - API shape / public exports
 *  - пустой/неинициализированный state (getConnection, isConnectionAlive,
 *    getConnectedChannelId, awaitReady)
 *  - idempotent leave для гильдии, которой никогда не было
 *  - `leave()` всегда фаерит onVoiceGone (даже без предварительного coonnect'а)
 *  - registerVoiceAdapterCallbacks shallow-merge поведение
 *  - clearAutoLeaveTimer noop на пустом state
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerVoiceAdapterCallbacks,
  leave,
  getConnection,
  isConnectionAlive,
  getConnectedChannelId,
  clearAutoLeaveTimer,
  awaitReady,
  __resetVoiceAdapterForTests,
} from '../src/voice-adapter.js';

beforeEach(() => {
  __resetVoiceAdapterForTests();
});

test('getConnection / isConnectionAlive / getConnectedChannelId — пустое состояние', () => {
  assert.equal(getConnection('guild-1'), null);
  assert.equal(isConnectionAlive('guild-1'), false);
  assert.equal(getConnectedChannelId('guild-1'), null);
});

test('clearAutoLeaveTimer — noop на неизвестной гильдии', () => {
  assert.doesNotThrow(() => clearAutoLeaveTimer('guild-2'));
  assert.doesNotThrow(() => clearAutoLeaveTimer('guild-2'));
});

test('awaitReady — бросает, если соединения нет', async () => {
  await assert.rejects(
    () => awaitReady('guild-no-conn', 10),
    /нет соединения/,
  );
});

test('leave() всегда фаерит onVoiceGone, даже если соединения не было', () => {
  const seen = [];
  registerVoiceAdapterCallbacks({
    onVoiceGone: (id, reason) => seen.push({ id, reason }),
  });

  leave('guild-3');
  assert.deepEqual(seen, [{ id: 'guild-3', reason: 'user_leave' }]);

  leave('guild-3', 'timeout');
  assert.deepEqual(seen.at(-1), { id: 'guild-3', reason: 'timeout' });
});

test('leave() на пустом state не трогает registry и не взрывается на повторах', () => {
  registerVoiceAdapterCallbacks({
    onVoiceGone: () => {
      /* ignore */
    },
  });
  leave('g');
  leave('g');
  assert.equal(getConnection('g'), null);
  assert.equal(isConnectionAlive('g'), false);
});

test('registerVoiceAdapterCallbacks — shallow merge, перезапись полей', () => {
  const seen = [];
  registerVoiceAdapterCallbacks({
    onVoiceReady: (id) => seen.push(['ready-a', id]),
    onVoiceGone: (id) => seen.push(['gone-a', id]),
  });
  registerVoiceAdapterCallbacks({
    onVoiceGone: (id) => seen.push(['gone-b', id]),
  });
  leave('g-merge');
  assert.deepEqual(seen, [['gone-b', 'g-merge']]);
});

test('__resetVoiceAdapterForTests — полностью очищает state + колбэки', () => {
  const seen = [];
  registerVoiceAdapterCallbacks({
    onVoiceGone: (id) => seen.push(id),
  });
  leave('g-reset');
  assert.deepEqual(seen, ['g-reset']);

  __resetVoiceAdapterForTests();

  // после reset колбэк не должен срабатывать
  leave('g-reset');
  assert.deepEqual(seen, ['g-reset']);
});

test('getConnectedChannelId: строка при пустом state — всегда null', () => {
  assert.equal(getConnectedChannelId('123'), null);
  assert.equal(getConnectedChannelId(123), null); // числовой id тоже корректно приводится
});

test('leave(): ignores null/undefined колбэки без исключений', () => {
  // no callbacks registered
  assert.doesNotThrow(() => leave('g-no-cb'));
  // явно null
  registerVoiceAdapterCallbacks({ onVoiceGone: null });
  assert.doesNotThrow(() => leave('g-null-cb'));
});
