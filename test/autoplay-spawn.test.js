/**
 * Unit tests for src/autoplay-spawn.js.
 *
 * The full spawner path talks to real network-backed services, so these tests
 * stay focused on the narrow exported seams we intentionally keep pure:
 *   1) spawner factory shape and dep validation
 *   2) recent-url guard behavior
 *   3) stale guard shape and stale detection contract
 *   4) escape retrieval preparation attaching the real engine spawn id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoplaySpawnEscapeTelemetry,
  buildAutoplayRetrievalPositiveContext,
  createAutoplaySpawnStaleGuard,
  createAutoplaySpawner,
  isYoutubeUrlBlockedForAutoplaySpawns,
  pickAutoplayPrefetchCandidateRespectingArtistQuarantine,
  prepareAutoplayRetrievalModeForSpawn,
  shouldBypassAutoplayPrefetchFastPath,
} from '../src/autoplay-spawn.js';
import { currentPlayingUrlByGuild } from '../src/guild-session-state.js';
import { setSessionPlayedWatchUrls } from '../src/idle-navigation-state.js';
import {
  clearAutoplayEscapeState,
  confirmAutoplayEscapeBranch,
  getAutoplayEscapeSnapshot,
  startAutoplayEscapeTrial,
} from '../src/autoplay-escape-state.js';

const GID = 'test-autoplay-spawn-guild';

function cleanup() {
  currentPlayingUrlByGuild.delete(GID);
  setSessionPlayedWatchUrls(GID, []);
}

test('createAutoplaySpawner: bad deps -> throws', () => {
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

test('isYoutubeUrlBlockedForAutoplaySpawns: null/undefined guildId -> false', () => {
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(null, 'https://youtu.be/xxx'), false);
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(undefined, 'https://youtu.be/xxx'), false);
});

test('isYoutubeUrlBlockedForAutoplaySpawns: empty state -> false', () => {
  cleanup();
  assert.equal(
    isYoutubeUrlBlockedForAutoplaySpawns(GID, 'https://www.youtube.com/watch?v=abc123defgh'),
    false,
  );
  cleanup();
});

test('isYoutubeUrlBlockedForAutoplaySpawns: current url === candidate -> true', () => {
  cleanup();
  const url = 'https://www.youtube.com/watch?v=abc123defgh';
  currentPlayingUrlByGuild.set(GID, url);
  assert.equal(isYoutubeUrlBlockedForAutoplaySpawns(GID, url), true);
  cleanup();
});

test('isYoutubeUrlBlockedForAutoplaySpawns: candidate in recent history -> true', () => {
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

test('isYoutubeUrlBlockedForAutoplaySpawns: candidate absent from history -> false', () => {
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
    spawnGen: Number.MAX_SAFE_INTEGER,
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
  assert.equal(typeof guard, 'function');
});

test('createAutoplaySpawnStaleGuard: stale is detected after bumpAutoplaySpawnGeneration', async () => {
  const { bumpAutoplaySpawnGeneration } = await import('../src/autoplay-stale-guard.js');
  const gid = 'stale-guard-integration-gid';
  const oldGen = bumpAutoplaySpawnGeneration(gid);
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
  assert.equal(result, true, 'guard should detect stale generations');
  assert.equal(log.length, 1, 'logSpawn called exactly once');
  assert.equal(log[0].outcome, 'stale_after_retrieval');
  assert.ok('detail' in log[0].extra, 'detail is forwarded into logSpawn');
});

test('prepareAutoplayRetrievalModeForSpawn attaches the real engine spawn id to the active escape branch', () => {
  const gid = 'test-autoplay-spawn-escape-gid';
  const prevEnabled = process.env.AUTOPLAY_ESCAPE_ENABLED;
  process.env.AUTOPLAY_ESCAPE_ENABLED = '1';
  clearAutoplayEscapeState(gid);

  try {
    startAutoplayEscapeTrial(gid, {
      reason: 'basin_trigger',
      contrastHint: { from: 'same_spawn', anchor: 'spawn:session:1' },
    });

    const before = getAutoplayEscapeSnapshot(gid);
    assert.equal(before.currentSpawnId, null);

    const retrievalMode = prepareAutoplayRetrievalModeForSpawn({
      guildId: gid,
      spawnId: 'spawn:session:99',
      escapeSnapshot: before,
      seedQuery: 'Perturbator',
      effectiveSeed: 'Primary focus (STRONG): Perturbator',
      pivotToAnchor: true,
      lastIntent: 'Perturbator',
      initialSeed: 'Darksynth',
      topic: 'Cyberpunk',
      identityIntent: 'Synthwave',
      currentPlayingLabel: 'Perturbator - Venger',
    });

    const after = getAutoplayEscapeSnapshot(gid);
    assert.equal(after.currentSpawnId, 'spawn:session:99');
    assert.equal(retrievalMode.mode, 'escape');
    assert.match(retrievalMode.effectiveSeed, /Escape mode:/);
  } finally {
    clearAutoplayEscapeState(gid);
    if (prevEnabled == null) delete process.env.AUTOPLAY_ESCAPE_ENABLED;
    else process.env.AUTOPLAY_ESCAPE_ENABLED = prevEnabled;
  }
});

test('prepareAutoplayRetrievalModeForSpawn leaves confirmed branches untouched and returns normal mode', () => {
  const gid = 'test-autoplay-spawn-confirmed-gid';
  const prevEnabled = process.env.AUTOPLAY_ESCAPE_ENABLED;
  process.env.AUTOPLAY_ESCAPE_ENABLED = '1';
  clearAutoplayEscapeState(gid);

  try {
    startAutoplayEscapeTrial(gid, {
      currentSpawnId: 'spawn:session:confirmed',
      contrastHint: { from: 'same_family', anchor: 'darksynth' },
    });
    confirmAutoplayEscapeBranch(gid, { reason: 'test_confirmed' });

    const before = getAutoplayEscapeSnapshot(gid);
    assert.equal(before.phase, 'confirmed');

    const retrievalMode = prepareAutoplayRetrievalModeForSpawn({
      guildId: gid,
      spawnId: 'spawn:session:new',
      escapeSnapshot: before,
      seedQuery: 'Perturbator',
      effectiveSeed: 'Primary focus (STRONG): Perturbator',
      pivotToAnchor: true,
      lastIntent: 'Perturbator',
      initialSeed: 'Darksynth',
      topic: 'Cyberpunk',
      identityIntent: 'Synthwave',
      currentPlayingLabel: 'Perturbator - Venger',
    });

    const after = getAutoplayEscapeSnapshot(gid);
    assert.equal(after.currentSpawnId, 'spawn:session:confirmed');
    assert.equal(retrievalMode.mode, 'normal');
  } finally {
    clearAutoplayEscapeState(gid);
    if (prevEnabled == null) delete process.env.AUTOPLAY_ESCAPE_ENABLED;
    else process.env.AUTOPLAY_ESCAPE_ENABLED = prevEnabled;
  }
});

test('buildAutoplayRetrievalPositiveContext appends confirmed anchors only for confirmed branches', () => {
  const basePositiveCtx = ['Data Kiss', 'Turbo Killer'];

  assert.deepEqual(
    buildAutoplayRetrievalPositiveContext(basePositiveCtx, {
      phase: 'confirmed',
      confirmedAnchors: ['Power Glove - Playback'],
    }),
    ['Data Kiss', 'Turbo Killer', 'Power Glove - Playback'],
  );

  assert.deepEqual(
    buildAutoplayRetrievalPositiveContext(basePositiveCtx, {
      phase: 'confirmed',
      confirmedAnchors: [],
    }),
    basePositiveCtx,
  );

  assert.deepEqual(
    buildAutoplayRetrievalPositiveContext(basePositiveCtx, {
      phase: 'trial',
      confirmedAnchors: ['Should not apply'],
    }),
    basePositiveCtx,
  );
});

test('buildAutoplaySpawnEscapeTelemetry summarizes phase, mode and confirmed anchors for metrics', () => {
  assert.deepEqual(
    buildAutoplaySpawnEscapeTelemetry(
      {
        phase: 'confirmed',
        branchId: 'escape:guild:1',
        confirmedAnchors: ['Power Glove - Playback'],
        cooldownSpawnsRemaining: 2,
      },
      { mode: 'normal' },
    ),
    {
      phase: 'confirmed',
      mode: 'normal',
      branchId: 'escape:guild:1',
      confirmedAnchorsCount: 1,
      dFallbackUsed: false,
      cooldownRemaining: 2,
    },
  );

  assert.deepEqual(
    buildAutoplaySpawnEscapeTelemetry(
      {
        phase: null,
        branchId: null,
        confirmedAnchors: [],
        cooldownSpawnsRemaining: 0,
      },
      { mode: 'd_fallback' },
    ),
    {
      phase: null,
      mode: 'd_fallback',
      branchId: null,
      confirmedAnchorsCount: 0,
      dFallbackUsed: true,
      cooldownRemaining: 0,
    },
  );
});

test('shouldBypassAutoplayPrefetchFastPath bypasses pool hits for trial/provisional but not confirmed', () => {
  assert.equal(
    shouldBypassAutoplayPrefetchFastPath({
      phase: 'trial',
      prefetchMode: 'off',
    }),
    true,
  );
  assert.equal(
    shouldBypassAutoplayPrefetchFastPath({
      phase: 'provisional',
      prefetchMode: 'cheap',
    }),
    true,
  );
  assert.equal(
    shouldBypassAutoplayPrefetchFastPath({
      phase: null,
      prefetchMode: 'normal',
      dFallbackPending: true,
    }),
    true,
  );
  assert.equal(
    shouldBypassAutoplayPrefetchFastPath({
      phase: 'confirmed',
      prefetchMode: 'normal',
    }),
    false,
  );
  assert.equal(
    shouldBypassAutoplayPrefetchFastPath({
      phase: null,
      prefetchMode: 'normal',
    }),
    false,
  );
});

test('pickAutoplayPrefetchCandidateRespectingArtistQuarantine discards quarantined pool hits until a different artist appears', () => {
  const popped = [
    { title: 'Aimer - Brave Shine', url: 'https://example.test/aimer-1' },
    { title: 'Aimer - Ref:rain', url: 'https://example.test/aimer-2' },
    { title: 'ClariS「ケアレス」 Music Video', url: 'https://example.test/claris-1' },
  ];

  const selection = pickAutoplayPrefetchCandidateRespectingArtistQuarantine({
    popCandidate: () => popped.shift() ?? null,
    quarantinedArtists: ['aimer'],
    extractLeadArtistToken: (title) => {
      if (title.startsWith('Aimer')) return 'aimer';
      if (title.startsWith('ClariS')) return 'claris';
      return null;
    },
  });

  assert.equal(selection.rejectedByArtistQuarantine, 2);
  assert.equal(selection.candidate?.title, 'ClariS「ケアレス」 Music Video');
});

test('pickAutoplayPrefetchCandidateRespectingArtistQuarantine keeps unknown-artist pool hits', () => {
  const popped = [
    { title: 'Sony Music Entertainment (Japan) - 【MV】炎 / LiSA', url: 'https://example.test/unknown' },
  ];

  const selection = pickAutoplayPrefetchCandidateRespectingArtistQuarantine({
    popCandidate: () => popped.shift() ?? null,
    quarantinedArtists: ['aimer'],
    extractLeadArtistToken: () => null,
  });

  assert.equal(selection.rejectedByArtistQuarantine, 0);
  assert.equal(selection.candidate?.url, 'https://example.test/unknown');
});
