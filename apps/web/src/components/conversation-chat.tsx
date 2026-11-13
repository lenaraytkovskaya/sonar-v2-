'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { getConversationChat } from '@sonar/db/inbound';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { ChannelIcon } from './channel-icon';
import { channelLabel, contactLabel } from '@/lib/outreach-labels';
import { Card } from './shared';
import { Draft } from './company-email';
import { AiAssist } from './ai-assist';
import { Button } from './ui/button';
import { Input } from './ui/input';
type Chat = Awaited<ReturnType<typeof getConversationChat>>;
type Task = { id: string; status: string; reason_uk?: string };
export function ConversationChat({ initial }: { initial: Chat }) {
  const [data, setData] = useState(initial);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState(
    [...initial.messages].reverse().find((m) => m.subject)?.subject ?? '',
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const busy = useRef(false);
  const requestKey = useRef({ fingerprint: '', key: '' });
  const path = `/api/conversations/${initial.conversation?.id}`;
  const lastInbound = [...data.messages]
    .reverse()
    .find((m) => m.direction === 'in');
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (response.ok) setData(await response.json());
        if (task && ['queued', 'running'].includes(task.status)) {
          const status = await fetch(`${path}?taskId=${task.id}`, {
            signal: controller.signal,
          });
          if (status.ok) setTask(await status.json());
        }
      } catch {
        /* Retain the latest snapshot while reconnecting. */
      }
    };
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, task]);
  useEffect(() => {
    if (!lastInbound) return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', messageId: lastInbound.id }),
      }).catch(() => {});
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [path, lastInbound?.id]);
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    if (action === 'copied' || action === 'copyError') {
      setNotice(action === 'copied' ? uk.outreach.copied : uk.email.error);
      return true;
    }
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setNotice('');
    const fingerprint = JSON.stringify({ action, ...fields });
    if (requestKey.current.fingerprint !== fingerprint)
      requestKey.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...fields,
          requestId: requestKey.current.key,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      requestKey.current = { fingerprint: '', key: '' };
      if (action === 'generate') setTask(result);
      if (action === 'reply') setBody('');
      const refresh = await fetch(path);
      if (refresh.ok) setData(await refresh.json());
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : uk.email.error);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const conversation = data.conversation;
  if (!conversation) return null;
  const generating =
    task !== null && ['queued', 'running'].includes(task.status);
  const social = conversation.channel === 'social';
  const manual =
    ['form', 'call'].includes(conversation.channel) ||
    (social && !data.socialAvailable);
  const canReply =
    manual ||
    social ||
    ['email', 'telegram', 'whatsapp'].includes(conversation.channel);
  const link =
    ['form', 'social'].includes(conversation.channel) &&
    /^https?:\/\//i.test(conversation.contactValue ?? '')
      ? conversation.contactValue
      : null;
  return (
    <Card className="min-w-0 space-y-4 p-4">
      <h2 className="font-heading text-lg font-bold">
        {conversation.companyId ? (
          <Link href={`/companies/${conversation.companyId}`}>
            {conversation.companyName}
          </Link>
        ) : (
          uk.inbound.unknownCompany
        )}
      </h2>
      <p className="break-words text-sm text-muted-foreground">
        <ChannelIcon
          channel={conversation.channel}
          value={conversation.contactValue ?? ''}
        />{' '}
        {channelLabel(conversation.channel, conversation.contactValue ?? '')} ·{' '}
        {contactLabel(conversation.contactValue)}
      </p>
      {conversation.needsHuman && (
        <p className="rounded-lg bg-wait-bg p-3 text-wait">
          <StatusBadge status="handoff">{uk.inbound.needsHuman}</StatusBadge>
        </p>
      )}
      {data.blocked && (
        <p className="rounded-lg bg-err-bg p-3 text-err">
          <StatusBadge status="do_not_contact">{uk.email.blocked}</StatusBadge>
        </p>
      )}
      <div
        role="log"
        aria-label={uk.email.history}
        className="max-h-[36rem] space-y-3 overflow-y-auto"
      >
        {data.messages.map((message) => (
          <Draft
            key={`${message.id}:${message.body}:${message.subject}:${message.status}`}
            message={message}
            blocked={data.blocked}
            pending={pending}
            approval={
              message.source !== 'reply' &&
              conversation.campaignSendMode === 'approval'
            }
            act={act}
            onUseText={
              social && data.socialAvailable
                ? (text) => {
                    setBody(text);
                    document.getElementById('reply-body')?.focus();
                  }
                : undefined
            }
          />
        ))}
      </div>
      {!data.blocked && canReply && (
        <div className="space-y-3 border-t border-border pt-3">
          {lastInbound && (
            <Button
              variant="outline"
              disabled={pending || generating}
              onClick={() => void act('generate')}
            >
              {generating ? uk.outreach.generating : uk.inbound.suggest}
            </Button>
          )}
          {social && (
            <p className="text-sm text-muted-foreground">
              {data.socialAvailable
                ? uk.socialAccounts.browser
                : uk.socialAccounts.manual}
            </p>
          )}
          {link && manual && (
            <p className="text-sm">
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="text-accent"
              >
                {uk.outreach.openContact}
              </a>{' '}
              · {uk.outreach.manualHint}
            </p>
          )}
          {conversation.channel === 'email' && (
            <div>
              <label htmlFor="reply-subject">{uk.email.subject}</label>
              <Input
                id="reply-subject"
                value={subject}
                maxLength={998}
                onChange={(event) => setSubject(event.target.value)}
              />
              <AiAssist text={subject} onApply={setSubject} />
            </div>
          )}
          <label className="block" htmlFor="reply-body">
            {conversation.channel === 'call'
              ? uk.outreach.callNote
              : data.messages.length
                ? uk.inbound.reply
                : uk.inbound.firstMessage}
          </label>
          <textarea
            id="reply-body"
            value={body}
            rows={4}
            maxLength={20000}
            onChange={(event) => setBody(event.target.value)}
            className="w-full rounded-lg border border-border bg-surface p-3"
          />
          <AiAssist text={body} onApply={setBody} />
          <Button
            disabled={
              pending ||
              !body.trim() ||
              (conversation.channel === 'email' && !subject.trim())
            }
            onClick={() =>
              void act('reply', {
                body,
                subject,
                ...(social
                  ? {
                      socialDelivery: data.socialAvailable
                        ? 'browser'
                        : 'manual',
                    }
                  : {}),
              })
            }
          >
            {conversation.channel === 'call'
              ? uk.outreach.logCall
              : manual
                ? uk.outreach.manualSent
                : uk.email.send}
          </Button>
          {link && (
            <Button
              type="button"
              variant="outline"
              className="ml-2"
              disabled={!body.trim()}
              onClick={() =>
                void navigator.clipboard
                  .writeText(body)
                  .then(() => act('copied'))
                  .catch(() => act('copyError'))
              }
            >
              {uk.outreach.copy}
            </Button>
          )}
        </div>
      )}
      {task && (
        <p role="status" className="text-sm text-muted-foreground">
          <StatusBadge status={task.status}>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
          </StatusBadge>
          {task.reason_uk && ` · ${task.reason_uk}`}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </Card>
  );
}
