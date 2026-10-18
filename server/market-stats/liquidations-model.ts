import type { LiquidationColumn, LiquidationCluster, LiquidationGap, LiquidationStats, LiquidationVenue } from '../../shared/market-stats';

export const HOUR = 3_600_000;
export const LIQUIDATION_DAY = 24 * HOUR;
export const MODEL_DAYS = 38;
export const DISPLAY_DAYS = 30;
export const BAND_COUNT = 120;
export const LEVERAGE_TIERS = [
  { leverage: 5, weight: 0.1 }, { leverage: 10, weight: 0.3 },
  { leverage: 25, weight: 0.3 }, { leverage: 50, weight: 0.2 }, { leverage: 100, weight: 0.1 },
] as const;
export const MMR = 0.005;
export type OiHour = { time: number; btc: number };
export type LiquidationCandle = { time: number; open: number; high: number; low: number; close: number };
export type LiquidationInputs = { oi: OiHour[]; candles: LiquidationCandle[]; fetchedAt: number };
type Cohort = { btc: number; price: number; side: 0 | 1 };
export type ModelHour = LiquidationCandle & { oiBtc: number };

export class LiquidationInputError extends Error {
  constructor(message: string, public gaps: LiquidationGap[] = []) { super(message); }
}

/** Exact UTC join. Even a single missing hour is unavailable; no invented bars/OI. */
export function alignLiquidationInputs(inputs: LiquidationInputs, start: number, end: number): ModelHour[] {
  if (start % HOUR || end % HOUR || end <= start || end - start > MODEL_DAYS * LIQUIDATION_DAY)
    throw new LiquidationInputError('The requested UTC hourly window is invalid.');
  const oi = new Map<number, OiHour>(), candles = new Map<number, LiquidationCandle>();
  for (const row of inputs.oi) {
    if (!Number.isSafeInteger(row.time) || row.time % HOUR || !Number.isFinite(row.btc) || row.btc < 0 || oi.has(row.time))
      throw new LiquidationInputError('OKX open-interest history contains invalid or duplicate hours.');
    oi.set(row.time, row);
  }
  for (const row of inputs.candles) {
    if (!Number.isSafeInteger(row.time) || row.time % HOUR || candles.has(row.time)
      || ![row.open, row.high, row.low, row.close].every(n => Number.isFinite(n) && n > 0)
      || row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || row.low > row.high)
      throw new LiquidationInputError('OKX candle history contains invalid or duplicate hours.');
    candles.set(row.time, row);
  }
  const gaps: LiquidationGap[] = [], hours: ModelHour[] = [];
  for (let time = start; time < end; time += HOUR) {
    const o = oi.get(time), c = candles.get(time);
    if (!o) gaps.push({ time, input: 'open-interest' });
    if (!c) gaps.push({ time, input: 'candles' });
    if (o && c) hours.push({ ...c, oiBtc: o.btc });
  }
  if (gaps.length) throw new LiquidationInputError(`Incomplete OKX hourly inputs: ${gaps.length} missing observations. No gaps are interpolated.`, gaps);
  return hours;
}

/**
 * oi-leverage-v2: start empty (the initial book is unknown). On each subsequent
 * hour, scale cohorts by the venue's remaining OI fraction on a drop, assuming
 * closes are spread across all open positions, OR add positive OI, split 50/50.
 * Then sweep against that hour's high/low, including new cohorts. Within-hour
 * entry ordering is unknown; this explicit convention is conservative.
 */
export function modelLiquidations(hours: ModelHour[], displayStart: number) {
  if (hours.length < 2 || hours.length > MODEL_DAYS * 24) throw new LiquidationInputError('Insufficient or oversized model history.');
  const last = hours[hours.length - 1], lower = last.close * 0.75, upper = last.close * 1.25;
  const bandWidth = (upper - lower) / BAND_COUNT;
  let cohorts: Cohort[] = [], enteredBtc = 0, retiredBtc = 0, sweptBtc = 0;
  const columns: LiquidationColumn[] = [];
  let block: LiquidationColumn | undefined;
  for (let i = 0; i < hours.length; i++) {
    const hour = hours[i];
    if (i) {
      const delta = hour.oiBtc - hours[i - 1].oiBtc;
      if (delta > 0) {
        const entry = (hour.high + hour.low + hour.close) / 3;
        enteredBtc += delta;
        for (const tier of LEVERAGE_TIERS) for (const side of [0, 1] as const) {
          cohorts.push({ btc: delta * 0.5 * tier.weight, side,
            price: entry * (side === 0 ? 1 - 1 / tier.leverage + MMR : 1 + 1 / tier.leverage - MMR) });
        }
      } else if (delta < 0) {
        const total = cohorts.reduce((sum, c) => sum + c.btc, 0);
        const ratio = Math.max(0, Math.min(1, hour.oiBtc / hours[i - 1].oiBtc));
        retiredBtc += total * (1 - ratio);
        for (const c of cohorts) c.btc *= ratio;
      }
      cohorts = cohorts.filter(c => {
        if (c.btc <= 0) return false;
        const swept = c.side === 0 ? hour.low <= c.price : hour.high >= c.price;
        if (swept) sweptBtc += c.btc;
        return !swept;
      });
    }
    if (hour.time < displayStart) continue;
    const time = Math.floor(hour.time / (4 * HOUR)) * 4 * HOUR;
    if (!block || block.time !== time) {
      block = { time, sampleAsOf: hour.time + HOUR, candle: { open: hour.open, high: hour.high, low: hour.low, close: hour.close }, bins: [], excludedUsd: 0 };
      columns.push(block);
    }
    block.candle.high = Math.max(block.candle.high, hour.high);
    block.candle.low = Math.min(block.candle.low, hour.low);
    block.candle.close = hour.close;
    block.sampleAsOf = hour.time + HOUR;
    const bins: [number, number][] = Array.from({ length: BAND_COUNT }, () => [0, 0]);
    let excludedUsd = 0;
    for (const c of cohorts) {
      const usd = c.btc * hour.close;
      if (c.price < lower || c.price >= upper) excludedUsd += usd;
      else bins[Math.min(BAND_COUNT - 1, Math.floor((c.price - lower) / bandWidth))][c.side] += usd;
    }
    // Overwrite the previous hourly state. Repeated exposure must never be summed.
    block.bins = bins.map(([long, short]) => [Math.round(long), Math.round(short)]);
    block.excludedUsd = Math.round(excludedUsd);
  }
  if (!columns.length) throw new LiquidationInputError('No hourly states in the display window.');
  const latest = columns[columns.length - 1];
  const summary: LiquidationStats['summary'] = { above: null, below: null };
  for (let i = 0; i < BAND_COUNT; i++) {
    const [long, short] = latest.bins[i], notionalUsd = long + short;
    if (!notionalUsd) continue;
    const cluster: LiquidationCluster = { lower: lower + i * bandWidth, upper: lower + (i + 1) * bandWidth,
      notionalUsd, side: long && short ? 'both' : long ? 'long' : 'short' };
    const side = (cluster.lower + cluster.upper) / 2 > last.close ? 'above' : 'below';
    if (!summary[side] || notionalUsd > summary[side]!.notionalUsd) summary[side] = cluster;
  }
  const value: LiquidationStats = { methodologyVersion: 'oi-leverage-v2', asset: 'BTC', instrument: 'BTC-USDT-SWAP',
    currentPrice: last.close, priceRange: { lower, upper }, bandWidth, columns,
    scaleMaxUsd: Math.max(0, ...columns.flatMap(c => c.bins.map(b => b[0] + b[1]))),
    excludedUsd: latest.excludedUsd, summary, modelStartedAt: hours[0].time, displayStartedAt: displayStart, initialOiBtc: hours[0].oiBtc };
  return { value, accounting: { enteredBtc, retiredBtc, sweptBtc, liveBtc: cohorts.reduce((sum, c) => sum + c.btc, 0) }, cohorts };
}

export type VenueOiSeries = { venue: Exclude<LiquidationVenue, 'okx'>; rows: OiHour[] };
type VenueAccounting = { venue: LiquidationVenue; enteredBtc: number; retiredBtc: number; sweptBtc: number;
  discardedForGapBtc: number; liveBtc: number };
type MultiVenueResult = { value: LiquidationStats; cohorts: Cohort[]; venueAccounting: VenueAccounting[];
  accounting: Omit<VenueAccounting, 'venue'> };

/** v3 keeps ownership through retirement and gaps. All books use the same OKX clock/prices. */
export function modelMultiVenueLiquidations(hours: ModelHour[], displayStart: number, optional: VenueOiSeries[]): ReturnType<typeof modelLiquidations> | MultiVenueResult {
  // Preserve the v2 entry point, errors, rounding and metadata verbatim on fallback.
  if (!optional.length) return modelLiquidations(hours, displayStart);
  if (hours.length < 2 || hours.length > MODEL_DAYS * 24) throw new LiquidationInputError('Insufficient or oversized model history.');
  const ordered = ['binance', 'bybit', 'hyperliquid'] as const;
  if (optional.length > 3 || new Set(optional.map(s => s.venue)).size !== optional.length
    || optional.some(s => !ordered.includes(s.venue))) throw new LiquidationInputError('Invalid venue books.');
  const series: { venue: LiquidationVenue; rows: OiHour[] }[] = [
    { venue: 'okx', rows: hours.map(h => ({ time: h.time, btc: h.oiBtc })) },
    ...ordered.flatMap(venue => optional.filter(s => s.venue === venue)),
  ];
  const books = series.map(s => {
    let previous = -Infinity;
    if (s.rows.length > hours.length || s.rows.some(r => {
      const bad = !Number.isSafeInteger(r.time) || r.time % HOUR || r.time <= previous
        || r.time < hours[0].time || r.time > hours.at(-1)!.time || !Number.isFinite(r.btc) || r.btc < 0;
      previous = r.time; return bad;
    })) throw new LiquidationInputError('Invalid venue observations.');
    return { venue: s.venue, observations: new Map(s.rows.map(r => [r.time, r.btc])),
      lastObservation: s.rows.at(-1)?.time ?? -Infinity, previous: undefined as OiHour | undefined,
      cohorts: [] as Cohort[], enteredBtc: 0, retiredBtc: 0, sweptBtc: 0, discardedForGapBtc: 0 };
  });
  const last = hours.at(-1)!, lower = last.close * 0.75, upper = last.close * 1.25;
  const bandWidth = (upper - lower) / BAND_COUNT, columns: LiquidationColumn[] = [];
  let block: LiquidationColumn | undefined;
  for (const hour of hours) {
    for (const book of books) {
      const btc = book.observations.get(hour.time);
      if (btc === undefined) {
        if (hour.time < book.lastObservation) {
          book.discardedForGapBtc += book.cohorts.reduce((sum, c) => sum + c.btc, 0);
          book.cohorts = []; book.previous = undefined;
        }
        // A short terminal lag is known coverage ending: sweep, without new OI changes.
      } else {
        const delta = book.previous && book.previous.time === hour.time - HOUR ? btc - book.previous.btc : 0;
        if (delta > 0) {
          const entry = (hour.high + hour.low + hour.close) / 3;
          book.enteredBtc += delta;
          for (const tier of LEVERAGE_TIERS) for (const side of [0, 1] as const) {
            book.cohorts.push({ btc: delta * 0.5 * tier.weight, side,
              price: entry * (side === 0 ? 1 - 1 / tier.leverage + MMR : 1 + 1 / tier.leverage - MMR) });
          }
        } else if (delta < 0) {
          const ratio = Math.max(0, Math.min(1, btc / book.previous!.btc));
          book.retiredBtc += book.cohorts.reduce((sum, c) => sum + c.btc, 0) * (1 - ratio);
          for (const c of book.cohorts) c.btc *= ratio;
        }
        book.previous = { time: hour.time, btc };
      }
      book.cohorts = book.cohorts.filter(c => {
        if (c.btc <= 0) return false;
        const swept = c.side === 0 ? hour.low <= c.price : hour.high >= c.price;
        if (swept) book.sweptBtc += c.btc;
        return !swept;
      });
    }
    if (hour.time < displayStart) continue;
    const time = Math.floor(hour.time / (4 * HOUR)) * 4 * HOUR;
    if (!block || block.time !== time) {
      block = { time, sampleAsOf: hour.time + HOUR, candle: { open: hour.open, high: hour.high, low: hour.low, close: hour.close }, bins: [], excludedUsd: 0 };
      columns.push(block);
    }
    block.candle.high = Math.max(block.candle.high, hour.high); block.candle.low = Math.min(block.candle.low, hour.low);
    block.candle.close = hour.close; block.sampleAsOf = hour.time + HOUR;
    const bins: [number, number][] = Array.from({ length: BAND_COUNT }, () => [0, 0]);
    let excludedUsd = 0;
    for (const book of books) for (const c of book.cohorts) {
      const usd = c.btc * hour.close;
      if (c.price < lower || c.price >= upper) excludedUsd += usd;
      else bins[Math.min(BAND_COUNT - 1, Math.floor((c.price - lower) / bandWidth))][c.side] += usd;
    }
    // Round once, after all venue books have contributed to the common bands.
    block.bins = bins.map(([long, short]) => [Math.round(long), Math.round(short)]); block.excludedUsd = Math.round(excludedUsd);
  }
  if (!columns.length) throw new LiquidationInputError('No hourly states in the display window.');
  const latest = columns.at(-1)!, summary: LiquidationStats['summary'] = { above: null, below: null };
  for (let i = 0; i < BAND_COUNT; i++) {
    const [long, short] = latest.bins[i], notionalUsd = long + short;
    if (!notionalUsd) continue;
    const cluster: LiquidationCluster = { lower: lower + i * bandWidth, upper: lower + (i + 1) * bandWidth,
      notionalUsd, side: long && short ? 'both' : long ? 'long' : 'short' };
    const side = (cluster.lower + cluster.upper) / 2 > last.close ? 'above' : 'below';
    if (!summary[side] || notionalUsd > summary[side]!.notionalUsd) summary[side] = cluster;
  }
  const value: LiquidationStats = { methodologyVersion: 'oi-leverage-v3', asset: 'BTC', instrument: 'BTC-USDT-SWAP',
    currentPrice: last.close, priceRange: { lower, upper }, bandWidth, columns,
    scaleMaxUsd: Math.max(0, ...columns.flatMap(c => c.bins.map(b => b[0] + b[1]))), excludedUsd: latest.excludedUsd,
    summary, modelStartedAt: hours[0].time, displayStartedAt: displayStart, initialOiBtc: hours[0].oiBtc };
  const venueAccounting = books.map(b => ({ venue: b.venue, enteredBtc: b.enteredBtc, retiredBtc: b.retiredBtc,
    sweptBtc: b.sweptBtc, discardedForGapBtc: b.discardedForGapBtc, liveBtc: b.cohorts.reduce((sum, c) => sum + c.btc, 0) }));
  const accounting = venueAccounting.reduce((sum, b) => ({ enteredBtc: sum.enteredBtc + b.enteredBtc,
    retiredBtc: sum.retiredBtc + b.retiredBtc, sweptBtc: sum.sweptBtc + b.sweptBtc,
    discardedForGapBtc: sum.discardedForGapBtc + b.discardedForGapBtc, liveBtc: sum.liveBtc + b.liveBtc }),
    { enteredBtc: 0, retiredBtc: 0, sweptBtc: 0, discardedForGapBtc: 0, liveBtc: 0 });
  return { value, accounting, cohorts: books.flatMap(b => b.cohorts), venueAccounting };
}
