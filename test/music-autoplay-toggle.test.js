import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnqueueTrackPresentation,
  resolveMusicTransportFlags,
  resolveCurrentTrackArtistForQuarantine,
  shouldKickPlaybackOnEnqueue,
  shouldKickAutoplayOnEnable,
} from '../src/music.js';

test('resolveMusicTransportFlags keeps autoplay toggle enabled while connected but idle', () => {
  const flags = resolveMusicTransportFlags({
    inVoice: true,
    playing: false,
    paused: false,
    loading: false,
    queueLength: 0,
    autoplay: true,
    repeat: false,
    idleBackForwardAvailable: false,
    pastLen: 0,
    sessLen: 0,
    hasRememberedTrack: false,
  });

  assert.equal(flags.hasActiveTrack, false);
  assert.equal(flags.canAutoplayToggle, true);
  assert.equal(flags.canRepeatToggle, false);
  assert.equal(flags.canSkipForward, false);
});

test('resolveMusicTransportFlags still allows retrospective like on exhausted remembered track', () => {
  const flags = resolveMusicTransportFlags({
    inVoice: true,
    playing: false,
    paused: false,
    loading: false,
    queueLength: 0,
    autoplay: true,
    repeat: false,
    idleBackForwardAvailable: false,
    pastLen: 0,
    sessLen: 0,
    hasRememberedTrack: true,
  });

  assert.equal(flags.canLike, true);
  assert.equal(flags.canAutoplayToggle, true);
});

test('shouldKickAutoplayOnEnable only kicks an idle connected session', () => {
  assert.equal(shouldKickAutoplayOnEnable({
    inVoice: true,
    playing: false,
    paused: false,
    loading: false,
  }), true);

  assert.equal(shouldKickAutoplayOnEnable({
    inVoice: false,
    playing: false,
    paused: false,
    loading: false,
  }), false);

  assert.equal(shouldKickAutoplayOnEnable({
    inVoice: true,
    playing: true,
    paused: false,
    loading: false,
  }), false);

  assert.equal(shouldKickAutoplayOnEnable({
    inVoice: true,
    playing: false,
    paused: true,
    loading: false,
  }), false);

  assert.equal(shouldKickAutoplayOnEnable({
    inVoice: true,
    playing: false,
    paused: false,
    loading: true,
  }), false);
});

test('shouldKickPlaybackOnEnqueue never interrupts an active or loading track', () => {
  assert.equal(shouldKickPlaybackOnEnqueue({
    playing: false,
    paused: false,
    loading: false,
  }), true);

  assert.equal(shouldKickPlaybackOnEnqueue({
    playing: true,
    paused: false,
    loading: false,
  }), false);

  assert.equal(shouldKickPlaybackOnEnqueue({
    playing: false,
    paused: true,
    loading: false,
  }), false);

  assert.equal(shouldKickPlaybackOnEnqueue({
    playing: false,
    paused: false,
    loading: true,
  }), false);
});

test('buildEnqueueTrackPresentation prefers canonical title for direct URLs', () => {
  assert.deepEqual(
    buildEnqueueTrackPresentation(
      'https://youtu.be/3fPEt9NRm5E',
      'Акс арт онлайн',
    ),
    {
      trackLabel: 'Акс арт онлайн',
      queueItemTitle: 'Акс арт онлайн',
    },
  );

  assert.deepEqual(
    buildEnqueueTrackPresentation(
      'https://youtu.be/3fPEt9NRm5E',
      'https://youtu.be/3fPEt9NRm5E',
    ),
    {
      trackLabel: 'https://youtu.be/3fPEt9NRm5E',
      queueItemTitle: null,
    },
  );

  assert.deepEqual(
    buildEnqueueTrackPresentation(
      'Iconic GUMI Playlist',
      null,
    ),
    {
      trackLabel: 'Iconic GUMI Playlist',
      queueItemTitle: null,
    },
  );
});

test('resolveCurrentTrackArtistForQuarantine uses queue-item channelName as Topic fallback', () => {
  assert.equal(
    resolveCurrentTrackArtistForQuarantine(
      'adrenaline!!! / THE FIRST TAKE',
      { channelName: 'TrySail - Topic' },
    ),
    'trysail',
  );

  assert.equal(
    resolveCurrentTrackArtistForQuarantine(
      'adrenaline!!! / THE FIRST TAKE',
      { channelName: null },
    ),
    null,
  );
});
