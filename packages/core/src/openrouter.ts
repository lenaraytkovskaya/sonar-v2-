// Contract: https://openrouter.ai/docs/cookbook/administration/usage-accounting
export type PaidResponse = {
  id: string;
  model: string;
  text: string;
  costUsd: number;
  units: number;
  costBasis?: 'provider_reported' | 'estimated_tariff';
};
export type TextModel = {
  id: string;
  name: string;
  promptUsd: number;
  completionUsd: number;
  requestUsd: number;
};
export class OpenRouterError extends Error {
  constructor(
    public code: 'request_failed' | 'invalid_response' | 'usage_missing',
  ) {
    super(code);
  }
}
function amount(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
    throw new OpenRouterError('invalid_response');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new OpenRouterError('invalid_response');
  return number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OpenRouterError('invalid_response');
  return value as Record<string, unknown>;
}
export function createOpenRouterClient(
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  async function request(path: string, body?: object) {
    if (!apiKey) throw new OpenRouterError('request_failed');
    const response = await fetcher(`https://openrouter.ai/api/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new OpenRouterError('request_failed');
    return record(await response.json());
  }
  return {
    async models(): Promise<TextModel[]> {
      const response = await request(
        'models?output_modalities=text&endpoints=/api/v1/chat/completions',
      );
      if (!Array.isArray(response.data))
        throw new OpenRouterError('invalid_response');
      return response.data
        .flatMap((entry: unknown): TextModel[] => {
          try {
            const model = record(entry),
              architecture = record(model.architecture),
              pricing = record(model.pricing);
            if (
              typeof model.id !== 'string' ||
              !Array.isArray(architecture.output_modalities) ||
              !architecture.output_modalities.includes('text')
            )
              return [];
            return [
              {
                id: model.id,
                name: typeof model.name === 'string' ? model.name : model.id,
                promptUsd: amount(pricing.prompt),
                completionUsd: amount(pricing.completion),
                requestUsd: amount(pricing.request ?? 0),
              },
            ];
          } catch {
            return [];
          }
        })
        .sort(
          (a, b) =>
            a.promptUsd + a.completionUsd - b.promptUsd - b.completionUsd ||
            a.requestUsd - b.requestUsd,
        );
    },
    async complete(
      model: string,
      messages: { role: 'system' | 'user'; content: string }[],
      maxTokens: number,
    ): Promise<PaidResponse> {
      if (!model || !Number.isInteger(maxTokens) || maxTokens < 1)
        throw new OpenRouterError('invalid_response');
      const response = await request('chat/completions', {
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
      });
      const choices = response.choices;
      const text = record(
        record(Array.isArray(choices) ? choices[0] : null).message,
      ).content;
      if (
        typeof response.id !== 'string' ||
        typeof text !== 'string' ||
        !text.trim()
      )
        throw new OpenRouterError('invalid_response');
      const usage = record(response.usage);
      if (usage.cost === undefined || usage.cost === null)
        throw new OpenRouterError('usage_missing');
      const units = amount(usage.total_tokens);
      if (!Number.isSafeInteger(units))
        throw new OpenRouterError('invalid_response');
      return {
        id: response.id,
        model: typeof response.model === 'string' ? response.model : model,
        text,
        costUsd: amount(usage.cost),
        units,
      };
    },
  };
}
