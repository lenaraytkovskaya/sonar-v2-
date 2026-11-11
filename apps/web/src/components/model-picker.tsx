'use client';
import { useId, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { TextModel } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { filterModels } from '@/lib/model-picker';
import { Button } from './ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

function ModelDetails({ model }: { model: TextModel }) {
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="block break-words">{model.name}</span>
      <span className="block break-all text-xs text-muted-foreground">
        {model.id}
      </span>
      <span className="block text-xs text-muted-foreground">
        ${(model.promptUsd * 1e6).toFixed(4)} / $
        {(model.completionUsd * 1e6).toFixed(4)} {uk.ai.perMillion}
      </span>
    </span>
  );
}
export function ModelPicker({
  label,
  models,
  value,
  onChange,
  defaultOnlyCheap,
}: {
  label: string;
  models: TextModel[];
  value: string;
  onChange: (value: string) => void;
  defaultOnlyCheap: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyCheap, setOnlyCheap] = useState(defaultOnlyCheap);
  const selected = models.find((model) => model.id === value);
  const visible = filterModels(models, query, onlyCheap, value);
  return (
    <div className="space-y-2">
      <span id={`${id}-label`}>{label}</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-labelledby={`${id}-label ${id}-value`}
            aria-expanded={open}
            className="h-auto w-full justify-between bg-raised"
          >
            <span id={`${id}-value`} className="min-w-0 flex-1 text-left">
              {selected ? (
                <ModelDetails model={selected} />
              ) : (
                <span className="break-all">{value || uk.ai.choose}</span>
              )}
            </span>
            <ChevronsUpDown aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-labelledby={`${id}-label`}>
          <Command shouldFilter={false} label={`${label}: ${uk.ai.search}`}>
            <CommandInput
              aria-label={`${label}: ${uk.ai.search}`}
              placeholder={uk.ai.search}
              value={query}
              onValueChange={setQuery}
            />
            <label
              className="flex min-h-11 cursor-pointer items-center gap-2 border-b border-border px-3 text-sm"
              title={uk.ai.cheapLimit}
            >
              <input
                type="checkbox"
                checked={onlyCheap}
                onChange={(event) => setOnlyCheap(event.target.checked)}
              />
              {uk.ai.onlyCheap}
            </label>
            <CommandList aria-labelledby={`${id}-label`}>
              <CommandEmpty>{uk.ai.noModels}</CommandEmpty>
              {visible.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  onSelect={() => {
                    onChange(model.id);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <ModelDetails model={model} />
                  {model.id === value && (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
