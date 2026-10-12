import { decideAutoRepay, decideAutoTopUp } from '../../vault/auto-topup';
import type { PerBotPositionHealth, TopUpSuggestion } from '../../vault/borrow-health';
import { assertBorrowSnapshot, borrowHash, raw, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';

export interface PhoenixDefenseFacts {
  /** Server-resolved loan/authority binding. Never an HTTP body. */
  intent: PhoenixBorrowIntent;
  snapshot: BorrowSnapshot;
  health: PerBotPositionHealth;
  suggestion: TopUpSuggestion | null;
  autoCollateralTopUp: boolean; autoRepayEnabled: boolean;
  heldAccountCollateralRaw: string;
  collateralPriceUsd: number; collateralDecimals: number;
  /** Persisted user authorization, independent of account-collateral consent. */
  reserveAuthorized: boolean;
  /** Reviewed per-attempt limits; zero disables the corresponding route. */
  maxTopupRaw: string; maxRepayRaw: string;
  maxAgeMs: number;
  previousAttemptAt: string | null;
}
export type PhoenixDefenseDecision = { action: 'skip' } | { action: 'needs_attention'; reason: string }
  | { action: 'execute'; intent: PhoenixBorrowIntent };

export function decidePhoenixDefense(f: PhoenixDefenseFacts, now: number): PhoenixDefenseDecision {
  if (!f.autoCollateralTopUp && !f.autoRepayEnabled) return {action:'skip'};
  const attention = (reason: string): PhoenixDefenseDecision => ({action:'needs_attention',reason});
  try {
    // Venue observation time is deliberately absent. Both lender and lender
    // oracle observations must be fresh even when the Phoenix stream is live.
    assertBorrowSnapshot({...f.intent,action:'repay',amountRaw:'1'},f.snapshot,now,f.maxAgeMs);
    if (f.health.borrowPositionId !== f.intent.botLoanId || f.health.venuePositionId !== f.intent.botVenueId
      || f.health.collateralMint !== f.intent.collateralMint || f.health.liveDebtRaw !== f.snapshot.debtRaw
      || f.health.liveCollateralRaw !== f.snapshot.collateralRaw) return attention('Bound lender health required');
    if (!Number.isFinite(f.snapshot.oracleObservedAt) || f.snapshot.oracleObservedAt > now
      || now - f.snapshot.oracleObservedAt > f.maxAgeMs || f.health.status !== 'available') return attention('Fresh lender health required');
    if (!f.reserveAuthorized) return attention('Liquid bot repayment route is not authorized');
    const previousAttemptAt = f.previousAttemptAt === null ? null : new Date(f.previousAttemptAt).toISOString();
    const cash = raw(f.snapshot.walletUsdcRaw);
    const base: PhoenixBorrowIntent = {...f.intent,requestKey:`auto:${borrowHash({loan:f.intent.botLoanId,previousAttemptAt})}`,
      amountRaw:'0',collateralRaw:'0',measurementHash:null,
      consent:{accountCollateral:false,reserve:true,deployBorrowed:false}};
    if (f.autoCollateralTopUp && f.intent.consent.accountCollateral && cash >= raw(f.intent.reserveRaw)
      && raw(f.intent.reserveRaw) > 0n && f.snapshot.botHealthAllowed && f.snapshot.accountCarveAllowed) {
      const held = raw(f.heldAccountCollateralRaw), cap = raw(f.maxTopupRaw);
      const topup = decideAutoTopUp({health:f.health,suggestion:f.suggestion,heldCollateralRaw:held < cap ? held : cap,
        collateralPriceUsd:f.collateralPriceUsd,collateralDecimals:f.collateralDecimals});
      if (topup.action === 'topup') return {action:'execute',intent:{...base,action:'topup',collateralRaw:topup.sourceAmountRaw.toString(),
        consent:{...base.consent,accountCollateral:true},automation:{kind:'defender',targetFinalDebtRaw:null}}};
      if (topup.action === 'skip' && !f.autoRepayEnabled) return {action:'skip'};
    }
    if (f.autoRepayEnabled) {
      const cap = raw(f.maxRepayRaw);
      // Only settled bot-wallet cash. No parked estimate, queue, account cash,
      // margin, swap, new loan or withdrawal request can supply this route.
      const repay = decideAutoRepay({health:f.health,debtRaw:raw(f.snapshot.debtRaw!),collateralRaw:raw(f.snapshot.collateralRaw!),
        collateralPriceUsd:f.collateralPriceUsd,collateralDecimals:f.collateralDecimals,debtDecimals:6,
        botIdleUsdcRaw:cash < cap ? cash : cap,targetLtv:f.intent.targetLtv});
      if (repay.action === 'repay') return {action:'execute',intent:{...base,action:'repay',amountRaw:repay.repayRaw.toString(),
        automation:{kind:'defender',targetFinalDebtRaw:(raw(f.snapshot.debtRaw!) - repay.repayRaw).toString()}}};
      if (repay.action === 'skip') return {action:'skip'};
    }
    return attention('No authorized liquid route; queued Phoenix returns cannot repay urgent debt');
  } catch { return attention('Lender state or authorized reserve unavailable'); }
}
