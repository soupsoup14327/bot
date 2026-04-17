import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { getSchemaForBackend } from './schema.js';
import { assertSafeDatabaseUrl, isTestRuntime } from './test-safety-guard.js';

const { Client: PgClient } = pg;

const DEFAULT_TEST_DATABASE_URL = 'sqlite::memory:';
const DEFAULT_DEV_DATABASE_URL = 'sqlite:./data/local.db';

/**
 * @typedef {{
 *   backend: 'sqlite',
 *   url: string,
 *   filename: string,
 *   inMemory: boolean,
 * }} SqliteDatabaseConfig
 */

/**
 * @typedef {{
 *   backend: 'postgres',
 *   url: string,
 * }} PostgresDatabaseConfig
 */

/**
 * @typedef {SqliteDatabaseConfig | PostgresDatabaseConfig} ParsedDatabaseUrl
 */

/**
 * @typedef {{
 *   backend: 'sqlite' | 'postgres',
 *   url: string,
 *   db: unknown,
 *   client: unknown,
 *   close: () => Promise<void>,
 * }} DatabaseConnection
 */

/**
 * @returns {string}
 */
export function resolveDatabaseUrl() {
  const fromEnv = String(process.env.DATABASE_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  return isTestRuntime() ? DEFAULT_TEST_DATABASE_URL : DEFAULT_DEV_DATABASE_URL;
}

/**
 * @param {string} rawUrl
 * @returns {ParsedDatabaseUrl}
 */
export function parseDatabaseUrl(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) {
    throw new Error('DATABASE_URL is empty');
  }

  if (url === 'sqlite::memory:') {
    return {
      backend: 'sqlite',
      url,
      filename: ':memory:',
      inMemory: true,
    };
  }

  if (url.startsWith('sqlite:')) {
    const location = url.slice('sqlite:'.length);
    if (!location) {
      throw new Error(`Unsupported sqlite DATABASE_URL: ${url}`);
    }
    return {
      backend: 'sqlite',
      url,
      filename: resolve(process.cwd(), location),
      inMemory: false,
    };
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return {
      backend: 'postgres',
      url,
    };
  }

  throw new Error(`Unsupported DATABASE_URL scheme: ${url}`);
}

/**
 * @param {{ url?: string }} [options]
 * @returns {Promise<DatabaseConnection>}
 */
export async function openDatabaseConnection(options = {}) {
  const url = options.url ? String(options.url).trim() : resolveDatabaseUrl();
  assertSafeDatabaseUrl(url);
  const parsed = parseDatabaseUrl(url);

  if (parsed.backend === 'sqlite') {
    const schema = getSchemaForBackend('sqlite');
    if (!parsed.inMemory) {
      mkdirSync(dirname(parsed.filename), { recursive: true });
    }
    const client = new BetterSqlite3(parsed.filename);
    const db = drizzleSqlite({ client, schema });
    return {
      backend: 'sqlite',
      url: parsed.url,
      db,
      client,
      close: async () => {
        client.close();
      },
    };
  }

  const schema = getSchemaForBackend('postgres');
  const client = new PgClient({ connectionString: parsed.url });
  await client.connect();
  const db = drizzlePg({ client, schema });
  return {
    backend: 'postgres',
    url: parsed.url,
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}
