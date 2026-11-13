'use client';
import { useEffect, useState } from 'react';
import { companyFiltersSchema, type CompanyFilters } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FilterPanel } from './filter-panel';
import { CompanyCard, type CompanyCardRow } from './company-card';
import { Card, PageHeader } from './shared';
import { runAiJob } from '@/lib/ai-job';
import { ManualEntry } from './manual-entry';
type Row = CompanyCardRow;
function params(filters: CompanyFilters) {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}
export function CompanyList({
  initialFilters = {},
}: {
  initialFilters?: CompanyFilters;
}) {
  const [draft, setDraft] = useState<CompanyFilters>(initialFilters),
    [filters, setFilters] = useState<CompanyFilters>(initialFilters),
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
    const query = params(f).toString();
    window.history.replaceState(
      null,
      '',
      query ? `/companies?${query}` : '/companies',
    );
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
        initialCampaignId={initialFilters.campaignId}
      />
      <FilterPanel
        count={
          Object.values(filters).filter(
            (value) => value !== undefined && value !== '',
          ).length
        }
        onReset={() => {
          setDraft({});
          apply({});
          setPreview(null);
        }}
        toolbar={
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
        }
      >
        <Card className="space-y-3 border-0 shadow-none">
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
        {campaigns.length > 0 && (
          <div
            className="mb-2 flex flex-wrap items-center gap-1.5"
            aria-label={uk.company.campaign}
          >
            <span className="mr-1 text-xs text-muted-foreground">
              {uk.company.campaign}:
            </span>
            {[{ id: '', name: uk.company.allCampaigns }, ...campaigns].map(
              (campaign) => (
                <Button
                  key={campaign.id}
                  className="min-h-8 px-2.5 text-xs"
                  variant={
                    (filters.campaignId ?? '') === campaign.id
                      ? 'default'
                      : 'outline'
                  }
                  onClick={() => {
                    const f = {
                      ...filters,
                      campaignId: campaign.id || undefined,
                    };
                    setDraft(f);
                    apply(f);
                  }}
                >
                  {campaign.name}
                </Button>
              ),
            )}
          </div>
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
                ? uk.company.statuses[
                    status as keyof typeof uk.company.statuses
                  ]
                : uk.company.all}
            </Button>
          ))}
        </div>
      </FilterPanel>
      <div className="mb-3 flex items-center justify-between gap-2 text-sm">
        <a
          className="inline-flex min-h-11 items-center rounded-lg border border-border px-3"
          href={'/api/companies/export?' + params(filters)}
        >
          {uk.company.export}
        </a>
        <span aria-live="polite" className="text-muted-foreground">
          {uk.company.total}: {loading ? '…' : data.total}
        </span>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-err">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {data.companies.map((c) => (
          <CompanyCard key={c.id} company={c} link={link} />
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
