import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emailHistoryLines, splitEmailHistory } from './email-display';
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@/lib/email-display', () => import('./email-display'));
import { MessageBody } from '../components/message-body';

const gmail = 'вс, 15 нояб. 2026 г. в 02:14, Тест <sender@example.com>:';
const reply = 'Проверка входящей почты 2\n\n';
const history = `${gmail}\n\n> ручной ответ\n>\n> вс, ...\n>> ручной тест 1`;
const outlook = [
  '-----Original Message-----',
  'From: Test <sender@example.com>',
  'Sent: Sunday, November 15, 2026 02:14',
  'To: Receiver <receiver@example.com>',
  'Subject: Test',
  '',
  'Previous answer',
].join('\n');

describe('email display history', () => {
  it('splits the supplied Gmail pattern without losing any original text', () => {
    expect(splitEmailHistory(reply + history, 'email')).toEqual({
      current: reply,
      history,
    });
  });

  it.each([
    'On Sun, Nov 15, 2026 at 02:14 Test <sender@example.com> wrote:',
    'On Sun, Nov 15, 2026 at 02:14\nTest <sender@example.com> wrote:',
    '15 листопада 2026 р. Тест <sender@example.com> пише:',
  ])('recognizes a safely quoted attribution: %s', (header) => {
    const body = `${reply}${header}\n\n> Old\n>> Older`;
    const parsed = splitEmailHistory(body, 'email');
    expect(parsed.current).toBe(reply);
    expect(parsed.current + parsed.history).toBe(body);
  });

  it.each([outlook, outlook.replace('-----Original Message-----\n', '')])(
    'recognizes complete Outlook headers',
    (history) => {
      expect(splitEmailHistory(reply + history, 'email')).toEqual({
        current: reply,
        history,
      });
    },
  );

  it.each([
    `${gmail}\n\n> Question 1\nNew inline answer\n> Question 2`,
    `${gmail}\n\n> Question\n\nNew answer below`,
    `${gmail}\n\nUnquoted ambiguous text`,
    `${outlook}\n> Quoted question\nInline answer`,
    'From: sender@example.com\nSubject: Incomplete\nOld body',
    'On occasion I wrote:\n\n> A Markdown quotation',
    `${gmail}\n\n> No current answer`,
    '',
    'Абзац один 👋\n\nАбзац два\nhttps://example.com/довгий-шлях?q=1&x=2',
    'Markdown:\n\n> A genuine quotation\n>> A nested quotation',
  ])('keeps ambiguous, inline, empty and plain content visible', (body) => {
    expect(splitEmailHistory(body, 'email')).toEqual({
      current: body,
      history: '',
    });
  });

  it('preserves paragraphs, Unicode, URLs and CRLF byte for byte', () => {
    const current =
      'Відповідь 👋\r\n\r\nДругий абзац https://example.com/шлях\r\n\r\n';
    const body = current + history.replaceAll('\n', '\r\n');
    const parsed = splitEmailHistory(body, 'email');
    expect(parsed.current).toBe(current);
    expect(parsed.current + parsed.history).toBe(body);
  });

  it('formats only quote prefixes, leaving nested content and HTML-like text intact', () => {
    expect(
      emailHistoryLines(
        'Header\n> Old\n>\n> > <img src=x onerror=alert(1)>\n>> https://example.com',
      ),
    ).toEqual([
      { depth: 0, text: 'Header' },
      { depth: 1, text: 'Old' },
      { depth: 1, text: '' },
      { depth: 2, text: '<img src=x onerror=alert(1)>' },
      { depth: 2, text: 'https://example.com' },
    ]);
  });

  it.each(['telegram', 'whatsapp', 'social', 'form', 'call'])(
    'leaves %s unchanged',
    (channel) => {
      const body = reply + history;
      expect(splitEmailHistory(body, channel)).toEqual({
        current: body,
        history: '',
      });
    },
  );

  it('renders malicious HTML as escaped text, including history and the exact original', () => {
    // The application uses Next's automatic JSX runtime; Vitest uses classic JSX.
    vi.stubGlobal('React', React);
    try {
      const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      const body = `${payload}\n\n${gmail}\n\n> ${payload}`;
      const html = renderToStaticMarkup(
        React.createElement(MessageBody, { body, channel: 'email' }),
      );
      expect(html).not.toMatch(/<img|<script|dangerouslySetInnerHTML/);
      expect(html).toContain('&lt;img');
      expect(html).toContain('&gt; &lt;img');
      expect(html).toContain('<details');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
