import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { ENV_REGISTRY, INTERNAL_ENV_KEYS, getRegistryMap } from './env-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const ENV_PATH = path.join(ROOT, '.env');

function walkJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.bak')) continue;
    files.push(full);
  }
  return files;
}

function getUsedEnvVars() {
  const files = walkJsFiles(SRC_DIR);
  const used = new Set();
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
    for (const m of content.matchAll(/env(?:Number|Bool|Int|Float)\('([A-Z0-9_]+)'/g)) used.add(m[1]);
  }
  for (const k of INTERNAL_ENV_KEYS) used.delete(k);
  return [...used].sort();
}

function getEnvExampleVars() {
  const text = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const vars = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/);
    if (m) vars.add(m[1]);
  }
  return [...vars].sort();
}

function validateBySpec(name, value, spec) {
  if (value == null || value === '') return null;

  if (spec.type === 'bool01') {
    if (!/^(0|1|true|false|yes|no)$/i.test(String(value).trim())) {
      return `${name} must be boolean-like (0/1/true/false/yes/no)`;
    }
    return null;
  }
  if (spec.type === 'int') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return `${name} must be an integer`;
    if (spec.min != null && n < spec.min) return `${name} must be >= ${spec.min}`;
    if (spec.max != null && n > spec.max) return `${name} must be <= ${spec.max}`;
    return null;
  }
  if (spec.type === 'float') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${name} must be a number`;
    if (spec.min != null && n < spec.min) return `${name} must be >= ${spec.min}`;
    if (spec.max != null && n > spec.max) return `${name} must be <= ${spec.max}`;
    return null;
  }
  if (spec.type === 'url') {
    try {
      new URL(value);
    } catch {
      return `${name} must be a valid URL`;
    }
    return null;
  }
  return null;
}

function checkRegistryCoverage(usedVars, registryMap) {
  return usedVars.filter((name) => !registryMap.has(name));
}

function checkExampleCoverage(registryVars, exampleVars) {
  const example = new Set(exampleVars);
  return registryVars.filter((name) => !example.has(name));
}

function loadDotEnvIfExists() {
  if (!fs.existsSync(ENV_PATH)) return { exists: false, parsed: {} };
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  return { exists: true, parsed: dotenv.parse(raw) };
}

function validateDotEnv(parsed, registry) {
  const issues = [];
  for (const spec of registry) {
    const value = parsed[spec.name];
    if (spec.required && (value == null || value === '')) {
      issues.push(`${spec.name} is required but missing in .env`);
      continue;
    }
    const err = validateBySpec(spec.name, value, spec);
    if (err) issues.push(err);
  }
  return issues;
}

function printRegistrySummary() {
  const byCategory = ENV_REGISTRY.reduce((acc, it) => {
    acc[it.category] = (acc[it.category] || 0) + 1;
    return acc;
  }, {});
  const categories = Object.keys(byCategory).sort();
  console.log('[env] registry categories:');
  for (const c of categories) {
    console.log(`  - ${c}: ${byCategory[c]}`);
  }
}

function run() {
  const usedVars = getUsedEnvVars();
  const registryMap = getRegistryMap();
  const registryVars = [...registryMap.keys()].sort();
  const exampleVars = getEnvExampleVars();

  const uncoveredUsed = checkRegistryCoverage(usedVars, registryMap);
  const missingInExample = checkExampleCoverage(registryVars, exampleVars);

  const dotEnv = loadDotEnvIfExists();
  const envIssues = dotEnv.exists ? validateDotEnv(dotEnv.parsed, ENV_REGISTRY) : [];

  console.log(`[env] used in src: ${usedVars.length}`);
  console.log(`[env] in registry: ${registryVars.length}`);
  console.log(`[env] in .env.example: ${exampleVars.length}`);
  printRegistrySummary();

  if (uncoveredUsed.length > 0) {
    console.log('\n[env] ERROR: vars used in src but missing in registry:');
    uncoveredUsed.forEach((v) => console.log(`  - ${v}`));
  }
  if (missingInExample.length > 0) {
    console.log('\n[env] ERROR: vars in registry but missing in .env.example:');
    missingInExample.forEach((v) => console.log(`  - ${v}`));
  }

  if (!dotEnv.exists) {
    console.log('\n[env] note: .env not found, skipped local value validation.');
  } else if (envIssues.length > 0) {
    console.log('\n[env] ERROR: .env validation failed:');
    envIssues.forEach((it) => console.log(`  - ${it}`));
  } else {
    console.log('\n[env] .env validation passed.');
  }

  if (uncoveredUsed.length > 0 || missingInExample.length > 0 || envIssues.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('\nverify-env: ALL CHECKS PASSED');
}

run();
