import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink, MapPin, Star } from 'lucide-react';
import { validId } from '@/lib/api-access';
import { notFound } from 'next/navigation';
import { normalizeWebsite, type RegistryEntity } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, CompanyStatus, scoreTone } from '@/components/shared';
import { CompanyEmail } from '@/components/company-email';
import { ManualEntry, DeleteManualContact } from '@/components/manual-entry';
import { CompanyAnalysis } from '@/components/company-analysis';
import { SiteScan } from '@/components/site-scan';
import { WebsiteCandidate } from '@/components/website-candidate';
import { RegistryMatch } from '@/components/registry-match';
import { LocalTime } from '@/components/local-time';
import { ScanSummary, Score } from '@/components/shared';
import { cn } from '@/lib/utils';

const kindOrder = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
  'website',
];
const visibleContacts = 12;

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
    <Card className={cn('min-w-0 space-y-2.5 break-words p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-sm font-bold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
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
        <summary className="flex cursor-pointer items-center justify-between gap-2 p-4 font-heading text-sm font-bold uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-chip px-2 text-xs normal-case">
              {count}
            </span>
          )}
        </summary>
        <div className="space-y-2 border-t border-border p-4 text-sm">
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

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ campaignId?: string }>;
}) {
  const { id } = await params;
  const { campaignId } = await searchParams;
  const selectedCampaign = validId(campaignId) ? campaignId : undefined;
  if (!validId(id)) notFound();
  const { getCompany } = await import('@sonar/db/companies');
  const { getCompanyMessaging } = await import('@sonar/db/email');
  const { getProzorroCompanySummary } = await import('@sonar/db/prozorro');
  const [data, messaging, prozorro] = await Promise.all([
    getCompany(id),
    getCompanyMessaging(id),
    getProzorroCompanySummary(id),
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
  const prozorroContacts = contacts.filter(
    (contact) =>
      ['phone', 'email'].includes(contact.kind) &&
      (contact.source === 'prozorro' || contact.meta?.alsoInProzorro),
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
  const map = normalizeWebsite(c.google_maps_uri)?.website;
  const website = normalizeWebsite(c.website ?? undefined);
  const siteStatus = siteFacts.find((fact) => fact.kind === 'site_status');
  const contactRow = (contact: (typeof contacts)[number]) => {
    const href = contactHref(contact);
    const unavailable = contact.meta?.telegram_unavailable;
    const unavailableReason =
      unavailable &&
      typeof unavailable === 'object' &&
      'reason_uk' in unavailable &&
      typeof unavailable.reason_uk === 'string'
        ? unavailable.reason_uk
        : '';
    return (
      <li
        key={contact.id}
        className="flex min-w-0 items-start gap-2 border-b border-border py-1.5 last:border-0"
      >
        <span className="w-20 shrink-0 pt-0.5 text-xs text-muted-foreground">
          {uk.company.kinds[contact.kind as keyof typeof uk.company.kinds]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {href ? (
              <a
                className="truncate text-accent"
                href={href}
                target={
                  contact.kind === 'phone' || contact.kind === 'email'
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
          </div>
          <p className="text-xs text-muted-foreground">
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
          {unavailable && (
            <p className="mt-1 inline-block rounded-full bg-err-bg px-2 py-0.5 text-xs text-err">
              {uk.telegram.unavailable}
              {unavailableReason ? `: ${unavailableReason}` : ''}
            </p>
          )}
          {contact.source === 'manual' && (
            <DeleteManualContact companyId={id} contactId={contact.id} />
          )}
        </div>
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
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-xl font-bold tracking-tight">
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

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
        <Section title={uk.scoring.top}>
          {mainScore ? (
            <ul className="space-y-1 text-sm">
              {(
                Object.keys(
                  uk.scoring.categories,
                ) as (keyof typeof uk.scoring.categories)[]
              ).map((category) => {
                const contact = mainScore.breakdown.top[category];
                const href = contact ? contactHref(contact) : undefined;
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
                        target="_blank"
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
        <Section
          title={uk.company.googleData}
          action={
            map && (
              <a
                className="inline-flex items-center gap-1 text-xs text-accent"
                href={map}
                target="_blank"
                rel="noreferrer"
              >
                <MapPin aria-hidden="true" className="size-3.5" />
                {uk.company.maps}
              </a>
            )
          }
        >
          <p className="text-sm">{c.address ?? uk.company.noData}</p>
          <p className="text-sm text-muted-foreground">
            {uk.google.businessStatus[
              c.business_status as keyof typeof uk.google.businessStatus
            ] ??
              c.business_status ??
              '—'}
          </p>
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
            {prozorro.count.toLocaleString('uk-UA')}
          </p>
        </Section>
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
          <CompanyEmail
            companyId={id}
            initial={messaging}
            selectedCampaign={selectedCampaign}
            drafts={Object.fromEntries(
              analyses.map((analysis) => [
                analysis.campaign_id,
                analysis.result.first_message,
              ]),
            )}
          />
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
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        {[
                          uk.company.score,
                          uk.scoring.value,
                          uk.scoring.weight,
                          uk.scoring.contribution,
                        ].map((label) => (
                          <th key={label} className="px-2 py-1 font-medium">
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
                          <th scope="row" className="px-2 py-1 font-normal">
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
                </section>
              ))}
            </Collapsible>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <Section title={`${uk.company.contacts} · ${contacts.length}`}>
            <ManualEntry companyId={id} />
            {!contacts.length && (
              <p className="text-sm text-muted-foreground">
                {uk.company.noData}
              </p>
            )}
            <ul className="text-sm">
              {sortedContacts.slice(0, visibleContacts).map(contactRow)}
            </ul>
            {sortedContacts.length > visibleContacts && (
              <details className="text-sm">
                <summary className="cursor-pointer text-accent">
                  {uk.company.more}: {sortedContacts.length - visibleContacts}
                </summary>
                <ul>{sortedContacts.slice(visibleContacts).map(contactRow)}</ul>
              </details>
            )}
          </Section>
          <Section title={uk.company.registry}>
            <RegistryMatch companyId={c.id} candidates={candidates} />
            {registryFacts.length > 0 && (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
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
                        : fact.kind === 'founders' && Array.isArray(fact.value)
                          ? fact.value
                              .map((f: { name: string | null; role: string }) =>
                                [f.name, f.role].filter(Boolean).join(' · '),
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
          <Collapsible title={uk.prozorro.title} count={prozorro.count}>
            {prozorroContacts.map((contact) => (
              <p key={contact.id}>
                {uk.company.kinds[contact.kind as 'phone' | 'email']}:{' '}
                <a className="text-accent" href={contactHref(contact)}>
                  {contact.normalized}
                </a>
              </p>
            ))}
            {facts
              .filter(
                (fact) =>
                  fact.source === 'prozorro' && fact.kind === 'contact_person',
              )
              .map((fact) => (
                <p key={fact.id} className="flex items-center gap-1.5">
                  {uk.prozorro.contactPerson}: {String(fact.value)}
                  <SourceLink url={fact.source_url} />
                </p>
              ))}
            {!prozorro.latest.length && (
              <p className="text-muted-foreground">{uk.prozorro.empty}</p>
            )}
            {prozorro.latest.map((purchase) => (
              <div
                className="space-y-0.5 border-t border-border pt-2"
                key={`${purchase.docType}:${purchase.docId}`}
              >
                <p className="flex items-start gap-1.5">
                  {purchase.title ?? uk.prozorro.untitled}
                  <SourceLink url={purchase.sourceUrl} />
                </p>
                <p className="text-xs text-muted-foreground">
                  <LocalTime value={purchase.date} dateOnly /> ·{' '}
                  {uk.prozorro.roles[purchase.role]} ·{' '}
                  {purchase.amount === null
                    ? '—'
                    : Number(purchase.amount).toLocaleString('uk-UA')}{' '}
                  {purchase.currency}
                </p>
              </div>
            ))}
          </Collapsible>
          <Collapsible title={uk.scanner.facts} count={siteFacts.length}>
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
          </Collapsible>
          <Collapsible
            title={uk.company.history}
            count={history.length + scans.length}
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
                  {uk.tasks.status[scan.status as keyof typeof uk.tasks.status]}{' '}
                  · <LocalTime value={scan.created_at} />
                </p>
                {scan.reason_uk && (
                  <p className="text-muted-foreground">{scan.reason_uk}</p>
                )}
                <ScanSummary result={scan.result} />
              </div>
            ))}
            <ul className="space-y-1">
              {history.map((row) => (
                <li key={row.id}>
                  {row.action === 'company.website.adopted'
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
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      </div>
    </>
  );
}
