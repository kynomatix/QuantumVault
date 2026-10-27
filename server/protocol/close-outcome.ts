import type { ProtocolAdapter } from './adapter.js';
import type { ProtocolPosition } from './protocol-types.js';

export interface CloseObservation {
  account: string;
  environment: string;
  requestId: string;
  startedAt: number;
  dispatchedAt: number;
  receivedAt: number;
  /** Null means an empty inventory with no observed order history, never close proof. */
  lastOrderId: number | null;
  venueClockMs?: number;
  complete: true;
  fresh: true;
  noDedup: true;
}
export interface CloseSnapshot {
  positions: ProtocolPosition[];
  evidence: CloseObservation;
}
export interface CloseResult {
  outcome: 'acknowledged' | 'confirmed' | 'rejected' | 'partial' | 'unknown';
  account: string;
  market: string;
  reason: string;
  baseline?: CloseObservation;
  observation?: CloseObservation;
  remainingSize?: number;
}

// Queueing consumes no venue snapshot age. Keep separate finite budgets, shared
// by the transport reader and every downstream close-evidence consumer.
export const CLOSE_QUEUE_WAIT_MS = 8_000;
export const CLOSE_SNAPSHOT_AGE_MS = 10_000;
export const CLOSE_TOTAL_WAIT_MS = CLOSE_QUEUE_WAIT_MS + CLOSE_SNAPSHOT_AGE_MS;

export function closeSnapshotTimingError(startedAt: number, dispatchedAt: number, receivedAt: number): string | undefined {
  if (![startedAt, dispatchedAt, receivedAt].every(Number.isFinite)
    || startedAt > dispatchedAt || dispatchedAt > receivedAt) return 'timing_invalid';
  if (receivedAt - startedAt > CLOSE_TOTAL_WAIT_MS) return 'total_timeout';
  if (dispatchedAt - startedAt > CLOSE_QUEUE_WAIT_MS) return 'queue_timeout';
  if (receivedAt - dispatchedAt > CLOSE_SNAPSHOT_AGE_MS) return 'timeout';
  return undefined;
}

export function validSnapshot(snapshot: CloseSnapshot, account: string): boolean {
  const e = snapshot?.evidence;
  return Boolean(e && e.account === account && e.environment && e.requestId
    && e.complete === true && e.fresh === true && e.noDedup === true
    && (e.lastOrderId === null
      ? Array.isArray(snapshot.positions) && snapshot.positions.length === 0
      : Number.isSafeInteger(e.lastOrderId) && e.lastOrderId >= 0)
    && [e.startedAt, e.dispatchedAt, e.receivedAt].every(Number.isFinite)
    && e.startedAt <= e.dispatchedAt && e.dispatchedAt <= e.receivedAt
    && e.receivedAt <= Date.now() && Date.now() - e.receivedAt <= 10_000
    && closeSnapshotTimingError(e.startedAt, e.dispatchedAt, e.receivedAt) === undefined
    && Array.isArray(snapshot.positions)
    && snapshot.positions.every(p => p.internalSymbol && Number.isFinite(p.baseSize))
    && new Set(snapshot.positions.map(p => p.internalSymbol)).size === snapshot.positions.length);
}

/** Independent inventory observations, including externally closed positions.
 * Empty-account mode is only for callers that have submitted no close orders. */
export function qualifiedFlatObservation(account: string, market: string | undefined,
  baseline: CloseSnapshot, after: CloseSnapshot, notBefore: number,
  purpose: 'close' | 'empty-account' = 'close'): boolean {
  if (!validSnapshot(baseline, account) || !validSnapshot(after, account)
    || !Number.isFinite(notBefore) || after.evidence.startedAt < notBefore
    || after.evidence.startedAt < baseline.evidence.receivedAt
    || baseline.evidence.environment !== after.evidence.environment
    || baseline.evidence.requestId === after.evidence.requestId) return false;
  if (baseline.evidence.lastOrderId === null || after.evidence.lastOrderId === null) {
    return purpose === 'empty-account'
      && baseline.evidence.lastOrderId === null && after.evidence.lastOrderId === null;
  }
  if (after.evidence.lastOrderId < baseline.evidence.lastOrderId) return false;
  const inScope = (p: ProtocolPosition) => market === undefined || p.internalSymbol === market;
  if (after.positions.some(p => inScope(p) && p.baseSize !== 0)) return false;
  return !baseline.positions.some(p => inScope(p) && p.baseSize !== 0)
    || after.evidence.lastOrderId > baseline.evidence.lastOrderId;
}

/** This boundary never substitutes a permissive/default position read. */
export async function readCloseSnapshot(adapter: ProtocolAdapter, account: string, subaccountId?: string): Promise<CloseSnapshot> {
  if (!adapter.getCloseConfirmationSnapshot) throw new Error('close_confirmation_reader_unavailable');
  const snapshot = await adapter.getCloseConfirmationSnapshot(account, subaccountId);
  if (!validSnapshot(snapshot, account)) throw new Error('invalid_close_confirmation_evidence');
  return snapshot;
}

export function closeResultFromObservation(input: {
  account: string; market: string; baseline: CloseSnapshot; after: CloseSnapshot; settledAt: number;
}): CloseResult {
  const { account, market, baseline, after, settledAt } = input;
  const result: CloseResult = { outcome: 'unknown', account, market, reason: 'unqualified_close_observation',
    baseline: baseline.evidence, observation: after.evidence };
  if (!validSnapshot(baseline, account) || !validSnapshot(after, account)
    || baseline.evidence.lastOrderId === null || after.evidence.lastOrderId === null
    || baseline.evidence.account !== account || after.evidence.account !== account
    || baseline.evidence.environment !== after.evidence.environment
    || baseline.evidence.requestId === after.evidence.requestId || after.evidence.startedAt < settledAt
    || after.evidence.lastOrderId < baseline.evidence.lastOrderId) return result;
  const before = baseline.positions.find(p => p.internalSymbol === market)?.baseSize ?? 0;
  const remaining = after.positions.find(p => p.internalSymbol === market)?.baseSize ?? 0;
  if (!Number.isFinite(before) || !Number.isFinite(remaining) || before === 0) return result;
  if (remaining !== 0) return { ...result, outcome: 'partial', remainingSize: remaining, reason: 'residual_exposure' };
  if (!qualifiedFlatObservation(account, market, baseline, after, settledAt)) return result;
  return { ...result, outcome: 'confirmed', remainingSize: 0, reason: 'qualified_flat_observation' };
}

export function isConfirmedClose(result: CloseResult | undefined): boolean {
  return result?.outcome === 'confirmed';
}
