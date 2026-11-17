'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { listFormMessages } from '@sonar/db/forms';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { messageStatus } from '@/lib/outreach-labels';
import { Card, StatusBadge } from './shared';
import { Button } from './ui/button';
import { Callout, DetailList } from './ui/layout';
import { LocalTime } from './local-time';
import { InboxModeTabs } from './inbox-mode-tabs';
import { FriendlyError } from './friendly-error';
import { useInboxPolling } from './use-inbox-polling';

type Forms = Awaited<ReturnType<typeof listFormMessages>>;
const statusLabel = (status: string) =>
  status === 'awaiting_manual'
    ? uk.forms.awaitingManual
    : messageStatus(status);
export function FormInbox({
  initial,
  selectedId,
  explicitSelection,
}: {
  initial: Forms;
  selectedId?: string;
  explicitSelection: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  useEffect(() => setData(initial), [initial]);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const { error: refreshError } = useInboxPolling(
    '/api/form-messages',
    async (signal) => {
      if (busy.current) return;
      const response = await fetch('/api/form-messages', {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw Error();
      if (!signal.aborted) setData(await response.json());
    },
  );
  const selected = data.find((row) => row.id === selectedId);
  const rows = data.filter(
    (row) =>
      !filter ||
      (filter === 'replied' ? row.replies > 0 : row.status === filter),
  );
  const act = async (action: 'sent' | 'approve' | 'send') => {
    if (!selected || busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        action === 'sent'
          ? `/api/form-messages/${selected.id}`
          : `/api/companies/${selected.companyId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: action === 'send' ? 'submit' : action,
            messageId: selected.id,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      router.refresh();
      const refresh = await fetch('/api/form-messages', { cache: 'no-store' });
      if (refresh.ok) setData(await refresh.json());
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1
        className={cn(
          'shrink-0 font-heading text-2xl font-bold tracking-tight',
          explicitSelection && 'hidden lg:block',
        )}
      >
        {uk.pages.inbox.title}
      </h1>
      {refreshError && (
        <p role="status" className="text-sm text-err">
          {uk.inbound.refreshError}
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]">
        <Card
          className={cn(
            'min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain',
            explicitSelection && 'hidden lg:block',
          )}
        >
          <InboxModeTabs mode="forms" />
          <div className="border-b border-border p-3">
            <label htmlFor="form-inbox-status" className="sr-only">
              {uk.company.status}
            </label>
            <select
              id="form-inbox-status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
            >
              <option value="">{uk.company.all}</option>
              {[
                'awaiting_manual',
                'awaiting_approval',
                'queued',
                'draft',
                'sent',
                'failed',
              ].map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
              <option value="replied">{uk.forms.replied}</option>
            </select>
          </div>
          {!rows.length && (
            <p className="p-5 text-sm text-muted-foreground">
              {uk.forms.inboxEmpty}
            </p>
          )}
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/inbox?tab=forms&form=${row.id}`}
              scroll={false}
              aria-current={selectedId === row.id ? 'true' : undefined}
              className={cn(
                'block min-w-0 space-y-2 border-b border-border px-4 py-3 text-sm last:border-0 hover:bg-raised',
                selectedId === row.id && 'bg-chip hover:bg-chip',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-medium">
                  {row.companyName}
                </span>
                <span className="text-xs text-muted-foreground">
                  <LocalTime value={row.sentAt ?? row.createdAt} />
                </span>
              </div>
              <StatusBadge status={row.status}>
                {statusLabel(row.status)}
              </StatusBadge>
              <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                {row.body}
              </p>
              <p className="text-xs text-muted-foreground">
                {uk.forms.sharedContacts}:{' '}
                {row.sharedContacts
                  .map((key) => uk.forms.contactLabels[key])
                  .join(', ') || '—'}
              </p>
              <p className="text-xs text-accent">
                {uk.forms.replies}:{' '}
                <span className="tabular-nums">{row.replies}</span>
              </p>
            </Link>
          ))}
        </Card>
        <Card
          className={cn(
            'min-h-0 min-w-0 overflow-y-auto overscroll-contain p-4',
            !explicitSelection && 'hidden lg:block',
          )}
        >
          <Link
            href="/inbox?tab=forms"
            className="mb-3 inline-flex min-h-9 items-center text-sm text-accent lg:hidden"
            scroll={false}
          >
            {uk.inbound.backToDialogs}
          </Link>
          {selected ? (
            <div className="space-y-5">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                <h2 className="min-w-0 break-words font-heading text-lg font-bold">
                  <Link
                    href={`/companies/${selected.companyId}`}
                    className="text-accent hover:underline"
                  >
                    {selected.companyName}
                  </Link>
                </h2>
                <StatusBadge status={selected.status}>
                  {statusLabel(selected.status)}
                </StatusBadge>
              </header>
              <DetailList
                items={[
                  {
                    label: selected.sentAt ? uk.forms.sentAt : uk.company.date,
                    value: (
                      <LocalTime
                        value={selected.sentAt ?? selected.createdAt}
                      />
                    ),
                  },
                  {
                    label: uk.forms.contactLabels.name,
                    value: selected.senderName,
                    hidden: !selected.senderName,
                  },
                  {
                    label: uk.forms.contactLabels.email,
                    value: selected.senderEmail,
                    hidden: !selected.sharedContacts.includes('email'),
                  },
                  {
                    label: uk.forms.contactLabels.phone,
                    value: selected.senderPhone,
                    hidden: !selected.sharedContacts.includes('phone'),
                  },
                  {
                    label: uk.forms.contactLabels.whatsapp,
                    value: selected.senderWhatsapp,
                    hidden: !selected.sharedContacts.includes('whatsapp'),
                  },
                  {
                    label: uk.forms.contactLabels.telegram,
                    value: selected.senderTelegram,
                    hidden: !selected.sharedContacts.includes('telegram'),
                  },
                  {
                    label: uk.forms.contactLabels.website,
                    value: selected.senderWebsite,
                    hidden: !selected.senderWebsite,
                  },
                  {
                    label: uk.forms.formUrl,
                    value: selected.url,
                  },
                  {
                    label: uk.forms.sharedContacts,
                    value:
                      selected.sharedContacts
                        .map((key) => uk.forms.contactLabels[key])
                        .join(', ') || '—',
                  },
                ]}
              />
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  {['sent', 'delivered', 'read'].includes(selected.status)
                    ? uk.forms.actualBody
                    : selected.status === 'awaiting_manual'
                      ? uk.forms.manualBody
                      : uk.forms.messaging}
                </h3>
                <div className="flex justify-end">
                  <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-accent/30 bg-accent/15 px-3 py-2 text-sm shadow-sm [overflow-wrap:anywhere] sm:max-w-[80%]">
                    {selected.body}
                  </p>
                </div>
              </section>
              {selected.reasonUk && <Callout><FriendlyError reason={selected.reasonUk} /></Callout>}
              <div className="grid gap-3 sm:grid-cols-2">
                {(['before', 'after'] as const)
                  .filter((phase) =>
                    phase === 'before'
                      ? selected.screenshotBefore
                      : selected.screenshotAfter,
                  )
                  .map((phase) => (
                    <a
                      key={phase}
                      href={`/api/form-messages/${selected.id}/screenshots/${phase}`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 overflow-hidden rounded-lg border border-border bg-raised text-xs text-accent hover:bg-chip"
                    >
                      <img
                        src={`/api/form-messages/${selected.id}/screenshots/${phase}`}
                        alt={uk.forms[phase]}
                        loading="lazy"
                        className="h-32 w-full object-cover object-top"
                      />
                      <span className="block px-3 py-2 font-medium">
                        {uk.forms[phase]}
                      </span>
                    </a>
                  ))}
              </div>
              {selected.status === 'awaiting_manual' && (
                <>
                  <Callout>{uk.forms.manualHint}</Callout>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline">
                      <a href={selected.url} target="_blank" rel="noreferrer">
                        {uk.forms.open}
                      </a>
                    </Button>
                    <Button disabled={pending} onClick={() => void act('sent')}>
                      {uk.forms.markSent}
                    </Button>
                  </div>
                </>
              )}
              {['draft', 'awaiting_approval'].includes(selected.status) && (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void act(
                      selected.status === 'awaiting_approval'
                        ? 'approve'
                        : 'send',
                    )
                  }
                >
                  {selected.status === 'awaiting_approval'
                    ? uk.email.approve
                    : uk.email.send}
                </Button>
              )}
              {error && (
                <p role="alert" className="text-sm text-err">
                  {error}
                </p>
              )}
              <section className="space-y-3 border-t border-border pt-4">
                <h3 className="font-semibold">
                  {uk.forms.replies}{' '}
                  <span className="tabular-nums">({selected.replies})</span>
                </h3>
                {!selected.replyConversations.length && (
                  <p className="text-sm text-muted-foreground">
                    {uk.forms.noReplies}
                  </p>
                )}
                {selected.replyConversations.map((reply) => (
                  <Link
                    key={reply.id}
                    href={`/inbox?conversation=${reply.id}`}
                    className="block space-y-2 rounded-lg border border-border p-3 text-sm hover:bg-raised"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="text-accent">{uk.forms.openReply}</span>
                      {reply.lastAt && <LocalTime value={reply.lastAt} />}
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap break-words">
                      {reply.lastMessage}
                    </p>
                  </Link>
                ))}
              </section>
            </div>
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {uk.forms.selectForm}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
