/**
 * Pure arbiter для реакции на AudioPlayerStatus.Idle.
 *
 * Извлечён из `music.js::handlePlayerIdle` в рамках Шага 6b. Чистая функция без побочек:
 * на вход — snapshot входов на момент Idle, на выход — набор директив для
 * тонкого диспатчера side-effects в `music.js`.
 *
 * Поведение ПОЛНОСТЬЮ соответствует logic'у `handlePlayerIdle` до 6b (перенос 1:1).
 * Семантика «почему Idle» через StreamHandle.EndReason разводится в 6c.
 *
 * Правило чистоты: все входы — snapshot на момент Idle. Любые consuming-read'ы
 * (в первую очередь `consumeSuppressTrackFinishedOnce`) выполняются в вызывающем
 * коде ДО вызова `resolveIdleVerdict` и передаются сюда как plain booleans.
 *
 * Разграничение обязанностей с pre-stop step (ручная навигация):
 *   - При `skip()` / `previousTrack()` фиксация «мы уходим с этого трека, не
 *     repeat'им его» делается заранее (`executeSkipPreStopMachine` →
 *     `applySkipRepeatHeadShift` / `applyRepeatPreviousRestart`).
 *     К моменту Idle голова очереди уже сдвинута там, где надо.
 *   - Поэтому здесь `forceSkipFromQueue = true` только при реальном failure потока
 *     (`streamFailed && repeatOn`) — иначе repeat зациклит упавший трек.
 *   - Кейс `suppressFinished && repeatOn` НЕ триггерит forceSkip: иначе двойной shift
 *     (один раз в pre-stop, второй раз здесь) пропустит лишний трек. См. также
 *     docs/БАГИ.md BUG-0001 (skip-then-same-track) — закрыт именно pre-stop шагом.
 */

/**
 * @typedef {Object} IdleInput
 * @property {boolean} wasPlaying       — isPlayerPlaying(id) до markNotPlaying.
 * @property {boolean} streamFailed     — fatal EndReason / pendingFatal от StreamHandle на момент Idle.
 * @property {boolean} suppressFinished — результат consumeSuppressTrackFinishedOnce(id).
 * @property {boolean} repeatOn         — repeatByGuild.has(id).
 */

/**
 * @typedef {Object} IdleVerdict
 * @property {boolean} ignore             — true → handlePlayerIdle выходит сразу (эхо Idle).
 * @property {boolean} emitTrackFinished  — emit сигнала 'track_finished' (natural finish only).
 * @property {boolean} forceSkipFromQueue — shiftIfHead/removeItem текущего item из очереди.
 * @property {boolean} scheduleNext       — schedulePlayNext(id, 'player-idle').
 */

/** @type {IdleVerdict} */
const IGNORE_VERDICT = Object.freeze({
  ignore: true,
  emitTrackFinished: false,
  forceSkipFromQueue: false,
  scheduleNext: false,
});

/**
 * Решает, какие побочки вызывать в ответ на Idle.
 * Pure: одинаковый input → одинаковый verdict, state не читает и не пишет.
 *
 * @param {IdleInput} input
 * @returns {IdleVerdict}
 */
export function resolveIdleVerdict(input) {
  if (!input || !input.wasPlaying) {
    return IGNORE_VERDICT;
  }
  const emitTrackFinished = !input.streamFailed && !input.suppressFinished;
  const forceSkipFromQueue = input.streamFailed && input.repeatOn;
  return {
    ignore: false,
    emitTrackFinished,
    forceSkipFromQueue,
    scheduleNext: true,
  };
}
