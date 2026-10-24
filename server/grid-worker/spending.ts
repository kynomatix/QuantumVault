import DecimalBase from 'decimal.js';
import type { PoolClient } from 'pg';

const Decimal = DecimalBase.clone({ precision: 200, rounding: DecimalBase.ROUND_UP });
export const AGGREGATE_RESERVATION_IDENTITY = 'qv:grid-worker:v3:aggregate-reservations';

export interface EntryLiability {
  /** Durable lineage only; a missing lineage is retained as a separate liability. */
  lineage: string | null;
  amount: string;
  worstPrice: string;
  reduceOnly: boolean;
}
export interface SpendingFacts {
  observedAt: number;
  complete: boolean;
  quoteDecimals: number;
  positionNotional: string;
  orders: readonly EntryLiability[];
  entries: readonly EntryLiability[];
  feeReserve: string;
  fundingReserve: string;
  /** Only slippage not already included in worstPrice. */
  remainingSlippageReserve: string;
  uncertainTransfers: readonly { operationId: string; amount: string }[];
}
export interface SpendingReservation {
  investment: string; leverage: number; budget: string; exposure: string;
  reserve: string; cash: string; fees: string; factsAt: number;
  uncertain: boolean; aboveBudget: boolean;
}
function money(value: string) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || value.length > 80) throw Error('GRID_SPENDING_FACTS_INVALID');
  const n = new Decimal(value);
  if (!n.isFinite() || n.isNegative()) throw Error('GRID_SPENDING_FACTS_INVALID');
  return n;
}
/** No offsets across bots, positions or uncertain transfers. Unknown facts never become zero. */
export function calculateSpending(investment: string, leverage: number, facts: SpendingFacts, dbNow: number): SpendingReservation {
  if (!facts.complete || !Number.isSafeInteger(facts.observedAt) || !Number.isSafeInteger(dbNow)
    || facts.observedAt > dbNow || dbNow - facts.observedAt > 5_000
    || !Number.isSafeInteger(facts.quoteDecimals) || facts.quoteDecimals < 0 || facts.quoteDecimals > 18
    || !Number.isSafeInteger(leverage) || leverage < 1) throw Error('GRID_SPENDING_FACTS_INVALID');
  const i = money(investment);
  if (!i.gt(0)) throw Error('GRID_SPENDING_POLICY_INVALID');
  const round = (n: DecimalBase) => n.toDecimalPlaces(facts.quoteDecimals, Decimal.ROUND_UP);
  const budget = round(i.mul(leverage));
  let exposure = round(money(facts.positionNotional));
  const represented = new Map<string, DecimalBase>();
  for (const entry of [...facts.orders, ...facts.entries]) {
    if (typeof entry.reduceOnly !== 'boolean' || entry.lineage !== null && (typeof entry.lineage !== 'string' || !entry.lineage)) throw Error('GRID_SPENDING_LINEAGE_INVALID');
    const liability = round(money(entry.amount).mul(money(entry.worstPrice)));
    if (entry.reduceOnly) continue;
    if (entry.lineage === null) exposure = exposure.plus(liability);
    else represented.set(entry.lineage, Decimal.max(represented.get(entry.lineage) ?? 0, liability));
  }
  for (const value of represented.values()) exposure = exposure.plus(value);
  const fees = round(money(facts.feeReserve).plus(money(facts.fundingReserve)).plus(money(facts.remainingSlippageReserve)));
  const transfers = new Map<string, DecimalBase>();
  for (const transfer of facts.uncertainTransfers) {
    if (typeof transfer.operationId !== 'string' || !transfer.operationId) throw Error('GRID_SPENDING_LINEAGE_INVALID');
    transfers.set(transfer.operationId, Decimal.max(transfers.get(transfer.operationId) ?? 0, money(transfer.amount)));
  }
  let cash = i.plus(fees);
  for (const value of transfers.values()) cash = cash.plus(value);
  return { investment: i.toFixed(), leverage, budget: budget.toFixed(), exposure: round(exposure).toFixed(),
    reserve: round(Decimal.max(budget, exposure).plus(fees)).toFixed(), cash: round(cash).toFixed(), fees: fees.toFixed(),
    factsAt: facts.observedAt, uncertain: transfers.size > 0, aboveBudget: exposure.gt(budget) };
}

export interface SpendingCaps { startScope: string; perBotCap: string | null; globalCeiling: string | null }
/** The future cap arithmetic does not authorize expanded scope. */
export function withinSpendingCaps(r: SpendingReservation, caps: SpendingCaps, totals: { reserve: string; cash: string }): boolean {
  if (caps.startScope !== 'owner_allowlist') return false;
  if (caps.perBotCap !== null && (!money(caps.perBotCap).gt(0) || money(r.investment).gt(caps.perBotCap))) return false;
  if (caps.globalCeiling !== null && (!money(caps.globalCeiling).gt(0)
    || money(totals.reserve).plus(r.reserve).gt(caps.globalCeiling)
    || money(totals.cash).plus(r.cash).gt(caps.globalCeiling))) return false;
  return !r.aboveBudget;
}
export function futureNonOwnerInvestmentAllowed(investment: string, perBotCap: string | null): boolean {
  return perBotCap !== null && money(perBotCap).gt(0) && money(perBotCap).lte(250)
    && money(investment).gt(0) && money(investment).lte(perBotCap);
}
/** Caller already holds the shared host fence. Always before wallet and bot locks. */
export async function aggregateReservationFence(c: PoolClient): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [AGGREGATE_RESERVATION_IDENTITY]);
}
export async function allReservationTotals(c: PoolClient): Promise<{ reserve: string; cash: string }> {
  // No owner filter: paused, uncertain and all other retained bots count equally.
  return (await c.query<{ reserve: string; cash: string }>(`SELECT COALESCE(sum(reserve_usd),0)::text AS reserve,
    COALESCE(sum(cash_commitment_usd),0)::text AS cash FROM grid_worker_reservations WHERE state IN ('held','uncertain')`)).rows[0];
}
