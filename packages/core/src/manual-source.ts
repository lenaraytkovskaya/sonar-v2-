import { z } from 'zod';
import { normalizeWebsite } from './google.js';
import { socialTarget, type SocialNetwork } from './social.js';
import { prozorroCode } from './prozorro.js';

export const manualSourceSchema = z
  .object({
    requestId: z.string().uuid(),
    source: z.enum(['website', 'googleMaps', 'social', 'registry']),
    value: z.string().trim().min(1).max(2048),
    network: z.enum(['facebook', 'instagram', 'linkedin']).optional(),
    expected: z.string().max(2048).nullable().optional(),
  })
  .strict();
export type ManualSourceInput = z.infer<typeof manualSourceSchema>;
export type SourceErrorCode =
  | 'invalidWebsite'
  | 'invalidGoogleMaps'
  | 'invalidSocial'
  | 'networkRequired'
  | 'invalidCode'
  | 'staleSource'
  | 'sourceBusy'
  | 'conflictingCode'
  | 'companyNotFound'
  | 'campaignRequired'
  | 'registryCountry';
export class ManualSourceError extends Error {
  constructor(public code: SourceErrorCode) {
    super(code);
  }
}
function web(raw: string) {
  if (/[\s\p{Cc}\\]/u.test(raw)) return null;
  const site = normalizeWebsite(
    /^[\p{L}\p{N}.-]+\.[\p{L}\p{N}-]{2,}(?::\d+)?(?:[/?#]|$)/u.test(raw)
      ? `https://${raw}`
      : raw,
  );
  if (!site) return null;
  const url = new URL(site.website);
  if (
    url.port ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(':')
  )
    return null;
  return site;
}
// URL shape is validated locally. Opaque Google URLs are resolved only by Google's API.
export function manualGoogleMaps(
  raw: string,
): { url: string; placeId: string | null } | null {
  if (
    !/^https:\/\//i.test(raw) ||
    /^https:\/\/[^/?#]*@/i.test(raw) ||
    /[\s\p{Cc}\\]/u.test(raw) ||
    raw.length > 2048
  )
    return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.searchParams.has('place_ids')
  )
    return null;
  const short = url.hostname === 'maps.app.goo.gl';
  const full = ['www.google.com', 'google.com', 'maps.google.com'].includes(
    url.hostname,
  );
  if (!short && !full) return null;
  if (short)
    return /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      ? { url: url.href, placeId: null }
      : null;
  const mapPath =
    ['/maps', '/maps/', '/maps/search', '/maps/search/'].includes(
      url.pathname,
    ) ||
    url.pathname.startsWith('/maps/place/') ||
    (url.hostname === 'maps.google.com' && url.pathname === '/');
  if (
    !mapPath ||
    url.pathname.startsWith('/maps/dir') ||
    url.pathname.startsWith('/maps/@')
  )
    return null;
  const ids = [
    ...url.searchParams.getAll('query_place_id'),
    ...url.searchParams
      .getAll('q')
      .filter((v) => v.startsWith('place_id:'))
      .map((v) => v.slice(9)),
  ];
  if (
    ids.length &&
    (url.searchParams.has('cid') || url.pathname.includes('/data='))
  )
    return null;
  if (ids.length)
    return ids.length === 1 && /^[A-Za-z0-9_-]+$/.test(ids[0]!)
      ? { url: url.href, placeId: ids[0]! }
      : null;
  const place = /^\/maps\/place\/[^/]+/.test(url.pathname);
  const cid =
    ['/maps', '/maps/', '/'].includes(url.pathname) &&
    /^\d+$/.test(url.searchParams.get('cid') ?? '') &&
    url.searchParams.getAll('cid').length === 1;
  return place || cid ? { url: url.href, placeId: null } : null;
}
export function normalizeManualSource(input: ManualSourceInput) {
  const data = manualSourceSchema.parse(input);
  if (data.source === 'website') {
    const site = web(data.value);
    if (!site) throw new ManualSourceError('invalidWebsite');
    return { ...data, value: site.website, domain: site.domain };
  }
  if (data.source === 'googleMaps') {
    const maps = manualGoogleMaps(data.value);
    if (!maps) throw new ManualSourceError('invalidGoogleMaps');
    return { ...data, value: maps.url, placeId: maps.placeId };
  }
  if (data.source === 'registry') {
    const code = prozorroCode(data.value);
    if (!code) throw new ManualSourceError('invalidCode');
    return { ...data, value: code };
  }
  let url = data.value;
  if (url.startsWith('@')) {
    if (!data.network) throw new ManualSourceError('networkRequired');
    const handle = url.slice(1);
    const pattern =
      data.network === 'instagram'
        ? /^[a-z\d_][a-z\d_.]{0,29}$/i
        : data.network === 'linkedin'
          ? /^[a-z\d][a-z\d_-]*$/i
          : /^[a-z\d][a-z\d._-]*$/i;
    if (
      !pattern.test(handle) ||
      (data.network === 'instagram' &&
        (handle.endsWith('.') || handle.includes('..')))
    )
      throw new ManualSourceError('invalidSocial');
    url = `https://www.${data.network}.com/${data.network === 'linkedin' ? 'company/' : ''}${handle}/`;
  }
  const site = web(url);
  const target = site && socialTarget(site.website);
  if (
    !target ||
    target.kind === 'unsupported' ||
    (data.network && target.network !== data.network)
  )
    throw new ManualSourceError('invalidSocial');
  if (
    target.network === 'instagram' &&
    (target.handle.startsWith('.') ||
      target.handle.endsWith('.') ||
      target.handle.includes('..'))
  )
    throw new ManualSourceError('invalidSocial');
  // Do not silently turn post URLs into profile URLs.
  const path = new URL(site!.website).pathname.split('/').filter(Boolean);
  const max =
    target.network === 'linkedin'
      ? 2
      : target.network === 'facebook' && ['pages', 'p'].includes(path[0]!)
        ? 3
        : 1;
  if (path.length > max) throw new ManualSourceError('invalidSocial');
  return {
    ...data,
    value: target.canonicalUrl,
    target,
    network: target.network as SocialNetwork,
  };
}
