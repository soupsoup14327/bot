import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
} from 'discord.js';
import sodium from 'libsodium-wrappers';
import { chatOllama } from './ollama.js';
import { enqueue, skip, stopAndLeave } from './music.js';

await sodium.ready;

const SYSTEM =
  'Ты дружелюбный помощник в Discord. Отвечай кратко и по делу. Если пользователь просит музыку или картинку, подскажи команды /play и /image.';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Создай файл .env с DISCORD_TOKEN=... (см. .env.example)');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

function pollinationsUrl(prompt) {
  const q = encodeURIComponent(prompt.slice(0, 900));
  return `https://image.pollinations.ai/prompt/${q}?width=1024&height=1024&nologo=true`;
}

client.once('ready', (c) => {
  console.log(`В сети как ${c.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'chat') {
      await interaction.deferReply();
      const text = interaction.options.getString('text', true);
      const reply = await chatOllama(text, SYSTEM);
      const chunk = reply.slice(0, 3900);
      await interaction.editReply(chunk);
      return;
    }

    if (interaction.commandName === 'image') {
      await interaction.deferReply();
      const prompt = interaction.options.getString('prompt', true);
      const url = pollinationsUrl(prompt);
      const embed = new EmbedBuilder()
        .setTitle('Картинка')
        .setDescription(`Промпт: ${prompt.slice(0, 500)}`)
        .setImage(url)
        .setFooter({ text: 'Генерация через image.pollinations.ai' });
      await interaction.editReply({ embeds: [embed], content: url });
      return;
    }

    if (interaction.commandName === 'play') {
      const member = interaction.member;
      const voice = member?.voice?.channel;
      if (!voice?.isVoiceBased()) {
        await interaction.reply({
          content: 'Зайди в голосовой канал и повтори команду.',
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      await enqueue(voice, query);
      await interaction.editReply(`В очередь: **${query}**`);
      return;
    }

    if (interaction.commandName === 'skip') {
      const ok = skip(interaction.guildId);
      await interaction.reply(ok ? 'Пропуск…' : 'Ничего не играет.');
      return;
    }

    if (interaction.commandName === 'stop') {
      stopAndLeave(interaction.guildId);
      await interaction.reply('Остановлено.');
      return;
    }
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Ошибка: ${msg.slice(0, 500)}` }).catch(() => {});
    } else {
      await interaction.reply({ content: `Ошибка: ${msg.slice(0, 500)}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(token);
