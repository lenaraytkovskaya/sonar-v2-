'use client';
import { useState, type ReactNode } from 'react';
import { parseCampaignChips } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { Button } from './ui/button';
import { Input } from './ui/input';
export function CampaignControl({
  label,
  hint,
  text,
  onApply,
  disabled,
  children,
}: {
  label: string;
  hint: string;
  text: string;
  onApply: (text: string) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="block space-y-1.5 text-sm font-medium">
        <span>{label}</span>
        {children}
      </label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <AiAssist text={text} onApply={onApply} disabled={disabled} />
    </div>
  );
}
export function CampaignChips({
  kind,
  values,
  change,
  disabled,
  onError,
}: {
  kind: 'cities' | 'queries' | 'language_codes';
  values: string[];
  change: (values: string[], ai?: boolean) => void;
  disabled: boolean;
  onError: (label: string) => void;
}) {
  const [input, setInput] = useState('');
  const apply = (text: string, ai = false) => {
    try {
      change(parseCampaignChips(text, kind), ai);
      setInput('');
    } catch {
      onError(uk.campaign[kind]);
    }
  };
  const add = () => {
    if (input.trim()) apply([...values, input].join('\n'));
  };
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{uk.campaign[kind]}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <button
            type="button"
            key={value}
            disabled={disabled}
            aria-label={`${uk.campaign.remove}: ${value}`}
            className="min-h-9 max-w-full rounded-full bg-chip px-3 break-words"
            onClick={() => change(values.filter((item) => item !== value))}
          >
            {value} ×
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={uk.campaign[kind]}
          value={input}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={add}
        >
          {uk.campaign.add}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{uk.campaign.hints[kind]}</p>
      <AiAssist
        text={values.join('\n') || input}
        onApply={(text) => apply(text, true)}
        disabled={disabled}
      />
    </fieldset>
  );
}
