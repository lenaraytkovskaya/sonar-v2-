import { load } from 'cheerio';
import {
  findPhoneNumbersInText,
  type CountryCode,
} from 'libphonenumber-js/max';
import { normalizePhone } from './index.js';

export type SocialNetwork = 'facebook' | 'instagram' | 'linkedin';
export interface SocialTarget {
  network: SocialNetwork;
  kind: 'page' | 'profile' | 'company' | 'showcase' | 'school' | 'unsupported';
  handle: string;
  canonicalUrl: string;
}
export interface SocialProfile {
  method?: 'session' | 'anonymous';
  address?: string | null;
  rating?: string | null;
  reviewsCount?: number | null;
  name: string | null;
  category: string | null;
  description: string | null;
  website: string | null;
  phones: string[];
  emails: string[];
  followers: number | null;
  postsCount: number | null;
  followingCount: number | null;
  industry: string | null;
  companySize: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  lastPostAt: string | null;
  posts: { date: string; url: string }[];
}
export interface SocialDocument {
  url: string;
  html: string;
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const clean = load(value).text().replace(/\s+/g, ' ').trim();
  return clean || null;
};
function webUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || /[\p{Cc}\s<>]/u.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function socialTarget(raw: string): SocialTarget | null {
  const safe = webUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase();
  let parts: string[];
  try {
    parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  } catch {
    return null;
  }
  const first = parts[0]?.toLowerCase();
  if (!first) return null;
  const unsupported = (network: SocialNetwork): SocialTarget => ({
    network,
    kind: 'unsupported',
    handle: parts.join('/'),
    canonicalUrl: `https://www.${network}.com/${parts.map(encodeURIComponent).join('/')}/`,
  });
  const facebook =
    /^(?:(?:www|m|mbasic)\.)?(?:facebook\.com|fb\.com|fb\.me)$/.test(host);
  if (facebook) {
    let handle: string;
    if (first === 'profile.php') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) return null;
      return {
        network: 'facebook',
        kind: 'page',
        handle: id,
        canonicalUrl: `https://www.facebook.com/profile.php?id=${id}`,
      };
    }
    if (first === 'pages' && parts[1] && /^\d+$/.test(parts[2] ?? '')) {
      handle = parts[2]!;
      return {
        network: 'facebook',
        kind: 'page',
        handle,
        canonicalUrl: `https://www.facebook.com/profile.php?id=${handle}`,
      };
    }
    if (first === 'p' && /-\d+$/.test(parts[1] ?? '')) {
      handle = parts[1]!.match(/-(\d+)$/)![1]!;
      return {
        network: 'facebook',
        kind: 'page',
        handle,
        canonicalUrl: `https://www.facebook.com/profile.php?id=${handle}`,
      };
    }
    if (!/^[a-z\d][a-z\d.\-_]*$/i.test(first)) return null;
    if (
      /^(?:groups|people|pages|p|watch|reels?|stories|story\.php|posts|photos?|photo\.php|videos?|login(?:\.php)?|sharer(?:\.php)?|share|dialog|plugins|events|marketplace|gaming|help|settings|checkpoint|recover|search)$/.test(
        first,
      )
    )
      return unsupported('facebook');
    handle = first;
    return {
      network: 'facebook',
      kind: 'page',
      handle,
      canonicalUrl: /^\d+$/.test(handle)
        ? `https://www.facebook.com/profile.php?id=${handle}`
        : `https://www.facebook.com/${handle}/`,
    };
  }
  if (/^(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)$/.test(host)) {
    if (!/^[\w.]{1,30}$/.test(first)) return null;
    if (
      /^(?:p|reels?|tv|stories|explore|accounts|direct|about|developer|legal|challenge|checkpoint|web)$/.test(
        first,
      )
    )
      return unsupported('instagram');
    return {
      network: 'instagram',
      kind: 'profile',
      handle: first,
      canonicalUrl: `https://www.instagram.com/${first}/`,
    };
  }
  if (
    /^(?:(?:m|[a-z]{2,3})\.)?linkedin\.com$/.test(host) &&
    /^(?:company|showcase|school)$/.test(first) &&
    /^[\w-]+$/.test(parts[1] ?? '')
  ) {
    const kind = first as 'company' | 'showcase' | 'school';
    const handle = parts[1]!.toLowerCase();
    return {
      network: 'linkedin',
      kind,
      handle: kind === 'company' ? handle : `${kind}:${handle}`,
      canonicalUrl: `https://www.linkedin.com/${kind}/${handle}/`,
    };
  }
  if (/^(?:(?:m|[a-z]{2,3})\.)?linkedin\.com$/.test(host))
    return unsupported('linkedin');
  return null;
}

function count(value: unknown): number | null {
  if (typeof value === 'object')
    return count(object(value).count ?? object(value).total);
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(/^(\d[\d\s,.'’]*)\s*(k|m|b|тис\.?|тыс\.?|млн\.?)?$/iu);
  if (!match) return null;
  const multiplier = /^(?:k|тис|тыс)/iu.test(match[2] ?? '')
    ? 1000
    : /^(?:m|млн)/iu.test(match[2] ?? '')
      ? 1e6
      : /^b$/i.test(match[2] ?? '')
        ? 1e9
        : 1;
  const numeric = match[1]!.replace(/[\s'’]/g, '');
  const result =
    Number(
      multiplier === 1
        ? numeric.replace(/[,.]/g, '')
        : numeric.replace(',', '.'),
    ) * multiplier;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function machineDate(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isSafeInteger(value))
    milliseconds = value < 1e12 ? value * 1000 : value;
  else if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  ) {
    const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
    if (
      !Number.isFinite(day) ||
      new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)
    )
      return null;
    milliseconds = Date.parse(
      value.length === 10 ? `${value}T00:00:00Z` : value,
    );
    if (!Number.isFinite(milliseconds)) return null;
    if (
      new Date(milliseconds).toISOString().slice(0, 10) !==
        value.slice(0, 10) &&
      value.length === 10
    )
      return null;
  } else return null;
  return Number.isFinite(milliseconds) &&
    milliseconds >= Date.UTC(2000, 0, 1) &&
    milliseconds <= Date.UTC(2100, 0, 1)
    ? new Date(milliseconds).toISOString()
    : null;
}
// Data only: public embedded JSON, including JSON strings inside platform envelopes.
function records(html: string): RecordValue[] {
  const $ = load(html);
  const result: RecordValue[] = [];
  let nodes = 0;
  let chars = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 35 || nodes++ > 40000) return;
    if (
      typeof value === 'string' &&
      (value.trim().startsWith('{') || value.trim().startsWith('[')) &&
      chars + value.length < 8e6
    ) {
      chars += value.length;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        /* Invalid JSON is not evidence. */
      }
    } else if (Array.isArray(value))
      value.forEach((child) => visit(child, depth + 1));
    else if (value && typeof value === 'object') {
      const node = object(value);
      result.push(node);
      Object.values(node).forEach((child) => visit(child, depth + 1));
    }
  };
  $(
    'script[type="application/json"],script[type="application/ld+json"],script#__NEXT_DATA__,code',
  ).each((_, element) => visit($(element).text(), 0));
  return result;
}
function sameTarget(value: unknown, target: SocialTarget): boolean {
  if (typeof value !== 'string') return false;
  const other = socialTarget(value);
  return (
    other?.network === target.network &&
    other.handle === target.handle &&
    other.kind === target.kind
  );
}
function profiles(all: RecordValue[], target: SocialTarget): RecordValue[] {
  return all.filter((node) => {
    if (target.network === 'instagram')
      return (
        typeof node.username === 'string' &&
        node.username.toLowerCase() === target.handle
      );
    const matches = [
      node.url,
      node['@id'],
      object(node.mainEntityOfPage)['@id'],
    ].some((value) => sameTarget(value, target));
    if (target.network === 'facebook')
      return (
        (matches &&
          (node.__typename === 'Page' ||
            node.is_additional_profile_plus === true ||
            /Organization|LocalBusiness/.test(String(node['@type'])))) ||
        (/^\d+$/.test(target.handle) &&
          String(node.id) === target.handle &&
          node.__typename === 'Page')
      );
    return (
      (matches &&
        /Organization|Corporation|CollegeOrUniversity|School|Company/.test(
          String(node['@type'] ?? node.$type ?? node.__typename),
        )) ||
      [node.universalName, node.vanityName].some(
        (value) =>
          typeof value === 'string' &&
          value.toLowerCase() ===
            target.handle.replace(/^(?:school|showcase):/, ''),
      )
    );
  });
}
export function parseSocialProfile(
  html: string,
  target: SocialTarget,
  country: CountryCode,
  documents: SocialDocument[] = [],
): SocialProfile {
  const $ = load(html);
  const all = records(html);
  const matched = profiles(all, target);
  const ids = new Set(matched.map((node) => node.id).filter(Boolean));
  const associated = all.filter((node) => ids.has(node.id));
  const result: SocialProfile = {
    address: null,
    rating: null,
    reviewsCount: null,
    name: null,
    category: null,
    description: null,
    website: null,
    phones: [],
    emails: [],
    followers: null,
    postsCount: null,
    followingCount: null,
    industry: null,
    companySize: null,
    headquarters: null,
    foundedYear: null,
    lastPostAt: null,
    posts: [],
  };
  const first = (...values: unknown[]) =>
    values.map(text).find(Boolean) ?? null;
  const addPhone = (value: unknown) => {
    if (typeof value !== 'string') return;
    const phone = normalizePhone(value.replace(/^tel:/i, ''), country);
    if (phone && !result.phones.includes(phone)) result.phones.push(phone);
  };
  const addEmail = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const [email] of value.matchAll(
      /[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}/gi,
    )) {
      const normalized = email.toLowerCase();
      if (!result.emails.includes(normalized)) result.emails.push(normalized);
    }
  };
  const addPost = (dateValue: unknown, urlValue: unknown) => {
    const date = machineDate(dateValue);
    const url = webUrl(urlValue, target.canonicalUrl);
    if (
      !date ||
      !url ||
      result.posts.length >= 1000 ||
      result.posts.some((post) => post.url === url)
    )
      return;
    const hostTarget = new URL(url).hostname.replace(/^(?:www|m|mbasic)\./, '');
    if (hostTarget !== `${target.network}.com`) return;
    const path = new URL(url).pathname;
    if (
      /\/(?:comments?|c)\//i.test(path) ||
      [...new URL(url).searchParams.keys()].some((key) =>
        /comment|reply/i.test(key),
      )
    )
      return;
    if (
      !/(?:\/posts\/|\/p\/|\/reel\/|\/videos\/|\/feed\/update\/|\/pulse\/|\/activity-|story\.php|permalink\.php)/.test(
        path,
      )
    )
      return;
    result.posts.push({ date, url });
  };
  const externalUrl = (value: unknown) => {
    let safe = webUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    if (['l.facebook.com', 'l.instagram.com'].includes(url.hostname))
      safe = webUrl(url.searchParams.get('u'));
    return safe && !socialTarget(safe) ? safe : null;
  };
  const ownerMatches = (value: unknown) => {
    const owner = object(value);
    return (
      sameTarget(owner.url ?? owner['@id'], target) ||
      (owner.id != null &&
        [...ids].some((id) => String(id) === String(owner.id))) ||
      (target.network === 'instagram' &&
        typeof owner.username === 'string' &&
        owner.username.toLowerCase() === target.handle)
    );
  };
  const owners = (node: RecordValue) =>
    [
      ...(Array.isArray(node.actors) ? node.actors : []),
      node.owner,
      node.user,
      node.author,
      object(node.feedback).owning_profile,
    ].filter((value) => Object.keys(object(value)).length);
  for (const node of all) {
    if (/comment/i.test(String(node.__typename ?? node['@type']))) continue;
    const sections = object(node.comet_sections);
    const contentStory = object(object(sections.content).story);
    const actors = [...owners(node), ...owners(contentStory)];
    if (
      !actors.length ||
      !actors.every(ownerMatches) ||
      node.sponsored_data ||
      node.is_ad === true
    )
      continue;
    const code = node.shortcode ?? node.code;
    const postUrl =
      node.permalink_url ??
      node.url ??
      node['@id'] ??
      contentStory.url ??
      (target.network === 'facebook' &&
      typeof node.post_id === 'string' &&
      /^[\w-]+$/.test(node.post_id)
        ? `${target.canonicalUrl.includes('profile.php') ? `https://www.facebook.com/${target.handle}/` : target.canonicalUrl}posts/${node.post_id}`
        : null);
    addPost(
      node.creation_time ??
        node.taken_at_timestamp ??
        node.taken_at ??
        node.datePublished ??
        node.publishedAt ??
        node.createdAt,
      postUrl ??
        (target.network === 'instagram' &&
        typeof code === 'string' &&
        /^[\w-]+$/.test(code)
          ? `https://www.instagram.com/p/${code}/`
          : null),
    );
    const metadata = object(
      object(object(sections.context_layout).story).comet_sections,
    ).metadata;
    for (const item of Array.isArray(metadata) ? metadata : []) {
      const story = object(object(item).story);
      if (owners(story).some((owner) => !ownerMatches(owner))) continue;
      addPost(story.creation_time, story.url ?? story.permalink_url ?? postUrl);
    }
  }
  for (const node of [...new Set([...matched, ...associated])]) {
    result.name ??= first(node.full_name, node.name, node.localizedName);
    result.category ??= first(
      node.category_name,
      node.category,
      object(node.category).name,
      object(Array.isArray(node.category_list) ? node.category_list[0] : null)
        .name,
    );
    result.description ??= first(
      node.biography,
      node.description,
      node.about,
      object(node.summary).text,
    );
    result.website ??=
      externalUrl(
        node.external_url ??
          node.website ??
          node.websiteUrl ??
          object(Array.isArray(node.bio_links) ? node.bio_links[0] : null).url,
      ) ??
      (typeof node.url === 'string' && !socialTarget(node.url)
        ? webUrl(node.url)
        : null);
    result.followers ??= count(
      node.follower_count ??
        node.followers_count ??
        node.edge_followed_by ??
        node.followers,
    );
    result.followingCount ??= count(
      node.following_count ?? node.edge_follow ?? node.following,
    );
    result.postsCount ??= count(
      node.media_count ??
        node.all_media_count ??
        node.edge_owner_to_timeline_media ??
        node.posts_count,
    );
    result.industry ??= first(node.industry, object(node.industry).name);
    result.companySize ??= first(
      node.companySize,
      node.employeeCountRange,
      object(node.numberOfEmployees).value,
    );
    let address = object(
      node.address ?? node.headquarters ?? node.business_address,
    );
    if (typeof node.business_address_json === 'string') {
      try {
        address = object(JSON.parse(node.business_address_json));
      } catch {
        /* Invalid address is not evidence. */
      }
    }
    result.address ??= first(
      typeof node.address === 'string' ? node.address : null,
      [
        address.streetAddress ?? address.street_address,
        address.addressLocality ?? address.city_name,
        address.postalCode ?? address.zip,
        address.addressCountry,
      ]
        .filter((value) => typeof value === 'string')
        .join(', '),
    );
    const rating = object(node.aggregateRating);
    const ratingValue =
      rating.ratingValue ??
      node.rating_value ??
      node.overall_star_rating ??
      node.rating;
    result.rating ??=
      typeof ratingValue === 'number' && Number.isFinite(ratingValue)
        ? String(ratingValue)
        : text(ratingValue);
    result.reviewsCount ??= count(
      rating.reviewCount ??
        node.reviews_count ??
        node.review_count ??
        node.rating_count,
    );
    result.headquarters ??= first(
      typeof node.headquarters === 'string' ? node.headquarters : null,
      [address.addressLocality, address.addressRegion, address.addressCountry]
        .filter((value) => typeof value === 'string')
        .join(', '),
    );
    const year = Number(
      node.foundedYear ??
        object(node.foundedOn).year ??
        String(node.foundingDate ?? '').slice(0, 4),
    );
    if (
      Number.isInteger(year) &&
      year >= 1000 &&
      year <= new Date().getUTCFullYear()
    )
      result.foundedYear ??= year;
    [
      node.telephone,
      node.phone_number,
      node.business_phone_number,
      node.public_phone_number,
    ]
      .flat()
      .forEach(addPhone);
    [node.email, node.business_email, node.public_email]
      .flat()
      .forEach(addEmail);
    for (const context of Array.isArray(
      object(node.profile_social_context).content,
    )
      ? (object(node.profile_social_context).content as unknown[])
      : []) {
      const value = object(object(context).text).text;
      if (typeof value === 'string') {
        const match = value.match(
          /^(.+?)\s+(followers|following|підписників|підписники|читачів|подписчиков|подписчики|obserwujących|abonnés|seguidores|підписки|подписки)$/iu,
        );
        if (match)
          result[
            /^(?:following|підписки|подписки)$/iu.test(match[2]!)
              ? 'followingCount'
              : 'followers'
          ] ??= count(match[1]);
      }
    }
    const tiles = object(node.profile_tile_sections).edges;
    if (Array.isArray(tiles))
      for (const edge of tiles) {
        const views = object(object(edge).node).profile_tile_views;
        for (const view of Array.isArray(object(views).nodes)
          ? (object(views).nodes as unknown[])
          : []) {
          const items = object(
            object(object(view).view_style_renderer).view,
          ).profile_tile_items;
          for (const item of Array.isArray(object(items).nodes)
            ? (object(items).nodes as unknown[])
            : []) {
            const tile = object(object(item).node);
            result.description ??= text(object(tile.profile_status_text).text);
            const context = object(
              object(tile.timeline_context_item).renderer,
            ).context_item;
            const title = text(object(object(context).title).text);
            if (title?.match(/^(?:Page|Сторінка|Страница)\s*·\s*/iu))
              result.category ??= title.replace(
                /^(?:Page|Сторінка|Страница)\s*·\s*/iu,
                '',
              );
            result.website ??= externalUrl(object(context).url);
            const reviews = title?.match(
              /(\d[\d\s,.]*\s*(?:тис\.?|тыс\.?|k)?)\s*(?:reviews|відгук\p{L}*|отзыв\p{L}*)/iu,
            );
            result.reviewsCount ??= count(reviews?.[1]);
            const stars = title?.match(
              /(?:rating|оцінка|рейтинг)\s*[:·]?\s*(\d(?:[.,]\d+)?)/iu,
            );
            result.rating ??= stars?.[1]?.replace(',', '.') ?? null;
            addEmail(title);
            if (title)
              findPhoneNumbersInText(title, country).forEach((match) =>
                addPhone(match.number.number),
              );
          }
        }
      }
    const feeds = [
      node.edge_owner_to_timeline_media,
      node.polaris_ordered_timeline_connection,
      node.timeline_list_feed_units,
    ];
    for (const feed of feeds)
      for (const edge of Array.isArray(object(feed).edges)
        ? (object(feed).edges as unknown[])
        : []) {
        const post = object(object(edge).node);
        const owner = object(post.user ?? post.owner);
        if (
          (typeof owner.username === 'string' &&
            owner.username.toLowerCase() !== target.handle) ||
          (owner.id && node.id && String(owner.id) !== String(node.id))
        )
          continue;
        if (target.network === 'facebook') {
          const actors = Array.isArray(post.actors)
            ? post.actors.map((actor) => object(actor).id)
            : [];
          const owning = object(object(post.feedback).owning_profile).id;
          if (
            (!actors.length && !owning) ||
            actors.some((id) => String(id) !== String(node.id)) ||
            (owning && String(owning) !== String(node.id))
          )
            continue;
        }
        if (post.sponsored_data || post.is_ad === true) continue;
        const code = post.shortcode ?? post.code;
        addPost(
          post.taken_at_timestamp ?? post.taken_at ?? post.creation_time,
          post.permalink_url ??
            (target.network === 'instagram' &&
            typeof code === 'string' &&
            /^[\w-]+$/.test(code)
              ? `https://www.instagram.com/p/${code}/`
              : null),
        );
      }
  }
  const metaUrl =
    $('meta[property="og:url"]').attr('content') ??
    $('link[rel="canonical"]').attr('href');
  const metaTitle = $('meta[property="og:title"]').attr('content') ?? '';
  const metaMatches =
    sameTarget(metaUrl, target) ||
    (target.network === 'instagram' &&
      metaTitle.toLowerCase().includes(`(@${target.handle})`));
  const headerMatches = $(
    'main header a[href],main h1 a[href],[role="main"] header a[href],[role="main"] h1 a[href]',
  )
    .toArray()
    .some((element) =>
      sameTarget(webUrl($(element).attr('href'), target.canonicalUrl), target),
    );
  if (metaMatches || (!metaUrl && (matched.length || headerMatches))) {
    const description =
      $('meta[property="og:description"]').attr('content') ??
      $('meta[name="description"]').attr('content');
    result.name ??= first(
      metaTitle
        .replace(/\s*\(@[\w.]+\).*$/, '')
        .replace(/\s*[|·–-]\s*(?:Facebook|Instagram|LinkedIn).*$/i, ''),
      $('main h1,[role="main"] h1').first().text(),
    );
    result.description ??= first(description);
    for (const [field, label] of [
      [
        'followers',
        'followers|підписників|підписники|читачів|подписчиков|подписчики|obserwujących|abonnés|seguidores',
      ],
      ['followingCount', 'following|підписки|подписки'],
      ['postsCount', 'posts|дописів|публікацій|публикаций'],
    ] as const) {
      const value = description?.match(
        new RegExp(
          `([\\d][\\d\\s,.'’]*(?:k|m|b|тис\\.?|тыс\\.?|млн\\.?)?)\\s+(?:${label})`,
          'iu',
        ),
      )?.[1];
      result[field] ??= count(value);
    }
    const area = $('main,[role="main"]').length
      ? $('main,[role="main"]').first().clone()
      : $('body').clone();
    area
      .find(
        'script,style,noscript,template,footer,nav,aside,form,[role="dialog"],[role="navigation"],[role="menu"],[hidden],[aria-hidden="true"]',
      )
      .remove();
    if (target.network === 'linkedin')
      area.find('dt').each((_, element) => {
        const label = $(element).text().trim().toLowerCase();
        const value = text($(element).next('dd').text());
        if (/^(?:industry|галузь|отрасль)$/u.test(label))
          result.industry ??= value;
        if (/^(?:company size|розмір компанії|размер компании)$/u.test(label))
          result.companySize ??= value;
        if (/^(?:headquarters|штаб-квартира)$/u.test(label))
          result.headquarters ??= value;
        if (/^(?:website|вебсайт|веб-сайт|сайт)$/u.test(label))
          result.website ??= externalUrl(
            $(element).next('dd').find('a[href]').attr('href'),
          );
        if (
          /^(?:founded|засновано|основана)$/u.test(label) &&
          /^\d{4}$/.test(value ?? '') &&
          Number(value) <= new Date().getUTCFullYear()
        )
          result.foundedYear ??= Number(value);
      });
    const details = area.clone();
    details
      .find('article,[role="article"],[data-post],[data-recommendations]')
      .remove();
    const header = details.find('header').first();
    const lines = (scope: typeof details) => {
      const copy = scope.clone();
      copy.find('div,p,li,section,h1,h2,h3,span,br').append('\n');
      return copy
        .text()
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };
    const profileLines = lines(details);
    if (target.network === 'facebook') {
      result.category ??=
        profileLines
          .map(
            (line) =>
              line.match(/^(?:Page|Сторінка|Страница)\s*·\s*(.+)/iu)?.[1],
          )
          .find(Boolean) ?? null;
      const ratingLine = profileLines.find((line) =>
        /recommend|рекоменду|rating|оцінка|рейтинг/iu.test(line),
      );
      result.rating ??=
        ratingLine?.match(
          /\d+(?:[.,]\d+)?\s*%\s*(?:recommend|рекоменду\p{L}*)/iu,
        )?.[0] ??
        ratingLine
          ?.match(/(?:rating|оцінка|рейтинг)\s*[:·]?\s*(\d(?:[.,]\d+)?)/iu)?.[1]
          ?.replace(',', '.') ??
        null;
      result.reviewsCount ??= count(
        ratingLine?.match(
          /(\d[\d\s,.]*\s*(?:тис\.?|тыс\.?|k)?)\s*(?:reviews|відгук\p{L}*|отзыв\p{L}*)/iu,
        )?.[1],
      );
      result.description ??= first(details.find('p').first().text());
    }
    if (target.network === 'instagram' && header.length) {
      const biography = header.clone();
      biography.find('h1,h2,ul,button,[role="button"]').remove();
      biography.find('a[href]').each((_, element) => {
        const href = $(element).attr('href') ?? '';
        if (/maps\.|\/explore\/locations\/|\/maps(?:\/|\?)/i.test(href)) {
          result.address ??= text($(element).text());
          $(element).remove();
        } else if (!/^(?:mailto:|tel:)/i.test(href)) $(element).remove();
      });
      let bioLines = lines(biography).filter(
        (line) =>
          ![target.handle, result.name].includes(line) &&
          !/^(?:follow|message|edit profile|підписатися|повідомлення|редагувати профіль)$/iu.test(
            line,
          ) &&
          !/\d.*(?:followers|following|posts|підписник|підписки|допис|публікаці)/iu.test(
            line,
          ),
      );
      if (
        (!result.name || result.name.toLowerCase() === target.handle) &&
        bioLines.length >= 2
      )
        result.name = bioLines.shift()!;
      if (
        !result.category &&
        bioLines.length >= 2 &&
        /^[\p{L}\s/&-]{2,70}$/u.test(bioLines[0]!)
      )
        result.category = bioLines.shift()!;
      bioLines = bioLines.filter((line) => line !== result.category);
      if (
        bioLines.length &&
        (!result.description || result.description === description)
      )
        result.description = bioLines.join(' ');
    }
    result.category ??= first(
      details
        .find(
          '[data-profile-category],[itemprop="category"],header [data-category]',
        )
        .first()
        .text(),
    );
    result.address ??= first(
      details
        .find('[data-profile-address],[itemprop="address"]')
        .first()
        .text(),
    );
    result.description ??= first(
      details
        .find('[data-profile-biography],[itemprop="description"]')
        .first()
        .text(),
    );
    result.website ??= externalUrl(
      details
        .find(
          '[data-profile-website] a[href],a[data-profile-website],header a[href*="l.instagram.com/"]',
        )
        .first()
        .attr('href'),
    );
    if (target.network !== 'linkedin')
      details.find('a[href]').each((_, element) => {
        const label = $(element).text().trim();
        if (
          label &&
          /^(?:https?:\/\/|www\.)?[^\s/]+\.[a-z]{2,}(?:\/|$)/i.test(label)
        )
          result.website ??= externalUrl(
            webUrl($(element).attr('href'), target.canonicalUrl),
          );
      });
    for (const [field, labels] of [
      ['followers', 'followers|підписників|читачів|подписчиков|obserwujących'],
      ['followingCount', 'following|підписки|подписки'],
      ['postsCount', 'posts|дописів|публікацій|публикаций'],
    ] as const) {
      const value = (
        target.network === 'facebook' ? profileLines.join(' ') : header.text()
      ).match(
        new RegExp(
          `(\\d[\\d\\s,.'’]*(?:k|m|b|тис\\.?|тыс\\.?|млн\\.?)?)\\s+(?:${labels})`,
          'iu',
        ),
      )?.[1];
      result[field] ??= count(value);
    }
    details
      .find('a[href^="tel:"]')
      .each((_, element) => addPhone($(element).attr('href')));
    details
      .find('a[href^="mailto:"]')
      .each((_, element) =>
        addEmail($(element).attr('href')?.slice(7).split('?')[0]),
      );
    const bio = [
      result.description,
      details.find('[data-profile-biography],[itemprop="description"]').text(),
      target.network === 'facebook' ? profileLines.join(' ') : null,
    ]
      .filter(Boolean)
      .join(' ');
    addEmail(bio);
    findPhoneNumbersInText(bio, country).forEach((match) =>
      addPhone(match.number.number),
    );
    area.find('time[datetime]').each((_, element) => {
      const article = $(element).closest('article,[role="article"]');
      const author = article
        .find(
          '[rel="author"],a[data-post-author],a[data-profile-author],a.update-components-actor__meta-link,a.feed-shared-actor__container-link',
        )
        .first()
        .attr('href');
      if (author && !sameTarget(webUrl(author, target.canonicalUrl), target))
        return;
      const link =
        $(element).closest('a[href]').attr('href') ??
        $(element).closest('article').find('a[href]').first().attr('href');
      if (
        target.network === 'facebook' &&
        !author &&
        !sameTarget(webUrl(link, target.canonicalUrl), target)
      )
        return;
      if (target.network === 'linkedin' && !author) return;
      addPost($(element).attr('datetime'), link);
    });
    for (const node of all.filter((node) =>
      /SocialMediaPosting|BlogPosting/.test(String(node['@type'])),
    )) {
      const author = object(node.author);
      if (sameTarget(author.url ?? author['@id'], target))
        addPost(node.datePublished, node.url ?? node['@id']);
    }
  }
  for (const document of documents) {
    const safe = webUrl(document.url);
    if (!safe) continue;
    const doc = load(document.html);
    const canonical =
      doc('meta[property="og:url"]').attr('content') ??
      doc('link[rel="canonical"]').attr('href');
    if (
      (target.network === 'linkedin' || target.network === 'facebook') &&
      sameTarget(safe, target)
    ) {
      if (canonical && !sameTarget(canonical, target)) continue;
      const extra = parseSocialProfile(
        canonical
          ? document.html
          : `<meta property="og:url" content="${target.canonicalUrl}">${document.html}`,
        target,
        country,
      );
      for (const field of [
        'name',
        'category',
        'description',
        'website',
        'address',
        'rating',
        'reviewsCount',
        'followers',
        'postsCount',
        'followingCount',
        'industry',
        'companySize',
        'headquarters',
        'foundedYear',
      ] as const)
        if (result[field] == null && extra[field] != null)
          Object.assign(result, { [field]: extra[field] });
      extra.phones.forEach(addPhone);
      extra.emails.forEach(addEmail);
      extra.posts.forEach((post) => addPost(post.date, post.url));
    } else if (target.network === 'instagram') {
      const url = new URL(safe);
      if (
        !/^(?:www\.)?instagram\.com$/.test(url.hostname) ||
        !/^\/(?:p|reel)\/[\w-]+\/?$/.test(url.pathname)
      )
        continue;
      const samePost = (value: unknown) => {
        const candidate = webUrl(value, target.canonicalUrl);
        return (
          candidate &&
          new URL(candidate).hostname.replace(/^www\./, '') ===
            'instagram.com' &&
          new URL(candidate).pathname.replace(/\/$/, '') ===
            url.pathname.replace(/\/$/, '')
        );
      };
      if (canonical && !samePost(canonical)) continue;
      const referenced =
        (metaMatches || matched.length || headerMatches) &&
        $('main a[href],[role="main"] a[href]')
          .toArray()
          .some(
            (element) =>
              !$(element).closest('nav,aside,[data-recommendations]').length &&
              samePost($(element).attr('href')),
          );
      const docRecords = records(document.html);
      for (const node of docRecords) {
        const actors = owners(node);
        const code = node.shortcode ?? node.code;
        if (
          actors.length &&
          actors.every(ownerMatches) &&
          samePost(
            node.permalink_url ??
              node.url ??
              (typeof code === 'string' ? `/p/${code}/` : null),
          )
        )
          addPost(node.taken_at_timestamp ?? node.taken_at, safe);
      }
      doc(
        'main article time[datetime],[role="main"] article time[datetime]',
      ).each((_, element) => {
        const article = doc(element).closest('article');
        if (doc(element).closest('[data-comment],aside,nav').length) return;
        const author = article
          .find(
            '[rel="author"],a[data-post-author],a[data-profile-author],header a[href]',
          )
          .first()
          .attr('href');
        if (author ? !sameTarget(webUrl(author, safe), target) : !referenced)
          return;
        const timeLink = doc(element).closest('a[href]').attr('href');
        if (timeLink && !samePost(timeLink)) return;
        // Comment/reply permalinks can equal the post URL. Scope list items to
        // this article so an outer feed list item does not hide a real post time.
        if (doc(element).parentsUntil('article', 'li,[role="listitem"]').length)
          return;
        const foreign = docRecords.some((node) => {
          const code = node.shortcode ?? node.code;
          return (
            typeof code === 'string' &&
            samePost(`/p/${code}/`) &&
            owners(node).some((actor) => !ownerMatches(actor))
          );
        });
        if (!foreign) addPost(doc(element).attr('datetime'), safe);
      });
    }
  }
  result.posts.sort((a, b) => b.date.localeCompare(a.date));
  result.posts = result.posts.slice(0, 12);
  result.lastPostAt = result.posts.reduce<string | null>(
    (latest, post) => (!latest || post.date > latest ? post.date : latest),
    null,
  );
  return result;
}

export function detectSocialBlock(
  html: string,
  url: string,
  status: number,
  target?: SocialTarget,
): 'captcha' | 'login_wall' | 'forbidden' | 'rate_limit' | null {
  if (status === 429) return 'rate_limit';
  if (status === 403) return 'forbidden';
  const $ = load(html);
  $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  const visible = $('body').text().replace(/\s+/g, ' ');
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    /* No route evidence. */
  }
  if (
    /^\/(?:challenge|checkpoint)(?:\/|$)/i.test(path) ||
    $(
      'iframe[src*="captcha"],input[name="captcha_response"],.g-recaptcha,.h-captcha',
    ).length ||
    /verify (?:that )?you are human|confirm (?:that )?you(?:'re| are) human|complete (?:the )?(?:captcha|security check)|checking your browser|підтвердіть,?\s+що це ви/iu.test(
      visible,
    )
  )
    return 'captcha';
  if (
    /too many requests|please wait a few minutes before you try again/i.test(
      visible,
    )
  )
    return 'rate_limit';
  if (
    /^\/(?:accounts\/login|login(?:\.php)?|authwall|uas\/login|checkpoint\/lg)(?:\/|$)/i.test(
      path,
    )
  )
    return 'login_wall';
  const loginForm = $('form')
    .toArray()
    .some(
      (element) =>
        $(element).find('input[type="password"]').length > 0 &&
        $(element).find(
          'input[name="username"],input[name="email"],input[name="session_key"],input[autocomplete="username"]',
        ).length > 0,
    );
  const inferred = target ?? socialTarget(url);
  const publicMain = $('main,[role="main"]').clone();
  publicMain.find('form,script,style,[role="dialog"]').remove();
  const companyContent =
    publicMain.find('h1').length > 0 &&
    publicMain.find('p,article,[itemprop="description"]').text().trim().length >
      20 &&
    !/^(?:log in|sign in|увійти)/i.test(publicMain.find('h1').text().trim());
  const hasProfile =
    companyContent ||
    (inferred &&
      (profiles(records(html), inferred).length > 0 ||
        (sameTarget($('meta[property="og:url"]').attr('content'), inferred) &&
          $('main h1,main header,[role="main"] h1,[role="main"] header')
            .length > 0)));
  if (
    !hasProfile &&
    (loginForm ||
      /(?:log in|sign in|увійдіть|увійти).{0,60}(?:to (?:continue|see|view)|щоб (?:переглянути|продовжити))/i.test(
        visible,
      ))
  )
    return 'login_wall';
  return null;
}
