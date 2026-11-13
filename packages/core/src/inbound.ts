import { load } from 'cheerio';
export const inboundCategories = [
  'interest',
  'question',
  'price',
  'contract',
  'complaint',
  'refusal',
  'autoreply',
] as const;
export type InboundCategory = (typeof inboundCategories)[number];
export function parseInboundCategory(text: string): InboundCategory {
  const value: unknown = JSON.parse(
    text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
  );
  const category =
    value && typeof value === 'object' && 'category' in value
      ? value.category
      : null;
  if (!inboundCategories.includes(category as InboundCategory))
    throw new Error('Invalid inbound classification');
  return category as InboundCategory;
}
export function parseReplyDraft(text: string): {
  subject?: string;
  body: string;
} {
  const value: unknown = JSON.parse(
    text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
  );
  if (
    !value ||
    typeof value !== 'object' ||
    !('body' in value) ||
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    value.body.length > 100000
  )
    throw new Error('Invalid reply draft');
  if (
    'subject' in value &&
    (typeof value.subject !== 'string' ||
      value.subject.length > 998 ||
      /[\r\n]/.test(value.subject))
  )
    throw new Error('Invalid reply subject');
  return {
    body: value.body.trim(),
    ...('subject' in value ? { subject: String(value.subject).trim() } : {}),
  };
}
export function receivedEmailContent(data: Record<string, unknown>) {
  if (
    typeof data.from !== 'string' ||
    !Array.isArray(data.to) ||
    !data.to.every((item) => typeof item === 'string')
  )
    throw new Error('Invalid received email');
  const headers = Object.fromEntries(
    Object.entries(
      data.headers && typeof data.headers === 'object' ? data.headers : {},
    ).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  const $ = load(typeof data.html === 'string' ? data.html : '');
  $('script,style,head').remove();
  $('br').replaceWith('\n');
  $('p,div,tr').append('\n');
  return {
    sender: data.from.match(/<([^<>]+)>/)?.[1] ?? data.from,
    recipients: (data.to as string[]).map((value) =>
      (value.match(/<([^<>]+)>/)?.[1] ?? value).trim(),
    ),
    externalMessageId:
      typeof data.message_id === 'string'
        ? data.message_id
        : headers['message-id'],
    body:
      typeof data.text === 'string' && data.text.trim()
        ? data.text
        : $.root().text().trim(),
    subject: typeof data.subject === 'string' ? data.subject : '',
    inReplyTo: headers['in-reply-to'],
    references: headers.references?.match(/<[^<>]+>/g) ?? [],
  };
}
