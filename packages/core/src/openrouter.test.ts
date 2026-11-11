import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterClient } from './openrouter.js';
const reply = {
  id: 'generation-1',
  model: 'chosen/model',
  choices: [{ message: { content: 'Текст' } }],
  usage: { cost: 0.0042, total_tokens: 123 },
};
const stub = (body: unknown, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
describe('OpenRouter adapter', () => {
  it('takes actual cost from usage and uses the chosen model', async () => {
    const fetcher = stub(reply);
    const client = createOpenRouterClient('test-token', fetcher);
    expect(
      await client.complete(
        'chosen/model',
        [{ role: 'user', content: 'Покращити' }],
        100,
      ),
    ).toEqual({
      id: 'generation-1',
      model: 'chosen/model',
      text: 'Текст',
      costUsd: 0.0042,
      units: 123,
    });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('chosen/model');
    expect(body.max_tokens).toBe(100);
    expect(body.reasoning).toEqual({ exclude: true });
    expect(body).not.toHaveProperty('usage');
  });
  it('reports missing cost with received-response billing evidence', async () => {
    await expect(
      createOpenRouterClient(
        'test',
        stub({ ...reply, usage: { total_tokens: 123 } }),
      ).complete('model', [], 100),
    ).rejects.toMatchObject({ code: 'usage_missing', billing: { units: 123 } });
  });
  it.each([-1, 'nope', null])('rejects invalid cost %s', async (cost) => {
    await expect(
      createOpenRouterClient(
        'test',
        stub({ ...reply, usage: { ...reply.usage, cost } }),
      ).complete('model', [], 100),
    ).rejects.toThrow();
  });
  it.each([
    [
      { finish_reason: 'length', message: { content: '{"partial":' } },
      'finish_reason',
    ],
    [
      { message: { content: '', reasoning: 'private reasoning' } },
      'empty_content',
    ],
    [{ message: { content: null }, finish_reason: 'stop' }, 'empty_content'],
  ])(
    'classifies unsuccessful HTTP 200 without retaining content',
    async (choice, code) => {
      const error = await createOpenRouterClient(
        'test',
        stub({ ...reply, choices: [choice] }),
      )
        .complete('model', [], 100)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code,
        billing: { costUsd: 0.0042, units: 123 },
      });
      expect(JSON.stringify(error)).not.toContain('private reasoning');
      expect(JSON.stringify(error)).not.toContain('partial');
    },
  );
  it('settles malformed JSON but preserves network uncertainty', async () => {
    await expect(
      createOpenRouterClient(
        'test',
        vi.fn().mockResolvedValue(new Response('{broken')),
      ).complete('model', [], 100),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      billing: { units: 0 },
    });
    await expect(
      createOpenRouterClient(
        'test',
        vi.fn().mockRejectedValue(new DOMException('secret', 'TimeoutError')),
      ).complete('model', [], 100),
    ).rejects.toMatchObject({
      code: 'network_unavailable',
      billing: undefined,
    });
  });
  it('rejects provider errors without exposing the response body', async () => {
    await expect(
      createOpenRouterClient(
        'test',
        stub({ error: 'private provider details' }, 429),
      ).complete('model', [], 100),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('does not call the network without a key', async () => {
    const fetcher = stub(reply);
    await expect(
      createOpenRouterClient('', fetcher).complete('model', [], 100),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports a missing models key without making a request', async () => {
    const fetcher = stub({ data: [] });
    await expect(
      createOpenRouterClient('', fetcher).models(),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 429, 503])(
    'keeps the models HTTP %s status without response secrets',
    async (status) => {
      await expect(
        createOpenRouterClient(
          'stub',
          stub({ error: 'secret' }, status),
        ).models(),
      ).rejects.toMatchObject({ status, message: `HTTP ${status}` });
    },
  );
  it('reports unavailable models on network failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('private details'));
    await expect(
      createOpenRouterClient('stub', fetcher).models(),
    ).rejects.toMatchObject({
      code: 'network_unavailable',
      message: 'network_unavailable',
    });
  });
  it('sorts text models by valid prompt/completion/request price', async () => {
    const model = (id: string, prompt: string, outputs = ['text']) => ({
      id,
      name: id,
      architecture: { output_modalities: outputs },
      pricing: { prompt, completion: '0', request: '0' },
    });
    const fetcher = stub({
      data: [
        model('expensive', '0.1'),
        model('image', '0', ['image']),
        model('bad', 'invalid'),
        model('cheap', '0.001'),
      ],
    });
    expect(
      (await createOpenRouterClient('test', fetcher).models()).map((m) => m.id),
    ).toEqual(['cheap', 'expensive']);
  });
});
