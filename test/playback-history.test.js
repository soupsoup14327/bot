import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  __resetPlaybackHistoryForTests,
  __setPlaybackHistoryDepsForTests,
  recordPlaybackHistory,
} from '../src/playback-history.js';

test('playback-history ignores events without user attribution and does not bootstrap DB', async () => {
  const events = [];

  __setPlaybackHistoryDepsForTests({
    async openDatabaseConnection() {
      events.push('open');
      return {
        async close() {
          events.push('close');
        },
      };
    },
    createHistoryRepository() {
      events.push('repo');
      return { kind: 'repo' };
    },
    createHistoryService() {
      events.push('service');
      return {
        async recordPlay() {
          events.push('recordPlay');
          return { ok: true, playId: 'play-ignored' };
        },
      };
    },
  });

  try {
    const result = await recordPlaybackHistory({
      eventType: 'finished',
      guildId: 'guild-1',
      triggeredBy: 'autoplay',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
    });

    assert.deepEqual(result, { ok: false, reason: 'ignored' });
    assert.deepEqual(events, []);
  } finally {
    await __resetPlaybackHistoryForTests();
  }
});

test('playback-history lazily builds one runtime history service and normalizes payload', async () => {
  const events = [];

  __setPlaybackHistoryDepsForTests({
    async openDatabaseConnection() {
      events.push('open');
      return {
        async close() {
          events.push('close');
        },
      };
    },
    createHistoryRepository(connection) {
      events.push(['repo', Boolean(connection)]);
      return { kind: 'repo' };
    },
    createHistoryService({ repo }) {
      events.push(['service', repo.kind]);
      return {
        async recordPlay(payload) {
          events.push(['recordPlay', payload]);
          return { ok: true, playId: `play-${events.length}` };
        },
      };
    },
  });

  try {
    const first = await recordPlaybackHistory({
      eventType: 'skipped',
      guildId: 'guild-2',
      sessionId: 'session-2',
      actor: 'actor-1',
      requestedBy: 'requester-1',
      triggeredBy: 'user',
      listenersCount: 3.9,
      elapsedMs: 42.7,
      url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
      title: 'Gangnam Style',
    });
    const second = await recordPlaybackHistory({
      eventType: 'previous',
      guildId: 'guild-2',
      actor: 'actor-2',
      triggeredBy: 'navigation',
      listenersCount: -5,
      url: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
      title: 'Numb',
    });

    assert.deepEqual(first, { ok: true, playId: 'play-4' });
    assert.deepEqual(second, { ok: true, playId: 'play-5' });
    assert.equal(events.filter((entry) => entry === 'open').length, 1);
    assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === 'repo').length, 1);
    assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === 'service').length, 1);

    const recorded = events.filter((entry) => Array.isArray(entry) && entry[0] === 'recordPlay');
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0][1].userId, 'requester-1');
    assert.equal(recorded[0][1].listenersCount, 3);
    assert.equal(recorded[0][1].elapsedMs, 42);
    assert.equal(recorded[1][1].userId, 'actor-2');
    assert.equal(recorded[1][1].listenersCount, 0);
    assert.equal(recorded[1][1].eventType, 'previous');
  } finally {
    await __resetPlaybackHistoryForTests();
  }

  assert.equal(events.filter((entry) => entry === 'close').length, 1);
});

test('playback-history retries bootstrap after an init failure and soft-fails the first call', async () => {
  const warnings = [];
  let openAttempts = 0;

  __setPlaybackHistoryDepsForTests({
    async openDatabaseConnection() {
      openAttempts += 1;
      if (openAttempts === 1) {
        throw new Error('db boot failed');
      }
      return {
        async close() {},
      };
    },
    createHistoryRepository() {
      return { kind: 'repo' };
    },
    createHistoryService() {
      return {
        async recordPlay() {
          return { ok: true, playId: 'play-recovered' };
        },
      };
    },
    warn(...args) {
      warnings.push(args.map((item) => String(item)).join(' '));
    },
  });

  try {
    const first = await recordPlaybackHistory({
      eventType: 'finished',
      requestedBy: 'user-3',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
    });
    const second = await recordPlaybackHistory({
      eventType: 'finished',
      requestedBy: 'user-3',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
    });

    assert.deepEqual(first, { ok: false, reason: 'db_error' });
    assert.deepEqual(second, { ok: true, playId: 'play-recovered' });
    assert.equal(openAttempts, 2);
    assert.equal(warnings.some((line) => line.includes('[history] playback-history init failed')), true);
  } finally {
    await __resetPlaybackHistoryForTests();
  }
});
