import Link from 'next/link';
import { validId } from '@/lib/api-access';
import { notFound } from 'next/navigation';
import { normalizeWebsite } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from '@/components/shared';
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
  const { company: c, contacts, campaigns, history } = data;
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
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-3 p-5">
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
        <Card className="space-y-4 p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.contacts}
          </h2>
          {!contacts.length && <p>{uk.company.noData}</p>}
          {contacts.map((contact) => (
            <div className="border-b border-border pb-3" key={contact.id}>
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
        <Card className="space-y-3 p-5">
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
        <Card className="space-y-3 p-5">
          <h2 className="font-heading text-xl font-bold">
            {uk.company.history}
          </h2>
          {history.map((row) => (
            <p key={row.id}>
              {row.action === 'company.found'
                ? uk.company.added
                : uk.company.activity}{' '}
              · {row.user_name ?? uk.appName} · {date(row.created_at)}
            </p>
          ))}
          {!history.length && <p>{uk.company.noData}</p>}
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
