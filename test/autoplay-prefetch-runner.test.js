import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAutoplayPrefetchRunPlan } from '../src/autoplay-prefetch-runner.js';

test('buildAutoplayPrefetchRunPlan disables the runner during trial/off mode', () => {
  assert.deepEqual(buildAutoplayPrefetchRunPlan('off'), {
    prefetchMode: 'off',
    skipRunner: true,
    runFast: false,
    runFull: false,
  });
});

test('buildAutoplayPrefetchRunPlan keeps only cheap prefetch during provisional mode', () => {
  assert.deepEqual(buildAutoplayPrefetchRunPlan('cheap'), {
    prefetchMode: 'cheap',
    skipRunner: false,
    runFast: true,
    runFull: false,
  });
});

test('buildAutoplayPrefetchRunPlan preserves the old behavior in normal mode', () => {
  assert.deepEqual(buildAutoplayPrefetchRunPlan('normal'), {
    prefetchMode: 'normal',
    skipRunner: false,
    runFast: true,
    runFull: true,
  });
});
