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
import { CrudButton, CrudDialog } from './crud-dialog';
import { RegistryPhoneSync } from './registry-phone-sync';
import { ProzorroSync } from './prozorro-sync';
import {
  socialFields,
  socialKeys,
  validSocialSettings,
  type SocialSettings,
} from '@/lib/social-settings';
import {
  scannerFields,
  scannerKeys,
  validScannerSettings,
  type ScannerSettings,
} from '@/lib/scanner-settings';
function TextSetting({
  label,
  value,
  onApply,
}: {
  label: string;
  value: string;
  onApply: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-3">
      <h2 className="font-heading text-base font-bold">{label}</h2>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">
        {value || '—'}
      </p>
      <CrudButton
        action="edit"
        aria-label={`${uk.crud.edit}: ${label}`}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        {uk.crud.edit}
      </CrudButton>
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        draft={draft}
      >
        <label className="block space-y-2">
          <span>{label}</span>
          <textarea
            value={draft}
            maxLength={20000}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-44 w-full rounded-lg border border-border bg-raised p-3"
          />
        </label>
        <AiAssist text={draft} onApply={setDraft} />
        <p className="text-sm text-muted-foreground">{uk.crud.saveSettings}</p>
        <Button
          onClick={() => {
            onApply(draft);
            setOpen(false);
          }}
        >
          {uk.ai.apply}
        </Button>
      </CrudDialog>
    </div>
  );
}
export function SettingsPanel() {
  const [profileIndex, setProfileIndex] = useState<number | null>(null);
  const [profilePrice, setProfilePrice] = useState('');
  const [models, setModels] = useState<TextModel[]>([]),
    [profiles, setProfiles] = useState<GoogleProfile[]>([]),
    [googleDays, setGoogleDays] = useState(365),
    [scanner, setScanner] = useState<ScannerSettings>({}),
    [social, setSocial] = useState<SocialSettings>({}),
    [cheap, setCheap] = useState(''),
    [strong, setStrong] = useState(''),
    [budget, setBudget] = useState(50),
    [about, setAbout] = useState(''),
    [analysisPrompt, setAnalysisPrompt] = useState(''),
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
    setAnalysisPrompt(data['analysis.prompt'] ?? '');
    setProfiles(data['google.field_profiles'] ?? []);
    setGoogleDays(data['retention.google_days'] ?? 365);
    setSocial(
      Object.fromEntries(
        socialKeys
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, data[key]]),
      ),
    );
    setScanner(
      Object.fromEntries(
        scannerKeys
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, data[key]]),
      ),
    );
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
          analysisPrompt,
          googleProfiles: profiles,
          googleDays,
          scanner,
          social,
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
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <RegistryPhoneSync />
        <ProzorroSync />
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-base font-bold">
            {uk.social.title}
          </h2>
          <label className="flex min-h-9 items-center gap-3">
            <input
              type="checkbox"
              checked={social['social.enabled'] === true}
              onChange={(event) =>
                setSocial({ ...social, 'social.enabled': event.target.checked })
              }
            />
            {uk.social.enabled}
          </label>
          {Object.entries(socialFields).map(([key, range]) => (
            <label key={key} className="block space-y-2">
              <span>
                {uk.social.settings[key as keyof typeof uk.social.settings]}
              </span>
              <Input
                type="number"
                {...range}
                value={typeof social[key] === 'number' ? social[key] : ''}
                onChange={(event) =>
                  setSocial({ ...social, [key]: event.target.valueAsNumber })
                }
              />
            </label>
          ))}
          <p className="text-sm text-muted-foreground">
            {uk.social.settingsHint}
          </p>
          <AiAssist
            text={JSON.stringify(social, null, 2)}
            onApply={(text) => {
              try {
                const value = JSON.parse(text);
                if (!validSocialSettings(value)) throw Error();
                setSocial(value);
              } catch {
                setMessage(uk.ai.invalid);
              }
            }}
          />
        </Card>
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-base font-bold">{uk.ai.title}</h2>
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
          <TextSetting label={uk.ai.about} value={about} onApply={setAbout} />
        </Card>
        <Card className="space-y-3 p-6">
          <TextSetting
            label={uk.analysis.prompt}
            value={analysisPrompt}
            onApply={setAnalysisPrompt}
          />
        </Card>
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-base font-bold">
            {uk.google.title}
          </h2>
          <p>{uk.google.estimated}</p>
          {profiles.map((p, index) => (
            <div className="space-y-2 border-b border-border pb-3" key={p.id}>
              <p>
                {p.name} · {p.sku} · {p.priceUsd}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {p.fields.join(', ')}
              </p>
              <CrudButton
                action="edit"
                disabled={pending}
                aria-label={`${uk.crud.editProfile}: ${p.name}`}
                onClick={() => {
                  setProfilePrice(String(p.priceUsd));
                  setProfileIndex(index);
                }}
              >
                {uk.crud.editProfile}
              </CrudButton>
            </div>
          ))}
          <CrudDialog
            open={profileIndex !== null}
            onOpenChange={() => setProfileIndex(null)}
            title={uk.crud.editProfile}
            draft={profilePrice}
          >
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setProfiles(
                  profiles.map((profile, index) =>
                    index === profileIndex
                      ? { ...profile, priceUsd: Number(profilePrice) }
                      : profile,
                  ),
                );
                setProfileIndex(null);
              }}
            >
              <label className="block space-y-2">
                <span>{uk.google.price}</span>
                <Input
                  required
                  type="number"
                  min="0"
                  step="0.001"
                  value={profilePrice}
                  onChange={(event) => setProfilePrice(event.target.value)}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                {uk.crud.saveSettings}
              </p>
              <Button>{uk.ai.apply}</Button>
            </form>
          </CrudDialog>
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
        <Card className="space-y-4 p-6">
          <h2 className="font-heading text-base font-bold">
            {uk.scanner.title}
          </h2>
          {Object.entries(scannerFields).map(([key, range]) => (
            <label className="block space-y-2" key={key}>
              <span>
                {uk.scanner.settings[key as keyof typeof uk.scanner.settings]}
              </span>
              <Input
                type="number"
                min={range.min}
                max={range.max}
                step={range.integer ? 1 : 0.001}
                value={typeof scanner[key] === 'number' ? scanner[key] : ''}
                onChange={(e) =>
                  setScanner({ ...scanner, [key]: e.target.valueAsNumber })
                }
              />
            </label>
          ))}
          <label className="block space-y-2">
            <span>{uk.scanner.settings['scanner.user_agent']}</span>
            <Input
              value={String(scanner['scanner.user_agent'] ?? '')}
              maxLength={500}
              onChange={(e) =>
                setScanner({ ...scanner, 'scanner.user_agent': e.target.value })
              }
            />
          </label>
          <label className="flex min-h-9 items-center gap-3">
            <input
              type="checkbox"
              checked={scanner['scanner.ai_fallback'] === true}
              onChange={(e) =>
                setScanner({
                  ...scanner,
                  'scanner.ai_fallback': e.target.checked,
                })
              }
            />
            {uk.scanner.settings['scanner.ai_fallback']}
          </label>
          <TextSetting
            label={uk.scanner.settings['scanner.ai_prompt']}
            value={String(scanner['scanner.ai_prompt'] ?? '')}
            onApply={(value) =>
              setScanner({ ...scanner, 'scanner.ai_prompt': value })
            }
          />
          <p className="text-sm text-muted-foreground">{uk.scanner.assist}</p>
          <AiAssist
            text={JSON.stringify(scanner, null, 2)}
            onApply={(text) => {
              try {
                const value = JSON.parse(text);
                if (!validScannerSettings(value)) throw Error();
                setScanner(value);
              } catch {
                setMessage(uk.ai.invalid);
              }
            }}
          />
        </Card>
        <div className="sticky bottom-0 flex flex-wrap items-center gap-4 border-t border-border bg-background py-4 xl:col-span-2">
          <Button disabled={pending} onClick={() => void save()}>
            {uk.ai.save}
          </Button>
          {message && <p role="status">{message}</p>}
        </div>
      </div>
    </>
  );
}
