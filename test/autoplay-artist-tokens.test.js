import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDominantArtist,
  extractLeadArtistToken,
  extractLeadArtistTokenFromTitle,
} from '../src/autoplay-artist-tokens.js';

const TABLE = [
  {
    title: 'Unlike Pluto - Insanium',
    expected: 'unlike pluto',
  },
  {
    title: 'LISA - ROCKSTAR (Official Music Video)',
    expected: 'lisa',
  },
  {
    title: 'Kalafina - Heavenly Blue Music Video',
    expected: 'kalafina',
  },
  {
    title: 'ClariS「ケアレス」 Music Video',
    expected: 'claris',
  },
  {
    title: 'TrySail [華麗ワンターン] Music Video',
    expected: 'trysail',
  },
  {
    title: 'Aimer「カタオモイ」 MUSIC VIDEO (FULL ver.)',
    expected: 'aimer',
  },
  {
    title: 'LISA - BORN AGAIN feat. Doja Cat & RAYE',
    expected: 'lisa',
  },
  {
    title: 'MindaRyn × ASCA - Way to go',
    expected: 'mindaryn',
  },
  {
    title: 'Sony Music Entertainment (Japan) - 【MV】炎 / LiSA',
    expected: null,
  },
];

test('extractLeadArtistTokenFromTitle handles western and JP/anison title formats', () => {
  for (const row of TABLE) {
    assert.equal(
      extractLeadArtistTokenFromTitle(row.title),
      row.expected,
      row.title,
    );
  }
});

test('extractLeadArtistToken falls back to topic channel metadata when the title is ambiguous', () => {
  assert.equal(
    extractLeadArtistToken({
      title: 'adrenaline!!! / THE FIRST TAKE',
      channelName: 'TrySail - Topic',
    }),
    'trysail',
  );
});

test('extractLeadArtistTokenFromTitle returns null for empty or obviously non-artist titles', () => {
  assert.equal(extractLeadArtistTokenFromTitle(''), null);
  assert.equal(extractLeadArtistTokenFromTitle('【MV】Official Music Video'), null);
});

test('detectDominantArtist works with repeated JP-style titles', () => {
  assert.deepEqual(
    detectDominantArtist([
      'ClariS「ケアレス」 Music Video',
      'Kalafina - Heavenly Blue Music Video',
      'ClariS - ALIVE / Lycoris Recoil (Dolby Atmos sound)',
      'TrySail [華麗ワンターン] Music Video',
      'ClariS「ケアレス」 Music Video',
    ]),
    { artist: 'claris', count: 3 },
  );
});
