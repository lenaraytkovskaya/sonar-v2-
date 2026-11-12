'use client';
import { useEffect, useState } from 'react';

/**
 * Server components render in the server's time zone (UTC); this re-renders the
 * timestamp in the viewer's own zone after hydration.
 */
export function LocalTime({
  value,
  dateOnly = false,
}: {
  value: string | Date;
  dateOnly?: boolean;
}) {
  const format = () => {
    const date = new Date(value);
    return dateOnly
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
  useEffect(() => setText(format()), [value, dateOnly]);
  return (
    <time dateTime={new Date(value).toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
