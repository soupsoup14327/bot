/**
 * Этап 7: Groq только в recovery — счётчик подряд идущих «плохих» spawn
 * (исключение, пустая выдача, все кандидаты в playability cache).
 * Пока streak < порога, median path в `autoplay-engine` не вызывает Groq
 * (если включено AUTOPLAY_RECOVERY_GROQ_ONLY=1).
 */

/** @type {Map<string, number>} */
const badSpawnStreakByGuild = new Map();

export function isRecoveryGroqOnlyEnabled() {
  return String(process.env.AUTOPLAY_RECOVERY_GROQ_ONLY ?? '').trim() === '1';
}

/** Порог подряд плохих исходов, после которого разрешена цепочка Groq. */
export function recoveryStreakThreshold() {
  const n = Number(process.env.AUTOPLAY_RECOVERY_STREAK_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 2;
}

export function getAutoplayRecoveryStreak(guildId) {
  return badSpawnStreakByGuild.get(String(guildId)) ?? 0;
}

export function resetAutoplayRecoveryStreak(guildId) {
  badSpawnStreakByGuild.delete(String(guildId));
}

/**
 * Успешная постановка трека в очередь — сбрасываем streak.
 * @param {string} guildId
 */
export function recordAutoplaySpawnSuccess(guildId) {
  resetAutoplayRecoveryStreak(guildId);
}

/**
 * Плохой исход spawn (см. вызовы в music.js).
 * @param {string} guildId
 */
export function recordAutoplaySpawnBadOutcome(guildId) {
  const id = String(guildId);
  const n = (badSpawnStreakByGuild.get(id) ?? 0) + 1;
  badSpawnStreakByGuild.set(id, n);
}

/**
 * Разрешить полную цепочку Groq (artist-pack → struct → legacy).
 * Если recovery-only выключен — всегда true (старое поведение).
 * @param {string} guildId
 */
export function shouldAllowGroqAutoplayChain(guildId) {
  if (!isRecoveryGroqOnlyEnabled()) return true;
  return getAutoplayRecoveryStreak(guildId) >= recoveryStreakThreshold();
}
