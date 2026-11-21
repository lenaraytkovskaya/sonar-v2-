import { uk } from '@/i18n/uk';
import { Logo, ThemeSelect } from '@/components/shell';
import { Card } from '@/components/ui/card';
import { InviteForm } from './form';

export const dynamic = 'force-dynamic';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { getOpenInvite } = await import('@sonar/db/user-invites');
  const result = /^[A-Za-z0-9_-]{20,100}$/.test(token)
    ? await getOpenInvite(token).catch(() => ({ error: 'invalid' as const }))
    : { error: 'invalid' as const };
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-5">
      <Logo />
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <h1 className="font-heading text-2xl font-bold">{uk.invite.title}</h1>
        {'invite' in result && result.invite ? (
          <>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {uk.invite.description} {result.invite.email}
            </p>
            <InviteForm token={token} />
          </>
        ) : (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-err-bg p-3 text-sm text-err"
          >
            {uk.invite[result.error ?? 'invalid']}
          </p>
        )}
      </Card>
      <ThemeSelect />
    </main>
  );
}
