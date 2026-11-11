import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession, getSessionUser } from '@/lib/auth';
import { Shell } from '@/components/shell';
export default async function CrmLayout({ children }: { children: ReactNode }) {
  const { user } = await getSession();
  if (!user?.id) redirect('/login');
  const currentUser = await getSessionUser(user.id);
  if (!currentUser) redirect('/session/expired');
  return <Shell name={currentUser.name}>{children}</Shell>;
}
