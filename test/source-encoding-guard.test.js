/**
 * source-encoding-guard.test.js
 *
 * Context: on the Windows host some edit tools pass files through a
 * Windows-1252 codepath during write. When a source file contains Cyrillic
 * text encoded as UTF-8 (bytes 0xD0/0xD1 + trailer), that codepath cannot
 * represent Cyrillic and replaces every affected byte pair with a single
 * 0x98 "replacement" byte. Result: panel strings render as "??????" in
 * Discord, and the commit passes CI because JS syntax is still valid.
 *
 * This guard fails loud the moment any source file is saved through a
 * broken codec. Cheap to run, stops a whole class of silent regressions.
 *
 * Heuristic:
 *   - Count "replacement-looking" 0x98 bytes in each source file.
 *   - Normal source files have 0-5 such bytes (incidental, e.g. inside
 *     binary-looking comments). Broken files have hundreds-to-thousands.
 *   - Threshold: > 20 is a hard fail.
 *   - Additionally: every file that had Cyrillic previously should still
 *     have a substantial number of 0xD0/0xD1 UTF-8 lead bytes. Zero leads
 *     in a file that used to have Cyrillic = the Cyrillic got nuked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');

const SAFE_0x98_THRESHOLD = 20;

/** Files that carry heavy Russian payloads — losing it = regression. */
const MUST_HAVE_CYRILLIC = [
  'music-panel.js',  // ~2700 UTF-8 Cyrillic leads in practice
  'music.js',        // ~3900
  'orchestrator.js', // ~1800
  'index.js',        // ~1200
];

function analyseFile(absPath) {
  const buf = fs.readFileSync(absPath);
  let n98 = 0;
  let utf8Leads = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x98) n98++;
    if (buf[i] === 0xD0 || buf[i] === 0xD1) utf8Leads++;
  }
  return { size: buf.length, n98, utf8Leads };
}

test('no source file has a suspicious pile of 0x98 replacement bytes', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const abs = path.join(SRC_DIR, f);
    const stats = analyseFile(abs);
    if (stats.n98 > SAFE_0x98_THRESHOLD) {
      offenders.push(`${f}: ${stats.n98} × 0x98 (likely UTF-8 → Windows-1252 corruption)`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Files look Cyrillic-corrupted:\n  - ${offenders.join('\n  - ')}\n` +
      `Use a Node fs.writeFileSync(..., 'utf8') patch script instead of StrReplace ` +
      `for any edit that touches a Cyrillic region of these files.`,
  );
});

test('files that must carry Russian text still have UTF-8 Cyrillic leads', () => {
  const stripped = [];
  for (const f of MUST_HAVE_CYRILLIC) {
    const abs = path.join(SRC_DIR, f);
    const stats = analyseFile(abs);
    // Threshold 500: realistic files here have 1000+ leads. A value below
    // 500 would mean someone nuked most of the Cyrillic — exactly the
    // regression we want to catch.
    if (stats.utf8Leads < 500) {
      stripped.push(`${f}: only ${stats.utf8Leads} UTF-8 leads (expected > 500)`);
    }
  }
  assert.equal(
    stripped.length,
    0,
    `Files lost their Cyrillic payload:\n  - ${stripped.join('\n  - ')}`,
  );
});
