import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLikesService } from '../src/core/services/likes-service.js';
import { createLikesRepository } from '../src/db/repo/likes.js';
import { openMigratedSqliteTestDb } from './db-test-helpers.js';

test('createLikesService.emitLike toggles canonical YouTube identity across URL variants', async () => {
  const fixture = await openMigratedSqliteTestDb('likes-service-toggle');

  try {
    const repo = createLikesRepository(fixture.connection);
    const timestamps = [
      new Date('2026-04-18T04:00:00.000Z'),
      new Date('2026-04-18T04:05:00.000Z'),
    ];
    const service = createLikesService({
      repo,
      now: () => timestamps.shift() ?? new Date('2026-04-18T04:10:00.000Z'),
    });

    const added = await service.emitLike({
      userId: 'user-3',
      guildId: 'guild-1',
      url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      sessionId: 'session-1',
    });

    assert.deepEqual(added, { ok: true, removed: false });
    const stored = await service.listLikes('user-3');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].provider, 'youtube');
    assert.equal(stored[0].providerTrackId, 'youtube:dQw4w9WgXcQ');

    const removed = await service.emitLike({
      userId: 'user-3',
      guildId: 'guild-1',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      sessionId: 'session-1',
    });

    assert.deepEqual(removed, { ok: true, removed: true });
    assert.deepEqual(await service.listLikes('user-3'), []);
  } finally {
    await fixture.cleanup();
  }
});

test('createLikesService soft-fails reads and writes when the repo throws', async () => {
  const warnings = [];
  const service = createLikesService({
    repo: {
      async getLike() {
        throw new Error('db offline');
      },
      async addLike() {
        throw new Error('db offline');
      },
      async removeLike() {
        throw new Error('db offline');
      },
      async listLikesByUser() {
        throw new Error('db offline');
      },
    },
    warn: (...args) => {
      warnings.push(args.map((item) => String(item)).join(' '));
    },
  });

  const writeResult = await service.emitLike({
    userId: 'user-4',
    url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    title: 'Gangnam Style',
  });
  const readResult = await service.listLikes('user-4');

  assert.deepEqual(writeResult, { ok: false, reason: 'db_error' });
  assert.deepEqual(readResult, []);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].includes('[likes] emitLike soft-fail'), true);
  assert.equal(warnings[1].includes('[likes] listLikes soft-fail'), true);
});
