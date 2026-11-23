'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  companyFiltersSchema,
  filtersFromParams,
  type CompanyFilters,
} from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ChevronDown } from 'lucide-react';
import { CompanyCard, type CompanyCardRow } from './company-card';
import { CompanyTable } from './company-table';
import { Card, PageHeader } from './shared';
import { runAiJob } from '@/lib/ai-job';
import { ManualEntry } from './manual-entry';
type Row = CompanyCardRow;
const sortLabels = {
  quality: uk.company.qualityDescending,
  score: uk.company.scoreDescending,
  newest: uk.company.newest,
};
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
  const query = useSearchParams();
  const filters = useMemo(() => {
    const values = new URLSearchParams(query.toString());
    if (values.has('campaign'))
      values.set('campaignId', values.get('campaign')!);
    try {
      return filtersFromParams(values);
    } catch {
      return {};
    }
  }, [query]);
  const filterKey = params(filters).toString();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [draft, setDraft] = useState<CompanyFilters>(initialFilters),
    [pagination, setPagination] = useState({ key: filterKey, page: 1 }),
    [data, setData] = useState<{
      companies: Row[];
      total: number;
      pageSize: number;
    }>({ companies: [], total: 0, pageSize: 25 }),
    [campaigns, setCampaigns] = useState<
      { id: string; name: string; countryCode: string }[]
    >([]),
    [error, setError] = useState(''),
    [description, setDescription] = useState(''),
    [preview, setPreview] = useState<CompanyFilters | null>(null),
    [pending, setPending] = useState(false),
    [loading, setLoading] = useState(false),
    [showAi, setShowAi] = useState(false);
  const page = pagination.key === filterKey ? pagination.page : 1;
  const setPage = (page: number) => setPagination({ key: filterKey, page });
  useEffect(() => {
    clearTimeout(timer.current);
    setDraft(filters);
  }, [filters]);
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
        const rows = (await r.json()).campaigns as {
          id: string;
          name: string;
          country_code: string;
        }[];
        setCampaigns(
          rows.map((campaign) => ({
            id: campaign.id,
            name: campaign.name,
            countryCode: campaign.country_code,
          })),
        );
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
    const next = { ...draft, [key]: value };
    setDraft(next);
    setPreview(null);
    clearTimeout(timer.current);
    if (['q', 'city', 'minRating', 'minScore'].includes(key))
      timer.current = setTimeout(() => apply(next), 400);
    else apply(next);
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
    clearTimeout(timer.current);
    const parsed = companyFiltersSchema.safeParse(f);
    if (!parsed.success) {
      setError(uk.ai.invalid);
      return;
    }
    setError('');
    const next = parsed.data;
    const url = new URL(window.location.href);
    for (const key of Object.keys(companyFiltersSchema.shape))
      url.searchParams.delete(key);
    url.searchParams.delete('campaign');
    url.searchParams.delete('page');
    for (const [key, value] of params(next))
      url.searchParams.set(key === 'campaignId' ? 'campaign' : key, value);
    window.history.replaceState(null, '', url);
    setDraft(next);
    setPagination({ key: params(next).toString(), page: 1 });
  };
  const link = (id: string) =>
    '/companies/' +
    id +
    (filters.campaignId ? '?campaignId=' + filters.campaignId : '');
  return (
    <>
      <PageHeader
        {...uk.pages.companies}
        actions={
          <ManualEntry
            campaigns={campaigns}
            initialCampaignId={initialFilters.campaignId}
          />
        }
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
          aria-expanded={showAi}
          onClick={() => setShowAi(!showAi)}
        >
          {uk.company.aiFilters}
          <ChevronDown
            aria-hidden="true"
            className={showAi ? 'rotate-180' : ''}
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
      {showAi && (
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
                      : key === 'status'
                        ? (uk.company.statuses[
                            value as keyof typeof uk.company.statuses
                          ] ?? String(value))
                        : key === 'sort'
                          ? (sortLabels[value as keyof typeof sortLabels] ??
                            String(value))
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
        </Card>
      )}
      <div className="mb-3 grid items-end gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
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
            className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
            value={draft.sort ?? 'quality'}
            onChange={(e) =>
              update('sort', e.target.value as CompanyFilters['sort'])
            }
          >
            <option value="quality">{uk.company.qualityDescending}</option>
            <option value="score">{uk.company.scoreDescending}</option>
            <option value="newest">{uk.company.newest}</option>
          </select>
        </label>
        <label>
          {uk.company.platforms}
          <select
            className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
            value={draft.platforms ?? 'all'}
            onChange={(e) =>
              update('platforms', e.target.value as CompanyFilters['platforms'])
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
        {(['hasWebsite', 'hasPhone'] as const).map((key) => (
          <label className="flex min-h-11 items-center gap-2" key={key}>
            <input
              type="checkbox"
              checked={draft[key] === true}
              onChange={(e) => update(key, e.target.checked ? true : undefined)}
            />
            {uk.company[key]}
          </label>
        ))}
      </div>
      {Object.values(filters).some(
        (value) => value !== undefined && value !== '',
      ) && (
        <Button
          variant="ghost"
          className="mb-3 px-0 underline underline-offset-4"
          onClick={() => apply({})}
        >
          {uk.company.reset}
        </Button>
      )}
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
                    ...draft,
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
        className="mb-4 inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-chip p-1"
        aria-label={uk.company.status}
      >
        {['', ...Object.keys(uk.company.statuses)].map((status) => (
          <Button
            key={status}
            className="text-xs"
            variant={
              filters.status === status || (!filters.status && !status)
                ? 'tabActive'
                : 'tab'
            }
            aria-pressed={
              filters.status === status || (!filters.status && !status)
            }
            onClick={() => {
              const f = {
                ...draft,
                status: (status as CompanyFilters['status']) || undefined,
              };
              setDraft((previous) => ({ ...previous, status: f.status }));
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
      <div className="hidden md:block">
        {data.companies.length > 0 && (
          <CompanyTable companies={data.companies} link={link} />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 md:hidden">
        {data.companies.map((c) => (
          <CompanyCard key={c.id} company={c} link={link} />
        ))}
      </div>
      {!loading && !data.companies.length && (
        <Card className="p-5">{uk.company.noResults}</Card>
      )}
      <div className="mt-4 flex items-center justify-end gap-3 text-sm">
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
