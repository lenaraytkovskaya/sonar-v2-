'use client';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Copy } from 'lucide-react';
import { findMessagePlaceholder } from '@sonar/core';
import { cn } from '@/lib/utils';
import { normalizedDraft, sameDraft } from '@/lib/draft-state';
import type { getConversationChat } from '@sonar/db/inbound';
import { uk } from '@/i18n/uk';
import {
  channelLabel,
  contactLabel,
  socialUnavailableNotice,
} from '@/lib/outreach-labels';
import { useInboxPolling } from './use-inbox-polling';
import { inboxReadSnapshot } from '@/lib/inbox-read';
import { isNearBottom, newMessageCount } from '@/lib/inbox-scroll';
import { Card, StatusBadge } from './shared';
import { Draft } from './company-email';
import { AiAssist } from './ai-assist';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Callout } from './ui/layout';
import { FormReplyMatch } from './form-reply-match';
import { ViberThreadMatch } from './viber-thread-match';
import { ChannelIcon } from './channel-icon';
import { FriendlyError } from './friendly-error';
import { LocalTime } from './local-time';
import {
  canReplyInConversation,
  isReplyDraftChannel,
} from '@/lib/conversation-reply';
type Message = NonNullable<
  Awaited<ReturnType<typeof getConversationChat>>
>['messages'][number];
type Chat = Awaited<ReturnType<typeof getConversationChat>>;
type Task = { id: string; status: string; reason_uk?: string };
export function ConversationChat({
  initial,
  active = true,
  backHref,
}: {
  initial: Chat;
  active?: boolean;
  backHref?: string;
}) {
  const [data, setData] = useState(initial);
  const [timeZone, setTimeZone] = useState('UTC');
  useEffect(() => setData(initial), [initial]);
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }, []);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState(
    [...initial.messages].reverse().find((m) => m.subject)?.subject ?? '',
  );
  const placeholder =
    data.conversation?.channel === 'call'
      ? null
      : findMessagePlaceholder(`${subject}\n${body}`);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const busy = useRef(false);
  const requestKey = useRef({ fingerprint: '', key: '' });
  const history = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const update = () => setCompact(element.clientHeight < 440);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const atBottom = useRef(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const previous = useRef<string[]>([]);
  const [newMessages, setNewMessages] = useState(0);
  const revision = useRef(0);
  const mounted = useRef(true);
  const actionRead = useRef<AbortController | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const draftKey = `sonar:reply:${initial.conversation?.id}`;
  useEffect(() => {
    mounted.current = true;
    actionRead.current = new AbortController();
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
      if (
        typeof saved?.body === 'string' &&
        typeof saved?.subject === 'string'
      ) {
        setBody(saved.body);
        setSubject(saved.subject);
        if (
          typeof saved.requestKey?.fingerprint === 'string' &&
          typeof saved.requestKey?.key === 'string'
        )
          requestKey.current = saved.requestKey;
      }
    } catch {
      /* Storage may be unavailable. Keep the in-memory draft. */
    }
    setDraftLoaded(true);
    return () => {
      mounted.current = false;
      actionRead.current?.abort();
      revision.current++;
    };
  }, [draftKey]);
  useEffect(() => {
    if (draftLoaded)
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ body, subject, requestKey: requestKey.current }),
        );
      } catch {
        /* Keep the in-memory draft. */
      }
  }, [body, subject, draftLoaded, draftKey, pending]);
  const scrollToLatest = () => {
    if (history.current)
      history.current.scrollTop = history.current.scrollHeight;
    atBottom.current = true;
    setFollowingLatest(true);
    setNewMessages(0);
  };
  useLayoutEffect(() => {
    if (!active) return;
    const added = newMessageCount(
      previous.current,
      data.messages.map((m) => m.id),
    );
    if (!previous.current.length || atBottom.current) scrollToLatest();
    else if (added) setNewMessages((count) => count + added);
    previous.current = data.messages.map((m) => m.id);
  }, [data.messages, active]);
  useEffect(() => {
    const element = history.current;
    if (!element || !active) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) scrollToLatest();
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [active]);
  const path = `/api/conversations/${initial.conversation?.id}`;
  const lastInbound = [...data.messages]
    .reverse()
    .find((m) => m.direction === 'in');
  const readSnapshot = JSON.stringify(
    data.messages
      .filter((m) => m.direction === 'in')
      .map((m) => ({ id: m.id, unread: !m.readAt })),
  );
  const { error: refreshError } = useInboxPolling(
    active && path,
    async (signal) => {
      if (busy.current) return;
      const version = revision.current;
      const response = await fetch(path, { signal, cache: 'no-store' });
      if (!response.ok) throw Error();
      const next = await response.json();
      if (signal.aborted || busy.current || version !== revision.current)
        return;
      setData(next);
      if (task && ['queued', 'running'].includes(task.status)) {
        const status = await fetch(`${path}?taskId=${task.id}`, {
          signal,
          cache: 'no-store',
        });
        if (status.ok) {
          const nextTask = await status.json();
          if (!signal.aborted && version === revision.current)
            setTask(nextTask);
        }
      }
    },
  );
  useEffect(() => {
    const incoming = JSON.parse(readSnapshot) as {
      id: string;
      unread: boolean;
    }[];
    const snapshot = inboxReadSnapshot(incoming, {
      active,
      followingLatest,
      newMessages,
      conversationId: data.conversation?.id,
      selectedId: initial.conversation?.id,
    });
    if (!snapshot) return;
    let controller = new AbortController();
    const markRead = () => {
      if (document.visibilityState !== 'visible' || !atBottom.current) return;
      void fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      }).catch(() => {});
    };
    const changed = () => {
      if (document.visibilityState !== 'visible') {
        controller.abort();
        controller = new AbortController();
      } else markRead();
    };
    markRead();
    document.addEventListener('visibilitychange', changed);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', changed);
    };
  }, [
    path,
    readSnapshot,
    data.messages,
    active,
    followingLatest,
    newMessages,
    data.conversation?.id,
    initial.conversation?.id,
  ]);
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    if (action === 'copied' || action === 'copyError') {
      setNotice(action === 'copied' ? uk.outreach.copied : uk.email.error);
      return true;
    }
    if (busy.current) return false;
    busy.current = true;
    revision.current++;
    setPending(true);
    setNotice('');
    const fingerprint = JSON.stringify({ action, ...fields });
    if (requestKey.current.fingerprint !== fingerprint)
      requestKey.current = { fingerprint, key: crypto.randomUUID() };
    try {
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ body, subject, requestKey: requestKey.current }),
        );
      } catch {
        /* Keep the in-memory request key. */
      }
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
      if (!mounted.current) return true;
      requestKey.current = { fingerprint: '', key: '' };
      if (action === 'generate') setTask(result);
      if (action === 'reply') {
        setBody((current) => (current === fields.body ? '' : current));
        atBottom.current = true;
      }
      // An accepted send must not become a retryable failure if this read fails.
      try {
        const refresh = await fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.any([
            ...(actionRead.current ? [actionRead.current.signal] : []),
            AbortSignal.timeout(15000),
          ]),
        });
        if (refresh.ok) {
          const next = await refresh.json();
          if (mounted.current) setData(next);
        }
      } catch {
        /* The next UI poll will refresh the accepted action. */
      }
      return true;
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : uk.email.error);
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  // One composer: an AI draft is edited and sent from the bottom box, not as a second editor.
  const pendingDraft = [...data.messages]
    .reverse()
    .find(
      (m) =>
        m.direction === 'out' &&
        ['draft', 'awaiting_approval'].includes(m.status) &&
        isReplyDraftChannel(m.channel),
    );
  const pendingDraftId = pendingDraft?.id;
  useEffect(() => {
    if (!pendingDraft || !draftLoaded) return;
    setBody((current) => (current.trim() ? current : pendingDraft.body));
    if (pendingDraft.subject)
      setSubject((current) =>
        current.trim() ? current : (pendingDraft.subject ?? ''),
      );
    // Only when a different draft appears.
  }, [pendingDraftId, draftLoaded]);
  const sendDraft = async () => {
    if (!pendingDraft || placeholder) return;
    const base = normalizedDraft({
      subject: pendingDraft.subject ?? '',
      body: pendingDraft.body,
    });
    const submitted = normalizedDraft({ subject, body });
    const changed = !sameDraft(submitted, base);
    if (
      changed &&
      !(await act('save', {
        messageId: pendingDraft.id,
        ...submitted,
        expected: base,
      }))
    )
      return;
    const requestingApproval =
      pendingDraft.status !== 'awaiting_approval' &&
      conversation?.campaignSendMode === 'approval';
    if (
      await act(
        conversation?.channel === 'social' && !data.socialAvailable
          ? 'manual'
          : pendingDraft.status === 'awaiting_approval'
            ? 'approve'
            : 'send',
        { messageId: pendingDraft.id, expected: changed ? submitted : base },
      )
    ) {
      if (!requestingApproval) setBody('');
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
  const canReply = canReplyInConversation(conversation.channel);
  const link =
    ['form', 'social'].includes(conversation.channel) &&
    /^https?:\/\//i.test(conversation.contactValue ?? '')
      ? conversation.contactValue
      : null;
  return (
    <Card
      ref={frame}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <header
        tabIndex={0}
        className={cn(
          'max-h-[30%] min-h-8 shrink space-y-1 overflow-y-auto overscroll-contain border-b border-border p-3',
          compact && 'p-2',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          {backHref && (
            <Link
              href={backHref}
              scroll={false}
              className={cn(
                'inline-flex min-h-9 items-center text-sm text-accent lg:hidden',
                compact && 'min-h-7 text-xs',
              )}
            >
              {uk.inbound.backToDialogs}
            </Link>
          )}
          {conversation.needsHuman && (
            <StatusBadge status="waiting">{uk.inbound.needsHuman}</StatusBadge>
          )}
        </div>
        <h2
          title={conversation.companyName ?? undefined}
          className={cn(
            'line-clamp-2 break-words font-heading text-lg font-bold [overflow-wrap:anywhere]',
            compact && 'line-clamp-1 text-base',
          )}
        >
          {conversation.companyId ? (
            <Link
              href={`/companies/${conversation.companyId}`}
              className="text-accent hover:underline"
            >
              {conversation.companyName}
            </Link>
          ) : (
            uk.inbound.unknownCompany
          )}
        </h2>
        <p
          title={contactLabel(conversation.contactValue)}
          className={cn(
            'break-words text-sm text-muted-foreground',
            compact && 'truncate text-xs',
          )}
        >
          <ChannelIcon
            channel={conversation.channel}
            value={conversation.contactValue ?? ''}
            className="mr-1"
          />
          {channelLabel(conversation.channel, conversation.contactValue ?? '')}{' '}
          · {contactLabel(conversation.contactValue)}
        </p>
        {data.blocked && (
          <StatusBadge status="closed">{uk.email.blocked}</StatusBadge>
        )}
      </header>
      <FormReplyMatch
        conversationId={conversation.id}
        companyId={conversation.companyId}
        active={active}
      />
      <ViberThreadMatch
        conversationId={conversation.id}
        active={
          active &&
          conversation.channel === 'viber' &&
          !conversation.companyId &&
          conversation.contactValue?.startsWith('viber-thread:') === true
        }
      />
      <div className="relative min-h-12 flex-1">
        <div
          ref={history}
          tabIndex={0}
          onScroll={() => {
            if (history.current) {
              atBottom.current = isNearBottom(history.current);
              setFollowingLatest(atBottom.current);
              if (atBottom.current) setNewMessages(0);
            }
          }}
          role="log"
          aria-label={uk.email.history}
          aria-live="polite"
          aria-relevant="additions"
          className="h-full min-h-0 overflow-y-auto overscroll-contain bg-raised p-3"
        >
          <div className="space-y-2">
            {data.messages
              .filter((message) => message.id !== pendingDraftId)
              .map((message, index, shown) => {
                const day = (value: Message) =>
                  new Date(value.sentAt ?? value.createdAt).toLocaleDateString(
                    'en-CA',
                    { timeZone },
                  );
                const newDay =
                  index === 0 || day(shown[index - 1]!) !== day(message);
                return (
                  <Fragment key={message.id}>
                    {newDay && (
                      <p
                        className="py-2 text-center text-xs text-muted-foreground"
                        suppressHydrationWarning
                      >
                        <span className="rounded-full bg-surface px-3 py-1">
                          <LocalTime
                            value={message.sentAt ?? message.createdAt}
                            monthDay
                          />
                        </span>
                      </p>
                    )}
                    <Draft
                      bubble
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
                );
              })}
          </div>
        </div>
        {newMessages > 0 && (
          <Button
            variant="outline"
            className="absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 shadow-lg"
            onClick={scrollToLatest}
          >
            {uk.inbound.newMessages} ({newMessages})
          </Button>
        )}
      </div>
      {(refreshError || task || notice) && (
        <div
          role="status"
          tabIndex={0}
          className="max-h-8 shrink-0 overflow-y-auto px-2 text-xs"
        >
          {refreshError && (
            <p className="text-err">{uk.inbound.refreshError}</p>
          )}
          {task && (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={task.status}>
                {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
              </StatusBadge>
              {task.reason_uk && <FriendlyError reason={task.reason_uk} />}
            </div>
          )}
          {notice && <p>{notice}</p>}
        </div>
      )}
      {!data.blocked && canReply && (
        <div
          className={cn(
            'relative shrink-0 space-y-2 border-t border-border p-3',
            compact && 'space-y-1 p-2',
          )}
        >
          {social && !data.socialAvailable && (
            <Callout tone="wait">
              {socialUnavailableNotice(
                conversation.contactValue,
                data.socialUnavailableReasonUk,
                data.socialUnavailableKind,
              )}
            </Callout>
          )}
          <details className="group/reply">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {uk.inbound.replyOptions}
            </summary>
            <div className="absolute inset-x-2 bottom-full z-10 hidden max-h-[calc(var(--inbox-height,100dvh)*0.4)] space-y-2 overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-lg group-open/reply:block">
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
            </div>
          </details>
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
          <label className="sr-only" htmlFor="reply-body">
            {conversation.channel === 'call'
              ? uk.outreach.callNote
              : data.messages.length
                ? uk.inbound.reply
                : uk.inbound.firstMessage}
          </label>
          <textarea
            id="reply-body"
            value={body}
            rows={2}
            maxLength={20000}
            onChange={(event) => setBody(event.target.value)}
            className={cn(
              'max-h-[calc(var(--inbox-height,100dvh)*0.2)] min-h-16 w-full resize-y rounded-lg border border-border bg-surface p-3',
              compact &&
                'max-h-[calc(var(--inbox-height,100dvh)*0.12)] min-h-10 resize-none p-2',
            )}
          />
          {placeholder && (
            <Callout tone="err">{uk.outreach.placeholder(placeholder)}</Callout>
          )}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <AiAssist floating text={body} onApply={setBody} />
            </div>
            <Button
              disabled={
                pending ||
                !!placeholder ||
                !body.trim() ||
                (conversation.channel === 'email' && !subject.trim())
              }
              onClick={() =>
                pendingDraft
                  ? void sendDraft()
                  : void act('reply', {
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
                  : pendingDraft?.status === 'awaiting_approval'
                    ? uk.email.approve
                    : pendingDraft &&
                        conversation.campaignSendMode === 'approval'
                      ? uk.email.requestApproval
                      : uk.email.send}
            </Button>
            {pendingDraft && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                title={uk.outreach.skipDraftHint}
                onClick={() =>
                  void act('skip', { messageId: pendingDraft.id }).then(
                    (ok) => ok && setBody(''),
                  )
                }
              >
                {uk.outreach.skip}
              </Button>
            )}
            {link && (
              <Button
                type="button"
                variant="outline"
                className={compact ? 'shrink-0 px-2' : undefined}
                title={uk.outreach.copy}
                disabled={!body.trim()}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(body)
                    .then(() => act('copied'))
                    .catch(() => act('copyError'))
                }
              >
                {compact && <Copy aria-hidden className="size-4" />}
                <span className={compact ? 'sr-only' : undefined}>
                  {uk.outreach.copy}
                </span>
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
