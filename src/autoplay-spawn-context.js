/**
 * Собирает контекст для autoplay spawn без изменения policy.
 * Хранение session state остаётся в autoplay-session-state.js,
 * а этот шаг только формирует orchestration input.
 *
 * @param {{
 *   guildId: string,
 *   seedQuery: string,
 *   session: {
 *     sessionTitles: string[],
 *     usedQueries: string[],
 *     initialSeed: string | null,
 *     lastIntent: string | null,
 *   },
 *   normalizeTitle: (title: string) => string,
 *   getPositiveContext: (guildId: string) => string[],
 *   getNegativeContext: (guildId: string, limit: number) => string[],
 *   detectDominantArtist: (titles: string[]) => { artist: string, count: number } | null,
 *   buildAutoplayPivotSeed: (guildId: string) => string | null,
 * }} p
 */
export function buildAutoplaySpawnContext(p) {
  const sessionTitles = p.session.sessionTitles;
  const initialSeed = p.session.initialSeed;
  const lastIntent = p.session.lastIntent;
  const playedTitles = sessionTitles.map(p.normalizeTitle);
  const positiveCtx = p.getPositiveContext(p.guildId).map(p.normalizeTitle);
  const negativeCtx = p.getNegativeContext(p.guildId, 8).map(p.normalizeTitle);
  const usedQueries = p.session.usedQueries;
  const pivotDominant = p.detectDominantArtist(sessionTitles.slice(-5));
  const pivotToAnchor = Boolean(pivotDominant);
  const effectiveSeed = pivotToAnchor
    ? (p.buildAutoplayPivotSeed(p.guildId) ?? p.seedQuery)
    : p.seedQuery;

  return {
    sessionTitles,
    initialSeed,
    lastIntent,
    playedTitles,
    positiveCtx,
    negativeCtx,
    usedQueries,
    pivotDominant,
    pivotToAnchor,
    effectiveSeed,
  };
}
