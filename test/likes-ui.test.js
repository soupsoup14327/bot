import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLikesReply } from '../src/likes-ui.js';

test('buildLikesReply: empty likes produce onboarding hint', () => {
  assert.equal(
    buildLikesReply([], { limit: 10 }),
    'В избранном пока пусто. Нажми ❤ на треке, чтобы сохранить его.',
  );
});

test('buildLikesReply: formats numbered likes with artist and url', () => {
  const content = buildLikesReply([
    {
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    {
      title: 'Numb',
      artist: 'Linkin Park',
      sourceUrl: 'https://www.youtube.com/watch?v=3JZ4pnNtyxQ',
    },
  ], { limit: 10 });

  assert.equal(content.includes('**Твоё избранное:**'), true);
  assert.equal(content.includes('1. Never Gonna Give You Up — Rick Astley'), true);
  assert.equal(content.includes('<https://www.youtube.com/watch?v=dQw4w9WgXcQ>'), true);
  assert.equal(content.includes('2. Numb — Linkin Park'), true);
});

test('buildLikesReply: truncates oversized reply with remaining counter', () => {
  const likes = Array.from({ length: 20 }, (_, index) => ({
    title: `Очень длинное название трека номер ${index + 1} `.repeat(12),
    artist: `Исполнитель ${index + 1}`,
    sourceUrl: `https://example.com/tracks/${index + 1}`,
  }));

  const content = buildLikesReply(likes, { limit: 20 });

  assert.equal(content.length <= 1900, true);
  assert.equal(content.includes('…и ещё '), true);
});
