'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { getCompanyMessaging } from '@sonar/db/email';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
type Messaging = Awaited<ReturnType<typeof getCompanyMessaging>>;
export function CompanyEmail({
  companyId,
  initial,
  drafts,
  selectedCampaign,
}: {
  companyId: string;
  initial: Messaging;
  drafts: Record<string, string>;
  selectedCampaign?: string;
}) {
  const router = useRouter(),
    busy = useRef(false),
    draftKey = useRef({ fingerprint: '', key: '' });
  const [data, setData] = useState(initial),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState('');
  const firstCampaign =
    initial.campaigns.find((campaign) => campaign.id === selectedCampaign)
      ?.id ??
    initial.campaignId ??
    '';
  const [campaignId, setCampaignId] = useState(firstCampaign),
    [accountId, setAccountId] = useState(
      initial.accounts.find((account) => account.enabled)?.id ?? '',
    );
  const [toAddress, setToAddress] = useState(initial.defaultRecipient),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(drafts[firstCampaign] ?? initial.suggestedBody);
  useEffect(() => {
    setData(initial);
  }, [initial]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/companies/${companyId}/messages`, {
          signal: controller.signal,
        });
        if (response.ok) setData(await response.json());
      } catch {
        /* Keep the last successful snapshot during temporary network failures. */
      }
    };
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [companyId]);
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setNotice('');
    try {
      const response = await fetch(`/api/companies/${companyId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...fields }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      if (action === 'send') {
        setOpen(false);
        setSubject('');
        setBody('');
        draftKey.current = { fingerprint: '', key: '' };
        setNotice(uk.email.saved);
      }
      try {
        const snapshot = await fetch(`/api/companies/${companyId}/messages`);
        if (snapshot.ok) setData(await snapshot.json());
      } catch {
        /* Polling will refresh history after a confirmed mutation. */
      }
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const send = () => {
    const fields = { campaignId, accountId, toAddress, subject, body };
    const fingerprint = JSON.stringify(fields);
    if (draftKey.current.fingerprint !== fingerprint)
      draftKey.current = { fingerprint, key: crypto.randomUUID() };
    void act('send', { ...fields, idempotencyKey: draftKey.current.key });
  };
  const approval =
    data.campaigns.find((campaign) => campaign.id === campaignId)?.sendMode ===
    'approval';
  const ready =
    data.emails.length > 0 &&
    data.accounts.some((account) => account.enabled) &&
    data.campaigns.length > 0;
  const selectClass =
    'min-h-11 w-full rounded-lg border border-border bg-surface px-3';
  return (
    <Card className="min-w-0 space-y-4 p-5 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-xl font-bold">{uk.email.title}</h2>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={data.blocked || pending || !ready}
            onClick={() => setOpen(!open)}
          >
            {uk.email.write}
          </Button>
          <Button
            variant="outline"
            disabled={data.blocked || pending}
            onClick={() => void act('block')}
          >
            {uk.email.block}
          </Button>
        </div>
      </div>
      {data.blocked ? (
        <p role="status">{uk.email.blocked}</p>
      ) : (
        !ready && <p>{uk.email.noSetup}</p>
      )}
      {open && !data.blocked && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-2">
              {uk.company.campaign}
              <select
                className={selectClass}
                required
                value={campaignId}
                onChange={(event) => {
                  setCampaignId(event.target.value);
                  setBody(drafts[event.target.value] ?? '');
                }}
              >
                {data.campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2">
              {uk.email.account}
              <select
                className={selectClass}
                required
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {data.accounts
                  .filter((account) => account.enabled)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {account.fromAddress}
                    </option>
                  ))}
              </select>
            </label>
            <label className="space-y-2">
              {uk.email.recipient}
              <select
                className={selectClass}
                required
                value={toAddress}
                onChange={(event) => setToAddress(event.target.value)}
              >
                {data.emails.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <label htmlFor="email-subject">{uk.email.subject}</label>
            <Input
              id="email-subject"
              required
              maxLength={998}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
            <AiAssist text={subject} onApply={setSubject} />
          </div>
          <div>
            <label htmlFor="email-body">{uk.email.body}</label>
            <textarea
              id="email-body"
              required
              maxLength={20000}
              rows={8}
              className="w-full rounded-lg border border-border bg-surface p-3"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <AiAssist text={body} onApply={setBody} />
          </div>
          <p className="text-sm text-muted-foreground">
            {approval ? uk.email.approvalHint : uk.email.sendHint}
          </p>
          <Button type="submit" disabled={pending || !ready}>
            {pending
              ? uk.ai.pending
              : approval
                ? uk.email.requestApproval
                : uk.email.send}
          </Button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      <h3 className="font-semibold">{uk.email.history}</h3>
      {!data.messages.length && <p>{uk.email.noMessages}</p>}
      {data.messages.map((message) => (
        <section
          key={message.id}
          className="space-y-2 border-t border-border pt-4"
        >
          <p className="break-words font-medium">
            {message.subject} · {message.toAddress}
          </p>
          <p className="text-sm text-muted-foreground">
            {uk.email.statuses[message.status]} ·{' '}
            {new Date(message.sentAt ?? message.createdAt).toLocaleString(
              'uk-UA',
            )}
          </p>
          {message.status === 'queued' && message.scheduledAt && (
            <p className="text-sm text-muted-foreground">
              {uk.email.scheduled}:{' '}
              {new Date(message.scheduledAt).toLocaleString('uk-UA')}
            </p>
          )}
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
          {message.reasonUk && <p className="text-err">{message.reasonUk}</p>}
          {message.status === 'draft' && (
            <Button
              disabled={pending || data.blocked}
              onClick={() => void act('submit', { messageId: message.id })}
            >
              {uk.email.send}
            </Button>
          )}
          {message.status === 'awaiting_approval' && (
            <Button
              disabled={pending || data.blocked}
              onClick={() => void act('approve', { messageId: message.id })}
            >
              {uk.email.approve}
            </Button>
          )}
        </section>
      ))}
    </Card>
  );
}
