'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { socialTarget } from '@sonar/core';
import type { getCompanySocial } from '@sonar/db/social';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { ChannelIcon } from './channel-icon';
import { Button } from './ui/button';
import { LocalTime } from './local-time';

type SocialData = Awaited<ReturnType<typeof getCompanySocial>>;
const fields = {
  facebook: [
    'name',
    'category',
    'description',
    'followers',
    'rating',
    'reviewsCount',
    'postsCount',
    'lastPostAt',
  ],
  instagram: [
    'name',
    'category',
    'description',
    'address',
    'followers',
    'followingCount',
    'postsCount',
    'lastPostAt',
  ],
  linkedin: [
    'name',
    'description',
    'followers',
    'industry',
    'companySize',
    'headquarters',
    'foundedYear',
    'lastPostAt',
  ],
} as const;
function safeUrl(value: string | null | undefined) {
  try {
    const url = new URL(value ?? '');
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function PublicLink({
  value,
  label,
}: {
  value: string | null | undefined;
  label?: string;
}) {
  const href = safeUrl(value);
  return href ? (
    <a
      className="break-all text-accent"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {label ?? value}
    </a>
  ) : (
    <span>—</span>
  );
}

export function CompanySocial({
  companyId,
  initial,
  contacts,
}: {
  companyId: string;
  initial: SocialData;
  contacts: { id: string; kind: string; value: string }[];
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const active = data.profiles.some(
    (row) => row.task && ['queued', 'running'].includes(row.task.status),
  );
  useEffect(() => setData(initial), [initial]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetch(`/api/companies/${companyId}/social`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw Error();
          const next = (await response.json()) as SocialData;
          setData(next);
          if (
            !next.profiles.some(
              (row) =>
                row.task && ['queued', 'running'].includes(row.task.status),
            )
          )
            router.refresh();
        })
        .catch(() => {
          if (!controller.signal.aborted) setMessage(uk.social.error);
        });
    }, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active, companyId, router]);
  const run = async () => {
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/api/companies/${companyId}/social`, {
        method: 'POST',
      });
      if (!response.ok) throw Error();
      const next = (await response.json()) as SocialData;
      setData(next);
      if (!next.profiles.length) setMessage(uk.social.empty);
    } catch {
      setMessage(uk.social.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <Button
        variant="outline"
        disabled={pending || active}
        onClick={() => void run()}
      >
        {pending || active ? uk.ai.pending : uk.social.update}
      </Button>
      {!data.profiles.length && (
        <p className="text-muted-foreground">{uk.social.empty}</p>
      )}
      {data.profiles.map((row) => (
        <section
          key={`${row.network}:${row.sourceUrl}`}
          className="min-w-0 space-y-2 border-t border-border pt-3"
        >
          <h3 className="font-semibold">
            <ChannelIcon channel={row.network} />{' '}
            {uk.social.networks[row.network]}
          </h3>
          <p>
            <PublicLink value={row.sourceUrl} />{' '}
            {contacts
              .filter((contact) => {
                const target =
                  contact.kind === 'social'
                    ? socialTarget(contact.value)
                    : null;
                return (
                  target?.network === row.network &&
                  target?.handle === row.target.handle
                );
              })
              .slice(0, 1)
              .map((contact) => (
                <Link
                  key={contact.id}
                  className="ml-2 text-accent"
                  href={`/inbox?contact=${contact.id}`}
                >
                  {uk.email.write}
                </Link>
              ))}
          </p>
          {row.task && (
            <p className="text-xs text-muted-foreground">
              <StatusBadge status={row.task.status}>
                {uk.tasks.status[
                  row.task.status as keyof typeof uk.tasks.status
                ] ?? '—'}
              </StatusBadge>
              {row.task.reasonUk && ` · ${row.task.reasonUk}`}
            </p>
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {fields[row.network].map((field) => (
              <div className="contents" key={field}>
                <dt className="text-muted-foreground">
                  {uk.social.fields[field]}
                </dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">
                  {field === 'lastPostAt' && row.profile?.lastPostAt ? (
                    safeUrl(
                      row.profile.posts.find(
                        (post) => post.date === row.profile?.lastPostAt,
                      )?.url,
                    ) ? (
                      <a
                        className="text-accent"
                        href={safeUrl(
                          row.profile.posts.find(
                            (post) => post.date === row.profile?.lastPostAt,
                          )?.url,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <LocalTime value={row.profile.lastPostAt} dateOnly />
                      </a>
                    ) : (
                      <LocalTime value={row.profile.lastPostAt} dateOnly />
                    )
                  ) : typeof row.profile?.[field] === 'number' &&
                    field !== 'foundedYear' ? (
                    new Intl.NumberFormat('uk-UA').format(
                      row.profile[field] as number,
                    )
                  ) : (
                    (row.profile?.[field] ?? '—')
                  )}
                </dd>
              </div>
            ))}
            <dt className="text-muted-foreground">
              {uk.social.fields.website}
            </dt>
            <dd>
              <PublicLink value={row.profile?.website} />
            </dd>
            {(['phones', 'emails'] as const).map((field) => (
              <div className="contents" key={field}>
                <dt className="text-muted-foreground">
                  {uk.social.fields[field]}
                </dt>
                <dd className="min-w-0 break-words">
                  {row.profile?.[field].join(', ') || '—'}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {uk.social.fields.method}:{' '}
            {row.profile
              ? uk.social.methods[row.profile.method ?? 'anonymous']
              : '—'}
          </p>
          {!!row.profile?.posts.length && (
            <details>
              <summary className="cursor-pointer text-accent">
                {uk.social.posts}
              </summary>
              <ul className="mt-1 space-y-1">
                {row.profile.posts.map((post) => (
                  <li key={post.url}>
                    <PublicLink
                      value={post.url}
                      label={
                        post.date
                          ? new Date(post.date).toLocaleDateString('uk-UA')
                          : uk.social.post
                      }
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-muted-foreground">
            {uk.company.source}:{' '}
            <PublicLink
              value={row.sourceUrl}
              label={uk.social.networks[row.network]}
            />{' '}
            · {uk.social.checked}:{' '}
            {row.foundAt ? <LocalTime value={row.foundAt} /> : '—'}
          </p>
        </section>
      ))}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
