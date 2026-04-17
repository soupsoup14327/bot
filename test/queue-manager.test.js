/**
 * Unit-тесты queue-manager.js.
 *
 * Blocker по docs/ПЛАН-РЕФАКТОРИНГА.md (Шаг 4).
 *
 * Проверяется:
 *  - Базовые операции: enqueue, peek, dequeue, clear, length.
 *  - Dedup-инварианты (sameTrackContent) для enqueueIfNotQueued / unshiftIfNewHead.
 *  - Идентичность по reference для shiftIfHead / removeItem.
 *  - Изоляция между guildId.
 *  - Defensive copy у getQueueSnapshot.
 *  - QueueOps — замороженный binding с корректной seman­тикой.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueTrack,
  enqueueTrackIfNotQueued,
  unshiftTrack,
  unshiftTrackIfNewHead,
  peekNext,
  dequeueNext,
  shiftIfHead,
  removeItem,
  clearQueue,
  getQueueLength,
  getQueueSnapshot,
  getQueueOps,
  __resetAllQueuesForTests,
} from '../src/queue-manager.js';

const G = 'guild-A';
const G2 = 'guild-B';

/** Trivial QueueItem builder; source='single' по умолчанию. */
function item(url, extra = {}) {
  return { url, source: 'single', ...extra };
}

/** Стандартный youtube watch-URL для дедупа по video_id. */
function yt(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

beforeEach(() => {
  __resetAllQueuesForTests();
});

// ─── Базовые операции ────────────────────────────────────────────────────────

test('enqueueTrack / peekNext / getQueueLength — push в хвост и чтение без мутации', () => {
  enqueueTrack(G, item('a'));
  enqueueTrack(G, item('b'));
  assert.equal(getQueueLength(G), 2);
  const head1 = peekNext(G);
  assert.equal(head1?.url, 'a');
  const head2 = peekNext(G);
  assert.equal(head2?.url, 'a');
  assert.equal(getQueueLength(G), 2, 'peek не должен мутировать длину');
});

test('dequeueNext снимает head и возвращает его; null на пустой очереди', () => {
  enqueueTrack(G, item('a'));
  enqueueTrack(G, item('b'));
  const first = dequeueNext(G);
  assert.equal(first?.url, 'a');
  assert.equal(getQueueLength(G), 1);
  const second = dequeueNext(G);
  assert.equal(second?.url, 'b');
  assert.equal(getQueueLength(G), 0);
  assert.equal(dequeueNext(G), null);
});

test('peekNext / getQueueLength на неинициализированной гильдии → null / 0', () => {
  assert.equal(peekNext('no-such-guild'), null);
  assert.equal(getQueueLength('no-such-guild'), 0);
});

test('clearQueue опустошает очередь', () => {
  enqueueTrack(G, item('a'));
  enqueueTrack(G, item('b'));
  enqueueTrack(G, item('c'));
  clearQueue(G);
  assert.equal(getQueueLength(G), 0);
  assert.equal(peekNext(G), null);
});

test('clearQueue на неинициализированной гильдии — no-op', () => {
  assert.doesNotThrow(() => clearQueue('never-seen'));
});

// ─── unshift ─────────────────────────────────────────────────────────────────

test('unshiftTrack безусловно добавляет на голову', () => {
  enqueueTrack(G, item('b'));
  unshiftTrack(G, item('a'));
  assert.equal(getQueueLength(G), 2);
  assert.equal(peekNext(G)?.url, 'a');
});

test('unshiftTrackIfNewHead: пустая очередь → добавляет, возвращает true', () => {
  const ok = unshiftTrackIfNewHead(G, item(yt('AAAAAAAAAAA')));
  assert.equal(ok, true);
  assert.equal(getQueueLength(G), 1);
});

test('unshiftTrackIfNewHead: голова — тот же трек → no-op, false', () => {
  enqueueTrack(G, item(yt('AAAAAAAAAAA')));
  const ok = unshiftTrackIfNewHead(G, item(yt('AAAAAAAAAAA')));
  assert.equal(ok, false);
  assert.equal(getQueueLength(G), 1);
});

test('unshiftTrackIfNewHead: голова — другой трек → добавляет', () => {
  enqueueTrack(G, item(yt('BBBBBBBBBBB')));
  const ok = unshiftTrackIfNewHead(G, item(yt('AAAAAAAAAAA')));
  assert.equal(ok, true);
  assert.equal(getQueueLength(G), 2);
  assert.equal(peekNext(G)?.url, yt('AAAAAAAAAAA'));
});

test('unshiftTrackIfNewHead: dedup по video_id работает между разными форматами URL', () => {
  enqueueTrack(G, item('https://youtu.be/AAAAAAAAAAA'));
  const ok = unshiftTrackIfNewHead(G, item('https://www.youtube.com/watch?v=AAAAAAAAAAA'));
  assert.equal(ok, false, 'youtu.be и watch?v= — один и тот же видео-id');
  assert.equal(getQueueLength(G), 1);
});

// ─── enqueueTrackIfNotQueued ─────────────────────────────────────────────────

test('enqueueTrackIfNotQueued: пустая очередь → добавляет', () => {
  const ok = enqueueTrackIfNotQueued(G, item(yt('AAAAAAAAAAA')));
  assert.equal(ok, true);
  assert.equal(getQueueLength(G), 1);
});

test('enqueueTrackIfNotQueued: трек уже в очереди (любая позиция) → no-op', () => {
  enqueueTrack(G, item(yt('AAAAAAAAAAA')));
  enqueueTrack(G, item(yt('BBBBBBBBBBB')));
  const ok = enqueueTrackIfNotQueued(G, item(yt('BBBBBBBBBBB')));
  assert.equal(ok, false);
  assert.equal(getQueueLength(G), 2);
});

test('enqueueTrackIfNotQueued: разные треки добавляются', () => {
  enqueueTrackIfNotQueued(G, item(yt('AAAAAAAAAAA')));
  enqueueTrackIfNotQueued(G, item(yt('BBBBBBBBBBB')));
  enqueueTrackIfNotQueued(G, item(yt('CCCCCCCCCCC')));
  assert.equal(getQueueLength(G), 3);
});

// ─── shiftIfHead / removeItem (reference identity) ───────────────────────────

test('shiftIfHead: голова === item → снимает, true', () => {
  const a = item('a');
  const b = item('b');
  enqueueTrack(G, a);
  enqueueTrack(G, b);
  const ok = shiftIfHead(G, a);
  assert.equal(ok, true);
  assert.equal(getQueueLength(G), 1);
  assert.equal(peekNext(G)?.url, 'b');
});

test('shiftIfHead: голова !== item → no-op, false', () => {
  const a = item('a');
  const b = item('b');
  enqueueTrack(G, a);
  enqueueTrack(G, b);
  const ok = shiftIfHead(G, b);
  assert.equal(ok, false, 'b не на голове — ничего не трогаем');
  assert.equal(getQueueLength(G), 2);
});

test('shiftIfHead: пустая очередь → false', () => {
  assert.equal(shiftIfHead(G, item('a')), false);
});

test('shiftIfHead: одинаковое содержимое, но разные references → false', () => {
  const a = item('a');
  const aClone = item('a');
  enqueueTrack(G, a);
  const ok = shiftIfHead(G, aClone);
  assert.equal(ok, false, 'identity, не equality');
  assert.equal(getQueueLength(G), 1);
});

test('removeItem: на голове → удаляет, true', () => {
  const a = item('a');
  const b = item('b');
  enqueueTrack(G, a);
  enqueueTrack(G, b);
  const ok = removeItem(G, a);
  assert.equal(ok, true);
  assert.equal(getQueueLength(G), 1);
  assert.equal(peekNext(G)?.url, 'b');
});

test('removeItem: в середине → удаляет, true', () => {
  const a = item('a');
  const b = item('b');
  const c = item('c');
  enqueueTrack(G, a);
  enqueueTrack(G, b);
  enqueueTrack(G, c);
  const ok = removeItem(G, b);
  assert.equal(ok, true);
  const snap = getQueueSnapshot(G);
  assert.deepEqual(snap.map((i) => i.url), ['a', 'c']);
});

test('removeItem: item не найден → false', () => {
  enqueueTrack(G, item('a'));
  const ok = removeItem(G, item('ghost'));
  assert.equal(ok, false);
  assert.equal(getQueueLength(G), 1);
});

test('removeItem на неинициализированной гильдии → false', () => {
  assert.equal(removeItem('no-guild', item('a')), false);
});

// ─── Изоляция между guildId ──────────────────────────────────────────────────

test('разные guildId имеют независимые очереди', () => {
  enqueueTrack(G, item('a'));
  enqueueTrack(G2, item('x'));
  enqueueTrack(G2, item('y'));
  assert.equal(getQueueLength(G), 1);
  assert.equal(getQueueLength(G2), 2);
  clearQueue(G);
  assert.equal(getQueueLength(G), 0);
  assert.equal(getQueueLength(G2), 2, 'clear у G не должен трогать G2');
});

// ─── getQueueSnapshot: defensive copy ────────────────────────────────────────

test('getQueueSnapshot: мутация результата не затрагивает внутренний массив', () => {
  enqueueTrack(G, item('a'));
  enqueueTrack(G, item('b'));
  const snap = getQueueSnapshot(G);
  snap.push(item('xxx'));
  snap.shift();
  assert.equal(getQueueLength(G), 2);
  assert.equal(peekNext(G)?.url, 'a');
});

test('getQueueSnapshot: пустая гильдия → пустой массив', () => {
  assert.deepEqual(getQueueSnapshot('never-seen'), []);
});

// ─── QueueOps ────────────────────────────────────────────────────────────────

test('getQueueOps: все методы ведут себя идентично прямому API', () => {
  const ops = getQueueOps(G);
  ops.push(item('a'));
  ops.push(item('b'));
  assert.equal(ops.length(), 2);
  assert.equal(ops.peek()?.url, 'a');
  const head = ops.shift();
  assert.equal(head?.url, 'a');
  assert.equal(getQueueLength(G), 1, 'ops.shift должен мутировать общий store');
});

test('getQueueOps: возвращаемый объект заморожен', () => {
  const ops = getQueueOps(G);
  assert.equal(Object.isFrozen(ops), true);
  assert.throws(
    () => {
      // @ts-expect-error тест на frozen
      ops.push = () => {};
    },
    TypeError,
    'strict mode должен бросить на присваивании в frozen',
  );
});

test('getQueueOps: pushIfNotQueued / unshiftIfNewHead используют dedup', () => {
  const ops = getQueueOps(G);
  assert.equal(ops.pushIfNotQueued(item(yt('AAAAAAAAAAA'))), true);
  assert.equal(ops.pushIfNotQueued(item(yt('AAAAAAAAAAA'))), false);
  assert.equal(ops.unshiftIfNewHead(item(yt('AAAAAAAAAAA'))), false);
  assert.equal(ops.unshiftIfNewHead(item(yt('BBBBBBBBBBB'))), true);
  assert.equal(ops.length(), 2);
  assert.equal(ops.peek()?.url, yt('BBBBBBBBBBB'));
});

test('getQueueOps: shiftIfHead / removeItem работают по reference', () => {
  const ops = getQueueOps(G);
  const a = item('a');
  const b = item('b');
  ops.push(a);
  ops.push(b);
  assert.equal(ops.shiftIfHead(b), false, 'b не на голове');
  assert.equal(ops.shiftIfHead(a), true);
  assert.equal(ops.length(), 1);
  assert.equal(ops.removeItem(b), true);
  assert.equal(ops.length(), 0);
});

test('getQueueOps: разные guildId дают независимые binding-ы', () => {
  const opsA = getQueueOps(G);
  const opsB = getQueueOps(G2);
  opsA.push(item('a'));
  opsB.push(item('x'));
  opsB.push(item('y'));
  assert.equal(opsA.length(), 1);
  assert.equal(opsB.length(), 2);
});

// ─── Edge: guildId как non-string ────────────────────────────────────────────

test('числовой guildId нормализуется к строке (одна и та же очередь)', () => {
  // @ts-expect-error тест нормализации: мы принимаем string | number
  enqueueTrack(12345, item('a'));
  assert.equal(getQueueLength('12345'), 1);
  assert.equal(getQueueLength(String(12345)), 1);
});
