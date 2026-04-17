import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHistoryService } from '../src/core/services/history-service.js';
import { createHistoryRepository } from '../src/db/repo/history.js';
import { openMigratedSqliteTestDb } from './db-test-helpers.js';

test('createHistoryService.recordPlay normalizes canonical YouTube track identity across URL variants', async () => {
  const fixture = await openMigratedSqliteTestDb('history-service-normalization');

  try {
    const repo = createHistoryRepository(fixture.connection);
    const timestamps = [
      new Date('2026-04-18T08:00:00.000Z'),
      new Date('2026-04-18T08:05:00.000Z'),
    ];
    const ids = ['play-a', 'play-b'];
    const service = createHistoryService({
      repo,
      now: () => timestamps.shift() ?? new Date('2026-04-18T08:10:00.000Z'),
      makeId: () => ids.shift() ?? 'play-fallback',
    });

    const first = await service.recordPlay({
      userId: 'user-3',
      url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      guildId: 'guild-3',
      sessionId: 'session-3',
      requestedBy: 'user-3',
      triggeredBy: 'manual',
      listenersCount: 4,
      eventType: 'finished',
    });
    const second = await service.recordPlay({
      userId: 'user-3',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      triggeredBy: 'autoplay',
      listenersCount: 1,
      eventType: 'skipped',
    });

    assert.deepEqual(first, { ok: true, playId: 'play-a' });
    assert.deepEqual(second, { ok: true, playId: 'play-b' });

    const stored = await service.listRecentHistory('user-3');
    assert.equal(stored.length, 2);
    assert.equal(stored[0].trackKey, 'youtube:dQw4w9WgXcQ');
    assert.equal(stored[1].trackKey, 'youtube:dQw4w9WgXcQ');
    assert.equal(stored[0].eventType, 'skipped');

    const tracks = fixture.connection.client
      .prepare('select count(*) as total from tracks where track_key = ?')
      .get('youtube:dQw4w9WgXcQ');
    assert.equal(Number(tracks.total), 1);
  } finally {
    await fixture.cleanup();
  }
});

test('createHistoryService soft-fails reads and writes when the repo throws', async () => {
  const warnings = [];
  const service = createHistoryService({
    repo: {
      async addPlay() {
        throw new Error('db offline');
      },
      async listRecentPlaysByUser() {
        throw new Error('db offline');
      },
    },
    warn: (...args) => {
      warnings.push(args.map((item) => String(item)).join(' '));
    },
  });

  const writeResult = await service.recordPlay({
    userId: 'user-4',
    url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    title: 'Gangnam Style',
    triggeredBy: 'manual',
    listenersCount: 2,
  });
  const readResult = await service.listRecentHistory('user-4');

  assert.deepEqual(writeResult, { ok: false, reason: 'db_error' });
  assert.deepEqual(readResult, []);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].includes('[history] recordPlay soft-fail'), true);
  assert.equal(warnings[1].includes('[history] listRecentHistory soft-fail'), true);
});
