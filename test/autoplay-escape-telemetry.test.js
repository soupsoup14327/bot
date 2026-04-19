import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAutoplayEscapeMetrics,
  getAutoplayEscapeMetrics,
  incrementAutoplayEscapeMetric,
  recordAutoplayEscapeTransitionMetric,
} from '../src/autoplay-escape-telemetry.js';

const GUILD_ID = 'guild-escape-telemetry-test';

beforeEach(() => {
  clearAutoplayEscapeMetrics();
});

test('incrementAutoplayEscapeMetric accumulates per-guild counters', () => {
  assert.equal(incrementAutoplayEscapeMetric(GUILD_ID, 'transition.trial_started'), 1);
  assert.equal(incrementAutoplayEscapeMetric(GUILD_ID, 'transition.trial_started'), 2);
  assert.deepEqual(getAutoplayEscapeMetrics(GUILD_ID), {
    'transition.trial_started': 2,
  });
});

test('recordAutoplayEscapeTransitionMetric tracks both stage and killed reason', () => {
  recordAutoplayEscapeTransitionMetric(GUILD_ID, 'confirmed');
  recordAutoplayEscapeTransitionMetric(GUILD_ID, 'killed', {
    reason: 'trial_quick_skip_before_t',
  });

  assert.deepEqual(getAutoplayEscapeMetrics(GUILD_ID), {
    'transition.confirmed': 1,
    'transition.killed': 1,
    'killed.trial_quick_skip_before_t': 1,
  });
});

test('clearAutoplayEscapeMetrics can reset one guild or all guilds', () => {
  incrementAutoplayEscapeMetric(GUILD_ID, 'transition.trial_started');
  incrementAutoplayEscapeMetric('guild-other', 'transition.confirmed');

  clearAutoplayEscapeMetrics(GUILD_ID);
  assert.deepEqual(getAutoplayEscapeMetrics(GUILD_ID), {});
  assert.deepEqual(getAutoplayEscapeMetrics('guild-other'), {
    'transition.confirmed': 1,
  });

  clearAutoplayEscapeMetrics();
  assert.deepEqual(getAutoplayEscapeMetrics(), {});
});
