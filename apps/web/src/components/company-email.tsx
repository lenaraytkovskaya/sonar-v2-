'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { getCompanyChat } from '@sonar/db/outreach';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { channelLabel, messageStatus } from '@/lib/outreach-labels';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { LocalTime } from './local-time';
type Chat = Awaited<ReturnType<typeof getCompanyChat>>;
type Message = Chat['messages'][number];
type Action = (
  action: string,
  fields?: Record<string, unknown>,
) => Promise<boolean>;
const selectClass =
  'min-h-11 w-full rounded-lg border border-border bg-surface px-3';

function Draft({
  message,
  blocked,
  pending,
  approval,
  act,
}: {
  message: Message;
  blocked: boolean;
  pending: boolean;
  approval: boolean;
  act: Action;
}) {
  const [subject, setSubject] = useState(message.subject),
    [body, setBody] = useState(message.body);
  const editable = ['draft', 'awaiting_approval', 'awaiting_manual'].includes(
    message.status,
  );
  const manual = ['form', 'social'].includes(message.channel);
  const changed = subject !== message.subject || body !== message.body;
  const save = () => act('save', { messageId: message.id, subject, body });
  const proceed = async (action: string) => {
    if (changed && !(await save())) return;
    await act(action, { messageId: message.id });
  };
  return (
    <section
      className={cn(
        'min-w-0 space-y-2 rounded-lg border border-border p-3',
        message.direction === 'in' ? 'mr-6 bg-surface' : 'ml-6 bg-raised',
      )}
    >
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>
          {message.direction === 'in'
            ? uk.outreach.incoming
            : uk.outreach.outgoing}
        </span>
        <span>{messageStatus(message.status)}</span>
        <span>
          {uk.outreach.sources[
            message.source as keyof typeof uk.outreach.sources
          ] ?? message.source}
        </span>
        <LocalTime value={message.sentAt ?? message.createdAt} />
      </p>
      {editable && !blocked ? (
        <>
          {message.channel === 'email' && (
            <div>
              <label htmlFor={`subject-${message.id}`}>
                {uk.email.subject}
              </label>
              <Input
                id={`subject-${message.id}`}
                value={subject}
                maxLength={998}
                onChange={(event) => setSubject(event.target.value)}
              />
              <AiAssist text={subject} onApply={setSubject} />
            </div>
          )}
          <div>
            <label htmlFor={`body-${message.id}`}>{uk.email.body}</label>
            <textarea
              id={`body-${message.id}`}
              rows={5}
              maxLength={20000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface p-3"
            />
            <AiAssist text={body} onApply={setBody} />
          </div>
          {manual && (
            <p className="text-xs text-muted-foreground">
              {uk.outreach.manualHint}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending || !changed || !body.trim()}
              onClick={() => void save()}
            >
              {uk.outreach.save}
            </Button>
            {manual ? (
              <>
                <Button
                  variant="outline"
                  disabled={pending || !body.trim()}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(body)
                      .then(() => act('copied'))
                      .catch(() => act('copyError'))
                  }
                >
                  {uk.outreach.copy}
                </Button>
                <Button
                  disabled={pending || !body.trim()}
                  onClick={() => void proceed('manual')}
                >
                  {uk.outreach.manualSent}
                </Button>
              </>
            ) : (
              <Button
                disabled={
                  pending ||
                  !body.trim() ||
                  (message.channel === 'email' && !subject.trim())
                }
                onClick={() =>
                  void proceed(
                    message.status === 'awaiting_approval' ? 'approve' : 'send',
                  )
                }
              >
                {message.status === 'awaiting_approval'
                  ? uk.email.approve
                  : approval
                    ? uk.email.requestApproval
                    : uk.email.send}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void act('skip', { messageId: message.id })}
            >
              {uk.outreach.skip}
            </Button>
          </div>
        </>
      ) : (
        <>
          {message.subject && (
            <h3 className="font-semibold">{message.subject}</h3>
          )}
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </>
      )}
      {message.reasonUk && <p className="text-err">{message.reasonUk}</p>}
    </section>
  );
}

export function CompanyChat({
  initial,
  selectedCampaign,
  selectedContact,
}: {
  initial: Chat;
  selectedCampaign?: string;
  selectedContact?: string;
}) {
  const [data, setData] = useState(initial);
  const contacts = data.contacts.filter((contact) =>
    ['email', 'form', 'social', 'phone', 'telegram', 'whatsapp'].includes(
      contact.kind,
    ),
  );
  const [contactId, setContactId] = useState(
    selectedContact ?? contacts[0]?.id ?? '',
  );
  const [campaignId, setCampaignId] = useState(
    selectedCampaign ?? data.campaigns[0]?.id ?? '',
  );
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [callNote, setCallNote] = useState('');
  const [task, setTask] = useState<{
    id: string;
    status: string;
    reason_uk?: string;
  } | null>(null);
  const busy = useRef(false),
    requestKey = useRef({ fingerprint: '', key: '' });
  const companyId = data.company?.id;
  const path = `/api/companies/${companyId}/outreach`;
  useEffect(() => setData(initial), [initial]);
  useEffect(() => {
    if (!contacts.some((contact) => contact.id === contactId))
      setContactId(contacts[0]?.id ?? '');
  }, [data.contacts, contactId]);
  useEffect(() => {
    if (!companyId) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (response.ok) setData(await response.json());
        if (task && ['queued', 'running'].includes(task.status)) {
          const status = await fetch(`${path}?taskId=${task.id}`, {
            signal: controller.signal,
          });
          if (status.ok) setTask({ id: task.id, ...(await status.json()) });
        }
      } catch {
        /* Retain the latest successful snapshot during a network interruption. */
      }
    };
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [companyId, path, task]);
  const act: Action = async (action, fields = {}) => {
    if (action === 'copied' || action === 'copyError') {
      setNotice(action === 'copied' ? uk.outreach.copied : uk.email.error);
      return true;
    }
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setNotice('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...fields }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      if (action === 'generate')
        setTask({ id: result.id, status: result.status ?? 'queued' });
      else setNotice(uk.outreach.saved);
      if (action === 'call') {
        setCallNote('');
        requestKey.current = { fingerprint: '', key: '' };
      }
      const snapshot = await fetch(path).catch(() => null);
      if (snapshot?.ok) setData(await snapshot.json());
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : uk.email.error);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const contact = contacts.find((row) => row.id === contactId);
  const blocked = data.blocked || data.blockedContactIds.includes(contactId);
  const approval =
    data.campaigns.find((row) => row.id === campaignId)?.sendMode ===
    'approval';
  const conversationIds = data.conversations
    .filter(
      (row) => row.contactId === contactId && row.campaignId === campaignId,
    )
    .map((row) => row.id);
  const messages = data.messages
    .filter((row) => conversationIds.includes(row.conversationId))
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  const generating = !!task && ['queued', 'running'].includes(task.status);
  const request = (action: 'generate' | 'call') => {
    const fields = {
      contactId,
      campaignId,
      ...(action === 'call' ? { body: callNote } : {}),
    };
    const fingerprint = JSON.stringify({ action, ...fields });
    if (requestKey.current.fingerprint !== fingerprint)
      requestKey.current = { fingerprint, key: crypto.randomUUID() };
    void act(action, { ...fields, requestId: requestKey.current.key }).then(
      (ok) => {
        if (ok && action === 'generate')
          requestKey.current = { fingerprint: '', key: '' };
      },
    );
  };
  const href =
    contact &&
    ['form', 'social'].includes(contact.kind) &&
    /^https?:\/\//i.test(contact.value)
      ? contact.value
      : null;
  if (!data.company)
    return <Card className="p-4">{uk.manual.errors.companyNotFound}</Card>;
  return (
    <Card className="min-w-0 space-y-4 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading font-bold">
          {uk.outreach.title} ·{' '}
          <Link href={`/companies/${data.company.id}`} className="text-accent">
            {data.company.name}
          </Link>
        </h2>
        {!data.blocked && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void act('block')}
          >
            {uk.email.block}
          </Button>
        )}
        <select
          aria-label={uk.company.campaign}
          className={cn(selectClass, 'w-auto max-w-full')}
          value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
        >
          {data.campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
      </div>
      {!data.campaigns.length && <p>{uk.outreach.noCampaign}</p>}
      <div
        role="tablist"
        aria-label={uk.outreach.contacts}
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {contacts.map((row) => (
          <button
            key={row.id}
            role="tab"
            aria-selected={row.id === contactId}
            className={cn(
              'min-h-11 shrink-0 rounded-lg border px-3 py-2 text-left',
              row.id === contactId ? 'border-accent bg-chip' : 'border-border',
            )}
            onClick={() => {
              setContactId(row.id);
              setCallNote('');
            }}
          >
            <span className="block text-xs text-muted-foreground">
              {channelLabel(row.kind)}
            </span>
            {row.normalized || row.value}
          </button>
        ))}
      </div>
      {!contacts.length && <p>{uk.outreach.emptyContacts}</p>}
      {blocked && (
        <p role="status" className="rounded-lg bg-err-bg p-3 text-err">
          {uk.email.blocked}
        </p>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center text-accent"
        >
          {uk.outreach.openContact}
        </a>
      )}
      <div
        role="log"
        aria-label={uk.email.history}
        className="max-h-[36rem] space-y-3 overflow-y-auto"
      >
        {!messages.length && contact && (
          <p className="py-6 text-center text-muted-foreground">
            {uk.email.noMessages}
          </p>
        )}
        {messages.map((message) => (
          <Draft
            key={`${message.id}:${message.body}:${message.subject}:${message.status}`}
            message={message}
            blocked={blocked}
            pending={pending}
            approval={approval}
            act={act}
          />
        ))}
      </div>
      {contact &&
        !blocked &&
        (contact.kind === 'phone' ? (
          <div className="border-t border-border pt-3">
            <label htmlFor={`call-${data.company.id}`}>
              {uk.outreach.callNote}
            </label>
            <textarea
              id={`call-${data.company.id}`}
              className="w-full rounded-lg border border-border bg-surface p-3"
              value={callNote}
              maxLength={20000}
              rows={3}
              onChange={(event) => setCallNote(event.target.value)}
            />
            <AiAssist text={callNote} onApply={setCallNote} />
            <Button
              className="mt-3"
              disabled={pending || !campaignId || !callNote.trim()}
              onClick={() => request('call')}
            >
              {uk.outreach.logCall}
            </Button>
          </div>
        ) : !messages.length ? (
          <Button
            disabled={pending || generating || !campaignId}
            onClick={() => request('generate')}
          >
            {generating ? uk.outreach.generating : uk.outreach.generate}
          </Button>
        ) : null)}
      {task && (
        <p role="status" className="text-muted-foreground">
          {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
          {task.reason_uk && ` · ${task.reason_uk}`}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </Card>
  );
}
