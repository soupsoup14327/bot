# Юнит-тесты PAWPAW

**Runner:** `node:test` (встроенный в Node.js ≥ 18).
**Зависимости:** нет. Ноль новых dev-пакетов.

---

## Запуск

```bash
cd bot
npm test            # все тесты из каталога test/
npm run test:watch  # тот же набор в watch-режиме
```

Для запуска одного файла:

```bash
node --test test/smoke.test.js
```

## Соглашения

- Файлы именуются `<name>.test.js` и лежат в `bot/test/` с повторением структуры `src/`.
- Один файл = один тестируемый модуль.
- Импорты — относительные из `src/` через `../src/...`.
- Предпочитаем `assert/strict`, не `assert`.
- Fake timers — через встроенный `t.mock.timers` из `node:test`.

## Пример

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { something } from '../src/module.js';

test('something: описание ожидания', () => {
  assert.equal(something(1), 2);
});
```

## Что сейчас в покрытии

| Модуль | Статус | Обязателен по [ПЛАН-РЕФАКТОРИНГА.md](../docs/ПЛАН-РЕФАКТОРИНГА.md) |
|---|---|---|
| `smoke.test.js` | ✅ | инфраструктура (Шаг 0) |
| `stream-error-classifier` | ✅ | Шаг 1 (39 тестов: rules 1–7 + phase-aware + invariants) |
| `stream-handle` | ✅ | Шаг 2 (28 тестов: phase transitions с fake timers, EndReason: natural/cancelled/fatal/transient, multi-process, robustness) |
| `audio-pipeline` | ✅ | Шаг 3 (3 теста: shape + semaphore snapshot + input validation; полный lifecycle — в интеграционных, см. «Что НЕ делаем») |
| `orchestrator` | ✅ | Шаги 3 + 5 + 7 (19 тестов: контракт `commands` — 8 ключей, `Result<T>` форма (`ok/value` / `ok/reason/code`), invalid_argument для всех команд + доменные коды `not_playing`/`no_history`/`not_applicable`, toggle на свежем guildId, идемпотентность `stopAndLeave`, заморозка Ok/Err; `events` voice-lifecycle реакции `onVoiceReady`/`onVoiceGone` → `startSession`/`endSession` + `botVoiceState`, идемпотентность) |
| `queue-manager` | ✅ | Шаг 4 (30 тестов: базовые операции, dedup по `sameTrackContent`, identity-check для `shiftIfHead`/`removeItem`, изоляция guildId, `getQueueSnapshot` defensive copy, `QueueOps` frozen + independent binding) |
| `voice-adapter` | ✅ | Шаг 5 (10 тестов: API shape на пустом state, идемпотентность `leave`, `leave` всегда фаерит `onVoiceGone` даже без активного соединения, shallow-merge колбэков, `__resetVoiceAdapterForTests`, защита от null-колбэков; полный lifecycle с мокированием `@discordjs/voice` — в интеграционных) |
| `player-controller` | ✅ | Шаг 6a (15 тестов: API shape + пустой state, idempotent `ensurePlayer`, `pause`/`resume` false-гарды, `stopPlayer`/`destroyPlayer` семантика, колбэки `onIdle`/`onPlayerError`/`onPlayerStateChange` фаерятся, mapping AudioPlayerStatus → доменные строки, shallow-merge `registerPlayerControllerCallbacks`, бросающий колбэк не ломает emit, `__resetPlayerControllerForTests`) |
| `player-idle-verdict` | ✅ | Шаг 6b (17 тестов: shape verdict, null/undefined input → ignore, полная таблица 2⁴ = 16 комбинаций входов, инварианты `ignore ⇔ !wasPlaying` / `scheduleNext ⇔ !ignore` / импликации `emitTrackFinished` и `forceSkipFromQueue`, именованные кейсы natural/natural+repeat/skip_suppressed±repeat/stream_error±repeat/stream_error+suppressFinished, pure без мутации input) |
| `autoplay-spawn` | ✅ | Шаг 8 (9 тестов: фабрика `createAutoplaySpawner` — валидация deps (null/{} → throws), форма возвращаемого объекта (`spawnAutoplayPlaylist` function, `Object.isFrozen`); чистая `isYoutubeUrlBlockedForAutoplaySpawns` — null-guard для guildId, пустой state → false, current-url match → true, candidate в recent session history → true, candidate отсутствует → false; `createAutoplaySpawnStaleGuard` — детект stale после `bumpAutoplaySpawnGeneration`, `logSpawn` вызван ровно один раз с `detail`-полем) |
| `idle-navigation-state-machine` | — | существует, покрытие добавим параллельно |
| `autoplay-spawn-context` | — | существует, покрытие добавим параллельно |

## Что НЕ делаем в юнит-тестах

- Не мокаем `discord.js` / `@discordjs/voice` (это прерогатива интеграционных тестов, которые в план первого этапа не входят).
- Не делаем сетевых вызовов (yt-dlp, Groq, Pollinations).
- Не пишем в `data/` и не читаем оттуда.

Stateful модули (`player-controller`, `voice-adapter`, `orchestrator`) юнит-покрытием на первом этапе не обязываются — см. «Тестирование» в [ПЛАН-РЕФАКТОРИНГА.md](../docs/ПЛАН-РЕФАКТОРИНГА.md).
