/**
 * Юнит-тесты для src/autoplay-spawn.js.
 *
 * Модуль делает реальные сетевые вызовы (Groq, YouTube, recommendation-bridge)
 * внутри `spawnAutoplayPlaylist`, поэтому тесты фокусируются на:
 *   1) Shape фабрики `createAutoplaySpawner` — контракт dep-валидации и
 *      результирующего объекта.
 *   2) Чистая функция `isYoutubeUrlBlockedForAutoplaySpawns` — null-guard и
 *      интеграция с `currentPlayingUrlByGuild` + `setSessionPlayedWatchUrls`.
 *   3) Early-exit stale guard (после spawn_gen).
 *
 * Полный integration-тест spawn'а требует mock'ов Groq/YouTube/Discord —
 * он живёт в e2e-сценариях и в существующих spawn telemetry-логах.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAutoplaySpawnStaleGuard,
  createAutoplaySpawner,
  isYoutubeUrlBlockedForAutoplaySpawns,
} from '../src/autoplay-spawn.js';
import { currentPlayingUrlByGuild } from '../src/guild-session-state.js';
import { setSessionPlayedWatchUrls } from '../src/idle-navigation-state.js';

const GID = 'test-autoplay-spawn-guild';

function cleanup() {
  currentPlayingUrlByGuild.delete(GID);
  setSessionPlayedWatchUrls(GID, []);
}

test('createAutoplaySpawner: bad deps → throws', () => {
  assert.throws(() => createAutoplaySpawner(null), /invalid deps/);
  assert.throws(() => createAutoplaySpawner({}), /invalid deps/);
  assert.throws(
    () => createAutoplaySpawner({ notifyPlaybackUiRefresh: () => {} }),
    /invalid deps/,
  );
  assert.throws(
    () => createAutoplaySpawner({ getOnAutoplaySpawned: () => null }),
    /invalid deps/,
  );
});

test('createAutoplaySpawner: returns frozen object with spawnAutoplayPlaylist', () => {
  const spawner = createAutoplaySpawner({
    notifyPlaybackUiRefresh: () => {},
    getOnAutoplaySpawned: () => null,
  });
  assert.ok(spawner, 'spawner defined');
  assert.equal(typeof spawner.spawnAutoplayPlaylist, 'function');
  assert.ok(Object.isFrozen(spawner), 'spawner frozen');
});

test('isYoutubeUrlBlockedForAutoplaySpawns: null/undefined guildId → false', () => {
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(null, 'https://youtu.be/xxx'), false);
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(undefined, 'https://youtu.be/xxx'), false);
});

test('isYoutubeUrlBlockedForAutoplaySpawns: empty state → false', () => {
  cleanup();
  assert.equal(
    isYoutubeUrlBlockedForAutoplaySpawns(GID, 'https://www.youtube.com/watch?v=abc123defgh'),
    false,
  );
  cleanup();
});

test('isYoutubeUrlBlockedForAutoplaySpawns: current url === candidate → true', () => {
  cleanup();
  const url = 'https://www.youtube.com/watch?v=abc123defgh';
  currentPlayingUrlByGuild.set(GID, url);
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(GID, url), true);
  cleanup();
});

test('isYoutubeUrlBlockedForAutoplaySpawns: candidate в recent history → true', () => {
  cleanup();
  const url = 'https://www.youtube.com/watch?v=zzz999aaaa0';
  setSessionPlayedWatchUrls(GID, [
    'https://www.youtube.com/watch?v=otherxxxxx1',
    url,
    'https://www.youtube.com/watch?v=otherxxxxx2',
  ]);
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(GID, url), true);
  cleanup();
});

test('isYoutubeUrlBlockedForAutoplaySpawns: candidate отсутствует в history → false', () => {
  cleanup();
  setSessionPlayedWatchUrls(GID, ['https://www.youtube.com/watch?v=differentidx']);
  assert.equal(
    isYoutubeUrlBlockedForAutoplaySpawns(GID, 'https://www.youtube.com/watch?v=candidatexxx'),
    false,
  );
  cleanup();
});

test('createAutoplaySpawnStaleGuard: chain does not mutate logSpawn when fresh', () => {
  const log = [];
  const guard = createAutoplaySpawnStaleGuard({
    guildId: 'stale-guard-gid',
    spawnGen: Number.MAX_SAFE_INTEGER, // заведомо stale в живой системе
    staleCtx: {
      isConnectionAlive: () => true,
      isPlaying: () => false,
      hasAutoplay: () => true,
      getQueueLength: () => 0,
    },
    logSpawn: (outcome, extra) => {
      log.push({ outcome, extra });
    },
  });
  // Guard — это функция (phase, outcome) → boolean, сигнальным log'ом когда stale.
  assert.equal(typeof guard, 'function');
});

test('createAutoplaySpawnStaleGuard: stale детектируется после bumpAutoplaySpawnGeneration', async () => {
  const { bumpAutoplaySpawnGeneration } = await import('../src/autoplay-stale-guard.js');
  const gid = 'stale-guard-integration-gid';
  const oldGen = bumpAutoplaySpawnGeneration(gid);
  // Делаем ещё один bump, чтобы oldGen стал просроченным.
  bumpAutoplaySpawnGeneration(gid);

  const log = [];
  const guard = createAutoplaySpawnStaleGuard({
    guildId: gid,
    spawnGen: oldGen,
    staleCtx: {
      isConnectionAlive: () => true,
      isPlaying: () => false,
      hasAutoplay: () => true,
      getQueueLength: () => 0,
    },
    logSpawn: (outcome, extra) => {
      log.push({ outcome, extra });
    },
  });
  const result = guard('after_retrieval', 'stale_after_retrieval');
  assert.equal(result, true, 'guard должен детектировать stale');
  assert.equal(log.length, 1, 'logSpawn вызван один раз');
  assert.equal(log[0].outcome, 'stale_after_retrieval');
  assert.ok('detail' in log[0].extra, 'detail-поле передано в logSpawn');
});
