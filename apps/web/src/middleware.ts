import { NextResponse, type NextRequest } from 'next/server';
import { unsealData } from 'iron-session';
import { uk } from '@/i18n/uk';
import { sessionOptions, type SessionData } from '@/lib/session';
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    path === '/login' ||
    path === '/api/health' ||
    path.startsWith('/api/webhooks/')
  )
    return NextResponse.next();
  const options = sessionOptions();
  const session = await unsealData<SessionData>(
    request.cookies.get(options.cookieName)?.value ?? '',
    { password: options.password, ttl: options.ttl },
  );
  if (session.user?.id) return NextResponse.next();
  if (path.startsWith('/api/'))
    return NextResponse.json({ error: uk.unauthorized }, { status: 401 });
  const login = new URL('/login', request.url);
  login.searchParams.set('next', path + request.nextUrl.search);
  return NextResponse.redirect(login);
}
export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
