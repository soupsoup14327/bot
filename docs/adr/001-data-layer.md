# ADR-001: Data layer

**Статус:** Accepted
**Дата:** 2026-04-17
**Автор:** команда PAWPAW
**Область:** общий data-слой для бота и будущего API (companion-app)

---

## 1. Context

До сих пор бот был stateless-процессом: всё состояние жило в памяти per-guild и терялось при рестарте. Это устраивало, пока основной функционал — воспроизведение музыки по запросу.

Появляются сценарии, которые **требуют persistence**:

- **Лайки треков** — пользователь жмёт кнопку ❤ и ожидает, что его личный список сохранится между сессиями. Сейчас кнопка работает как stub (возвращает ошибку), потому что некуда писать.
- **История прослушиваний** — нужна как входной сигнал для рекомендера (см. `src/recommender.js` — WP8c заглушка).
- **Recommender-подсказки** — Apple Music-подобная лента «Up Next» из ~5 треков, которая обновляется по мере проигрывания. Seed для неё — последние N треков пользователя/гильдии.
- **Companion-app (планируется)** — отдельный UI, который читает те же данные (лайки, историю) и пишет в них же.

Принятие решения о data-слое **сейчас**, а не в момент появления первой фичи с БД, нужно для:

1. Одинаковой схемы для бота и будущего API — чтобы не переезжать.
2. Явного контракта по миграциям, test-safety, fail-policy — чтобы не наступить на «случайно записали тесты в прод» и «схема в dev отличается от схемы в CI».
3. Зафиксировать, **чего мы НЕ делаем сейчас**, чтобы не скатиться в premature architecture.

Этот ADR **фиксирует решение, но НЕ включает код**. Реализация — отдельным шагом после принятия ADR.

---

## 2. Decision

### 2.1 Процесс

Один Node.js-процесс содержит и бота, и будущий API. Границы обеспечиваются **структурой директорий**, не сетью:

```
bot/src/
  bot/       — Discord-специфичная логика (interaction handlers, slash commands)
  api/       — HTTP endpoints для companion-app (пока пусто)
  core/      — общие use-cases (music, queue, session), не знающие про транспорт
  db/        — schema, migrations, adapter
  recommender/ — stub сейчас, реальная реализация позже
```

Текущие `src/*.js` переедут в эти папки постепенно — **не в рамках этого ADR**.

### 2.2 Конфигурация БД

Единственная переменная окружения: **`DATABASE_URL`**.

Scheme в URL определяет backend:

| URL-пример | Назначение | Когда используется |
|---|---|---|
| `sqlite::memory:` | in-memory SQLite | автотесты (`node --test`) |
| `sqlite:./data/local.db` | file SQLite | локальная разработка (default) |
| `postgres://user:pass@host:5432/db` | Postgres | managed/production-like окружение |

**Default, если переменная не задана**:

- В тестовом окружении (`NODE_ENV=test` либо запуск под `node --test`) → `sqlite::memory:`.
- В остальных случаях → `sqlite:./data/local.db`.

Это гарантирует, что «забыл выставить env» не приведёт к случайной записи в прод.

### 2.3 ORM

**Drizzle** (`drizzle-orm` + `drizzle-kit generate`).

Обоснование:

- Статическая типизация схемы без runtime-оверхеда.
- Генерирует **plain SQL** миграции — их легко ревьюить и применять без ORM.
- Поддерживает SQLite и Postgres одним API (с оговорками, см. §4 Cross-backend discipline).
- Не тянет «magic» и активные рекорды — схема и запросы остаются явными.

Альтернативы, отвергнутые: Prisma (слишком много магии + отдельный клиент), TypeORM (декораторы + сомнительная поддержка SQLite для наших кейсов), raw SQL (теряем типы, но оставляем как escape hatch для сложных кейсов).

### 2.4 Schema ownership

Схема **общая** для бота и API.

На текущем этапе владелец схемы — сам проект, не отдельный app-only слой. Миграции, определения таблиц, types живут в `src/db/` и используются обоими компонентами (бот + API) симметрично.

Если в будущем приложения разделятся на два процесса — пересматриваем отдельно (см. §7 Open Questions).

### 2.5 Что НЕ делаем сейчас

Явно отложено, чтобы не тащить premature complexity:

- **Split bot/app на два процесса** — пока один.
- **Postgres-specific фичи** (JSONB, partial indexes, RLS, trigger-based logic) — схема держится cross-compatible.
- **Connection pooling tuning** (max connections, idle timeout, PgBouncer) — default настройки.
- **Read replicas / sharding** — нет.
- **Encryption at rest на уровне приложения** — полагаемся на БД/ФС.
- **Миграции down / rollback** — Drizzle их не генерирует, forward-only. Для rollback — restore из бэкапа.

---

## 3. Test-safety invariant

**Инвариант:** процесс тестов **не должен иметь возможности записать в production-базу**, даже если по ошибке был задан реальный `DATABASE_URL`.

### 3.1 Обязательный guard

Функция `assertSafeDatabaseUrl(url)` вызывается **до любого открытия соединения** в тестовом режиме (при `NODE_ENV=test` или когда модуль импортируется из `node --test`).

Допустимые URL в тестах — **только один из**:

```
^sqlite::memory:$
^sqlite:\./data/test/[a-z0-9._-]+\.db$
```

Любой другой URL → `process.exit(1)` **немедленно**, с явным сообщением и без stack-trace-исключений, которые тест-раннер может поймать и заглушить.

### 3.2 Где вызывается

- В `src/db/connection.js` (или эквивалент), в самой функции, открывающей соединение.
- В `test/setup.js`, который глобально выполняется перед всеми тестами (через `--test-hook` или явный import в top-level).

Двойная проверка — намеренная: если кто-то обойдёт test-setup (например, напрямую импортирует `connection.js`), guard всё равно сработает при первом `connect()`.

### 3.3 Что guard НЕ проверяет

- Не смотрит «похож ли host на прод» — логика «прод/не прод» ненадёжна.
- Не требует переменной `NODE_ENV`-равной-строго-`test` — в CI может быть `ci`, в smoke-скриптах вообще пусто. Проверка — **по scheme и пути URL**, а не по окружению.

### 3.4 CI integration

CI-пайплайн запускает тесты с явно выставленным `DATABASE_URL=sqlite::memory:` либо с путём в `./data/test/*.db`. Guard это пропустит. Любое другое значение → job падает.

---

## 4. Cross-backend discipline

**Схема обязана оставаться cross-compatible между SQLite и Postgres.**

Это означает:

### 4.1 Типы колонок — только пересечение

Используем только типы, одинаково ведущие себя в обоих backend:

- `integer`, `real`, `text`, `blob` — базовые.
- `timestamp` (Drizzle нормализует в `TEXT ISO8601` для SQLite, `timestamptz` для Postgres).
- `boolean` (Drizzle нормализует в `INTEGER 0/1` для SQLite).

**Запрещены без явного обсуждения в отдельном ADR**:

- `jsonb` (Postgres-only).
- `uuid` как нативный тип (используем `text` + генерация на стороне приложения).
- `array`-типы Postgres.
- `tsvector` / full-text search.

### 4.2 Запросы

- Никаких `ON CONFLICT DO UPDATE` прямой формы — Drizzle-API `.onConflictDoUpdate()` работает в обоих backend, raw SQL — нет.
- Никаких window functions в hot paths.
- Никаких Postgres-специфичных операторов (`@@`, `->>`, `::jsonb`).

Если **реально нужен** Postgres-specific приём — он вводится отдельным ADR с переоценкой cross-backend стратегии (возможно, переход на Postgres-only).

### 4.3 Миграции

Drizzle-kit генерирует SQL, который **должен** применяться к SQLite и Postgres без ручных правок. Проверка — CI-матрицей (см. §6.2).

### 4.4 Цена и смысл

Мы платим за это:

- Более узким набором типов и фич.
- Иногда менее эффективными запросами на Postgres-only железе.

Получаем:

- Локальная разработка без поднятия Postgres.
- Тесты в in-memory SQLite на CI → быстро.
- Realistic option оставаться на SQLite для production, если продукт того не перерастёт.

Это осознанный trade-off. Пересматриваем, если SQLite перестанет тянуть нагрузку или если появится критичная Postgres-only фича.

---

## 5. Migration ownership

### 5.1 Источник схемы

Схема описана в `src/db/schema.ts` (Drizzle definitions). **Единственный** источник правды.

### 5.2 Генерация миграций

```bash
npm run db:generate  # drizzle-kit generate → src/db/migrations/NNNN_*.sql
```

Файлы миграций **коммитятся в репозиторий**. Их ручное редактирование допускается, но ревьюится наравне с кодом.

### 5.3 Применение миграций

**Один исполнитель, одно место, одно время**: при старте процесса, **до** инициализации бота и API.

```
process start
  ├─ 1. load env
  ├─ 2. open DB connection
  ├─ 3. run pending migrations  ← здесь
  ├─ 4. init bot (Discord login, handlers)
  ├─ 5. init api (HTTP listen)
  └─ 6. ready
```

Если миграция упала → процесс **не стартует**. Нет «частично проинициализированного» состояния.

### 5.4 Concurrent safety

Для Postgres — `pg_advisory_lock` вокруг миграции: если два процесса стартуют одновременно, второй ждёт первого и не запускает миграцию повторно.

Для SQLite — single-writer file-lock через сам SQLite достаточен; реалистично одновременный старт двух процессов на одном файле маловероятен и не поддерживается.

### 5.5 Rollback

Drizzle-kit **не генерирует** down-migrations. Rollback = restore из бэкапа. Для локальной dev-БД — удаление `./data/local.db` и регенерация.

---

## 6. Fail-policy

### 6.1 Per use-case таблица

Что делает приложение, если БД **недоступна при запросе** (таймаут, connection error, migration mismatch):

| Use-case | Fail-mode | Обоснование |
|---|---|---|
| **Миграции при старте** | Hard fail: процесс не стартует, exit 1 | Запуск с устаревшей схемой → более опасно, чем не стартовать |
| **Лайк трека** (write) | Soft fail: ephemeral-сообщение "не удалось сохранить лайк", UI не мигает | Не блокируем музыку из-за проблем с БД |
| **Чтение лайков в UI** | Soft fail: скрываем badge «это лайкнуто», не блокируем кнопку | Деградация визуала, не функциональности |
| **Запись в history** (play_end event) | Fire-and-forget + warn-log | История — сигнал для рекомендера, не критичный путь |
| **Чтение history для recommender seed** | Soft fail: рекомендер получает пустой seed и возвращает `[]` | Рекомендер уже устроен как опциональный слой (см. `recommender.js` WP8c) |
| **Companion-app API (GET)** | HTTP 503 с `Retry-After` | Клиент понимает, что временная проблема |
| **Companion-app API (POST/PATCH)** | HTTP 503 + лог | То же, писать повторять клиенту |
| **Guild session state** (транзиент) | НЕ ходит в БД | Session-state остаётся in-memory per-guild — он транзиентный по природе |

### 6.2 Timeout budget

- Все чтения в UI-путях (build panel, render queue) — **≤ 50ms**. Больше → считаем fail и идём по soft-fail ветке.
- Записи — best effort без ожидания UI (асинхронные, не блокируют interaction reply).

### 6.3 Observability baseline

Минимум метрик, без premature APM:

- **Counter:** `db_query_total{result="ok|timeout|error"}`.
- **Histogram:** длительность запроса, buckets `[5ms, 25ms, 100ms, 500ms]`.
- **Slow-query warn-log:** любой запрос > 200ms → `console.warn` с текстом запроса (без значений параметров, чтобы не лить PII).
- **Health endpoint:** `/health/db` возвращает `200 { latency_ms }` или `503` если пинг БД упал.

Реализация — через обычные console-логи или через текстовые метрики в `data/metrics/` (`METRICS_TXT_ENABLED=1`). Без Prometheus/OpenTelemetry на этом этапе.

---

## 7. Consequences

### 7.1 Что выигрываем

- **Zero friction для dev/test**: SQLite file, никакой внешней инфры.
- **Realistic upgrade path в прод**: одна переменная, тот же код.
- **Test isolation** через `sqlite::memory:` — параллельные suites без взаимных помех.
- **Honest constraints**: cross-backend discipline заставляет писать портируемый SQL.
- **Migration as code**: схема живёт рядом с исходниками, diff виден в PR.

### 7.2 Чем платим

- Ограничения на SQL-фичи (см. §4).
- Необходимость прогонять CI на **обоих** backend — дополнительный job.
- Fail-policy нужно держать в голове при написании каждого use-case, который читает/пишет БД.
- Одна `DATABASE_URL` для бота и API → если захочется разделить БД по компонентам, потребуется переезд.

### 7.3 CI-матрица

Два отдельных job, один pipeline:

- `test-sqlite` — `DATABASE_URL=sqlite::memory:`, прогон `node --test`.
- `test-postgres` — `DATABASE_URL=postgres://...`, с поднятым Postgres в service container, прогон того же `node --test`.

Оба обязательны для merge. Если один падает, а другой проходит — это **и есть** сигнал нарушенной cross-backend discipline (§4).

---

## 8. Hygiene

- `data/` добавляется в `.gitignore` и `.dockerignore` — SQLite-файлы не должны попадать в репо/образ.
- `data/test/` чистится перед каждым test-run (через `beforeEach`/`setup.js`).
- Бэкап локальной dev-БД — опционально, на усмотрение разработчика (это не критичные данные).

---

## 9. Open questions

Отложено, пересматривается при появлении триггеров:

1. **Нужен ли вообще production Postgres?**
   Триггер: реальный продовый деплой с требованиями HA / managed / > 1 writer.

2. **Разделять ли бот и API на два процесса?**
   Триггер: появление разных release cadence, изоляция ресурсов, отдельный scaling API.

3. **Выносить ли recommender в отдельный сервис?**
   Триггер: recommender начинает нуждаться в GPU / больших моделях / долгих pipelines, где держать его в main-процессе становится тяжело.

4. **Где живёт production БД, если прод появится?**
   Опции: VPS + managed Postgres, Neon/Supabase, или остаться на SQLite-file при single-deploy топологии.

5. **Нужен ли отдельный schema owner?**
   Триггер: разделение на два процесса + желание, чтобы один из них был single-writer для схемы.

---

## 10. Revisit

Этот ADR пересматривается, если:

- SQLite начинает упираться в потолок по записи/чтению на realistic нагрузке → рассмотрение Postgres-only.
- Появляется фича, требующая jsonb/tsvector/array → отдельный ADR о смене cross-backend политики.
- Бот и API расходятся по release cadence / инфре → ADR о split.
- Меняется ORM (Drizzle перестал устраивать) → ADR о миграции.

Пересмотр оформляется как новый ADR (например, ADR-002), который явно супersedes ADR-001. Старый не удаляется — остаётся как исторический контекст.

---

## Ссылки

- `src/recommender.js` — stub с контрактом `getNextTracks(seed, options)` (WP8c).
- `docs/АРХИТЕКТУРА.md` — общий обзор модулей (обновится после реализации data-слоя).
- `docs/ПЕРЕМЕННЫЕ.md` — реестр env-переменных (обновится после добавления `DATABASE_URL` в `src/`).
- `.env.example` — практический фрагмент с примерами `DATABASE_URL`.
