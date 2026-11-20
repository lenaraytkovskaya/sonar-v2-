'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TextModel, GoogleProfile, FinanceRates } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { InfoTip, Section } from './ui/layout';
import { AiAssist } from './ai-assist';
import { runAiJob } from '@/lib/ai-job';
import { ModelPicker } from './model-picker';
import { NotificationSettings } from './message-notifier';
import { RegistryPhoneSync } from './registry-phone-sync';
import { ProzorroSync } from './prozorro-sync';
import { LocalTime } from './local-time';
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

const sections = uk.settings.sections;
type SectionId = keyof typeof sections;

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 items-start gap-3 border-b border-border py-5 first:pt-0 last:border-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium">{label}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function TextSetting({
  label,
  value,
  onChange,
  editing,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return editing ? (
    <div className="space-y-2">
      <textarea
        aria-label={label}
        value={value}
        maxLength={20000}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-44 w-full rounded-lg border border-border bg-raised p-3 font-mono text-sm"
      />
      <AiAssist text={value} onApply={onChange} />
    </div>
  ) : (
    <div className="space-y-2">
      <p
        className={cn(
          'rounded-lg border border-border bg-raised p-3 font-mono text-sm whitespace-pre-wrap break-words',
          !expanded && 'line-clamp-4',
        )}
      >
        {value || '—'}
      </p>
      {value && (
        <button
          type="button"
          aria-expanded={expanded}
          className="min-h-11 text-sm text-accent hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? uk.actions.hide : uk.settings.showAll}
        </button>
      )}
    </div>
  );
}

type ExemptCompany = { id: string; name: string };
function HoursExemptCompanies({
  value,
  onChange,
  editing,
}: {
  value: ExemptCompany[];
  onChange: (value: ExemptCompany[]) => void;
  editing: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ExemptCompany[]>([]);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const search = async () => {
    setSearching(true);
    setError('');
    try {
      const response = await fetch(
        `/api/companies?q=${encodeURIComponent(query.trim())}`,
      );
      if (!response.ok) throw Error(uk.ai.error);
      const data = await response.json();
      setResults(data.companies ?? []);
    } catch {
      setError(uk.ai.error);
    } finally {
      setSearching(false);
    }
  };
  return (
    <div className="space-y-3">
      {value.length ? (
        <ul className="space-y-2">
          {value.map((company) => (
            <li
              key={company.id}
              className="flex items-center justify-between gap-2"
            >
              <Link
                href={`/companies/${company.id}`}
                className="text-accent hover:underline"
              >
                {company.name}
              </Link>
              {editing && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    onChange(value.filter((item) => item.id !== company.id))
                  }
                  aria-label={`${uk.settings.hoursExemptRemove}: ${company.name}`}
                >
                  {uk.settings.hoursExemptRemove}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{uk.settings.hoursExemptEmpty}</p>
      )}
      {editing && (
        <>
          <div className="flex gap-2">
            <Input
              aria-label={uk.settings.hoursExemptSearch}
              placeholder={uk.settings.hoursExemptSearch}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void search();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={searching}
              onClick={() => void search()}
            >
              {uk.settings.hoursExemptFind}
            </Button>
          </div>
          <AiAssist text={query} onApply={setQuery} />
          {!!results.length && (
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {results.map((company) => (
                <li key={company.id}>
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={value.some((item) => item.id === company.id)}
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...value, company]
                            : value.filter((item) => item.id !== company.id),
                        )
                      }
                    />
                    {company.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-err">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsPanel({ section }: { section?: string }) {
  const router = useRouter();
  const active: SectionId =
    section && Object.hasOwn(sections, section)
      ? (section as SectionId)
      : 'notifications';
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [models, setModels] = useState<TextModel[]>([]),
    [profiles, setProfiles] = useState<GoogleProfile[]>([]),
    [googleDays, setGoogleDays] = useState(365),
    [scanner, setScanner] = useState<ScannerSettings>({}),
    [social, setSocial] = useState<SocialSettings>({}),
    [cheap, setCheap] = useState(''),
    [strong, setStrong] = useState(''),
    [budget, setBudget] = useState(50),
    [hoursExemptCompanies, setHoursExemptCompanies] = useState<ExemptCompany[]>(
      [],
    ),
    [financeRates, setFinanceRates] = useState<FinanceRates>({
      USD: 1,
      UAH: 0.024,
      EUR: 1.08,
    }),
    [renewalReminderDays, setRenewalReminderDays] = useState(3),
    [about, setAbout] = useState(''),
    [analysisPrompt, setAnalysisPrompt] = useState(''),
    [resendLastEvent, setResendLastEvent] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false);
  const values = {
    cheap,
    strong,
    budget,
    hoursExemptCompanies,
    financeRates,
    renewalReminderDays,
    about,
    analysisPrompt,
    profiles,
    googleDays,
    scanner,
    social,
  };
  const baseline = useRef(values);
  const restore = () => {
    const value = baseline.current;
    setCheap(value.cheap);
    setStrong(value.strong);
    setBudget(value.budget);
    setHoursExemptCompanies(value.hoursExemptCompanies);
    setFinanceRates(value.financeRates);
    setRenewalReminderDays(value.renewalReminderDays);
    setAbout(value.about);
    setAnalysisPrompt(value.analysisPrompt);
    setProfiles(value.profiles);
    setGoogleDays(value.googleDays);
    setScanner(value.scanner);
    setSocial(value.social);
    setEditing(false);
    setMessage('');
  };
  const load = async (modelsOnly = false) => {
    const response = await fetch('/api/settings');
    if (!response.ok) throw Error(uk.ai.error);
    const data = await response.json();
    setModels(data['ai.models'] ?? []);
    if (modelsOnly) return;
    setCheap(data['ai.model.cheap'] ?? '');
    setStrong(data['ai.model.strong'] ?? '');
    setBudget(data['budget.monthly_usd'] ?? 50);
    setHoursExemptCompanies(
      (data['send.hours_exempt_company_ids'] ?? []).map((id: string) => ({
        id,
        name:
          data.hoursExemptCompanies?.find(
            (company: ExemptCompany) => company.id === id,
          )?.name ?? id,
      })),
    );
    setFinanceRates(data['finance.rates'] ?? { USD: 1, UAH: 0.024, EUR: 1.08 });
    setRenewalReminderDays(data['finance.renewal_reminder_days'] ?? 3);
    setAbout(data['company.about'] ?? '');
    setAnalysisPrompt(data['analysis.prompt'] ?? '');
    setResendLastEvent(data['email.resend.last_event'] ?? null);
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
    setLoaded(true);
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
    if (
      (active === 'scanner' && !validScannerSettings(scanner)) ||
      (active === 'social' && !validSocialSettings(social))
    ) {
      setMessage(uk.ai.invalid);
      return;
    }
    setPending(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cheap,
          strong,
          budget,
          hoursExemptCompanyIds: hoursExemptCompanies.map(
            (company) => company.id,
          ),
          financeRates,
          renewalReminderDays,
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
      setEditing(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uk.ai.error);
    } finally {
      setPending(false);
    }
  };
  const editable = !['notifications', 'registry'].includes(active);
  const disabled = pending || !loaded;
  const canNavigate = () =>
    !pending &&
    (!editing ||
      JSON.stringify(values) === JSON.stringify(baseline.current) ||
      window.confirm(uk.crud.discard));
  const numeric = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    range: { min: number; max: number; step?: number | 'any' },
  ) =>
    editing ? (
      <Input
        aria-label={label}
        required
        type="number"
        {...range}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    ) : (
      <span className="tabular-nums">
        {Number.isFinite(value) ? value : '—'}
      </span>
    );
  const socialUnit = (key: string) => {
    if (key.endsWith('daily_limit')) return uk.social.units.day;
    if (key.endsWith('session_fetch_daily_limit')) return uk.social.units.day;
    if (key.endsWith('relogin_cooldown_hours')) return uk.social.units.hours;
    if (key.endsWith('_seconds')) return uk.social.units.seconds;
    if (key.endsWith('_minutes')) return uk.social.units.minutes;
    if (key.endsWith('_ms')) return uk.social.units.milliseconds;
    if (key.endsWith('_usd')) return uk.social.units.dollars;
    return '';
  };
  const socialNumberRow = (key: string) => {
    const range = socialFields[key as keyof typeof socialFields];
    if (!range) return null;
    const label = uk.social.settings[key as keyof typeof uk.social.settings];
    return (
      <SettingRow
        key={key}
        label={label}
        description={
          editing ? uk.settings.range(range.min, range.max) : undefined
        }
      >
        <span className="inline-flex flex-wrap items-center gap-2">
          {numeric(
            label,
            Number(social[key]),
            (value) => setSocial({ ...social, [key]: value }),
            range,
          )}
          <span className="text-xs text-muted-foreground">
            {socialUnit(key)}
          </span>
        </span>
      </SettingRow>
    );
  };
  const socialToggleRow = (key: string, label: string) => (
    <SettingRow key={key} label={label}>
      <input
        aria-label={label}
        type="checkbox"
        disabled={!editing}
        checked={social[key] === true}
        onChange={(event) =>
          setSocial({ ...social, [key]: event.target.checked })
        }
      />
    </SettingRow>
  );
  const socialNumericKeys = Object.keys(socialFields);
  const socialGeneralKeys = socialNumericKeys.filter(
    (key) => !/^social\.(facebook|instagram|linkedin|inbox)\./.test(key),
  );
  return (
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
      <label className="space-y-2 lg:hidden">
        <span className="text-sm font-medium">{uk.settings.section}</span>
        <select
          value={active}
          disabled={pending}
          onChange={(event) => {
            if (canNavigate())
              router.push(`/settings?section=${event.target.value}`, {
                scroll: false,
              });
            else event.target.value = active;
          }}
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
        >
          {Object.entries(sections).map(([id, item]) => (
            <option key={id} value={id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <nav
        aria-label={uk.settings.section}
        className="hidden space-y-1 lg:block"
      >
        {Object.entries(sections).map(([id, item]) => (
          <Link
            key={id}
            href={`/settings?section=${id}`}
            scroll={false}
            onClick={(event) => {
              if (!canNavigate()) event.preventDefault();
            }}
            aria-current={active === id ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-raised',
              active === id && 'bg-chip text-accent',
            )}
          >
            {item.title}
          </Link>
        ))}
      </nav>
      <Section
        title={sections[active].title}
        description={sections[active].description}
        className="min-w-0"
        actions={
          editable && !editing ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                baseline.current = structuredClone(values);
                setMessage('');
                setEditing(true);
              }}
            >
              {uk.crud.edit}
            </Button>
          ) : undefined
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={pending} className="min-w-0">
            {active === 'notifications' && (
              <>
                <NotificationSettings embedded />
                <div className="mt-5 border-t border-border pt-5 text-sm text-muted-foreground">
                  {resendLastEvent ? (
                    <>
                      {uk.email.resendLastEvent}{' '}
                      <LocalTime value={resendLastEvent} />
                    </>
                  ) : (
                    uk.email.resendNever
                  )}
                </div>
              </>
            )}
            {active === 'ai' && (
              <>
                <SettingRow
                  label={uk.ai.cheap}
                  description={uk.settings.modelHint}
                >
                  {editing ? (
                    <ModelPicker
                      label={uk.ai.cheap}
                      models={models}
                      value={cheap}
                      onChange={setCheap}
                      defaultOnlyCheap
                    />
                  ) : (
                    (models.find((model) => model.id === cheap)?.name ??
                    (cheap || uk.ai.choose))
                  )}
                </SettingRow>
                <SettingRow label={uk.ai.strong} description={uk.ai.price}>
                  {editing ? (
                    <ModelPicker
                      label={uk.ai.strong}
                      models={models}
                      value={strong}
                      onChange={setStrong}
                      defaultOnlyCheap={false}
                    />
                  ) : (
                    (models.find((model) => model.id === strong)?.name ??
                    (strong ? (
                      strong
                    ) : (
                      <span className="flex flex-wrap items-center gap-3">
                        <span className="text-muted-foreground">
                          {uk.ai.notSelected}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            baseline.current = structuredClone(values);
                            setMessage('');
                            setEditing(true);
                          }}
                        >
                          {uk.ai.choose}
                        </Button>
                      </span>
                    )))
                  )}
                </SettingRow>
                <SettingRow
                  label={uk.ai.about}
                  description={uk.settings.aboutHint}
                >
                  <TextSetting
                    label={uk.ai.about}
                    value={about}
                    onChange={setAbout}
                    editing={editing}
                  />
                </SettingRow>
                <div className="mt-5">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => void refresh()}
                  >
                    {pending ? uk.ai.pending : uk.ai.refresh}
                  </Button>
                </div>
              </>
            )}
            {active === 'analysis' && (
              <SettingRow
                label={uk.analysis.prompt}
                description={sections.analysis.description}
              >
                <TextSetting
                  label={uk.analysis.prompt}
                  value={analysisPrompt}
                  onChange={setAnalysisPrompt}
                  editing={editing}
                />
              </SettingRow>
            )}
            {active === 'google' && (
              <>
                {profiles.map((profile, index) => (
                  <SettingRow
                    key={profile.id}
                    label={profile.name}
                    description={`${profile.sku} · ${profile.fields.join(', ')}`}
                  >
                    {numeric(
                      uk.google.price,
                      profile.priceUsd,
                      (priceUsd) =>
                        setProfiles(
                          profiles.map((item, i) =>
                            i === index ? { ...item, priceUsd } : item,
                          ),
                        ),
                      { min: 0, max: 1e9, step: 0.001 },
                    )}
                  </SettingRow>
                ))}
                <SettingRow
                  label={uk.google.retention}
                  description={uk.google.estimated}
                >
                  {numeric(uk.google.retention, googleDays, setGoogleDays, {
                    min: 1,
                    max: 3650,
                    step: 1,
                  })}
                </SettingRow>
              </>
            )}
            {active === 'scanner' && (
              <>
                {Object.entries(scannerFields).map(([key, range]) => {
                  const label =
                    uk.scanner.settings[
                      key as keyof typeof uk.scanner.settings
                    ];
                  return (
                    <SettingRow
                      key={key}
                      label={label}
                      description={uk.settings.range(range.min, range.max)}
                    >
                      {numeric(
                        label,
                        Number(scanner[key]),
                        (value) => setScanner({ ...scanner, [key]: value }),
                        {
                          min: range.min,
                          max: range.max,
                          step: range.integer ? 1 : 0.001,
                        },
                      )}
                    </SettingRow>
                  );
                })}
                <SettingRow
                  label={uk.scanner.settings['scanner.user_agent']}
                  description={uk.settings.userAgentHint}
                >
                  {editing ? (
                    <Input
                      aria-label={uk.scanner.settings['scanner.user_agent']}
                      required
                      value={String(scanner['scanner.user_agent'] ?? '')}
                      maxLength={500}
                      onChange={(event) =>
                        setScanner({
                          ...scanner,
                          'scanner.user_agent': event.target.value,
                        })
                      }
                    />
                  ) : (
                    String(scanner['scanner.user_agent'] ?? '—')
                  )}
                </SettingRow>
                <SettingRow
                  label={uk.scanner.settings['scanner.ai_fallback']}
                  description={uk.scanner.assist}
                >
                  <input
                    aria-label={uk.scanner.settings['scanner.ai_fallback']}
                    type="checkbox"
                    disabled={!editing}
                    checked={scanner['scanner.ai_fallback'] === true}
                    onChange={(event) =>
                      setScanner({
                        ...scanner,
                        'scanner.ai_fallback': event.target.checked,
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  label={uk.scanner.settings['scanner.ai_prompt']}
                  description={uk.scanner.assist}
                >
                  <TextSetting
                    label={uk.scanner.settings['scanner.ai_prompt']}
                    value={String(scanner['scanner.ai_prompt'] ?? '')}
                    onChange={(value) =>
                      setScanner({ ...scanner, 'scanner.ai_prompt': value })
                    }
                    editing={editing}
                  />
                </SettingRow>
                {editing && (
                  <div className="mt-5">
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
                  </div>
                )}
              </>
            )}
            {active === 'social' && (
              <>
                <div className="space-y-2">
                  <h3 className="border-b border-border pb-2 text-sm font-semibold">
                    {uk.social.groups.general}
                  </h3>
                  <SettingRow
                    label={uk.social.enabled}
                    description={
                      <span className="inline-flex items-center gap-1">
                        {uk.social.settingsHint}
                        <InfoTip>{uk.social.settingsHint}</InfoTip>
                      </span>
                    }
                  >
                    <input
                      aria-label={uk.social.enabled}
                      type="checkbox"
                      disabled={!editing}
                      checked={social['social.enabled'] === true}
                      onChange={(event) =>
                        setSocial({
                          ...social,
                          'social.enabled': event.target.checked,
                        })
                      }
                    />
                  </SettingRow>
                  {socialGeneralKeys.map(socialNumberRow)}
                  {socialToggleRow(
                    'social.auto_password_login',
                    uk.social.settings['social.auto_password_login'],
                  )}
                </div>
                {(['facebook', 'instagram', 'linkedin'] as const).map(
                  (network) => (
                    <div key={network} className="mt-6 space-y-2">
                      <h3 className="border-b border-border pb-2 text-sm font-semibold">
                        {uk.social.groups[network]}
                      </h3>
                      {socialNumericKeys
                        .filter((key) => key.startsWith(`social.${network}.`))
                        .map(socialNumberRow)}
                    </div>
                  ),
                )}
                <details className="mt-6 rounded-lg border border-border px-4">
                  <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
                    {uk.social.groups.inbox}
                  </summary>
                  <div className="border-t border-border py-2">
                    {socialToggleRow(
                      'social.inbox.enabled',
                      uk.social.inboxSettings.enabled,
                    )}
                    {socialToggleRow(
                      'social.inbox.facebook.enabled',
                      uk.social.inboxSettings.facebook,
                    )}
                    {socialToggleRow(
                      'social.inbox.instagram.enabled',
                      uk.social.inboxSettings.instagram,
                    )}
                    {socialNumericKeys
                      .filter((key) => key.startsWith('social.inbox.'))
                      .map(socialNumberRow)}
                  </div>
                </details>
                {editing && (
                  <div className="mt-5">
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
                  </div>
                )}
              </>
            )}
            {active === 'registry' && (
              <div className="space-y-6">
                <RegistryPhoneSync embedded />
                <ProzorroSync embedded />
              </div>
            )}
            {active === 'budget' && (
              <>
                <SettingRow
                  label={uk.settings.hoursExemptCompanies}
                  description={uk.settings.hoursExemptHint}
                >
                  <HoursExemptCompanies
                    value={hoursExemptCompanies}
                    onChange={setHoursExemptCompanies}
                    editing={editing}
                  />
                </SettingRow>
                <SettingRow
                  label={uk.ai.budget}
                  description={sections.budget.description}
                >
                  {numeric(uk.ai.budget, budget, setBudget, {
                    min: 0,
                    max: 1e9,
                    step: 0.01,
                  })}
                </SettingRow>
                <SettingRow
                  label={uk.finance.rateUah}
                  description={uk.finance.rateHint}
                >
                  {numeric(
                    uk.finance.rateUah,
                    financeRates.UAH,
                    (UAH) => setFinanceRates({ ...financeRates, UAH }),
                    { min: 0.0000001, max: 1e6, step: 'any' },
                  )}
                </SettingRow>
                <SettingRow
                  label={uk.finance.rateEur}
                  description={uk.finance.rateHint}
                >
                  {numeric(
                    uk.finance.rateEur,
                    financeRates.EUR,
                    (EUR) => setFinanceRates({ ...financeRates, EUR }),
                    { min: 0.0000001, max: 1e6, step: 'any' },
                  )}
                </SettingRow>
                <SettingRow
                  label={uk.finance.reminderDays}
                  description={uk.finance.reminderDaysHint}
                >
                  {numeric(
                    uk.finance.reminderDays,
                    renewalReminderDays,
                    setRenewalReminderDays,
                    { min: 0, max: 90, step: 1 },
                  )}
                </SettingRow>
              </>
            )}
          </fieldset>
          {editing && (
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-5">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={restore}
              >
                {uk.ai.cancel}
              </Button>
              <Button type="submit" disabled={disabled}>
                {uk.ai.save}
              </Button>
            </div>
          )}
          {message && (
            <p role="status" className="mt-4 text-sm">
              {message}
            </p>
          )}
        </form>
      </Section>
    </div>
  );
}
