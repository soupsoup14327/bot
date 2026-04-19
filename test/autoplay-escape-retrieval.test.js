import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutoplayEscapeContrastHint,
  isAutoplayEscapeContrastActivePhase,
  resolveAutoplayEscapeRetrievalOverride,
} from '../src/autoplay-escape-retrieval.js';

test('buildAutoplayEscapeContrastHint derives a compact hint from basin evidence', () => {
  const hint = buildAutoplayEscapeContrastHint({
    basin: true,
    kind: 'same_family',
    evidence: {
      compared: 2,
      maxWindowMs: 120000,
      matchedQueryFamily: 'darksynth',
    },
  });

  assert.deepEqual(hint, { from: 'same_family', anchor: 'darksynth' });
});

test('resolveAutoplayEscapeRetrievalOverride keeps the normal retrieval path untouched when no branch is active', () => {
  const result = resolveAutoplayEscapeRetrievalOverride({
    escapeSnapshot: { phase: null, contrastHint: null },
    seedQuery: 'Perturbator',
    currentPlayingLabel: 'Perturbator - Venger',
    effectiveSeed: 'Primary focus (STRONG): Perturbator',
    pivotToAnchor: true,
    lastIntent: 'Perturbator',
    initialSeed: 'Darksynth',
    topic: 'Cyberpunk',
    identityIntent: 'Synthwave',
    currentPlayingLabelForRetrieval: 'Perturbator - Venger',
  });

  assert.equal(result.mode, 'normal');
  assert.equal(result.pivotToAnchor, true);
  assert.equal(result.currentPlayingLabel, 'Perturbator - Venger');
  assert.equal(result.escapeContrastHint, null);
});

test('resolveAutoplayEscapeRetrievalOverride builds an escape prompt and disables the normal pivot path', () => {
  const result = resolveAutoplayEscapeRetrievalOverride({
    escapeSnapshot: {
      phase: 'trial',
      contrastHint: { from: 'same_family', anchor: 'darksynth' },
    },
    seedQuery: 'Perturbator',
    currentPlayingLabel: 'Perturbator - Venger',
    effectiveSeed: 'Primary focus (STRONG): Perturbator',
    pivotToAnchor: true,
    lastIntent: 'Perturbator',
    initialSeed: 'Darksynth',
    topic: 'Cyberpunk',
    identityIntent: 'Synthwave',
    currentPlayingLabelForRetrieval: 'Perturbator - Venger',
  });

  assert.equal(result.mode, 'escape');
  assert.equal(result.pivotToAnchor, false);
  assert.equal(result.currentPlayingLabel, null);
  assert.equal(result.lastIntent, null);
  assert.equal(result.initialSeed, null);
  assert.deepEqual(result.escapeContrastHint, { from: 'same_family', anchor: 'darksynth' });
  assert.match(result.effectiveSeed, /Escape mode:/);
  assert.match(result.effectiveSeed, /darksynth/i);
});

test('resolveAutoplayEscapeRetrievalOverride builds a one-shot D-fallback prompt and disables session pivots', () => {
  const result = resolveAutoplayEscapeRetrievalOverride({
    escapeSnapshot: { phase: null, contrastHint: null },
    seedQuery: 'Perturbator',
    currentPlayingLabel: 'Perturbator - Venger',
    effectiveSeed: 'Primary focus (STRONG): Perturbator',
    pivotToAnchor: true,
    lastIntent: 'Perturbator',
    initialSeed: 'Darksynth',
    topic: 'Cyberpunk',
    identityIntent: 'Synthwave',
    currentPlayingLabelForRetrieval: 'Perturbator - Venger',
    useDFallback: true,
  });

  assert.equal(result.mode, 'd_fallback');
  assert.equal(result.pivotToAnchor, false);
  assert.equal(result.currentPlayingLabel, null);
  assert.equal(result.lastIntent, null);
  assert.equal(result.initialSeed, null);
  assert.equal(result.escapeContrastHint, null);
  assert.equal(typeof result.dFallbackPrompt, 'string');
  assert.match(result.effectiveSeed, /D fallback mode:/);
});

test('confirmed phase is no longer considered an active escape retrieval phase', () => {
  assert.equal(isAutoplayEscapeContrastActivePhase('trial'), true);
  assert.equal(isAutoplayEscapeContrastActivePhase('provisional'), true);
  assert.equal(isAutoplayEscapeContrastActivePhase('confirmed'), false);

  const result = resolveAutoplayEscapeRetrievalOverride({
    escapeSnapshot: {
      phase: 'confirmed',
      contrastHint: { from: 'same_family', anchor: 'darksynth' },
    },
    seedQuery: 'Perturbator',
    currentPlayingLabel: 'Perturbator - Venger',
    effectiveSeed: 'Primary focus (STRONG): Perturbator',
    pivotToAnchor: true,
    lastIntent: 'Perturbator',
    initialSeed: 'Darksynth',
    topic: 'Cyberpunk',
    identityIntent: 'Synthwave',
    currentPlayingLabelForRetrieval: 'Perturbator - Venger',
  });

  assert.equal(result.mode, 'normal');
  assert.equal(result.escapeContrastHint, null);
  assert.equal(result.currentPlayingLabel, 'Perturbator - Venger');
});
