/** Claim an event before displaying it; a blocked store falls back to this page's memory. */
export function claimSocialSessionEvent(
  key: string,
  eventId: string,
  seen: Set<string>,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
) {
  const event = `${key}:${eventId}`;
  if (seen.has(event)) return false;
  seen.add(event);
  try {
    const target = storage ?? localStorage;
    if (target.getItem(key) === eventId) return false;
    target.setItem(key, eventId);
  } catch {
    /* In-memory deduplication remains available. */
  }
  return true;
}
