import { channelLabel } from '@/lib/outreach-labels';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink, MapPin, Star } from 'lucide-react';
import { validId } from '@/lib/api-access';
import { notFound } from 'next/navigation';
import { normalizeWebsite, type RegistryEntity } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, CompanyStatus, scoreTone } from '@/components/shared';
import { ManualEntry, DeleteManualContact } from '@/components/manual-entry';
import { ManualSource } from '@/components/manual-source';
import { CompanyTabs } from '@/components/company-tabs';
import { CompanyAnalysis } from '@/components/company-analysis';
import { ProzorroCompany } from '@/components/prozorro-company';
import { CompanySocial } from '@/components/company-social';
import { SiteScan } from '@/components/site-scan';
import { WebsiteCandidate } from '@/components/website-candidate';
import { RegistryMatch } from '@/components/registry-match';
import { LocalTime } from '@/components/local-time';
import { ScanSummary, Score } from '@/components/shared';
import { cn } from '@/lib/utils';
import { ChannelIcon } from '@/components/channel-icon';
import { WhatsAppRetry } from '@/components/whatsapp-retry';
import { DetailList } from '@/components/ui/layout';

const kindOrder = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'booking',
  'social',
  'website',
];

function Section({
  title,
  children,
  className,
  action,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0 space-y-3 break-words p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Collapsible({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 break-words">
      <details>
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-5 py-4 font-heading text-base font-semibold">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-chip px-2 text-xs font-medium">
              {count}
            </span>
          )}
        </summary>
        <div className="space-y-2 border-t border-border px-5 py-4 text-sm">
          {children}
        </div>
      </details>
    </Card>
  );
}

function SourceLink({ url }: { url: string | null | undefined }) {
  const href = normalizeWebsite(url ?? undefined)?.website;
  return href ? (
    <a
      className="inline-flex text-accent"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={uk.company.source}
      aria-label={uk.company.source}
    >
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  ) : null;
}

function contactHref(contact: {
  kind: string;
  normalized: string;
  value: string;
}) {
  if (contact.kind === 'email') return 'mailto:' + contact.normalized;
  if (contact.kind === 'phone') return 'tel:' + contact.normalized;
  return normalizeWebsite(contact.value)?.website;
}

function formatOpeningHours(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(formatOpeningHours).filter(Boolean).join('; ');
  if (!value || typeof value !== 'object') return '';
  const hours = value as Record<string, unknown>;
  if (typeof hours.opens !== 'string' || typeof hours.closes !== 'string')
    return '';
  const days = [hours.dayOfWeek]
    .flat()
    .filter((day): day is string => typeof day === 'string')
    .map((day) => {
      const name = day.split('/').at(-1) ?? day;
      return (
        uk.company.weekdays[name as keyof typeof uk.company.weekdays] ?? name
      );
    });
  return [days.join(', '), `${hours.opens}–${hours.closes}`]
    .filter(Boolean)
    .join(': ');
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    campaignId?: string;
    tab?: string;
    contact?: string;
  }>;
}) {
  const { id } = await params;
  const { campaignId } = await searchParams;
  const selectedCampaign = validId(campaignId) ? campaignId : undefined;
  if (!validId(id)) notFound();
  const { getCompany } = await import('@sonar/db/companies');
  const { getCompanyChat } = await import('@sonar/db/outreach');
  const { getProzorroCompanySnapshot, prozorroCompanyCodes } =
    await import('@sonar/db/prozorro');
  const { getCompanySocial } = await import('@sonar/db/social');
  const [data, messaging, prozorro, social, codes] = await Promise.all([
    getCompany(id),
    getCompanyChat(id),
    getProzorroCompanySnapshot(id),
    getCompanySocial(id),
    prozorroCompanyCodes(id),
  ]);
  if (!data) notFound();
  const {
    company: c,
    contacts,
    campaigns,
    history,
    facts,
    scans,
    scores,
    analyses,
  } = data;
  const siteFacts = facts.filter(
    (fact) =>
      fact.source !== 'registry' &&
      fact.source !== 'prozorro' &&
      !['social_profile', 'manual_source', 'google_place'].includes(
        fact.kind,
      ) &&
      !['page_text', 'registry_rejected', 'website_candidate'].includes(
        fact.kind,
      ),
  );
  const websiteCandidates = facts.flatMap((fact) => {
    const site =
      fact.kind === 'website_candidate' &&
      typeof fact.value === 'string' &&
      (!fact.expires_at || new Date(fact.expires_at) > new Date())
        ? normalizeWebsite(fact.value)
        : null;
    return site && site.website !== c.website ? [{ ...fact, site }] : [];
  });
  const registryFacts = facts.filter(
    (fact) =>
      fact.source === 'registry' &&
      !['registry_entity', 'registry_candidates'].includes(fact.kind),
  );
  const registryName = registryFacts.find((fact) =>
    ['short_name', 'legal_name'].includes(fact.kind),
  );
  const candidates = facts
    .filter(
      (fact) =>
        fact.source === 'registry' &&
        fact.kind === 'registry_candidates' &&
        Array.isArray(fact.value),
    )
    .flatMap((fact) => fact.value as RegistryEntity[]);
  const terminated = registryFacts.some(
    (fact) =>
      fact.kind === 'registry_status' &&
      /припин|ліквід|банкрут/i.test(String(fact.value)),
  );
  const sortedContacts = [...contacts].sort(
    (a, b) =>
      ((kindOrder.indexOf(a.kind) + 99) % 99) -
        ((kindOrder.indexOf(b.kind) + 99) % 99) || b.rank - a.rank,
  );
  const orderedScores = [...scores].sort(
    (a, b) =>
      Number(b.campaign_id === selectedCampaign) -
      Number(a.campaign_id === selectedCampaign),
  );
  const mainScore = orderedScores[0];
  const mainAnalysis =
    analyses.find(
      (analysis) =>
        analysis.campaign_id === (selectedCampaign ?? mainScore?.campaign_id),
    ) ?? (!selectedCampaign ? analyses[0] : undefined);
  const manualMaps = facts.some(
    (f) => f.kind === 'manual_source' && f.value?.source === 'googleMaps',
  );
  const map = normalizeWebsite(c.google_maps_uri)?.website;
  const googleFact = facts.find(
    (f) =>
      f.kind === 'google_place' &&
      f.source_url === c.google_maps_uri &&
      (!f.expires_at || new Date(f.expires_at) > new Date()),
  );
  const google = googleFact?.value;
  const openingHours =
    google?.regularOpeningHours?.weekdayDescriptions?.join('; ') ||
    formatOpeningHours(
      facts.find(
        (fact) =>
          fact.kind === 'opening_hours' &&
          fact.source === 'website' &&
          (!fact.expires_at || new Date(fact.expires_at) > new Date()),
      )?.value,
    );
  const googlePhone = contacts.find((contact) => contact.kind === 'phone');
  const website = normalizeWebsite(c.website ?? undefined);
  const siteStatus = siteFacts.find((fact) => fact.kind === 'site_status');
  // A click on a contact opens its dialog: the inbox when one exists, otherwise the contact tab.
  const dialogKinds = [
    'email',
    'phone',
    'telegram',
    'whatsapp',
    'form',
    'social',
  ];
  const dialogHref = (contact: {
    id?: string;
    kind: string;
    normalized: string;
  }) => {
    if (!dialogKinds.includes(contact.kind)) return undefined;
    const contactId =
      contact.id ??
      contacts.find(
        (row) =>
          row.kind === contact.kind && row.normalized === contact.normalized,
      )?.id;
    if (!contactId) return undefined;
    const conversation = messaging.conversations.find(
      (row) => row.contactId === contactId,
    );
    if (conversation) return `/inbox?conversation=${conversation.id}`;
    const query = new URLSearchParams({ contact: contactId });
    if (selectedCampaign) query.set('campaignId', selectedCampaign);
    return `/inbox?${query}`;
  };
  const contactRow = (contact: (typeof contacts)[number]) => {
    const dialog = dialogHref(contact);
    const href = dialog ?? contactHref(contact);
    const unavailable = [
      {
        value: contact.meta?.telegram_unavailable,
        label: uk.telegram.unavailable,
        key: 'telegram',
      },
      {
        value: contact.meta?.whatsapp_unavailable,
        label: uk.whatsapp.unavailable,
        key: 'whatsapp',
      },
    ].filter((entry) => entry.value);
    return (
      <li
        key={contact.id}
        className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1 border-b border-border py-2 last:border-0 sm:flex-nowrap"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <ChannelIcon channel={contact.kind} value={contact.value} />
            {contact.kind === 'social'
              ? channelLabel(contact.kind, contact.value)
              : uk.company.kinds[contact.kind as keyof typeof uk.company.kinds]}
          </span>
          <div className="flex min-w-0 items-center gap-1.5">
            {href ? (
              <a
                className="truncate text-accent"
                href={href}
                target={
                  dialog || contact.kind === 'phone' || contact.kind === 'email'
                    ? undefined
                    : '_blank'
                }
                rel="noreferrer"
                title={contact.normalized}
              >
                {contact.normalized}
              </a>
            ) : (
              <span className="truncate">{contact.normalized}</span>
            )}
            <SourceLink url={contact.source_url} />
            {contact.kind === 'social' && (
              <Link
                className="shrink-0 text-accent"
                href={`/inbox?contact=${contact.id}`}
              >
                {uk.email.write}
              </Link>
            )}
          </div>
          <p className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto sm:shrink-0 sm:text-right">
            {
              uk.company.sources[
                contact.source as keyof typeof uk.company.sources
              ]
            }{' '}
            · <LocalTime value={contact.found_at} dateOnly />
            {contact.meta?.ai && ` · ${uk.scanner.ai}`}
            {contact.meta?.alsoOnWebsite && ` · ${uk.scanner.alsoOnWebsite}`}
            {contact.meta?.alsoInProzorro &&
              contact.source !== 'prozorro' &&
              ` · ${uk.prozorro.alsoInProzorro}`}
            {contact.meta?.note && ` · ${String(contact.meta.note)}`}
          </p>
          {unavailable.map(({ value, label, key }) => (
            <div key={label} className="mt-1 flex items-center gap-1">
              <p className="inline-block rounded-full bg-err-bg px-2 py-0.5 text-xs text-err">
                {value &&
                typeof value === 'object' &&
                'reason_uk' in value &&
                typeof value.reason_uk === 'string'
                  ? value.reason_uk.startsWith(label)
                    ? value.reason_uk
                    : `${label}: ${value.reason_uk}`
                  : label}
                {key === 'whatsapp' &&
                  value &&
                  typeof value === 'object' &&
                  'at' in value &&
                  typeof value.at === 'string' && (
                    <>
                      {' '}
                      · <LocalTime value={value.at} dateOnly />
                    </>
                  )}
              </p>
              {key === 'whatsapp' && value && (
                <WhatsAppRetry companyId={id} contactId={contact.id} />
              )}
            </div>
          ))}
        </div>
        {contact.source === 'manual' && (
          <DeleteManualContact companyId={id} contactId={contact.id} />
        )}
      </li>
    );
  };
  return (
    <>
      <Link
        className="mb-2 inline-flex items-center text-sm text-accent"
        href={
          '/companies' +
          (selectedCampaign ? '?campaignId=' + selectedCampaign : '')
        }
      >
        ← {uk.company.back}
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-bold tracking-tight">
              {c.name}
            </h1>
            <CompanyStatus
              status={c.status as keyof typeof uk.company.statuses}
            />
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {[c.city, c.primary_type].filter(Boolean).join(' · ')}
            {c.rating && (
              <span className="inline-flex items-center gap-1">
                <Star aria-hidden="true" className="size-3.5 text-wait" />
                {c.rating} ({c.ratings_count ?? 0} {uk.company.reviews})
              </span>
            )}
            {website && (
              <a
                className="text-accent"
                href={website.website}
                target="_blank"
                rel="noreferrer"
              >
                {website.domain}
              </a>
            )}
          </p>
        </div>
        <SiteScan
          companyId={id}
          hasWebsite={!!c.website}
          enrich={c.place_id.startsWith('manual:')}
        />
      </header>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Section title={uk.company.score}>
          {mainScore ? (
            <>
              <p
                className={cn(
                  'font-heading text-3xl font-bold tabular-nums',
                  scoreTone(mainScore.score).text,
                )}
              >
                {mainScore.score.toFixed(1)}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-chip">
                <div
                  className={cn(
                    'h-full rounded-full',
                    scoreTone(mainScore.score).bar,
                  )}
                  style={{ width: `${mainScore.score}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {mainScore.campaign_name} ·{' '}
                <LocalTime value={mainScore.computed_at} />
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{uk.scoring.empty}</p>
          )}
        </Section>
        <Section title={uk.company.fit}>
          <Score
            value={mainAnalysis?.result.fit ?? null}
            label={uk.company.fit}
          />
          {mainAnalysis && (
            <>
              <p className="text-sm text-muted-foreground">
                {mainAnalysis.result.fit_reason}
              </p>
              <p className="text-xs text-muted-foreground">
                {mainAnalysis.campaign_name} ·{' '}
                <LocalTime value={mainAnalysis.created_at} />
              </p>
            </>
          )}
        </Section>
        <Section title={uk.scoring.top}>
          {mainScore ? (
            <ul className="space-y-1 text-sm">
              {(
                Object.keys(
                  uk.scoring.categories,
                ) as (keyof typeof uk.scoring.categories)[]
              ).map((category) => {
                const contact = mainScore.breakdown.top[category];
                const dialog = contact ? dialogHref(contact) : undefined;
                const href =
                  dialog ?? (contact ? contactHref(contact) : undefined);
                return (
                  <li key={category} className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-xs leading-5 text-muted-foreground">
                      {uk.scoring.categories[category]}
                    </span>
                    {!contact ? (
                      <span className="text-muted-foreground">—</span>
                    ) : href ? (
                      <a
                        className="truncate text-accent"
                        href={href}
                        target={dialog ? undefined : '_blank'}
                        rel="noreferrer"
                        title={contact.normalized}
                      >
                        {contact.normalized}
                      </a>
                    ) : (
                      <span className="truncate">{contact.normalized}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{uk.company.noData}</p>
          )}
        </Section>
        <Section title={uk.company.registry}>
          {registryName ? (
            <p className="text-sm font-medium">{String(registryName.value)}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{uk.registry.empty}</p>
          )}
          {terminated && (
            <p role="alert" className="text-sm text-err">
              {uk.registry.terminated}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {uk.prozorro.title} · {uk.prozorro.purchases}:{' '}
            {(prozorro?.matched ?? 0).toLocaleString('uk-UA')} ·{' '}
            {uk.prozorro.sample}
          </p>
        </Section>
      </div>
      <CompanyTabs
        key={id}
        tabs={[
          {
            key: 'googleMaps',
            label: uk.company.sectionTabs.googleMaps,
            content: (
              <div className="min-w-0 space-y-3">
                <Section
                  title={uk.company.googleData}
                  action={
                    <div className="flex items-center gap-2">
                      {map && (
                        <a
                          className="inline-flex min-h-11 items-center gap-1 text-sm text-accent"
                          href={map}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <MapPin aria-hidden="true" className="size-4" />
                          {uk.company.maps}
                        </a>
                      )}
                    </div>
                  }
                >
                  <ManualSource
                    companyId={id}
                    source="googleMaps"
                    current={c.google_maps_uri}
                    menuAction
                  />
                  <DetailList
                    items={[
                      {
                        label: uk.company.address,
                        value:
                          google?.formattedAddress ??
                          c.address ??
                          uk.company.noData,
                      },
                      {
                        label: uk.company.rating,
                        value: google?.rating ?? c.rating ?? '—',
                      },
                      {
                        label: uk.company.reviews,
                        value:
                          google?.userRatingCount ?? c.ratings_count ?? '—',
                      },
                      {
                        label: uk.company.type,
                        value: google?.primaryType ?? c.primary_type ?? '—',
                      },
                      {
                        label: uk.company.phone,
                        value:
                          google?.nationalPhoneNumber ??
                          googlePhone?.value ??
                          '—',
                      },
                      {
                        label: uk.company.website,
                        value: google?.websiteUri ?? c.website ?? '—',
                      },
                      {
                        label: uk.company.hours,
                        value: openingHours || '—',
                        hidden: !openingHours,
                      },
                    ]}
                  />
                  {googleFact && (
                    <p className="text-xs text-muted-foreground">
                      {uk.manualSource.collected}: {uk.company.sources.google} ·{' '}
                      <LocalTime value={googleFact.found_at} />
                    </p>
                  )}
                  {manualMaps && (
                    <p className="text-xs text-muted-foreground">
                      {uk.manualSource.originalGoogle}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {uk.google.businessStatus[
                      c.business_status as keyof typeof uk.google.businessStatus
                    ] ??
                      c.business_status ??
                      '—'}
                  </p>
                </Section>
              </div>
            ),
          },
          {
            key: 'website',
            label: uk.company.sectionTabs.website,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={uk.company.website}>
                  <ManualSource
                    companyId={id}
                    source="website"
                    current={c.website}
                  />
                  {website ? (
                    <a
                      className="break-all text-sm text-accent"
                      href={website.website}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {website.website}
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {uk.company.noData}
                    </p>
                  )}
                  {siteStatus && (
                    <p className="text-xs text-muted-foreground">
                      {uk.scanner.kinds.site_status}:{' '}
                      {siteStatus.value?.reason ?? uk.tasks.status.done}
                    </p>
                  )}
                  {websiteCandidates.map((fact) => (
                    <div
                      key={fact.id}
                      className="space-y-1 border-t border-border pt-2"
                    >
                      <p className="text-xs text-muted-foreground">
                        {uk.company.websiteCandidate}
                      </p>
                      <a
                        className="block break-all text-sm text-accent"
                        href={fact.site.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {fact.site.website}
                      </a>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        {
                          uk.company.sources[
                            fact.source as keyof typeof uk.company.sources
                          ]
                        }{' '}
                        · <LocalTime value={fact.found_at} dateOnly />
                        <SourceLink url={fact.source_url} />
                      </p>
                      <WebsiteCandidate companyId={id} factId={fact.id} />
                    </div>
                  ))}
                </Section>
                <Section title={`${uk.scanner.facts} · ${siteFacts.length}`}>
                  {!siteFacts.length && (
                    <p className="text-muted-foreground">{uk.company.noData}</p>
                  )}
                  {siteFacts.map((fact) => (
                    <div key={fact.id} className="min-w-0">
                      {fact.kind === 'schema_org' ? (
                        <details>
                          <summary className="cursor-pointer">
                            {uk.scanner.kinds.schema_org}
                          </summary>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-2 text-xs">
                            {JSON.stringify(fact.value, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <p className="flex items-center gap-1.5">
                          <span>
                            <span className="text-muted-foreground">
                              {uk.scanner.kinds[
                                fact.kind as keyof typeof uk.scanner.kinds
                              ] ?? fact.kind}
                              :
                            </span>{' '}
                            {fact.kind === 'site_status'
                              ? (fact.value.reason ?? uk.tasks.status.done)
                              : fact.kind === 'captcha'
                                ? (uk.scanner.captchas[
                                    fact.value as keyof typeof uk.scanner.captchas
                                  ] ?? String(fact.value))
                                : typeof fact.value === 'string'
                                  ? fact.value
                                  : JSON.stringify(fact.value)}
                          </span>
                          <SourceLink url={fact.source_url} />
                        </p>
                      )}
                    </div>
                  ))}
                </Section>
              </div>
            ),
          },
          {
            key: 'social',
            label: uk.company.sectionTabs.social,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={uk.social.title}>
                  <ManualSource companyId={id} source="social" />
                  <CompanySocial
                    companyId={c.id}
                    initial={social}
                    contacts={contacts}
                  />
                </Section>
              </div>
            ),
          },
          {
            key: 'registry',
            label: uk.company.sectionTabs.registry,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={uk.company.registry}>
                  <ManualSource companyId={id} source="registry" />
                  <RegistryMatch companyId={c.id} candidates={candidates} />
                  {registryFacts.length > 0 && (
                    <dl className="grid sm:grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                      {registryFacts.map((fact) => (
                        <div key={fact.id} className="contents">
                          <dt className="text-muted-foreground">
                            {uk.registry.kinds[
                              fact.kind as keyof typeof uk.registry.kinds
                            ] ?? fact.kind}
                          </dt>
                          <dd className="break-words">
                            {fact.kind === 'registry_match_method'
                              ? (uk.registry.methods[
                                  String(
                                    fact.value,
                                  ) as keyof typeof uk.registry.methods
                                ] ?? String(fact.value))
                              : fact.kind === 'founders' &&
                                  Array.isArray(fact.value)
                                ? fact.value
                                    .map(
                                      (f: {
                                        name: string | null;
                                        role: string;
                                      }) =>
                                        [f.name, f.role]
                                          .filter(Boolean)
                                          .join(' · '),
                                    )
                                    .join('; ')
                                : String(fact.value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {registryFacts[0] && (
                    <p className="text-xs text-muted-foreground">
                      {uk.company.sources.registry} ·{' '}
                      <LocalTime value={registryFacts[0].found_at} dateOnly />
                    </p>
                  )}
                </Section>
              </div>
            ),
          },
          {
            key: 'analysis',
            label: uk.company.sectionTabs.analysis,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={uk.analysis.title}>
                  {!campaigns.length && (
                    <p className="text-sm text-muted-foreground">
                      {uk.company.noData}
                    </p>
                  )}
                  {[...campaigns]
                    .sort(
                      (a, b) =>
                        Number(b.id === selectedCampaign) -
                        Number(a.id === selectedCampaign),
                    )
                    .map((campaign, index) => (
                      <section
                        key={campaign.id}
                        className={cn(
                          'space-y-2 text-sm',
                          index > 0 && 'border-t border-border pt-3',
                        )}
                      >
                        {campaigns.length > 1 && (
                          <h3 className="font-semibold">{campaign.name}</h3>
                        )}
                        <CompanyAnalysis
                          companyId={id}
                          campaignId={campaign.id}
                          analysis={analyses.find(
                            (row) => row.campaign_id === campaign.id,
                          )}
                        />
                      </section>
                    ))}
                </Section>
                {orderedScores.length > 0 && (
                  <Collapsible title={uk.scoring.details}>
                    {orderedScores.map((row) => (
                      <section key={row.campaign_id} className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <Link
                            className="text-accent"
                            href={'/campaigns?campaign=' + row.campaign_id}
                          >
                            {row.campaign_name}
                          </Link>
                          <Score value={row.score} compact />
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs text-muted-foreground">
                              <tr>
                                {[
                                  uk.company.score,
                                  uk.scoring.value,
                                  uk.scoring.weight,
                                  uk.scoring.contribution,
                                ].map((label) => (
                                  <th
                                    key={label}
                                    className="px-2 py-1 font-medium"
                                  >
                                    {label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {row.breakdown.features.map((feature) => (
                                <tr
                                  key={feature.feature}
                                  className="border-t border-border"
                                >
                                  <th
                                    scope="row"
                                    className="px-2 py-1 font-normal"
                                  >
                                    {
                                      uk.campaign.weights[
                                        feature.feature as keyof typeof uk.campaign.weights
                                      ]
                                    }
                                  </th>
                                  <td
                                    className={cn(
                                      'px-2 py-1 tabular-nums',
                                      feature.value >= 0.7
                                        ? 'text-ok'
                                        : feature.value > 0
                                          ? 'text-wait'
                                          : 'text-err',
                                    )}
                                  >
                                    {(feature.value * 100).toFixed(0)}%
                                  </td>
                                  <td className="px-2 py-1 tabular-nums">
                                    {feature.weight}
                                  </td>
                                  <td className="px-2 py-1 tabular-nums">
                                    {feature.contribution.toFixed(1)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    ))}
                  </Collapsible>
                )}
              </div>
            ),
          },
          {
            key: 'contacts',
            label: uk.company.sectionTabs.contacts,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={`${uk.company.contacts} · ${contacts.length}`}>
                  <ManualEntry companyId={id} />
                  {!contacts.length && (
                    <p className="text-sm text-muted-foreground">
                      {uk.company.noData}
                    </p>
                  )}
                  <ul className="text-sm">
                    {(
                      [
                        { key: 'email', kinds: ['email'] },
                        { key: 'phones', kinds: ['phone'] },
                        {
                          key: 'messengers',
                          kinds: ['telegram', 'whatsapp', 'viber'],
                        },
                        { key: 'social', kinds: ['social'] },
                        { key: 'forms', kinds: ['form'] },
                        { key: 'booking', kinds: ['booking'] },
                        { key: 'websites', kinds: ['website'] },
                      ] as const
                    ).map(({ key, kinds }) => {
                      const group = sortedContacts
                        .filter((contact) =>
                          kinds.includes(contact.kind as never),
                        )
                        .sort((a, b) => b.rank - a.rank);
                      if (!group.length) return null;
                      return (
                        <li
                          key={key}
                          className="list-none space-y-1.5 py-3 first:pt-0"
                        >
                          <h3 className="text-sm font-semibold">
                            {uk.company.contactGroups[key]} ({group.length})
                          </h3>
                          <ul className="text-sm">{group.map(contactRow)}</ul>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              </div>
            ),
          },
          {
            key: 'prozorro',
            label: uk.company.sectionTabs.prozorro,
            content: (
              <div className="min-w-0 space-y-3">
                <Section title={uk.prozorro.title}>
                  <ProzorroCompany
                    companyId={id}
                    snapshot={prozorro}
                    allowManualCode={!codes.some((fact) => fact.code)}
                  />
                </Section>
              </div>
            ),
          },
          {
            key: 'history',
            label: uk.company.sectionTabs.history,
            content: (
              <div className="min-w-0 space-y-3">
                <Section
                  title={`${uk.company.history} · ${history.length + scans.length}`}
                >
                  {campaigns.map((row) => (
                    <p key={row.id}>
                      <Link
                        className="text-accent"
                        href={'/campaigns?campaign=' + row.id}
                      >
                        {row.name}
                      </Link>{' '}
                      ·{' '}
                      {row.batch_id
                        ? `${uk.company.batch} #${row.number} · ${uk.tasks.status[row.status as keyof typeof uk.tasks.status]}`
                        : uk.manual.withoutBatch}{' '}
                      · <LocalTime value={row.added_at} />
                    </p>
                  ))}
                  {scans.map((scan) => (
                    <div key={scan.id}>
                      <p>
                        {uk.scanner.title} ·{' '}
                        {
                          uk.tasks.status[
                            scan.status as keyof typeof uk.tasks.status
                          ]
                        }{' '}
                        · <LocalTime value={scan.created_at} />
                      </p>
                      {scan.reason_uk && (
                        <p className="text-muted-foreground">
                          {scan.reason_uk}
                        </p>
                      )}
                      <ScanSummary result={scan.result} />
                    </div>
                  ))}
                  <ul className="space-y-1">
                    {history.map((row) => (
                      <li key={row.id}>
                        {row.action === 'company.source.manual'
                          ? uk.manualSource.history
                          : row.action === 'company.website.adopted'
                            ? uk.company.websiteAdopted
                            : row.action === 'company.found'
                              ? uk.company.added
                              : (uk.manual.activities[
                                  row.action as keyof typeof uk.manual.activities
                                ] ??
                                uk.scanner.activities[
                                  row.action as keyof typeof uk.scanner.activities
                                ] ??
                                uk.registry.activities[
                                  row.action as keyof typeof uk.registry.activities
                                ] ??
                                uk.company.activity)}{' '}
                        <span className="text-xs text-muted-foreground">
                          · {row.user_name ?? uk.appName} ·{' '}
                          <LocalTime value={row.created_at} />
                        </span>
                        {row.action === 'company.source.manual' && (
                          <p className="break-all text-xs text-muted-foreground">
                            {String(row.details?.target ?? '')}
                            {row.details?.previous &&
                              ` · ${uk.manualSource.previous}: ${String(row.details.previous)}`}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
