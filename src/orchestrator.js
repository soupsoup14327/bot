/**
 * orchestrator.js
 *
 * Координатор доменных use-case'ов. Внешний API (commands.*) — для Discord-бота,
 * будущего HTTP/WebSocket API и любых других клиентов. Внутренний API (events.*) —
 * реакции на события voice-adapter / player-controller / audio-pipeline.
 *
 * См. docs/ПЛАН-РЕФАКТОРИНГА.md, раздел «Ключевые контракты» → `orchestrator` API.
 *
 * Шаг 5: events.onVoiceReady / onVoiceGone стали production — воспроизводят
 * сессионный lifecycle из реальных событий `voice-adapter`.
 *
 * Шаг 7 (текущий): commands.* закрыт тонкими прокси над `music.js` с единым
 * `Result<T>` возвратом. Прямые импорты `music.js` из `button-handlers.js` и
 * `index.js` заменены на `orchestrator.commands.*` — так Discord-слой общается
 * с доменом только через этот модуль. Реальная логика пока живёт в `music.js`;
 * перенос её в явные domain-модули — тема последующих шагов плана.
 *
 * ВАЖНО: этот модуль умышленно тонкий. Policy-решения (например, "repeat ON +
 * stream failed → force-skip") не должны тут размазываться — они живут в явных
 * доменных модулях (queue-manager, player-controller, player-idle-verdict).
 * Orchestrator — только координация: кто кого и в каком порядке вызывает.
 */

import {
  startSession,
  endSession,
  setBotVoiceState,
} from './guild-session-state.js';

import {
  enqueue as musicEnqueue,
  skip as musicSkip,
  previousTrack as musicPreviousTrack,
  pauseMusic as musicPause,
  resumeMusic as musicResume,
  toggleRepeat as musicToggleRepeat,
  toggleAutoplay as musicToggleAutoplay,
  stopAndLeave as musicStopAndLeave,
} from './music.js';

/**
 * @typedef {'user_leave' | 'connection_destroy' | 'connection_disconnect' | 'timeout' | 'unknown'} VoiceGoneReason
 */

/**
 * Унифицированный ответ команды. Ok-ветка опционально несёт `value` (для
 * чтения UI'ем — текущее состояние toggle, panelHint и т.п.). Err-ветка
 * всегда несёт человекочитаемый `reason` + машинный `code` для UI-маршрутизации.
 *
 * Коды:
 *   - `invalid_argument`  — обязательный параметр отсутствует или некорректен;
 *   - `not_playing`       — операция требует активного плеера (skip/prev);
 *   - `no_history`        — previousTrack без истории в текущей сессии;
 *   - `not_applicable`    — pause/resume в неподходящем состоянии плеера;
 *   - `enqueue_error`     — enqueue выбросил Error (playability bad-url, voice failure и т.п.).
 *
 * @template T
 * @typedef {{ ok: true, value?: T } | { ok: false, reason: string, code: string }} Result
 */

function log(stage, guildId, meta) {
  if (process.env.ORCHESTRATOR_DEBUG === '1') {
    const extra = meta == null ? '' : ` ${JSON.stringify(meta)}`;
    console.log(`[orchestrator] ${stage} guild=${guildId}${extra}`);
  }
}

const OK = Object.freeze({ ok: true });

/**
 * @template T
 * @param {T} value
 * @returns {Result<T>}
 */
function okValue(value) {
  return Object.freeze({ ok: true, value });
}

/**
 * @param {string} reason
 * @param {string} code
 * @returns {Result<never>}
 */
function fail(reason, code) {
  return Object.freeze({ ok: false, reason, code });
}

/**
 * @param {string | null | undefined} guildId
 * @returns {string | null}
 */
function normalizeGuildId(guildId) {
  if (guildId == null) return null;
  const s = String(guildId);
  return s.length > 0 ? s : null;
}

/**
 * Внешний use-case API. Каждая команда:
 *   - идемпотентна по возможности (повторный skip не ломает состояние);
 *   - возвращает `Result<T>` с машинным `code` при ошибке;
 *   - не бросает — любой Error от нижнего слоя заворачивается в Err.
 *
 * Форма сделана «будто бы вызывается через per-guild Promise-chain» — mutex
 * сейчас не реализован, но API готов к его появлению без breaking change.
 */
export const commands = Object.freeze({
  /**
   * Поставить трек в очередь / запустить первый.
   *
   * @param {{
   *   channel: import('discord.js').VoiceBasedChannel,
   *   query: string,
   *   source?: 'single' | 'autoplay',
   *   userId?: string | null,
   *   userDisplayName?: string | null,
   * }} payload
   * @returns {Promise<Result<{ panelHint: string, trackLabel: string }>>}
   */
  async enqueue(payload) {
    if (!payload || !payload.channel) return fail('channel required', 'invalid_argument');
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query) return fail('query required', 'invalid_argument');
    log('commands.enqueue', payload.channel.guild?.id, { source: payload.source ?? 'single' });
    try {
      const r = await musicEnqueue(
        payload.channel,
        query,
        payload.source ?? 'single',
        payload.userId ?? null,
        payload.userDisplayName ?? null,
      );
      return okValue({
        panelHint: r?.panelHint ?? '',
        trackLabel: r?.trackLabel ?? '',
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return fail(reason, 'enqueue_error');
    }
  },

  /**
   * Пропустить текущий трек.
   * @param {string | null | undefined} guildId
   * @param {string | null} [actorUserId]
   * @returns {Result<void>}
   */
  skip(guildId, actorUserId = null) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.skip', id, { actorUserId });
    const ok = musicSkip(id, actorUserId);
    return ok ? OK : fail('no active player', 'not_playing');
  },

  /**
   * Перейти на предыдущий трек сессии.
   * @param {string | null | undefined} guildId
   * @param {string | null} [actorUserId]
   * @returns {Result<void>}
   */
  previousTrack(guildId, actorUserId = null) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.previousTrack', id, { actorUserId });
    const ok = musicPreviousTrack(id, actorUserId);
    return ok ? OK : fail('no history or not connected', 'no_history');
  },

  /**
   * Пауза.
   * @param {string | null | undefined} guildId
   * @returns {Result<void>}
   */
  pause(guildId) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.pause', id);
    const ok = musicPause(id);
    return ok ? OK : fail('pause not applicable', 'not_applicable');
  },

  /**
   * Снять паузу.
   * @param {string | null | undefined} guildId
   * @returns {Result<void>}
   */
  resume(guildId) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.resume', id);
    const ok = musicResume(id);
    return ok ? OK : fail('resume not applicable', 'not_applicable');
  },

  /**
   * Переключить repeat (взаимоисключающ с autoplay). Возвращает новое состояние.
   * @param {string | null | undefined} guildId
   * @returns {Result<{ enabled: boolean }>}
   */
  toggleRepeat(guildId) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.toggleRepeat', id);
    const enabled = musicToggleRepeat(id);
    return okValue({ enabled });
  },

  /**
   * Переключить autoplay (взаимоисключающ с repeat). Возвращает новое состояние.
   * @param {string | null | undefined} guildId
   * @returns {Result<{ enabled: boolean }>}
   */
  toggleAutoplay(guildId) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.toggleAutoplay', id);
    const enabled = musicToggleAutoplay(id);
    return okValue({ enabled });
  },

  /**
   * Полный стоп + выход из голосового канала.
   * @param {string | null | undefined} guildId
   * @returns {Result<void>}
   */
  stopAndLeave(guildId) {
    const id = normalizeGuildId(guildId);
    if (!id) return fail('guildId required', 'invalid_argument');
    log('commands.stopAndLeave', id);
    musicStopAndLeave(id);
    return OK;
  },
});

/**
 * Внутренний реактивный API. Вызывается adapter'ами на события от инфраструктуры.
 * Возвращаемое значение игнорируется (fire-and-forget).
 */
export const events = Object.freeze({
  /**
   * Бот вошёл в голосовой канал и VoiceConnection готов. Здесь — старт
   * логической сессии (новый sessionId) и синхронизация `botVoiceState`.
   *
   * @param {string} guildId
   * @param {string} channelId
   */
  onVoiceReady(guildId, channelId) {
    log('onVoiceReady', guildId, { channelId });
    const id = String(guildId);
    startSession(id);
    setBotVoiceState(id, { connected: true, channelId: String(channelId) });
  },

  /**
   * Бот ушёл из голосового канала (любой из путей: пользователь выгнал,
   * connection destroyed, disconnected, auto-leave по таймеру, явный leave).
   * Завершаем сессию и помечаем бота как не в голосе. Идемпотентно — можно
   * вызывать повторно: `endSession` просто delete'нет запись, `setBotVoiceState`
   * проставит connected=false.
   *
   * @param {string} guildId
   * @param {VoiceGoneReason} reason
   */
  onVoiceGone(guildId, reason) {
    log('onVoiceGone', guildId, { reason });
    const id = String(guildId);
    endSession(id);
    setBotVoiceState(id, { connected: false, channelId: null });
  },
});

/**
 * Удобный агрегирующий экспорт — `import { orchestrator } from './orchestrator.js'`.
 */
export const orchestrator = Object.freeze({ commands, events });
