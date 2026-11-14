import { setTimeout as sleep } from 'node:timers/promises';
export type ProzorroHttpSettings = {
  rate: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  userAgent: string;
};
export class ProzorroHttp {
  private nextAt = 0;
  constructor(
    private config: ProzorroHttpSettings,
    private request: typeof fetch = fetch,
    private wait: (ms: number) => Promise<unknown> = sleep,
  ) {}
  async get(path: string): Promise<unknown> {
    return this.requestJson(
      `https://public-api.prozorro.gov.ua/api/2.5/${path}`,
    );
  }
  async search(query: URLSearchParams): Promise<unknown> {
    return this.requestJson(
      `https://prozorro.gov.ua/api/search/tenders?${query}`,
      'POST',
    );
  }
  async summary(tenderId: string): Promise<unknown> {
    if (!/^UA-\d{4}-\d{2}-\d{2}-[\w-]+$/.test(tenderId))
      throw Error('Invalid Prozorro tender ID');
    return this.requestJson(
      `https://prozorro.gov.ua/api/tenders/${encodeURIComponent(tenderId)}/summary`,
    );
  }
  private pending: Promise<unknown> = Promise.resolve();
  private requestJson(url: string, method = 'GET'): Promise<unknown> {
    const result = this.pending.then(() => this.fetchJson(url, method));
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async fetchJson(url: string, method = 'GET'): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.wait(Math.max(0, this.nextAt - Date.now()));
      this.nextAt = Date.now() + 1000 / this.config.rate;
      let response: Response;
      try {
        response = await this.request(url, {
          method,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.config.timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        if (attempt >= this.config.retries) throw error;
        await this.wait(
          Math.min(60000, this.config.retryDelayMs * 2 ** attempt),
        );
        continue;
      }
      if (response.ok) return response.json();
      await response.body?.cancel();
      if (
        (response.status !== 429 && response.status < 500) ||
        attempt >= this.config.retries
      )
        throw new ProzorroHttpError(response.status);
      const retry = response.headers.get('retry-after');
      const delay =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry ?? '') - Date.now();
      // Do not retry earlier than a server's long Retry-After; hand it back as paused.
      if (delay > 60000) throw new ProzorroHttpError(response.status);
      await this.wait(
        Math.min(
          60000,
          Math.max(this.config.retryDelayMs * 2 ** attempt, delay || 0),
        ),
      );
    }
  }
}
export type ProzorroFeed = {
  data: { id: string; dateModified: string }[];
  next_page: { offset: string };
};
export function readProzorroFeed(value: unknown): ProzorroFeed {
  const feed = value as ProzorroFeed;
  if (
    !Array.isArray(feed?.data) ||
    typeof feed.next_page?.offset !== 'string' ||
    feed.data.some(
      (row) =>
        !/^[a-f\d]{32}$/i.test(row.id) ||
        !Number.isFinite(Date.parse(row.dateModified)),
    )
  )
    throw new Error('Invalid Prozorro feed');
  return feed;
}

export class ProzorroHttpError extends Error {
  constructor(public status: number) {
    super(`Prozorro HTTP ${status}`);
  }
}

let shared: { key: string; client: ProzorroHttp } | undefined;
export function sharedProzorroHttp(config: ProzorroHttpSettings) {
  const key = JSON.stringify(config);
  if (shared?.key !== key) shared = { key, client: new ProzorroHttp(config) };
  return shared.client;
}
