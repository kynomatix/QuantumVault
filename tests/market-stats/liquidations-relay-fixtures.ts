import { HOUR } from '../../server/market-stats/liquidations-model';
import { RELAY_VENUES } from '../../server/market-stats/liquidations-relay';
import { END } from './liquidations-fixtures';

export function relayRow(time: number, oiCoins = 100, fetchedAt = END + HOUR) {
  return { hour: new Date(time).toISOString(), oiCoins, oiUsd: null as number | null,
    open: 100, high: 101, low: 99, close: 100, sourceKind: 'EXAMPLE', fetchedAt: new Date(fetchedAt).toISOString() };
}
export function relayEnvelope(start = END - 3 * HOUR, lastHour = END - HOUR) {
  const venues = Object.fromEntries(RELAY_VENUES.map(venue => [venue, { venue, symbol: 'BTC', interval: '1h',
    rows: Array.from({ length: (lastHour - start) / HOUR + 1 }, (_, i) => relayRow(start + i * HOUR, 100 + i)),
    gaps: [] as { hour: string; reason: string }[] }])) as Record<typeof RELAY_VENUES[number], {
      venue: string; symbol: string; interval: string; rows: ReturnType<typeof relayRow>[]; gaps: { hour: string; reason: string }[] }>;
  return { symbol: 'BTC', interval: '1h', generatedAt: new Date(END + HOUR).toISOString(), venues };
}
