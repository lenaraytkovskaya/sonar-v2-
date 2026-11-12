'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
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
  const [channel, setChannel] = useState<'email' | 'form' | 'telegram'>(
    'email',
  );
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
    const fields = { campaignId, accountId, toAddress, subject, body, channel };
    const fingerprint = JSON.stringify(fields);
    if (draftKey.current.fingerprint !== fingerprint)
      draftKey.current = { fingerprint, key: crypto.randomUUID() };
    void act('send', { ...fields, idempotencyKey: draftKey.current.key });
  };
  const approval =
    data.campaigns.find((campaign) => campaign.id === campaignId)?.sendMode ===
    'approval';
  const accounts =
    channel === 'telegram'
      ? data.telegramAccounts
      : channel === 'form'
        ? data.formAccounts
        : data.accounts;
  const recipients =
    channel === 'telegram'
      ? data.telegramRecipients
      : channel === 'form'
        ? data.formUrls
        : data.emails;
  // Contacts and accounts can appear after the page loaded (manual add, polling);
  // keep the selected values inside the options the selects actually show.
  const recipientKey = recipients.join('\n');
  const accountKey = accounts
    .filter((account) => account.enabled)
    .map((account) => account.id)
    .join('\n');
  useEffect(() => {
    const options = recipientKey ? recipientKey.split('\n') : [];
    if (options.length && !options.includes(toAddress))
      setToAddress(options[0]!);
  }, [recipientKey, toAddress]);
  useEffect(() => {
    const options = accountKey ? accountKey.split('\n') : [];
    if (options.length && !options.includes(accountId))
      setAccountId(options[0]!);
  }, [accountKey, accountId]);
  const ready =
    recipients.length > 0 &&
    accounts.some((account) => account.enabled) &&
    data.campaigns.length > 0;
  const canWrite =
    data.campaigns.length > 0 &&
    ((data.emails.length > 0 &&
      data.accounts.some((account) => account.enabled)) ||
      (data.formUrls.length > 0 &&
        data.formAccounts.some((account) => account.enabled)) ||
      (data.telegramRecipients.length > 0 &&
        data.telegramAccounts.some((account) => account.enabled)));
  const sender = data.formAccounts.find((account) => account.id === accountId);
  const selectClass =
    'min-h-9 w-full rounded-lg border border-border bg-surface px-3';
  return (
    <Card className="min-w-0 space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-sm font-bold uppercase tracking-wide text-muted-foreground">
          {uk.forms.messaging}
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={data.blocked || pending || !canWrite}
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
        !canWrite && (
          <p>
            {uk.email.noSetup} {uk.forms.noSetup} {uk.telegram.noSetup}
          </p>
        )
      )}
      {open && !data.blocked && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label className="block space-y-2">
            {uk.forms.channel}
            <select
              className={selectClass}
              value={channel}
              onChange={(event) => {
                const next = event.target.value as
                  'email' | 'form' | 'telegram';
                setChannel(next);
                setAccountId(
                  (next === 'telegram'
                    ? data.telegramAccounts
                    : next === 'form'
                      ? data.formAccounts
                      : data.accounts
                  ).find((account) => account.enabled)?.id ?? '',
                );
                setToAddress(
                  (next === 'telegram'
                    ? data.telegramRecipients
                    : next === 'form'
                      ? data.formUrls
                      : data.emails)[0] ?? '',
                );
              }}
            >
              <option value="email">{uk.email.title}</option>
              <option value="form">{uk.forms.title}</option>
              {data.telegramRecipients.length > 0 &&
                data.telegramAccounts.some((account) => account.enabled) && (
                  <option value="telegram">{uk.telegram.title}</option>
                )}
            </select>
          </label>
          {!ready && (
            <p>
              {channel === 'telegram'
                ? uk.telegram.noSetup
                : channel === 'form'
                  ? uk.forms.noSetup
                  : uk.email.noSetup}
            </p>
          )}
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
                {accounts
                  .filter((account) => account.enabled)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ·{' '}
                      {'address' in account
                        ? account.address
                        : account.fromAddress}
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
                {recipients.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {channel === 'email' && (
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
          )}
          <div>
            <label htmlFor="email-body">{uk.email.body}</label>
            <textarea
              id="email-body"
              required
              maxLength={channel === 'telegram' ? 4096 : 20000}
              rows={8}
              className="w-full rounded-lg border border-border bg-surface p-3"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <AiAssist text={body} onApply={setBody} />
          </div>
          {channel === 'form' && sender && (
            <section className="space-y-2 rounded-lg border border-border bg-raised p-4">
              <h3 className="font-semibold">{uk.forms.preview}</h3>
              <p>
                {uk.forms.senderName}: {sender.senderName}
              </p>
              <p>
                {uk.email.address}: {sender.fromAddress}
              </p>
              <p>
                {uk.forms.senderPhone}: {sender.senderPhone}
              </p>
              <p className="whitespace-pre-wrap break-words">{body}</p>
            </section>
          )}
          <p className="text-sm text-muted-foreground">
            {approval
              ? uk.email.approvalHint
              : channel === 'telegram'
                ? uk.telegram.sendHint
                : channel === 'form'
                  ? uk.forms.sendHint
                  : uk.email.sendHint}
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
      {data.telegramUnavailable.map((contact) => (
        <p
          key={contact.value}
          className="rounded-lg bg-err-bg px-3 py-2 text-xs text-err"
        >
          {contact.value} · {uk.telegram.unavailable}: {contact.reasonUk}
        </p>
      ))}
      {notice && <p role="status">{notice}</p>}
      <h3 className="font-semibold">{uk.email.history}</h3>
      {!data.messages.length && <p>{uk.email.noMessages}</p>}
      {data.messages.map((message) => (
        <section
          key={message.id}
          className="space-y-2 border-t border-border pt-4"
        >
          <p className="break-words font-medium">
            {message.channel === 'telegram'
              ? uk.telegram.title
              : message.channel === 'form'
                ? uk.forms.title
                : message.subject}{' '}
            · {message.toAddress}
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
          {message.channel === 'form' && (
            <div className="grid gap-3 sm:grid-cols-2">
              {(['before', 'after'] as const).map(
                (phase) =>
                  message[
                    phase === 'before' ? 'screenshotBefore' : 'screenshotAfter'
                  ] && (
                    <a
                      key={phase}
                      className="min-w-0 space-y-2 rounded-lg border border-border p-3 text-accent"
                      href={`/api/form-messages/${message.id}/screenshots/${phase}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="block">{uk.forms[phase]}</span>
                      <Image
                        src={`/api/form-messages/${message.id}/screenshots/${phase}`}
                        alt={uk.forms[phase]}
                        width={1280}
                        height={960}
                        unoptimized
                        className="max-h-64 w-full rounded object-contain object-left"
                      />
                    </a>
                  ),
              )}
            </div>
          )}
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
