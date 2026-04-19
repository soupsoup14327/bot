import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAutoplayEscapeState,
  getAutoplayEscapePhase,
  getAutoplayEscapeSnapshot,
  isAutoplayEscapeCooldownActive,
  isAutoplayEscapeDFallbackPending,
  markAutoplayEscapeTrackStarted,
  startAutoplayEscapeTrial,
} from '../src/autoplay-escape-state.js';
import { maybeApplyAutoplayEscapeQuickSkipTransitions } from '../src/autoplay-escape-lifecycle.js';

const GUILD_ID = 'guild-escape-lifecycle-test';
const NOW = 1_700_000_000_000;

beforeEach(() => {
  clearAutoplayEscapeState();
});

test('quick-skip before T kills the active trial and marks D-fallback intent', () => {
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:trial' });
  markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:trial');

  const snapshot = getAutoplayEscapeSnapshot(GUILD_ID);
  const result = maybeApplyAutoplayEscapeQuickSkipTransitions({
    guildId: GUILD_ID,
    currentItem: { spawnId: 'spawn:sess:trial', source: 'autoplay' },
    currentTitle: 'Trial track',
    elapsedMs: 4_000,
    nowMs: (snapshot.phaseStartedAt ?? NOW) + 4_000,
  });

  assert.equal(result.handled, true);
  assert.equal(result.transition, 'killed_before_t');
  assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), true);
  assert.equal(isAutoplayEscapeDFallbackPending(GUILD_ID), true);
});

test('quick-skip after T kills the active trial without D-fallback intent', () => {
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:trial' });
  markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:trial');

  const snapshot = getAutoplayEscapeSnapshot(GUILD_ID);
  const nowMs = (snapshot.phaseStartedAt ?? NOW) + snapshot.trialThresholdMs + 1_000;
  const result = maybeApplyAutoplayEscapeQuickSkipTransitions({
    guildId: GUILD_ID,
    currentItem: { spawnId: 'spawn:sess:trial', source: 'autoplay' },
    currentTitle: 'Trial track',
    elapsedMs: snapshot.trialThresholdMs + 1_000,
    nowMs,
  });

  assert.equal(result.handled, true);
  assert.equal(result.transition, 'killed_after_t');
  assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
  assert.equal(isAutoplayEscapeDFallbackPending(GUILD_ID), false);
});

test('quick-skip transitions ignore non-started or mismatched escape tracks', () => {
  startAutoplayEscapeTrial(GUILD_ID, { currentSpawnId: 'spawn:sess:trial' });

  const notStarted = maybeApplyAutoplayEscapeQuickSkipTransitions({
    guildId: GUILD_ID,
    currentItem: { spawnId: 'spawn:sess:trial', source: 'autoplay' },
    currentTitle: 'Trial track',
    elapsedMs: 1_000,
    nowMs: NOW,
  });
  assert.equal(notStarted.handled, false);
  assert.equal(notStarted.reason, 'track_not_started');
  assert.equal(getAutoplayEscapePhase(GUILD_ID), 'trial');

  markAutoplayEscapeTrackStarted(GUILD_ID, 'spawn:sess:trial');
  const mismatch = maybeApplyAutoplayEscapeQuickSkipTransitions({
    guildId: GUILD_ID,
    currentItem: { spawnId: 'spawn:sess:other', source: 'autoplay' },
    currentTitle: 'Other track',
    elapsedMs: 1_000,
    nowMs: NOW,
  });
  assert.equal(mismatch.handled, false);
  assert.equal(mismatch.reason, 'spawn_mismatch');
  assert.equal(getAutoplayEscapePhase(GUILD_ID), 'trial');
});
