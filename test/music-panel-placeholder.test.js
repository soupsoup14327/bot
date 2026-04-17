/**
 * Unit tests for music-panel.js placeholder-replace flow (WP4-B).
 *
 * The invariants under test:
 *   I1: tag.id is unique — duplicate placeholderText produces distinct tags.
 *   I2: FIFO pop + tag-id lookup replaces THE CORRECT entry even when text
 *       is identical across multiple registrations.
 *   I3: If an entry is missing (MAX_QUEUE_LINES eviction simulation), the
 *       replace is a clean no-op, the pending id is still consumed.
 *   I4: If session is missing (teardown), nothing throws, no-op.
 *   I5: registerPendingSingleLine with unknown placeholderText does not
 *       pollute the pending FIFO.
 *   I6: After replace the text is the formatSingleQueueLine output and
 *       the tag is cleared (no lingering tags).
 *
 * These invariants are why we moved from text-based indexOf lookup to
 * unique numeric tag.id — they eliminate the whole class of "wrong line
 * replaced" bugs that plagued earlier attempts.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __test__, registerPendingSingleLine } from '../src/music-panel.js';

const GUILD = 'g1';

/** Minimal Discord client mock that fails editing silently. */
function mockClient() {
  return {
    channels: {
      async fetch() { return null; },
    },
  };
}

beforeEach(() => {
  __test__.reset();
  __test__.setClient(mockClient());
});

test('I1+I2: duplicate placeholderText — distinct tags, FIFO replaces in order', async () => {
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [
      { text: 'raw query', tag: null }, // A
      { text: 'other', tag: null },     // B
      { text: 'raw query', tag: null }, // C (duplicate text)
    ],
  });

  registerPendingSingleLine(GUILD, 'raw query', 'alice');
  registerPendingSingleLine(GUILD, 'raw query', 'bob');

  const state = __test__.getQueueState(GUILD);
  const tagged = state.lines.filter((e) => e.tag);
  assert.equal(tagged.length, 2, 'exactly two tagged entries');
  assert.notEqual(tagged[0].tag.id, tagged[1].tag.id, 'distinct tag ids');
  assert.equal(state.lines[0].tag?.addedBy, 'alice');
  assert.equal(state.lines[2].tag?.addedBy, 'bob');

  // Pop first tag → must replace entry A (index 0), not C.
  await __test__.triggerReplace(GUILD, 'Alice Real Title');
  const after1 = __test__.getQueueState(GUILD);
  assert.match(after1.lines[0].text, /Alice Real Title/);
  assert.equal(after1.lines[0].tag, null, 'tag cleared after replace');
  assert.equal(after1.lines[2].text, 'raw query', 'C untouched');
  assert.notEqual(after1.lines[2].tag, null, 'C still tagged');

  // Second pop → must replace C.
  await __test__.triggerReplace(GUILD, 'Bob Real Title');
  const after2 = __test__.getQueueState(GUILD);
  assert.match(after2.lines[2].text, /Bob Real Title/);
  assert.equal(after2.lines[2].tag, null);

  assert.equal(__test__.getPendingIds(GUILD).length, 0, 'FIFO drained');
});

test('I3: eviction simulation — entry removed, replace is a no-op, pending consumed', async () => {
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [{ text: 'raw query', tag: null }],
  });
  registerPendingSingleLine(GUILD, 'raw query', 'alice');
  assert.equal(__test__.getPendingIds(GUILD).length, 1);

  // Simulate MAX_QUEUE_LINES eviction: the tagged entry is shifted out.
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [{ text: 'some other autoplay line', tag: null }],
  });

  await __test__.triggerReplace(GUILD, 'Alice Real Title');

  assert.equal(__test__.getPendingIds(GUILD).length, 0, 'pending id popped even on miss');
  const state = __test__.getQueueState(GUILD);
  assert.equal(state.lines[0].text, 'some other autoplay line', 'untouched');
});

test('I4: no session — replace does not throw, no-op', async () => {
  registerPendingSingleLine(GUILD, 'raw query', 'alice');
  // registerPendingSingleLine silently noops (no session), but we also
  // prove triggerReplace on empty state is safe.
  await __test__.triggerReplace(GUILD, 'anything');
  assert.equal(__test__.getPendingIds(GUILD).length, 0);
});

test('I5: registerPendingSingleLine with unknown text does not push to FIFO', () => {
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [{ text: 'actual line', tag: null }],
  });
  registerPendingSingleLine(GUILD, 'missing query', 'alice');
  assert.equal(__test__.getPendingIds(GUILD).length, 0);
});

test('I6: replace output uses formatSingleQueueLine + tag is cleared', async () => {
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [{ text: 'raw query', tag: null }],
  });
  registerPendingSingleLine(GUILD, 'raw query', 'alice');
  await __test__.triggerReplace(GUILD, 'Final Title');

  const state = __test__.getQueueState(GUILD);
  // formatSingleQueueLine should produce non-raw output.
  assert.notEqual(state.lines[0].text, 'raw query');
  assert.match(state.lines[0].text, /Final Title/);
  assert.equal(state.lines[0].tag, null);
});

test('already-tagged entry is not re-tagged by second registerPendingSingleLine with same text', () => {
  __test__.seedQueueState(GUILD, {
    channelId: 'c1',
    messageId: 'm1',
    lines: [{ text: 'raw query', tag: null }],
  });
  registerPendingSingleLine(GUILD, 'raw query', 'alice');
  // Second call: no more untagged matches with this text → pending length stays 1.
  registerPendingSingleLine(GUILD, 'raw query', 'bob');
  assert.equal(__test__.getPendingIds(GUILD).length, 1, 'no false registration');
});
