/**
 * Shape + semaphore тесты audio-pipeline (Шаг 3 плана рефакторинга).
 *
 * Полные интеграционные тесты (spawn yt-dlp + handle lifecycle) не юнит-тесты —
 * они потребуют мокать youtube-dl-exec и @discordjs/voice, что противоречит
 * принципу «юниты без сетевых вызовов и discord.js»
 * (см. test/README.md, «Что НЕ делаем в юнит-тестах»).
 *
 * Здесь проверяем: модуль импортируется, экспортирует нужную shape, семафор
 * наблюдаем через `getYtdlpSemaphoreState()`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStream, getYtdlpSemaphoreState } from '../src/audio-pipeline.js';

describe('audio-pipeline shape', () => {
  test('экспортирует createStream и getYtdlpSemaphoreState', () => {
    assert.equal(typeof createStream, 'function');
    assert.equal(typeof getYtdlpSemaphoreState, 'function');
  });

  test('getYtdlpSemaphoreState → { active, max, queued }', () => {
    const s = getYtdlpSemaphoreState();
    assert.equal(typeof s.active, 'number');
    assert.equal(typeof s.max, 'number');
    assert.equal(typeof s.queued, 'number');
    assert.ok(s.max >= 1, 'MAX_CONCURRENT_YTDLP ≥ 1');
    assert.ok(s.active >= 0);
    assert.ok(s.queued >= 0);
  });

  test('createStream({}) без url — бросает understandable error', async () => {
    await assert.rejects(() => createStream({}), /url required/);
    await assert.rejects(() => createStream({ url: null }), /url required/);
    await assert.rejects(() => createStream({ url: 123 }), /url required/);
  });
});
