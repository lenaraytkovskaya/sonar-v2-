'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  campaignSchema,
  applyCampaignSuggestion,
  campaignSuggestionSchema,
  type CampaignInput,
  type CampaignSuggestion,
} from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, PageHeader } from './shared';
import { AiAssist } from './ai-assist';
import { useTasks } from './task-overview';
import { BatchList } from './batch-list';
import { runAiJob } from '@/lib/ai-job';
type Row = CampaignInput & {
  id: string;
  google_progress?: Record<string, { exhausted: boolean; buffer: unknown[] }>;
};
const initial: CampaignInput = {
  name: '',
  country_code: 'UA',
  language_code: 'uk',
  cities: [],
  queries: [],
  offer: '',
  batch_size: 20,
  budget_usd: 0.5,
  channels: { email: true, telegram: false, whatsapp: false, forms: false },
  send_mode: 'approval',
  scoring_weights: {},
  status: 'draft',
  field_profile: 'contacts',
};
function Chips({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    if (input.trim()) {
      onChange([...new Set([...values, input.trim()])]);
      setInput('');
    }
  };
  return (
    <fieldset className="space-y-2">
      <legend>{label}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <button
            type="button"
            aria-label={`${uk.campaign.remove}: ${v}`}
            className="min-h-9 max-w-full rounded-full bg-chip px-3 break-words"
            key={v}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            {v} ×
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={input}
          maxLength={200}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" onClick={add}>
          {uk.campaign.add}
        </Button>
      </div>
    </fieldset>
  );
}
export function CampaignPanel({
  defaultWeights,
}: {
  defaultWeights: CampaignInput['scoring_weights'];
}) {
  const initialForm = { ...initial, scoring_weights: defaultWeights };
  const withWeights = (row: CampaignInput): CampaignInput => ({
    ...row,
    scoring_weights: { ...defaultWeights, ...row.scoring_weights },
  });
  const { batches: batchProgress } = useTasks();
  const [rows, setRows] = useState<Row[]>([]),
    [presets, setPresets] = useState<
      { id: string; name: string; data: CampaignInput }[]
    >([]),
    [id, setId] = useState<string | null>(null),
    [form, setForm] = useState(initialForm),
    [description, setDescription] = useState(''),
    [preview, setPreview] = useState<CampaignSuggestion | null>(null),
    [source, setSource] = useState('form'),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const savedProgress = rows.find((row) => row.id === id)?.google_progress;
  const exhausted =
    form.queries.length > 0 &&
    form.cities.length > 0 &&
    form.queries.every((query) =>
      form.cities.every((city) => {
        const p = savedProgress?.[JSON.stringify([query, city])];
        return p?.exhausted && !p.buffer.length;
      }),
    );
  const update = <K extends keyof CampaignInput>(
    key: K,
    value: CampaignInput[K],
  ) => {
    setPreview(null);
    setForm({ ...form, [key]: value });
  };
  const load = async (selectFromUrl = false) => {
    const r = await fetch('/api/campaigns');
    if (!r.ok) throw Error(uk.ai.error);
    const d = await r.json();
    setRows(d.campaigns);
    const selected = new URLSearchParams(window.location.search).get(
      'campaign',
    );
    if (selectFromUrl && selected) {
      const row = d.campaigns.find((c: Row) => c.id === selected);
      if (row) {
        setId(row.id);
        setForm(
          campaignSchema
            .strip()
            .parse(withWeights({ ...row, budget_usd: Number(row.budget_usd) })),
        );
      }
    }
    setPresets(d.presets);
  };
  useEffect(() => {
    void load(true).catch(() => setMessage(uk.ai.error));
  }, []);
  useEffect(() => {
    void load().catch(() => setMessage(uk.ai.error));
  }, [batchProgress]);
  const act = async (kind: 'save' | 'start' | 'pause' | 'score') => {
    setPending(true);
    setMessage('');
    try {
      const data = campaignSchema.parse({
        ...form,
        budget_usd: Number(form.budget_usd),
        status:
          kind === 'pause'
            ? 'paused'
            : kind === 'start'
              ? 'active'
              : form.status,
      });
      const r = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, data, source }),
      });
      if (!r.ok) throw Error(uk.ai.invalid);
      const row = await r.json();
      setId(row.id);
      setForm({ ...data });
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
      setPending(false);
    }
  };
  const suggest = async () => {
    setPending(true);
    setPreview(null);
    setMessage('');
    try {
      const r = await runAiJob('/api/ai/assist', {
        action: 'campaign',
        text: description,
      });
      setPreview(campaignSuggestionSchema.parse(r.suggestion));
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
          <Button
            onClick={() => {
              setId(null);
              setForm(initialForm);
              setPreview(null);
            }}
          >
            {uk.campaign.create}
          </Button>
          {rows.length === 0 && <p>{uk.campaign.empty}</p>}
          {rows.map((row) => (
            <button
              className={`min-h-9 w-full rounded-lg p-3 text-left ${id === row.id ? 'bg-chip' : 'hover:bg-raised'}`}
              key={row.id}
              onClick={() => {
                setId(row.id);
                setForm(
                  campaignSchema.strip().parse(
                    withWeights({
                      ...row,
                      budget_usd: Number(row.budget_usd),
                    }),
                  ),
                );
                setPreview(null);
                setSource('form');
              }}
            >
              {row.name}
              <span className="block text-sm text-muted-foreground">
                {uk.campaign.statuses[row.status]}
              </span>
            </button>
          ))}
        </Card>
        <Card className="min-w-0 space-y-5 p-5 xl:columns-2 xl:gap-10 [&>*]:break-inside-avoid">
          <label className="block">
            {uk.campaign.presets}
            <select
              className="mt-2 min-h-9 w-full rounded-lg border border-border bg-surface px-3"
              value=""
              onChange={(e) => {
                const preset = presets.find((p) => p.id === e.target.value);
                if (preset) {
                  setId(null);
                  setForm(withWeights(preset.data));
                  setPreview(null);
                }
              }}
            >
              <option value="">{uk.campaign.presets}</option>
              {presets.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            {uk.campaign.describe}
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
            disabled={pending || !description.trim()}
            onClick={() => void suggest()}
          >
            {uk.campaign.suggest}
          </Button>
          {preview && (
            <div className="space-y-3 rounded-lg bg-raised p-4">
              <h2 className="font-heading text-lg font-bold">
                {uk.ai.preview}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {(['name', 'country_code', 'language_code'] as const).map(
                  (key) => (
                    <label key={key} className="min-w-0">
                      {uk.campaign[key]}
                      <Input
                        value={preview[key]}
                        maxLength={200}
                        onChange={(e) =>
                          setPreview({ ...preview, [key]: e.target.value })
                        }
                      />
                    </label>
                  ),
                )}
              </div>
              <Chips
                label={uk.campaign.cities}
                values={preview.cities}
                onChange={(cities) => setPreview({ ...preview, cities })}
              />
              <Chips
                label={uk.campaign.queries}
                values={preview.queries}
                onChange={(queries) => setPreview({ ...preview, queries })}
              />
              <label className="block">
                {uk.campaign.offer}
                <textarea
                  className="mt-2 min-h-32 w-full rounded-lg border border-border bg-surface p-3"
                  value={preview.offer}
                  maxLength={20000}
                  disabled={preview.needs_about}
                  onChange={(e) =>
                    setPreview({ ...preview, offer: e.target.value })
                  }
                />
              </label>
              {preview.needs_about && (
                <p>
                  <Link
                    className="inline-flex min-h-9 items-center text-accent underline"
                    href="/settings#company-about"
                  >
                    {uk.campaign.needsAbout}
                  </Link>
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={
                    !campaignSchema.safeParse(
                      applyCampaignSuggestion(form, preview),
                    ).success
                  }
                  onClick={() => {
                    setForm(applyCampaignSuggestion(form, preview));
                    setSource('ai');
                    setPreview(null);
                  }}
                >
                  {uk.ai.apply}
                </Button>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  {uk.ai.cancel}
                </Button>
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {(['name', 'country_code', 'language_code'] as const).map((key) => (
              <label key={key}>
                {uk.campaign[key]}
                <Input
                  value={form[key]}
                  maxLength={200}
                  onChange={(e) => update(key, e.target.value)}
                />
              </label>
            ))}
            <label>
              {uk.campaign.budget_usd}
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.budget_usd}
                onChange={(e) => update('budget_usd', Number(e.target.value))}
              />
            </label>
          </div>
          <Chips
            key={`${id}:cities`}
            label={uk.campaign.cities}
            values={form.cities}
            onChange={(v) => update('cities', v)}
          />
          <Chips
            key={`${id}:queries`}
            label={uk.campaign.queries}
            values={form.queries}
            onChange={(v) => update('queries', v)}
          />
          <label className="block">
            {uk.campaign.offer}
            <textarea
              className="mt-2 min-h-32 w-full rounded-lg border border-border bg-surface p-3"
              value={form.offer}
              maxLength={20000}
              onChange={(e) => update('offer', e.target.value)}
            />
          </label>
          <AiAssist
            text={form.offer}
            onApply={(v) => {
              update('offer', v);
              setSource('ai');
            }}
          />
          <div className="grid gap-4 sm:grid-cols-3 xl:break-before-column">
            <label>
              {uk.campaign.batch_size}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                value={form.batch_size}
                onChange={(e) =>
                  update(
                    'batch_size',
                    Number(e.target.value) as CampaignInput['batch_size'],
                  )
                }
              >
                {[20, 50, 100, 200].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              {uk.campaign.send_mode}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                value={form.send_mode}
                onChange={(e) =>
                  update(
                    'send_mode',
                    e.target.value as CampaignInput['send_mode'],
                  )
                }
              >
                {Object.entries(uk.campaign.modes).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {uk.campaign.status}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                value={form.status}
                onChange={(e) =>
                  update('status', e.target.value as CampaignInput['status'])
                }
              >
                {Object.entries(uk.campaign.statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>{uk.campaign.channels}</legend>
            <div className="flex flex-wrap gap-4">
              {Object.entries(form.channels).map(([key, v]) => (
                <label className="flex min-h-9 items-center gap-2" key={key}>
                  <input
                    type="checkbox"
                    checked={v}
                    onChange={(e) =>
                      update('channels', {
                        ...form.channels,
                        [key]: e.target.checked,
                      })
                    }
                  />
                  {
                    uk.campaign.channelNames[
                      key as keyof typeof uk.campaign.channelNames
                    ]
                  }
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend>{uk.campaign.scoring_weights}</legend>
            {Object.entries(form.scoring_weights).map(([key, v]) => (
              <label className="flex min-h-9 items-center gap-4" key={key}>
                {uk.campaign.weights[key as keyof typeof uk.campaign.weights] ??
                  key}
                <input
                  aria-label={
                    uk.campaign.weights[
                      key as keyof typeof uk.campaign.weights
                    ] ?? key
                  }
                  type="range"
                  min="0"
                  max="100"
                  value={v}
                  onChange={(e) =>
                    update('scoring_weights', {
                      ...form.scoring_weights,
                      [key]: Number(e.target.value),
                    })
                  }
                />
                {v}
              </label>
            ))}
          </fieldset>
          <AiAssist
            text={JSON.stringify(form.scoring_weights)}
            onApply={(text) => {
              try {
                const scoring_weights = JSON.parse(text);
                const parsed = campaignSchema.safeParse({
                  ...form,
                  scoring_weights,
                });
                if (
                  !parsed.success ||
                  Object.keys(scoring_weights).some(
                    (key) => !(key in defaultWeights),
                  ) ||
                  Object.keys(defaultWeights).some(
                    (key) => !(key in scoring_weights),
                  )
                )
                  throw Error();
                update('scoring_weights', parsed.data.scoring_weights);
                setSource('ai');
              } catch {
                setMessage(uk.ai.invalid);
              }
            }}
          />
          <label className="block">
            {uk.google.profile}
            <select
              className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
              value={form.field_profile}
              onChange={(e) =>
                update('field_profile', e.target.value as 'contacts' | 'basic')
              }
            >
              <option value="contacts">{uk.google.contacts}</option>
              <option value="basic">{uk.google.basic}</option>
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            {uk.campaign.saveFirst}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={pending || !campaignSchema.safeParse(form).success}
              onClick={() => void act('save')}
            >
              {uk.ai.save}
            </Button>
            <Button
              disabled={
                pending ||
                exhausted ||
                !form.cities.length ||
                !form.queries.length ||
                !campaignSchema.safeParse(form).success
              }
              onClick={() => void act('start')}
            >
              {exhausted ? uk.google.exhausted : uk.campaign.start}
            </Button>
            <Button
              variant="outline"
              disabled={
                pending || !id || !campaignSchema.safeParse(form).success
              }
              onClick={() => void act('score')}
            >
              {uk.campaign.recalculate}
            </Button>
            <Button
              variant="outline"
              disabled={pending || !id}
              onClick={() => void act('pause')}
            >
              {uk.campaign.pause}
            </Button>
          </div>
          {message && <p role="status">{message}</p>}
          {id && <BatchList key={id} campaignId={id} />}
        </Card>
      </div>
    </>
  );
}
