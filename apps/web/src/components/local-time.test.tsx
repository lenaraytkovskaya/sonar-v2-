import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { formatLocalTime, LocalTime } from './local-time.js';

it('formats UTC instants in the selected browser time zone', () => {
  const value = '2026-11-19T19:09:33.000Z';
  expect(formatLocalTime(value, { timeOnly: true }, 'Europe/Kyiv')).toBe(
    '21:09',
  );
  expect(formatLocalTime(value, { timeOnly: true }, 'UTC')).toBe('19:09');
});

it('renders no server-zone timestamp before the browser time zone is known', () => {
  const markup = renderToStaticMarkup(
    <LocalTime value="2026-11-19T19:09:33.000Z" timeOnly />,
  );
  expect(markup).toBe('<time dateTime="2026-11-19T19:09:33.000Z"></time>');
});
