import { NextResponse } from 'next/server';
import { getSession, getSessionUser } from '@/lib/auth';
export async function GET() {
  const session = await getSession();
  if (await getSessionUser(session.user?.id))
    return new NextResponse(null, { status: 303, headers: { Location: '/' } });
  session.destroy();
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/login' },
  });
}
