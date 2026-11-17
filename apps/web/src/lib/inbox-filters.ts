import { uk } from '../i18n/uk';
const validId = (id?: string) =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
export const inboxChannels = [
  'email',
  'telegram',
  'whatsapp',
  'social',
  'call',
];
export const inboxStatuses = [...Object.keys(uk.email.statuses), 'skipped'];
export function inboxFilters(query: Record<string, string | undefined>) {
  return {
    campaignId: validId(query.campaignId) ? query.campaignId : undefined,
    channel: inboxChannels.includes(query.channel ?? '')
      ? query.channel
      : undefined,
    status: inboxStatuses.includes(query.status ?? '')
      ? query.status
      : undefined,
    needsHuman: query.needsHuman === '1' ? true : undefined,
    unread: query.unread === '1' ? true : undefined,
  };
}
