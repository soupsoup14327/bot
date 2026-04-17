import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabaseConnection } from '../src/db/connection.js';
import { resolveMigrationsFolderForBackend, runDatabaseMigrations } from '../src/db/migrate.js';

test('resolveMigrationsFolderForBackend: returns committed migration packs for both backends', async () => {
  const sqliteFolder = resolveMigrationsFolderForBackend('sqlite');
  const postgresFolder = resolveMigrationsFolderForBackend('postgres');

  assert.equal(
    existsSync(join(sqliteFolder, 'meta', '_journal.json')),
    true,
  );
  assert.equal(
    existsSync(join(postgresFolder, 'meta', '_journal.json')),
    true,
  );
});

test('runDatabaseMigrations: applies schema and is idempotent on repeat', async () => {
  const relativePath = './data/test/db-migrate-roundtrip.db';
  const absolutePath = join(process.cwd(), 'data', 'test', 'db-migrate-roundtrip.db');

  if (existsSync(absolutePath)) {
    rmSync(absolutePath, { force: true });
  }

  try {
    await runDatabaseMigrations({ url: `sqlite:${relativePath}` });
    await assert.doesNotReject(async () => {
      await runDatabaseMigrations({ url: `sqlite:${relativePath}` });
    });

    const connection = await openDatabaseConnection({ url: `sqlite:${relativePath}` });
    try {
      const rows = connection.client
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all();
      const tables = rows.map((row) => row.name);
      assert.equal(tables.includes('__drizzle_migrations'), true);
      assert.equal(tables.includes('track_plays'), true);
      assert.equal(tables.includes('track_likes'), true);
      assert.equal(tables.includes('tracks'), true);
      assert.equal(tables.includes('users'), true);
    } finally {
      await connection.close();
    }
  } finally {
    if (existsSync(absolutePath)) {
      rmSync(absolutePath, { force: true });
    }
  }
});

test('runDatabaseMigrations: reuses an already-open connection without closing it', async () => {
  const relativePath = './data/test/db-migrate-existing-connection.db';
  const absolutePath = join(process.cwd(), 'data', 'test', 'db-migrate-existing-connection.db');

  if (existsSync(absolutePath)) {
    rmSync(absolutePath, { force: true });
  }

  let connection = null;
  try {
    connection = await openDatabaseConnection({ url: `sqlite:${relativePath}` });
    await runDatabaseMigrations({ connection });

    const rows = connection.client
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all();
    const tables = rows.map((row) => row.name);
    assert.equal(tables.includes('__drizzle_migrations'), true);
    assert.equal(tables.includes('track_plays'), true);
    assert.equal(tables.includes('track_likes'), true);
    assert.equal(tables.includes('tracks'), true);
    assert.equal(tables.includes('users'), true);
  } finally {
    if (connection) {
      await connection.close();
    }
    if (existsSync(absolutePath)) {
      rmSync(absolutePath, { force: true });
    }
  }
});
