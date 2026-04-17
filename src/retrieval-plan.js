/**
 * План retrieval для автоплея (этап 3): fast lane без Groq при стабильном сценарии.
 * См. docs/AUTOPLAY-IMPLEMENTATION-PLAN.md, docs/autoplay_staff_level_plan_v2.txt (FAST CONTINUATION LANE).
 *
 * Импорт без побочных эффектов: только функции и чтение env при вызове.
 */

/** Согласовано с variantAutoplayQuery в music.js — лёгкое разнообразие. */
const AUTOPLAY_MODIFIERS = ['', '', '', '', '', 'lyrics', 'new', 'similar', 'classic', 'official'];

function variantAutoplayQuery(base) {
  const b = String(base ?? '').trim();
  if (!b) return '';
  const mod = AUTOPLAY_MODIFIERS[Math.floor(Math.random() * AUTOPLAY_MODIFIERS.length)];
  return mod ? `${b} ${mod}` : b;
}

export function isFastLaneEnabled() {
  return String(process.env.AUTOPLAY_FAST_LANE_ENABLED ?? '').trim() === '1';
}

/**
 * Этап 9 (эксперимент): ~30% попыток добавить «лёгкое расширение» в fast lane.
 * Не дефолт для prod — только явный флаг. Доли — ориентир, не гарантия.
 */
export function isVarietyBudget7030Experimental() {
  return String(process.env.AUTOPLAY_VARIETY_BUDGET_EXPERIMENTAL ?? '').trim() === '1';
}

function fastLaneQueryBudget() {
  const n = Number(process.env.AUTOPLAY_FAST_LANE_QUERY_BUDGET);
  return Number.isFinite(n) && n >= 2 ? Math.min(12, Math.floor(n)) : 6;
}

function altStreakMinFromEnv() {
  const n = Number(process.env.AUTOPLAY_ALT_STREAK_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.min(6, Math.floor(n)) : 2;
}

/**
 * @typedef {{
 *   pivotToAnchor: boolean,
 *   lastIntent: string | null,
 *   initialSeed: string | null,
 *   topic: string | null,
 *   lastPlayedTitle: string | null,
 *   effectiveSeed: string,
 *   alternateStreak: number,
 * }} FastLaneContext
 */

/**
 * @param {FastLaneContext} ctx
 * @returns {{ mode: 'stable_continue' | 'light_variety', searchQueries: string[], usedToken: string } | null}
 */
export function tryBuildFastLaneRetrievalPlan(ctx) {
  if (!isFastLaneEnabled()) return null;
  /** Pivot — нужен полный Groq-путь (разнообразие / смена кластера). */
  if (ctx.pivotToAnchor) return null;

  const lastIntent = ctx.lastIntent ? String(ctx.lastIntent).trim() : '';
  const initialSeed = ctx.initialSeed ? String(ctx.initialSeed).trim() : '';
  const lastPlayed = ctx.lastPlayedTitle ? String(ctx.lastPlayedTitle).trim() : '';
  const topic = ctx.topic ? String(ctx.topic).trim() : '';
  const cleanSeed = String(ctx.effectiveSeed ?? '')
    .split('\n')[0]
    .replace(/^[^:]+:\s*/, '')
    .trim();

  const primary = lastIntent || initialSeed || cleanSeed || '';
  const hasSignal = Boolean(primary || lastPlayed || topic);
  if (!hasSignal) return null;

  const lightVariety = Number(ctx.alternateStreak ?? 0) >= altStreakMinFromEnv();
  const mode = lightVariety ? 'light_variety' : 'stable_continue';

  /** @type {string[]} */
  const raw = [];

  if (primary) {
    raw.push(`${primary} official audio`);
    const v = variantAutoplayQuery(primary);
    if (v) raw.push(v);
    if (lightVariety) {
      raw.push(`${primary} music`);
      const vr = variantAutoplayQuery(`${primary} recommended`);
      if (vr) raw.push(vr);
    }
  }
  if (lastPlayed && lastPlayed !== primary) {
    raw.push(`${lastPlayed} similar`);
    if (lightVariety) raw.push(`${lastPlayed} songs`);
  }
  if (topic) {
    raw.push(`${topic} official audio`);
    if (lightVariety) {
      const vt = variantAutoplayQuery(topic);
      if (vt) raw.push(vt);
    }
  }
  if (!primary && lastPlayed) {
    raw.push(`${lastPlayed} official audio`);
    const vl = variantAutoplayQuery(lastPlayed);
    if (vl) raw.push(vl);
  }

  const seen = new Set();
  const uniq = [];
  for (const q of raw) {
    const s = String(q).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }

  const budget = fastLaneQueryBudget();
  if (isVarietyBudget7030Experimental() && uniq.length < budget && Math.random() < 0.3) {
    const anchor = primary || lastPlayed || topic || cleanSeed;
    if (anchor) {
      const exp = `${anchor} discover`;
      const k = exp.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(exp);
      }
    }
  }

  const searchQueries = uniq.slice(0, budget);
  if (searchQueries.length === 0) return null;

  const usedToken = `fastlane:${mode}:${searchQueries[0].slice(0, 120)}`;
  return { mode, searchQueries, usedToken };
}
