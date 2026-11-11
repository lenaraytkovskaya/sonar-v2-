export type BudgetUsage = {
  monthlyLimitUsd: number;
  monthlySpentUsd: number;
  serviceLimitUsd: number | null;
  serviceSpentUsd: number;
};
export class BudgetExceeded extends Error {
  constructor(public scope: 'monthly' | 'service') {
    super(
      scope === 'monthly'
        ? 'Вичерпано місячний бюджет. Збільште ліміт у налаштуваннях.'
        : 'Вичерпано бюджет сервісу. Збільште його ліміт.',
    );
  }
}
// Integer fractional dollars avoid 0.1 + 0.2 boundary errors.
export function moneyUnits(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1e9)
    throw new Error('Invalid monetary amount');
  const [whole, fraction = ''] = value.toFixed(10).split('.');
  return BigInt(whole!) * 10_000_000_000n + BigInt(fraction);
}
export function checkBudget(usage: BudgetUsage, estimateUsd: number) {
  const estimate = moneyUnits(estimateUsd);
  const monthly = moneyUnits(usage.monthlyLimitUsd);
  if (monthly === 0n || moneyUnits(usage.monthlySpentUsd) + estimate > monthly)
    throw new BudgetExceeded('monthly');
  const spent = moneyUnits(usage.serviceSpentUsd);
  if (usage.serviceLimitUsd !== null) {
    const limit = moneyUnits(usage.serviceLimitUsd);
    if (limit === 0n || spent + estimate > limit)
      throw new BudgetExceeded('service');
  }
}
