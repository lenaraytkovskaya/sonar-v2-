# Етап 3 — Сайти і реєстри

Ворота: у компаній із порції є контакти із сайту, ЄДР і Prozorro з джерелом та датою; картка це показує.
Послідовні задачі, кожна в окремій гілці та PR після merge попередньої:
3.1 сканер сайтів; 3.2 зіставлення з ЄДР (registry); 3.3 Prozorro; 3.4 конвеєр збагачення та картка.

## Умови виконання

Прочитати AGENTS.md і docs/PLAN.md, розділи 3, 4, 8. Виконати лише 3.1.
Почати від origin/main у feat/task-3.1-site-scanner. Перший коміт зберігає цей промпт.
Не push: рев’юер Claude забере локальну гілку й відкриє PR. Нічний режим: питань не ставити.
Перед завершенням: pnpm lint && pnpm typecheck && pnpm test; DB integration на тимчасовій БД;
Docker build web+worker; оновити dev-стенд через docker compose up --build -d, залишити :58000.
Не чіпати сервер, .env, томи, чужі контейнери; не писати в registry.
Тести без платних запитів; жива перевірка до $0.10, лише за наявності ключа в .env стенда.
Фінальний опис PR українською: «Що зроблено», «Як перевірити», «Що не зроблено», остання строка «Гілка: …».

## ЗАДАЧА 3.1 — сканер сайтов

Модель (миграция Drizzle):
- company_facts: id, company_id, kind (text: например 'edrpou','ipn','language','captcha','schema_org','site_status'),
  value jsonb, source (google/website/registry/prozorro/manual/ai), source_url, found_at, expires_at.
  unique(company_id, kind, source, md5(value::text)).
- contacts: использовать существующую таблицу, source='website', source_url = страница, где найдено.
- settings (сиды миграцией, редактируемые в «Налаштування», блок «Сканер сайтів»):
  scanner.max_pages (по умолчанию 12), scanner.timeout_ms (15000), scanner.max_bytes (2_000_000),
  scanner.user_agent ('SonarBot/1.0 (+https://sonar.cryid.com)'), scanner.ai_fallback (true),
  scanner.ai_max_usd (0.002 за сайт), retention.website_days (365).

Логика (packages/core — чистые функции извлечения; apps/worker — задача site.scan, идемпотентна по company_id+день):
1. robots.txt: уважать Disallow для нашего user-agent и '*'. Запрещено → задача skipped «Сайт забороняє сканування (robots.txt)».
2. Порядок страниц: главная → ссылки того же домена со словами contact/kontakt/контакт/about/про-нас/о-нас/rekvizyty/реквізит/
   impressum/privacy + sitemap.xml (только эти типы) → остальные ссылки главной; стоп, когда найдены email+телефон+мессенджер
   или достигнут scanner.max_pages. Только тот же регистрируемый домен, только http/https, без файлов (pdf, jpg…).
3. Загрузка: fetch с таймаутом и лимитом размера, учёт charset (windows-1251 тоже). Если на главной < 200 символов текста и
   есть признаки SPA — Playwright (chromium headless, в worker-образе) только для этой страницы. Cloudflare/капча-челлендж,
   403/429 → не обходить: статус «сайт недоступний: <причина>» (факт site_status), задача skipped с причиной на украинском.
4. Извлечение: email (включая «[at]», «(at)», «собака», « at  dot »; mailto:; отбрасывать картинки вида x@2x.png и примеры),
   телефоны (tel:, текст; через normalizePhone со страной кампании/компании; отбрасывать даты, коды, ИНН), мессенджеры
   (t.me, telegram.me, wa.me, api.whatsapp.com, viber://, invite-ссылки), соцсети (facebook, instagram, linkedin, youtube,
   tiktok — ссылки на профиль, не share-ссылки), schema.org JSON-LD (Organization/LocalBusiness: telephone, email, address,
   sameAs), формы (form с полями name/email/phone/message; тип капчи: recaptcha v2/v3, hcaptcha, turnstile, нет) → contact kind 'form'
   с URL страницы и факт captcha, коды ЄДРПОУ (8 цифр рядом со словами ЄДРПОУ/ЕДРПОУ/код) и ІПН (10 цифр рядом с ІПН/РНОКПП)
   → факты edrpou/ipn, язык страницы (html lang, иначе по тексту) → факт language.
5. Ранжирование контактов (rank): email на домене сайта > общий email; телефон из schema.org/tel: > из текста; мессенджеры отдельно.
6. ИИ-фолбэк: если после сканирования нет ни email, ни телефона, ни мессенджера и scanner.ai_fallback=true —
   дешёвая модель через существующий runBudgetedRequest (оценка ≤ scanner.ai_max_usd, иначе skipped), на вход — очищенный
   текст до 6000 символов с 3 лучших страниц, ответ JSON по zod-схеме (emails, phones, messengers, edrpou), всё найденное
   ИИ — source='website', meta ai=true в source_url не писать; в facts — source 'ai'. Невалидный ответ → без падения.
7. Статус компании: на время скана 'enriching', после — не менять дальше (финальный статус ставит 3.4).
8. Повтор задачи не создаёт дублей контактов (unique уже есть) и не платит ИИ второй раз (idempotency).
9. Кнопка «Сканувати сайт» в карточке компании (запускает задачу), прогресс и итог видны в «Огляд» и в истории карточки.
Тесты (Vitest, без сети): фикстуры HTML (возьми идеи фикстур из старого репо lenaraytkovskaya/sonar tests/Fixtures/Stage1/html
только как пример структуры, код не копировать; можно написать свои 10–15 фикстур), robots, обфусцированные email,
телефоны UA/PL/DE, windows-1251, schema.org, формы и капчи, ЄДРПОУ/ІПН, порядок страниц и стоп-условие, ИИ-фолбэк на заглушке.
Живая проверка на стенде: просканировать сайты 5 компаний из уже найденной порции (там есть реальные сайты автосервисов Киева),
в ответе — что найдено по каждой, время, была ли ИИ-подсказка и её стоимость.
