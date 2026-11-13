import { socialTarget } from '@sonar/core';
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
export const socialNetwork = (value: string) =>
  socialTarget(value)?.network ?? null;
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
