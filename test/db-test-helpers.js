import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabaseConnection } from '../src/db/connection.js';
import { runDatabaseMigrations } from '../src/db/migrate.js';

/**
 * Small shared helper for DB-backed tests.
 * Uses file SQLite under ./data/test so each suite can run migrations once and
 * then reopen the same database connection safely.
 *
 * @param {string} name
 */
function sanitizeTestName(name) {
  const normalized = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized || 'db-test';
}

/**
 * @param {string} name
 */
export function buildSqliteTestDbUrl(name) {
  return `sqlite:./data/test/${sanitizeTestName(name)}.db`;
}

/**
 * @param {string} name
 */
export function buildSqliteTestDbPath(name) {
  return join(process.cwd(), 'data', 'test', `${sanitizeTestName(name)}.db`);
}

/**
 * @param {string} name
 */
export async function openMigratedSqliteTestDb(name) {
  const url = buildSqliteTestDbUrl(name);
  const absolutePath = buildSqliteTestDbPath(name);

  if (existsSync(absolutePath)) {
    rmSync(absolutePath, { force: true });
  }

  await runDatabaseMigrations({ url });
  const connection = await openDatabaseConnection({ url });

  return {
    url,
    absolutePath,
    connection,
    async cleanup() {
      await connection.close();
      if (existsSync(absolutePath)) {
        rmSync(absolutePath, { force: true });
      }
    },
  };
}
