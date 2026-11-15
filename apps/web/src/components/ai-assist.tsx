'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Heart,
  Languages,
  Loader2,
  Minimize2,
  PenLine,
  RefreshCw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { runAiJob } from '@/lib/ai-job';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

type Action = keyof typeof uk.ai.actions;
const icons: Record<Action, typeof Wand2> = {
  improve: Wand2,
  shorter: Minimize2,
  warmer: Heart,
  translate: Languages,
  custom: PenLine,
};
const needsInstruction = (action: Action) =>
  action === 'translate' || action === 'custom';

/**
 * Compact AI helper, as in most editors: a small «✨ ІІ» button opens a menu of actions;
 * an action runs at once and the result appears as a suggestion to replace the text with.
 */
export function AiAssist({
  text,
  onApply,
}: {
  text: string;
  onApply: (text: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const instructionInput = useRef<HTMLInputElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [menu, setMenu] = useState(false),
    [action, setAction] = useState<Action | null>(null),
    [instruction, setInstruction] = useState(''),
    [preview, setPreview] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const empty = !text.trim();
  const run = async (chosen: Action, extra = instruction) => {
    if (busy.current) return;
    busy.current = true;
    setAction(chosen);
    setMenu(false);
    setPending(true);
    setError('');
    setPreview('');
    try {
      const result = await runAiJob('/api/ai/assist', {
        action: chosen,
        text,
        instruction: extra,
      });
      setPreview(result.text);
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.ai.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const close = () => {
    setPreview('');
    setError('');
    setAction(null);
    setInstruction('');
    trigger.current?.focus();
  };
  const asking = action && needsInstruction(action) && !pending && !preview;
  useEffect(() => {
    if (asking) instructionInput.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (
      preview &&
      (container.current?.contains(document.activeElement) ||
        document.activeElement === document.body ||
        document.activeElement ===
          container.current?.closest('[role="dialog"]'))
    )
      applyButton.current?.focus();
  }, [preview]);
  return (
    <div ref={container} className="mt-1.5" aria-busy={pending}>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            disabled={empty || pending}
            title={empty ? uk.ai.emptyHint : uk.ai.assist}
            className={cn(
              'inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent transition-colors',
              'hover:bg-chip disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {pending ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Sparkles aria-hidden className="size-3.5" />
            )}
            {pending ? uk.ai.pending : uk.ai.short}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-56 p-1"
          onCloseAutoFocus={(event) => {
            if (asking) event.preventDefault();
          }}
        >
          <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            {uk.ai.menuTitle}
          </p>
          {(Object.keys(uk.ai.actions) as Action[]).map((key) => {
            const Icon = icons[key];
            return (
              <button
                key={key}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-chip"
                onClick={() => {
                  if (needsInstruction(key)) {
                    setMenu(false);
                    setPreview('');
                    setError('');
                    setAction(key);
                  } else void run(key, '');
                }}
              >
                <Icon aria-hidden className="size-4 text-muted-foreground" />
                {uk.ai.actions[key]}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {asking && (
        <div
          data-ai-instruction=""
          role="group"
          aria-label={uk.ai.instruction}
          className="mt-1.5 flex gap-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <Input
            ref={instructionInput}
            autoFocus
            className="min-w-0 flex-1"
            aria-label={uk.ai.instruction}
            placeholder={
              action === 'translate' ? uk.ai.languageHint : uk.ai.customHint
            }
            maxLength={1000}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              event.stopPropagation();
              if (instruction.trim()) void run(action);
            }}
          />
          <Button
            type="button"
            disabled={!instruction.trim()}
            onClick={() => void run(action)}
          >
            {uk.ai.go}
          </Button>
          <Button type="button" variant="outline" onClick={close}>
            <X aria-hidden className="size-4" />
            <span className="sr-only">{uk.ai.cancel}</span>
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-sm text-err">
          {error}
        </p>
      )}
      {preview && (
        <div className="mt-1.5 rounded-lg border border-accent/40 bg-chip p-3">
          <p className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles aria-hidden className="size-3 text-accent" />
            {action ? uk.ai.actions[action].replace('…', '') : uk.ai.preview}
          </p>
          <p className="whitespace-pre-wrap text-sm">{preview}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              ref={applyButton}
              type="button"
              className="min-h-8 px-3 text-xs"
              onClick={() => {
                onApply(preview);
                close();
              }}
            >
              <Check aria-hidden className="size-3.5" />
              {uk.ai.replace}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-8 px-3 text-xs"
              disabled={pending || !action}
              onClick={() => action && void run(action)}
            >
              <RefreshCw aria-hidden className="size-3.5" />
              {uk.ai.again}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-8 px-3 text-xs"
              onClick={close}
            >
              {uk.ai.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
