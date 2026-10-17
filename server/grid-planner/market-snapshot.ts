import { checkEntryConstraints, parseVenueDecimal } from '../protocol/market-constraints';
import type { ProtocolMarket } from '../protocol/protocol-types';
import type { PlannerDeps, PlannerMarket, Fact } from './types';
import Decimal from 'decimal.js';
import { validGridDecimal } from '../grid-bot/engine';
const D = Decimal.clone({ precision: 120, toExpNeg: -120, toExpPos: 120 });
const canonical = (value: string) => new D(value).toFixed();

export const unknown = <T>(reason: string): Fact<T> => ({ state: 'unavailable', reason });
function publicDecimal(raw: unknown, allowZero = false): string | null {
  if (typeof raw !== 'string' || raw.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  try {
    const parsed = new D(raw);
    if (!parsed.isFinite() || parsed.gte('1e18') || !parsed.isZero() && parsed.lt('1e-18')) return null;
    const value = parsed.toFixed();
    return validGridDecimal(value, allowZero) ? value : null;
  } catch { return null; }
}
export function marketSnapshot(row: ProtocolMarket, deps: PlannerDeps): PlannerMarket {
  const now = deps.now(), observation = row.constraintObservation;
  const admission = checkEntryConstraints(observation, row.internalSymbol, now);
  const p = observation?.planning, maximum = publicDecimal(p?.maximumQuote), low = publicDecimal(p?.minimumPrice, true), high = publicDecimal(p?.maximumPrice);
  const restrictions: Fact<string> = typeof p?.isolatedOnly === 'boolean' && typeof p.instrumentType === 'string'
    && Array.isArray(p.executionModes) && p.executionModes.length > 0 && p.executionModes.every(mode => typeof mode === 'string')
    ? { state: 'available', value: p.isolatedOnly ? 'isolated_only' : p.instrumentType !== 'perpetual' ? 'unsupported_instrument'
      : !p.executionModes.includes('orderbook') ? 'unsupported_execution' : 'unrestricted' }
    : unknown('Checked by Pacifica when each order is placed');
  // Revalidate exact fields, rather than accepting compatibility numbers or a forged view.
  const fieldsValid = observation && (['tick', 'lot', 'openingMinimum'] as const).every(key => {
    const field = observation[key], unit = key === 'tick' ? 'price' : key === 'lot' ? 'base' : 'USD';
    return field?.unit === unit && typeof field.exact === 'string' && field.exact.length <= 80
      && parseVenueDecimal(field.exact, unit)?.value === field.value && validGridDecimal(canonical(field.exact));
  });
  const constraints: PlannerMarket['constraints'] = admission.ok && fieldsValid && observation?.tick && observation.lot && observation.openingMinimum
    ? { state: 'available', value: { tick: canonical(observation.tick.exact), lot: canonical(observation.lot.exact), minimumQuote: canonical(observation.openingMinimum.exact),
      observedAt: observation.observedAt, expiresAt: observation.expiresAt, source: '/info', venue: 'pacifica',
      maxLeverage: row.maxLeverageSource === 'venue' && Number.isFinite(row.maxLeverage) && row.maxLeverage > 0
        ? { state: 'available', value: String(row.maxLeverage) } : unknown('Observed venue leverage maximum unavailable'),
      maximumQuote: maximum ? { state: 'available', value: maximum } : unknown('Checked by Pacifica when each order is placed'),
      priceBounds: low !== null && high !== null && new D(low).lt(high) ? { state: 'available', value: { minimum: low, maximum: high } }
        : unknown('Checked by Pacifica when each order is placed'),
      restrictions } }
    : unknown(admission.ok ? 'Invalid exact constraint fields or units' : admission.reason);
  const cached = deps.cachedReference(row.internalSymbol);
  const reference: PlannerMarket['reference'] = cached && Number.isFinite(cached.price) && cached.price > 0
    && Number.isSafeInteger(cached.observedAt) && cached.observedAt !== null && cached.observedAt <= now && now <= cached.observedAt + 60_000
    ? { state: 'available', value: { price: String(cached.price), observedAt: cached.observedAt, expiresAt: cached.observedAt + 60_000,
      label: 'Cached Pacifica book reference price' } } : unknown('Cached Pacifica book reference price is missing, invalid or older than 60 seconds');
  return { market: row.internalSymbol, protocolSymbol: row.protocolSymbol, name: row.fullName, constraints, reference };
}
