import { createHash } from 'node:crypto';
import { assertPhoenixIdentity } from './identity';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';

export type BorrowAction = 'open' | 'grow' | 'topup' | 'release' | 'repay' | 'unwind' | 'deploy';
export interface PhoenixBorrowIntent {
  version: 1; botId: string; ownerWallet: string; requestKey: string;
  identity: PhoenixTraderIdentity; accountAuthority: string;
  action: BorrowAction; collateralMint: string;
  accountLoanId: string | null; accountVenueId: number | null;
  botLoanId: string | null; botVenueId: number | null;
  amountRaw: string; collateralRaw: string; targetLtv: number;
  /** Explicit account-collateral consent, independent of the repayment reserve. */
  consent: { accountCollateral: boolean; reserve: boolean; deployBorrowed: boolean };
  reserveRaw: string;
  /** The measurement shown to the user, bound to this immutable request. */
  measurementHash: string | null;
}
export interface BorrowSnapshot {
  observedAt: number; oracleObservedAt: number; reference: string;
  authority: string; accountAuthority: string; collateralMint: string;
  accountLoanId: string | null; accountVenueId: number | null;
  botLoanId: string | null; botVenueId: number | null;
  debtRaw: string | null; collateralRaw: string | null;
  walletUsdcRaw: string; queuedUsdcRaw: string;
  /** Account lender, bot lender, wallet and U08 venue reads must all be complete. */
  complete: boolean; accountCarveAllowed: boolean; botHealthAllowed: boolean;
  measured: null | { samples: number; maxSeconds: number; observedAt: number; reference: string };
  queueCostRaw: string | null; expectedQueueSeconds: number | null;
}
export interface BorrowLiquidityPolicy {
  reviewed: boolean; maxAgeMs: number; measurementMaxAgeMs: number;
  maxQueueSeconds: number; maxQueueCostRaw: string; minimumReserveRaw: string;
  /** Fraction of fresh debt that must remain outside Phoenix, in liquid USDC. */
  reserveBps: number;
}
export function borrowHash(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function raw(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || value.includes('\n') || BigInt(value) > 18446744073709551615n) throw new Error('Invalid borrowing units');
  return BigInt(value);
}
export const addsBorrowRisk = (a: BorrowAction) => ['open', 'grow', 'topup', 'release', 'deploy'].includes(a);
export function validateBorrowIntent(i: PhoenixBorrowIntent) {
  assertPhoenixIdentity(i.identity);
  if (i.version !== 1 || !['open','grow','topup','release','repay','unwind','deploy'].includes(i.action)
    || !i.botId || !i.ownerWallet || !i.accountAuthority || i.accountAuthority === i.identity.authorityWalletAddress
    || i.accountAuthority === i.identity.traderAccountAddress || !i.collateralMint
    || !/^[A-Za-z0-9:_-]{1,120}$/.test(i.requestKey) || i.requestKey.includes('\n')
    || !Number.isFinite(i.targetLtv) || i.targetLtv <= 0 || i.targetLtv >= 1) throw new Error('Invalid Phoenix borrowing intent');
  [i.amountRaw, i.collateralRaw, i.reserveRaw].forEach(raw);
  if (!i.consent || Object.values(i.consent).length !== 3 || ['accountCollateral','reserve','deployBorrowed'].some(k => typeof (i.consent as any)[k] !== 'boolean')) throw new Error('Explicit boolean consent required');
  if (['open','grow','repay','deploy'].includes(i.action) && raw(i.amountRaw) === 0n || ['open','topup','release'].includes(i.action) && raw(i.collateralRaw) === 0n) throw new Error('Positive borrowing amount required');
  for (const [id, venue] of [[i.accountLoanId,i.accountVenueId],[i.botLoanId,i.botVenueId]] as const) {
    if ((id === null) !== (venue === null) || (venue !== null && (!Number.isSafeInteger(venue) || venue <= 0))) throw new Error('Loan identity incomplete');
  }
  if (i.action === 'open' ? i.botLoanId !== null || !i.accountLoanId : !i.botLoanId) throw new Error('Wrong loan scope');
  if (['open','grow','topup'].includes(i.action) && raw(i.collateralRaw) > 0n && (!i.consent.accountCollateral || !i.accountLoanId)) throw new Error('Account collateral consent required');
  if (i.action === 'unwind' && !i.accountLoanId) throw new Error('Bound account collateral return required');
  if (i.action === 'deploy' && (!i.consent.deployBorrowed || !i.consent.reserve || raw(i.reserveRaw) === 0n || !i.measurementHash)) throw new Error('Informed deployment and reserve consent required');
}
export function assertBorrowSnapshot(i: PhoenixBorrowIntent, s: BorrowSnapshot, now: number, maxAgeMs: number) {
  validateBorrowIntent(i);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !s.complete || !s.reference || !Number.isFinite(s.observedAt)
    || s.observedAt > now || now - s.observedAt > maxAgeMs || s.authority !== i.identity.authorityWalletAddress
    || s.accountAuthority !== i.accountAuthority || s.collateralMint !== i.collateralMint
    || s.botLoanId !== i.botLoanId || s.botVenueId !== i.botVenueId
    || s.accountLoanId !== i.accountLoanId || s.accountVenueId !== i.accountVenueId
    || s.debtRaw === null || s.collateralRaw === null) throw new Error('Fresh bound lender state required; loan remains recoverable');
  [s.debtRaw,s.collateralRaw,s.walletUsdcRaw,s.queuedUsdcRaw].forEach(raw);
  if (addsBorrowRisk(i.action) && (!Number.isFinite(s.oracleObservedAt) || s.oracleObservedAt > now || now - s.oracleObservedAt > maxAgeMs
    || !s.botHealthAllowed || (raw(i.collateralRaw) > 0n && !s.accountCarveAllowed))) throw new Error('Fresh lender oracle and health required');
}
export function authorizeDebtDeployment(i: PhoenixBorrowIntent, s: BorrowSnapshot, p: BorrowLiquidityPolicy, now: number) {
  assertBorrowSnapshot(i, s, now, p.maxAgeMs);
  const m = s.measured;
  if (i.action !== 'deploy' || !p.reviewed || !m || !Number.isSafeInteger(m.samples) || m.samples < 1 || !m.reference
    || !Number.isFinite(m.observedAt) || m.observedAt > now || now - m.observedAt > p.measurementMaxAgeMs
    || !Number.isFinite(p.measurementMaxAgeMs) || p.measurementMaxAgeMs <= 0
    || !Number.isFinite(p.maxQueueSeconds) || p.maxQueueSeconds <= 0
    || !Number.isFinite(m.maxSeconds) || m.maxSeconds < 0 || m.maxSeconds > p.maxQueueSeconds
    || borrowHash(m) !== i.measurementHash || s.expectedQueueSeconds === null || !Number.isFinite(s.expectedQueueSeconds)
    || s.expectedQueueSeconds < m.maxSeconds || s.expectedQueueSeconds > p.maxQueueSeconds || s.queueCostRaw === null
    || raw(s.queueCostRaw) > raw(p.maxQueueCostRaw) || !Number.isInteger(p.reserveBps) || p.reserveBps < 1 || p.reserveBps > 10000) throw new Error('Measured withdrawal delay and reviewed liquidity coverage required');
  const coverage = (raw(s.debtRaw!) * BigInt(p.reserveBps) + 9999n) / 10000n + raw(s.queueCostRaw);
  const floor = coverage > raw(p.minimumReserveRaw) ? coverage : raw(p.minimumReserveRaw);
  if (raw(i.reserveRaw) < floor || raw(s.walletUsdcRaw) < raw(i.amountRaw) + raw(i.reserveRaw)) throw new Error('Separate liquid repayment reserve insufficient');
  // queuedUsdcRaw and Phoenix margin never contribute to liquid coverage.
}
export function cappedRepayment(i: PhoenixBorrowIntent, s: BorrowSnapshot): bigint {
  if (s.debtRaw === null) throw new Error('Unknown debt');
  const debt = raw(s.debtRaw), requested = raw(i.amountRaw), cash = raw(s.walletUsdcRaw);
  const amount = requested < debt ? requested : debt;
  if (amount === 0n || amount > cash) throw new Error('Settled bot USDC required; queued cash cannot repay');
  return amount;
}
