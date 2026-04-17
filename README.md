# Discord bot: Groq (ИИ), YouTube music, картинки

## Важно про токен

Никогда не публикуй `DISCORD_TOKEN` в чатах и в GitHub. Если токен засветился — **Reset Token** в [Developer Portal](https://discord.com/developers/applications) → Bot.

## Что умеет

- `/chat` — ответ через **Groq** (модель по умолчанию — `llama-3.3-70b-versatile`, меняется `GROQ_CHAT_MODEL`).
- `/play` — очередь музыки с **YouTube** (поиск или ссылка); зайди в голосовой канал перед командой.
- `/image` — картинка по тексту через [image.pollinations.ai](https://image.pollinations.ai/) (без API-ключа).
- `/skip`, `/stop`.

## Требования

- Node.js 18+
- `GROQ_API_KEY` из [console.groq.com](https://console.groq.com/) (бесплатный tier достаточно).
- Для музыки: боту в Discord выданы права **Connect**, **Speak**, **Use Voice Activity** (и базовые для slash-команд).

## Настройка бота

1. Скопируй `.env.example` в `.env` (или `npm run env:setup`).
2. Заполни `DISCORD_TOKEN` (новый, после сброса при утечке).
3. `DISCORD_CLIENT_ID` — **Application ID** из вкладки OAuth2 / General.
4. `GROQ_API_KEY` — из Groq Console.
5. Опционально `DISCORD_GUILD_ID` — ID сервера для **быстрой** регистрации slash-команд (иначе глобальные команды могут обновляться до ~1 часа).

```bash
npm install
npm run register-commands
npm start
```

Полный список env-переменных — `docs/ПЕРЕМЕННЫЕ.md`.

## Пуш на GitHub

```bash
git init
git remote add origin https://github.com/soupsoup14327/bot.git
git add .
git commit -m "Initial bot"
git branch -M main
git push -u origin main
```

## Юридическое

Воспроизведение с YouTube и генерация картинок — на твоей ответственности и по правилам сервисов.
