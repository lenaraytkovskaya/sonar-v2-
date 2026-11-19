function minutesInZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function isSocialQuietHours(
  date: Date,
  range = '00:00-07:00',
  timeZone = 'Europe/Kyiv',
) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range);
  if (!match) throw new Error('Invalid social.inbox.quiet_hours');
  const [, startHour, startMinute, endHour, endMinute] = match;
  const start = Number(startHour) * 60 + Number(startMinute);
  const end = Number(endHour) * 60 + Number(endMinute);
  if (
    Number(startHour) > 23 ||
    Number(endHour) > 23 ||
    Number(startMinute) > 59 ||
    Number(endMinute) > 59 ||
    start === end
  )
    throw new Error('Invalid social.inbox.quiet_hours');
  const current = minutesInZone(date, timeZone);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function nextSocialInboxPollAt(
  now: Date,
  intervalSeconds: number,
  quietHours = '00:00-07:00',
  random = Math.random,
  timeZone = 'Europe/Kyiv',
) {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1)
    throw new Error('Invalid social.inbox.poll_seconds');
  const interval = isSocialQuietHours(now, quietHours, timeZone)
    ? 3600
    : intervalSeconds;
  const jitter = Math.round(interval * 0.3 * (random() * 2 - 1));
  return new Date(now.getTime() + Math.max(1, interval + jitter) * 1000);
}
