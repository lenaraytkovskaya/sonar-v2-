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
  });
  it('never guesses missing actual cost', async () => {
    await expect(
      createOpenRouterClient(
        'test',
        stub({ ...reply, usage: { total_tokens: 123 } }),
      ).complete('model', [], 100),
    ).rejects.toMatchObject({ code: 'usage_missing' });
  });
  it.each([-1, 'nope', null])('rejects invalid cost %s', async (cost) => {
    await expect(
      createOpenRouterClient(
        'test',
        stub({ ...reply, usage: { ...reply.usage, cost } }),
      ).complete('model', [], 100),
    ).rejects.toThrow();
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
