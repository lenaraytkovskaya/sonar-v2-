import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { Shell } from '@/components/shell';
export default async function CrmLayout({ children }: { children: ReactNode }) {
  const { user } = await getSession();
  if (!user?.id) redirect('/login');
  return <Shell name={user.name}>{children}</Shell>;
}
