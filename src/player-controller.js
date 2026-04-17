/**
 * player-controller.js
 *
 * Единственный владелец `AudioPlayer` и флага `playing` на гильдию.
 * Наружу выставляет узкий read/write API; `AudioPlayer` как объект
 * отдаётся только `voice-adapter`'у через `getPlayer(guildId)` для
 * `connection.subscribe(player)` — всё остальное идёт через имена методов.
 *
 * Жизненный цикл:
 *   client → music.enqueue(...) → ensurePlayer(guildId)
 *     → createAudioPlayer + state регистрация
 *     → registered listeners фаерят {onIdle, onError, onStateChange}
 *   teardown → stopPlayer / destroyPlayer (очистка state)
 *
 * Введён в Шаге 6a плана. В 6b логика handlePlayerIdle вынесена в чистый
 * арбитр `player-idle-verdict.js`; в 6c-b источником истины стал StreamHandle.
 */

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  createAudioPlayer,
} from '@discordjs/voice';

/**
 * @typedef {Object} PlayerControllerCallbacks
 * @property {(guildId: string) => void} [onIdle] — AudioPlayerStatus.Idle
 * @property {(guildId: string, error: Error) => void} [onPlayerError]
 * @property {(guildId: string, mapped: 'Playing'|'Paused'|'AutoPaused'|'Idle'|'Buffering'|null) => void} [onPlayerStateChange]
 */

/** @type {Map<string, import('@discordjs/voice').AudioPlayer>} */
const playerByGuild = new Map();

/** @type {Map<string, boolean>} */
const playingByGuild = new Map();

/** @type {PlayerControllerCallbacks} */
let callbacks = {};

/**
 * Зарегистрировать колбэки плеер-контроллера. Вызывать один раз на старте
 * (обычно из `music.js`/`index.js`). Повторный вызов — shallow merge.
 * @param {PlayerControllerCallbacks} cb
 */
export function registerPlayerControllerCallbacks(cb) {
  callbacks = { ...callbacks, ...(cb ?? {}) };
}

/**
 * @param {import('@discordjs/voice').AudioPlayerState} next
 * @returns {'Playing'|'Paused'|'AutoPaused'|'Idle'|'Buffering'|null}
 */
function mapPlayerStatus(next) {
  switch (next?.status) {
    case AudioPlayerStatus.Playing: return 'Playing';
    case AudioPlayerStatus.Paused: return 'Paused';
    case AudioPlayerStatus.AutoPaused: return 'AutoPaused';
    case AudioPlayerStatus.Idle: return 'Idle';
    case AudioPlayerStatus.Buffering: return 'Buffering';
    default: return null;
  }
}

/**
 * Создать `AudioPlayer` для гильдии, если ещё нет, и подписать его на
 * генерические listener'ы, которые делегируют в registered callbacks.
 *
 * Повторный вызов возвращает уже созданный instance.
 *
 * @param {string} guildId
 * @returns {import('@discordjs/voice').AudioPlayer}
 */
export function ensurePlayer(guildId) {
  const id = String(guildId);
  const existing = playerByGuild.get(id);
  if (existing) return existing;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  playerByGuild.set(id, player);
  playingByGuild.set(id, false);

  player.on(AudioPlayerStatus.Idle, () => {
    try {
      callbacks.onIdle?.(id);
    } catch (e) {
      console.warn('[player-controller] onIdle threw', id, e);
    }
  });
  player.on('error', (e) => {
    try {
      callbacks.onPlayerError?.(id, e);
    } catch (err) {
      console.warn('[player-controller] onPlayerError threw', id, err);
    }
  });
  player.on('stateChange', (_old, next) => {
    const mapped = mapPlayerStatus(next);
    try {
      callbacks.onPlayerStateChange?.(id, mapped);
    } catch (e) {
      console.warn('[player-controller] onPlayerStateChange threw', id, e);
    }
  });

  return player;
}

/**
 * Достать player для гильдии (например, чтобы передать в `conn.subscribe`).
 * Возвращает `null`, если плеер ещё не создан.
 * @param {string} guildId
 * @returns {import('@discordjs/voice').AudioPlayer | null}
 */
export function getPlayer(guildId) {
  return playerByGuild.get(String(guildId)) ?? null;
}

/**
 * Воспроизвести `AudioResource` на плеере гильдии. Флаг `playing` выставляется
 * атомарно здесь — никто снаружи этот флаг не пишет.
 *
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioResource} resource
 * @returns {boolean} `true` если player существует и play() вызван
 */
export function playResource(guildId, resource) {
  const id = String(guildId);
  const p = playerByGuild.get(id);
  if (!p) return false;
  p.play(resource);
  playingByGuild.set(id, true);
  return true;
}

/**
 * Сбросить «ожидает track_finished» флаг без остановки плеера. Используется
 * из `onIdle` callback'а, чтобы отметить, что текущий трек завершён.
 *
 * @param {string} guildId
 */
export function markNotPlaying(guildId) {
  playingByGuild.set(String(guildId), false);
}

/**
 * Пауза текущего трека, если он реально играет (статус Playing).
 * @param {string} guildId
 * @returns {boolean} `true` если пауза применилась
 */
export function pause(guildId) {
  const id = String(guildId);
  const p = playerByGuild.get(id);
  if (!p) return false;
  if (!playingByGuild.get(id)) return false;
  const st = p.state.status;
  if (st === AudioPlayerStatus.Idle) return false;
  if (st === AudioPlayerStatus.Paused || st === AudioPlayerStatus.AutoPaused) return false;
  return p.pause(true);
}

/**
 * Снять паузу, если есть что снимать.
 * @param {string} guildId
 * @returns {boolean} `true` если unpause применился
 */
export function resume(guildId) {
  const id = String(guildId);
  const p = playerByGuild.get(id);
  if (!p) return false;
  if (!playingByGuild.get(id)) return false;
  const st = p.state.status;
  if (st !== AudioPlayerStatus.Paused && st !== AudioPlayerStatus.AutoPaused) return false;
  return p.unpause();
}

/**
 * Полная остановка плеера (как `player.stop(true)`). `playing` обнуляется.
 * @param {string} guildId
 */
export function stopPlayer(guildId) {
  const id = String(guildId);
  const p = playerByGuild.get(id);
  if (p) {
    try {
      p.stop(true);
    } catch {
      /* ignore */
    }
  }
  playingByGuild.set(id, false);
}

/**
 * Полностью уничтожить плеер для гильдии и убрать из registry. Обычно не нужно,
 * но удобно для tear-down / тестов.
 * @param {string} guildId
 */
export function destroyPlayer(guildId) {
  const id = String(guildId);
  const p = playerByGuild.get(id);
  if (p) {
    try {
      p.removeAllListeners();
      p.stop(true);
    } catch {
      /* ignore */
    }
  }
  playerByGuild.delete(id);
  playingByGuild.delete(id);
}

/**
 * «Идёт ли сейчас воспроизведение» — считается с учётом `playing` флага.
 * В Шаге 6a семантика совпадает с legacy `s.playing`; в 6c станет строже
 * (проверка по AudioPlayerStatus).
 *
 * @param {string} guildId
 * @returns {boolean}
 */
export function isPlaying(guildId) {
  return playingByGuild.get(String(guildId)) === true;
}

/**
 * Discord `AudioPlayerStatus` текущего плеера (или null, если плеера нет).
 * Осторожно: этот статус и `isPlaying()` могут коротко расходиться между
 * событиями stateChange и Idle.
 *
 * @param {string} guildId
 * @returns {import('@discordjs/voice').AudioPlayerStatus | null}
 */
export function getStatus(guildId) {
  const p = playerByGuild.get(String(guildId));
  return p ? p.state.status : null;
}

/**
 * Есть ли вообще player для гильдии (создан через `ensurePlayer`).
 * @param {string} guildId
 * @returns {boolean}
 */
export function hasPlayer(guildId) {
  return playerByGuild.has(String(guildId));
}

/**
 * Тестовый хук: полностью обнулить state контроллера.
 * Не использовать в продакшн-коде.
 */
export function __resetPlayerControllerForTests() {
  for (const p of playerByGuild.values()) {
    try { p.removeAllListeners(); p.stop(true); } catch { /* ignore */ }
  }
  playerByGuild.clear();
  playingByGuild.clear();
  callbacks = {};
}
