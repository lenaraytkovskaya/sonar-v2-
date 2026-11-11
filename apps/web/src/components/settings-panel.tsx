'use client';
import { useEffect, useState } from 'react';
import type { TextModel, GoogleProfile } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from './shared';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { AiAssist } from './ai-assist';
import { runAiJob } from '@/lib/ai-job';
import { ModelPicker } from './model-picker';
export function SettingsPanel() {
  const [models, setModels] = useState<TextModel[]>([]),
    [profiles, setProfiles] = useState<GoogleProfile[]>([]),
    [googleDays, setGoogleDays] = useState(365),
    [cheap, setCheap] = useState(''),
    [strong, setStrong] = useState(''),
    [budget, setBudget] = useState(50),
    [about, setAbout] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false);
  const load = async (modelsOnly = false) => {
    const response = await fetch('/api/settings');
    if (!response.ok) throw Error(uk.ai.error);
    const data = await response.json();
    setModels(data['ai.models'] ?? []);
    if (modelsOnly) return;
    setCheap(data['ai.model.cheap'] ?? '');
    setStrong(data['ai.model.strong'] ?? '');
    setBudget(data['budget.monthly_usd'] ?? 50);
    setAbout(data['company.about'] ?? '');
    setProfiles(data['google.field_profiles'] ?? []);
    setGoogleDays(data['retention.google_days'] ?? 365);
  };
  useEffect(() => {
    void load().catch(() => setMessage(uk.ai.error));
  }, []);
  const refresh = async () => {
    setPending(true);
    setMessage('');
    try {
      await runAiJob('/api/ai/models', {});
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uk.ai.error);
    } finally {
      setPending(false);
    }
  };
  const save = async () => {
    setPending(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cheap,
          strong,
          budget,
          about,
          googleProfiles: profiles,
          googleDays,
        }),
      });
      if (!response.ok) throw Error(uk.ai.invalid);
      setMessage(uk.ai.saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uk.ai.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <PageHeader {...uk.pages.settings} />
      <div className="space-y-6">
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-xl font-bold">{uk.ai.title}</h2>
          <p className="text-sm text-muted-foreground">{uk.ai.price}</p>
          <ModelPicker
            label={uk.ai.cheap}
            models={models}
            value={cheap}
            onChange={setCheap}
            defaultOnlyCheap
          />
          <ModelPicker
            label={uk.ai.strong}
            models={models}
            value={strong}
            onChange={setStrong}
            defaultOnlyCheap={false}
          />
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void refresh()}
          >
            {pending ? uk.ai.pending : uk.ai.refresh}
          </Button>
        </Card>
        <Card className="space-y-3 p-6">
          <label className="block space-y-2">
            <span>{uk.ai.budget}</span>
            <Input
              type="number"
              min={0}
              max={1e9}
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.valueAsNumber)}
            />
          </label>
        </Card>
        <Card className="p-6">
          <label className="block space-y-2">
            <span>{uk.ai.about}</span>
            <textarea
              id="company-about"
              value={about}
              maxLength={20000}
              onChange={(e) => setAbout(e.target.value)}
              className="min-h-44 w-full rounded-lg border border-border bg-raised p-3"
            />
          </label>
          <AiAssist text={about} onApply={setAbout} />
        </Card>
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-xl font-bold">{uk.google.title}</h2>
          <p>{uk.google.estimated}</p>
          {profiles.map((p, index) => (
            <label className="block" key={p.id}>
              {p.name} · {p.sku}
              <Input
                aria-label={`${p.name}: ${uk.google.price}`}
                type="number"
                min="0"
                step="0.001"
                value={p.priceUsd}
                onChange={(e) =>
                  setProfiles(
                    profiles.map((v, i) =>
                      i === index
                        ? { ...v, priceUsd: e.target.valueAsNumber }
                        : v,
                    ),
                  )
                }
              />
              <span className="break-all text-xs text-muted-foreground">
                {p.fields.join(', ')}
              </span>
            </label>
          ))}
          <label className="block">
            {uk.google.retention}
            <Input
              type="number"
              min="1"
              max="3650"
              value={googleDays}
              onChange={(e) => setGoogleDays(e.target.valueAsNumber)}
            />
          </label>
        </Card>
        {message && <p role="status">{message}</p>}
        <Button disabled={pending} onClick={() => void save()}>
          {uk.ai.save}
        </Button>
      </div>
    </>
  );
}
