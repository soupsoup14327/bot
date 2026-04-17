/**
 * Generates `.env.example` from `scripts/env-registry.mjs`.
 *
 * Produces a human-readable template: category headers, inline defaults for
 * optional vars (as commented hints), and live placeholders for secrets that
 * an operator must set (DISCORD_TOKEN, DISCORD_CLIENT_ID, GROQ_API_KEY).
 *
 * Usage:
 *   node scripts/generate-env-example.mjs          # write .env.example
 *   node scripts/generate-env-example.mjs --check  # exit 1 if file is stale
 *
 * The `--check` mode is what CI/verify wires into: no arguments → rewrite,
 * `--check` → diff against disk and fail if out of sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_REGISTRY } from './env-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '.env.example');

const CATEGORY_ORDER = ['core', 'groq', 'autoplay', 'signals', 'playback', 'metrics'];

const CATEGORY_HEADERS = {
  core: 'Discord core',
  groq: 'Groq (ИИ для /chat и автоплея)',
  autoplay: 'Autoplay (движок подбора треков)',
  signals: 'Signals & recommendation bridge',
  playback: 'Playback, voice, yt-dlp',
  metrics: 'Metrics & debug',
};

const LIVE_PLACEHOLDERS = {
  DISCORD_TOKEN: 'your_bot_token_here',
  DISCORD_CLIENT_ID: 'your_application_id_here',
  GROQ_API_KEY: '',
};

const DATA_LAYER_BLOCK = `# ---------------------------------------------------------------------------
# Data layer (см. docs/adr/001-data-layer.md)
#
# Один DATABASE_URL управляет всем data-слоем. Schema в URL выбирает backend.
# Если переменная не задана:
#   - под \`node --test\` / NODE_ENV=test → sqlite::memory: (in-memory)
#   - в остальных случаях              → sqlite:./data/local.db (file)
#
# Примеры (раскомментировать нужное):
#
# In-memory SQLite — автотесты, CI matrix job \`test-sqlite\`:
# DATABASE_URL=sqlite::memory:
#
# File SQLite — локальная разработка (default для запуска без env):
# DATABASE_URL=sqlite:./data/local.db
#
# PostgreSQL — managed / production-like окружение:
# DATABASE_URL=postgres://user:password@host:5432/dbname
#
# Test-safety: в тестовом режиме допустимы ТОЛЬКО sqlite::memory: и
# sqlite:./data/test/*.db. Любой другой URL валит процесс немедленно
# (см. docs/adr/001-data-layer.md §3 Test-safety invariant).
# ---------------------------------------------------------------------------
# DATABASE_URL=sqlite:./data/local.db`;

function groupRegistry() {
  const groups = new Map();
  for (const c of CATEGORY_ORDER) groups.set(c, []);
  for (const row of ENV_REGISTRY) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  return groups;
}

function renderRow(row) {
  const live = Object.prototype.hasOwnProperty.call(LIVE_PLACEHOLDERS, row.name);
  const desc = row.description ? `  # ${row.description}` : '';
  if (live) {
    return `${row.name}=${LIVE_PLACEHOLDERS[row.name]}${desc}`;
  }
  const value = row.defaultValue != null ? String(row.defaultValue) : '';
  return `# ${row.name}=${value}${desc}`;
}

function build() {
  const lines = [];
  lines.push('# PAWPAW bot — environment template');
  lines.push('# Copy to .env and fill in secrets.');
  lines.push('# Regenerate from registry: node scripts/generate-env-example.mjs');
  lines.push('# Validate drift:         node scripts/generate-env-example.mjs --check');
  lines.push('');

  const groups = groupRegistry();
  for (const category of CATEGORY_ORDER) {
    const rows = groups.get(category) || [];
    if (rows.length === 0) continue;
    const header = CATEGORY_HEADERS[category] || category;
    lines.push(`# === [${category}] ${header} ===`);
    for (const row of rows) {
      lines.push(renderRow(row));
    }
    lines.push('');
  }

  lines.push(DATA_LAYER_BLOCK);
  lines.push('');

  return lines.join('\n');
}

function run() {
  const mode = process.argv[2] === '--check' ? 'check' : 'write';
  const next = build();

  if (mode === 'check') {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current === next) {
      console.log('[env.example] up to date');
      return;
    }
    console.error('[env.example] OUT OF SYNC with scripts/env-registry.mjs');
    console.error('  Fix: node scripts/generate-env-example.mjs');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(TARGET, next, 'utf8');
  console.log(`[env.example] wrote ${TARGET} (${next.length} bytes, ${ENV_REGISTRY.length} registry vars)`);
}

run();
