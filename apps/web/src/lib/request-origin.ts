export function isAllowedRequestOrigin(headers: Headers, appUrl?: string) {
  const origin = headers.get('origin');
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      return false;
    const host = headers.get('x-forwarded-host') ?? headers.get('host');
    if (url.host === host) return true;
    return !!appUrl && url.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
