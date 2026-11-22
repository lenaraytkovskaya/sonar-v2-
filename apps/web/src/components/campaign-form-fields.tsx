'use client';
import Link from 'next/link';
import {
  getCountries,
  campaignSchema,
  campaignDefaultsSchema,
  campaignGoogleEstimate,
  campaignNumericSuggestion,
  campaignWeightsSuggestion,
  campaignChannelsSuggestion,
  campaignProductSuggestion,
  type CampaignInput,
  type ProductDto,
  type GoogleProgress,
} from '@sonar/core';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { Input } from './ui/input';
import { Section } from './ui/layout';
import {
  CampaignControl as Control,
  CampaignChips as Chips,
} from './campaign-form-controls';

type Change = (patch: Partial<CampaignInput>, ai?: boolean) => void;
const countryNames = new Intl.DisplayNames(['uk'], { type: 'region' });
const countries = getCountries()
  .map((code) => ({ code, name: countryNames.of(code) ?? code }))
  .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
export function CampaignFormFields({
  form,
  products,
  progress,
  priceUsd,
  pending,
  onChange,
  onError,
}: {
  form: CampaignInput;
  products: ProductDto[];
  progress: GoogleProgress;
  priceUsd: number;
  pending: boolean;
  onChange: Change;
  onError: (message: string) => void;
}) {
  const languages = form.language_codes ?? [form.language_code];
  const estimate = campaignGoogleEstimate(form, progress, priceUsd);
  const invalid = (label: string) => onError(uk.campaign.invalidField(label));
  const apply =
    (label: string, parse: (text: string) => Partial<CampaignInput>) =>
    (text: string) => {
      try {
        onChange(parse(text.trim()), true);
      } catch {
        invalid(label);
      }
    };
  const number = (key: 'batch_size' | 'budget_usd' | 'min_score') => (
    <Control
      label={uk.campaign[key]}
      hint={uk.campaign.hints[key]}
      text={String(form[key])}
      disabled={pending}
      onApply={apply(uk.campaign[key], (text) => ({
        [key]: campaignNumericSuggestion(text, key),
      }))}
    >
      {key === 'batch_size' ? (
        <select
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
          value={form[key]}
          onChange={(event) =>
            onChange({
              batch_size: campaignNumericSuggestion(
                event.target.value,
                key,
              ) as CampaignInput['batch_size'],
            })
          }
        >
          {[20, 50, 100, 200].map((size) => (
            <option key={size}>{size}</option>
          ))}
        </select>
      ) : (
        <Input
          type="number"
          onInvalid={() => invalid(uk.campaign[key])}
          min={0}
          max={key === 'min_score' ? 100 : 100000}
          step="any"
          value={Number.isFinite(form[key]) ? form[key] : ''}
          onChange={(event) =>
            onChange({
              [key]:
                event.target.value === '' ? NaN : Number(event.target.value),
            })
          }
        />
      )}
    </Control>
  );
  return (
    <div className="space-y-6">
      <Section title={uk.campaign.main}>
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Control
              label={uk.campaign.name}
              hint={uk.campaign.hints.name}
              text={form.name}
              disabled={pending}
              onApply={apply(uk.campaign.name, (text) => ({
                name: campaignSchema.shape.name.parse(text),
              }))}
            >
              <Input
                value={form.name}
                maxLength={200}
                onChange={(event) => onChange({ name: event.target.value })}
              />
            </Control>
            <Control
              label={uk.campaign.country_code}
              hint={uk.campaign.hints.country_code}
              text={countryNames.of(form.country_code) ?? form.country_code}
              disabled={pending}
              onApply={apply(uk.campaign.country_code, (text) => ({
                country_code: campaignSchema.shape.country_code.parse(
                  countries.find(
                    (country) =>
                      country.name.toLocaleLowerCase('uk') ===
                      text.toLocaleLowerCase('uk'),
                  )?.code ?? text,
                ),
              }))}
            >
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                value={form.country_code}
                onChange={(event) =>
                  onChange({ country_code: event.target.value })
                }
              >
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </select>
            </Control>
          </div>
          <Chips
            kind="language_codes"
            values={languages}
            disabled={pending}
            onError={invalid}
            change={(values, ai) => {
              onChange(
                { language_codes: values, language_code: values[0] ?? '' },
                ai,
              );
              if (!values.length) invalid(uk.campaign.language_codes);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {uk.campaign.languageCost(languages.length)}
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            {(['cities', 'queries'] as const).map((kind) => (
              <Chips
                key={kind}
                kind={kind}
                values={form[kind]}
                disabled={pending}
                onError={invalid}
                change={(values, ai) => onChange({ [kind]: values }, ai)}
              />
            ))}
          </div>
          <div className="space-y-2 text-sm">
            <p>
              {uk.campaign.googleEstimate(
                estimate.requests,
                (Math.ceil(estimate.usd * 10000) / 10000).toLocaleString(
                  'uk-UA',
                  { minimumFractionDigits: 3, maximumFractionDigits: 4 },
                ),
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {uk.campaign.estimateHint}
            </p>
          </div>
          <div className="space-y-2">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{uk.campaign.product}</span>
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                value={form.product_id ?? ''}
                onChange={(event) =>
                  onChange({ product_id: event.target.value || null })
                }
              >
                <option value="">{uk.campaign.productRequired}</option>
                {products
                  .filter(
                    (product) =>
                      product.status === 'active' ||
                      product.id === form.product_id,
                  )
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                      {product.status === 'archived'
                        ? ` (${uk.campaign.archivedProduct})`
                        : ''}
                    </option>
                  ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {uk.campaign.productHint}
            </p>
            <AiAssist
              disabled={pending}
              text={
                products.find((product) => product.id === form.product_id)
                  ?.name ??
                products
                  .filter((product) => product.status === 'active')
                  .map((product) => product.name)
                  .join('\n')
              }
              onApply={apply(uk.campaign.product, (text) => ({
                product_id: campaignProductSuggestion(
                  text,
                  products,
                  form.product_id,
                ),
              }))}
            />
            <Link
              href="/products"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent underline"
              aria-label={uk.campaign.manageProducts}
            >
              {uk.campaign.createProduct}
            </Link>
          </div>
        </div>
      </Section>
      <details className="rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-5 py-4 font-heading text-base font-semibold">
          {uk.campaign.additional}
        </summary>
        <div className="space-y-5 border-t border-border px-5 py-4">
          <div className="grid gap-5 sm:grid-cols-2">
            {number('batch_size')}
            {number('budget_usd')}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {uk.campaign.channels}
            </legend>
            <div className="flex flex-wrap gap-4">
              {Object.entries(form.channels).map(([key, checked]) => (
                <label
                  key={key}
                  className="flex min-h-11 items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      onChange({
                        channels: {
                          ...form.channels,
                          [key]: event.target.checked,
                        },
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
            <p className="text-xs text-muted-foreground">
              {uk.campaign.hints.channels}
            </p>
            <AiAssist
              text={JSON.stringify(form.channels)}
              disabled={pending}
              onApply={apply(uk.campaign.channels, (text) => ({
                channels: campaignChannelsSuggestion(text),
              }))}
            />
          </fieldset>
          <div className="grid gap-5 sm:grid-cols-2">
            <Control
              label={uk.campaign.send_mode}
              hint={uk.campaign.hints.send_mode}
              text={uk.campaign.modes[form.send_mode]}
              disabled={pending}
              onApply={apply(uk.campaign.send_mode, (text) => ({
                send_mode: campaignDefaultsSchema.shape.send_mode.parse(
                  Object.entries(uk.campaign.modes).find(
                    ([, label]) => label === text,
                  )?.[0] ?? text,
                ),
              }))}
            >
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                value={form.send_mode}
                onChange={(event) =>
                  onChange({
                    send_mode: campaignDefaultsSchema.shape.send_mode.parse(
                      event.target.value,
                    ),
                  })
                }
              >
                {Object.entries(uk.campaign.modes).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Control>
            {number('min_score')}
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              {uk.campaign.scoring_weights}
            </legend>
            <p className="text-xs text-muted-foreground">
              {uk.campaign.hints.scoring_weights}
            </p>
            {Object.entries(form.scoring_weights).map(([key, value]) => (
              <Control
                key={key}
                label={
                  uk.campaign.weights[
                    key as keyof typeof uk.campaign.weights
                  ] ?? key
                }
                hint={uk.campaign.weightHint}
                text={String(value)}
                disabled={pending}
                onApply={apply(uk.campaign.scoring_weights, (text) => ({
                  scoring_weights: {
                    ...form.scoring_weights,
                    [key]: campaignNumericSuggestion(text, 'weight'),
                  },
                }))}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    className="min-w-0 flex-1"
                    value={value}
                    onChange={(event) =>
                      onChange({
                        scoring_weights: {
                          ...form.scoring_weights,
                          [key]: Number(event.target.value),
                        },
                      })
                    }
                  />
                  <span className="tabular-nums">{value}</span>
                </div>
              </Control>
            ))}
            <AiAssist
              text={JSON.stringify(form.scoring_weights)}
              disabled={pending}
              onApply={apply(uk.campaign.scoring_weights, (text) => ({
                scoring_weights: campaignWeightsSuggestion(
                  text,
                  Object.keys(form.scoring_weights),
                ),
              }))}
            />
          </fieldset>
        </div>
      </details>
    </div>
  );
}
