import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

export const BTN_PREV = 'ctrl_prev';
export const BTN_PAUSE = 'ctrl_pause';
export const BTN_RESUME = 'ctrl_resume';
/** Заглушка, кнопка всегда disabled — нет активного трека. */
export const BTN_TRANSPORT_OFF = 'ctrl_transport_off';
export const BTN_SKIP = 'ctrl_skip';
export const BTN_REPEAT = 'ctrl_repeat';
export const BTN_AUTOPLAY = 'ctrl_autoplay';
export const BTN_STOP = 'ctrl_stop';
export const BTN_ADD_MENU = 'ctrl_add_menu';
export const BTN_LIKE = 'ctrl_like';

export const MODAL_PLAY = 'modal_play';
export const FIELD_PLAY_QUERY = 'play_query';

/**
 * Строка 1: ⏮ ▶/⏸ ⏭ ↻ ∞ (транспорт). Строка 2: остановить, + добавить, ❤.
 * @param {{ hasActiveTrack: boolean, paused: boolean, canPrevious: boolean, canSkipForward: boolean, repeat: boolean, autoplay: boolean, loading?: boolean }} opts
 * @returns {import('discord.js').ActionRowBuilder[]}
 */
export function buildMusicControlRows({
  hasActiveTrack,
  paused,
  canPrevious,
  canSkipForward,
  repeat,
  autoplay,
  loading = false,
}) {
  if (loading) {
    return buildLoadingControlRows({ repeat, autoplay });
  }
  /** Пауза / продолжить / неактивная ▶ когда ничего не играет. */
  let pauseOrPlay;
  if (hasActiveTrack && !paused) {
    pauseOrPlay = new ButtonBuilder()
      .setCustomId(BTN_PAUSE)
      .setLabel('⏸')
      .setStyle(ButtonStyle.Secondary);
  } else if (hasActiveTrack && paused) {
    pauseOrPlay = new ButtonBuilder()
      .setCustomId(BTN_RESUME)
      .setLabel('▶')
      /* Discord даёт для обычных кнопок только Primary/Success/Danger/Secondary — «фиолетовый» ближе всего к Primary (blurple). */
      .setStyle(ButtonStyle.Primary);
  } else {
    pauseOrPlay = new ButtonBuilder()
      .setCustomId(BTN_TRANSPORT_OFF)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
  }

  /** Кнопка повтора: серая — выкл, фиолетовая — вкл, неактивна когда ничего не играет. */
  const repeatBtn = new ButtonBuilder()
    .setCustomId(BTN_REPEAT)
    .setLabel('↻')
    .setStyle(repeat ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!hasActiveTrack);

  /** Кнопка автоплея: серая — выкл, фиолетовая — вкл, неактивна когда ничего не играет. */
  const autoplayBtn = new ButtonBuilder()
    .setCustomId(BTN_AUTOPLAY)
    .setLabel('∞')
    .setStyle(autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!hasActiveTrack);

  const transport = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_PREV)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPrevious),
    pauseOrPlay,
    new ButtonBuilder()
      .setCustomId(BTN_SKIP)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSkipForward),
    repeatBtn,
    autoplayBtn,
  );
  const main = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN_STOP).setLabel('остановить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(BTN_ADD_MENU).setLabel('+ добавить').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN_LIKE)
      .setLabel('❤')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasActiveTrack),
  );
  return [transport, main];
}

/**
 * Между треками / поиск автоплея: все кнопки неактивны, кроме «остановить».
 * @param {{ repeat: boolean, autoplay: boolean }} opts
 */
function buildLoadingControlRows({ repeat, autoplay }) {
  const pauseOrPlay = new ButtonBuilder()
    .setCustomId(BTN_TRANSPORT_OFF)
    .setLabel('▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  const repeatBtn = new ButtonBuilder()
    .setCustomId(BTN_REPEAT)
    .setLabel('↻')
    .setStyle(repeat ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(true);
  const autoplayBtn = new ButtonBuilder()
    .setCustomId(BTN_AUTOPLAY)
    .setLabel('∞')
    .setStyle(autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(true);
  const transport = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_PREV)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    pauseOrPlay,
    new ButtonBuilder()
      .setCustomId(BTN_SKIP)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    repeatBtn,
    autoplayBtn,
  );
  const main = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN_STOP).setLabel('остановить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(BTN_ADD_MENU)
      .setLabel('+ добавить')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(BTN_LIKE)
      .setLabel('❤')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
  return [transport, main];
}

export function buildPlayModal() {
  const modal = new ModalBuilder().setCustomId(MODAL_PLAY).setTitle('Новый запрос');
  const input = new TextInputBuilder()
    .setCustomId(FIELD_PLAY_QUERY)
    .setLabel('Ссылка или запрос')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(500)
    .setPlaceholder('Вы можете вставить URL или написать свой запрос');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}
