import Link from 'next/link';
import { validId } from '@/lib/api-access';
import { notFound } from 'next/navigation';
import { normalizeWebsite } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from '@/components/shared';
import { CompanyAnalysis } from '@/components/company-analysis';
import { SiteScan } from '@/components/site-scan';
import { RegistryMatch } from '@/components/registry-match';
import { ScanSummary, Score } from '@/components/shared';
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
  const data = await getCompany(id);
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
  const date = (value: string | Date) =>
    new Date(value).toLocaleString('uk-UA');
  const siteFacts = facts.filter(
    (fact) => fact.source !== 'registry' && fact.kind !== 'page_text',
  );
  const registryFacts = facts.filter(
    (fact) => fact.source === 'registry' && fact.kind !== 'registry_entity',
  );
  const terminated = registryFacts.some(
    (fact) =>
      fact.kind === 'registry_status' &&
      /припин|ліквід|банкрут/i.test(String(fact.value)),
  );
  const map = normalizeWebsite(c.google_maps_uri)?.website;
  return (
    <>
      <Link
        className="mb-4 inline-flex min-h-11 items-center text-accent"
        href={
          '/companies' +
          (selectedCampaign ? '?campaignId=' + selectedCampaign : '')
        }
      >
        ← {uk.company.back}
      </Link>
      <PageHeader
        title={c.name}
        description={[
          c.city,
          c.primary_type,
          uk.company.statuses[c.status as keyof typeof uk.company.statuses],
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <SiteScan companyId={id} hasWebsite={!!c.website} />
      <div className="grid items-start gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <Card className="min-w-0 space-y-3 break-words p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.googleData}
          </h2>
          <p>{c.address ?? uk.company.noData}</p>
          <p>
            {uk.company.rating}: {c.rating ?? '—'} ({c.ratings_count ?? 0})
          </p>
          <p>
            {uk.google.businessStatus[
              c.business_status as keyof typeof uk.google.businessStatus
            ] ??
              c.business_status ??
              '—'}
          </p>
          <p>
            {uk.company.expires}:{' '}
            {c.google_expires_at ? date(c.google_expires_at) : '—'}
          </p>
          {map && (
            <a
              className="inline-flex min-h-11 items-center text-accent"
              href={map}
              target="_blank"
              rel="noreferrer"
            >
              {uk.company.maps}
            </a>
          )}
        </Card>
        <Card className="min-w-0 space-y-4 break-words p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.contacts}
          </h2>
          {!contacts.length && <p>{uk.company.noData}</p>}
          {contacts.map((contact) => (
            <div
              className="min-w-0 break-words border-b border-border pb-3"
              key={contact.id}
            >
              <p>
                {
                  uk.company.kinds[
                    contact.kind as keyof typeof uk.company.kinds
                  ]
                }
                {': '}
                {contact.kind === 'website' &&
                normalizeWebsite(contact.value) ? (
                  <a
                    className="text-accent"
                    href={normalizeWebsite(contact.value)!.website}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {contact.normalized}
                  </a>
                ) : contact.kind === 'phone' ? (
                  <a className="text-accent" href={'tel:' + contact.normalized}>
                    {contact.normalized}
                  </a>
                ) : (
                  contact.normalized
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {uk.company.source}:{' '}
                {
                  uk.company.sources[
                    contact.source as keyof typeof uk.company.sources
                  ]
                }{' '}
                · {date(contact.found_at)}
                {contact.meta?.ai && ` · ${uk.scanner.ai}`}
                {contact.meta?.alsoOnWebsite &&
                  ` · ${uk.scanner.alsoOnWebsite}`}
              </p>
              {normalizeWebsite(contact.source_url)?.website && (
                <a
                  className="text-accent"
                  href={normalizeWebsite(contact.source_url)!.website}
                  target="_blank"
                  rel="noreferrer"
                >
                  {uk.company.source}
                </a>
              )}
            </div>
          ))}
        </Card>
        <Card className="min-w-0 space-y-3 break-words p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.campaign}
          </h2>
          {campaigns.map((row) => (
            <div key={row.id}>
              <Link
                className="text-accent"
                href={'/campaigns?campaign=' + row.id}
              >
                {row.name}
              </Link>
              <p>
                {uk.company.batch} #{row.number} ·{' '}
                {uk.tasks.status[row.status as keyof typeof uk.tasks.status]} ·{' '}
                {date(row.added_at)}
              </p>
            </div>
          ))}
        </Card>
        <Card className="min-w-0 space-y-3 break-words p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.history}
          </h2>
          {history.map((row) => (
            <p key={row.id}>
              {row.action === 'company.found'
                ? uk.company.added
                : (uk.scanner.activities[
                    row.action as keyof typeof uk.scanner.activities
                  ] ?? uk.company.activity)}{' '}
              · {row.user_name ?? uk.appName} · {date(row.created_at)}
            </p>
          ))}
          {scans.map((scan) => (
            <div key={scan.id}>
              <p>
                {uk.scanner.title} ·{' '}
                {uk.tasks.status[scan.status as keyof typeof uk.tasks.status]} ·{' '}
                {date(scan.created_at)}
              </p>
              {scan.reason_uk && <p>{scan.reason_uk}</p>}
              <ScanSummary result={scan.result} />
            </div>
          ))}
          {!history.length && !scans.length && <p>{uk.company.noData}</p>}
        </Card>
        <Card className="min-w-0 space-y-3 break-words p-5">
          <h2 className="font-heading text-xl font-bold">{uk.scanner.facts}</h2>
          {!siteFacts.length && <p>{uk.company.noData}</p>}
          {siteFacts.map((fact) => (
            <div
              key={fact.id}
              className="min-w-0 break-words border-b border-border pb-3"
            >
              {fact.kind === 'schema_org' ? (
                <details>
                  <summary className="cursor-pointer min-h-11 py-2">
                    {uk.scanner.kinds.schema_org}
                  </summary>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 text-sm">
                    {JSON.stringify(fact.value, null, 2)}
                  </pre>
                </details>
              ) : (
                <p>
                  {uk.scanner.kinds[
                    fact.kind as keyof typeof uk.scanner.kinds
                  ] ?? fact.kind}
                  :{' '}
                  {fact.kind === 'site_status'
                    ? (fact.value.reason ?? uk.tasks.status.done)
                    : fact.kind === 'captcha'
                      ? (uk.scanner.captchas[
                          fact.value as keyof typeof uk.scanner.captchas
                        ] ?? String(fact.value))
                      : typeof fact.value === 'string'
                        ? fact.value
                        : JSON.stringify(fact.value)}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {
                  uk.company.sources[
                    fact.source as keyof typeof uk.company.sources
                  ]
                }{' '}
                · {date(fact.found_at)}
                {fact.expires_at &&
                  ` · ${uk.company.expires}: ${date(fact.expires_at)}`}
              </p>
              {normalizeWebsite(fact.source_url)?.website && (
                <a
                  className="text-accent"
                  href={normalizeWebsite(fact.source_url)!.website}
                  target="_blank"
                  rel="noreferrer"
                >
                  {uk.company.source}
                </a>
              )}
            </div>
          ))}
        </Card>
        <Card className="p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.registry}
          </h2>
          <RegistryMatch companyId={c.id} />
          {!registryFacts.length && (
            <p className="mt-3 text-muted-foreground">{uk.registry.empty}</p>
          )}
          {terminated && (
            <p role="alert" className="mt-3 text-err">
              {uk.registry.terminated}
            </p>
          )}
          <dl className="mt-3 space-y-2">
            {registryFacts.map((fact) => (
              <div key={fact.id} className="min-w-0 break-words">
                <dt className="text-sm text-muted-foreground">
                  {uk.registry.kinds[
                    fact.kind as keyof typeof uk.registry.kinds
                  ] ?? fact.kind}
                </dt>
                <dd>
                  {fact.kind === 'founders' && Array.isArray(fact.value)
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
          {registryFacts[0] && (
            <p className="mt-3 text-sm text-muted-foreground">
              {uk.company.sources.registry} · {date(registryFacts[0].found_at)}
            </p>
          )}
        </Card>
        <Card className="min-w-0 space-y-5 break-words p-5 lg:col-span-2">
          <h2 className="font-heading text-xl font-bold">
            {uk.analysis.title}
          </h2>
          {!campaigns.length && <p>{uk.company.noData}</p>}
          {[...campaigns]
            .sort(
              (a, b) =>
                Number(b.id === selectedCampaign) -
                Number(a.id === selectedCampaign),
            )
            .map((campaign) => (
              <section
                key={campaign.id}
                className="space-y-3 border-t border-border pt-4"
              >
                <h3 className="font-semibold">{campaign.name}</h3>
                <CompanyAnalysis
                  companyId={id}
                  campaignId={campaign.id}
                  analysis={analyses.find(
                    (row) => row.campaign_id === campaign.id,
                  )}
                />
              </section>
            ))}
        </Card>
        <Card className="min-w-0 space-y-5 p-5 lg:col-span-2">
          <h2 className="font-heading text-xl font-bold">{uk.company.score}</h2>
          {!scores.length && (
            <p className="text-muted-foreground">{uk.scoring.empty}</p>
          )}
          {[...scores]
            .sort(
              (a, b) =>
                Number(b.campaign_id === selectedCampaign) -
                Number(a.campaign_id === selectedCampaign),
            )
            .map((row) => (
              <section
                key={row.campaign_id}
                className="space-y-4 border-t border-border pt-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <Link
                    className="text-accent"
                    href={'/campaigns?campaign=' + row.campaign_id}
                  >
                    {row.campaign_name}
                  </Link>
                  <Score value={row.score} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {uk.scoring.computed}: {date(row.computed_at)}
                </p>
                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          {[
                            uk.company.score,
                            uk.scoring.value,
                            uk.scoring.weight,
                            uk.scoring.contribution,
                          ].map((label) => (
                            <th key={label} className="p-2">
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
                            <th scope="row" className="p-2 font-normal">
                              {
                                uk.campaign.weights[
                                  feature.feature as keyof typeof uk.campaign.weights
                                ]
                              }
                            </th>
                            <td className="p-2">
                              {(feature.value * 100).toFixed(0)}%
                            </td>
                            <td className="p-2">{feature.weight}</td>
                            <td className="p-2">
                              {feature.contribution.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="min-w-0 space-y-3">
                    <h3 className="font-semibold">{uk.scoring.top}</h3>
                    {(
                      Object.keys(
                        uk.scoring.categories,
                      ) as (keyof typeof uk.scoring.categories)[]
                    ).map((category) => {
                      const contact = row.breakdown.top[category];
                      const source = normalizeWebsite(
                        contact?.source_url ?? undefined,
                      )?.website;
                      const href =
                        contact?.kind === 'email'
                          ? 'mailto:' + contact.normalized
                          : contact?.kind === 'phone'
                            ? 'tel:' + contact.normalized
                            : normalizeWebsite(contact?.value)?.website;
                      return (
                        <div key={category} className="min-w-0 break-words">
                          <p className="font-medium">
                            {uk.scoring.categories[category]}
                          </p>
                          {!contact ? (
                            <p className="text-muted-foreground">
                              {uk.company.noData}
                            </p>
                          ) : (
                            <>
                              {href ? (
                                <a
                                  className="text-accent"
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {contact.normalized}
                                </a>
                              ) : (
                                <p>{contact.normalized}</p>
                              )}
                              <p className="text-sm text-muted-foreground">
                                {uk.company.source}:{' '}
                                {
                                  uk.company.sources[
                                    contact.source as keyof typeof uk.company.sources
                                  ]
                                }{' '}
                                · {date(contact.found_at)}
                              </p>
                              {source && (
                                <a
                                  className="text-accent"
                                  href={source}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {uk.company.source}
                                </a>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            ))}
        </Card>
      </div>
    </>
  );
}
