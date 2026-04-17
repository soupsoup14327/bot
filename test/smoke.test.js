/**
 * Smoke-тест тестовой инфраструктуры.
 *
 * Задачи:
 *  1) Убедиться, что `node --test` запускается и обнаруживает файлы в `bot/test/`.
 *  2) Убедиться, что `node:test` + `node:assert/strict` работают в ESM-проекте.
 *  3) Убедиться, что относительный импорт из `../src/` резолвится.
 *
 * Этот файл — prerequisite для всех последующих шагов рефакторинга.
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md, Шаг 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke: node:test + assert/strict работают', () => {
  assert.equal(1 + 1, 2);
  assert.deepEqual({ a: 1 }, { a: 1 });
});

test('smoke: async-тесты поддерживаются', async () => {
  const v = await Promise.resolve(42);
  assert.equal(v, 42);
});

test('smoke: fake timers через t.mock.timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 5_000);
  assert.equal(fired, false);
  t.mock.timers.tick(5_000);
  assert.equal(fired, true);
});

test('smoke: ESM-импорт из src/ резолвится', async () => {
  /**
   * Импортируем заведомо безопасный и pure-ish модуль.
   * `queue-invariants.js` — утилиты над очередью без побочных эффектов, без Discord-зависимостей.
   */
  const mod = await import('../src/queue-invariants.js');
  assert.equal(typeof mod.sameYoutubeContent, 'function');
  assert.equal(typeof mod.pushQueueIfNotQueued, 'function');
});
