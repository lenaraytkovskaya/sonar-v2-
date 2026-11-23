import { expect, it } from 'vitest';
import { createDesktopQueue } from './desktop-queue.js';

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

it('runs a send before queued scans and drops scans whose client left', async () => {
  const queue = createDesktopQueue();
  const order: string[] = [];
  const first = gate();
  const running = queue(async () => {
    await first.promise;
    order.push('scan-1');
  });
  const abandoned = queue(async () => void order.push('scan-abandoned'), {
    cancelled: () => true,
  });
  const scan = queue(async () => void order.push('scan-2'));
  const send = queue(async () => void order.push('send'), { priority: true });
  first.open();
  await running;
  await expect(abandoned).rejects.toThrow('request_cancelled');
  await Promise.all([scan, send]);
  expect(order).toEqual(['scan-1', 'send', 'scan-2']);
});

it('keeps working after an operation fails', async () => {
  const queue = createDesktopQueue();
  await expect(
    queue(async () => Promise.reject(Error('boom'))),
  ).rejects.toThrow('boom');
  expect(await queue(async () => 'ok')).toBe('ok');
});
