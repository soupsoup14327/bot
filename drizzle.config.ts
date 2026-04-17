import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const rawUrl = String(process.env.DATABASE_URL ?? '').trim();
const defaultUrl = process.argv.includes('--test')
  ? 'sqlite::memory:'
  : 'sqlite:./data/local.db';
const databaseUrl = rawUrl === 'sqlite::memory:' || rawUrl.startsWith('sqlite:')
  ? rawUrl
  : defaultUrl;

export default defineConfig({
  out: './src/db/migrations/sqlite',
  schema: './src/db/schema.sqlite.js',
  dialect: 'sqlite',
  dbCredentials: {
    url: databaseUrl,
  },
});
