'use client';
import { useState } from 'react';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { runAiJob } from '@/lib/ai-job';
export function AiAssist({
  text,
  onApply,
}: {
  text: string;
  onApply: (text: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [action, setAction] = useState<keyof typeof uk.ai.actions>('improve'),
    [instruction, setInstruction] = useState(''),
    [preview, setPreview] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    setError('');
    setPreview('');
    try {
      const result = await runAiJob('/api/ai/assist', {
        action,
        text,
        instruction,
      });
      setPreview(result.text);
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.ai.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mt-3">
      <Button type="button" variant="outline" onClick={() => setOpen(!open)}>
        {uk.ai.assist}
      </Button>
      {open && (
        <div className="mt-3 space-y-3 rounded-lg border border-border p-4">
          <select
            aria-label={uk.ai.assist}
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
            className="min-h-9 w-full rounded-lg border border-border bg-surface px-3"
          >
            {Object.entries(uk.ai.actions).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {['custom', 'translate'].includes(action) && (
            <Input
              aria-label={uk.ai.instruction}
              placeholder={uk.ai.instruction}
              maxLength={1000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          )}
          <Button
            type="button"
            disabled={pending || !text.trim()}
            onClick={() => void run()}
          >
            {pending ? uk.ai.pending : uk.ai.run}
          </Button>
          {error && (
            <p role="alert" className="text-err">
              {error}
            </p>
          )}
          {preview && (
            <>
              <p className="font-medium">{uk.ai.preview}</p>
              <p className="whitespace-pre-wrap rounded-lg bg-raised p-4">
                {preview}
              </p>
              <div className="flex gap-3">
                <Button
                  type="button"
                  onClick={() => {
                    onApply(preview);
                    setPreview('');
                    setOpen(false);
                  }}
                >
                  {uk.ai.apply}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPreview('')}
                >
                  {uk.ai.cancel}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
