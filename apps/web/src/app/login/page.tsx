import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { safeReturnTo } from '@/lib/session';
import { uk } from '@/i18n/uk';
import { Logo, ThemeSelect } from '@/components/shell';
import { Card } from '@/components/ui/card';
import { LoginForm } from './form';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const returnTo = safeReturnTo((await searchParams).next);
  if ((await getSession()).user?.id) redirect(returnTo);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-5">
      <Logo />
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <h1 className="font-heading text-2xl font-bold">{uk.login.title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {uk.login.description}
        </p>
        <LoginForm returnTo={returnTo} />
      </Card>
      <ThemeSelect />
    </main>
  );
}
