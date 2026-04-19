import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDistinctArtistShortlist,
  selectDistinctByArtist,
} from '../src/autoplay-distinct-artists.js';
import { extractLeadArtistTokenFromTitle } from '../src/autoplay-artist-tokens.js';

function candidate(title, channelName = null) {
  return {
    title,
    url: `https://example.test/${encodeURIComponent(title)}`,
    ...(channelName ? { channel: { name: channelName } } : {}),
  };
}

test('selectDistinctByArtist keeps stable first-wins order for known artists', () => {
  const items = [
    candidate('Aimer - Brave Shine'),
    candidate('Aimer - Ref:rain'),
    candidate('ClariS「ケアレス」 Music Video'),
    candidate('ClariS - ALIVE'),
  ];

  const shortlist = selectDistinctByArtist(items, {
    extractArtist: (item) => extractLeadArtistTokenFromTitle(item.title),
    maxPerArtist: 1,
  });

  assert.deepEqual(
    shortlist.map((item) => item.title),
    ['Aimer - Brave Shine', 'ClariS「ケアレス」 Music Video'],
  );
});

test('buildDistinctArtistShortlist does not collapse unknown artists into one null bucket', () => {
  const items = [
    candidate('Sony Music Entertainment (Japan) - 【MV】炎 / LiSA'),
    candidate('Various Artists Official Audio'),
    candidate('Aimer - Brave Shine'),
  ];

  const shortlist = buildDistinctArtistShortlist(items, {
    enabled: true,
    extractLeadArtistToken: extractLeadArtistTokenFromTitle,
    minCandidates: 3,
    fallbackMaxPerArtist: 2,
  });

  assert.deepEqual(
    shortlist.items.map((item) => item.title),
    items.map((item) => item.title),
  );
  assert.equal(shortlist.meta.strategy, 'distinct_1');
});

test('buildDistinctArtistShortlist relaxes to two-per-artist when one-per-artist is too small', () => {
  const items = [
    candidate('Aimer - Brave Shine'),
    candidate('Aimer - Ref:rain'),
    candidate('ClariS「ケアレス」 Music Video'),
  ];

  const shortlist = buildDistinctArtistShortlist(items, {
    enabled: true,
    extractLeadArtistToken: extractLeadArtistTokenFromTitle,
    minCandidates: 4,
    fallbackMaxPerArtist: 2,
  });

  assert.deepEqual(
    shortlist.items.map((item) => item.title),
    ['Aimer - Brave Shine', 'Aimer - Ref:rain', 'ClariS「ケアレス」 Music Video'],
  );
  assert.equal(shortlist.meta.strategy, 'distinct_relaxed');
});

test('buildDistinctArtistShortlist uses topic metadata fallback for ambiguous titles', () => {
  const items = [
    candidate('adrenaline!!! / THE FIRST TAKE', 'TrySail - Topic'),
    candidate('TrySail [華麗ワンターン] Music Video'),
    candidate('ClariS「ケアレス」 Music Video'),
  ];

  const shortlist = buildDistinctArtistShortlist(items, {
    enabled: true,
    extractLeadArtistToken: extractLeadArtistTokenFromTitle,
    minCandidates: 2,
    fallbackMaxPerArtist: 2,
  });

  assert.deepEqual(
    shortlist.items.map((item) => item.title),
    ['adrenaline!!! / THE FIRST TAKE', 'ClariS「ケアレス」 Music Video'],
  );
});
