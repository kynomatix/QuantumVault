import Decimal from 'decimal.js';
import type { GridInput, GridGeometryInput, GridLine, GridPlan, GridResult, GridPriceInput, GridPriceResult, MinimumResult, PairFee, Scale } from './engine-types';

// Private arithmetic cannot be changed by another consumer's Decimal.set().
const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_DOWN, toExpNeg: -120, toExpPos: 120 });
const MAX = new D('1000000000000000000');
const MIN = new D('0.000000000000000001');
export function validGridDecimal(value: unknown, allowZero = false): value is string {
  if (typeof value !== 'string' || value.length > 37 || !/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value)) return false;
  const n = new D(value);
  return n.lt(MAX) && (allowZero && n.isZero() || n.gte(MIN));
}
const text = (n: Decimal) => n.toFixed();
const floor = (n: Decimal, step: Decimal) => n.div(step).floor().times(step);
const failure = (code: Extract<GridResult, { ok: false }>['issues'][number]['code'], reason: string, ordinal?: number): Extract<GridResult, { ok: false }> =>
  ({ ok: false, issues: [{ code, reason, ...(ordinal === undefined ? {} : { ordinal }) }] });

function weight(index: number, count: number, scale: Scale): number {
  return scale === 'flat' ? 1 : scale === 'ascending' ? count - index : index + 1;
}
export function assumedPairFees(plan: GridPlan, rate: string): PairFee[] {
  if (!validGridDecimal(rate, true)) throw new Error('Invalid bounded fee rate');
  return plan.lines.filter(line => line.role === 'entry' && line.pairedExitOrdinal !== null).map(line => {
    const entry = new D(line.price), exit = new D(plan.lines[line.pairedExitOrdinal!].price);
    const spread = exit.minus(entry).abs(), required = new D(rate).times(entry.plus(exit));
    return { ordinal: line.ordinal, entryPrice: line.price, exitPrice: text(exit), quantity: line.quantity,
      spread: text(spread), requiredSpread: text(required), assumedRoundTripFee: text(required.times(line.quantity)),
      clears: spread.gt(required) };
  });
}

/** Price geometry only; never supplies quantities, capital requirements or execution authority. */
export function calculateGridPrices(input: GridPriceInput): GridPriceResult {
  for (const key of ['lower', 'upper', 'tick'] as const)
    if (!validGridDecimal(input[key])) return failure('invalid_decimal', `${key}: use a positive plain decimal with at most 18 decimal places`);
  if (!Number.isInteger(input.intervals) || input.intervals < 1 || input.intervals > 100 || !new D(input.lower).lt(input.upper))
    return failure('invalid_geometry', 'Choose an increasing range and 1–100 intervals');
  const lower = new D(input.lower), tick = new D(input.tick), spacing = new D(input.upper).minus(lower).div(input.intervals);
  const prices = Array.from({ length: input.intervals + 1 }, (_, i) => floor(lower.plus(spacing.times(i)), tick));
  if (prices.some((p, i) => p.lte(0) || i > 0 && p.lte(prices[i - 1])))
    return failure('duplicate_prices', 'Tick rounding collapses grid lines; widen the range or reduce intervals');
  return { ok: true, lines: prices.map((p, ordinal) => ({ ordinal, price: text(p) })) };
}

/** Hypothetical full-size geometry only. No fill, liquidation or execution authority. */
export function calculateGrid(input: GridInput): GridResult {
  const positive = ['lower', 'upper', 'start', 'leverage', 'tick', 'lot', 'minimumQuote', 'investmentStep', 'investment'] as const;
  for (const key of positive) if (!validGridDecimal(input[key])) return failure('invalid_decimal', `${key}: use a positive plain decimal with at most 18 decimal places`);
  if (!validGridDecimal(input.transferFloor, true) || (input.effectiveMakerCostRate != null && !validGridDecimal(input.effectiveMakerCostRate, true)))
    return failure('invalid_decimal', 'Invalid transfer floor or assumed fee');
  if (!['long', 'short'].includes(input.side) || !['flat', 'ascending', 'descending'].includes(input.entryScale)
      || !['flat', 'ascending', 'descending'].includes(input.profitScale) || typeof input.seed !== 'boolean'
      || !Number.isInteger(input.intervals) || input.intervals < 1 || input.intervals > 100)
    return failure('invalid_geometry', 'Choose long or short, known size scales and 1–100 intervals');
  const lower = new D(input.lower), upper = new D(input.upper), startRaw = new D(input.start), tick = new D(input.tick), lot = new D(input.lot);
  if (!lower.lt(startRaw) || !startRaw.lt(upper)) return failure('invalid_start', 'Reference price must be strictly inside the range');
  const start = floor(startRaw, tick), geometry = calculateGridPrices(input);
  if (!geometry.ok) return geometry;
  const prices = geometry.lines.map(line => new D(line.price));
  if (!start.gt(prices[0]) || !start.lt(prices[prices.length - 1])) return failure('invalid_start', 'Tick-rounded reference price is on the range boundary');
  const investment = new D(input.investment), step = new D(input.investmentStep);
  if (!investment.mod(step).isZero()) return failure('invalid_investment', 'Investment must align to the supplied quote increment');
  const isEntry = (p: Decimal) => input.side === 'long' ? p.lt(start) : p.gt(start);
  const entries = prices.map((p, i) => ({ p, i })).filter(x => isEntry(x.p));
  const profits = prices.map((p, i) => ({ p, i })).filter(x => !isEntry(x.p) && !x.p.eq(start));
  // Better entry/exit prices come first; ordinals remove any incidental ordering dependence.
  entries.sort((a, b) => input.side === 'long' ? a.i - b.i : b.i - a.i);
  profits.sort((a, b) => input.side === 'long' ? b.i - a.i : a.i - b.i);
  const total = investment.times(input.leverage), seedNotional = input.seed ? total.times(profits.length).div(entries.length + profits.length) : new D(0);
  const lines: GridLine[] = prices.map((p, ordinal) => ({ ordinal, price: text(p), quantity: '0', notional: '0',
    role: isEntry(p) ? 'entry' : input.seed && !p.eq(start) ? 'seed_exit' : 'virtual',
    pairedExitOrdinal: isEntry(p) ? ordinal + (input.side === 'long' ? 1 : -1) : null }));
  const allocate = (set: typeof entries, notional: Decimal, scale: Scale) => {
    const weights = set.map((_, i) => weight(i, set.length, scale)), sum = weights.reduce((a, b) => a + b, 0);
    set.forEach(({ p, i }, k) => {
      const quantity = floor(notional.times(weights[k]).div(sum).div(p), lot);
      lines[i].quantity = text(quantity); lines[i].notional = text(quantity.times(p));
    });
  };
  allocate(entries, total.minus(seedNotional), input.entryScale);
  if (input.seed) allocate(profits, seedNotional, input.profitScale);
  const allocated = lines.reduce((a, l) => a.plus(l.notional), new D(0));
  const plan: GridPlan = { side: input.side, start: text(start), investment: text(investment), leverage: input.leverage, lines,
    seedQuantity: text(lines.filter(l => l.role === 'seed_exit').reduce((a, l) => a.plus(l.quantity), new D(0))),
    allocatedNotional: text(allocated), unallocatedNotional: text(total.minus(allocated)),
    feeGate: input.effectiveMakerCostRate == null ? 'not_evaluated' : 'evaluated', feeRows: [] };
  if (input.effectiveMakerCostRate != null) {
    plan.feeRows = assumedPairFees(plan, input.effectiveMakerCostRate);
    const failed = plan.feeRows.find(row => !row.clears);
    if (failed) return failure('fee_clearance', 'Assumed round-trip cost is at least the adjacent spread', failed.ordinal);
  }
  if (investment.lt(input.transferFloor)) return failure('underfunded', 'Investment is below the supplied application transfer floor');
  for (const line of lines.filter(l => l.role !== 'virtual')) {
    const q = new D(line.quantity);
    if (q.lt(lot) || new D(line.notional).lt(input.minimumQuote)) return failure('underfunded', 'Lot-rounded line is below the opening minimum', line.ordinal);
    if (line.pairedExitOrdinal !== null && q.times(prices[line.pairedExitOrdinal]).lt(input.minimumQuote))
      return failure('underfunded', 'Full entry quantity is below the minimum at its paired exit', line.ordinal);
  }
  return { ok: true, plan };
}

/** Search integer quote quanta; only underfunding may advance the search. */
export function minimumInvestment(input: GridGeometryInput): MinimumResult {
  let evaluations = 0;
  const fail = (reason: string): MinimumResult => ({ ok: false, issues: [{ code: 'search_limit', reason }], evaluations });
  if (!validGridDecimal(input.investmentStep) || !validGridDecimal(input.transferFloor, true))
    return { ok: false, issues: [{ code: 'invalid_decimal', reason: 'Invalid investment step or transfer floor' }], evaluations };
  const step = new D(input.investmentStep), cap = MAX.div(step).ceil().minus(1);
  const evaluate = (units: Decimal): GridResult => {
    evaluations++;
    const amount = text(units.times(step));
    return validGridDecimal(amount) ? calculateGrid({ ...input, investment: amount }) : failure('invalid_decimal', 'Minimum investment exceeds the bounded decimal envelope');
  };
  let low = new D(0), high = D.max(1, new D(input.transferFloor).div(step).ceil()), result: GridResult;
  for (let i = 0; ; i++) {
    if (i >= 128 || evaluations >= 258 || high.gt(cap)) return fail('Minimum investment search reached its finite bound');
    result = evaluate(high);
    if (result.ok) break;
    if (result.issues.some(issue => issue.code !== 'underfunded')) return { ...result, evaluations };
    low = high; const next = D.min(cap, high.times(2));
    if (!next.gt(high)) return fail('Minimum search cannot advance');
    high = next;
  }
  for (let i = 0; high.minus(low).gt(1); i++) {
    if (i >= 128 || evaluations >= 258) return fail('Minimum investment search reached its finite bound');
    const mid = high.plus(low).div(2).floor();
    if (!mid.gt(low) || !mid.lt(high)) return fail('Minimum search cannot narrow');
    result = evaluate(mid);
    if (result.ok) high = mid;
    else if (result.issues.every(issue => issue.code === 'underfunded')) low = mid;
    else return { ...result, evaluations };
  }
  result = evaluate(high);
  if (!result.ok) return { ...result, evaluations };
  if (high.gt(1)) {
    const previous = evaluate(high.minus(1));
    if (previous.ok || previous.issues.some(issue => issue.code !== 'underfunded')) return fail('Minimum failed preceding-quantum verification');
  }
  return { ok: true, investment: text(high.times(step)), plan: result.plan, evaluations };
}
