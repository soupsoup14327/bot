import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('Нужны DISCORD_TOKEN и DISCORD_CLIENT_ID в .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Спросить ИИ (Groq)')
    .addStringOption((o) =>
      o.setName('text').setDescription('Текст').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('image')
    .setDescription('Картинка по описанию (Pollinations, без ключа)')
    .addStringOption((o) =>
      o.setName('prompt').setDescription('Описание').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Музыка из YouTube (поиск или URL)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Запрос или ссылка').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder().setName('skip').setDescription('Следующий трек').toJSON(),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить и выйти из войса').toJSON(),
];

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Команды зарегистрированы для гильдии ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Глобальные команды зарегистрированы (обновление до ~1 часа)');
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
