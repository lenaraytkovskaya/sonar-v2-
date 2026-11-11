import { afterEach, expect, it, vi } from 'vitest';
import { runAiJob } from './ai-job';
import { uk } from '../i18n/uk';

afterEach(() => vi.unstubAllGlobals());
it.each(Object.entries(uk.ai.modelErrors))(
  'translates queued model refresh error %s',
  async (code, message) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: 'stub-task' }))
        .mockResolvedValueOnce(
          Response.json({
            status: 'failed',
            reason_code: code,
            reason_uk: 'fallback',
          }),
        ),
    );
    await expect(runAiJob('/api/ai/models', {})).rejects.toThrow(message);
  },
);
it('preserves useful unknown task errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'stub-task' }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'failed',
          reason_code: 'other',
          reason_uk: 'Корисна причина',
        }),
      ),
  );
  await expect(runAiJob('/api/ai/models', {})).rejects.toThrow(
    'Корисна причина',
  );
});
it('translates browser network failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
  );
  await expect(runAiJob('/api/ai/models', {})).rejects.toThrow(
    uk.ai.modelErrors.network_unavailable,
  );
});
