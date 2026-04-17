import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startSession,
  endSession,
  getSessionId,
  currentPlayingLabelByGuild,
  currentPlayingUrlByGuild,
  currentQueueItemByGuild,
} from '../src/guild-session-state.js';

// WP8b: endSession must wipe ALL voice-scoped runtime maps, not just the
// session id. Background: without this, `currentPlayingLabelByGuild` leaked
// past voice-gone and surfaced as stale labels in `getGuildSessionSnapshot`.

test('endSession clears currentPlayingLabelByGuild', () => {
  const gid = `cleanup-label-${Date.now()}`;
  startSession(gid);
  currentPlayingLabelByGuild.set(gid, 'Some Track Title');
  assert.equal(currentPlayingLabelByGuild.get(gid), 'Some Track Title');

  endSession(gid);
  assert.equal(currentPlayingLabelByGuild.has(gid), false);
});

test('endSession clears currentPlayingUrlByGuild', () => {
  const gid = `cleanup-url-${Date.now()}`;
  startSession(gid);
  currentPlayingUrlByGuild.set(gid, 'https://youtu.be/abc123');

  endSession(gid);
  assert.equal(currentPlayingUrlByGuild.has(gid), false);
});

test('endSession clears currentQueueItemByGuild', () => {
  const gid = `cleanup-item-${Date.now()}`;
  startSession(gid);
  currentQueueItemByGuild.set(gid, { url: 'u', title: 't', source: 'single', requestedBy: null });

  endSession(gid);
  assert.equal(currentQueueItemByGuild.has(gid), false);
});

test('endSession clears sessionId (original behavior preserved)', () => {
  const gid = `cleanup-sid-${Date.now()}`;
  startSession(gid);
  assert.notEqual(getSessionId(gid), null);

  endSession(gid);
  assert.equal(getSessionId(gid), null);
});

test('endSession is idempotent — second call on cleaned guild does not throw', () => {
  const gid = `cleanup-idem-${Date.now()}`;
  startSession(gid);
  endSession(gid);
  // Second call on empty state — must be a no-op.
  assert.doesNotThrow(() => endSession(gid));
  assert.equal(currentPlayingLabelByGuild.has(gid), false);
});

test('endSession on a guild that never had a session is a no-op', () => {
  const gid = `cleanup-virgin-${Date.now()}`;
  assert.doesNotThrow(() => endSession(gid));
  assert.equal(getSessionId(gid), null);
});
