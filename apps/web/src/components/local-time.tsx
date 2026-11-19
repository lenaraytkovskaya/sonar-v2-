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
  monthDay = false,
}: {
  value: string | Date;
  dateOnly?: boolean;
  timeOnly?: boolean;
  monthDay?: boolean;
}) {
  const format = () => {
    const date = new Date(value);
    if (timeOnly)
      return date.toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
      });
    return monthDay
      ? date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })
      : dateOnly
        ? date.toLocaleDateString('uk-UA')
        : date.toLocaleString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
  };
  const [text, setText] = useState(format);
  useEffect(() => setText(format()), [value, dateOnly, timeOnly, monthDay]);
  return (
    <time dateTime={new Date(value).toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
