/**
 * index.js — точка входа Discord-бота.
 *
 * После рефакторинга Шага 10 этот файл — тонкий роутер:
 *
 *   Discord event → parse → (orchestrator.commands.* | music.enqueue |
 *                            addTracksAndUpdateUI | handleButtonInteractions)
 *
 * Он НЕ владеет state'ом, НЕ знает как устроены очередь / плеер / voice.
 * Весь функционал живёт в доменных модулях; index.js только:
 *
 *   1. Создаёт Discord `Client`.
 *   2. Инициализирует music-panel (initMusicUi).
 *   3. Регистрирует callback'и voice-adapter → orchestrator.events + auto-leave.
 *   4. Слушает `voiceStateUpdate` и обновляет listeners-count в session-state.
 *   5. Маршрутизирует:
 *       - slash-команды /chat /image /play /skip /stop,
 *       - кнопки музыкальной панели → button-handlers,
 *       - модальное окно /play (через кнопку «+ добавить») → music.enqueue.
 *
 * Все Domain-вызовы идут через `orchestrator.commands.*`. Прямой `music.js`
 * использован только для `enqueue` (нет command-эквивалента для full
 * enqueue-flow с панелью) и `registerAutoplayUserQuery` (регистратор
 * контекста автоплея, не команда управления).
 */

import 'dotenv/config';
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';
import sodium from 'libsodium-wrappers';

import { chatGroq } from './groq.js';
import { registerAutoplayUserQuery } from './music.js';
import { orchestrator } from './orchestrator.js';
import {
  addTracksAndUpdateUI,
  initMusicUi,
  registerPendingSingleLine,
} from './music-panel.js';
import {
  attachVoiceAutoLeave,
  registerVoiceAdapterCallbacks,
} from './voice-adapter.js';
import { handleButtonInteractions } from './button-handlers.js';
import { FIELD_PLAY_QUERY, MODAL_PLAY } from './ui-components.js';
import { updateListenersCount } from './guild-session-state.js';
import { formatSingleQueueLine } from './queue-line-format.js';

await sodium.ready;

const SYSTEM =
  'Ты дружелюбный помощник в Discord. Отвечай кратко и по делу. ' +
  'Если пользователь просит музыку или картинку, подскажи команды /play и /image.';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Создай файл .env с DISCORD_TOKEN=... (см. .env.example)');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

// ─── Wiring infra-слоя ────────────────────────────────────────────────────────

/**
 * voice-adapter ↔ orchestrator.events: один источник истины о lifecycle
 * voice-соединений (onVoiceReady → startSession, onVoiceGone → endSession).
 *
 * onAutoLeaveTimeout делегирует полный teardown в orchestrator.commands.stopAndLeave —
 * это корректно завершает цепочку: stop-player → clearState → voice.leave →
 * (onVoiceGone фаернется оттуда и запишет endSession).
 */
registerVoiceAdapterCallbacks({
  onVoiceReady: (guildId, channelId) => orchestrator.events.onVoiceReady(guildId, channelId),
  onVoiceGone: (guildId, reason) => orchestrator.events.onVoiceGone(guildId, reason),
  onAutoLeaveTimeout: (guildId) => {
    // fire-and-forget: auto-leave is background, нет UI-отклика.
    void orchestrator.commands.stopAndLeave(guildId);
  },
});

attachVoiceAutoLeave(client);
initMusicUi(client);

// ─── Listener count (voiceStateUpdate) ────────────────────────────────────────

/**
 * Пересчитать живых слушателей в voice-канале после любого voiceStateUpdate.
 * «Живой» = не бот, не server-deafened, не self-deafened.
 * Self-muted считается: он может слышать.
 *
 * Если в гильдии бот не в voice-канале — ставим 0. Это нужно, чтобы auto-leave
 * таймер и сигналы track_* видели консистентное значение.
 *
 * @param {import('discord.js').Guild} guild
 */
async function recomputeListenersForGuild(guild) {
  if (!guild) return;
  const guildId = String(guild.id);
  const snap = orchestrator.commands; // для tree-shake-friendly ссылки
  void snap;
  try {
    await guild.voiceStates.fetch();
  } catch { /* best effort */ }

  // Возьмём канал бота через его VoiceState; если он не в канале — 0.
  const me = guild.members.me;
  const myVoice = me?.voice?.channelId;
  if (!myVoice) {
    updateListenersCount(guildId, 0);
    return;
  }
  const ch = guild.channels.cache.get(myVoice);
  if (!ch?.isVoiceBased()) {
    updateListenersCount(guildId, 0);
    return;
  }
  let n = 0;
  for (const m of ch.members.values()) {
    if (m.user.bot) continue;
    const v = m.voice;
    if (v?.serverDeaf || v?.selfDeaf) continue;
    n++;
  }
  updateListenersCount(guildId, n);
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  void recomputeListenersForGuild(guild);
});

// ─── Utils ───────────────────────────────────────────────────────────────────

function pollinationsUrl(prompt) {
  const q = encodeURIComponent(String(prompt ?? '').slice(0, 900));
  return `https://image.pollinations.ai/prompt/${q}?width=1024&height=1024&nologo=true`;
}

async function replyErrorEphemeral(interaction, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const content = `Ошибка: ${String(msg).slice(0, 500)}`;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch { /* swallow — пользователю уже ничего не покажем */ }
}

/**
 * Общий enqueue-поток: /play или модалка через «+ добавить».
 * Разворачивает enqueue + ставит ephemeral-ответ + добавляет строку в сессионный
 * список и панель через `addTracksAndUpdateUI`.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} rawQuery
 */
async function runEnqueueFlow(interaction, rawQuery) {
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const voice = member?.voice?.channel;
  if (!voice?.isVoiceBased()) {
    const content = 'Зайди в голосовой канал и повтори команду.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const guildId = String(interaction.guildId);
  registerAutoplayUserQuery(guildId, rawQuery);

  const addedByName = interaction.user.displayName ?? interaction.user.username ?? null;

  const res = await orchestrator.commands.enqueue({
    channel: voice,
    query: rawQuery,
    source: 'single',
    userId: interaction.user.id,
    userDisplayName: addedByName,
  });

  if (!res.ok) {
    // Поднимаем наверх — catch в /play / runTextCommand покажет ошибку юзеру.
    throw new Error(res.reason || 'enqueue failed');
  }

  const line = formatSingleQueueLine(res.value.trackLabel, { addedBy: addedByName });

  await addTracksAndUpdateUI(interaction, [line], res.value.panelHint);

  // FIFO-регистрация для замены placeholder'а (raw query) на реальное название
  // трека в момент старта — см. music-panel._replacePendingSingleLineWithLabel.
  registerPendingSingleLine(guildId, line, addedByName);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

client.once('ready', (c) => {
  console.log(`В сети как ${c.user.tag}`);
});

// ─── interactionCreate router ────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButtonInteractions(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === MODAL_PLAY) {
      if (!interaction.guild) {
        await interaction.reply({ content: 'Только на сервере.', flags: MessageFlags.Ephemeral });
        return;
      }
      const query = interaction.fields.getTextInputValue(FIELD_PLAY_QUERY)?.trim() ?? '';
      if (!query) {
        await interaction.reply({ content: 'Пустой запрос.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await runEnqueueFlow(interaction, query);
      } catch (err) {
        console.error('[modal /play]', err);
        await replyErrorEphemeral(interaction, err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'chat') {
      await interaction.deferReply();
      const text = interaction.options.getString('text', true);
      const reply = await chatGroq(text, SYSTEM);
      await interaction.editReply(String(reply ?? '').slice(0, 3900));
      return;
    }

    if (interaction.commandName === 'image') {
      await interaction.deferReply();
      const prompt = interaction.options.getString('prompt', true);
      const url = pollinationsUrl(prompt);
      const embed = new EmbedBuilder()
        .setTitle('Картинка')
        .setDescription(`Промпт: ${String(prompt).slice(0, 500)}`)
        .setImage(url)
        .setFooter({ text: 'Генерация через image.pollinations.ai' });
      await interaction.editReply({ embeds: [embed], content: url });
      return;
    }

    if (interaction.commandName === 'play') {
      if (!interaction.guild) {
        await interaction.reply({ content: 'Только на сервере.', flags: MessageFlags.Ephemeral });
        return;
      }
      const query = interaction.options.getString('query', true).trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await runEnqueueFlow(interaction, query);
      } catch (err) {
        console.error('[slash /play]', err);
        await replyErrorEphemeral(interaction, err);
      }
      return;
    }

    if (interaction.commandName === 'skip') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await orchestrator.commands.skip(interaction.guildId, interaction.user.id);
      await interaction.editReply({
        content: res.ok ? 'Пропуск…' : 'Ничего не играет.',
      });
      return;
    }

    if (interaction.commandName === 'stop') {
      await interaction.reply({ content: 'Остановлено.', flags: MessageFlags.Ephemeral });
      await orchestrator.commands.stopAndLeave(interaction.guildId);
      return;
    }
  } catch (err) {
    console.error('[interactionCreate]', err);
    await replyErrorEphemeral(interaction, err);
  }
});

client.login(token);
