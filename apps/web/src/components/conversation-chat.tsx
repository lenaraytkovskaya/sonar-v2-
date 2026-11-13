'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { LocalTime } from './local-time';
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
  const [timeZone, setTimeZone] = useState('UTC');
  useEffect(
    () => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [],
  );
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState(
    [...initial.messages].reverse().find((m) => m.subject)?.subject ?? '',
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const busy = useRef(false);
  const log = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latestMessage = data.messages.at(-1);
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latestMessage?.id, latestMessage?.body, timeZone]);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = 'auto';
      const style = getComputedStyle(element);
      const maxHeight =
        parseFloat(style.lineHeight) * 6 +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom);
      element.style.maxHeight = `${maxHeight}px`;
      element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    }
  }, [body]);
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
  const send = () => {
    if (
      pending ||
      !body.trim() ||
      (conversation.channel === 'email' && !subject.trim())
    )
      return;
    void act('reply', {
      body,
      subject,
      ...(social
        ? { socialDelivery: data.socialAvailable ? 'browser' : 'manual' }
        : {}),
    });
  };
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden lg:h-[calc(100dvh-13rem)] lg:min-h-[32rem]">
      <header className="flex shrink-0 items-center gap-3 border-b border-border p-4">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent"
        >
          {(conversation.companyName || uk.inbound.unknownCompany)
            .split(/\s+/)
            .slice(0, 2)
            .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
            .join('')}
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-heading font-bold">
            {conversation.companyId ? (
              <Link
                className="hover:text-accent"
                href={`/companies/${conversation.companyId}`}
              >
                {conversation.companyName}
              </Link>
            ) : (
              uk.inbound.unknownCompany
            )}
          </h2>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <ChannelIcon
              channel={conversation.channel}
              value={conversation.contactValue ?? ''}
            />
            <span
              className="truncate"
              title={channelLabel(
                conversation.channel,
                conversation.contactValue ?? '',
              )}
            >
              {contactLabel(conversation.contactValue)}
            </span>
          </p>
        </div>
      </header>
      {conversation.needsHuman && (
        <p className="m-3 rounded-lg bg-wait-bg p-3 text-wait">
          <StatusBadge status="handoff">{uk.inbound.needsHuman}</StatusBadge>
        </p>
      )}
      {data.blocked && (
        <p className="m-3 rounded-lg bg-err-bg p-3 text-err">
          <StatusBadge status="do_not_contact">{uk.email.blocked}</StatusBadge>
        </p>
      )}
      <div
        ref={log}
        role="log"
        aria-label={uk.email.history}
        className="min-h-48 max-h-[55dvh] flex-1 space-y-3 overflow-y-auto bg-raised p-3 sm:p-4 lg:max-h-none"
      >
        {data.messages.map((message, index) => (
          <Fragment key={message.id}>
            {(index === 0 ||
              new Date(message.sentAt ?? message.createdAt).toLocaleDateString(
                'uk-UA',
                { timeZone },
              ) !==
                new Date(
                  data.messages[index - 1]?.sentAt ??
                    data.messages[index - 1]?.createdAt ??
                    message.createdAt,
                ).toLocaleDateString('uk-UA', { timeZone })) && (
              <div className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <LocalTime
                  value={message.sentAt ?? message.createdAt}
                  dateOnly
                />
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <Draft
              key={`${message.id}:${message.body}:${message.subject}:${message.status}`}
              messenger
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
          </Fragment>
        ))}
      </div>
      {!data.blocked && canReply && (
        <div className="shrink-0 space-y-2 border-t border-border p-3">
          {lastInbound && (
            <Button
              variant="outline"
              className="min-h-8 px-2 text-xs"
              disabled={pending || generating}
              onClick={() => void act('generate')}
            >
              {generating ? uk.outreach.generating : uk.inbound.suggest}
            </Button>
          )}
          {social && (
            <p className="text-xs text-muted-foreground">
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
          <div className="rounded-xl border border-border bg-surface p-2 focus-within:border-accent">
            <label className="sr-only" htmlFor="reply-body">
              {conversation.channel === 'call'
                ? uk.outreach.callNote
                : uk.inbound.reply}
            </label>
            <textarea
              ref={textarea}
              id="reply-body"
              value={body}
              rows={1}
              maxLength={20000}
              placeholder={
                conversation.channel === 'call'
                  ? uk.outreach.callNote
                  : uk.inbound.reply
              }
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  send();
                }
              }}
              className="block min-h-11 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none"
            />
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0 flex-1">
                <AiAssist text={body} onApply={setBody} />
              </div>
              <Button
                title={uk.inbound.sendShortcut}
                aria-label={
                  conversation.channel === 'call'
                    ? uk.outreach.logCall
                    : manual
                      ? uk.outreach.manualSent
                      : uk.email.send
                }
                disabled={
                  pending ||
                  !body.trim() ||
                  (conversation.channel === 'email' && !subject.trim())
                }
                onClick={send}
              >
                {manual && (
                  <span>
                    {conversation.channel === 'call'
                      ? uk.outreach.logCall
                      : uk.outreach.manualSent}
                  </span>
                )}
                <ArrowUp aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
          {link && (
            <Button
              type="button"
              variant="outline"
              className="min-h-8 text-xs"
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
        <p role="status" className="text-xs text-muted-foreground">
          <StatusBadge status={task.status}>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
          </StatusBadge>
          {task.reason_uk && ` · ${task.reason_uk}`}
        </p>
      )}
      {notice && (
        <p className="px-3 pb-3 text-sm" role="status">
          {notice}
        </p>
      )}
    </Card>
  );
}
