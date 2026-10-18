import Decimal from 'decimal.js';
import { calculateGridPrices, validGridDecimal } from './engine';
import type { GridCycle, GridInput, GridLine, GridResult, Scale } from './engine-types';
import { GRID_SEED_MAX_SLIPPAGE_PERCENT } from './stop-clearance';

const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_DOWN, toExpNeg: -120, toExpPos: 120 });
const fail = (code: Extract<GridResult, { ok: false }>['issues'][number]['code'], reason: string): GridResult => ({ ok: false, issues: [{ code, reason }] });
const floor = (v: Decimal, step: Decimal) => v.div(step).floor().mul(step);
const weight = (i: number, n: number, scale: Scale) => scale === 'flat' ? 1 : scale === 'ascending' ? n - i : i + 1;
export function gridSeedPriceBounds(start: string, tick: string) {
  const step = new D(tick), fraction = new D(GRID_SEED_MAX_SLIPPAGE_PERCENT).div(100);
  return { low: floor(new D(start).mul(new D(1).minus(fraction)), step).toFixed(),
    high: new D(start).mul(new D(1).plus(fraction)).div(step).ceil().mul(step).toFixed() };
}

/** Fixed capacity across every reachable cycle; initial seed allocation never compounds. */
export function calculateCycleGrid(input: GridInput): GridResult {
  for (const k of ['lower', 'upper', 'start', 'leverage', 'tick', 'lot', 'minimumQuote', 'investmentStep', 'investment'] as const)
    if (!validGridDecimal(input[k])) return fail('invalid_decimal', `Invalid ${k}`);
  if (!validGridDecimal(input.transferFloor, true) || input.maximumQuote != null && !validGridDecimal(input.maximumQuote)
    || input.effectiveMakerCostRate != null && !validGridDecimal(input.effectiveMakerCostRate, true)) return fail('invalid_decimal', 'Invalid limits or fees');
  if (!['long', 'short'].includes(input.side) || typeof input.seed !== 'boolean'
    || ![input.entryScale, input.profitScale].every(s => ['flat', 'ascending', 'descending'].includes(s))) return fail('invalid_geometry', 'Invalid direction, seed or scale');
  const geometry = calculateGridPrices(input); if (!geometry.ok) return geometry;
  const tick = new D(input.tick), lot = new D(input.lot), start = floor(new D(input.start), tick);
  const prices = geometry.lines.map(l => new D(l.price)), long = input.side === 'long';
  if (!new D(input.start).gt(input.lower) || !new D(input.start).lt(input.upper)
    || !start.gt(prices[0]) || !start.lt(prices.at(-1)!)) return fail('invalid_start', 'Reference must be strictly inside the quantized range');
  const investment = new D(input.investment), quantum = new D(input.investmentStep), total = investment.mul(input.leverage);
  if (!investment.mod(quantum).eq(0)) return fail('invalid_investment', 'Investment must align to the quote increment');
  const bounds = gridSeedPriceBounds(input.start, input.tick);
  if (input.seed && !new D(bounds.low).gt(0)) return fail('invalid_geometry', 'Seed execution bound is not positive');
  const worst = D.max(prices.at(-1)!, input.seed ? bounds.high : '0');
  const opening = (p: Decimal) => long ? p.lt(start) : p.gt(start);
  const entries = geometry.lines.filter(l => opening(new D(l.price))).sort((a, b) => long ? a.ordinal - b.ordinal : b.ordinal - a.ordinal);
  const profits = geometry.lines.filter(l => !opening(new D(l.price)) && !new D(l.price).eq(start)).sort((a, b) => long ? b.ordinal - a.ordinal : a.ordinal - b.ordinal);
  const count = entries.length + profits.length;
  const lines: GridLine[] = geometry.lines.map(l => ({ ...l, quantity: '0', notional: '0',
    role: new D(l.price).eq(start) ? 'virtual' : opening(new D(l.price)) ? 'entry' : 'seed_exit',
    pairedExitOrdinal: opening(new D(l.price)) ? l.ordinal + (long ? 1 : -1) : null }));
  const cycles: GridCycle[] = [], coefficients = new Map<number, Decimal>(), minimums = new Map<number, Decimal>();
  for (const [group, scale] of [[entries, input.entryScale], [profits, input.profitScale]] as const) {
    const weights = group.map((_, i) => weight(i, group.length, scale)), sum = weights.reduce((a, b) => a + b, 0);
    for (const [index, row] of group.entries()) {
      const i = row.ordinal, isOpening = opening(prices[i]);
      const openingOrdinal = isOpening ? i : i + (long ? -1 : 1), closingOrdinal = isOpening ? i + (long ? 1 : -1) : i;
      if (!prices[openingOrdinal] || !prices[closingOrdinal]) return fail('invalid_geometry', 'Cycle endpoint outside range');
      const minimum = new D(input.minimumQuote).div(prices[openingOrdinal]).div(lot).ceil().mul(lot);
      minimums.set(i, minimum);
      coefficients.set(i, new D(group.length).div(count).mul(weights[index]).div(sum).div(row.price));
      cycles.push({ ownerOrdinal: i, anchor: isOpening ? 'opening' : 'closing', openingOrdinal, closingOrdinal,
        openingPrice: prices[openingOrdinal].toFixed(), closingPrice: prices[closingOrdinal].toFixed(),
        quantity: '0', initialInventory: '0', initialOpeningCredit: '0' });
    }
  }
  cycles.sort((a, b) => a.ownerOrdinal - b.ownerOrdinal);
  // Fee rejection is price-only and must precede underfunding during minimum search.
  const feeRows = cycles.map(c => {
    const entry = new D(c.openingPrice), exit = new D(c.closingPrice), spread = entry.minus(exit).abs();
    const required = entry.plus(exit).mul(input.effectiveMakerCostRate ?? '0');
    return { ordinal: c.ownerOrdinal, entryPrice: c.openingPrice, exitPrice: c.closingPrice, quantity: '0',
      spread: spread.toFixed(), requiredSpread: required.toFixed(), assumedRoundTripFee: '0', clears: spread.gt(required) };
  });
  if (input.effectiveMakerCostRate != null && feeRows.some(r => !r.clears)) return fail('fee_clearance', 'Assumed round-trip cost is at least a cycle spread');
  if (investment.lt(input.transferFloor) || [...minimums.values()].reduce((s, q) => s.plus(q.mul(worst)), new D(0)).gt(total))
    return fail('underfunded', 'Investment cannot fund every future opening endpoint at its lot-rounded minimum');
  const quantities = (units: Decimal) => cycles.map(c => D.max(minimums.get(c.ownerOrdinal)!, floor(units.mul(quantum).mul(coefficients.get(c.ownerOrdinal)!), lot)));
  const capacity = (qs: Decimal[]) => qs.reduce((s, q) => s.plus(q), new D(0)).mul(worst);
  let low = new D(0), high = total.div(quantum).floor();
  for (let iteration = 0; low.lt(high); iteration++) {
    if (iteration >= 256) return fail('search_limit', 'Cycle allocation reached its finite bound');
    const mid = low.plus(high).plus(1).div(2).floor();
    if (!mid.gt(low) || mid.gt(high)) return fail('search_limit', 'Cycle allocation cannot narrow');
    if (capacity(quantities(mid)).lte(total)) low = mid; else high = mid.minus(1);
  }
  const qs = quantities(low), lifted: number[] = [];
  cycles.forEach((c, i) => {
    const q = qs[i], seeded = c.anchor === 'closing' && input.seed;
    c.quantity = q.toFixed(); c.initialInventory = seeded ? c.quantity : '0'; c.initialOpeningCredit = seeded ? '0' : c.quantity;
    lines[c.ownerOrdinal].quantity = c.quantity; lines[c.ownerOrdinal].notional = q.mul(lines[c.ownerOrdinal].price).toFixed();
    feeRows[i].quantity = c.quantity; feeRows[i].assumedRoundTripFee = q.mul(feeRows[i].requiredSpread).toFixed();
    if (floor(low.mul(quantum).mul(coefficients.get(c.ownerOrdinal)!), lot).lt(minimums.get(c.ownerOrdinal)!)) lifted.push(c.ownerOrdinal);
  });
  const seedQuantity = cycles.reduce((s, c) => s.plus(c.initialInventory), new D(0));
  if (seedQuantity.gt(0) && seedQuantity.mul(bounds.low).lt(input.minimumQuote)) return fail('underfunded', 'Aggregate seed is below the opening minimum at its execution bound');
  if (input.maximumQuote && (cycles.some(c => new D(c.quantity).mul(D.max(c.openingPrice, c.closingPrice)).gt(input.maximumQuote!))
    || seedQuantity.mul(bounds.high).gt(input.maximumQuote))) return fail('invalid_geometry', 'Cycle endpoint or aggregate seed exceeds maximum quote');
  const reserved = capacity(qs), allocated = lines.reduce((s, l) => s.plus(l.notional), new D(0));
  return { ok: true, plan: { policyVersion: '2.0.0', side: input.side, start: start.toFixed(), investment: investment.toFixed(), leverage: input.leverage,
    lines, cycles, capacityPrice: worst.toFixed(), capacityNotional: reserved.toFixed(), seedPriceBounds: bounds, seedQuantity: seedQuantity.toFixed(),
    allocatedNotional: allocated.toFixed(), unallocatedNotional: total.minus(reserved).toFixed(),
    feeGate: input.effectiveMakerCostRate == null ? 'not_evaluated' : 'evaluated', feeRows: input.effectiveMakerCostRate == null ? [] : feeRows,
    ...(lifted.length ? { openingOrderLift: { count: lifted.length, minimumQuote: input.minimumQuote, ordinals: lifted } } : {}) } };
}
