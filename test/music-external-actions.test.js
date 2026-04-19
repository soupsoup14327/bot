import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoplayByGuild,
} from '../src/guild-session-state.js';
import {
  clearAutoplayEscapeState,
  getAutoplayEscapeSnapshot,
  getAutoplayEscapePhase,
  isAutoplayEscapeCooldownActive,
  markAutoplayEscapeDFallbackPending,
  startAutoplayEscapeCooldown,
  startAutoplayEscapeTrial,
} from '../src/autoplay-escape-state.js';
import {
  clearArtistQuarantineState,
  getAutoplayArtistQuarantineSnapshot,
  quarantineArtistForNextSpawns,
} from '../src/autoplay-artist-quarantine.js';
import {
  enqueue,
  stopAndLeave,
  toggleAutoplay,
} from '../src/music.js';

const GUILD_ID = 'guild-music-external-actions-test';

beforeEach(() => {
  clearAutoplayEscapeState();
  clearArtistQuarantineState();
  autoplayByGuild.delete(GUILD_ID);
});

test('toggleAutoplay OFF clears the active escape branch and pending escape state', () => {
  autoplayByGuild.add(GUILD_ID);
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:toggle',
  });
  markAutoplayEscapeDFallbackPending(GUILD_ID, { reason: 'trial_quick_skip_before_t' });
  startAutoplayEscapeCooldown(GUILD_ID, 2);
  quarantineArtistForNextSpawns(GUILD_ID, 'aimer', 2);

  const enabled = toggleAutoplay(GUILD_ID);

  assert.equal(enabled, false);
  assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
  assert.equal(getAutoplayEscapeSnapshot(GUILD_ID).dFallbackPending, false);
  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), []);
});

test('stopAndLeave clears the active escape branch and pending escape state', () => {
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:stop',
  });
  markAutoplayEscapeDFallbackPending(GUILD_ID, { reason: 'trial_quick_skip_before_t' });
  startAutoplayEscapeCooldown(GUILD_ID, 2);
  quarantineArtistForNextSpawns(GUILD_ID, 'aimer', 2);

  stopAndLeave(GUILD_ID);

  assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
  assert.equal(getAutoplayEscapeSnapshot(GUILD_ID).dFallbackPending, false);
  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), []);
});

test('explicit user enqueue clears the active escape branch and pending escape state before voice setup', async () => {
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:enqueue',
  });
  markAutoplayEscapeDFallbackPending(GUILD_ID, { reason: 'trial_quick_skip_before_t' });
  startAutoplayEscapeCooldown(GUILD_ID, 2);
  quarantineArtistForNextSpawns(GUILD_ID, 'aimer', 2);

  const fakeChannel = {
    guild: { id: GUILD_ID },
  };

  await assert.rejects(
    enqueue(fakeChannel, 'Perturbator', 'single', 'user-1', 'User 1'),
  );

  assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
  assert.equal(getAutoplayEscapeSnapshot(GUILD_ID).dFallbackPending, false);
  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), []);
});
