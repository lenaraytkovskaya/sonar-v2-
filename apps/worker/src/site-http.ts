import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { decodeSiteHtml, sameSiteDomain, robotsAllows } from '@sonar/core';
export class SiteUnavailable extends Error {
  constructor(
    public code: string,
    public reasonUk: string,
  ) {
    super(reasonUk);
  }
}
export type SiteSettings = {
  maxPages: number;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
};
export type SiteResponse = {
  url: string;
  status: number;
  body: Uint8Array;
  contentType: string;
  location?: string;
};
export function publicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  // Only globally routed unicast IPv6; mapped, loopback, local and transition ranges stay blocked.
  return (
    isIP(ip) === 6 &&
    /^[23][0-9a-f]{3}:/.test(ip) &&
    !/^(2001:|2002:|3fff:)/.test(ip)
  );
}
export async function requestSite(
  url: URL,
  settings: SiteSettings,
): Promise<SiteResponse> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_resolve, reject) => {
          dnsTimer = setTimeout(
            () =>
              reject(
                new SiteUnavailable(
                  'timeout',
                  'Сайт недоступний: вичерпано час пошуку адреси.',
                ),
              ),
            settings.timeoutMs,
          );
          dnsTimer.unref();
        }),
      ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new SiteUnavailable(
      'unsafe_url',
      'Сайт недоступний: адреса не є публічною.',
    );
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(
      url,
      {
        headers: {
          'User-Agent': settings.userAgent,
          Accept: 'text/html,application/xml,text/plain,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
        lookup: (_hostname, options, callback) => {
          const address = addresses[0]!;
          if (options.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        if (Number(res.headers['content-length']) > settings.maxBytes) {
          req.destroy(
            new SiteUnavailable(
              'size_limit',
              'Сайт недоступний: сторінка перевищує ліміт розміру.',
            ),
          );
          return;
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > settings.maxBytes)
            req.destroy(
              new SiteUnavailable(
                'size_limit',
                'Сайт недоступний: сторінка перевищує ліміт розміру.',
              ),
            );
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('aborted', () =>
          reject(
            new SiteUnavailable(
              'response_aborted',
              'Сайт недоступний: завантаження перервано.',
            ),
          ),
        );
        res.on('end', () =>
          resolve({
            url: url.href,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            contentType: String(res.headers['content-type'] ?? ''),
            location: res.headers.location,
          }),
        );
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(
          new SiteUnavailable(
            'timeout',
            'Сайт недоступний: вичерпано час очікування.',
          ),
        ),
      settings.timeoutMs,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}
export class SiteHttp {
  private robots = new Map<string, Promise<string>>();
  constructor(
    readonly home: string,
    readonly settings: SiteSettings,
    private request = requestSite,
  ) {}
  private validate(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SiteUnavailable(
        'unsafe_url',
        'Сайт недоступний: некоректна адреса.',
      );
    }
    if (
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.port && !['80', '443'].includes(url.port)) ||
      !sameSiteDomain(this.home, url.href)
    )
      throw new SiteUnavailable(
        'unsafe_url',
        'Сайт недоступний: заборонена адреса або інший домен.',
      );
    url.hash = '';
    return url;
  }
  async read(value: string, checkRobots = true): Promise<SiteResponse> {
    let url = this.validate(value);
    for (let redirects = 0; redirects < 6; redirects++) {
      if (checkRobots) {
        const rules = await this.rules(url.origin);
        if (!robotsAllows(rules, url.href, this.settings.userAgent))
          throw new SiteUnavailable(
            'robots_denied',
            'Сайт забороняє сканування (robots.txt)',
          );
      }
      const response = await this.request(url, this.settings).catch((error) => {
        if (error instanceof SiteUnavailable) throw error;
        throw new SiteUnavailable(
          'network_unavailable',
          'Сайт недоступний: не вдалося встановити з’єднання.',
        );
      });
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.location
      ) {
        url = this.validate(new URL(response.location, url).href);
        continue;
      }
      if ([401, 403, 429].includes(response.status))
        throw new SiteUnavailable(
          `http_${response.status}`,
          `Сайт недоступний: сервер повернув ${response.status}.`,
        );
      return response;
    }
    throw new SiteUnavailable(
      'redirect_limit',
      'Сайт недоступний: забагато перенаправлень.',
    );
  }
  private rules(origin: string) {
    let rules = this.robots.get(origin);
    if (!rules) {
      rules = this.read(`${origin}/robots.txt`, false).then((response) => {
        if ([404, 410].includes(response.status)) return '';
        if (response.status !== 200)
          throw new SiteUnavailable(
            'robots_unavailable',
            'Сайт недоступний: не вдалося перевірити robots.txt.',
          );
        const text = decodeSiteHtml(response.body, response.contentType);
        if (/^\s*</.test(text))
          throw new SiteUnavailable(
            'robots_unavailable',
            'Сайт недоступний: некоректний robots.txt.',
          );
        return text;
      });
      this.robots.set(origin, rules);
    }
    return rules;
  }
}
