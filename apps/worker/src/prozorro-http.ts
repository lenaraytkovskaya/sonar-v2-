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
    for (let attempt = 0; ; attempt++) {
      await this.wait(Math.max(0, this.nextAt - Date.now()));
      this.nextAt = Date.now() + 1000 / this.config.rate;
      let response: Response;
      try {
        response = await this.request(
          `https://public-api.prozorro.gov.ua/api/2.5/${path}`,
          {
            headers: {
              'User-Agent': this.config.userAgent,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(this.config.timeoutMs),
            redirect: 'error',
          },
        );
      } catch (error) {
        if (attempt >= this.config.retries) throw error;
        await this.wait(this.config.retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.ok) return response.json();
      await response.body?.cancel();
      if (
        (response.status !== 429 && response.status < 500) ||
        attempt >= this.config.retries
      )
        throw new Error(`Prozorro HTTP ${response.status}`);
      const retry = response.headers.get('retry-after');
      const delay =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry ?? '') - Date.now();
      await this.wait(
        Math.max(this.config.retryDelayMs * 2 ** attempt, delay || 0),
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
