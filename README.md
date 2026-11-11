# Sonar v2

CRM для поиска компаний и контакта с ними: Google Maps → сайт → реестры → соцсети → ИИ-анализ и скоринг → отправка → переписка.

- План и решения: [docs/PLAN.md](docs/PLAN.md)
- Правила для агента-разработчика: [AGENTS.md](AGENTS.md)
- Задачи для Sol: [docs/prompts/](docs/prompts/)

## Структура

```
apps/web        CRM (Next.js)
apps/worker     фоновые задачи (pg-boss)
packages/db     схема и миграции (Drizzle), клиент registry
packages/core   общая логика
docker/         compose и Dockerfile
```

## Запуск

Потрібні Node 22, pnpm 10 (через `corepack enable`) та Docker Compose v2+.

### Локально (порожні бази)

```sh
cp .env.example .env # заповніть POSTGRES_USER, POSTGRES_PASSWORD, обидва URL (host postgres), WAHA_API_KEY
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
export COMPOSE_ENV_FILES=.env
docker compose -f docker/compose.yml -f docker/compose.dev.yml up --build -d
```

Відкрийте http://localhost:58000 та http://localhost:58000/api/health (`db: true`).
Worker застосовує міграції при старті. Локальний том `sonar-v2-dev-postgres` ізольований;
схема `registry` створюється без даних лише при першому запуску порожнього тому.
WAHA використовує закріплений AMD64-образ (емуляція Docker Desktop на ARM Mac).
Для запуску без контейнерів: експортуйте URL доступного локального Postgres та виконайте
`pnpm db:migrate && pnpm dev` (web на порту 3000). `pnpm db:generate` створює міграції.

### Сервер (лише після перевірки оператором)

Існуючий PostgreSQL має бути зупинений перед підключенням його тому до нового контейнера;
ніколи не запускайте два PostgreSQL на одному томі. База `sonar` має існувати, а користувач
`REGISTRY_DATABASE_URL` — мати лише SELECT у `registry`. Ініціалізація dev на сервері заборонена.

Розгортання — тільки через git. На сервері код лежить у `/opt/sonar-v2` і ніколи не редагується вручну.
systemd-таймер `sonar-deploy` щохвилини запускає `scripts/deploy.sh`: якщо `origin/main` змінився —
`git merge --ff-only`, `docker compose up --build -d`, перевірка `/api/health`. Журнал: `/var/log/sonar-deploy.log`.

Одноразове встановлення таймера:

```sh
systemctl link /opt/sonar-v2/deploy/sonar-deploy.service
systemctl enable --now /opt/sonar-v2/deploy/sonar-deploy.timer
```

Основний Compose використовує виключно зовнішній том `sonar-server_postgres`. Не видаляйте серверні томи.
Postgres доступний лише на `127.0.0.1:55432`; ззовні — тільки через Tailscale
(`tailscale serve --bg --tcp 55432 tcp://127.0.0.1:55432`) під роллю лише для читання `viewer`.
WAHA не публікує портів.
