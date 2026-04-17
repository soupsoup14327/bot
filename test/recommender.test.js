import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNextTracks, isRecommenderAvailable } from '../src/recommender.js';

// Thin tests — we are locking the STUB contract so future implementation
// swaps land on a stable API. Behavior assertions here are intentional
// placeholders; they will need to change when the real implementation
// lands — AT WHICH POINT tests should be rewritten with proper mocks for
// the app API.

test('getNextTracks(stub) returns { tracks: [], source: "stub" }', async () => {
  const r = await getNextTracks('some seed', { guildId: 'g1', count: 5 });
  assert.deepEqual(r.tracks, []);
  assert.equal(r.source, 'stub');
});

test('getNextTracks(stub) is resilient to empty / null seed', async () => {
  const r1 = await getNextTracks('', { guildId: 'g1' });
  assert.deepEqual(r1.tracks, []);
  const r2 = await getNextTracks(/** @type {any} */ (null), { guildId: 'g1' });
  assert.deepEqual(r2.tracks, []);
});

test('getNextTracks(stub) clamps count to [1, 20]', async () => {
  // Stub returns [] anyway — this test locks the contract: no throw on
  // out-of-range count. Future impl must also clamp.
  const r0 = await getNextTracks('seed', { guildId: 'g1', count: 0 });
  assert.equal(r0.source, 'stub');
  const rBig = await getNextTracks('seed', { guildId: 'g1', count: 9999 });
  assert.equal(rBig.source, 'stub');
});

test('isRecommenderAvailable(stub) returns false', () => {
  assert.equal(isRecommenderAvailable(), false);
});
