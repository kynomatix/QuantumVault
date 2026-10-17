/** Display-only maker fee assumptions; never execution fee authority. */
export const PACIFICA_FEE_SOURCE = 'https://docs.pacifica.fi/trading-on-pacifica/trading-fees';
// Published Tier 1 maker fee, verified 2026-10-17. Decimal rate, not percent.
export const PACIFICA_BASE_MAKER_RATE = '0.00015';
export type PlannerFee = { rate: string; tier: string | null; source: 'account' | 'published' } | null;
export function plannerFeeDefault(account: { makerFeeRate?: unknown; feeTier?: unknown; exists?: boolean } | null,
  publishedRate: unknown = PACIFICA_BASE_MAKER_RATE): PlannerFee {
  const valid = (rate: unknown): rate is string => typeof rate === 'string' && /^(0|[1-9]\d*)(\.\d{1,18})?$/.test(rate)
    && rate.length <= 30 && Number(rate) < 1;
  if (account?.exists !== false && valid(account?.makerFeeRate)) return { rate: account.makerFeeRate,
    tier: typeof account.feeTier === 'string' && /^(?:\d+|VIP ?\d+)$/i.test(account.feeTier) ? account.feeTier : null, source: 'account' };
  return valid(publishedRate) ? { rate: publishedRate, tier: '1', source: 'published' } : null;
}
