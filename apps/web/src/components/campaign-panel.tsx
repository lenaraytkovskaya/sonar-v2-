'use client';
import { useEffect, useRef, useState } from 'react';
import {
  campaignSchema,
  createCampaignDraft,
  type CampaignDefaults,
  type GoogleProgress,
  normalizeCampaignLanguages,
  googleSearchPairs,
  applyCampaignSuggestion,
  campaignSuggestionSchema,
  type CampaignInput,
  type ProductDto,
} from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, PageHeader, StatusBadge } from './shared';
import { useTasks } from './task-overview';
import { BatchList } from './batch-list';
import { CampaignCompanies } from './campaign-companies';
import { runAiJob } from '@/lib/ai-job';
import { CrudButton, CrudDialog } from './crud-dialog';
import { CampaignFormFields } from './campaign-form-fields';
import { Callout } from './ui/layout';
import { CampaignRunCard } from './campaign-run-card';
import { CampaignRunning } from './campaign-running';
type Row = CampaignInput & {
  id: string;
  google_progress?: GoogleProgress;
};
// Query tags shown before the rest is folded behind a button.
const queryPreview = 5;
export function CampaignPanel({
  defaults,
  defaultWeights,
  googlePriceUsd,
  pollMs,
}: {
  defaults: CampaignDefaults;
  defaultWeights: CampaignInput['scoring_weights'];
  googlePriceUsd: number;
  pollMs: number;
}) {
  const initialForm = () => createCampaignDraft(defaults, defaultWeights);
  const withWeights = (row: CampaignInput): CampaignInput => ({
    ...normalizeCampaignLanguages(row),
    outreach_goal: row.outreach_goal ?? '',
    min_score: Number(row.min_score),
    scoring_weights: { ...defaultWeights, ...row.scoring_weights },
  });
  const { batches: batchProgress } = useTasks();
  const [open, setOpen] = useState(false);
  const editorForm = useRef<HTMLFormElement>(null);
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [allQueries, setAllQueries] = useState(false);
  const selectionChanged = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const [rows, setRows] = useState<Row[]>([]),
    [id, setId] = useState<string | null>(null),
    [form, setForm] = useState(initialForm),
    [description, setDescription] = useState(''),
    [source, setSource] = useState('form'),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const messageTone = [
    uk.ai.saved,
    uk.campaign.queued,
    uk.campaign.scoreQueued,
    uk.campaign.filled,
  ].some((value) => value === message)
    ? 'ok'
    : 'err';
  const savedProgress = rows.find((row) => row.id === id)?.google_progress;
  const exhausted =
    form.queries.length > 0 &&
    form.cities.length > 0 &&
    googleSearchPairs(form).every(({ query, city, language }) => {
      const p = savedProgress?.[JSON.stringify([query, city, language])];
      return p?.exhausted && !p.buffer.length;
    });
  const loadProducts = async () => {
    const response = await fetch('/api/products');
    if (!response.ok) throw Error(uk.ai.error);
    setProducts((await response.json()).products);
  };
  const load = async (selectFromUrl = false) => {
    const r = await fetch('/api/campaigns');
    if (!r.ok) throw Error(uk.ai.error);
    const d = await r.json();
    setRows(d.campaigns);
    const selected = new URLSearchParams(window.location.search).get(
      'campaign',
    );
    if (selectFromUrl && !selectionChanged.current) {
      const row =
        d.campaigns.find((c: Row) => c.id === selected) ?? d.campaigns[0];
      if (row) {
        setId(row.id);
        setSelectedId(row.id);
        setForm(
          campaignSchema
            .strip()
            .parse(withWeights({ ...row, budget_usd: Number(row.budget_usd) })),
        );
      }
    }
  };
  useEffect(() => {
    void Promise.all([load(true), loadProducts()]).catch(() =>
      setMessage(uk.ai.error),
    );
  }, []);
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      void loadProducts().catch(() => setMessage(uk.ai.error));
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [open]);
  useEffect(() => {
    void load().catch(() => setMessage(uk.ai.error));
  }, [batchProgress]);
  const act = async (kind: 'save' | 'start' | 'score') => {
    if (open && kind === 'save' && !editorForm.current?.reportValidity())
      return;
    setPending(true);
    setMessage('');
    try {
      if (kind === 'start' && !form.product_id)
        throw Error(uk.campaign.productRequired);
      const parsed = campaignSchema
        .omit({ offer: true, outreach_goal: true })
        .strip()
        .safeParse({
          ...form,
          budget_usd: Number(form.budget_usd),
          status: kind === 'start' ? 'active' : form.status,
        });
      if (!parsed.success) {
        const key = parsed.error.issues[0]?.path[0];
        const label =
          typeof key === 'string'
            ? (uk.campaign as Record<string, unknown>)[
                key === 'language_code' ? 'language_codes' : key
              ]
            : undefined;
        throw Error(
          typeof label === 'string'
            ? uk.campaign.invalidField(label)
            : uk.ai.invalid,
        );
      }
      const data = parsed.data;
      const r = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, data, source }),
      });
      if (!r.ok) throw Error(uk.ai.invalid);
      const row = await r.json();
      setId(row.id);
      setForm({ ...form, ...data });
      setSource('form');
      if (kind === 'start') {
        const start = await fetch(`/api/campaigns/${row.id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: crypto.randomUUID() }),
        });
        const started = await start.json();
        if (!start.ok) throw Error(started.error ?? uk.ai.error);
        if (started.exhausted) {
          await load();
          setMessage(uk.google.exhausted);
          return;
        }
      }
      if (kind === 'score') {
        const scored = await fetch(`/api/campaigns/${row.id}/score`, {
          method: 'POST',
        });
        if (!scored.ok) {
          const result = await scored.json().catch(() => null);
          throw Error(result?.error ?? uk.ai.error);
        }
      }
      await load();
      setSelectedId(row.id);
      setOpen(false);
      setMessage(
        kind === 'start'
          ? uk.campaign.queued
          : kind === 'score'
            ? uk.campaign.scoreQueued
            : uk.ai.saved,
      );
    } catch (e) {
      setMessage(
        e instanceof Error && !('issues' in e) ? e.message : uk.ai.invalid,
      );
    } finally {
      setProgressVersion((value) => value + 1);
      setPending(false);
    }
  };
  const suggest = async () => {
    setPending(true);
    setMessage('');
    try {
      const r = await runAiJob('/api/ai/assist', {
        action: 'campaign',
        text: description,
        context: JSON.stringify({
          country: form.country_code,
          languages: form.language_codes ?? [form.language_code],
          cities: form.cities,
          queries: form.queries,
        }),
      });
      const suggestion = campaignSuggestionSchema.parse(r.suggestion);
      const next = applyCampaignSuggestion(form, suggestion);
      setForm(next);
      setSource('ai');
      setMessage(uk.campaign.filled);
    } catch (e) {
      setMessage(
        e instanceof Error && !('issues' in e) ? e.message : uk.ai.invalid,
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <PageHeader {...uk.pages.campaigns} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="min-w-0 space-y-3 p-4">
          <CrudButton
            disabled={pending}
            onClick={() => {
              selectionChanged.current = true;
              setId(null);
              setForm(initialForm);
              setDescription('');
              setSource('form');
              setMessage('');
              setOpen(true);
            }}
          >
            {uk.campaign.create}
          </CrudButton>
          {rows.length === 0 && <p>{uk.campaign.empty}</p>}
          {rows.map((row) => (
            <button
              className={`min-h-9 w-full rounded-lg p-3 text-left ${selectedId === row.id ? 'bg-chip' : 'hover:bg-raised'}`}
              key={row.id}
              onClick={() => {
                selectionChanged.current = true;
                setSelectedId(row.id);
                setId(row.id);
                setForm(
                  campaignSchema.strip().parse(
                    withWeights({
                      ...row,
                      budget_usd: Number(row.budget_usd),
                    }),
                  ),
                );
                setSource('form');
              }}
            >
              {row.name}
              <StatusBadge status={row.status}>
                {uk.campaign.statuses[row.status]}
              </StatusBadge>
            </button>
          ))}
        </Card>
        <Card className="min-w-0 space-y-4 p-5">
          {selectedId ? (
            <>
              <h2 className="font-heading text-lg font-bold">
                {rows.find((row) => row.id === selectedId)?.name}
              </h2>
              <CrudButton
                action="edit"
                disabled={pending}
                onClick={() => {
                  setMessage('');
                  setOpen(true);
                }}
              >
                {uk.crud.editCampaign}
              </CrudButton>
              <CampaignRunCard
                campaignId={selectedId}
                status={
                  rows.find((row) => row.id === selectedId)?.status ?? 'draft'
                }
                pending={pending}
                startDisabled={
                  exhausted ||
                  !form.cities.length ||
                  !form.queries.length ||
                  !campaignSchema.safeParse(form).success
                }
                startLabel={exhausted ? uk.google.exhausted : uk.campaign.start}
                onStart={() => void act('start')}
                onScore={() => void act('score')}
                onChanged={async () => {
                  setProgressVersion((value) => value + 1);
                  await load();
                }}
              />
              {!open && message && (
                <div role="status">
                  <Callout tone={messageTone}>{message}</Callout>
                </div>
              )}
              <CampaignRunning
                key={`running:${selectedId}`}
                campaignId={selectedId}
                pollMs={pollMs}
                refreshToken={progressVersion}
              />
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">
                    {uk.campaign.cities}:
                  </span>{' '}
                  {rows.find((row) => row.id === selectedId)?.cities.join(', ')}
                </p>
                <p className="font-medium text-foreground">
                  {uk.campaign.queries}:
                </p>
                <ul className="flex flex-wrap gap-2">
                  {(rows.find((row) => row.id === selectedId)?.queries ?? [])
                    .slice(0, allQueries ? undefined : queryPreview)
                    .map((query) => (
                      <li
                        key={query}
                        className="max-w-full break-words rounded-full bg-chip px-3 py-1 text-foreground"
                      >
                        {query}
                      </li>
                    ))}
                </ul>
                {(rows.find((row) => row.id === selectedId)?.queries.length ??
                  0) > queryPreview && (
                  <Button
                    variant="ghost"
                    onClick={() => setAllQueries(!allQueries)}
                  >
                    {allQueries
                      ? uk.campaign.queriesLess
                      : uk.campaign.queriesMore.replace(
                          '{n}',
                          String(
                            (rows.find((row) => row.id === selectedId)?.queries
                              .length ?? 0) - queryPreview,
                          ),
                        )}
                  </Button>
                )}
              </div>
              <BatchList key={selectedId} campaignId={selectedId} />
            </>
          ) : (
            <p>{uk.crud.selectCampaign}</p>
          )}
        </Card>
      </div>
      <CrudDialog
        wide
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            const saved = rows.find((row) => row.id === selectedId);
            setId(saved?.id ?? null);
            setForm(
              saved
                ? campaignSchema.strip().parse(
                    withWeights({
                      ...saved,
                      budget_usd: Number(saved.budget_usd),
                    }),
                  )
                : initialForm(),
            );
            setSource('form');
            setDescription('');
            setMessage('');
          }
        }}
        title={id ? uk.crud.editCampaign : uk.campaign.create}
        pending={pending}
        draft={{ form, description }}
        actions={
          <>
            {message && (
              <p
                role="status"
                className={`max-w-xs text-sm ${messageTone === 'err' ? 'text-err' : 'text-muted-foreground'}`}
              >
                {message}
              </p>
            )}
            <Button disabled={pending} onClick={() => void act('save')}>
              {pending ? uk.ai.pending : uk.ai.save}
            </Button>
          </>
        }
      >
        <form
          ref={editorForm}
          className="min-w-0 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void act('save');
          }}
        >
          <label className="block">
            {uk.campaign.describe}
            <Input
              value={description}
              maxLength={1000}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </label>
          <Button
            type="button"
            disabled={pending || !description.trim()}
            onClick={() => void suggest()}
          >
            {pending ? uk.ai.pending : uk.campaign.suggest}
          </Button>
          <p className="text-sm text-muted-foreground">
            {uk.campaign.suggestHint}
          </p>
          {open && (
            <CampaignFormFields
              form={form}
              products={products}
              progress={savedProgress ?? {}}
              priceUsd={googlePriceUsd}
              pending={pending}
              onError={setMessage}
              onChange={(patch, ai) => {
                setForm((current) => ({ ...current, ...patch }));
                setSource(ai ? 'ai' : 'form');
                setMessage('');
              }}
            />
          )}
        </form>
      </CrudDialog>
      {selectedId && (
        <Card className="mt-4 p-4">
          <CampaignCompanies key={selectedId} campaignId={selectedId} />
        </Card>
      )}
    </>
  );
}
