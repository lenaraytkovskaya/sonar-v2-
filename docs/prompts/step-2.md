Этап 2: кампании и поиск компаний в Google Places. Этап 1 слит в main (fe3cb59).
Начни с: git checkout main && git pull. Прочитай AGENTS.md и docs/PLAN.md (разделы 3, 5, 8).
Сохрани этот текст как docs/prompts/step-2.md в PR задачи 2.1.

Ворота этапа: в CRM создаю кампанию (с помощью ИИ), запускаю порцию на 20 компаний,
вижу прогресс на «Огляд», компании появляются в списке с сайтом и телефоном,
расходы Google посчитаны и не превышают лимит кампании и месяца.

ПОРЯДОК И ВЕТКИ. Задачи 2.1 → 2.2 → 2.3 → 2.4, каждая в своей ветке и своём PR.
Ветку каждой следующей задачи делай от ветки предыдущей; базу PR ставь на ветку
предыдущей задачи (в описании: «зависит от #N»). PR не сливай, сервер не трогай.

ПЛАТНЫЕ ЗАПРОСЫ. В тестах — только заглушки. Реальный запрос к Google — один раз,
на dev-стенде этого Mac, порция 20 компаний, лимит кампании $0.50, и только если
GOOGLE_PLACES_API_KEY есть в .env стенда. Результат и фактическую стоимость — в описание PR 2.3.

────────────────────────────────────────
2.1 Долги этапа 1 (маленький PR)
1. Бюджет (packages/db/src/budget.ts): блокировку держать только на время
   проверки и резерва (pg_advisory_xact_lock внутри транзакции резерва),
   НЕ во время внешнего запроса. Резерв в tasks.result уже учитывается в сумме —
   параллельные запросы не должны превысить лимит. Тест: 10 параллельных
   запросов при лимите на 3 — проходят ровно 3.
2. «Помилки та паузи»: показывать только последнюю ошибку каждого типа задачи
   (с числом повторений), кнопка «Сховати» (поле dismissed_at в tasks, пишет в activity_log).
3. Опрос /api/tasks: один общий опрос на страницу (контекст/хук на уровне Shell),
   а не отдельный в меню и в «Огляд».

────────────────────────────────────────
2.2 Кампании (страница «Кампанії»)
Модель (миграция Drizzle):
- campaigns: id, name, country_code (ISO-2), language_code, cities text[], queries text[],
  offer text, batch_size int (20/50/100/200), budget_usd numeric(20,10),
  channels jsonb (email/telegram/whatsapp/forms: bool), send_mode enum (auto/approval/manual),
  scoring_weights jsonb, status enum (draft/active/paused/archived),
  created_by → users, created_at, updated_at.
- campaign_presets: id, name, data jsonb (готовые шаблоны кампаний), 2–3 начальные записи
  (например «Авто — Україна», «Салони краси — Польща»).
UI по разделу 5 PLAN: список кампаний слева, справа форма настроек; чипы запросов и городов;
ползунки весов скоринга (сам скоринг — на этапе 4, сейчас только хранить);
кнопки «Зберегти», «Запустити порцію» (активна, когда есть запросы и города), «Пауза».
ИИ-помощник (дешёвая модель, через существующий учёт расходов):
- кнопка «Підібрати за описом»: я пишу одну фразу («автосервіси Києва та області») →
  ИИ возвращает JSON: name, country_code, language_code, cities[], queries[] (на языке страны,
  с синонимами, 5–10 штук), offer (черновик). Показать предпросмотр, «Застосувати».
- AiAssist у поля offer (как «Про нас»).
- Ответ ИИ валидировать по схеме (zod); невалидный → понятная ошибка, без падения.
Все действия пишутся в activity_log. Тесты: валидация формы и схемы ответа ИИ.

────────────────────────────────────────
2.3 Поиск в Google Places
API: Places API (New) Text Search — POST https://places.googleapis.com/v1/places:searchText,
заголовки X-Goog-Api-Key и X-Goog-FieldMask; тело: textQuery «<запрос> <город>»,
languageCode и regionCode из кампании, pageSize 20, pageToken для следующих страниц
(максимум 3 страницы на запрос).
Профили полей — в settings ('google.field_profiles'), выбор профиля в кампании:
- «Контакти» (по умолчанию): places.id, displayName, formattedAddress, addressComponents,
  location, types, primaryType, businessStatus, googleMapsUri, websiteUri,
  nationalPhoneNumber, internationalPhoneNumber, rating, userRatingCount, nextPageToken.
- «Базовий» (дешевле, без телефона и сайта).
У каждого профиля — цена за запрос в USD (настройка, редактируется в «Налаштування»).
Значения по умолчанию возьми с официальной страницы цен Google Places API (New) для
соответствующего уровня SKU и укажи в PR ссылку и дату. Сайт мне нужен всегда — профиль
по умолчанию обязан включать websiteUri.
Деньги: каждый запрос к Google — через runBudgetedRequest (service google_places,
оценка = цена профиля), плюс лимит budget_usd кампании (сумма spend_events задач её порций).
Если лимит исчерпан — порция paused с причиной на украинском.
Модель:
- batches: id, campaign_id, number, size, status (queued/running/done/paused/failed),
  found_new, found_known, requests, cost_usd, reason_uk, started_at, finished_at.
- companies: id, place_id unique, name, primary_type, types text[], address, city,
  country_code, lat, lng, website, domain, google_maps_uri, rating, ratings_count,
  business_status, status (new/enriching/ready/contacted/replied/interested/deal/refused/do_not_contact,
  по умолчанию new), google_expires_at, created_at, updated_at.
- campaign_companies: campaign_id, company_id, batch_id, added_at; unique(campaign_id, company_id).
- contacts: id, company_id, kind (email/phone/telegram/whatsapp/viber/form/social/website),
  value, normalized, source (google/website/registry/prozorro/manual), source_url,
  verified bool, rank int, found_at; unique(company_id, kind, normalized).
  Телефоны — через normalizePhone (страна кампании), сайт — нормализованный домен.
Логика порции (задача google.batch, идемпотентная по batch_id):
- перебирать пары запрос × город и страницы, пока не набрано batch_size НОВЫХ для кампании
  компаний или не кончились результаты (тогда done с пометкой «результати вичерпано»);
- дубли по place_id; компания, уже известная из другой кампании, привязывается, но
  считается в found_known; статус permanently closed — пропускать;
- хранение: place_id бессрочно, остальные поля Google — google_expires_at = now + N дней
  (N из settings 'retention.google_days', по умолчанию 365);
- прогресс порции обновлять после каждого запроса.
«Огляд»: блок порции «Пошук у Google Maps: X / Y» с прогрессом и стоимостью.
Тесты (с заглушкой Google): пагинация, дедупликация, остановка по batch_size,
остановка по лимиту кампании, нормализация телефонов и домена, повтор задачи без дублей.

────────────────────────────────────────
2.4 Компании (страницы «Компанії» и карточка)
- «Компанії»: таблица по разделу 5 PLAN — компания (название, город, тип, рейтинг),
  контакты (сайт, телефон), кампания, статус, дата; фильтры: кампания, город, статус,
  «є сайт», «є телефон»; поиск по названию/домену/телефону; пагинация на сервере; экспорт CSV.
- Поиск обычными словами (ИИ-помощник, дешёвая модель): «СТО з сайтом і рейтингом від 4.5»
  → ИИ превращает в фильтры (JSON по схеме), показывает их, я подтверждаю.
- Карточка компании: данные Google, контакты с источником и датой, кампании и порции,
  история из activity_log, ссылка на Google Maps. Скоринг и ЄДР — пока заглушки («етап 3–4»).
- Страница кампании: список порций со статусом, найдено/новых/известных, запросов, стоимостью.
Тесты: фильтры и поиск (SQL), схема ИИ-фильтров, CSV.

────────────────────────────────────────
В КОНЦЕ:
- локальная ветка review/step-2 = main + все ветки этапа 2 (не пушить);
- dev-стенд поднят на http://localhost:58000 и оставлен запущенным;
- в стенде есть одна реальная порция на 20 компаний (если был ключ) или порция
  с заглушкой Google;
- ответ: ссылки на PR, что проверено, фактическая стоимость реального запроса,
  что не сделано.
