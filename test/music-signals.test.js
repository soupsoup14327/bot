import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __replaceSignalBufferForTests,
  clearSignalBuffer,
  emitSignal,
  getRecentSignals,
  getSignalsByType,
} from '../src/music-signals.js';

function uniqueGuildId(suffix) {
  return `signals-spawn-${suffix}-${Date.now()}`;
}

test('emitSignal stores spawnId symmetrically across started/finished/skipped/previous', () => {
  const guildId = uniqueGuildId('symmetry');
  clearSignalBuffer(guildId);

  emitSignal('track_started', {
    guildId,
    sessionId: 'sess-1',
    spawnId: 'spawn:sess:1',
    url: 'https://youtu.be/aaa111',
    title: 'Started track',
  });
  emitSignal('track_finished', {
    guildId,
    sessionId: 'sess-1',
    spawnId: 'spawn:sess:1',
    url: 'https://youtu.be/aaa111',
    title: 'Started track',
  });
  emitSignal('track_skipped', {
    guildId,
    sessionId: 'sess-1',
    spawnId: 'spawn:sess:2',
    actor: 'user-1',
    url: 'https://youtu.be/bbb222',
    title: 'Skipped track',
  });
  emitSignal('track_previous', {
    guildId,
    sessionId: 'sess-1',
    spawnId: 'spawn:sess:3',
    actor: 'user-2',
    url: 'https://youtu.be/ccc333',
    title: 'Previous track',
  });

  assert.equal(getSignalsByType(guildId, 'track_started', 1)[0]?.spawnId, 'spawn:sess:1');
  assert.equal(getSignalsByType(guildId, 'track_finished', 1)[0]?.spawnId, 'spawn:sess:1');
  assert.equal(getSignalsByType(guildId, 'track_skipped', 1)[0]?.spawnId, 'spawn:sess:2');
  assert.equal(getSignalsByType(guildId, 'track_previous', 1)[0]?.spawnId, 'spawn:sess:3');

  clearSignalBuffer(guildId);
});

test('emitSignal without spawnId stores null instead of undefined', () => {
  const guildId = uniqueGuildId('no-spawn');
  clearSignalBuffer(guildId);

  emitSignal('track_started', {
    guildId,
    sessionId: 'sess-plain',
    url: 'https://youtu.be/noSpawn111',
    title: 'Plain user track',
  });

  const recent = getSignalsByType(guildId, 'track_started', 1);
  assert.equal(recent[0]?.spawnId, null);

  clearSignalBuffer(guildId);
});

test('legacy buffered events without spawnId normalize to null', () => {
  const guildId = uniqueGuildId('legacy');
  __replaceSignalBufferForTests(guildId, [
    {
      type: 'track_skipped',
      guildId,
      sessionId: 'sess-old',
      actor: 'user-old',
      requestedBy: null,
      triggeredBy: 'user',
      listenersCount: 2,
      url: 'https://youtu.be/legacy1',
      title: 'Legacy skip',
      timestamp: Date.now() - 1000,
      elapsedMs: 1200,
    },
    {
      type: 'track_started',
      guildId,
      sessionId: 'sess-old',
      actor: null,
      requestedBy: null,
      triggeredBy: 'autoplay',
      spawnId: 'spawn:sess:legacy',
      listenersCount: 2,
      url: 'https://youtu.be/legacy2',
      title: 'Modern start',
      timestamp: Date.now(),
      elapsedMs: null,
    },
  ]);

  const recent = getRecentSignals(guildId, 2);
  assert.equal(recent[0]?.spawnId, 'spawn:sess:legacy');
  assert.equal(recent[1]?.spawnId, null);

  clearSignalBuffer(guildId);
});
