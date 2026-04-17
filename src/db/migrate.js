import 'dotenv/config';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabaseConnection } from './connection.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_FOLDER = join(HERE, 'migrations', 'sqlite');
const POSTGRES_MIGRATIONS_FOLDER = join(HERE, 'migrations', 'postgres');

/**
 * @param {'sqlite' | 'postgres'} backend
 * @returns {string}
 */
export function resolveMigrationsFolderForBackend(backend) {
  return backend === 'postgres'
    ? POSTGRES_MIGRATIONS_FOLDER
    : SQLITE_MIGRATIONS_FOLDER;
}

/**
 * Apply pending SQL migrations from backend-specific src/db/migrations/* packs.
 *
 * Ownership rule:
 * - connection opening lives in connection.js
 * - migration execution lives here
 * - startup wiring will call this before Discord login
 *
 * Can reuse an already-open connection for startup bootstrapping:
 * `open -> migrate -> close -> client.login()`.
 *
 * @param {{
 *   url?: string,
 *   connection?: import('./connection.js').DatabaseConnection,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function runDatabaseMigrations(options = {}) {
  const connection = options.connection ?? await openDatabaseConnection({ url: options.url });
  const ownsConnection = !options.connection;
  try {
    const migrationsFolder = resolveMigrationsFolderForBackend(connection.backend);
    const migrationsJournal = join(migrationsFolder, 'meta', '_journal.json');
    if (!existsSync(migrationsJournal)) {
      return;
    }

    if (connection.backend === 'sqlite') {
      await migrateSqlite(connection.db, { migrationsFolder });
      return;
    }

    await migratePg(connection.db, { migrationsFolder });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runDatabaseMigrations();
    console.log('[db] migrations complete');
  } catch (error) {
    console.error('[db] migration failed', error);
    process.exit(1);
  }
}
