# Шаг 1 — каркас

Ворота шага: CRM открывается на https://sonar.cryid.com, вход по паролю, меню и темы работают, на «Огляд» видны живые задачи, ИИ-помощник работает в одном поле.

Порядок: 1.1 → (1.2 и 1.3 параллельно) → 1.4. Каждая задача — отдельная ветка и PR. Перед началом прочитай `AGENTS.md` и `docs/PLAN.md`.

---

## Задача 1.1 — монорепо, Docker, базы

**Контекст.** Репозиторий пустой (есть только документы). Сервер: Ubuntu 22.04, Docker 29 + Compose. Postgres 17 уже работает в томе `sonar-server_postgres`; в нём будут две базы: `registry` (ЄДР, заполнена, только чтение) и `sonar` (пустая, наша). Структура таблиц ЄДР — в `docs/registry-schema.sql` (добавит владелец).

**Задача.**
1. pnpm workspaces: `apps/web`, `apps/worker`, `packages/db`, `packages/core`. TypeScript strict, ESLint (flat config) + Prettier, Vitest. Корневые скрипты: `dev`, `build`, `lint`, `typecheck`, `test`, `db:generate`, `db:migrate`.
2. `apps/web` — Next.js 15 (App Router), пока одна страница «Sonar» и `GET /api/health` → `{ ok: true, db: true|false }`.
3. `apps/worker` — процесс, который подключается к базе, пишет в лог «worker started» и корректно завершается по SIGTERM.
4. `packages/db` — Drizzle: клиент `sonarDb` (DATABASE_URL) и клиент `registryDb` (REGISTRY_DATABASE_URL) с `default_transaction_read_only=on`. Первая миграция: `users` (id, email unique, name, password_hash, created_at) и `settings` (key text pk, value jsonb, updated_at).
5. `packages/core` — функция `normalizePhone(raw, defaultCountry)` на libphonenumber-js → E.164 или null, с тестами (украинский, польский, немецкий, американский номер, мусор).
6. `docker/compose.yml`:
   - `postgres`: `postgres:17-bookworm`, **внешний** том `sonar-server_postgres` (`external: true`), healthcheck, без публикации порта наружу;
   - `web`: порт `127.0.0.1:58000:3000` (на этот порт уже смотрит nginx sonar.cryid.com);
   - `worker`;
   - `waha`: образ devlikeapro/waha с **закреплённой версией** (не latest), API-ключ из `WAHA_API_KEY`, том для сессий, порт только внутри сети.
   - `docker/compose.dev.yml` для локальной разработки: свой пустой том Postgres и скрипт, создающий базы `sonar` и `registry` (registry — из `docs/registry-schema.sql`, без данных).
7. Dockerfile для web и worker (multi-stage, node:22-slim). Миграции применяются при старте worker.
8. README: как запустить локально и на сервере (3–5 команд).

**Не трогать.** Не создавать таблиц сверх `users` и `settings`. Не писать в `registry`.

**Готово, когда.** `pnpm lint && pnpm typecheck && pnpm test` проходят; `docker compose -f docker/compose.yml -f docker/compose.dev.yml up` поднимает всё локально; `/api/health` отвечает `db: true`.

**Как проверить.** Открыть http://localhost:58000/api/health.

---

## Задача 1.2 — оболочка CRM: темы, меню, вход

**Контекст.** После 1.1. Внешний вид — по разделу 5 `docs/PLAN.md` (меню, токены, шрифты, размеры).

**Задача.**
1. Tailwind v4 + shadcn/ui. Дизайн-токены из таблицы PLAN как CSS-переменные для светлой и тёмной темы; next-themes (светла / темна / як у системі), выбор сохраняется.
2. Шрифты через next/font: Inter (текст) и Manrope 700 (заголовки), subsets latin + cyrillic.
3. Словарь `apps/web/src/i18n/uk.ts`; все тексты интерфейса — только оттуда.
4. Layout: меню слева (Огляд, Кампанії, Компанії, Вхідні, Канали, Фінанси; внизу Налаштування), логотип-радар + «Sonar», переключатель темы, меню пользователя с «Вийти». На ширине < 768px меню сверху/в выезжающей панели, без горизонтальной прокрутки.
5. Страницы-заглушки: `/`, `/campaigns`, `/companies`, `/companies/[id]`, `/inbox`, `/channels`, `/finance`, `/settings` — заголовок, короткое описание и пустое состояние («Тут з'являться…»).
6. Вход: страница `/login`, пароль с argon2, сессия в httpOnly-cookie (iron-session, `AUTH_SECRET`). Middleware закрывает всё, кроме `/login`, `/api/health`, `/api/webhooks/*`. Скрипт `pnpm user:create` (email, имя, пароль вводится в консоли).
7. Общие компоненты: `StatusPill` (ok/run/wait/err/idle), `Card`, `PageHeader`, `EmptyState`.

**Не трогать.** Логику кампаний, компаний и т.д. — только оболочка.

**Готово, когда.** Вход и выход работают; все пункты меню открываются; тема переключается и сохраняется; на 375px всё читается без горизонтальной прокрутки.

**Как проверить.** `pnpm user:create`, войти, пройти все пункты меню в обеих темах и на телефонной ширине.

---

## Задача 1.3 — задачи и очередь, живой «Огляд»

**Контекст.** После 1.1. Принцип: каждая внешняя операция — задача со статусом и причиной (AGENTS.md).

**Задача.**
1. Миграция `tasks`: id, type, status (queued/running/done/skipped/failed/paused), subject_type, subject_id, batch_id (nullable), idempotency_key (unique), attempts, reason_code, reason_uk, payload jsonb, result jsonb, created_at, started_at, finished_at.
2. Worker: pg-boss; общая обёртка `runTask(type, handler)` — ставит running, вызывает обработчик, пишет done/skipped/failed с причиной; повторы по настройкам типа; повторная постановка с тем же idempotency_key не создаёт дубль.
3. Пробная задача `system.registry_ping`: считает строки в таблицах ЄДР (`registryDb`, только чтение) и пишет в result. Запуск при старте worker и раз в час.
4. API: `GET /api/tasks?status=&type=`, `POST /api/tasks/:id/retry` (идемпотентно: повтор уже стоящей в очереди задачи ничего не делает).
5. «Огляд»: блок «Зараз у роботі» (queued/running по типам с количеством и прогрессом) и «Помилки та паузи» (failed: название, причина на украинском, кнопка «Повторити»). Обновление раз в 3 секунды.
6. Тесты: переходы статусов в runTask, идемпотентность повтора.

**Не трогать.** Конвейер компаний (это шаг 2+).

**Готово, когда.** На «Огляд» видно, как `system.registry_ping` проходит queued → running → done; если сломать REGISTRY_DATABASE_URL — появляется failed с понятной причиной, «Повторити» после исправления работает.

---

## Задача 1.4 — OpenRouter, учёт расходов, ИИ-помощник

**Контекст.** После 1.2. Принципы: платный запрос — сначала бюджет, потом запрос, потом фактическая цена; ИИ-помощник у каждого текстового поля.

**Задача.**
1. Миграции: `services` (code, name, plan, monthly_limit_usd, note) с начальными записями: google_places, openrouter, resend, twocaptcha, iproyal, waha, server; `spend_events` (service_code, units, cost_usd, task_id nullable, meta jsonb, created_at).
2. `packages/core/budget`: `checkBudget(service, estimateUsd)` — сравнивает с лимитом сервиса и месячным бюджетом (настройка `budget.monthly_usd`, по умолчанию из `MONTHLY_BUDGET_USD`); при превышении — ошибка `BudgetExceeded` с текстом на украинском.
3. OpenRouter-клиент: модели из настроек `ai.model.cheap` и `ai.model.strong`; фактическая стоимость — из usage в ответе OpenRouter → `spend_events`.
4. «Налаштування», разделы:
   - «ІІ»: выбор дешёвой и сильной модели из списка OpenRouter `/models` (с ценой за 1M токенов, сортировка по цене);
   - «Бюджет»: месячный лимит;
   - «Про нас»: текст о компании-отправителе (будет использоваться в письмах) — первое поле с ИИ-помощником.
5. Компонент `AiAssist`: кнопка рядом с полем → меню действий (по умолчанию: «Покращити», «Коротше», «Тепліше», «Іншою мовою…», «Своя інструкція…»), предпросмотр результата, «Застосувати» / «Скасувати». API `POST /api/ai/assist` (action, text, context) → дешёвая модель, проверка бюджета, запись расхода.
6. Тесты: checkBudget (в пределах / превышение месячного / превышение сервиса), запись расхода из ответа-заглушки.

**Не трогать.** Страницу «Фінанси» (шаг 7) — пока только запись расходов.

**Готово, когда.** В «Налаштування» выбраны модели; в поле «Про нас» ИИ-помощник переписывает текст; в базе появляется запись в `spend_events` с реальной стоимостью; при лимите 0 помощник показывает понятное сообщение о бюджете.
