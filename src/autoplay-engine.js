/**
 * Retrieval-путь дублируется не в stdout: groqTrace + postPolicyQueries → data/metrics/autoplay-spawn.txt (music.js).
 * Локально: только debug?.(...) при AUTOPLAY_DEBUG (→ autoplay-debug.txt или консоль).
 * Док: docs/НАБЛЮДАЕМОСТЬ.md
 *
 * autoplay-engine.js — decision layer для retrieval автоплея (этап 5).
 * Не владеет guild state; побочных эффектов при import нет.
 *
 * Вызовы enqueue / schedulePlayNext остаются в `music.js`.
 */

import { groqNextTrackStruct, groqNextTrackQuery, groqRecommendArtists, isGroqConfigured } from './groq.js';
import { applyAutoplayQueryPolicy } from './autoplay-policy.js';
import { buildSearchQueriesFromStruct } from './youtube-search.js';
import { tryBuildFastLaneRetrievalPlan } from './retrieval-plan.js';
import {
  getAutoplayRecoveryStreak,
  isRecoveryGroqOnlyEnabled,
  recoveryStreakThreshold,
  shouldAllowGroqAutoplayChain,
} from './autoplay-recovery.js';

/** Согласовано с `music.js` variantAutoplayQuery. */
const AUTOPLAY_MODIFIERS = ['', '', '', '', '', 'lyrics', 'new', 'similar', 'classic', 'official'];

function variantAutoplayQuery(base) {
  const b = String(base ?? '').trim();
  if (!b) return '';
  const mod = AUTOPLAY_MODIFIERS[Math.floor(Math.random() * AUTOPLAY_MODIFIERS.length)];
  return mod ? `${b} ${mod}` : b;
}

/**
 * Аналог buildAutoplayStrategyQueries в music: identity → baseQueries → topic → explore.
 * @param {{ lastIntent: string | null, initialSeed: string | null, topic: string | null }} snap
 */
function buildStrategyQueries(snap, baseQueries, effectiveSeed) {
  const identity = snap.lastIntent ?? snap.initialSeed ?? null;
  const topic = snap.topic;
  const nearby = topic ? `${topic} official audio` : null;
  const explore = variantAutoplayQuery(
    String(effectiveSeed).split('\n')[0].replace(/^[^:]+:\s*/, '').trim(),
  );
  const all = [
    identity ? `${identity} official audio` : null,
    ...(Array.isArray(baseQueries) ? baseQueries : []),
    nearby,
    explore,
  ]
    .map((q) => String(q ?? '').trim())
    .filter(Boolean);
  return [...new Set(all)];
}

/**
 * @typedef {{
 *   guildId: string,
 *   effectiveSeed: string,
 *   pivotToAnchor: boolean,
 *   playedTitles: string[],
 *   positiveCtx: string[],
 *   negativeCtx: string[],
 *   usedQueries: string[],
 *   lastIntent: string | null,
 *   initialSeed: string | null,
 *   topic: string | null,
 *   identityIntent: string | null,
 *   sessionTitlesForFast: string[],
 *   alternateStreakFast: number,
 *   currentPlayingLabel: string | null,
 *   serverHints: string[],
 *   escapeContrastHint?: { from: 'same_spawn' | 'same_family', anchor: string | null } | null,
 *   dFallbackPrompt?: string | null,
 * }} AutoplayEngineSnapshot
 */

/**
 * @param {AutoplayEngineSnapshot} snapshot
 * @param {{ onGroqCall?: () => void, debug?: (stage: string, meta?: unknown) => void }} [hooks]
 */
export async function pickAutoplayRetrieval(snapshot, hooks = {}) {
  const { onGroqCall, debug } = hooks;
  const guildId = String(snapshot.guildId ?? '');
  const effectiveSeed = String(snapshot.effectiveSeed ?? '');
  const playedTitles = snapshot.playedTitles ?? [];
  const positiveCtx = snapshot.positiveCtx ?? [];
  const negativeCtx = snapshot.negativeCtx ?? [];
  const usedQueries = snapshot.usedQueries ?? [];
  const pivotToAnchor = Boolean(snapshot.pivotToAnchor);
  const serverHints = snapshot.serverHints ?? [];
  const escapeContrastHint = snapshot.escapeContrastHint ?? null;
  const dFallbackPrompt = String(snapshot.dFallbackPrompt ?? '').trim() || null;
  const escapeMode = Boolean(escapeContrastHint);
  const dFallbackMode = Boolean(dFallbackPrompt);
  const specialRetrievalMode = escapeMode || dFallbackMode;

  let searchQueries;
  let usedToken;
  let identityAnchorForPolicy = '';
  let enforceIdentityForPolicy = false;
  let artistCandidates = [];
  /** Снимок для метрик / отладки: что вернул Groq и какие запросы до policy. */
  let groqTrace = null;

  const sessionTitlesForFast = snapshot.sessionTitlesForFast ?? [];
  const fastLanePlan = specialRetrievalMode ? null : tryBuildFastLaneRetrievalPlan({
    pivotToAnchor,
    lastIntent: snapshot.lastIntent,
    initialSeed: snapshot.initialSeed,
    topic: snapshot.topic,
    lastPlayedTitle: sessionTitlesForFast.length ? sessionTitlesForFast[sessionTitlesForFast.length - 1] : null,
    effectiveSeed,
    alternateStreak: snapshot.alternateStreakFast ?? 0,
  });

  if (fastLanePlan) {
    searchQueries = fastLanePlan.searchQueries;
    usedToken = fastLanePlan.usedToken;
    artistCandidates = [];
    identityAnchorForPolicy = '';
    enforceIdentityForPolicy = false;
    debug?.('query-source', {
      mode: 'fast_lane',
      fastMode: fastLanePlan.mode,
      count: searchQueries.length,
    });
    groqTrace = {
      path: 'fast_lane',
      mode: fastLanePlan.mode,
      prePolicyQueries: [...searchQueries],
      usedToken,
    };
  } else {
    const allowGroqChain = shouldAllowGroqAutoplayChain(guildId);
    if (allowGroqChain && isGroqConfigured()) {
      try {
      const artistPack = await groqRecommendArtists(effectiveSeed, playedTitles, {
        positiveContext: positiveCtx,
        negativeContext: negativeCtx,
        usedQueries,
        pivotToAnchor,
      });
      onGroqCall?.();
      const avoided = new Set(
        (artistPack.avoid_artists ?? []).map((a) => String(a).toLowerCase().trim()).filter(Boolean),
      );
      const artistNames = (artistPack.artist_candidates ?? [])
        .map((c) => String(c?.name ?? '').trim())
        .filter(Boolean)
        .filter((name) => !avoided.has(name.toLowerCase()));
      artistCandidates = artistNames.slice(0, 5);
      const artistQueries = artistNames
        .flatMap((name) => [`${name} official audio`, `${name} top track official`])
        .slice(0, 8);
      if (!artistQueries.length) throw new Error('empty artist pack queries');

      searchQueries = artistQueries;
      identityAnchorForPolicy = artistNames[0] ?? '';
      enforceIdentityForPolicy = Boolean(identityAnchorForPolicy);
      usedToken = `artist-pack:${artistNames.join('|').slice(0, 240)}`;
      debug?.('artist-pack', {
        interests: artistPack.interest_tags ?? [],
        weakTags: artistPack.weak_tags ?? [],
        avoidArtists: artistPack.avoid_artists ?? [],
        pickedArtists: artistCandidates,
      });
      debug?.('query-source', { mode: 'artist-pack', count: searchQueries.length });
      groqTrace = {
        path: 'artist_pack',
        interest_tags: artistPack.interest_tags ?? [],
        weak_tags: artistPack.weak_tags ?? [],
        avoid_artists: artistPack.avoid_artists ?? [],
        artist_candidates: artistNames,
        prePolicyQueries: [...searchQueries],
        usedToken,
      };
    } catch (artistErr) {
      const emptyArtistPack =
        artistErr instanceof Error && artistErr.message === 'empty artist pack queries';
      if (!emptyArtistPack) onGroqCall?.();
      try {
        const struct = await groqNextTrackStruct(effectiveSeed, playedTitles, {
          positiveContext: positiveCtx,
          negativeContext: negativeCtx,
          usedQueries,
          pivotToAnchor,
        });
        onGroqCall?.();
        searchQueries = buildSearchQueriesFromStruct(struct);
        identityAnchorForPolicy = String(struct.identity_anchor ?? '').trim();
        enforceIdentityForPolicy = String(struct.seed_class ?? '').trim() === 'identity';
        const a1 = String(struct.session_anchor.axis_primary ?? '');
        const a2 = String(struct.session_anchor.axis_secondary ?? '');
        const p1 = String(struct.primary_focus.axis_primary ?? '');
        const p2 = String(struct.primary_focus.axis_secondary ?? '');
        usedToken = `blend:${struct.merge_strategy}|a:${a1}/${a2}|p:${p1}/${p2}|id:${String(struct.identity_anchor ?? '').slice(0, 24)}`;
        debug?.('query-source', { mode: 'struct', count: searchQueries.length });
        groqTrace = {
          path: 'struct',
          struct,
          prePolicyQueries: [...searchQueries],
          usedToken,
          artistPackError: artistErr instanceof Error ? artistErr.message : String(artistErr),
        };
      } catch (structErr) {
        onGroqCall?.();
        try {
          const legacyQuery = await groqNextTrackQuery(effectiveSeed, playedTitles, {
            positiveContext: positiveCtx,
            negativeContext: negativeCtx,
            usedQueries,
            pivotToAnchor,
          });
          onGroqCall?.();
          searchQueries = [legacyQuery];
          usedToken = legacyQuery;
          debug?.('query-source', { mode: 'legacy', count: searchQueries.length });
          groqTrace = {
            path: 'legacy',
            query: legacyQuery,
            prePolicyQueries: [...searchQueries],
            usedToken,
            structError: structErr instanceof Error ? structErr.message : String(structErr),
          };
        } catch (queryErr) {
          onGroqCall?.();
          const fallback = specialRetrievalMode
            ? String(effectiveSeed).split('\n')[0].replace(/^[^:]+:\s*/, '').trim()
            : (
              snapshot.lastIntent ??
              snapshot.initialSeed ??
              snapshot.currentPlayingLabel ??
              String(effectiveSeed).split('\n')[0].replace(/^[^:]+:\s*/, '').trim()
            );
          searchQueries = [variantAutoplayQuery(fallback)];
          usedToken = fallback;
          debug?.('query-source', { mode: 'fallback-after-legacy-fail', count: searchQueries.length });
          groqTrace = {
            path: 'fallback_after_legacy',
            query: searchQueries[0],
            prePolicyQueries: [...searchQueries],
            usedToken,
            errors: {
              artistPack: artistErr instanceof Error ? artistErr.message : String(artistErr),
              struct: structErr instanceof Error ? structErr.message : String(structErr),
              query: queryErr instanceof Error ? queryErr.message : String(queryErr),
            },
          };
        }
      }
      }
    } else {
      const fallback = specialRetrievalMode
        ? String(effectiveSeed).split('\n')[0].replace(/^[^:]+:\s*/, '').trim()
        : (
          snapshot.lastIntent ??
          snapshot.initialSeed ??
          String(effectiveSeed).split('\n')[0].replace(/^[^:]+:\s*/, '').trim()
        );
      searchQueries = [variantAutoplayQuery(fallback)];
      usedToken = fallback;
      const mode = isGroqConfigured() ? 'non_groq_median' : 'fallback-no-groq';
      debug?.('query-source', { mode, count: searchQueries.length });
      groqTrace = {
        path: mode,
        prePolicyQueries: [...searchQueries],
        usedToken,
      };
    }
  }

  const strategyQueries = specialRetrievalMode
    ? searchQueries
    : buildStrategyQueries(
      {
        lastIntent: snapshot.lastIntent,
        initialSeed: snapshot.initialSeed,
        topic: snapshot.topic,
      },
      searchQueries,
      effectiveSeed,
    );
  const allQueriesRaw = specialRetrievalMode
    ? strategyQueries
    : (serverHints[0] ? [...strategyQueries, serverHints[0]] : strategyQueries);
  const policy = applyAutoplayQueryPolicy({
    queries: allQueriesRaw,
    recentTitles: playedTitles,
    negativeTitles: negativeCtx,
    usedQueries,
    identityAnchor: enforceIdentityForPolicy
      ? (identityAnchorForPolicy || snapshot.identityIntent || '')
      : '',
  });
  const allQueries = policy.queries;

  debug?.('all-queries', { count: allQueries.length });
  debug?.('policy', policy.meta);

  const allowGroqForTelemetry = shouldAllowGroqAutoplayChain(guildId);
  const recoveryOnlyTelemetry = isRecoveryGroqOnlyEnabled();
  const streakTelemetry = getAutoplayRecoveryStreak(guildId);
  const streakMinTelemetry = recoveryStreakThreshold();
  let querySource;
  let retrievalPath;
  if (fastLanePlan) {
    querySource = `fast_lane:${fastLanePlan.mode}`;
    retrievalPath = querySource;
  } else if (allowGroqForTelemetry && isGroqConfigured()) {
    querySource = recoveryOnlyTelemetry ? 'groq_chain:recovery' : 'groq_chain';
    retrievalPath = recoveryOnlyTelemetry ? 'groq_recovery' : 'groq_default';
  } else {
    querySource = isGroqConfigured() ? 'non_groq_median' : 'no_groq';
    retrievalPath = isGroqConfigured() ? 'non_groq_median' : 'no_groq_config';
  }
  if (escapeMode) {
    querySource = `escape:${querySource}`;
    retrievalPath = `escape:${retrievalPath}`;
  } else if (dFallbackMode) {
    querySource = `d_fallback:${querySource}`;
    retrievalPath = `d_fallback:${retrievalPath}`;
  }
  debug?.('retrieval-path', {
    retrievalPath,
    querySource,
    recoveryGroqOnly: recoveryOnlyTelemetry,
    recoveryStreak: streakTelemetry,
    recoveryStreakMin: streakMinTelemetry,
    escapeMode,
    dFallbackMode,
    escapeFrom: escapeContrastHint?.from ?? null,
    escapeAnchor: escapeContrastHint?.anchor ?? null,
  });

  groqTrace = groqTrace
    ? { ...groqTrace, postPolicyQueries: allQueries, policyMeta: policy.meta ?? null }
    : { path: 'unknown', postPolicyQueries: allQueries, policyMeta: policy.meta ?? null };

  return {
    allQueries,
    usedToken,
    artistCandidates,
    identityAnchorForPolicy,
    enforceIdentityForPolicy,
    policy,
    groqTrace,
    telemetry: {
      querySource,
      retrievalPath,
      recoveryGroqOnly: recoveryOnlyTelemetry,
      recoveryStreak: streakTelemetry,
      recoveryStreakMin: streakMinTelemetry,
    },
  };
}
