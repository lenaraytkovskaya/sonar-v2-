'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { companyFiltersSchema, type CompanyFilters } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ChevronDown, Network, Store } from 'lucide-react';
import { Card, CompanyStatus, PageHeader, Score } from './shared';
import { runAiJob } from '@/lib/ai-job';
import { ManualEntry } from './manual-entry';
type Row = {
  id: string;
  name: string;
  city: string | null;
  primary_type: string | null;
  rating: string | null;
  score: number | null;
  website: string | null;
  status: keyof typeof uk.company.statuses;
  created_at: string;
  ratings_count: number | null;
  phones: string[];
  emails: string[];
  channels: string[];
  registry: boolean;
  platform: boolean;
  domain: string | null;
  chain_size: number;
  branches?: { id: string; name: string; address: string | null }[];
  campaigns: { id: string; name: string }[];
};
const channelOrder = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
] as const;
function params(filters: CompanyFilters) {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}
export function CompanyList({
  initialCampaignId,
}: {
  initialCampaignId?: string;
}) {
  const [draft, setDraft] = useState<CompanyFilters>({
      campaignId: initialCampaignId,
    }),
    [filters, setFilters] = useState<CompanyFilters>({
      campaignId: initialCampaignId,
    }),
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
    [loading, setLoading] = useState(false),
    [showFilters, setShowFilters] = useState(false);
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
  const link = (id: string) =>
    '/companies/' +
    id +
    (filters.campaignId ? '?campaignId=' + filters.campaignId : '');
  return (
    <>
      <PageHeader {...uk.pages.companies} />
      <ManualEntry
        campaigns={campaigns}
        initialCampaignId={initialCampaignId}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          aria-label={uk.company.search}
          placeholder={uk.company.search}
          className="max-w-sm"
          value={draft.q ?? ''}
          maxLength={200}
          onChange={(e) => update('q', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(draft);
          }}
        />
        <Button
          variant="outline"
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
        >
          {showFilters ? uk.company.hideFilters : uk.company.showFilters}
          <ChevronDown
            aria-hidden="true"
            className={showFilters ? 'rotate-180' : ''}
          />
        </Button>
        <a
          className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-sm"
          href={'/api/companies/export?' + params(filters)}
        >
          {uk.company.export}
        </a>
        <span
          className="ml-auto text-sm text-muted-foreground"
          aria-live="polite"
        >
          {uk.company.total}: {loading ? '…' : data.total}
        </span>
      </div>
      {showFilters && (
        <Card className="mb-3 space-y-3 p-4">
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
                      platforms: uk.company.platforms,
                      hasPhone: uk.company.hasPhone,
                      minRating: uk.company.minRating,
                      minScore: uk.company.minScore,
                      sort: uk.company.sort,
                    }[key as keyof CompanyFilters]
                  }
                  :{' '}
                  {typeof value === 'boolean'
                    ? value
                      ? '✓'
                      : '—'
                    : key === 'platforms'
                      ? uk.company.platformOptions[
                          value as keyof typeof uk.company.platformOptions
                        ]
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
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
              {uk.company.minScore}
              <Input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={draft.minScore ?? ''}
                onChange={(e) =>
                  update(
                    'minScore',
                    e.target.value === '' ? undefined : e.target.valueAsNumber,
                  )
                }
              />
            </label>
            <label>
              {uk.company.sort}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                value={draft.sort ?? (draft.campaignId ? 'score' : 'newest')}
                onChange={(e) =>
                  update('sort', e.target.value as CompanyFilters['sort'])
                }
              >
                <option value="score">{uk.company.scoreDescending}</option>
                <option value="newest">{uk.company.newest}</option>
              </select>
            </label>
            <label>
              {uk.company.campaign}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
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
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
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
            <label>
              {uk.company.platforms}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                value={draft.platforms ?? 'all'}
                onChange={(e) =>
                  update(
                    'platforms',
                    e.target.value as CompanyFilters['platforms'],
                  )
                }
              >
                {Object.entries(uk.company.platformOptions).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <div className="flex items-center gap-5">
              {(['hasWebsite', 'hasPhone'] as const).map((key) => (
                <label className="flex min-h-9 items-center gap-2" key={key}>
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
          </div>
        </Card>
      )}
      <div
        className="mb-3 flex flex-wrap gap-1.5"
        aria-label={uk.company.status}
      >
        {['', ...Object.keys(uk.company.statuses)].map((status) => (
          <Button
            key={status}
            className="min-h-8 px-2.5 text-xs"
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
        <p role="alert" className="mb-3 text-err">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {data.companies.map((c) => (
          <Card key={c.id} className="flex min-w-0 flex-col gap-2.5 p-3.5">
            <div className="flex items-start justify-between gap-2">
              <Link
                className="line-clamp-2 min-w-0 font-semibold leading-snug text-foreground hover:text-accent"
                href={link(c.id)}
                title={c.name}
              >
                {c.name}
              </Link>
              <CompanyStatus status={c.status} />
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0 text-xs text-muted-foreground">
                <p className="truncate">
                  {[c.city, c.primary_type].filter(Boolean).join(' · ') || '—'}
                </p>
                <p>
                  <span className="text-wait">★</span> {c.rating ?? '—'}
                  {c.ratings_count ? (
                    <>
                      {' '}
                      · {c.ratings_count} {uk.company.reviews}
                    </>
                  ) : null}
                </p>
              </div>
              <Score value={c.score} compact />
            </div>
            <div
              className="flex flex-wrap gap-1"
              aria-label={uk.company.channels}
            >
              {channelOrder
                .filter((kind) => c.channels.includes(kind))
                .map((kind) => (
                  <span
                    key={kind}
                    className="rounded bg-ok-bg px-1.5 py-0.5 text-[11px] font-medium text-ok"
                  >
                    {uk.company.kinds[kind]}
                  </span>
                ))}
              {c.registry && (
                <span className="rounded bg-run-bg px-1.5 py-0.5 text-[11px] font-medium text-run">
                  {uk.company.registry}
                </span>
              )}
              {c.platform && (
                <span
                  className="inline-flex items-center gap-1 rounded bg-wait-bg px-1.5 py-0.5 text-[11px] font-medium text-wait"
                  title={uk.company.platformHint}
                >
                  <Store aria-hidden="true" className="size-3" />
                  {uk.company.platform}
                </span>
              )}
              {!c.channels.length && (
                <span className="text-xs text-muted-foreground">
                  {uk.company.noContacts}
                </span>
              )}
            </div>
            <div className="min-w-0 space-y-0.5 text-sm">
              {c.website && (
                <a
                  className="block truncate text-accent"
                  target="_blank"
                  rel="noreferrer"
                  href={c.website}
                >
                  {c.domain ?? c.website}
                </a>
              )}
              {c.emails[0] && (
                <a className="block truncate" href={'mailto:' + c.emails[0]}>
                  {c.emails[0]}
                </a>
              )}
              {c.phones[0] && (
                <a className="block tabular-nums" href={'tel:' + c.phones[0]}>
                  {c.phones[0]}
                  {c.phones.length > 1 && (
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      +{c.phones.length - 1}
                    </span>
                  )}
                </a>
              )}
            </div>
            {c.chain_size > 1 && (
              <details className="rounded-lg bg-raised px-2.5 py-1.5 text-sm">
                <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
                  <Network
                    aria-hidden="true"
                    className="size-3.5 text-accent"
                  />
                  {uk.company.chain}: {c.chain_size} {uk.company.branches}
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {c.branches?.map((branch) => (
                    <li key={branch.id} className="min-w-0">
                      <Link
                        className="block truncate text-accent"
                        href={link(branch.id)}
                      >
                        {branch.name}
                      </Link>
                      {branch.address && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {branch.address}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {c.campaigns.map((a) => a.name).join(', ')}
              </span>
              <span className="shrink-0">
                {new Date(c.created_at).toLocaleDateString('uk-UA')}
              </span>
            </div>
          </Card>
        ))}
      </div>
      {!loading && !data.companies.length && (
        <Card className="p-5">{uk.company.noResults}</Card>
      )}
      <div className="mt-4 flex items-center gap-3 text-sm">
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
