'use client';
import { useState } from 'react';
import type { ContactDetails as Details } from '@sonar/db/forms';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Section } from './ui/layout';

export function ContactDetails({
  initial,
  formDelivery,
}: {
  initial: Details;
  formDelivery: { dailyLimit: number; sentToday: number };
}) {
  const [details, setDetails] = useState(initial);
  const [dailyLimit, setDailyLimit] = useState(String(formDelivery.dailyLimit));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  return (
    <Section title={uk.forms.contactDetails} description={uk.forms.contactHint}>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setNotice('');
          try {
            const response = await fetch('/api/contact-details', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...details,
                dailyLimit: Number(dailyLimit),
              }),
            });
            const result = await response.json();
            if (!response.ok) throw Error(result.error ?? uk.email.error);
            setNotice(uk.outreach.saved);
          } catch (error) {
            setNotice(error instanceof Error ? error.message : uk.email.error);
          } finally {
            setPending(false);
          }
        }}
      >
        {(Object.keys(uk.forms.contactLabels) as (keyof Details)[]).map(
          (key) => (
            <div key={key} className="space-y-1">
              <label
                htmlFor={`contact-details-${key}`}
                className="text-sm font-medium"
              >
                {uk.forms.contactLabels[key]}
              </label>
              <Input
                id={`contact-details-${key}`}
                type={
                  key === 'email'
                    ? 'email'
                    : key === 'phone'
                      ? 'tel'
                      : key === 'website'
                        ? 'url'
                        : 'text'
                }
                maxLength={500}
                value={details[key]}
                onChange={(event) =>
                  setDetails({ ...details, [key]: event.target.value })
                }
              />
              <AiAssist
                text={details[key]}
                onApply={(value) => setDetails({ ...details, [key]: value })}
              />
            </div>
          ),
        )}
        <div className="space-y-3 border-t border-border pt-5 sm:col-span-2">
          <h3 className="text-sm font-semibold">{uk.forms.sendingTitle}</h3>
          <p className="text-sm text-muted-foreground">
            {uk.forms.sentToday(
              formDelivery.sentToday,
              Number(dailyLimit) || formDelivery.dailyLimit,
            )}
          </p>
          <label
            htmlFor="form-daily-limit"
            className="block text-sm font-medium"
          >
            {uk.forms.dailyLimit}
          </label>
          <Input
            id="form-daily-limit"
            type="number"
            min={1}
            max={100000}
            step={1}
            value={dailyLimit}
            onChange={(event) => setDailyLimit(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {uk.forms.sendingHint}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button disabled={pending}>
            {pending ? uk.ai.pending : uk.forms.save}
          </Button>
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
        </div>
      </form>
    </Section>
  );
}
