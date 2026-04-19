/**
 * Escape retrieval helpers.
 *
 * Keeps two concerns narrow and testable:
 * - deriving a compact contrastHint from basin evidence
 * - converting an active escape snapshot into a retrieval override without
 *   mutating the normal autoplay path
 */

/**
 * @typedef {{ from: 'same_spawn' | 'same_family', anchor: string | null }} AutoplayEscapeContrastHint
 */

/**
 * @param {import('./autoplay-basin-detection.js').AutoplayBasinDecision | null | undefined} decision
 * @returns {AutoplayEscapeContrastHint | null}
 */
export function buildAutoplayEscapeContrastHint(decision) {
  if (!decision?.basin || !decision.kind) return null;
  if (decision.kind === 'same_spawn') {
    return {
      from: 'same_spawn',
      anchor: decision.evidence?.matchedSpawnId ?? null,
    };
  }
  if (decision.kind === 'same_family') {
    return {
      from: 'same_family',
      anchor: decision.evidence?.matchedQueryFamily ?? null,
    };
  }
  return null;
}

function buildContrastPrompt({ contrastHint, seedQuery, currentPlayingLabel }) {
  const current = String(currentPlayingLabel ?? seedQuery ?? '').trim();
  const subject = current || 'the recent autoplay basin';
  if (contrastHint?.from === 'same_family' && contrastHint.anchor) {
    return (
      `Escape mode: the last quick-skips stayed inside the same query-family basin (${contrastHint.anchor}). ` +
      `Do NOT continue from the same family or current-track pivot. Move away from "${subject}" into a clearly different direction, ` +
      `with a different performer cluster, scene neighbourhood, or energy profile, while still sounding plausible for a shared listening session.`
    );
  }
  return (
    `Escape mode: the last quick-skips came from the same generated autoplay basin. ` +
    `Do NOT continue from the current-track pivot or the same performer cluster around "${subject}". ` +
    `Choose a clearly different but still musically coherent next direction for shared listening, not random novelty.`
  );
}

function buildDFallbackPrompt({ seedQuery, currentPlayingLabel }) {
  const subject = String(currentPlayingLabel ?? seedQuery ?? '').trim() || 'the recent autoplay basin';
  return (
    `D fallback mode: the first escape attempt was rejected immediately. ` +
    `Do NOT continue from the same basin around "${subject}", do NOT reuse the same performer cluster, ` +
    `and do NOT follow the previous session anchor. Choose one clearly different but still musically coherent direction for shared listening.`
  );
}

/**
 * @param {string | null | undefined} phase
 * @returns {boolean}
 */
export function isAutoplayEscapeContrastActivePhase(phase) {
  return phase === 'trial' || phase === 'provisional';
}

/**
 * @param {{
 *   escapeSnapshot?: { phase?: string | null, contrastHint?: AutoplayEscapeContrastHint | null } | null,
 *   seedQuery: string,
 *   currentPlayingLabel?: string | null,
 *   effectiveSeed: string,
 *   pivotToAnchor: boolean,
 *   lastIntent?: string | null,
 *   initialSeed?: string | null,
 *   topic?: string | null,
 *   identityIntent?: string | null,
 *   currentPlayingLabelForRetrieval?: string | null,
 *   useDFallback?: boolean,
 * }} input
 */
export function resolveAutoplayEscapeRetrievalOverride(input) {
  if (input.useDFallback) {
    return {
      mode: 'd_fallback',
      effectiveSeed: buildDFallbackPrompt({
        seedQuery: input.seedQuery,
        currentPlayingLabel: input.currentPlayingLabel,
      }),
      pivotToAnchor: false,
      lastIntent: null,
      initialSeed: null,
      topic: null,
      identityIntent: null,
      currentPlayingLabel: null,
      escapeContrastHint: null,
      dFallbackPrompt: buildDFallbackPrompt({
        seedQuery: input.seedQuery,
        currentPlayingLabel: input.currentPlayingLabel,
      }),
    };
  }

  const escapeSnapshot = input.escapeSnapshot ?? null;
  const contrastHint = escapeSnapshot?.contrastHint ?? null;
  if (!isAutoplayEscapeContrastActivePhase(escapeSnapshot?.phase) || !contrastHint) {
    return {
      mode: 'normal',
      effectiveSeed: input.effectiveSeed,
      pivotToAnchor: input.pivotToAnchor,
      lastIntent: input.lastIntent ?? null,
      initialSeed: input.initialSeed ?? null,
      topic: input.topic ?? null,
      identityIntent: input.identityIntent ?? null,
      currentPlayingLabel: input.currentPlayingLabelForRetrieval ?? null,
      escapeContrastHint: null,
      dFallbackPrompt: null,
    };
  }

  return {
    mode: 'escape',
    effectiveSeed: buildContrastPrompt({
      contrastHint,
      seedQuery: input.seedQuery,
      currentPlayingLabel: input.currentPlayingLabel,
    }),
    pivotToAnchor: false,
    lastIntent: null,
    initialSeed: null,
    topic: null,
    identityIntent: null,
    currentPlayingLabel: null,
    escapeContrastHint: contrastHint,
    dFallbackPrompt: null,
  };
}
