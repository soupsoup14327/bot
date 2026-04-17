import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const rawUrl = String(process.env.DATABASE_URL ?? '').trim();
const defaultUrl = 'postgres://postgres:postgres@127.0.0.1:5432/pawpaw_dev';
const databaseUrl = rawUrl.startsWith('postgres://') || rawUrl.startsWith('postgresql://')
  ? rawUrl
  : defaultUrl;

export default defineConfig({
  out: './src/db/migrations/postgres',
  schema: './src/db/schema.pg.js',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
