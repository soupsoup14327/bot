/**
 * Обработчики кнопок музыкальной панели.
 *
 * Порядок действий в каждом обработчике:
 *   1. `deferUpdate()` ПЕРВЫМ — чтобы уложиться в 3-секундный бюджет
 *      ACK'а Discord-интеракции, даже если команда в очереди за другой.
 *   2. `await orchestrator.commands.*` — команды теперь async и сериализованы
 *      per-guild в command-queue.js. Два юзера жмут одновременно — команды
 *      выполняются строго по очереди, не гоняясь за один и тот же state.
 *   3. `syncInteractionMusicPanel` — рефреш UI ПОСЛЕ мутации, иначе панель
 *      покажет устаревший snapshot.
 *
 * index.js остаётся тонким роутером и ничего не знает о деталях кнопок.
 */

import { MessageFlags } from 'discord.js';
import {
  BTN_ADD_MENU,
  BTN_AUTOPLAY,
  BTN_LIKE,
  BTN_PAUSE,
  BTN_PREV,
  BTN_REPEAT,
  BTN_RESUME,
  BTN_SKIP,
  BTN_STOP,
  buildPlayModal,
} from './ui-components.js';
import { orchestrator } from './orchestrator.js';
import { syncInteractionMusicPanel } from './music-panel.js';
import { getGuildSessionSnapshot, getSessionId } from './guild-session-state.js';
import { emitLike } from './personal-signals.js';

export async function handleButtonInteractions(interaction) {
  console.log(`[btn] ${interaction.customId} user=${interaction.user.id} guild=${interaction.guildId}`);
  if (!interaction.guild) {
    await interaction.reply({ content: 'Только на сервере.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  switch (interaction.customId) {
    case BTN_SKIP:
      await interaction.deferUpdate();
      await orchestrator.commands.skip(interaction.guildId, interaction.user.id);
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_PREV: {
      await interaction.deferUpdate();
      const res = await orchestrator.commands.previousTrack(interaction.guildId, interaction.user.id);
      if (!res.ok) {
        await interaction.followUp({
          content: 'Назад некуда — это первый трек в этой сессии или плеер сейчас не активен.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      await syncInteractionMusicPanel(interaction);
      break;
    }

    case BTN_REPEAT:
      await interaction.deferUpdate();
      await orchestrator.commands.toggleRepeat(interaction.guildId);
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_AUTOPLAY:
      await interaction.deferUpdate();
      await orchestrator.commands.toggleAutoplay(interaction.guildId);
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_PAUSE:
      await interaction.deferUpdate();
      await orchestrator.commands.pause(interaction.guildId);
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_RESUME:
      await interaction.deferUpdate();
      await orchestrator.commands.resume(interaction.guildId);
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_STOP:
      await interaction.reply({ content: 'Остановлено.', flags: MessageFlags.Ephemeral });
      await orchestrator.commands.stopAndLeave(interaction.guildId);
      break;

    case BTN_ADD_MENU:
      await interaction.showModal(buildPlayModal());
      break;

    case BTN_LIKE: {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = interaction.guildId;
      const userId  = interaction.user.id;
      const snapshot = guildId ? getGuildSessionSnapshot(guildId) : null;
      if (!snapshot?.currentUrl) {
        await interaction.editReply({ content: 'Сейчас ничего не играет.' });
        break;
      }
      // personal-signals.js — stub до появления БД. emitLike возвращает
      // { ok:false, reason:'not_implemented' } — показываем честную ошибку,
      // чтобы не плодить временный UX «успех без персистентности».
      try {
        const res = await emitLike({
          userId,
          guildId,
          url: snapshot.currentUrl,
          title: snapshot.currentLabel ?? snapshot.currentUrl,
          sessionId: getSessionId(guildId),
        });
        if (res.ok) {
          const head = res.removed ? 'Убрано из избранного' : 'Добавлено в избранное ❤';
          await interaction.editReply({ content: head });
        } else {
          await interaction.editReply({
            content: 'Избранное пока не работает — ждём БД приложения.',
          });
        }
      } catch (err) {
        console.error('[like] failed', err);
        await interaction.editReply({ content: 'Не удалось сохранить — попробуй ещё раз.' });
      }
      break;
    }
  }
}
