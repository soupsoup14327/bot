# Discord bot: Ollama (Llama), YouTube music, картинки

## Важно про токен

Никогда не публикуй `DISCORD_TOKEN` в чатах и в GitHub. Если токен засветился — **Reset Token** в [Developer Portal](https://discord.com/developers/applications) → Bot.

## Что умеет

- `/chat` — ответ через локальную **Ollama** (по умолчанию `llama3.1:8b`).
- `/play` — очередь музыки с **YouTube** (поиск или ссылка); зайди в голосовой канал перед командой.
- `/image` — картинка по тексту через [image.pollinations.ai](https://image.pollinations.ai/) (без API-ключа).
- `/skip`, `/stop`.

## Требования

- Node.js 18+
- Запущенный **Ollama** и скачанная модель (см. ниже).
- Для музыки: боту в Discord выданы права **Connect**, **Speak**, **Use Voice Activity** (и базовые для slash-команд).

## Установка Ollama и модели (Windows)

1. Установи [Ollama для Windows](https://ollama.com/download) (или через `winget install Ollama.Ollama`).
2. В терминале:

```bash
ollama pull llama3.1:8b
```

3. Убедись, что сервер доступен: `http://127.0.0.1:11434` (Ollama обычно стартует в фоне после установки).

## Настройка бота

1. Скопируй `.env.example` в `.env`.
2. Заполни `DISCORD_TOKEN` (новый, после сброса при утечке).
3. `DISCORD_CLIENT_ID` — **Application ID** из вкладки OAuth2 / General.
4. Опционально `DISCORD_GUILD_ID` — ID сервера для **быстрой** регистрации slash-команд (иначе глобальные команды могут обновляться до ~1 часа).

```bash
npm install
npm run register-commands
npm start
```

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
