import { uk } from '@/i18n/uk';
export const contactLabel = (value: string) => {
  const telegramId = /^telegram:user:(\d+)(?::-?\d+)?$/.exec(value)?.[1];
  const whatsappId = /^whatsapp:lid:(\d+)$/.exec(value)?.[1];
  return telegramId
    ? `${uk.inbound.telegramUser} ${telegramId}`
    : whatsappId
      ? `${uk.inbound.whatsappUser} ${whatsappId}`
      : value;
};
export function socialNetwork(value: string) {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const host = url.hostname.replace(/^(?:www|m|mbasic)\./, '');
    const networks: Record<string, keyof typeof uk.social.networks> = {
      'instagram.com': 'instagram',
      'facebook.com': 'facebook',
      'fb.com': 'facebook',
      'fb.me': 'facebook',
      'linkedin.com': 'linkedin',
    };
    return Object.hasOwn(networks, host) ? networks[host]! : null;
  } catch {
    return null;
  }
}
export const channelLabel = (channel: string, value = '') => {
  const network = channel === 'social' ? socialNetwork(value) : null;
  return network
    ? uk.social.networks[network]
    : ({
        email: uk.email.title,
        form: uk.forms.title,
        telegram: uk.telegram.title,
        whatsapp: uk.whatsapp.title,
        social: uk.outreach.social,
        call: uk.outreach.call,
        phone: uk.outreach.call,
      }[channel] ?? channel);
};
type DeliveryContext = {
  channel: string;
  toValue: string;
  reasonUk?: string | null;
  providerId?: string | null;
};
export const facebookDispatched = (status: string, message?: DeliveryContext) =>
  status === 'sent' &&
  message?.channel === 'social' &&
  socialNetwork(message.toValue) === 'facebook' &&
  message.reasonUk === uk.outreach.facebookDispatched;
export const facebookHistoryLink = (
  status: string,
  message: DeliveryContext,
) => {
  if (!facebookDispatched(status, message) || !message.providerId) return null;
  try {
    const url = new URL(message.providerId);
    return url.protocol === 'https:' && socialNetwork(url.href) === 'facebook'
      ? url.href
      : null;
  } catch {
    return null;
  }
};
export const messageStatus = (status: string, message?: DeliveryContext) =>
  facebookDispatched(status, message)
    ? uk.outreach.facebookDispatched
    : (uk.email.statuses[status as keyof typeof uk.email.statuses] ??
      (status === 'skipped'
        ? uk.outreach.skipped
        : status === 'received'
          ? uk.inbound.received
          : status));
