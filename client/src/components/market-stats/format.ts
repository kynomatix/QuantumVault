import type { StatsCard } from '@shared/market-stats';

export const utcTime = (value: number) => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}).format(value) + ' UTC';
export const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
export const signedPercent = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
export function currentCard<T>(card: StatsCard<T>, now: number): StatsCard<T> {
  return now < card.expiresAt ? card : { ...card, status: 'unavailable', value: null,
    reason: 'This observation has expired. Reopen the page to check for new data.' };
}
