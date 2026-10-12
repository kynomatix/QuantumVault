import { btcTrendExpiresAt, BTC_TREND_WEEK_MS, type GridDirectionSuggestion } from '../../../shared/grid-direction';

export function isGridDirectionSuggestion(value: unknown): value is GridDirectionSuggestion {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!['retrievedAt', 'serverNow', 'expiresAt'].every(key => Number.isSafeInteger(v[key]) && Number(v[key]) > 0)
    || Number(v.retrievedAt) > Number(v.serverNow)) return false;
  if (v.regime === 'unavailable') return v.sourceVenue === null && v.asOf === null && v.movingAverage === null
    && v.lastClose === null && typeof v.reason === 'string';
  return ['above', 'below'].includes(String(v.regime)) && ['okx', 'gate', 'hyperliquid', 'pacifica'].includes(String(v.sourceVenue))
    && (v.sourceAggregation === undefined || (v.sourceVenue === 'pacifica' && v.sourceAggregation === 'weekly-from-daily'))
    && Number.isSafeInteger(v.asOf) && Number(v.asOf) > 0 && Number(v.asOf) <= Number(v.retrievedAt)
    && Number(v.retrievedAt) - Number(v.asOf) < BTC_TREND_WEEK_MS
    && ['movingAverage', 'lastClose'].every(key => typeof v[key] === 'number' && Number.isFinite(v[key]) && Number(v[key]) > 0)
    && (v.regime === 'above' ? Number(v.lastClose) > Number(v.movingAverage) : Number(v.lastClose) < Number(v.movingAverage))
    && Number(v.expiresAt) > Number(v.serverNow)
    && Number(v.expiresAt) === btcTrendExpiresAt(Number(v.asOf));
}

export function gridDirectionText(value: GridDirectionSuggestion | null): { label: string; basis: string } {
  const basis = "Based on last week's close. BTC weekly candles, 50-week simple moving average.";
  if (!value || value.regime === 'unavailable') return { label: 'Trend suggestion unavailable',
    basis: `${basis} ${value?.regime === 'unavailable' ? value.reason : 'No fresh weekly data is available.'}` };
  const source = value.sourceAggregation === 'weekly-from-daily'
    ? 'Pacifica perp, weekly from daily' : `${value.sourceVenue.toUpperCase()} perpetual candles`;
  return { label: `Trend: BTC ${value.regime} its 50-week average — ${value.regime === 'above' ? 'long' : 'short'} grids favoured`,
    basis: `${basis} ${source}. As of ${new Date(value.asOf).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}. Suggestion only; choose either direction.` };
}
