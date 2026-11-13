import { describe, expect, it } from 'vitest';
import { statusTone } from './status-tone';
describe('status tones', () => {
  it.each([
    [
      'ok',
      [
        'success',
        'done',
        'sent',
        'active',
        'valid',
        'ready',
        'delivered',
        'read',
      ],
    ],
    [
      'err',
      ['errors', 'failed', 'refused', 'do_not_contact', 'DNC', 'invalid'],
    ],
    [
      'wait',
      [
        'paused',
        'queued',
        'awaiting',
        'awaiting_approval',
        'awaiting_manual',
        'handoff',
        'qr',
      ],
    ],
    ['run', ['running', 'scanning', 'enriching', 'starting']],
    [
      'idle',
      ['disabled', 'new', 'skipped', 'draft', 'disconnected', 'unknown'],
    ],
  ] as const)('maps %s without changing domain statuses', (tone, statuses) => {
    for (const status of statuses) expect(statusTone(status)).toBe(tone);
  });
});
