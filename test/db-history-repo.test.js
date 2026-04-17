import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHistoryRepository } from '../src/db/repo/history.js';
import { openMigratedSqliteTestDb } from './db-test-helpers.js';

test('createHistoryRepository.addPlay upserts canonical tracks and lists newest-first', async () => {
  const fixture = await openMigratedSqliteTestDb('db-history-repo-ordering');

  try {
    const repo = createHistoryRepository(fixture.connection);

    const first = await repo.addPlay({
      playId: 'play-1',
      userId: 'user-1',
      trackKey: 'youtube:dQw4w9WgXcQ',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      guildId: 'guild-1',
      sessionId: 'session-1',
      requestedBy: 'user-1',
      triggeredBy: 'autoplay',
      listenersCount: 2,
      elapsedMs: 12345,
      eventType: 'finished',
      playedAt: '2026-04-18T06:00:00.000Z',
      createdAt: '2026-04-18T06:00:00.000Z',
    });
    const second = await repo.addPlay({
      playId: 'play-2',
      userId: 'user-1',
      trackKey: 'youtube:dQw4w9WgXcQ',
      provider: 'youtube',
      sourceUrl: 'https://youtu.be/dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up (Remastered title refresh)',
      artist: 'Rick Astley',
      guildId: 'guild-1',
      sessionId: 'session-1',
      requestedBy: 'user-1',
      triggeredBy: 'manual',
      listenersCount: 1,
      elapsedMs: null,
      eventType: 'skipped',
      playedAt: '2026-04-18T06:05:00.000Z',
      createdAt: '2026-04-18T06:05:00.000Z',
    });

    assert.equal(first.trackKey, 'youtube:dQw4w9WgXcQ');
    assert.equal(second.trackKey, 'youtube:dQw4w9WgXcQ');
    assert.equal(second.title, 'Never Gonna Give You Up (Remastered title refresh)');

    const plays = await repo.listRecentPlaysByUser('user-1', { limit: 10 });
    assert.equal(plays.length, 2);
    assert.equal(plays[0].playId, 'play-2');
    assert.equal(plays[1].playId, 'play-1');
    assert.equal(plays[0].trackKey, 'youtube:dQw4w9WgXcQ');
    assert.equal(plays[0].title, 'Never Gonna Give You Up (Remastered title refresh)');

    const trackCount = fixture.connection.client
      .prepare('select count(*) as total from tracks where track_key = ?')
      .get('youtube:dQw4w9WgXcQ');
    const playCount = fixture.connection.client
      .prepare('select count(*) as total from track_plays where user_id = ?')
      .get('user-1');

    assert.equal(Number(trackCount.total), 1);
    assert.equal(Number(playCount.total), 2);
  } finally {
    await fixture.cleanup();
  }
});

test('createHistoryRepository.listRecentPlaysByUser supports eventType filtering', async () => {
  const fixture = await openMigratedSqliteTestDb('db-history-repo-filter');

  try {
    const repo = createHistoryRepository(fixture.connection);

    await repo.addPlay({
      playId: 'play-finished',
      userId: 'user-2',
      trackKey: 'youtube:9bZkp7q19f0',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
      title: 'Gangnam Style',
      artist: 'PSY',
      triggeredBy: 'manual',
      listenersCount: 3,
      eventType: 'finished',
      playedAt: '2026-04-18T07:00:00.000Z',
      createdAt: '2026-04-18T07:00:00.000Z',
    });
    await repo.addPlay({
      playId: 'play-skipped',
      userId: 'user-2',
      trackKey: 'youtube:3JZ4pnNtyxQ',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
      title: 'Numb',
      artist: 'Linkin Park',
      triggeredBy: 'manual',
      listenersCount: 3,
      eventType: 'skipped',
      playedAt: '2026-04-18T07:05:00.000Z',
      createdAt: '2026-04-18T07:05:00.000Z',
    });

    const finishedOnly = await repo.listRecentPlaysByUser('user-2', {
      limit: 10,
      eventType: 'finished',
    });

    assert.equal(finishedOnly.length, 1);
    assert.equal(finishedOnly[0].playId, 'play-finished');
    assert.equal(finishedOnly[0].eventType, 'finished');
  } finally {
    await fixture.cleanup();
  }
});

test('createHistoryRepository retention keeps only newest N plays per user and prunes orphan tracks', async () => {
  const fixture = await openMigratedSqliteTestDb('db-history-repo-retention');

  try {
    const repo = createHistoryRepository(fixture.connection, { maxPlaysPerUser: 2 });

    await repo.addPlay({
      playId: 'play-old',
      userId: 'user-3',
      trackKey: 'youtube:old-track',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=oldtrack001',
      title: 'Old Track',
      artist: 'Artist A',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T09:00:00.000Z',
      createdAt: '2026-04-18T09:00:00.000Z',
    });
    await repo.addPlay({
      playId: 'play-mid',
      userId: 'user-3',
      trackKey: 'youtube:mid-track',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=midtrack002',
      title: 'Mid Track',
      artist: 'Artist B',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T09:05:00.000Z',
      createdAt: '2026-04-18T09:05:00.000Z',
    });
    await repo.addPlay({
      playId: 'play-new',
      userId: 'user-3',
      trackKey: 'youtube:new-track',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=newtrack003',
      title: 'New Track',
      artist: 'Artist C',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T09:10:00.000Z',
      createdAt: '2026-04-18T09:10:00.000Z',
    });

    const plays = await repo.listRecentPlaysByUser('user-3', { limit: 10 });
    assert.deepEqual(plays.map((play) => play.playId), ['play-new', 'play-mid']);

    const playCount = fixture.connection.client
      .prepare('select count(*) as total from track_plays where user_id = ?')
      .get('user-3');
    const trackCount = fixture.connection.client
      .prepare('select count(*) as total from tracks')
      .get();

    assert.equal(Number(playCount.total), 2);
    assert.equal(Number(trackCount.total), 2);
  } finally {
    await fixture.cleanup();
  }
});

test('createHistoryRepository retention can be disabled explicitly', async () => {
  const fixture = await openMigratedSqliteTestDb('db-history-repo-retention-disabled');

  try {
    const repo = createHistoryRepository(fixture.connection, { maxPlaysPerUser: 0 });

    await repo.addPlay({
      playId: 'play-a',
      userId: 'user-4',
      trackKey: 'youtube:disable-a',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=disable0001',
      title: 'Disable A',
      artist: 'Artist A',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T10:00:00.000Z',
      createdAt: '2026-04-18T10:00:00.000Z',
    });
    await repo.addPlay({
      playId: 'play-b',
      userId: 'user-4',
      trackKey: 'youtube:disable-b',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=disable0002',
      title: 'Disable B',
      artist: 'Artist B',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T10:05:00.000Z',
      createdAt: '2026-04-18T10:05:00.000Z',
    });
    await repo.addPlay({
      playId: 'play-c',
      userId: 'user-4',
      trackKey: 'youtube:disable-c',
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=disable0003',
      title: 'Disable C',
      artist: 'Artist C',
      triggeredBy: 'manual',
      listenersCount: 1,
      eventType: 'finished',
      playedAt: '2026-04-18T10:10:00.000Z',
      createdAt: '2026-04-18T10:10:00.000Z',
    });

    const plays = await repo.listRecentPlaysByUser('user-4', { limit: 10 });
    assert.deepEqual(plays.map((play) => play.playId), ['play-c', 'play-b', 'play-a']);
  } finally {
    await fixture.cleanup();
  }
});
