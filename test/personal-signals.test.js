import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  __resetPersonalSignalsForTests,
  __setPersonalSignalsDepsForTests,
  emitLike,
  listLikes,
} from '../src/personal-signals.js';

test('personal-signals lazily builds one runtime likes service and reuses it across calls', async () => {
  const events = [];

  __setPersonalSignalsDepsForTests({
    async openDatabaseConnection() {
      events.push('open');
      return {
        async close() {
          events.push('close');
        },
      };
    },
    createLikesRepository(connection) {
      events.push(['repo', Boolean(connection)]);
      return { kind: 'repo' };
    },
    createLikesService({ repo }) {
      events.push(['service', repo.kind]);
      return {
        async emitLike(payload) {
          events.push(['emitLike', payload.userId, payload.url]);
          return { ok: true, removed: false };
        },
        async listLikes(userId) {
          events.push(['listLikes', userId]);
          return [{ userId, title: 'liked' }];
        },
      };
    },
    warn(...args) {
      events.push(['warn', ...args.map((item) => String(item))]);
    },
  });

  try {
    const first = await emitLike({
      userId: 'user-1',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
    });
    const listed = await listLikes('user-1');
    const second = await emitLike({
      userId: 'user-2',
      url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
      title: 'Gangnam Style',
    });

    assert.deepEqual(first, { ok: true, removed: false });
    assert.deepEqual(second, { ok: true, removed: false });
    assert.deepEqual(listed, [{ userId: 'user-1', title: 'liked' }]);
    assert.equal(events.filter((entry) => entry === 'open').length, 1);
    assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === 'repo').length, 1);
    assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === 'service').length, 1);
  } finally {
    await __resetPersonalSignalsForTests();
  }

  assert.equal(events.filter((entry) => entry === 'close').length, 1);
});

test('personal-signals retries bootstrap after an init failure and soft-fails the first call', async () => {
  const warnings = [];
  let openAttempts = 0;

  __setPersonalSignalsDepsForTests({
    async openDatabaseConnection() {
      openAttempts += 1;
      if (openAttempts === 1) {
        throw new Error('db boot failed');
      }
      return {
        async close() {},
      };
    },
    createLikesRepository() {
      return { kind: 'repo' };
    },
    createLikesService() {
      return {
        async emitLike() {
          return { ok: true, removed: true };
        },
        async listLikes() {
          return [{ title: 'recovered' }];
        },
      };
    },
    warn(...args) {
      warnings.push(args.map((item) => String(item)).join(' '));
    },
  });

  try {
    const first = await emitLike({
      userId: 'user-3',
      url: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
      title: 'Numb',
    });
    const second = await emitLike({
      userId: 'user-3',
      url: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
      title: 'Numb',
    });
    const listed = await listLikes('user-3');

    assert.deepEqual(first, { ok: false, reason: 'db_error' });
    assert.deepEqual(second, { ok: true, removed: true });
    assert.deepEqual(listed, [{ title: 'recovered' }]);
    assert.equal(openAttempts, 2);
    assert.equal(warnings.some((line) => line.includes('[likes] personal-signals init failed')), true);
  } finally {
    await __resetPersonalSignalsForTests();
  }
});
