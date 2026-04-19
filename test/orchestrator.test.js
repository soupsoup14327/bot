/**
 * Shape- и поведенческие тесты orchestrator.
 *
 * Шаг 3: только skeleton-контракт.
 * Шаг 5: в `events.onVoiceReady/onVoiceGone` приехала реальная реакция на
 *        voice-lifecycle (startSession/endSession + setBotVoiceState).
 * Шаг 7: `commands.*` получил полный набор прокси над music.js с единым
 *        `Result<T>` возвратом — проверяем контракт: форма, ключи, invalid-argument.
 *
 * Логика делегированных вызовов (skip/pause/previousTrack/...) покрыта
 * тестами соответствующих модулей. Тут — только «шлюзовые» инварианты.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrator, commands, events } from '../src/orchestrator.js';
import {
  currentQueueItemByGuild,
  endSession,
  getGuildSessionSnapshot,
  getSessionId,
} from '../src/guild-session-state.js';

const GID = 'orchestrator-test-guild';

beforeEach(() => {
  endSession(GID);
});

describe('orchestrator shape', () => {
  test('экспортирует commands, events и объединённый orchestrator', () => {
    assert.equal(typeof orchestrator, 'object');
    assert.equal(typeof commands, 'object');
    assert.equal(typeof events, 'object');
    assert.equal(orchestrator.commands, commands);
    assert.equal(orchestrator.events, events);
  });

  test('commands и events заморожены (против случайных присваиваний)', () => {
    assert.equal(Object.isFrozen(commands), true);
    assert.equal(Object.isFrozen(events), true);
    assert.equal(Object.isFrozen(orchestrator), true);
  });

  test('commands содержит все ключи use-case API (Шаг 7)', () => {
    const expected = [
      'enqueue',
      'skip',
      'previousTrack',
      'pause',
      'resume',
      'toggleRepeat',
      'toggleAutoplay',
      'stopAndLeave',
    ];
    const actual = Object.keys(commands).sort();
    assert.deepEqual(actual, [...expected].sort());
    for (const k of expected) {
      assert.equal(typeof commands[k], 'function', `commands.${k} должен быть функцией`);
    }
  });
});

describe('orchestrator.commands Result contract (Шаг 7)', () => {
  /**
   * Хелпер: убедиться что значение — валидный Err-Result.
   * @param {unknown} res
   * @param {string} expectedCode
   */
  function assertErr(res, expectedCode) {
    assert.equal(typeof res, 'object');
    assert.notEqual(res, null);
    assert.equal(/** @type {any} */ (res).ok, false);
    assert.equal(typeof /** @type {any} */ (res).reason, 'string');
    assert.equal(/** @type {any} */ (res).code, expectedCode);
  }

  test('skip(null) → Err invalid_argument', async () => {
    assertErr(await commands.skip(null), 'invalid_argument');
    assertErr(await commands.skip(undefined), 'invalid_argument');
    assertErr(await commands.skip(''), 'invalid_argument');
  });

  test('previousTrack(null) → Err invalid_argument', async () => {
    assertErr(await commands.previousTrack(null), 'invalid_argument');
    assertErr(await commands.previousTrack(undefined), 'invalid_argument');
  });

  test('pause(null) / resume(null) → Err invalid_argument', async () => {
    assertErr(await commands.pause(null), 'invalid_argument');
    assertErr(await commands.resume(undefined), 'invalid_argument');
  });

  test('toggleRepeat(null) / toggleAutoplay(null) → Err invalid_argument', async () => {
    assertErr(await commands.toggleRepeat(null), 'invalid_argument');
    assertErr(await commands.toggleAutoplay(null), 'invalid_argument');
  });

  test('stopAndLeave(null) → Err invalid_argument', async () => {
    assertErr(await commands.stopAndLeave(null), 'invalid_argument');
  });

  test('enqueue без channel → Err invalid_argument', async () => {
    assertErr(await commands.enqueue(null), 'invalid_argument');
    assertErr(await commands.enqueue({ query: 'anything' }), 'invalid_argument');
  });

  test('enqueue с пустым query → Err invalid_argument', async () => {
    const fakeChannel = { guild: { id: GID } };
    assertErr(await commands.enqueue({ channel: fakeChannel, query: '' }), 'invalid_argument');
    assertErr(await commands.enqueue({ channel: fakeChannel, query: '   ' }), 'invalid_argument');
  });

  test('skip/previousTrack с живым guildId, но без плеера → Err (доменный код)', async () => {
    // Нет ensurePlayer для UNKNOWN_GUILD — music.skip/previousTrack вернут false.
    // Проверяем что прокси оборачивает false в осмысленный Err с code.
    const unknownGuild = `orchestrator-no-player-${Date.now()}`;
    const r1 = await commands.skip(unknownGuild);
    assert.equal(r1.ok, false);
    assert.equal(/** @type {any} */ (r1).code, 'not_playing');
    const r2 = await commands.previousTrack(unknownGuild);
    assert.equal(r2.ok, false);
    assert.equal(/** @type {any} */ (r2).code, 'no_history');
  });

  test('toggleRepeat/toggleAutoplay на свежем guildId → Ok с enabled=true, повтор → false', async () => {
    const freshGuild = `orchestrator-toggle-${Date.now()}`;
    const r1 = await commands.toggleRepeat(freshGuild);
    assert.equal(r1.ok, true);
    assert.equal(/** @type {any} */ (r1).value.enabled, true);
    const r2 = await commands.toggleRepeat(freshGuild);
    assert.equal(r2.ok, true);
    assert.equal(/** @type {any} */ (r2).value.enabled, false);

    const a1 = await commands.toggleAutoplay(freshGuild);
    assert.equal(a1.ok, true);
    assert.equal(/** @type {any} */ (a1).value.enabled, true);
    // Repeat уже off после второго toggleRepeat → toggleAutoplay не должен ронять инвариант
    const a2 = await commands.toggleAutoplay(freshGuild);
    assert.equal(a2.ok, true);
    assert.equal(/** @type {any} */ (a2).value.enabled, false);
  });

  test('stopAndLeave на любом guildId идемпотентен и возвращает Ok', async () => {
    const freshGuild = `orchestrator-stop-${Date.now()}`;
    const r1 = await commands.stopAndLeave(freshGuild);
    assert.equal(r1.ok, true);
    const r2 = await commands.stopAndLeave(freshGuild);
    assert.equal(r2.ok, true);
  });

  test('pause/resume на guildId без плеера → Err not_applicable', async () => {
    const unknownGuild = `orchestrator-pause-${Date.now()}`;
    const rp = await commands.pause(unknownGuild);
    assert.equal(rp.ok, false);
    assert.equal(/** @type {any} */ (rp).code, 'not_applicable');
    const rr = await commands.resume(unknownGuild);
    assert.equal(rr.ok, false);
    assert.equal(/** @type {any} */ (rr).code, 'not_applicable');
  });

  test('Ok-результаты заморожены (Result иммутабелен)', async () => {
    const fresh = `orchestrator-freeze-${Date.now()}`;
    const r = await commands.stopAndLeave(fresh);
    assert.equal(Object.isFrozen(r), true);
    const r2 = await commands.toggleRepeat(fresh);
    assert.equal(Object.isFrozen(r2), true);
  });

  test('Err-результаты заморожены', async () => {
    const r = await commands.skip(null);
    assert.equal(Object.isFrozen(r), true);
  });
});

describe('orchestrator.events voice lifecycle (Шаг 5)', () => {
  test('events.onVoiceReady — стартует сессию и ставит botConnected=true', () => {
    assert.equal(getSessionId(GID), null);
    events.onVoiceReady(GID, 'channel-42');
    assert.equal(typeof getSessionId(GID), 'string');
    const snap = getGuildSessionSnapshot(GID);
    assert.equal(snap.botConnected, true);
    assert.equal(snap.voiceChannelId, 'channel-42');
  });

  test('events.onVoiceGone — завершает сессию и ставит botConnected=false', () => {
    events.onVoiceReady(GID, 'channel-7');
    assert.notEqual(getSessionId(GID), null);
    events.onVoiceGone(GID, 'user_leave');
    assert.equal(getSessionId(GID), null);
    const snap = getGuildSessionSnapshot(GID);
    assert.equal(snap.botConnected, false);
    assert.equal(snap.voiceChannelId, null);
  });

  test('events.onVoiceGone идемпотентен — повторный вызов не бросает', () => {
    events.onVoiceGone(GID, 'user_leave');
    assert.doesNotThrow(() => events.onVoiceGone(GID, 'timeout'));
    assert.doesNotThrow(() => events.onVoiceGone(GID, 'connection_destroy'));
    assert.equal(getSessionId(GID), null);
  });

  test('getGuildSessionSnapshot exposes current autoplay spawn id when present', () => {
    events.onVoiceReady(GID, 'channel-99');
    currentQueueItemByGuild.set(GID, {
      url: 'https://www.youtube.com/watch?v=abc123defgh',
      source: 'autoplay',
      spawnId: 'spawn:test-session:42',
      title: 'Test title',
    });
    const snap = getGuildSessionSnapshot(GID);
    assert.equal(snap.currentTrackSpawnId, 'spawn:test-session:42');
  });
});
