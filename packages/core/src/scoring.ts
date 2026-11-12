import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { getDomain } from 'tldts';

export const scoringFeatures = [
  'website',
  'phone',
  'email',
  'messenger',
  'form',
  'rating',
  'registry',
  'reachability',
] as const;
export type ScoringFeature = (typeof scoringFeatures)[number];
export type ScoringWeights = Partial<Record<ScoringFeature, number>>;
export interface ScoringContact {
  id: string;
  kind:
    | 'email'
    | 'phone'
    | 'telegram'
    | 'whatsapp'
    | 'viber'
    | 'form'
    | 'social'
    | 'website';
  value: string;
  normalized: string;
  source: string;
  source_url: string | null;
  meta?: unknown;
  rank: number;
  found_at: Date | string;
}
export interface ScoringInput {
  website: string | null;
  siteScanDone: boolean;
  isPlatform?: boolean;
  rating: number | null;
  ratingsCount: number | null;
  registryFound: boolean;
  registryTerminated: boolean;
  contacts: ScoringContact[];
}
export interface ScoreBreakdown {
  features: {
    feature: ScoringFeature;
    value: number;
    weight: number;
    contribution: number;
  }[];
  top: Record<
    'email' | 'phone' | 'messenger' | 'form' | 'social',
    ScoringContact | null
  >;
}
const messengers = new Set(['telegram', 'whatsapp', 'viber']);
const unit = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

// Fixed logarithmic scale: a 5-star business with 1,000 reviews reaches 1.
export function normalizedRating(
  rating: number | null,
  reviews: number | null,
): number {
  return (
    unit((rating ?? 0) / 5) *
    unit(Math.log1p(Math.max(0, reviews ?? 0)) / Math.log1p(1000))
  );
}

function emailValue(
  contacts: ScoringContact[],
  website: string | null,
): number {
  const emails = contacts.filter((contact) => contact.kind === 'email');
  if (!emails.length) return 0;
  let websiteDomain: string | null = null;
  try {
    websiteDomain = getDomain(new URL(website ?? '').hostname, {
      allowPrivateDomains: true,
    });
  } catch {
    /* A missing or invalid website cannot establish a matching email domain. */
  }
  return websiteDomain &&
    emails.some(
      (contact) =>
        getDomain(contact.normalized.split('@')[1] ?? '', {
          allowPrivateDomains: true,
        }) === websiteDomain,
    )
    ? 1
    : 0.5;
}

/**
 * General mailboxes reach the company; city, job and no-reply mailboxes usually
 * belong to another branch or department.
 */
export function emailPreference(email: string): number {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (
    /^(?:no-?reply|do-?not-?reply|mailer-daemon|hr|jobs?|career|vacanc|robota|rabota|buh|accounting|billing)/.test(
      local,
    ) ||
    /^(?:kyiv|kiev|lviv|lvov|odesa|odessa|kharkiv|kharkov|dnipro|dnepr|zaporizh|zaporozh|vinnyt|vinnits|poltava|chernihiv|cherkasy|sumy|rivne|lutsk|ternopil|uzhhorod|ivano|khmelnyt|zhytomyr|mykolaiv|nikolaev|kherson|kropyv|warsaw|krakow|wroclaw|berlin)/.test(
      local,
    )
  )
    return -1;
  return /^(?:info|office|sto|service|servis|contact|kontakt|hello|mail|sales|zakaz|order|support|admin)/.test(
    local,
  )
    ? 1
    : 0;
}

function mobile(contact: ScoringContact): number {
  if (contact.kind !== 'phone') return 0;
  const type = parsePhoneNumberFromString(contact.normalized)?.getType();
  return Number(type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE');
}

export function scoreCompany(
  input: ScoringInput,
  weights: ScoringWeights,
): { score: number; breakdown: ScoreBreakdown } {
  const contacts = input.contacts.filter((contact) =>
    contact.normalized.trim(),
  );
  const sourcePriority: Record<string, number> = {
    website: 3,
    registry: 2,
    google: 1,
  };
  const time = (contact: ScoringContact) =>
    new Date(contact.found_at).getTime() || 0;
  const ordered = [...contacts].sort(
    (a, b) =>
      b.rank - a.rank ||
      mobile(b) - mobile(a) ||
      (sourcePriority[b.source] ?? 0) - (sourcePriority[a.source] ?? 0) ||
      time(b) - time(a) ||
      a.normalized.localeCompare(b.normalized) ||
      a.id.localeCompare(b.id),
  );
  const top: ScoreBreakdown['top'] = {
    email:
      ordered
        .filter((contact) => contact.kind === 'email')
        .sort(
          (a, b) =>
            emailPreference(b.normalized) - emailPreference(a.normalized),
        )[0] ?? null,
    phone: ordered.find((contact) => contact.kind === 'phone') ?? null,
    messenger: ordered.find((contact) => messengers.has(contact.kind)) ?? null,
    form: ordered.find((contact) => contact.kind === 'form') ?? null,
    social: ordered.find((contact) => contact.kind === 'social') ?? null,
  };
  const values: Record<ScoringFeature, number> = {
    website: Number(
      Boolean(input.website) && input.siteScanDone && !input.isPlatform,
    ),
    phone: Number(Boolean(top.phone)),
    email: emailValue(contacts, input.website),
    messenger: Number(Boolean(top.messenger)),
    form: Number(Boolean(top.form)),
    rating: normalizedRating(input.rating, input.ratingsCount),
    registry: Number(input.registryFound && !input.registryTerminated),
    // Multiple accounts in one category do not inflate channel coverage.
    reachability: Object.values(top).filter(Boolean).length / 5,
  };
  const features = scoringFeatures.map((feature) => ({
    feature,
    value: values[feature],
    weight: Number.isFinite(weights[feature])
      ? Math.max(0, weights[feature] ?? 0)
      : 0,
    contribution: 0,
  }));
  const totalWeight = features.reduce(
    (total, feature) => total + feature.weight,
    0,
  );
  for (const feature of features)
    feature.contribution = totalWeight
      ? ((feature.weight * feature.value) / totalWeight) * 100
      : 0;
  const score = Math.min(
    100,
    features.reduce((total, feature) => total + feature.contribution, 0),
  );
  return { score, breakdown: { features, top } };
}
