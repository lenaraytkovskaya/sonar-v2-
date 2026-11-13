export type StatusTone = 'ok' | 'err' | 'wait' | 'run' | 'idle';
const groups: Record<StatusTone, readonly string[]> = {
  ok: [
    'ok',
    'success',
    'done',
    'sent',
    'active',
    'enabled',
    'valid',
    'ready',
    'replied',
    'interested',
    'deal',
    'delivered',
    'read',
    'received',
  ],
  err: [
    'err',
    'error',
    'errors',
    'failed',
    'refused',
    'do_not_contact',
    'dnc',
    'invalid',
    'expired',
  ],
  wait: [
    'wait',
    'paused',
    'queued',
    'awaiting',
    'awaiting_approval',
    'awaiting_manual',
    'handoff',
    'needs_human',
    'contacted',
    'qr',
    'needs_login',
    'pending',
  ],
  run: ['run', 'running', 'scanning', 'enriching', 'starting'],
  idle: [
    'idle',
    'disabled',
    'new',
    'skipped',
    'draft',
    'stopped',
    'disconnected',
  ],
};
export function statusTone(status: string): StatusTone {
  return (
    (Object.keys(groups) as StatusTone[]).find((tone) =>
      groups[tone].includes(status.toLowerCase()),
    ) ?? 'idle'
  );
}
