import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAutoplayEscapeState,
  getAutoplayEscapePhase,
  isAutoplayEscapeCooldownActive,
  startAutoplayEscapeTrial,
  startAutoplayEscapeCooldown,
} from '../src/autoplay-escape-state.js';
import {
  __replaceSignalBufferForTests,
  clearSignalBuffer,
} from '../src/music-signals.js';
import {
  clearAutoplayEscapeMetrics,
  getAutoplayEscapeMetrics,
} from '../src/autoplay-escape-telemetry.js';
import { maybeTriggerAutoplayEscapeTrialFromQuickSkip } from '../src/autoplay-escape-trigger.js';

const GUILD_ID = 'guild-escape-trigger-test';
const NOW = 1_700_000_000_000;

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
  clearAutoplayEscapeMetrics();
  clearSignalBuffer(GUILD_ID);
}

function quickSkipEvent(overrides = {}) {
  return {
    type: 'track_skipped',
    guildId: GUILD_ID,
    sessionId: 'sess-escape',
    actor: 'user-1',
    requestedBy: 'user-1',
    triggeredBy: 'user',
    spawnId: 'spawn:sess:prior',
    listenersCount: 1,
    url: 'https://youtu.be/prior1111111',
    title: 'Prior quick skip',
    timestamp: NOW - 5_000,
    elapsedMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  resetState();
});

test('feature flag OFF short-circuits before reading basin history', () => {
  __replaceSignalBufferForTests(GUILD_ID, [quickSkipEvent({ spawnId: 'spawn:sess:1' })]);

  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '0' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:1', source: 'autoplay' },
      currentUrl: 'https://youtu.be/current11111',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, false);
    assert.equal(result.skippedByFlag, true);
    assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  });
});

test('cooldown is consumed before basin detection and no trial starts', () => {
  __replaceSignalBufferForTests(GUILD_ID, [quickSkipEvent({ spawnId: 'spawn:sess:2' })]);
  startAutoplayEscapeCooldown(GUILD_ID, 1);

  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:2', source: 'autoplay' },
      currentUrl: 'https://youtu.be/current22222',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, false);
    assert.equal(result.skippedByCooldown, true);
    assert.equal(isAutoplayEscapeCooldownActive(GUILD_ID), false);
    assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
    assert.equal(getAutoplayEscapeMetrics(GUILD_ID)['trigger.skipped_by_cooldown'], 1);
  });
});

test('same spawn quick-skip basin starts a trial branch', () => {
  __replaceSignalBufferForTests(GUILD_ID, [quickSkipEvent({ spawnId: 'spawn:sess:7' })]);

  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:7', source: 'autoplay' },
      currentUrl: 'https://youtu.be/current77777',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, true);
    assert.equal(result.decision?.kind, 'same_spawn');
    assert.equal(result.snapshot?.phase, 'trial');
    assert.equal(result.snapshot?.originSpawnId, 'spawn:sess:7');
    assert.deepEqual(result.snapshot?.contrastHint, { from: 'same_spawn', anchor: 'spawn:sess:7' });
    assert.equal(getAutoplayEscapePhase(GUILD_ID), 'trial');
  });
});

test('active escape branch blocks basin-trigger replacement', () => {
  startAutoplayEscapeTrial(GUILD_ID, {
    currentSpawnId: 'spawn:sess:active',
    contrastHint: { from: 'same_spawn', anchor: 'spawn:sess:active' },
  });
  __replaceSignalBufferForTests(GUILD_ID, [quickSkipEvent({ spawnId: 'spawn:sess:active' })]);

  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:active', source: 'autoplay' },
      currentUrl: 'https://youtu.be/currentactive1',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, false);
    assert.equal(result.skippedByActiveBranch, true);
    assert.equal(getAutoplayEscapePhase(GUILD_ID), 'trial');
  });
});

test('non-basin quick-skip leaves escape state untouched', () => {
  __replaceSignalBufferForTests(GUILD_ID, [quickSkipEvent({
    spawnId: 'spawn:sess:other',
    queryFamily: 'ambient',
  })]);

  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:new', source: 'autoplay' },
      currentUrl: 'https://youtu.be/current99999',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, false);
    assert.equal(result.decision?.kind, null);
    assert.equal(result.decision?.evidence.reason, 'no_match');
    assert.equal(getAutoplayEscapePhase(GUILD_ID), null);
  });
});

test('one fresh quick-skip is insufficient evidence, not outside-window', () => {
  withEnv({ AUTOPLAY_ESCAPE_ENABLED: '1' }, () => {
    const result = maybeTriggerAutoplayEscapeTrialFromQuickSkip({
      guildId: GUILD_ID,
      sessionId: 'sess-escape',
      currentItem: { spawnId: 'spawn:sess:solo', source: 'autoplay' },
      currentUrl: 'https://youtu.be/currentsolo1',
      currentTitle: 'Current quick skip',
      nowMs: NOW,
    });

    assert.equal(result.triggered, false);
    assert.equal(result.decision?.evidence.reason, 'insufficient_events');
  });
});
