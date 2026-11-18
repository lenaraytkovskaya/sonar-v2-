export type StatusTone = 'ok' | 'err' | 'wait' | 'run' | 'idle';
const groups: Record<StatusTone, readonly string[]> = {
  ok: [
    'ok',
    'success',
    'done',
    'ready',
    'operational',
    'sent',
    'active',
    'enabled',
    'valid',
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
    'closed',
    'closed_temporarily',
    'closed_permanently',
    'do_not_contact',
    'dnc',
    'invalid',
    'expired',
  ],
  wait: [
    'wait',
    'paused',
    'awaiting',
    'awaiting_approval',
    'awaiting_manual',
    'handoff',
    'needs_human',
    'contacted',
    'qr',
    'needs_login',
    'pending',
    'waiting',
    'skipped',
  ],
  run: ['run', 'running', 'queued', 'scanning', 'enriching', 'starting'],
  idle: ['idle', 'disabled', 'new', 'draft', 'stopped', 'disconnected'],
};
export function statusTone(status: string): StatusTone {
  return (
    (Object.keys(groups) as StatusTone[]).find((tone) =>
      groups[tone].includes(status.toLowerCase()),
    ) ?? 'idle'
  );
}
