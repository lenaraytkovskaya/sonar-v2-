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

Описание появится в задаче 1.1.
