'use client';
import { useEffect, useState } from 'react';

/**
 * Server components render in the server's time zone (UTC); this re-renders the
 * timestamp in the viewer's own zone after hydration.
 */
export function LocalTime({
  value,
  dateOnly = false,
  timeOnly = false,
}: {
  value: string | Date;
  dateOnly?: boolean;
  timeOnly?: boolean;
}) {
  const format = (utc = false) => {
    const timeZone = utc ? 'UTC' : undefined;
    const date = new Date(value);
    return timeOnly
      ? date.toLocaleTimeString('uk-UA', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone,
        })
      : dateOnly
        ? date.toLocaleDateString('uk-UA', { timeZone })
        : date.toLocaleString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
          });
  };
  const [text, setText] = useState(() => format(true));
  useEffect(() => setText(format()), [value, dateOnly, timeOnly]);
  return (
    <time dateTime={new Date(value).toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
