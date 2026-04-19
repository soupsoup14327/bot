import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachAutoplayEscapeSpawnId,
  clearAutoplayEscapeState,
  consumeAutoplayEscapeDFallbackPending,
  confirmAutoplayEscapeBranch,
  consumeAutoplayEscapeCooldownSpawn,
  getAutoplayEscapeCooldownSpawns,
  getAutoplayEscapeDepthCap,
  getAutoplayEscapePhase,
  getAutoplayEscapePrefetchMode,
  getAutoplayEscapeSnapshot,
  getAutoplayEscapeTrialThresholdMs,
  isAutoplayEscapeCooldownActive,
  isAutoplayEscapeDFallbackPending,
  isAutoplayEscapeEnabled,
  killAutoplayEscapeBranch,
  markAutoplayEscapeDFallbackPending,
  markAutoplayEscapeTrackStarted,
  promoteAutoplayEscapeToProvisional,
  shouldAutoplayEscapePrefetch,
  startAutoplayEscapeCooldown,
  startAutoplayEscapeTrial,
} from '../src/autoplay-escape-state.js';

const GUILD_ID = 'guild-escape-test';

function withEnv(patch, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resetState() {
  clearAutoplayEscapeState();
}

test('escape snapshot is empty by default', () => {
  resetState();
  const snapshot = getAutoplayEscapeSnapshot(GUILD_ID);
  assert.equal(snapshot.phase, null);
  assert.equal(snapshot.branchId, null);
  assert.equal(snapshot.depth, 0);
  assert.equal(snapshot.prefetchMode, 'normal');
  assert.equal(snapshot.cooldownSpawnsRemaining, 0);
  assert.equal(snapshot.dFallbackPending, false);
  assert.deepEqual(snapshot.confirmedAnchors, []);
  assert.equal(shouldAutoplayEscapePrefetch(GUILD_ID), true);
});

test('feature flag defaults OFF and enables with env=1', () => {
  resetState();
  withEnv({ AUTOPLAY_ESCAPE_ENABLED: null }, () => {
    assert.equal(isAutoplayEscapeEnabled(), false);
  });
  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    assert.equal(isAutoplayEscapeEnabled(), true);
  });
});

test('trial threshold derives from quick-skip with a 30s cap and override wins', () => {
  resetState();
  withEnv({ AUTOPLAY_ESCAPE_T_MS: null, MUSIC_QUICK_SKIP_MS: '5000' }, () => {
    assert.equal(getAutoplayEscapeTrialThresholdMs(), 12_500);
  });
  withEnv({ AUTOPLAY_ESCAPE_T_MS: null, MUSIC_QUICK_SKIP_MS: '30000' }, () => {
    assert.equal(getAutoplayEscapeTrialThresholdMs(), 30_000);
  });
  withEnv({ AUTOPLAY_ESCAPE_T_MS: '18000', MUSIC_QUICK_SKIP_MS: '5000' }, () => {
    assert.equal(getAutoplayEscapeTrialThresholdMs(), 18_000);
  });
});

test('starting a trial creates a branch with trial phase and disables prefetch', () => {
  resetState();
  const snapshot = startAutoplayEscapeTrial(GUILD_ID, {
    originSpawnId: 'spawn:sess:1',
    currentSpawnId: 'spawn:sess:1',
    contrastHint: { from: 'same_spawn', anchor: 'spawn:sess:1' },
    basinKind: 'spawn_id',
  });

  assert.equal(snapshot.phase, 'trial');
  assert.equal(snapshot.depth, 1);
  assert.equal(snapshot.originSpawnId, 'spawn:sess:1');
  assert.equal(snapshot.currentSpawnId, 'spawn:sess:1');
  assert.deepEqual(snapshot.contrastHint, { from: 'same_spawn', anchor: 'spawn:sess:1' });
  assert.equal(snapshot.phaseStartedAt, null);
  assert.equal(snapshot.prefetchMode, 'off');
  assert.equal(shouldAutoplayEscapePrefetch(GUILD_ID), false);
  assert.equal(getAutoplayEscapePhase(GUILD_ID), 'trial');
});

test('trial promotes to provisional and cheap prefetch only', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:2' });
  const snapshot = promoteAutoplayEscapeToProvisional(GUILD_ID, { dwellMs: 15_000 });

  assert.equal(snapshot.phase, 'provisional');
  assert.equal(snapshot.depth, 1);
  assert.equal(snapshot.prefetchMode, 'cheap');
  assert.equal(getAutoplayEscapePrefetchMode(GUILD_ID), 'cheap');
  assert.equal(shouldAutoplayEscapePrefetch(GUILD_ID), true);
});

test('provisional can spawn exactly one child trial in the same branch', () => {
  resetState();
  const root = startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:root',
    contrastHint: { from: 'same_family', anchor: 'darksynth' },
  });
  promoteAutoplayEscapeToProvisional(GUILD_ID, { dwellMs: 13_000 });

  const child = startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:child',
    contrastHint: { from: 'same_family', anchor: 'ebm' },
  });

  assert.equal(child.phase, 'trial');
  assert.equal(child.depth, 2);
  assert.equal(child.branchId, root.branchId);
  assert.equal(child.originSpawnId, root.originSpawnId);
  assert.equal(child.currentSpawnId, 'spawn:sess:child');
  assert.deepEqual(child.contrastHint, { from: 'same_family', anchor: 'ebm' });
});

test('depth cap is 2 and a third chance in the same branch throws', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:root' });
  promoteAutoplayEscapeToProvisional(GUILD_ID);
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:child' });
  promoteAutoplayEscapeToProvisional(GUILD_ID);

  assert.equal(getAutoplayEscapeDepthCap(), 2);
  assert.throws(
    () => startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:third' }),
    /depth cap reached/,
  );
});

test('starting a trial while trial is already active throws', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:active' });
  assert.throws(
    () => startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:again' }),
    /cannot start child trial from phase=trial/,
  );
});

test('child trial inherits parent contrast hint when override is omitted', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:root',
    contrastHint: { from: 'same_family', anchor: 'darksynth' },
  });
  promoteAutoplayEscapeToProvisional(GUILD_ID);
  const child = startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:child' });
  assert.deepEqual(child.contrastHint, { from: 'same_family', anchor: 'darksynth' });
});

test('confirmed keeps the branch visible for secondary-context harvesting', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:confirm',
    contrastHint: { from: 'same_family', anchor: 'confirmed' },
  });
  const snapshot = confirmAutoplayEscapeBranch(GUILD_ID, {
    finishReason: 'track_finished',
    title: 'Power Glove - Playback',
  });

  assert.equal(snapshot.phase, 'confirmed');
  assert.equal(snapshot.prefetchMode, 'normal');
  assert.equal(snapshot.meta.finishReason, 'track_finished');
  assert.deepEqual(snapshot.confirmedAnchors, ['Power Glove - Playback']);
});

test('provisional branch can also be confirmed on natural finish', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:confirm-provisional',
    contrastHint: { from: 'same_family', anchor: 'confirmed-provisional' },
  });
  promoteAutoplayEscapeToProvisional(GUILD_ID, { dwellMs: 15_000 });

  const snapshot = confirmAutoplayEscapeBranch(GUILD_ID, {
    finishReason: 'track_finished',
    title: 'Perturbator - Venger',
  });

  assert.equal(snapshot.phase, 'confirmed');
  assert.equal(snapshot.currentSpawnId, 'spawn:sess:confirm-provisional');
  assert.equal(snapshot.meta.finishReason, 'track_finished');
  assert.deepEqual(snapshot.confirmedAnchors, ['Perturbator - Venger']);
});

test('confirmed without a title keeps explicit confirmedAnchors empty', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:confirm-empty',
    contrastHint: { from: 'same_family', anchor: 'confirmed-empty' },
  });

  const snapshot = confirmAutoplayEscapeBranch(GUILD_ID, {
    finishReason: 'track_finished',
  });

  assert.equal(snapshot.phase, 'confirmed');
  assert.deepEqual(snapshot.confirmedAnchors, []);
});

test('attachAutoplayEscapeSpawnId requires an active branch and updates currentSpawnId', () => {
  resetState();
  assert.throws(
    () => attachAutoplayEscapeSpawnId(GUILD_ID, 'spawn:sess:none'),
    /cannot attach spawn id from phase=none/,
  );

  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:old' });
  const snapshot = attachAutoplayEscapeSpawnId(GUILD_ID, 'spawn:sess:new');
  assert.equal(snapshot.currentSpawnId, 'spawn:sess:new');
});

test('markAutoplayEscapeTrackStarted rebases phaseStartedAt on the real playback start', () => {
  resetState();
  const trial = startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:real' });
  assert.equal(trial.phaseStartedAt, null);

  const snapshot = markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:real', {
    reason: 'playback_track_started',
  });
  assert.equal(snapshot.phase, 'trial');
  assert.equal(snapshot.currentSpawnId, 'spawn:sess:real');
  assert.equal(typeof snapshot.phaseStartedAt, 'number');
  assert.ok(snapshot.phaseStartedAt >= snapshot.startedAt);
});

test('markAutoplayEscapeTrackStarted is strict about active trial phase and spawn id match', () => {
  resetState();
  assert.throws(
    () => markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:none'),
    /cannot mark track started from phase=none/,
  );

  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:expected' });
  assert.throws(
    () => markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:other'),
    /cannot mark track started for spawn=spawn:sess:other/,
  );
});

test('kill is idempotent and may start cooldown in spawn units', () => {
  resetState();
  const first = killAutoplayEscapeBranch(GUILD_ID, 'user_enqueue', {
    startCooldown: true,
    cooldownSpawns: 3,
  });

  assert.equal(first.phase, null);
  assert.equal(first.cooldownSpawnsRemaining, 3);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), true);

  const second = killAutoplayEscapeBranch(GUILD_ID, 'user_enqueue');
  assert.equal(second.phase, null);
  assert.equal(second.cooldownSpawnsRemaining, 3);
});

test('cooldown decrements in spawns and expires at zero', () => {
  resetState();
  assert.equal(getAutoplayEscapeCooldownSpawns(), 2);
  startAutoplayEscapeCooldown(GUILD_ID, 2);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), true);
  assert.equal(consumeAutoplayEscapeCooldownSpawn(GUILD_ID), 1);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), true);
  assert.equal(consumeAutoplayEscapeCooldownSpawn(GUILD_ID), 0);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
});

test('D-fallback pending is single-shot and visible in snapshot', () => {
  resetState();
  assert.equal(isAutoplayEscapeDFallbackPending(GUILD_ID), false);

  markAutoplayEscapeDFallbackPending(GUILD_ID, { reason: 'trial_quick_skip_before_t' });
  const snapshot = getAutoplayEscapeSnapshot(GUILD_ID);
  assert.equal(snapshot.dFallbackPending, true);
  assert.equal(isAutoplayEscapeDFallbackPending(GUILD_ID), true);

  assert.equal(consumeAutoplayEscapeDFallbackPending(GUILD_ID), true);
  assert.equal(consumeAutoplayEscapeDFallbackPending(GUILD_ID), false);
  assert.equal(getAutoplayEscapeSnapshot(GUILD_ID).dFallbackPending, false);
});

test('clearAutoplayEscapeState resets a single guild and the global store', () => {
  resetState();
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:clear' });
  startAutoplayEscapeCooldown(GUILD_ID, 2);
  startAutoplayEscapeTrial('guild-other', { currentSpawnId: 'spawn:other:1' });

  clearAutoplayEscapeState(GUILD_ID);
  assert.equal(getAutoplayEscapeSnapshot(GUILD_ID).phase, null);
  assert.equal(getAutoplayEscapeSnapshot('guild-other').phase, 'trial');

  clearAutoplayEscapeState();
  assert.equal(getAutoplayEscapeSnapshot('guild-other').phase, null);
});
