import { describe, expect, it } from 'vitest';
import { statusTone } from './status-tone';
describe('status tones', () => {
  it.each([
    [
      'ok',
      [
        'success',
        'done',
        'ready',
        'OPERATIONAL',
        'sent',
        'active',
        'valid',
        'delivered',
        'read',
      ],
    ],
    [
      'err',
      [
        'errors',
        'failed',
        'closed',
        'CLOSED_TEMPORARILY',
        'closed_permanently',
        'refused',
        'do_not_contact',
        'DNC',
        'invalid',
      ],
    ],
    [
      'wait',
      [
        'paused',
        'waiting',
        'skipped',
        'pending',
        'awaiting',
        'awaiting_approval',
        'awaiting_manual',
        'handoff',
        'qr',
      ],
    ],
    ['run', ['running', 'queued', 'scanning', 'enriching', 'starting']],
    ['idle', ['disabled', 'new', 'draft', 'disconnected', 'unknown']],
  ] as const)('maps %s without changing domain statuses', (tone, statuses) => {
    for (const status of statuses) expect(statusTone(status)).toBe(tone);
  });
});
