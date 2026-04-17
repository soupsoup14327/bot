import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleCommand,
  hasPendingCommands,
  __resetCommandQueueForTests,
} from '../src/command-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('scheduleCommand: runs fn and returns its result', async () => {
  __resetCommandQueueForTests();
  const r = await scheduleCommand('g1', () => ({ ok: true, value: 42 }));
  assert.deepEqual(r, { ok: true, value: 42 });
});

test('scheduleCommand: serialises commands for the same guild (FIFO)', async () => {
  __resetCommandQueueForTests();

  const d1 = deferred();
  const d2 = deferred();
  const order = [];

  const p1 = scheduleCommand('gA', async () => {
    order.push('a-start');
    await d1.promise;
    order.push('a-end');
    return 'a';
  });

  const p2 = scheduleCommand('gA', async () => {
    order.push('b-start');
    await d2.promise;
    order.push('b-end');
    return 'b';
  });

  // Дать микрозадачам прокрутиться — b НЕ должен стартовать пока a не
  // зарезолвил свой deferred.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['a-start']);

  d1.resolve();
  await p1;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);

  d2.resolve();
  await p2;
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('scheduleCommand: different guilds run in parallel', async () => {
  __resetCommandQueueForTests();

  const d1 = deferred();
  const d2 = deferred();
  const order = [];

  const p1 = scheduleCommand('gX', async () => {
    order.push('x-start');
    await d1.promise;
    order.push('x-end');
  });

  const p2 = scheduleCommand('gY', async () => {
    order.push('y-start');
    await d2.promise;
    order.push('y-end');
  });

  await new Promise((r) => setImmediate(r));
  // Обе команды стартанули, ни одна не ждёт другую.
  assert.deepEqual(order.slice().sort(), ['x-start', 'y-start']);

  d2.resolve();
  await p2;
  d1.resolve();
  await p1;

  assert.ok(order.includes('x-end'));
  assert.ok(order.includes('y-end'));
});

test('scheduleCommand: thrown error becomes Err Result, chain continues', async () => {
  __resetCommandQueueForTests();

  const r1 = await scheduleCommand('gE', () => {
    throw new Error('boom');
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'internal_error');
  assert.match(r1.reason, /boom/);

  // Следующая команда для этой же гильдии должна отработать нормально —
  // очередь не «отравлена» предыдущей ошибкой.
  const r2 = await scheduleCommand('gE', () => ({ ok: true, value: 'next' }));
  assert.deepEqual(r2, { ok: true, value: 'next' });
});

test('scheduleCommand: rejected Promise also becomes Err Result', async () => {
  __resetCommandQueueForTests();

  const r = await scheduleCommand('gP', async () => {
    throw new Error('async-boom');
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'internal_error');
  assert.match(r.reason, /async-boom/);
});

test('scheduleCommand: tails map is cleaned up after last command resolves', async () => {
  __resetCommandQueueForTests();

  const p = scheduleCommand('gClean', () => 'done');
  assert.equal(hasPendingCommands('gClean'), true);
  await p;
  // Дать finally() шанс отработать.
  await new Promise((r) => setImmediate(r));
  assert.equal(hasPendingCommands('gClean'), false);
});

test('scheduleCommand: mid-chain command sees state mutated by previous', async () => {
  __resetCommandQueueForTests();

  // Симулируем общий state — простая переменная. Без очереди две
  // «команды» могли бы читать исходное значение до записи.
  let state = 0;

  const p1 = scheduleCommand('gS', async () => {
    const current = state;
    // Ждём микрозадачу — без очереди другой участник успел бы встрять.
    await Promise.resolve();
    state = current + 1;
    return state;
  });

  const p2 = scheduleCommand('gS', async () => {
    const current = state;
    await Promise.resolve();
    state = current + 1;
    return state;
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.equal(state, 2);
});
