'use client';
import { useEffect, useState } from 'react';
import {
  campaignSchema,
  campaignSuggestionSchema,
  type CampaignInput,
  type CampaignSuggestion,
} from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, PageHeader } from './shared';
import { AiAssist } from './ai-assist';
import { runAiJob } from '@/lib/ai-job';
type Row = CampaignInput & { id: string };
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
  scoring_weights: { website: 30, phone: 30, rating: 40 },
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
            className="min-h-11 rounded-full bg-chip px-3"
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
export function CampaignPanel() {
  const [rows, setRows] = useState<Row[]>([]),
    [presets, setPresets] = useState<
      { id: string; name: string; data: CampaignInput }[]
    >([]),
    [id, setId] = useState<string | null>(null),
    [form, setForm] = useState(initial),
    [description, setDescription] = useState(''),
    [preview, setPreview] = useState<CampaignSuggestion | null>(null),
    [source, setSource] = useState('form'),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const update = <K extends keyof CampaignInput>(
    key: K,
    value: CampaignInput[K],
  ) => {
    setPreview(null);
    setForm({ ...form, [key]: value });
  };
  const load = async () => {
    const r = await fetch('/api/campaigns');
    if (!r.ok) throw Error(uk.ai.error);
    const d = await r.json();
    setRows(d.campaigns);
    setPresets(d.presets);
  };
  useEffect(() => {
    void load().catch(() => setMessage(uk.ai.error));
  }, []);
  const act = async (kind: 'save' | 'start' | 'pause') => {
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
        if (!start.ok) throw Error(uk.ai.error);
      }
      await load();
      setMessage(kind === 'start' ? uk.campaign.queued : uk.ai.saved);
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
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="space-y-3 p-4">
          <Button
            onClick={() => {
              setId(null);
              setForm(initial);
              setPreview(null);
            }}
          >
            {uk.campaign.create}
          </Button>
          {rows.length === 0 && <p>{uk.campaign.empty}</p>}
          {rows.map((row) => (
            <button
              className={`min-h-11 w-full rounded-lg p-3 text-left ${id === row.id ? 'bg-chip' : 'hover:bg-raised'}`}
              key={row.id}
              onClick={() => {
                setId(row.id);
                setForm({ ...row, budget_usd: Number(row.budget_usd) });
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
        <Card className="space-y-5 p-5">
          <label className="block">
            {uk.campaign.presets}
            <select
              className="mt-2 min-h-11 w-full rounded-lg border border-border bg-surface px-3"
              value=""
              onChange={(e) => {
                const preset = presets.find((p) => p.id === e.target.value);
                if (preset) {
                  setId(null);
                  setForm(preset.data);
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
              <p>{uk.ai.preview}</p>
              <pre className="overflow-auto whitespace-pre-wrap text-sm">
                {JSON.stringify(preview, null, 2)}
              </pre>
              <Button
                onClick={() => {
                  setForm({ ...form, ...preview });
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
          <div className="grid gap-4 sm:grid-cols-3">
            <label>
              {uk.campaign.batch_size}
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
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
                className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
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
                className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
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
                <label className="flex min-h-11 items-center gap-2" key={key}>
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
              <label className="flex min-h-11 items-center gap-4" key={key}>
                {uk.campaign.weights[key as keyof typeof uk.campaign.weights] ??
                  key}
                <input
                  aria-label={key}
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
          <label className="block">
            {uk.google.profile}
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-surface p-2"
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
                !form.cities.length ||
                !form.queries.length ||
                !campaignSchema.safeParse(form).success
              }
              onClick={() => void act('start')}
            >
              {uk.campaign.start}
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
        </Card>
      </div>
    </>
  );
}
