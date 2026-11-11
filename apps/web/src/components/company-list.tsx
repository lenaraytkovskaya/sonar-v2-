'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { companyFiltersSchema, type CompanyFilters } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, PageHeader } from './shared';
import { runAiJob } from '@/lib/ai-job';
type Row = {
  id: string;
  name: string;
  city: string | null;
  primary_type: string | null;
  rating: string | null;
  website: string | null;
  status: keyof typeof uk.company.statuses;
  created_at: string;
  phones: string[];
  campaigns: { id: string; name: string }[];
};
function params(filters: CompanyFilters) {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}
export function CompanyList() {
  const [draft, setDraft] = useState<CompanyFilters>({}),
    [filters, setFilters] = useState<CompanyFilters>({}),
    [page, setPage] = useState(1),
    [data, setData] = useState<{
      companies: Row[];
      total: number;
      pageSize: number;
    }>({ companies: [], total: 0, pageSize: 25 }),
    [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [description, setDescription] = useState(''),
    [preview, setPreview] = useState<CompanyFilters | null>(null),
    [pending, setPending] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const p = params(filters);
    p.set('page', String(page));
    fetch('/api/companies?' + p, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        setData(await r.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(uk.ai.error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, page]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/campaigns', { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        setCampaigns((await r.json()).campaigns);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(uk.ai.error);
      });
    return () => controller.abort();
  }, []);
  const update = (
    key: keyof CompanyFilters,
    value: CompanyFilters[keyof CompanyFilters],
  ) => {
    setDraft({ ...draft, [key]: value });
    setPreview(null);
  };
  const suggest = async () => {
    setPending(true);
    setError('');
    setPreview(null);
    try {
      const r = await runAiJob('/api/ai/assist', {
        action: 'company_filters',
        text: description,
      });
      setPreview(companyFiltersSchema.parse(r.filters));
    } catch (e) {
      setError(
        e instanceof Error && !('issues' in e) ? e.message : uk.ai.invalid,
      );
    } finally {
      setPending(false);
    }
  };
  const apply = (f: CompanyFilters) => {
    setFilters(companyFiltersSchema.parse(f));
    setPage(1);
  };
  return (
    <>
      <PageHeader {...uk.pages.companies} />
      <Card className="mb-6 space-y-4 p-5">
        <label className="block">
          {uk.company.natural}
          <Input
            value={description}
            maxLength={1000}
            onChange={(e) => {
              setDescription(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <Button
          variant="outline"
          disabled={pending || !description.trim()}
          onClick={() => void suggest()}
        >
          {pending ? uk.ai.pending : uk.company.suggest}
        </Button>
        {preview && (
          <div className="space-y-3 rounded-lg bg-raised p-4">
            <p>{uk.ai.preview}</p>
            {Object.entries(preview).map(([key, value]) => (
              <p key={key}>
                {
                  {
                    q: uk.company.search,
                    city: uk.company.city,
                    campaignId: uk.company.campaign,
                    status: uk.company.status,
                    hasWebsite: uk.company.hasWebsite,
                    hasPhone: uk.company.hasPhone,
                    minRating: uk.company.minRating,
                  }[key as keyof CompanyFilters]
                }
                :{' '}
                {typeof value === 'boolean'
                  ? value
                    ? '✓'
                    : '—'
                  : String(value)}
              </p>
            ))}
            <Button
              onClick={() => {
                setDraft(preview);
                apply(preview);
                setPreview(null);
              }}
            >
              {uk.ai.apply}
            </Button>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {uk.ai.cancel}
            </Button>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-3 2xl:grid-cols-6">
          <label>
            {uk.company.search}
            <Input
              value={draft.q ?? ''}
              maxLength={200}
              onChange={(e) => update('q', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply(draft);
              }}
            />
          </label>
          <label>
            {uk.company.city}
            <Input
              value={draft.city ?? ''}
              maxLength={200}
              onChange={(e) => update('city', e.target.value)}
            />
          </label>
          <label>
            {uk.company.minRating}
            <Input
              type="number"
              min="0"
              max="5"
              step="0.1"
              value={draft.minRating ?? ''}
              onChange={(e) =>
                update(
                  'minRating',
                  e.target.value === '' ? undefined : e.target.valueAsNumber,
                )
              }
            />
          </label>
          <label>
            {uk.company.campaign}
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
              value={draft.campaignId ?? ''}
              onChange={(e) =>
                update('campaignId', e.target.value || undefined)
              }
            >
              <option value="">{uk.company.all}</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uk.company.status}
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
              value={draft.status ?? ''}
              onChange={(e) =>
                update(
                  'status',
                  (e.target.value || undefined) as CompanyFilters['status'],
                )
              }
            >
              <option value="">{uk.company.all}</option>
              {Object.entries(uk.company.statuses).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-5">
            {(['hasWebsite', 'hasPhone'] as const).map((key) => (
              <label className="flex min-h-11 items-center gap-2" key={key}>
                <input
                  type="checkbox"
                  checked={draft[key] === true}
                  onChange={(e) =>
                    update(key, e.target.checked ? true : undefined)
                  }
                />
                {uk.company[key]}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={!companyFiltersSchema.safeParse(draft).success}
            onClick={() => apply(draft)}
          >
            {uk.company.apply}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDraft({});
              apply({});
              setPreview(null);
            }}
          >
            {uk.company.reset}
          </Button>
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4"
            href={'/api/companies/export?' + params(filters)}
          >
            {uk.company.export}
          </a>
        </div>
      </Card>
      <div className="mb-4 flex flex-wrap gap-2" aria-label={uk.company.status}>
        {['', ...Object.keys(uk.company.statuses)].map((status) => (
          <Button
            key={status}
            variant={
              filters.status === status || (!filters.status && !status)
                ? 'default'
                : 'outline'
            }
            onClick={() => {
              const f = {
                ...filters,
                status: (status as CompanyFilters['status']) || undefined,
              };
              setDraft(f);
              apply(f);
            }}
          >
            {status
              ? uk.company.statuses[status as keyof typeof uk.company.statuses]
              : uk.company.all}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-4 text-err">
          {error}
        </p>
      )}
      <p className="mb-3" aria-live="polite">
        {uk.company.total}: {loading ? '…' : data.total}
      </p>
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-raised">
            <tr>
              {[
                uk.company.name,
                uk.company.contacts,
                uk.company.campaign,
                uk.company.status,
                uk.company.date,
              ].map((h) => (
                <th className="p-4" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.companies.map((c) => (
              <tr className="border-t border-border" key={c.id}>
                <td className="min-w-52 p-4">
                  <Link
                    className="font-semibold text-accent"
                    href={'/companies/' + c.id}
                  >
                    {c.name}
                  </Link>
                  <p className="text-muted-foreground">
                    {c.city} · {c.primary_type}
                  </p>
                  <p>
                    {uk.company.rating}: {c.rating ?? '—'}
                  </p>
                </td>
                <td className="p-4">
                  {c.website && (
                    <a
                      className="block max-w-52 truncate text-accent"
                      target="_blank"
                      rel="noreferrer"
                      href={c.website}
                    >
                      {c.website}
                    </a>
                  )}
                  {c.phones.map((phone) => (
                    <a className="block" key={phone} href={'tel:' + phone}>
                      {phone}
                    </a>
                  ))}
                </td>
                <td className="p-4">
                  {c.campaigns.map((a) => (
                    <Link
                      className="block text-accent"
                      key={a.id}
                      href={'/campaigns?campaign=' + a.id}
                    >
                      {a.name}
                    </Link>
                  ))}
                </td>
                <td className="p-4">
                  <span className="rounded-full bg-chip px-3 py-1 whitespace-nowrap">
                    {uk.company.statuses[c.status]}
                  </span>
                </td>
                <td className="p-4 whitespace-nowrap">
                  {new Date(c.created_at).toLocaleDateString('uk-UA')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !data.companies.length && (
          <p className="p-5">{uk.company.noResults}</p>
        )}
      </Card>
      <div className="mt-4 flex items-center gap-4">
        <Button
          variant="outline"
          disabled={loading || page === 1}
          onClick={() => setPage(page - 1)}
        >
          {uk.company.previous}
        </Button>
        <span>
          {uk.company.page} {page} /{' '}
          {Math.max(1, Math.ceil(data.total / data.pageSize))}
        </span>
        <Button
          variant="outline"
          disabled={loading || page * data.pageSize >= data.total}
          onClick={() => setPage(page + 1)}
        >
          {uk.company.next}
        </Button>
      </div>
    </>
  );
}
