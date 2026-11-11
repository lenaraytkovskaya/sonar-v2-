import { expect, it, vi } from 'vitest';
import { PaidHttpError } from '@sonar/core';
import { solveTwoCaptcha } from './captcha.js';

it.each(['recaptcha', 'hcaptcha', 'turnstile'] as const)(
  'submits %s once, polls and records the provider price',
  async (kind) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errorId: 0, taskId: 123 }))
      .mockResolvedValueOnce(
        Response.json({ errorId: 0, status: 'processing' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          errorId: 0,
          status: 'ready',
          cost: '0.00299',
          solution: { token: 'stub-token' },
        }),
      );
    const result = await solveTwoCaptcha(
      { kind, siteKey: 'site-key', url: 'https://example.invalid/form' },
      'stub-secret',
      { pollMs: 5000, timeoutMs: 120000 },
      transport,
      async () => {},
    );
    expect(result).toMatchObject({
      text: 'stub-token',
      costUsd: 0.00299,
      units: 1,
    });
    expect(
      transport.mock.calls.map(([url]) => String(url).split('/').pop()),
    ).toEqual(['createTask', 'getTaskResult', 'getTaskResult']);
    expect(
      JSON.parse(String(transport.mock.calls[0]![1]!.body)).task.websiteKey,
    ).toBe('site-key');
  },
);
it('only treats explicit create rejection as an uncharged failure', async () => {
  const run = (transport: typeof fetch) =>
    solveTwoCaptcha(
      { kind: 'recaptcha', siteKey: 'key', url: 'https://example.invalid' },
      'stub',
      { pollMs: 5000, timeoutMs: 120000 },
      transport,
      async () => {},
    );
  await expect(
    run(vi.fn().mockResolvedValue(Response.json({ errorId: 1 }))),
  ).rejects.toBeInstanceOf(PaidHttpError);
  await expect(
    run(vi.fn().mockRejectedValue(Error('network'))),
  ).rejects.not.toBeInstanceOf(PaidHttpError);
});
