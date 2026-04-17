/**
 * Обработчики кнопок музыкальной панели.
 *
 * Каждый обработчик:
 *   1. Вызывает доменный use-case через `orchestrator.commands.*`
 *   2. Делает deferUpdate() чтобы Discord не показывал «думает»
 *   3. Ставит обновление панели в очередь через syncInteractionMusicPanel
 *
 * index.js остаётся тонким роутером и ничего не знает о деталях кнопок.
 *
 * Шаг 7: обработчики больше не зависят от `music.js` напрямую — только
 * через `orchestrator.commands`. Это делает Discord-слой взаимозаменяемым
 * (будущий HTTP/WebSocket API будет вызывать те же команды).
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
      orchestrator.commands.skip(interaction.guildId, interaction.user.id);
      await interaction.deferUpdate();
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_PREV: {
      await interaction.deferUpdate();
      const res = orchestrator.commands.previousTrack(interaction.guildId, interaction.user.id);
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
      orchestrator.commands.toggleRepeat(interaction.guildId);
      await interaction.deferUpdate();
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_AUTOPLAY:
      orchestrator.commands.toggleAutoplay(interaction.guildId);
      await interaction.deferUpdate();
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_PAUSE:
      orchestrator.commands.pause(interaction.guildId);
      await interaction.deferUpdate();
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_RESUME:
      orchestrator.commands.resume(interaction.guildId);
      await interaction.deferUpdate();
      await syncInteractionMusicPanel(interaction);
      break;

    case BTN_STOP:
      orchestrator.commands.stopAndLeave(interaction.guildId);
      await interaction.reply({ content: 'Остановлено.', flags: MessageFlags.Ephemeral });
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
      try {
        const { removed } = await emitLike({
          userId,
          guildId,
          url: snapshot.currentUrl,
          title: snapshot.currentLabel ?? snapshot.currentUrl,
          sessionId: getSessionId(guildId),
        });
        await interaction.editReply({
          content: removed ? 'Убрано из избранного' : 'Добавлено в избранное ❤',
        });
      } catch (err) {
        console.error('[like] failed to persist', err);
        await interaction.editReply({ content: 'Не удалось сохранить — попробуй ещё раз.' });
      }
      break;
    }
  }
}
