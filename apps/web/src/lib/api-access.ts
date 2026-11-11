import { getSession } from './auth';
import { isAllowedRequestOrigin } from './request-origin';
export async function apiUser(request: Request, mutation = false) {
  const user = (await getSession()).user;
  if (!user) return null;
  if (mutation && !isAllowedRequestOrigin(request.headers, process.env.APP_URL))
    return null;
  return user;
}
export const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
