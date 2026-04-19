# Документация PAWPAW

**Язык документации:** русский  
**Обновлено:** 2026-04-19

---

## Документы

| Файл | Содержание |
|---|---|
| [АРХИТЕКТУРА.md](АРХИТЕКТУРА.md) | Модули, граф зависимостей, runtime-потоки, владение состоянием, API/БД, архитектурные планы и техдолг |
| [СТАТУС.md](СТАТУС.md) | Текущее состояние проекта: что закрыто, что в обкатке, что сознательно отложено |
| [ПЕРЕМЕННЫЕ.md](ПЕРЕМЕННЫЕ.md) | Все переменные окружения с описанием на русском |
| [AUTOPLAY-NOTES.txt](AUTOPLAY-NOTES.txt) | Короткие практические заметки по autoplay rollout: diversity, quarantine, escape и порядок включения feature flag'ов |
| [НАБЛЮДАЕМОСТЬ.md](НАБЛЮДАЕМОСТЬ.md) | Метрики, файлы в `data/metrics/`, консольные логи |
| [ИНВАРИАНТЫ.md](ИНВАРИАНТЫ.md) | Критичные правила для разработчиков: планировщик, prefetch, stale guard, FSM |
| [БАГИ.md](БАГИ.md) | Реестр багов (история + открытые) |
| [ПЛАН-РЕФАКТОРИНГА.md](ПЛАН-РЕФАКТОРИНГА.md) | Журнал шагов 0–10 (выполнены), контракты; опциональный шаг 10b — идея `enqueue-pipeline` |
| [adr/001-data-layer.md](adr/001-data-layer.md) | ADR-001: data layer — один `DATABASE_URL`, Drizzle, SQLite для dev/test, Postgres как upgrade path, test-safety invariant, migration ownership, cross-backend discipline, fail-policy |

---

## Быстрые ответы

**Состояние на 2026-04-19**
- Data layer подключён в runtime: SQLite для dev/test, отдельный Postgres pack для parity и CI.
- Лайки и `/likes` работают end-to-end, playback history пишет в `track_plays`.
- CI matrix SQLite/Postgres зелёная; проект сейчас в режиме обкатки.
- По autoplay зафиксированы отдельные rollout-заметки: что уже даёт escape, где остаётся однообразие и какие флаги включать отдельно → [AUTOPLAY-NOTES.txt](AUTOPLAY-NOTES.txt).
- Подробнее по текущему состоянию и отложенным направлениям → [СТАТУС.md](СТАТУС.md).

**Как запустить?**
```bash
cd bot
npm install
npm run env:setup      # создать .env
# заполнить DISCORD_TOKEN и GROQ_API_KEY
npm start
```

**Как проверить код перед коммитом?**
```bash
npm run verify
```

**Что делать после правки `src/db/schema.js`?**
```bash
npm run db:generate
```

**Как зарегистрировать slash-команды?**
```bash
npm run register-commands
```

**Как посмотреть избранные треки?**
→ `/likes`

**Где смотреть метрики?**
→ `bot/data/metrics/*.txt` (при `METRICS_TXT_ENABLED=1`)

**Где добавить баг?**
→ `docs/БАГИ.md`

**Какой модуль за что отвечает?**
→ [АРХИТЕКТУРА.md — Контур runtime](АРХИТЕКТУРА.md#контур-runtime) → «Подсистемы и модули»

**Как работает автоплей?**
→ [АРХИТЕКТУРА.md — Потоки и состояние](АРХИТЕКТУРА.md#потоки-и-состояние) → «Автоплей (очередь опустела)»

**Где лежат последние практические заметки по подбору треков?**
→ `docs/AUTOPLAY-NOTES.txt`

**Что нельзя делать в `runPlayNext`?**
→ `docs/ИНВАРИАНТЫ.md` → раздел 1

**Где смотреть текущий data layer и history foundation?**
→ `docs/АРХИТЕКТУРА.md` → «База данных» и `docs/adr/001-data-layer.md`
