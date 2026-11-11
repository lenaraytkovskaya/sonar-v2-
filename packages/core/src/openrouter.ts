export class PaidHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

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
export function compareModelPrice(a: TextModel, b: TextModel) {
  return (
    a.promptUsd + a.completionUsd - b.promptUsd - b.completionUsd ||
    a.requestUsd - b.requestUsd ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
export class OpenRouterError extends Error {
  constructor(
    public code:
      | 'request_failed'
      | 'invalid_response'
      | 'usage_missing'
      | 'finish_reason'
      | 'empty_content'
      | 'api_key_missing'
      | 'network_unavailable',
    public billing?: { costUsd?: number; units: number },
    public finishReason?: 'length' | 'content_filter' | 'error' | 'tool_calls',
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
    if (!apiKey) throw new OpenRouterError('api_key_missing');
    const response = await fetcher(`https://openrouter.ai/api/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    }).catch(() => {
      throw new OpenRouterError('network_unavailable');
    });
    if (!response.ok) throw new PaidHttpError(response.status);
    const text = await response.text().catch(() => {
      throw new OpenRouterError('network_unavailable');
    });
    try {
      return record(JSON.parse(text));
    } catch {
      throw new OpenRouterError('invalid_response', { units: 0 });
    }
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
        .sort(compareModelPrice);
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
        reasoning: { exclude: true },
      });
      // Retain only validated billing numbers, never provider content or keys.
      const usage = response.usage as Record<string, unknown> | undefined;
      const billing: { costUsd?: number; units: number } = { units: 0 };
      try {
        if (usage?.cost != null) billing.costUsd = amount(usage.cost);
      } catch {
        /* Invalid cost falls back to the reservation. */
      }
      try {
        const units = amount(usage?.total_tokens);
        if (Number.isSafeInteger(units)) billing.units = units;
      } catch {
        /* Missing token counts do not invalidate a known cost. */
      }
      try {
        const choices = response.choices;
        const choice = record(Array.isArray(choices) ? choices[0] : null);
        if (
          ['length', 'content_filter', 'error', 'tool_calls'].includes(
            String(choice.finish_reason),
          )
        )
          throw new OpenRouterError(
            'finish_reason',
            billing,
            choice.finish_reason as OpenRouterError['finishReason'],
          );
        const text = record(choice.message).content;
        if (text == null || (typeof text === 'string' && !text.trim()))
          throw new OpenRouterError('empty_content');
        if (
          typeof response.id !== 'string' ||
          typeof text !== 'string' ||
          !text.trim()
        )
          throw new OpenRouterError('invalid_response');
        if (billing.costUsd === undefined)
          throw new OpenRouterError('usage_missing');
        const units = amount(usage?.total_tokens);
        if (!Number.isSafeInteger(units))
          throw new OpenRouterError('invalid_response');
        return {
          id: response.id,
          model: typeof response.model === 'string' ? response.model : model,
          text,
          costUsd: billing.costUsd,
          units,
        };
      } catch (error) {
        if (error instanceof OpenRouterError) error.billing = billing;
        throw error;
      }
    },
  };
}
