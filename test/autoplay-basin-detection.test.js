import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAutoplayBasin } from '../src/autoplay-basin-detection.js';

const NOW = 1_700_000_000_000;

function skipEvent(overrides = {}) {
  return {
    timestamp: NOW - 1_000,
    spawnId: null,
    queryFamily: null,
    url: 'https://youtu.be/example',
    title: 'Example track',
    ...overrides,
  };
}

test('detectAutoplayBasin returns same_spawn for the newest two quick-skips in one batch', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    recentQuickSkips: [
      skipEvent({ timestamp: NOW - 2_000, spawnId: 'spawn:sess:7', queryFamily: 'darksynth' }),
      skipEvent({ timestamp: NOW - 6_000, spawnId: 'spawn:sess:7', queryFamily: 'retrowave' }),
      skipEvent({ timestamp: NOW - 9_000, spawnId: 'spawn:sess:3', queryFamily: 'ambient' }),
    ],
  });

  assert.equal(result.basin, true);
  assert.equal(result.kind, 'same_spawn');
  assert.equal(result.evidence.matchedSpawnId, 'spawn:sess:7');
});

test('detectAutoplayBasin falls back to same_family when spawnIds differ', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    recentQuickSkips: [
      skipEvent({ timestamp: NOW - 2_000, spawnId: 'spawn:sess:8', queryFamily: 'darksynth' }),
      skipEvent({ timestamp: NOW - 5_000, spawnId: 'spawn:sess:9', queryFamily: 'DarkSynth' }),
    ],
  });

  assert.equal(result.basin, true);
  assert.equal(result.kind, 'same_family');
  assert.equal(result.evidence.matchedQueryFamily, 'darksynth');
});

test('detectAutoplayBasin uses the configured recency window and ignores stale skips', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    maxWindowMs: 60_000,
    recentQuickSkips: [
      skipEvent({ timestamp: NOW - 30_000, spawnId: 'spawn:sess:11' }),
      skipEvent({ timestamp: NOW - 200_000, spawnId: 'spawn:sess:11' }),
    ],
  });

  assert.equal(result.basin, false);
  assert.equal(result.kind, null);
  assert.equal(result.evidence.reason, 'outside_window');
});

test('detectAutoplayBasin returns no match when the newest pair share neither batch nor family', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    recentQuickSkips: [
      skipEvent({ timestamp: NOW - 2_000, spawnId: 'spawn:sess:15', queryFamily: 'industrial' }),
      skipEvent({ timestamp: NOW - 3_000, spawnId: 'spawn:sess:16', queryFamily: 'ambient' }),
    ],
  });

  assert.equal(result.basin, false);
  assert.equal(result.kind, null);
  assert.equal(result.evidence.reason, 'no_match');
});

test('detectAutoplayBasin treats legacy events without spawnId or family as non-matching', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    recentQuickSkips: [
      skipEvent({ timestamp: NOW - 2_000, spawnId: null, queryFamily: null }),
      skipEvent({ timestamp: NOW - 3_000, spawnId: undefined, queryFamily: undefined }),
    ],
  });

  assert.equal(result.basin, false);
  assert.equal(result.kind, null);
  assert.equal(result.evidence.reason, 'no_match');
});

test('detectAutoplayBasin needs two recent events even if maxSkipsConsidered is larger', () => {
  const result = detectAutoplayBasin({
    nowMs: NOW,
    maxSkipsConsidered: 5,
    recentQuickSkips: [skipEvent({ timestamp: NOW - 2_000, spawnId: 'spawn:sess:solo' })],
  });

  assert.equal(result.basin, false);
  assert.equal(result.kind, null);
  assert.equal(result.evidence.reason, 'insufficient_events');
});
