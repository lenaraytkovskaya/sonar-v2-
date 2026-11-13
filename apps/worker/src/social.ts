import {
  BudgetExceeded,
  detectSocialBlock,
  parseSocialProfile,
  socialTarget,
  type CountryCode,
  type SocialTarget,
  type PaidResponse,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { runBudgetedRequest, BillingUncertain } from '@sonar/db/budget';
import { saveSocialProfile, type SocialPayload } from '@sonar/db/social';
import { enqueueCompanyScores } from '@sonar/db/scoring';
import { boss, runTask, type TaskOutcome } from '@sonar/db/tasks';
import {
  fetchSocialPage,
  socialProxies,
  type SocialPage,
} from './social-browser.js';
export { closeSocialBrowser } from './social-browser.js';
type Runtime = {
  day?: string;
  count?: number;
  nextAt?: string;
  pauseUntil?: string;
  blocked?: boolean;
  reason?: string;
};
type Settings = Record<string, unknown>;
const reason = (code: string) =>
  ({
    captcha: 'Соцмережа вимагає CAPTCHA. Повторіть вручну після паузи.',
    login_wall: 'Соцмережа вимагає входу. Доступні лише публічні сторінки.',
    forbidden:
      'Соцмережа заборонила доступ (403). Повторіть вручну після паузи.',
    rate_limit:
      'Соцмережа обмежила запити (429). Повторіть вручну після паузи.',
    robots_denied: 'Соцмережа забороняє автоматичне читання (robots.txt).',
    robots_unavailable: 'Не вдалося перевірити robots.txt соцмережі.',
    profile_missing: 'На публічній сторінці немає підтверджених даних профілю.',
    network_error: 'Не вдалося завантажити публічну сторінку соцмережі.',
  })[code] ?? 'Не вдалося прочитати сторінку соцмережі.';
export function socialLimit(
  config: Settings,
  network: string,
  runtime: Runtime,
  manual: boolean,
  now = new Date(),
): string | null {
  if (
    runtime.blocked &&
    (!manual || Date.parse(runtime.pauseUntil ?? '') > now.getTime())
  )
    return (
      runtime.reason ?? 'Соцмережу призупинено. Повторіть вручну після паузи.'
    );
  if (
    runtime.day === now.toISOString().slice(0, 10) &&
    (runtime.count ?? 0) >= Number(config[`social.${network}.daily_limit`])
  )
    return 'Вичерпано денний ліміт соцмережі. Повторіть вручну завтра.';
  return null;
}
function number(config: Settings, key: string, min: number, max: number) {
  const value = Number(config[key]);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error('Некоректні налаштування соцмереж.');
  return value;
}
export async function runSocialFetch(
  payload: SocialPayload,
  taskId: string,
  fetchPage = fetchSocialPage,
): Promise<TaskOutcome> {
  const paused = (reasonCode: string, reasonUk: string): TaskOutcome => ({
    status: 'paused',
    reasonCode,
    reasonUk,
  });
  const target = socialTarget(payload.target.canonicalUrl);
  if (
    !target ||
    target.network !== payload.target.network ||
    target.handle !== payload.target.handle
  )
    return {
      status: 'skipped',
      reasonCode: 'social_invalid',
      reasonUk: 'Некоректне посилання на соцмережу.',
    };
  if (target.kind === 'unsupported')
    return {
      status: 'skipped',
      reasonCode: 'social_unsupported',
      reasonUk: 'Цей тип сторінки соцмережі не підтримується.',
    };
  let proxies;
  try {
    proxies = socialProxies();
  } catch {
    return paused(
      'social_proxy_invalid',
      'Перевірте SOCIAL_PROXY_URLS на сервері',
    );
  }
  if (!proxies.length)
    return paused(
      'social_proxy_missing',
      'Додайте SOCIAL_PROXY_URLS на сервері',
    );
  const client = await sonarPool.connect();
  let locked = false;
  const lockKey = `social.network:${target.network}`;
  try {
    const {
      rows: [lock],
    } = await client.query(
      'select pg_try_advisory_lock(hashtextextended($1,0)) as locked',
      [lockKey],
    );
    locked = lock.locked;
    if (!locked)
      return {
        status: 'deferred',
        runAt: new Date(Date.now() + 1000),
        reasonCode: 'social_busy',
        reasonUk: 'Інший запит до соцмережі ще виконується.',
      };
    const { rows } = await client.query(
      "select key,value from settings where key like 'social.%' or key='scanner.user_agent'",
    );
    const config: Settings = Object.fromEntries(
      rows.map((row) => [row.key, row.value]),
    );
    const cost = number(config, 'social.cost_per_request_usd', 0, 100);
    const timeout = number(config, 'social.page_timeout_ms', 100, 120000);
    const gap = number(
      config,
      `social.${target.network}.min_gap_seconds`,
      0,
      86400,
    );
    number(config, `social.${target.network}.daily_limit`, 1, 100000);
    const pause = number(
      config,
      `social.${target.network}.pause_minutes`,
      0,
      10080,
    );
    const runtimeKey = `social.${target.network}.runtime`;
    const runtime = (config[runtimeKey] ?? {}) as Runtime;
    const {
      rows: [parent],
    } = await client.query(
      'select idempotency_key,payload from tasks where id=$1',
      [taskId],
    );
    const requestKey = `${parent.idempotency_key}:request:${payload.requestVersion ?? 0}`;
    const {
      rows: [previous],
    } = await client.query(
      'select t.id,t.result,s.id as billed from tasks t left join spend_events s on s.task_id=t.id where t.idempotency_key=$1',
      [requestKey],
    );
    if (previous?.result?.billingPending)
      return paused('billing_uncertain', new BillingUncertain().message);
    if (!previous?.billed) {
      const limit = socialLimit(
        config,
        target.network,
        runtime,
        !!payload.manual,
      );
      if (limit) return paused('social_network_paused', limit);
      const next = Date.parse(runtime.nextAt ?? '');
      if (next > Date.now())
        return {
          status: 'deferred',
          runAt: new Date(next),
          reasonCode: 'social_gap',
          reasonUk: 'Очікування паузи між запитами соцмережі.',
        };
    }
    const {
      rows: [request],
    } = await client.query(
      `insert into tasks(type,idempotency_key,payload,subject_type,subject_id,status) values('social.request',$1,$2,'company',$3,'running') on conflict(idempotency_key) do update set status='running' returning id`,
      [
        requestKey,
        JSON.stringify({
          parentId: taskId,
          companyId: payload.companyId,
          target,
        }),
        payload.companyId,
      ],
    );
    const {
      rows: [company],
    } = await client.query(
      'select coalesce(c.country_code,a.country_code) as country_code from companies c left join lateral(select p.country_code from campaigns p join campaign_companies cc on cc.campaign_id=p.id where cc.company_id=c.id order by p.id limit 1)a on true where c.id=$1',
      [payload.companyId],
    );
    let response: PaidResponse;
    try {
      response = await runBudgetedRequest(
        'iproyal',
        cost,
        request.id,
        async () => {
          const now = new Date();
          await client.query(
            'update settings set value=$2,updated_at=now() where key=$1',
            [
              runtimeKey,
              JSON.stringify({
                day: now.toISOString().slice(0, 10),
                count:
                  (runtime.day === now.toISOString().slice(0, 10)
                    ? (runtime.count ?? 0)
                    : 0) + 1,
                nextAt: new Date(now.getTime() + gap * 1000).toISOString(),
                blocked: false,
              }),
            ],
          );
          // Once the proxy is used, even a blocked or failed page consumes paid traffic.
          let page: SocialPage;
          try {
            page = await fetchPage(
              target,
              proxies[(runtime.count ?? 0) % proxies.length]!,
              timeout,
              String(config['scanner.user_agent'] ?? 'SonarBot/1.0'),
            );
          } catch {
            page = {
              html: '',
              url: target.canonicalUrl,
              status: 0,
              error: 'network_error',
            };
          }
          const block = detectSocialBlock(
            page.html,
            page.url,
            page.status,
            target,
          );
          let failure: string | null =
            block ??
            page.error ??
            (page.status >= 400 ? 'network_error' : null);
          const profile = failure
            ? null
            : parseSocialProfile(
                page.html,
                target,
                company?.country_code as CountryCode,
              );
          if (
            profile &&
            !Object.values(profile).some((value) =>
              Array.isArray(value) ? value.length > 0 : value !== null,
            )
          )
            failure = 'profile_missing';
          return {
            id: request.id,
            model: 'iproyal',
            text: JSON.stringify(failure ? { failure } : { profile }),
            costUsd: page.usedProxy === false ? 0 : cost,
            units: page.usedProxy === false ? 0 : 1,
            costBasis: 'estimated_tariff',
          };
        },
      );
    } catch (error) {
      await client.query(
        "update tasks set status='paused',reason_code=$2,reason_uk=$3,finished_at=now() where id=$1",
        [
          request.id,
          error instanceof BudgetExceeded
            ? 'budget_exceeded'
            : 'billing_uncertain',
          error instanceof BudgetExceeded
            ? error.message
            : new BillingUncertain().message,
        ],
      );
      return paused(
        error instanceof BudgetExceeded
          ? 'budget_exceeded'
          : 'billing_uncertain',
        error instanceof BudgetExceeded
          ? error.message
          : new BillingUncertain().message,
      );
    }
    await client.query(
      "update tasks set status='done',finished_at=now() where id=$1",
      [request.id],
    );
    const data = JSON.parse(response.text);
    if (data.failure) {
      const reasonUk = reason(data.failure);
      if (
        ['captcha', 'login_wall', 'forbidden', 'rate_limit'].includes(
          data.failure,
        )
      )
        await client.query(
          `update settings set value=value||$2::jsonb,updated_at=now() where key=$1`,
          [
            runtimeKey,
            JSON.stringify({
              blocked: true,
              pauseUntil: new Date(Date.now() + pause * 60000).toISOString(),
              reason: reasonUk,
            }),
          ],
        );
      return {
        status: ['captcha', 'rate_limit'].includes(data.failure)
          ? 'paused'
          : 'skipped',
        reasonCode: `social_${data.failure}`,
        reasonUk,
      };
    }
    await client.query('begin');
    const {
      rows: [fresh],
    } = await client.query('select payload from tasks where id=$1 for update', [
      taskId,
    ]);
    const companies = [
      ...new Set<string>([
        payload.companyId,
        ...(fresh.payload.companyIds ?? []),
      ]),
    ];
    await saveSocialProfile(
      client,
      companies,
      target as SocialTarget,
      data.profile,
    );
    await client.query(
      "update tasks set status='done',result=$2,finished_at=now() where id=$1",
      [
        taskId,
        JSON.stringify({
          profile: data.profile,
          target,
          costUsd: response.costUsd,
        }),
      ],
    );
    await client.query('commit');
    for (const companyId of companies) await enqueueCompanyScores(companyId);
    return {
      status: 'done',
      result: { profile: data.profile, target, costUsd: response.costUsd },
    };
  } catch {
    await client.query('rollback').catch(() => {});
    return {
      status: 'failed',
      reasonCode: 'social_failed',
      reasonUk:
        'Не вдалося обробити соцмережу. Перевірте налаштування й повторіть.',
    };
  } finally {
    if (locked)
      await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [
        lockKey,
      ]);
    client.release();
  }
}
export async function registerSocialTasks() {
  await boss.createQueue('social.fetch');
  await runTask('social.fetch', (payload, id) =>
    runSocialFetch(payload as SocialPayload, id),
  );
}
