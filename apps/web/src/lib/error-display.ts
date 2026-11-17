import { uk } from '../i18n/uk';

export function presentError(reason: string) {
  if (/\[messagebutton\/unconfirmed\]/i.test(reason))
    return { message: uk.errors.instagramChatUnavailable, details: reason };
  if (/\[composer\/timeout\]/i.test(reason))
    return { message: uk.errors.messageFieldMissing, details: reason };
  if (/analysis\.max_tokens/i.test(reason))
    return {
      message: uk.errors.analysisTokenLimit,
      details: reason,
    };
  return { message: reason.replace(/ІІ/g, 'ШІ'), details: undefined };
}
