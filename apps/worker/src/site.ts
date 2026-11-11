import { chromium } from 'playwright';
import {
  extractSitePage,
  decodeSiteHtml,
  orderSiteUrls,
  shouldStopSiteScan,
  normalizeAiSiteResult,
  createOpenRouterClient,
  BudgetExceeded,
  OpenRouterError,
  PaidHttpError,
  type TextModel,
  type CountryCode,
  type SitePage,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { runBudgetedRequest, BillingUncertain } from '@sonar/db/budget';
import {
  boss,
  runTask,
  logActivity,
  TaskFailure,
  type TaskOutcome,
} from '@sonar/db/tasks';
import { SiteHttp, SiteUnavailable } from './site-http.js';
type Page = SitePage & { url: string };
type Config = Record<string, unknown>;
export async function renderSitePage(
  http: SiteHttp,
  url: string,
  html: string,
): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  let failure: unknown;
  let requests = 0;
  let bytes = Buffer.byteLength(html);
  try {
    const context = await browser.newContext({
      userAgent: http.settings.userAgent,
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        if (
          ++requests > 40 ||
          request.method() !== 'GET' ||
          ['image', 'media', 'font', 'stylesheet'].includes(
            request.resourceType(),
          )
        )
          return await route.abort();
        const response =
          request.url() === url
            ? {
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: Buffer.from(html),
              }
            : await http.read(request.url());
        if (response.status >= 400) return await route.abort();
        if (request.url() !== url) bytes += response.body.length;
        if (bytes > http.settings.maxBytes)
          throw new SiteUnavailable(
            'size_limit',
            'Сайт недоступний: сторінка перевищує ліміт розміру.',
          );
        await route.fulfill({
          status: response.status,
          contentType: response.contentType,
          body: Buffer.from(response.body),
        });
      } catch (error) {
        if (error instanceof SiteUnavailable && error.code !== 'unsafe_url')
          failure = error;
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: http.settings.timeoutMs,
    });
    if (failure) throw failure;
    const result = await page.content();
    if (Buffer.byteLength(result) > http.settings.maxBytes)
      throw new SiteUnavailable(
        'size_limit',
        'Сайт недоступний: сторінка перевищує ліміт розміру.',
      );
    return result;
  } catch (error) {
    if (error instanceof SiteUnavailable) throw error;
    throw new SiteUnavailable(
      'render_unavailable',
      'Сайт недоступний: не вдалося завантажити динамічну сторінку.',
    );
  } finally {
    await browser.close();
  }
}
export async function scanSite(
  http: SiteHttp,
  country: CountryCode,
  onPage: (page: Page, count: number) => Promise<void>,
  render = renderSitePage,
) {
  const pages: Page[] = [];
  let urls = [http.home];
  for (
    let index = 0;
    index < urls.length && index < http.settings.maxPages;
    index++
  ) {
    const response = await http.read(urls[index]!);
    if (response.status >= 400) {
      if (!index)
        throw new SiteUnavailable(
          `http_${response.status}`,
          `Сайт недоступний: сервер повернув ${response.status}.`,
        );
      continue;
    }
    if (!/text\/html|application\/xhtml/i.test(response.contentType)) {
      if (!index)
        throw new SiteUnavailable(
          'not_html',
          'Сайт недоступний: головна сторінка не є HTML.',
        );
      continue;
    }
    let html = decodeSiteHtml(response.body, response.contentType);
    let page = extractSitePage(html, { url: response.url, country });
    if (page.challenge)
      throw new SiteUnavailable(
        'challenge',
        'Сайт недоступний: захист від ботів або перевірка CAPTCHA.',
      );
    if (!index && page.text.length < 200 && page.spa) {
      html = await render(http, response.url, html);
      page = extractSitePage(html, { url: response.url, country });
      if (page.challenge)
        throw new SiteUnavailable(
          'challenge',
          'Сайт недоступний: захист від ботів або перевірка CAPTCHA.',
        );
    }
    const found = { ...page, url: response.url };
    pages.push(found);
    await onPage(found, pages.length);
    if (
      shouldStopSiteScan(
        pages.flatMap((entry) => entry.contacts),
        pages.length,
        http.settings.maxPages,
      )
    )
      break;
    if (!index) {
      let sitemapUrls: string[] = [];
      const sitemap = await http.read(
        new URL('/sitemap.xml', response.url).href,
      );
      if (sitemap.status === 200)
        sitemapUrls = [
          ...decodeSiteHtml(sitemap.body, sitemap.contentType).matchAll(
            /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi,
          ),
        ].map((match) => match[1]!.trim().replace(/&amp;/g, '&'));
      urls = [
        urls[0]!,
        ...orderSiteUrls(response.url, page.links, sitemapUrls).filter(
          (url) => url !== response.url && url !== urls[0],
        ),
      ];
    }
  }
  return pages;
}
export function aiEvidencePage(
  value: string,
  pages: Page[],
  phone = false,
): Page | undefined {
  const canonical = (text: string) =>
    text
      .toLowerCase()
      .replace(/https?:\/\//g, '')
      .replace(/\[at\]|\(at\)|\bat\b|собака/gu, '@')
      .replace(/\[dot\]|\(dot\)|\bdot\b/gu, '.')
      .replace(/[^\p{L}\p{N}]/gu, '');
  const key = phone ? value.replace(/\D/g, '').slice(-9) : canonical(value);
  return key
    ? pages.find((page) => {
        const evidence = `${page.text} ${page.links.join(' ')}`;
        return (
          phone ? evidence.replace(/\D/g, '') : canonical(evidence)
        ).includes(key);
      })
    : undefined;
}
export async function aiSiteFallback(
  pages: Page[],
  country: CountryCode,
  config: Config,
  taskId: string,
  client?: ReturnType<typeof createOpenRouterClient>,
) {
  const empty = (aiStatus: string) => ({
    contacts: [],
    facts: [],
    aiUsed: false,
    costUsd: 0,
    aiStatus,
  });
  if (!config['scanner.ai_fallback']) return empty('disabled');
  if (
    pages.some((page) =>
      page.contacts.some((contact) =>
        ['email', 'phone', 'telegram', 'whatsapp', 'viber'].includes(
          contact.kind,
        ),
      ),
    )
  )
    return empty('not_needed');
  if (!client && !process.env.OPENROUTER_API_KEY) return empty('missing_key');
  const model = (config['ai.models'] as TextModel[] | undefined)?.find(
    (entry) => entry.id === config['ai.model.cheap'],
  );
  if (!model) return empty('missing_model');
  const maxTokens = Number(config['scanner.ai_max_tokens']);
  const prompt = config['scanner.ai_prompt'];
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 10000 ||
    typeof prompt !== 'string'
  )
    return empty('invalid_config');
  const messages = [
    { role: 'system' as const, content: prompt },
    {
      role: 'user' as const,
      content: JSON.stringify(
        pages.slice(0, 3).map((page) => ({
          url: page.url,
          text: page.text.slice(
            0,
            Math.floor(6000 / Math.min(3, pages.length)),
          ),
        })),
      ),
    },
  ];
  const estimate =
    (Buffer.byteLength(JSON.stringify(messages)) + 100) * model.promptUsd +
    maxTokens * model.completionUsd +
    model.requestUsd;
  if (
    !Number.isFinite(estimate) ||
    estimate < 0 ||
    estimate > Number(config['scanner.ai_max_usd'])
  )
    return empty('price_limit');
  try {
    const response = await runBudgetedRequest(
      'openrouter',
      estimate,
      taskId,
      () =>
        (
          client ?? createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? '')
        ).complete(model.id, messages, maxTokens),
    );
    let result;
    try {
      result = normalizeAiSiteResult(
        JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, '')),
        { url: pages[0]!.url, country },
      );
    } catch {
      /* Keep scan results when AI returns invalid JSON. */
    }
    return {
      contacts:
        result?.contacts.filter((contact) =>
          aiEvidencePage(
            contact.value,
            pages.slice(0, 3),
            contact.kind === 'phone',
          ),
        ) ?? [],
      facts:
        result?.facts.filter((fact) =>
          aiEvidencePage(String(fact.value), pages.slice(0, 3)),
        ) ?? [],
      aiUsed: true,
      costUsd: response.costUsd,
      aiStatus: result ? 'done' : 'invalid_response',
    };
  } catch (error) {
    if (
      error instanceof BillingUncertain ||
      (error instanceof OpenRouterError && error.code === 'network_unavailable')
    )
      throw new BillingUncertain();
    if (error instanceof OpenRouterError && error.billing)
      return {
        ...empty('invalid_response'),
        aiUsed: true,
        costUsd: error.billing.costUsd ?? estimate,
      };
    if (error instanceof BudgetExceeded) return empty('budget_exceeded');
    if (error instanceof PaidHttpError || error instanceof OpenRouterError)
      return empty('request_failed');
    throw error;
  }
}
export async function runSiteScan(
  payload: { companyId: string },
  taskId: string,
): Promise<TaskOutcome> {
  const started = Date.now();
  const companyId = payload.companyId;
  if (!companyId)
    throw new TaskFailure('company_missing', 'Компанію не знайдено.');
  const client = await sonarPool.connect();
  const {
    rows: [lock],
  } = await client.query(
    'select pg_try_advisory_lock(hashtextextended($1,0)) as locked',
    [`site.scan:${companyId}`],
  );
  if (!lock.locked) {
    client.release();
    return {
      status: 'skipped',
      reasonCode: 'scan_busy',
      reasonUk: 'Сайт компанії вже сканується.',
    };
  }
  try {
    const {
      rows: [company],
    } = await client.query(
      'select c.*, (select ca.country_code from campaign_companies cc join campaigns ca on ca.id=cc.campaign_id where cc.company_id=c.id order by cc.added_at desc limit 1) as campaign_country from companies c where c.id=$1',
      [companyId],
    );
    if (!company?.website)
      return {
        status: 'skipped',
        reasonCode: 'website_missing',
        reasonUk: 'У компанії немає сайту.',
      };
    const { rows } = await client.query(
      "select key,value from settings where key like 'scanner.%' or key like 'ai.%' or key='retention.website_days'",
    );
    const config: Config = Object.fromEntries(
      rows.map((row) => [row.key, row.value]),
    );
    const settings = {
      maxPages: Number(config['scanner.max_pages']),
      timeoutMs: Number(config['scanner.timeout_ms']),
      maxBytes: Number(config['scanner.max_bytes']),
      userAgent: String(config['scanner.user_agent']),
    };
    if (
      ![
        settings.maxPages,
        settings.timeoutMs,
        settings.maxBytes,
        Number(config['retention.website_days']),
      ].every((value) => Number.isSafeInteger(value) && value > 0)
    )
      throw new TaskFailure(
        'scanner_config_invalid',
        'Перевірте налаштування сканера сайтів.',
      );
    const country = (company.campaign_country ??
      company.country_code) as CountryCode;
    await client.query(
      "update companies set status='enriching',updated_at=now() where id=$1 and status in ('new','enriching')",
      [companyId],
    );
    await logActivity(
      'site.scan.started',
      'company',
      companyId,
      null,
      { taskId },
      client,
    );
    let contacts = 0;
    let pageCount = 0;
    const foundContacts = new Set<string>();
    const contactPage = /(?:contact|kontakt|контакт|feedback|zvorotn|зворотн)/i;
    let formSaved = false,
      formIsContactPage = false;
    const persist = async (
      page: Pick<Page, 'url' | 'contacts' | 'facts'>,
      ai = false,
    ) => {
      for (const contact of page.contacts) {
        // One contact form per site: prefer a contact page, otherwise keep the first one found.
        if (contact.kind === 'form') {
          let path = page.url;
          try {
            path = decodeURI(page.url);
          } catch {
            /* Keep the raw URL when it is not valid percent-encoding. */
          }
          const onContactPage = contactPage.test(path);
          if (formSaved && !(onContactPage && !formIsContactPage)) continue;
          await client.query(
            "delete from contacts where company_id=$1 and kind='form' and source='website'",
            [companyId],
          );
          foundContacts.forEach(
            (key) => key.startsWith('form:') && foundContacts.delete(key),
          );
          formSaved = true;
          formIsContactPage = onContactPage;
        }
        foundContacts.add(`${contact.kind}:${contact.value}`);
        await client.query(
          `insert into contacts(company_id,kind,value,normalized,source,source_url,rank,meta) values($1,$2,$3,$3,'website',$4,$5,$6) on conflict(company_id,kind,normalized) do update set found_at=case when contacts.source='website' then now() else contacts.found_at end,source_url=case when contacts.source<>'website' or contacts.rank>excluded.rank then contacts.source_url else excluded.source_url end,rank=greatest(contacts.rank,excluded.rank),meta=contacts.meta||(case when contacts.source='website' and contacts.rank<=excluded.rank then excluded.meta else '{}'::jsonb end)||case when contacts.source<>'website' then jsonb_build_object('alsoOnWebsite',excluded.source_url) else '{}'::jsonb end`,
          [
            companyId,
            contact.kind,
            contact.value,
            page.url,
            contact.rank,
            { ...contact.meta, ai },
          ],
        );
      }
      for (const fact of page.facts)
        await saveFact(fact.kind, fact.value, page.url, ai ? 'ai' : 'website');
      contacts = foundContacts.size;
    };
    const saveFact = async (
      kind: string,
      value: unknown,
      url: string,
      source = 'website',
    ) => {
      await client.query(
        `insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,$2,$3,$4,$5,now()+$6*interval '1 day') on conflict(company_id,kind,source,(md5(value::text))) do update set found_at=now(),expires_at=excluded.expires_at,source_url=excluded.source_url`,
        [
          companyId,
          kind,
          JSON.stringify(value),
          source,
          url,
          config['retention.website_days'],
        ],
      );
    };
    try {
      const pages = await scanSite(
        new SiteHttp(company.website, settings),
        country,
        async (page, count) => {
          await persist(page);
          pageCount = count;
          await client.query(
            "update tasks set result=coalesce(result,'{}'::jsonb)||$2::jsonb where id=$1",
            [taskId, JSON.stringify({ pages: count, contacts })],
          );
        },
      );
      const ai = pages.length
        ? await aiSiteFallback(pages, country, config, taskId)
        : {
            contacts: [],
            facts: [],
            aiUsed: false,
            costUsd: 0,
            aiStatus: 'no_pages',
          };
      for (const contact of ai.contacts) {
        const page = aiEvidencePage(
          contact.value,
          pages.slice(0, 3),
          contact.kind === 'phone',
        );
        if (page)
          await persist(
            { url: page.url, contacts: [contact], facts: [] },
            true,
          );
      }
      for (const fact of ai.facts) {
        const page = aiEvidencePage(String(fact.value), pages.slice(0, 3));
        if (page)
          await persist({ url: page.url, contacts: [], facts: [fact] }, true);
      }
      const {
        rows: [billing],
      } = await client.query(
        'select count(*)::int as count,coalesce(sum(cost_usd),0) as cost from spend_events where task_id=$1',
        [taskId],
      );
      const result = {
        pages: pageCount,
        contacts,
        aiUsed: Boolean(billing.count) || ai.aiUsed,
        aiStatus: billing.count && !ai.aiUsed ? 'done' : ai.aiStatus,
        costUsd: billing.count ? Number(billing.cost) : ai.costUsd,
        durationMs: Date.now() - started,
      };
      await saveFact(
        'site_status',
        { status: 'done', pages: pageCount },
        company.website,
      );
      await logActivity(
        'site.scan.done',
        'company',
        companyId,
        null,
        { taskId, ...result },
        client,
      );
      return { status: 'done', result };
    } catch (error) {
      if (error instanceof BillingUncertain)
        return {
          status: 'paused',
          reasonCode: 'billing_uncertain',
          reasonUk: error.message,
        };
      if (!(error instanceof SiteUnavailable)) throw error;
      const unavailable = error;
      await saveFact(
        'site_status',
        {
          status: 'unavailable',
          reason: unavailable.reasonUk,
          pages: pageCount,
        },
        company.website,
      );
      await client.query(
        "update tasks set result=coalesce(result,'{}'::jsonb)||$2::jsonb where id=$1",
        [
          taskId,
          JSON.stringify({
            pages: pageCount,
            contacts,
            aiUsed: false,
            costUsd: 0,
            durationMs: Date.now() - started,
          }),
        ],
      );
      await logActivity(
        'site.scan.skipped',
        'company',
        companyId,
        null,
        {
          taskId,
          reason: unavailable.reasonUk,
          pages: pageCount,
          contacts,
          durationMs: Date.now() - started,
        },
        client,
      );
      return {
        status: 'skipped',
        reasonCode: unavailable.code,
        reasonUk: unavailable.reasonUk,
      };
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [
      `site.scan:${companyId}`,
    ]);
    client.release();
  }
}
export async function registerSiteTasks() {
  await boss.createQueue('site.scan');
  await runTask('site.scan', (payload, id) =>
    runSiteScan(payload as { companyId: string }, id),
  );
}
