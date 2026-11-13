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
export const messageStatus = (status: string) =>
  uk.email.statuses[status as keyof typeof uk.email.statuses] ??
  (status === 'skipped'
    ? uk.outreach.skipped
    : status === 'received'
      ? uk.inbound.received
      : status);
