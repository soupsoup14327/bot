import { assertSafeDatabaseUrl } from '../src/db/test-safety-guard.js';

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const url = String(process.env.DATABASE_URL ?? 'sqlite::memory:').trim();

assertSafeDatabaseUrl(url, { testRuntime: true });
