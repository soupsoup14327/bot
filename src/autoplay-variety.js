/**
 * Variety controller (этап 9): мягкие штрафы за повтор артиста и «залипание» query family.
 * Состояние — только после успешных autoplay spawn; сброс при стопе/выходе.
 */

import { extractLeadArtistTokenFromTitle } from './autoplay-artist-tokens.js';

/** @type {Map<string, string[]>} */
const recentArtistsByGuild = new Map();
/** @type {Map<string, string[]>} */
const recentFamiliesByGuild = new Map();

export function isVarietyControllerEnabled() {
  // Default ON: выключается только явным `=0` / `=false`. Контроллер
  // штрафует повторы артистов и query-family при ранкинге и критически
  // важен для anti-repeat UX при ∞ (см. docs/АРХИТЕКТУРА.md#variety).
  const v = String(process.env.AUTOPLAY_VARIETY_CONTROLLER_ENABLED ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Грубая семья retrieval для анти-залипания (staff v2 §12.2).
 * @param {Record<string, unknown> | null | undefined} telemetry
 * @param {string | null | undefined} firstQuery
 */
export function inferQueryFamilyFromTelemetry(telemetry, firstQuery) {
  const q = String(firstQuery ?? '').toLowerCase();
  const qs = String(telemetry?.querySource ?? telemetry?.retrievalPath ?? '');
  if (/cover|nightcore|slowed|remix|кавер|sped\s*up|8d\b/i.test(q)) return 'cover_remix_live';
  if (/mix|compilation|playlist|\b\d+\s*hours?\b|\bhour\b/i.test(q)) return 'playlist_mix';
  if (/similar|recommended|like\b|discover/i.test(q)) return 'related_similar';
  if (qs.includes('fast_lane')) return qs.includes('light_variety') ? 'fast_light' : 'fast_stable';
  if (qs.includes('groq')) return 'groq';
  if (qs.includes('non_groq')) return 'median_non_groq';
  return 'generic';
}

/**
 * @param {string} guildId
 * @param {{ pickedTitle: string, telemetry: Record<string, unknown>, firstQuery: string | null | undefined }} meta
 */
export function recordVarietyStateAfterSpawn(guildId, meta) {
  if (!isVarietyControllerEnabled()) return;
  const id = String(guildId);
  const artist = extractLeadArtistTokenFromTitle(meta.pickedTitle);
  if (artist) {
    const arr = recentArtistsByGuild.get(id) ?? [];
    arr.push(artist);
    while (arr.length > 5) arr.shift();
    recentArtistsByGuild.set(id, arr);
  }
  const fam = inferQueryFamilyFromTelemetry(meta.telemetry, meta.firstQuery);
  const farr = recentFamiliesByGuild.get(id) ?? [];
  farr.push(fam);
  while (farr.length > 5) farr.shift();
  recentFamiliesByGuild.set(id, farr);
}

export function clearVarietyState(guildId) {
  const id = String(guildId);
  recentArtistsByGuild.delete(id);
  recentFamiliesByGuild.delete(id);
}

/**
 * Штраф к total score ranker-а (не hard-reject).
 * @param {string} guildId
 * @param {string} candidateTitle
 */
export function computeVarietyRankPenalty(guildId, candidateTitle) {
  if (!isVarietyControllerEnabled()) {
    return { penalty: 0, notes: {} };
  }
  const id = String(guildId);
  const cand = extractLeadArtistTokenFromTitle(candidateTitle);
  if (!cand) return { penalty: 0, notes: {} };

  const recent = recentArtistsByGuild.get(id) ?? [];
  const window = recent.slice(-5);
  const countSame = window.filter((a) => a === cand).length;
  const last2 = window.slice(-2);

  const soft = envNumber('AUTOPLAY_VARIETY_ARTIST_SOFT_PENALTY', 12, 0, 80);
  const strong = envNumber('AUTOPLAY_VARIETY_ARTIST_STRONG_PENALTY', 32, 0, 120);

  /** @type {Record<string, unknown>} */
  const notes = {};
  let penalty = 0;

  if (last2.includes(cand)) {
    penalty += soft;
    notes.artistRepeatLast2 = true;
  }
  if (countSame >= 3) {
    penalty += strong;
    notes.artistDominantWindow = countSame;
  }

  const fams = recentFamiliesByGuild.get(id) ?? [];
  const last3 = fams.slice(-3);
  if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
    const base = envNumber('AUTOPLAY_VARIETY_FAMILY_STREAK_BASE', 8, 0, 40);
    const mult = envNumber('AUTOPLAY_VARIETY_FAMILY_STREAK_MULT', 1.35, 1, 2);
    penalty = Math.floor((penalty + base) * mult);
    notes.familyStreak3x = last3[0];
    notes.familyStreakBase = base;
    notes.familyStreakMult = mult;
  }

  return { penalty, notes };
}
