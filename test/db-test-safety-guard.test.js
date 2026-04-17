import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAFE_TEST_DATABASE_URL_RE,
  assertSafeDatabaseUrl,
  isSafeTestDatabaseUrl,
} from '../src/db/test-safety-guard.js';

test('SAFE_TEST_DATABASE_URL_RE: allows only sqlite memory and ./data/test/*.db', () => {
  assert.match('sqlite::memory:', SAFE_TEST_DATABASE_URL_RE);
  assert.match('sqlite:./data/test/pawpaw.db', SAFE_TEST_DATABASE_URL_RE);
  assert.match('sqlite:./data/test/a-1._z.db', SAFE_TEST_DATABASE_URL_RE);
});

test('isSafeTestDatabaseUrl: rejects operator and production-like urls', () => {
  const blocked = [
    '',
    'sqlite:./data/local.db',
    'sqlite:../data/test/pawpaw.db',
    'sqlite:./data/test/pawpaw.sqlite',
    'postgres://user:pass@localhost:5432/pawpaw',
  ];

  for (const candidate of blocked) {
    assert.equal(isSafeTestDatabaseUrl(candidate), false, candidate);
  }
});

test('assertSafeDatabaseUrl: returns normalized url outside test mode', () => {
  assert.equal(
    assertSafeDatabaseUrl('postgres://user:pass@localhost:5432/pawpaw', { testRuntime: false }),
    'postgres://user:pass@localhost:5432/pawpaw',
  );
});
