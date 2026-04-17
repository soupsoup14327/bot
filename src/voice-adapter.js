/**
 * voice-adapter.js
 *
 * Единственный владелец `VoiceConnection` на гильдию и таймеров auto-leave.
 * Наружу не отдаёт сам объект соединения, кроме узких геттеров. Мутации —
 * только через этот модуль. Внешние клиенты читают состояние через
 * `isConnectionAlive(id)` / `getConnectedChannelId(id)`.
 *
 * Жизненный цикл соединения (happy path):
 *   client → music.enqueue(...) → ensureVoiceConnection(channel, player)
 *     → (если надо) joinVoiceChannel + entersState Ready + subscribe(player)
 *     → Map<guildId, VoiceConnection>
 *     → callbacks.onVoiceReady(guildId, channelId)
 *
 * Уход:
 *   leave(guildId, reason?) — atomic destroy + markGone
 *   stateChange → Disconnected/Destroyed — markGone ('connection_disconnect' / 'connection_destroy')
 *   auto-leave timer — setPendingLeaveReason('timeout') → callbacks.onAutoLeaveTimeout(id)
 *     (который обычно дёргает music.stopAndLeave → teardown → voice-adapter.leave)
 *
 * Фиксит Bug #5 (eternal loading): `ensureVoiceConnection` атомарен — при
 * таймауте Ready мы гарантированно уничтожаем частичное соединение и не
 * записываем его в map, так что внешний мир никогда не видит «есть коннект,
 * но он не Ready».
 */

import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';

/**
 * @typedef {'user_leave' | 'timeout' | 'connection_disconnect' | 'connection_destroy' | 'unknown'} VoiceGoneReason
 */

/**
 * @typedef {Object} VoiceAdapterCallbacks
 * @property {(guildId: string, channelId: string) => void} [onVoiceReady]
 * @property {(guildId: string, reason: VoiceGoneReason) => void} [onVoiceGone]
 * @property {(guildId: string) => void} [onAutoLeaveTimeout]
 */

/** @type {Map<string, import('@discordjs/voice').VoiceConnection>} */
const connectionsByGuild = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const voiceEmptyTimers = new Map();

/**
 * При уходе из канала мы хотим сообщить orchestrator'у причину. Большинство
 * вызовов leave() знают её сразу (explicit user leave → `user_leave`). Для
 * auto-leave путь «timer → callback → music.stopAndLeave → teardown →
 * adapter.leave» длинный, поэтому причина предварительно сохраняется здесь.
 * При markGone() значение считывается и удаляется.
 * @type {Map<string, VoiceGoneReason>}
 */
const pendingLeaveReason = new Map();

/** @type {VoiceAdapterCallbacks} */
let callbacks = {};

/** @type {import('discord.js').Client | null} */
let voiceClient = null;

/**
 * Зарегистрировать колбэки на voice-события. Вызывать ОДИН раз на старте бота
 * из `index.js` (обычно — делегирование в `orchestrator.events.*`).
 * Повторный вызов сливает новые поля поверх старых (shallow merge), что удобно
 * в тестах.
 *
 * @param {VoiceAdapterCallbacks} cb
 */
export function registerVoiceAdapterCallbacks(cb) {
  callbacks = { ...callbacks, ...(cb ?? {}) };
}

/**
 * Получить секунды до авто-выхода (ENV `VOICE_EMPTY_LEAVE_MINUTES`, default 1 мин).
 * @returns {number}
 */
function getVoiceEmptyDelayMs() {
  const mins = Number.parseFloat(process.env.VOICE_EMPTY_LEAVE_MINUTES ?? '1');
  const minutes = Number.isFinite(mins) && mins > 0 ? mins : 1;
  return Math.max(1, minutes) * 60_000;
}

/**
 * Очистить pending auto-leave таймер гильдии (если был).
 * Вызывается из `stopAndLeave` и из логики, где мы заранее знаем,
 * что оставаться в канале — корректно.
 * @param {string} guildId
 */
export function clearAutoLeaveTimer(guildId) {
  const id = String(guildId);
  const t = voiceEmptyTimers.get(id);
  if (t) clearTimeout(t);
  voiceEmptyTimers.delete(id);
}

/**
 * Подписаться на `voiceStateUpdate` клиента Discord, чтобы переоценивать
 * «пусто ли в голосовом канале» и ставить/снимать auto-leave timer.
 *
 * Должно вызываться один раз при старте бота (после создания `Client`).
 *
 * @param {import('discord.js').Client} client
 */
export function attachVoiceAutoLeave(client) {
  voiceClient = client;
  const ms = getVoiceEmptyDelayMs();

  client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;
    void checkVoiceChannelEmpty(guild, ms);
  });
}

/**
 * Внешний триггер переоценки «пусто ли в голосовом канале» — использовать
 * после явных сценариев типа `enqueue`, где мы можем быть единственным,
 * кто сменил состояние.
 *
 * @param {import('discord.js').Guild} guild
 */
export function checkVoiceChannelEmptyNow(guild) {
  if (!guild) return;
  void checkVoiceChannelEmpty(guild, getVoiceEmptyDelayMs());
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {number} delayMs
 */
async function checkVoiceChannelEmpty(guild, delayMs) {
  const id = String(guild.id);
  const conn = getVoiceConnection(id);
  if (!conn) {
    clearAutoLeaveTimer(id);
    return;
  }
  const channelId = conn.joinConfig.channelId;
  if (!channelId) {
    clearAutoLeaveTimer(id);
    return;
  }

  try {
    await guild.voiceStates.fetch();
  } catch {
    /* ignore */
  }

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isVoiceBased()) {
    clearAutoLeaveTimer(id);
    return;
  }

  const humans = ch.members.filter((m) => !m.user.bot).size;
  if (humans > 0) {
    clearAutoLeaveTimer(id);
    return;
  }

  if (voiceEmptyTimers.has(id)) return;
  const t = setTimeout(() => {
    voiceEmptyTimers.delete(id);
    void (async () => {
      const g = await voiceClient?.guilds.fetch(id).catch(() => null);
      if (!g) return;
      const liveConn = getVoiceConnection(id);
      if (!liveConn) return;
      const cid = liveConn.joinConfig.channelId;
      if (!cid) return;
      try {
        await g.voiceStates.fetch();
      } catch {
        /* ignore */
      }
      const vch = await g.channels.fetch(cid).catch(() => null);
      if (!vch?.isVoiceBased()) return;
      if (vch.members.filter((m) => !m.user.bot).size > 0) return;
      // Причину проставляем заранее — `leave()` по цепочке
      // teardown → voice-adapter.leave подхватит её через pendingLeaveReason.
      pendingLeaveReason.set(id, 'timeout');
      try {
        callbacks.onAutoLeaveTimeout?.(id);
      } catch (e) {
        console.warn('[voice-adapter] onAutoLeaveTimeout threw', id, e);
      }
      console.log(
        `[voice-adapter] авто-выход из голоса (нет людей ${Math.round(delayMs / 60000)} мин), guild ${id}`,
      );
    })();
  }, delayMs);
  voiceEmptyTimers.set(id, t);
}

/**
 * Эмитим `onVoiceGone`, если гильдия сейчас была в регистре. Каждый источник
 * (explicit leave, stateChange, timeout) — конкурирует за «первое срабатывание»;
 * второй вызов для той же гильдии уже не увидит её в map и будет noop.
 *
 * @param {string} guildId
 * @param {VoiceGoneReason} reason
 */
function markGone(guildId, reason) {
  const id = String(guildId);
  const had = connectionsByGuild.has(id);
  connectionsByGuild.delete(id);
  if (!had) return;
  const actualReason = pendingLeaveReason.get(id) ?? reason;
  pendingLeaveReason.delete(id);
  try {
    callbacks.onVoiceGone?.(id, actualReason);
  } catch (e) {
    console.warn('[voice-adapter] onVoiceGone threw', id, e);
  }
}

/**
 * Повесить на соединение `stateChange` listener, который автоматически
 * чистит registry при Disconnected/Destroyed. Отдельный listener `error` —
 * просто логирует.
 *
 * @param {string} guildId
 * @param {import('@discordjs/voice').VoiceConnection} conn
 */
function wireConnectionListeners(guildId, conn) {
  conn.on('error', (e) => {
    console.error('[voice-adapter] VoiceConnection error', guildId, e);
  });
  conn.on('stateChange', (_old, ns) => {
    if (ns.status === VoiceConnectionStatus.Disconnected) {
      markGone(guildId, 'connection_disconnect');
    } else if (ns.status === VoiceConnectionStatus.Destroyed) {
      markGone(guildId, 'connection_destroy');
    }
  });
}

/**
 * Гарантирует, что к `channel` есть готовое (Ready) `VoiceConnection` с
 * подписанным player'ом. Атомарная операция:
 *
 *   - если уже подключены к этому же каналу и не Destroyed — reuse;
 *   - иначе старое соединение (если было) destroy() и создаём новое;
 *   - ждём Ready до 30 с;
 *   - подписываем player;
 *   - регистрируем в map и зовём onVoiceReady.
 *
 * При сбое на этапе «entersState Ready» — partial connection уничтожается,
 * в registry не попадает; бросается исключение. Внешний мир НЕ видит
 * «полу-подключенное» состояние.
 *
 * @param {import('discord.js').VoiceBasedChannel} channel
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @returns {Promise<import('@discordjs/voice').VoiceConnection>}
 */
export async function ensureVoiceConnection(channel, player) {
  if (!channel?.guild) throw new Error('voice-adapter: channel without guild');
  if (!player) throw new Error('voice-adapter: player required');
  const guildId = String(channel.guild.id);
  const existing = connectionsByGuild.get(guildId);
  const joinedCh = existing?.joinConfig?.channelId;
  const alive =
    existing && existing.state.status !== VoiceConnectionStatus.Destroyed;

  if (alive && String(joinedCh) === String(channel.id)) {
    return existing;
  }

  if (existing) {
    // user_leave — нас попросили переключить канал, старое соединение
    // уходит по пользовательской инициативе.
    pendingLeaveReason.set(guildId, 'user_leave');
    // Удаляем из registry ДО destroy() — stateChange→Destroyed увидит пустой
    // map и не эмитит второй onVoiceGone.
    connectionsByGuild.delete(guildId);
    try {
      existing.destroy();
    } catch {
      /* ignore */
    }
    const effective = pendingLeaveReason.get(guildId) ?? 'connection_destroy';
    pendingLeaveReason.delete(guildId);
    try {
      callbacks.onVoiceGone?.(guildId, effective);
    } catch (e) {
      console.warn('[voice-adapter] onVoiceGone threw', guildId, e);
    }
  }

  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  wireConnectionListeners(guildId, conn);

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
  } catch (e) {
    console.error('[voice-adapter] voice not ready', guildId, e);
    try {
      conn.destroy();
    } catch {
      /* ignore */
    }
    // В registry ещё не положили — markGone не сработает, но дадим знать наверх.
    try {
      callbacks.onVoiceGone?.(guildId, 'timeout');
    } catch (err) {
      console.warn('[voice-adapter] onVoiceGone threw', guildId, err);
    }
    throw new Error('Не удалось подключиться к голосовому каналу');
  }

  conn.subscribe(player);
  connectionsByGuild.set(guildId, conn);
  try {
    callbacks.onVoiceReady?.(guildId, String(channel.id));
  } catch (e) {
    console.warn('[voice-adapter] onVoiceReady threw', guildId, e);
  }
  return conn;
}

/**
 * Явный выход из голосового канала. Представляет намерение клиента завершить
 * сессию — `onVoiceGone` фаерится ВСЕГДА, даже если соединения уже не было
 * в registry (например, оно слетело ранее по stateChange). Это гарантирует,
 * что orchestrator доведёт endSession/setBotVoiceState до конца в любых
 * сценариях, где `stopAndLeave` зовут «на всякий случай».
 *
 * Повторный вызов — ещё раз эмитит onVoiceGone, но endSession/setBotVoiceState
 * идемпотентны, так что никакого вреда нет.
 *
 * @param {string} guildId
 * @param {VoiceGoneReason} [reason='user_leave']
 */
export function leave(guildId, reason = 'user_leave') {
  const id = String(guildId);
  const conn = connectionsByGuild.get(id);
  // Приоритет — ранее проставленная причина (auto-leave timer), иначе — явный
  // аргумент вызова.
  const effective = pendingLeaveReason.get(id) ?? reason;
  pendingLeaveReason.delete(id);
  clearAutoLeaveTimer(id);
  // ВАЖНО: удаляем из registry ДО destroy(), чтобы listener stateChange→Destroyed
  // увидел пустой map и не эмитил второй onVoiceGone.
  connectionsByGuild.delete(id);
  if (conn) {
    try {
      conn.destroy();
    } catch {
      /* ignore */
    }
  }
  try {
    callbacks.onVoiceGone?.(id, effective);
  } catch (e) {
    console.warn('[voice-adapter] onVoiceGone threw', id, e);
  }
}

/**
 * @param {string} guildId
 * @returns {import('@discordjs/voice').VoiceConnection | null}
 */
export function getConnection(guildId) {
  return connectionsByGuild.get(String(guildId)) ?? null;
}

/**
 * Коннект в registry и не в статусе Destroyed.
 * @param {string} guildId
 * @returns {boolean}
 */
export function isConnectionAlive(guildId) {
  const c = connectionsByGuild.get(String(guildId));
  if (!c) return false;
  return c.state.status !== VoiceConnectionStatus.Destroyed;
}

/**
 * ID канала, в котором сидит бот. `null` — нет записи или нет channelId.
 * @param {string} guildId
 * @returns {string | null}
 */
export function getConnectedChannelId(guildId) {
  const c = connectionsByGuild.get(String(guildId));
  const cid = c?.joinConfig?.channelId;
  return cid ? String(cid) : null;
}

/**
 * Дождаться статуса Ready на уже существующем соединении. Если соединения
 * нет — бросает. Если уже Ready — резолвится сразу.
 *
 * @param {string} guildId
 * @param {number} [timeoutMs=15_000]
 */
export async function awaitReady(guildId, timeoutMs = 15_000) {
  const id = String(guildId);
  const conn = connectionsByGuild.get(id);
  if (!conn) throw new Error('voice-adapter: нет соединения для гильдии');
  if (conn.state.status === VoiceConnectionStatus.Ready) return;
  await entersState(conn, VoiceConnectionStatus.Ready, timeoutMs);
}

/**
 * Тестовый/диагностический хук: полностью обнулить внутренний state.
 * Не использовать в продакшн-коде.
 */
export function __resetVoiceAdapterForTests() {
  for (const t of voiceEmptyTimers.values()) clearTimeout(t);
  voiceEmptyTimers.clear();
  connectionsByGuild.clear();
  pendingLeaveReason.clear();
  callbacks = {};
  voiceClient = null;
}
