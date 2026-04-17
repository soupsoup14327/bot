import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLikesRepository } from '../src/db/repo/likes.js';
import { openMigratedSqliteTestDb } from './db-test-helpers.js';

test('createLikesRepository.addLike is idempotent and listLikesByUser is ordered newest-first', async () => {
  const fixture = await openMigratedSqliteTestDb('db-likes-repo-ordering');

  try {
    const repo = createLikesRepository(fixture.connection);

    const first = await repo.addLike({
      userId: 'user-1',
      provider: 'youtube',
      providerTrackId: 'youtube:dQw4w9WgXcQ',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      likedAt: '2026-04-18T01:00:00.000Z',
      createdAt: '2026-04-18T01:00:00.000Z',
    });
    const duplicate = await repo.addLike({
      userId: 'user-1',
      provider: 'youtube',
      providerTrackId: 'youtube:dQw4w9WgXcQ',
      sourceUrl: 'https://youtu.be/dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      likedAt: '2026-04-18T01:05:00.000Z',
      createdAt: '2026-04-18T01:05:00.000Z',
    });
    const second = await repo.addLike({
      userId: 'user-1',
      provider: 'youtube',
      providerTrackId: 'youtube:9bZkp7q19f0',
      sourceUrl: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
      title: 'Gangnam Style',
      artist: 'PSY',
      likedAt: '2026-04-18T02:00:00.000Z',
      createdAt: '2026-04-18T02:00:00.000Z',
    });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(second.created, true);

    const likes = await repo.listLikesByUser('user-1', { limit: 10 });
    assert.equal(likes.length, 2);
    assert.equal(likes[0].providerTrackId, 'youtube:9bZkp7q19f0');
    assert.equal(likes[1].providerTrackId, 'youtube:dQw4w9WgXcQ');

    const likeCount = fixture.connection.client
      .prepare('select count(*) as total from track_likes where user_id = ?')
      .get('user-1');
    const userCount = fixture.connection.client
      .prepare('select count(*) as total from users where user_id = ?')
      .get('user-1');

    assert.equal(Number(likeCount.total), 2);
    assert.equal(Number(userCount.total), 1);
  } finally {
    await fixture.cleanup();
  }
});

test('createLikesRepository.removeLike is idempotent for missing and already-removed rows', async () => {
  const fixture = await openMigratedSqliteTestDb('db-likes-repo-remove');

  try {
    const repo = createLikesRepository(fixture.connection);
    const key = {
      userId: 'user-2',
      provider: 'youtube',
      providerTrackId: 'youtube:3JZ4pnNtyxQ',
    };

    const missing = await repo.removeLike(key);
    assert.deepEqual(missing, { removed: false });

    await repo.addLike({
      ...key,
      sourceUrl: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
      title: 'Numb',
      artist: 'Linkin Park',
      likedAt: '2026-04-18T03:00:00.000Z',
      createdAt: '2026-04-18T03:00:00.000Z',
    });

    const removed = await repo.removeLike(key);
    const removedAgain = await repo.removeLike(key);

    assert.deepEqual(removed, { removed: true });
    assert.deepEqual(removedAgain, { removed: false });
    assert.deepEqual(await repo.listLikesByUser('user-2'), []);
  } finally {
    await fixture.cleanup();
  }
});
