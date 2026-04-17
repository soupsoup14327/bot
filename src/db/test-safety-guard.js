/**
 * In test mode we only allow ephemeral SQLite or files under ./data/test/.
 * This protects against accidental writes to a real operator database.
 */
export const SAFE_TEST_DATABASE_URL_RE = /^(sqlite::memory:|sqlite:\.\/data\/test\/[a-z0-9._-]+\.db)$/;

/**
 * `node --test` passes the flag through execArgv. We also respect NODE_ENV=test
 * because some helpers may run outside the native test runner.
 *
 * @returns {boolean}
 */
export function isTestRuntime() {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test='))) {
    return true;
  }
  return process.argv.some((arg) => arg === '--test' || arg.startsWith('--test='));
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeTestDatabaseUrl(url) {
  return SAFE_TEST_DATABASE_URL_RE.test(String(url ?? '').trim());
}

/**
 * Hard-fail before any connection is opened. We use process.exit(1) instead of
 * throwing so the node:test runner cannot accidentally swallow the invariant.
 *
 * @param {string} url
 * @param {{ testRuntime?: boolean }} [options]
 * @returns {string}
 */
export function assertSafeDatabaseUrl(url, options = {}) {
  const normalized = String(url ?? '').trim();
  const testRuntime = options.testRuntime ?? isTestRuntime();
  if (!testRuntime) return normalized;
  if (isSafeTestDatabaseUrl(normalized)) return normalized;

  console.error(
    `[db:test-safety] Refusing to open unsafe test database URL: ${normalized || '<empty>'}`,
  );
  process.exit(1);
}
