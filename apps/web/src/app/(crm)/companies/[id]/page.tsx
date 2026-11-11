import Link from 'next/link';
import { validId } from '@/lib/api-access';
import { notFound } from 'next/navigation';
import { normalizeWebsite } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from '@/components/shared';
import { SiteScan } from '@/components/site-scan';
import { ScanSummary } from '@/components/shared';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!validId(id)) notFound();
  const { getCompany } = await import('@sonar/db/companies');
  const data = await getCompany(id);
  if (!data) notFound();
  const { company: c, contacts, campaigns, history, facts, scans } = data;
  const date = (value: string) => new Date(value).toLocaleString('uk-UA');
  const map = normalizeWebsite(c.google_maps_uri)?.website;
  return (
    <>
      <Link
        className="mb-4 inline-flex min-h-11 items-center text-accent"
        href="/companies"
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
      <div className="grid gap-5 lg:grid-cols-2">
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
          {!facts.length && <p>{uk.company.noData}</p>}
          {facts.map((fact) => (
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
        {[uk.company.score, uk.company.registry].map((label) => (
          <Card className="p-5" key={label}>
            <h2 className="font-heading text-xl font-bold">{label}</h2>
            <p className="mt-3 text-muted-foreground">{uk.company.later}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
