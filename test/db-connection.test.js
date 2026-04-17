import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openDatabaseConnection,
  parseDatabaseUrl,
  resolveDatabaseUrl,
} from '../src/db/connection.js';

test('resolveDatabaseUrl: defaults to sqlite::memory: in test mode', () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(resolveDatabaseUrl(), 'sqlite::memory:');
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

test('parseDatabaseUrl: sqlite memory', () => {
  assert.deepEqual(parseDatabaseUrl('sqlite::memory:'), {
    backend: 'sqlite',
    url: 'sqlite::memory:',
    filename: ':memory:',
    inMemory: true,
  });
});

test('parseDatabaseUrl: sqlite file', () => {
  const parsed = parseDatabaseUrl('sqlite:./data/test/example.db');
  assert.equal(parsed.backend, 'sqlite');
  assert.equal(parsed.inMemory, false);
  assert.match(parsed.filename, /data[\\/]test[\\/]example\.db$/);
});

test('parseDatabaseUrl: postgres', () => {
  assert.deepEqual(parseDatabaseUrl('postgres://user:pass@localhost:5432/pawpaw'), {
    backend: 'postgres',
    url: 'postgres://user:pass@localhost:5432/pawpaw',
  });
});

test('parseDatabaseUrl: unsupported scheme throws', () => {
  assert.throws(
    () => parseDatabaseUrl('mysql://root@localhost/db'),
    /Unsupported DATABASE_URL scheme/,
  );
});

test('openDatabaseConnection: sqlite memory opens and closes cleanly', async () => {
  const connection = await openDatabaseConnection({ url: 'sqlite::memory:' });
  assert.equal(connection.backend, 'sqlite');
  assert.equal(typeof connection.close, 'function');
  await connection.close();
});
