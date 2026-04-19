import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { extractLeadArtistTokenFromTitle } from '../src/autoplay-artist-tokens.js';
import {
  clearArtistQuarantineState,
  consumeAutoplayArtistQuarantineSpawn,
  filterAutoplayCandidatesByArtistQuarantine,
  getAutoplayArtistQuarantineSnapshot,
  isArtistQuarantined,
  quarantineArtistForNextSpawns,
} from '../src/autoplay-artist-quarantine.js';

const GUILD_ID = 'guild-autoplay-artist-quarantine-test';

function candidate(title, channelName = null) {
  return {
    title,
    url: `https://example.test/${encodeURIComponent(title)}`,
    ...(channelName ? { channel: { name: channelName } } : {}),
  };
}

beforeEach(() => {
  clearArtistQuarantineState();
});

test('consumeAutoplayArtistQuarantineSpawn returns the current snapshot and decrements per spawn', () => {
  quarantineArtistForNextSpawns(GUILD_ID, 'aimer', 2);

  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), [
    { artist: 'aimer', remainingSpawns: 2 },
  ]);
  assert.deepEqual(consumeAutoplayArtistQuarantineSpawn(GUILD_ID), ['aimer']);
  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), [
    { artist: 'aimer', remainingSpawns: 1 },
  ]);
  assert.deepEqual(consumeAutoplayArtistQuarantineSpawn(GUILD_ID), ['aimer']);
  assert.deepEqual(getAutoplayArtistQuarantineSnapshot(GUILD_ID), []);
});

test('filterAutoplayCandidatesByArtistQuarantine hard-blocks only matching known artists', () => {
  const filtered = filterAutoplayCandidatesByArtistQuarantine([
    candidate('Aimer - Brave Shine'),
    candidate('Aimer - Ref:rain'),
    candidate('ClariS「ケアレス」 Music Video'),
    candidate('Sony Music Entertainment (Japan) - 【MV】炎 / LiSA'),
  ], {
    quarantinedArtists: ['aimer'],
    extractLeadArtistToken: extractLeadArtistTokenFromTitle,
  });

  assert.deepEqual(
    filtered.items.map((item) => item.title),
    [
      'ClariS「ケアレス」 Music Video',
      'Sony Music Entertainment (Japan) - 【MV】炎 / LiSA',
    ],
  );
  assert.deepEqual(filtered.meta, {
    activeArtists: 1,
    rejected: 2,
  });
});

test('filterAutoplayCandidatesByArtistQuarantine respects topic metadata fallback for ambiguous titles', () => {
  const filtered = filterAutoplayCandidatesByArtistQuarantine([
    candidate('adrenaline!!! / THE FIRST TAKE', 'TrySail - Topic'),
    candidate('TrySail [華麗ワンターン] Music Video'),
    candidate('ClariS「ケアレス」 Music Video'),
  ], {
    quarantinedArtists: ['trysail'],
    extractLeadArtistToken: extractLeadArtistTokenFromTitle,
  });

  assert.deepEqual(
    filtered.items.map((item) => item.title),
    ['ClariS「ケアレス」 Music Video'],
  );
  assert.equal(isArtistQuarantined(['trysail'], 'TrySail'), true);
});
