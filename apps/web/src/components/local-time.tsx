'use client';
import React from 'react';
import { useEffect, useState } from 'react';

export type LocalTimeFormat = {
  dateOnly?: boolean;
  timeOnly?: boolean;
  monthDay?: boolean;
};

export function formatLocalTime(
  value: string | Date,
  {
    dateOnly = false,
    timeOnly = false,
    monthDay = false,
  }: LocalTimeFormat = {},
  timeZone?: string,
) {
  const date = new Date(value);
  if (timeOnly)
    return date.toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });
  return monthDay
    ? date.toLocaleDateString('uk-UA', {
        day: 'numeric',
        month: 'long',
        ...(timeZone ? { timeZone } : {}),
      })
    : dateOnly
      ? date.toLocaleDateString('uk-UA', timeZone ? { timeZone } : {})
      : date.toLocaleString('uk-UA', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          ...(timeZone ? { timeZone } : {}),
        });
}

/**
 * Keep server and hydration markup identical; show the browser-local time once
 * the viewer's time zone is available.
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
  const [text, setText] = useState('');
  useEffect(
    () => setText(formatLocalTime(value, { dateOnly, timeOnly, monthDay })),
    [value, dateOnly, timeOnly, monthDay],
  );
  return (
    <time dateTime={new Date(value).toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
