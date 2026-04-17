/**
 * Проверка модулей без запуска бота:
 * 1) node --check для каждого src/*.js
 * 2) dynamic import всех модулей кроме точек входа (index.js, register-commands.js)
 * 3) смоук-тесты чистых функций (без сети)
 *
 * Запуск: node scripts/verify-modules.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const SKIP_IMPORT = new Set(['index.js', 'register-commands.js']);

function checkSyntax(files) {
  let ok = true;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(SRC, f)], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    if (r.status !== 0) {
      console.error(`[syntax FAIL] ${f}`, r.stderr || r.stdout);
      ok = false;
    }
  }
  return ok;
}

async function importModules(files) {
  let ok = true;
  for (const f of files) {
    if (SKIP_IMPORT.has(f)) {
      console.log(`[import skip] ${f} (entrypoint)`);
      continue;
    }
    const url = pathToFileURL(join(SRC, f)).href;
    try {
      await import(url);
      console.log(`[import OK] ${f}`);
    } catch (e) {
      console.error(`[import FAIL] ${f}`, e?.message ?? e);
      ok = false;
    }
  }
  return ok;
}

async function smokePureFunctions() {
  const { tryNormalizeYoutubeUrl, isAutoplayAltVariantsRelaxed } = await import('../src/youtube-search.js');
  const { extractYoutubeVideoId, sameYoutubeContent } = await import('../src/queue-invariants.js');
  const { formatSingleQueueLine, formatAutoplayQueueLine } = await import(
    '../src/queue-line-format.js',
  );
  const { isGroqConfigured } = await import('../src/groq.js');
  const { createSchedulePlayNext } = await import('../src/playback-schedule.js');
  const { applyAutoplayQueryPolicy } = await import('../src/autoplay-policy.js');
  const { isAutoplayBaselineLogEnabled } = await import('../src/autoplay-baseline.js');
  const {
    isPlayabilityCacheShadowEnabled,
    isPlayabilityHardSkipEnabled,
    playabilityCanonicalKey,
  } = await import('../src/playability-cache.js');
  const {
    isFastLaneEnabled,
    isVarietyBudget7030Experimental,
    tryBuildFastLaneRetrievalPlan,
  } = await import('../src/retrieval-plan.js');
  const { rankAutoplayCandidates } = await import('../src/candidate-ranker.js');
  const {
    bumpAutoplaySpawnGeneration,
    checkAutoplaySpawnStaleDiscard,
    getAutoplaySpawnGeneration,
    invalidateAutoplaySpawn,
    isAutoplayStaleGuardEnabled,
    isAutoplaySpawnStaleToken,
  } = await import('../src/autoplay-stale-guard.js');
  const {
    getAutoplayRecoveryStreak,
    isRecoveryGroqOnlyEnabled,
    recordAutoplaySpawnBadOutcome,
    recordAutoplaySpawnSuccess,
    shouldAllowGroqAutoplayChain,
  } = await import('../src/autoplay-recovery.js');
  const {
    clearVarietyState,
    computeVarietyRankPenalty,
    isVarietyControllerEnabled,
    recordVarietyStateAfterSpawn,
  } = await import('../src/autoplay-variety.js');
  const { detectDominantArtist, extractLeadArtistTokenFromTitle } = await import('../src/autoplay-artist-tokens.js');
  const {
    classifyPreviousRuntimeMode,
    computeIdlePreviousStep,
    resolveIdleSkipTailStep,
    selectPreviousBranch,
  } = await import('../src/idle-navigation-state-machine.js');
  const {
    executeIdlePreviousMachine,
    executeLivePreviousMachine,
    executeSkipPreStopMachine,
  } = await import('../src/idle-navigation-machine-api.js');
  const {
    clearIdleNavigationState,
    consumeSuppressHistoryPush,
    deleteIdleBackForwardTail,
    getIdleBackForwardTail,
    getIdleNavCursor,
    getSessionPlayedWatchUrls,
    setIdleBackForwardTail,
    setIdleNavCursor,
    setPastTrackUrls,
    setSessionPlayedWatchUrls,
  } = await import('../src/idle-navigation-state.js');

  const tests = [];
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  tryNormalizeYoutubeUrl('https://youtu.be/dQw4w9WgXcQ');
  assert(
    tryNormalizeYoutubeUrl('https://youtu.be/dQw4w9WgXcQ') === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'tryNormalizeYoutubeUrl youtu.be',
  );
  assert(isAutoplayAltVariantsRelaxed() === false, 'alt variants relaxed default off');
  const prevAltVar = process.env.AUTOPLAY_ALT_VARIANTS_RELAXED;
  process.env.AUTOPLAY_ALT_VARIANTS_RELAXED = '1';
  assert(isAutoplayAltVariantsRelaxed() === true, 'alt variants relaxed on');
  if (prevAltVar === undefined) delete process.env.AUTOPLAY_ALT_VARIANTS_RELAXED;
  else process.env.AUTOPLAY_ALT_VARIANTS_RELAXED = prevAltVar;
  assert(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'extract id');
  assert(sameYoutubeContent('https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'same content');
  assert(formatSingleQueueLine('x').includes('x'), 'formatSingle');
  assert(typeof isGroqConfigured() === 'boolean', 'isGroqConfigured');

  let calls = 0;
  const sched = createSchedulePlayNext(async () => {
    calls++;
  });
  await sched('g1', 'test');
  await new Promise((r) => setTimeout(r, 30));
  assert(calls === 1, 'schedulePlayNext runs once');

  const pol = applyAutoplayQueryPolicy({ queries: ['alpha test one', 'beta test two'] });
  assert(Array.isArray(pol.queries) && pol.queries.length === 2, 'autoplay-policy');
  assert(isAutoplayBaselineLogEnabled() === false, 'autoplay-baseline default off');
  assert(isPlayabilityCacheShadowEnabled() === false, 'playability-cache shadow default off');
  assert(isPlayabilityHardSkipEnabled() === false, 'playability-cache hard skip default off');
  assert(isFastLaneEnabled() === false, 'fast lane default off');
  assert(isVarietyBudget7030Experimental() === false, 'variety 70/30 experimental default off');
  assert(isVarietyControllerEnabled() === false, 'variety controller default off');
  const prevVarCtl = process.env.AUTOPLAY_VARIETY_CONTROLLER_ENABLED;
  process.env.AUTOPLAY_VARIETY_CONTROLLER_ENABLED = '1';
  assert(isVarietyControllerEnabled() === true, 'variety controller on');
  const vg = 'verify-variety-guild';
  assert(computeVarietyRankPenalty(vg, 'Alpha Artist - Track One').penalty === 0, 'variety no history');
  recordVarietyStateAfterSpawn(vg, {
    pickedTitle: 'Alpha Artist - A',
    telemetry: { querySource: 'fast_lane:stable_continue' },
    firstQuery: 'alpha official audio',
  });
  recordVarietyStateAfterSpawn(vg, {
    pickedTitle: 'Alpha Artist - B',
    telemetry: { querySource: 'fast_lane:stable_continue' },
    firstQuery: 'alpha official audio',
  });
  assert(computeVarietyRankPenalty(vg, 'Alpha Artist - C').penalty > 0, 'variety repeat artist');
  clearVarietyState(vg);
  assert(computeVarietyRankPenalty(vg, 'Alpha Artist - C').penalty === 0, 'variety cleared');
  if (prevVarCtl === undefined) delete process.env.AUTOPLAY_VARIETY_CONTROLLER_ENABLED;
  else process.env.AUTOPLAY_VARIETY_CONTROLLER_ENABLED = prevVarCtl;

  assert(
    extractLeadArtistTokenFromTitle('Test Artist - Song Title') === 'test artist',
    'lead artist token',
  );
  assert(detectDominantArtist(['X - a', 'X - b', 'X - c'])?.artist === 'x', 'dominant artist');
  const prevMode = classifyPreviousRuntimeMode({ status: 'idle', playing: false, queueLength: 0 });
  assert(prevMode.endedAll === true && prevMode.playingOrPaused === false, 'state machine runtime mode idle');
  assert(
    selectPreviousBranch({ endedAll: true, playingOrPaused: false, stackLength: 0 }) === 'idle',
    'state machine branch idle',
  );
  assert(
    selectPreviousBranch({ endedAll: false, playingOrPaused: true, stackLength: 2 }) === 'live',
    'state machine branch live',
  );
  assert(
    selectPreviousBranch({ endedAll: false, playingOrPaused: false, stackLength: 99 }) === 'none',
    'state machine branch none',
  );
  const prevStep = computeIdlePreviousStep({
    hist: ['u1', 'u2', 'u3'],
    rawCursor: undefined,
    currentUrl: 'ucur',
  });
  assert(prevStep.ok && prevStep.prevCursor === 2 && prevStep.prevUrl === 'u3', 'state machine idle previous step');
  const prevStepFail = computeIdlePreviousStep({
    hist: [],
    rawCursor: undefined,
    currentUrl: 'ucur',
  });
  assert(prevStepFail.ok === false, 'state machine idle previous step fail on empty hist');
  const skipTailSelfLoop = resolveIdleSkipTailStep({
    tail: 'https://youtu.be/dQw4w9WgXcQ',
    hist: ['h1', 'h2'],
    cursor: 0,
    currentUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    sameYoutubeContent,
  });
  assert(
    skipTailSelfLoop.action === 'drop' && skipTailSelfLoop.reason === 'self_loop_same_as_current',
    'state machine skip self-loop drop',
  );
  const skipTailExhausted = resolveIdleSkipTailStep({
    tail: 'tail-ok',
    hist: ['h1'],
    cursor: 0,
    currentUrl: '',
    sameYoutubeContent,
  });
  assert(
    skipTailExhausted.action === 'drop' && skipTailExhausted.reason === 'cursor_exhausted',
    'state machine skip cursor exhausted drop',
  );
  const skipTailAdvance = resolveIdleSkipTailStep({
    tail: 'tail-ok',
    hist: ['h1', 'h2', 'h3'],
    cursor: 0,
    currentUrl: '',
    sameYoutubeContent,
  });
  assert(
    skipTailAdvance.action === 'enqueue' && skipTailAdvance.nextCursor === 1 && skipTailAdvance.nextTail === 'h2',
    'state machine skip enqueue advance',
  );
  const machineGuild = 'verify-idle-machine';
  clearIdleNavigationState(machineGuild);
  const qm = await import('../src/queue-manager.js');
  qm.clearQueue(machineGuild);
  setSessionPlayedWatchUrls(machineGuild, ['u1', 'u2', 'u3']);
  const idlePrevMachine = executeIdlePreviousMachine({
    guildId: machineGuild,
    queue: qm.getQueueOps(machineGuild),
    currentUrl: 'cur-url',
  });
  assert(idlePrevMachine.ok === true && idlePrevMachine.inserted === true, 'machine api idle previous');
  assert(getIdleNavCursor(machineGuild) === 2, 'machine api idle previous cursor set');
  assert(getIdleBackForwardTail(machineGuild) === 'cur-url', 'machine api idle previous tail set');
  deleteIdleBackForwardTail(machineGuild);
  setIdleBackForwardTail(machineGuild, 'https://youtu.be/dQw4w9WgXcQ');
  setSessionPlayedWatchUrls(machineGuild, ['h1', 'h2']);
  setIdleNavCursor(machineGuild, 0);
  qm.clearQueue(machineGuild);
  qm.enqueueTrack(machineGuild, { url: 'q1', source: 'single' });
  executeSkipPreStopMachine({
    guildId: machineGuild,
    queue: qm.getQueueOps(machineGuild),
    repeatEnabled: true,
    tail: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    currentUrl: 'https://youtu.be/dQw4w9WgXcQ',
    sameYoutubeContent,
  });
  assert(getIdleBackForwardTail(machineGuild) === undefined, 'machine api skip tail dropped on self-loop');
  qm.clearQueue(machineGuild);
  const headItem = { url: 'head', source: 'single' };
  qm.enqueueTrack(machineGuild, headItem);
  setPastTrackUrls(machineGuild, ['p1', 'p2']);
  const livePrevMachine = executeLivePreviousMachine({
    guildId: machineGuild,
    queue: qm.getQueueOps(machineGuild),
    currentUrl: 'cur-live',
    currentOrigItem: headItem,
  });
  assert(livePrevMachine.ok === true, 'machine api live previous ok');
  const liveSnapshot = qm.getQueueSnapshot(machineGuild);
  assert(liveSnapshot[0]?.url === 'p2' && liveSnapshot[1]?.url === 'cur-live', 'machine api live queue rewired');
  assert(consumeSuppressHistoryPush(machineGuild) === true, 'machine api marks suppress history push');
  clearIdleNavigationState(machineGuild);
  const prevFast = process.env.AUTOPLAY_FAST_LANE_ENABLED;
  process.env.AUTOPLAY_FAST_LANE_ENABLED = '1';
  const fastPlan = tryBuildFastLaneRetrievalPlan({
    pivotToAnchor: false,
    lastIntent: 'test artist',
    initialSeed: null,
    topic: null,
    lastPlayedTitle: 'test artist - song',
    effectiveSeed: 'test',
    alternateStreak: 0,
  });
  assert(fastPlan && fastPlan.mode === 'stable_continue' && fastPlan.searchQueries.length >= 1, 'fast lane plan');
  const { pickAutoplayRetrieval } = await import('../src/autoplay-engine.js');
  const enginePick = await pickAutoplayRetrieval(
    {
      guildId: 'g1',
      effectiveSeed: 'seed',
      pivotToAnchor: false,
      playedTitles: [],
      positiveCtx: [],
      negativeCtx: [],
      usedQueries: [],
      lastIntent: 'test band',
      initialSeed: null,
      topic: null,
      identityIntent: null,
      sessionTitlesForFast: ['Artist - Title'],
      alternateStreakFast: 0,
      currentPlayingLabel: null,
      serverHints: [],
    },
    { debug: () => {} },
  );
  assert(
    Array.isArray(enginePick.allQueries) && enginePick.allQueries.length >= 1,
    'autoplay-engine pickAutoplayRetrieval',
  );
  assert(
    tryBuildFastLaneRetrievalPlan({
      pivotToAnchor: true,
      lastIntent: 'x',
      initialSeed: null,
      topic: null,
      lastPlayedTitle: null,
      effectiveSeed: 'x',
      alternateStreak: 0,
    }) === null,
    'fast lane skips on pivot',
  );
  const ranked = rankAutoplayCandidates(
    [
      { title: 'bad', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', _debug: { searchScore: 120 } },
      { title: 'good', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', _debug: { searchScore: 10 } },
    ],
    {
      isMarkedBad: (url) => /aaaaaaaaaaa/.test(url),
      isRecentBlocked: () => false,
      isArtistCooldownBlocked: () => false,
    },
  );
  assert(ranked[0]?.url?.includes('bbbbbbbbbbb'), 'candidate-ranker rejects bad first');
  if (prevFast === undefined) delete process.env.AUTOPLAY_FAST_LANE_ENABLED;
  else process.env.AUTOPLAY_FAST_LANE_ENABLED = prevFast;
  assert(
    playabilityCanonicalKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'youtube:dQw4w9WgXcQ',
    'playability key vid',
  );

  const sgGuild = 'verify-stale-guard';
  assert(getAutoplaySpawnGeneration(sgGuild) === 0, 'spawn gen default 0');
  const sgTok = bumpAutoplaySpawnGeneration(sgGuild);
  assert(sgTok === 1 && getAutoplaySpawnGeneration(sgGuild) === 1, 'spawn gen bump');
  assert(!isAutoplaySpawnStaleToken(sgGuild, sgTok), 'spawn gen not stale');
  invalidateAutoplaySpawn(sgGuild);
  assert(isAutoplaySpawnStaleToken(sgGuild, sgTok), 'spawn gen stale after invalidate');
  assert(isAutoplayStaleGuardEnabled() === true, 'stale guard default on');

  const sdGuild = 'verify-stale-discard';
  const sdTok = bumpAutoplaySpawnGeneration(sdGuild);
  const mockCtxOk = {
    isConnectionAlive: (gid) => gid === sdGuild,
    isPlaying: () => false,
    hasAutoplay: (gid) => gid === sdGuild,
    getQueueLength: () => 0,
  };
  assert(
    checkAutoplaySpawnStaleDiscard(sdGuild, sdTok, 'smoke', mockCtxOk) === null,
    'stale discard passes when idle',
  );
  invalidateAutoplaySpawn(sdGuild);
  assert(
    checkAutoplaySpawnStaleDiscard(sdGuild, sdTok, 'smoke', mockCtxOk) === 'generation',
    'stale discard on gen bump',
  );

  const rg = 'verify-recovery';
  assert(isRecoveryGroqOnlyEnabled() === false, 'recovery groq-only default off');
  assert(shouldAllowGroqAutoplayChain(rg) === true, 'groq chain allowed when recovery-only off');
  const prevRec = process.env.AUTOPLAY_RECOVERY_GROQ_ONLY;
  const prevMin = process.env.AUTOPLAY_RECOVERY_STREAK_MIN;
  process.env.AUTOPLAY_RECOVERY_GROQ_ONLY = '1';
  process.env.AUTOPLAY_RECOVERY_STREAK_MIN = '2';
  assert(shouldAllowGroqAutoplayChain(rg) === false, 'groq blocked streak 0 under recovery-only');
  recordAutoplaySpawnBadOutcome(rg);
  assert(shouldAllowGroqAutoplayChain(rg) === false, 'groq blocked streak 1');
  recordAutoplaySpawnBadOutcome(rg);
  assert(getAutoplayRecoveryStreak(rg) === 2, 'recovery streak bump');
  assert(shouldAllowGroqAutoplayChain(rg) === true, 'groq after streak threshold');
  recordAutoplaySpawnSuccess(rg);
  assert(getAutoplayRecoveryStreak(rg) === 0, 'recovery reset on success');
  if (prevRec === undefined) delete process.env.AUTOPLAY_RECOVERY_GROQ_ONLY;
  else process.env.AUTOPLAY_RECOVERY_GROQ_ONLY = prevRec;
  if (prevMin === undefined) delete process.env.AUTOPLAY_RECOVERY_STREAK_MIN;
  else process.env.AUTOPLAY_RECOVERY_STREAK_MIN = prevMin;

  tests.push('youtube-search tryNormalizeUrl + alt relaxed');
  tests.push('queue-invariants extract/same');
  tests.push('queue-line-format');
  tests.push('groq isGroqConfigured');
  tests.push('playback-schedule one job');
  tests.push('autoplay-policy applyAutoplayQueryPolicy');
  tests.push('autoplay-baseline import');
  tests.push('playability-cache key');
  tests.push('retrieval-plan fast lane');
  tests.push('autoplay-engine pick');
  tests.push('candidate-ranker guards');
  tests.push('autoplay-stale-guard');
  tests.push('autoplay-recovery');
  tests.push('autoplay-variety');
  tests.push('autoplay-artist-tokens');
  tests.push('idle-navigation-state-machine transitions');
  tests.push('idle-navigation-machine-api transitions');

  // voice-adapter smoke: пустой state + leave фаерит onVoiceGone
  const va = await import('../src/voice-adapter.js');
  va.__resetVoiceAdapterForTests();
  assert(va.getConnection('smoke-g') === null, 'voice-adapter getConnection null default');
  assert(va.isConnectionAlive('smoke-g') === false, 'voice-adapter isConnectionAlive false default');
  assert(va.getConnectedChannelId('smoke-g') === null, 'voice-adapter getConnectedChannelId null default');
  const vaSeen = [];
  va.registerVoiceAdapterCallbacks({ onVoiceGone: (id, reason) => vaSeen.push([id, reason]) });
  va.leave('smoke-g');
  assert(
    vaSeen.length === 1 && vaSeen[0][0] === 'smoke-g' && vaSeen[0][1] === 'user_leave',
    'voice-adapter leave fires onVoiceGone even with empty registry',
  );
  va.__resetVoiceAdapterForTests();
  tests.push('voice-adapter registry + leave');

  // player-controller smoke: пустой state + ensurePlayer + колбэки
  const pc = await import('../src/player-controller.js');
  const { AudioPlayerStatus: APS } = await import('@discordjs/voice');
  pc.__resetPlayerControllerForTests();
  assert(pc.hasPlayer('smoke-pc') === false, 'player-controller hasPlayer false default');
  assert(pc.getPlayer('smoke-pc') === null, 'player-controller getPlayer null default');
  assert(pc.getStatus('smoke-pc') === null, 'player-controller getStatus null default');
  assert(pc.isPlaying('smoke-pc') === false, 'player-controller isPlaying false default');
  const pcSeen = [];
  pc.registerPlayerControllerCallbacks({
    onIdle: (id) => pcSeen.push(['idle', id]),
    onPlayerError: (id) => pcSeen.push(['err', id]),
    onPlayerStateChange: (id, m) => pcSeen.push(['sc', id, m]),
  });
  const smokePlayer = pc.ensurePlayer('smoke-pc');
  assert(pc.hasPlayer('smoke-pc') === true, 'player-controller ensurePlayer registers');
  assert(pc.ensurePlayer('smoke-pc') === smokePlayer, 'player-controller ensurePlayer idempotent');
  smokePlayer.emit(APS.Idle);
  smokePlayer.emit('error', new Error('x'));
  smokePlayer.emit('stateChange', { status: APS.Idle }, { status: APS.Playing });
  assert(pcSeen.length === 3, 'player-controller emits registered callbacks');
  assert(pcSeen[0][0] === 'idle' && pcSeen[0][1] === 'smoke-pc', 'player-controller onIdle wired');
  assert(pcSeen[1][0] === 'err', 'player-controller onPlayerError wired');
  assert(pcSeen[2][0] === 'sc' && pcSeen[2][2] === 'Playing', 'player-controller onPlayerStateChange maps to domain string');
  pc.__resetPlayerControllerForTests();
  tests.push('player-controller registry + callbacks');

  // orchestrator.events: onVoiceReady/onVoiceGone должны трогать сессию
  const orch = await import('../src/orchestrator.js');
  const gss = await import('../src/guild-session-state.js');
  const smokeOrchGuild = 'smoke-orchestrator';
  gss.endSession(smokeOrchGuild);
  orch.events.onVoiceReady(smokeOrchGuild, '42');
  assert(typeof gss.getSessionId(smokeOrchGuild) === 'string', 'orchestrator.events.onVoiceReady starts session');
  const snap1 = gss.getGuildSessionSnapshot(smokeOrchGuild);
  assert(snap1?.botConnected === true, 'orchestrator.events.onVoiceReady sets botConnected=true');
  assert(snap1?.voiceChannelId === '42', 'orchestrator.events.onVoiceReady sets voiceChannelId');
  orch.events.onVoiceGone(smokeOrchGuild, 'user_leave');
  assert(gss.getSessionId(smokeOrchGuild) === null, 'orchestrator.events.onVoiceGone ends session');
  const snap2 = gss.getGuildSessionSnapshot(smokeOrchGuild);
  assert(snap2?.botConnected === false, 'orchestrator.events.onVoiceGone sets botConnected=false');
  tests.push('orchestrator.events voice lifecycle');

  // player-idle-verdict smoke: проверяем ключевые решения арбитра
  const piv = await import('../src/player-idle-verdict.js');
  const vIgnore = piv.resolveIdleVerdict({ wasPlaying: false, streamFailed: true, suppressFinished: true, repeatOn: true });
  assert(vIgnore.ignore === true && vIgnore.scheduleNext === false, 'player-idle-verdict !wasPlaying → ignore');
  const vNatural = piv.resolveIdleVerdict({ wasPlaying: true, streamFailed: false, suppressFinished: false, repeatOn: false });
  assert(vNatural.emitTrackFinished === true && vNatural.forceSkipFromQueue === false, 'player-idle-verdict natural finish');
  const vSkipSuppressedRepeat = piv.resolveIdleVerdict({ wasPlaying: true, streamFailed: false, suppressFinished: true, repeatOn: true });
  assert(vSkipSuppressedRepeat.emitTrackFinished === false, 'player-idle-verdict skip_suppressed не emit track_finished');
  assert(vSkipSuppressedRepeat.forceSkipFromQueue === false, 'player-idle-verdict skip_suppressed+repeat: НЕТ double-shift');
  const vStreamRepeat = piv.resolveIdleVerdict({ wasPlaying: true, streamFailed: true, suppressFinished: false, repeatOn: true });
  assert(vStreamRepeat.forceSkipFromQueue === true, 'player-idle-verdict stream_error+repeat: force-skip от петли');
  const vStreamNoRepeat = piv.resolveIdleVerdict({ wasPlaying: true, streamFailed: true, suppressFinished: false, repeatOn: false });
  assert(vStreamNoRepeat.forceSkipFromQueue === false, 'player-idle-verdict stream_error без repeat: runPlayNext двигает очередь');
  tests.push('player-idle-verdict arbiter');

  // orchestrator.commands shape (Шаг 7): проверяем что все 8 команд на месте
  // и базовые invalid-argument ветки возвращают Err с ожидаемым code. Реальная
  // доменная логика (skip, previousTrack, ...) тестируется в *.test.js.
  const expectedCmds = [
    'enqueue',
    'skip',
    'previousTrack',
    'pause',
    'resume',
    'toggleRepeat',
    'toggleAutoplay',
    'stopAndLeave',
  ];
  for (const k of expectedCmds) {
    assert(typeof orch.commands[k] === 'function', `orchestrator.commands.${k} должен быть функцией`);
  }
  assert(Object.isFrozen(orch.commands), 'orchestrator.commands заморожен');
  const rNullSkip = orch.commands.skip(null);
  assert(rNullSkip.ok === false && rNullSkip.code === 'invalid_argument', 'commands.skip(null) → invalid_argument');
  const rNullStop = orch.commands.stopAndLeave(null);
  assert(rNullStop.ok === false && rNullStop.code === 'invalid_argument', 'commands.stopAndLeave(null) → invalid_argument');
  const rBadEnqueue = await orch.commands.enqueue(null);
  assert(rBadEnqueue.ok === false && rBadEnqueue.code === 'invalid_argument', 'commands.enqueue(null) → invalid_argument');
  const freshToggleGuild = `smoke-orch-toggle-${Date.now()}`;
  const rToggle1 = orch.commands.toggleRepeat(freshToggleGuild);
  assert(rToggle1.ok === true && rToggle1.value.enabled === true, 'commands.toggleRepeat первый раз → enabled=true');
  const rToggle2 = orch.commands.toggleRepeat(freshToggleGuild);
  assert(rToggle2.ok === true && rToggle2.value.enabled === false, 'commands.toggleRepeat второй раз → enabled=false');
  const rStopOk = orch.commands.stopAndLeave(freshToggleGuild);
  assert(rStopOk.ok === true, 'commands.stopAndLeave живой guildId → Ok');
  tests.push('orchestrator.commands shape');

  // autoplay-spawn factory shape (Шаг 8): фабрика + экспорт isYoutubeUrlBlockedForAutoplaySpawns.
  // Полный e2e spawn требует Groq/YouTube mocks и живёт в *.test.js + telemetry-логах.
  const autoSpawn = await import('../src/autoplay-spawn.js');
  assert(typeof autoSpawn.createAutoplaySpawner === 'function', 'createAutoplaySpawner export');
  assert(typeof autoSpawn.isYoutubeUrlBlockedForAutoplaySpawns === 'function', 'isYoutubeUrlBlockedForAutoplaySpawns export');
  assert(typeof autoSpawn.createAutoplaySpawnStaleGuard === 'function', 'createAutoplaySpawnStaleGuard export');
  let threw = false;
  try { autoSpawn.createAutoplaySpawner({}); } catch { threw = true; }
  assert(threw === true, 'createAutoplaySpawner({}) должен бросить invalid deps');
  const spawnerSmoke = autoSpawn.createAutoplaySpawner({
    notifyPlaybackUiRefresh: () => {},
    getOnAutoplaySpawned: () => null,
  });
  assert(typeof spawnerSmoke.spawnAutoplayPlaylist === 'function', 'spawner.spawnAutoplayPlaylist function');
  assert(Object.isFrozen(spawnerSmoke), 'spawner frozen');
  assert(autoSpawn.isYoutubeUrlBlockedForAutoplaySpawns(null, 'x') === false, 'null guildId → unblocked');
  tests.push('autoplay-spawn factory shape');

  // playback-loop public API (Шаг 10): ядро плеера вынесено из music.js.
  // Проверяем, что public-контракт стабилен: accessors per-guild state + setters колбэков.
  const playbackLoop = await import('../src/playback-loop.js');
  assert(typeof playbackLoop.ensureGuildMusicState === 'function', 'ensureGuildMusicState export');
  assert(typeof playbackLoop.getGuildMusicState === 'function', 'getGuildMusicState export');
  assert(typeof playbackLoop.killYtdlp === 'function', 'killYtdlp export');
  assert(typeof playbackLoop.schedulePlayNext === 'function', 'schedulePlayNext export');
  assert(typeof playbackLoop.setOnPlaybackUiRefresh === 'function', 'setOnPlaybackUiRefresh export');
  assert(typeof playbackLoop.setOnPlayingTrackDisplay === 'function', 'setOnPlayingTrackDisplay export');
  assert(typeof playbackLoop.setOnPlaybackIdle === 'function', 'setOnPlaybackIdle export');
  assert(typeof playbackLoop.setOnAutoplaySpawned === 'function', 'setOnAutoplaySpawned export');
  // getGuildMusicState читает без создания; для несуществующей гильдии → undefined.
  assert(playbackLoop.getGuildMusicState('__smoke_nonexistent__') === undefined, 'getGuildMusicState undefined for unknown guild');
  // killYtdlp идемпотентен на null/undefined (tear-down defensive).
  playbackLoop.killYtdlp(null);
  playbackLoop.killYtdlp(undefined);
  tests.push('playback-loop public API');

  console.log(`[smoke OK] ${tests.length} groups: ${tests.join(', ')}`);
  return true;
}

const files = readdirSync(SRC).filter((n) => n.endsWith('.js')).sort();

let allOk = true;
if (!checkSyntax(files)) allOk = false;

const importOk = await importModules(files);
if (!importOk) allOk = false;

if (allOk) {
  try {
    await smokePureFunctions();
  } catch (e) {
    console.error('[smoke FAIL]', e?.message ?? e);
    allOk = false;
  }
}

if (!allOk) {
  process.exit(1);
}
console.log('\nverify-modules: ALL CHECKS PASSED');
