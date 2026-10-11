import { phoenixFeatureEnabled } from './rollout';
import type { BorrowPosition, TradingBot } from '../../../shared/schema';
import type { AutoDefenseCapabilities } from '../../vault/auto-defense-capabilities';
import { assertBorrowSnapshot, borrowHash, raw, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';
import type { PhoenixBorrowService } from './borrow-service';
import { decidePhoenixDefense, type PhoenixDefenseFacts } from './auto-defense-policy';

export interface PhoenixDefenseSource {
  enabled(): boolean;
  /** Fresh persisted flags, consent and limits plus bound lender/oracle reads. */
  facts(botId: string, loanId: string): Promise<PhoenixDefenseFacts>;
  /** Read U11 journals BEFORE proposing a new request. Includes needs_attention. */
  pending(botId: string, loanId: string): Promise<PhoenixBorrowIntent | null>;
  /** Durable, deduplicated needs-attention observation in the owning health path. */
  attention(botId: string, loanId: string, reason: string): Promise<void>;
}

/** Wire this same guard into U11 IO.authorizeAutomatic. It runs again immediately
 * before broadcast, so a queue/health/opt-in change after selection cannot spend. */
export function automaticDefenseAuthorizer(source: PhoenixDefenseSource, now = Date.now) {
  return async (i: PhoenixBorrowIntent, s: BorrowSnapshot) => {
    if (i.automation?.kind !== 'defender' || !i.botLoanId) throw new Error('Automatic defense intent required');
    const f = await source.facts(i.botId,i.botLoanId);
    assertBorrowSnapshot(i,s,now(),f.maxAgeMs);
    assertBorrowSnapshot(i,f.snapshot,now(),f.maxAgeMs);
    if (f.health.borrowPositionId !== i.botLoanId || f.health.venuePositionId !== i.botVenueId
      || f.health.collateralMint !== i.collateralMint || f.health.liveDebtRaw !== f.snapshot.debtRaw
      || f.health.liveCollateralRaw !== f.snapshot.collateralRaw) throw new Error('Bound lender health required');
    if (borrowHash(i.identity) !== borrowHash(f.intent.identity) || i.accountAuthority !== f.intent.accountAuthority
      || i.ownerWallet !== f.intent.ownerWallet || !f.reserveAuthorized
      || !Number.isFinite(s.oracleObservedAt) || s.oracleObservedAt > now() || now() - s.oracleObservedAt > f.maxAgeMs
      || !Number.isFinite(f.snapshot.oracleObservedAt) || f.snapshot.oracleObservedAt > now() || now() - f.snapshot.oracleObservedAt > f.maxAgeMs
      || f.health.status !== 'available' || f.health.liquidatable !== false) throw new Error('Fresh authorized lender health required');
    if (i.action === 'repay') {
      // Kill new risk without disabling an already authorized debt reduction.
      if (!f.autoRepayEnabled || raw(i.amountRaw) > raw(f.maxRepayRaw)
        || raw(s.walletUsdcRaw) < raw(i.amountRaw) || raw(f.snapshot.walletUsdcRaw) < raw(i.amountRaw)) throw new Error('Authorized liquid bot cash unavailable');
    } else if (i.action === 'topup') {
      if (!source.enabled() || !f.autoCollateralTopUp || !f.intent.consent.accountCollateral
        || raw(i.collateralRaw) > raw(f.maxTopupRaw) || raw(f.intent.reserveRaw) === 0n
        || raw(s.walletUsdcRaw) < raw(f.intent.reserveRaw) || raw(f.snapshot.walletUsdcRaw) < raw(f.intent.reserveRaw)) throw new Error('Top-up consent or liquid reserve unavailable');
    } else throw new Error('Automatic borrowing is forbidden');
  };
}

export interface PhoenixDefenseRuntime {
  capabilities(): AutoDefenseCapabilities;
  defend(position: BorrowPosition, bot: TradingBot): Promise<void>;
}
export function createPhoenixDefenseRuntime(service: Pick<PhoenixBorrowService,'run'>, source: PhoenixDefenseSource,
  now = Date.now): PhoenixDefenseRuntime {
  return {
    capabilities: () => ({topup:source.enabled(),repay:source.enabled()}),
    async defend(position,bot) {
      if (bot.activeProtocol !== 'phoenix' || position.kind !== 'borrow' || position.status !== 'open'
        || position.debtVenue !== 'jupiter_lend' || position.tradingBotId !== bot.id || position.walletAddress !== bot.walletAddress) return;
      try {
        const pending = await source.pending(bot.id,position.id);
        if (pending) {
          if (pending.automation?.kind !== 'defender' || pending.botId !== bot.id || pending.ownerWallet !== bot.walletAddress || pending.botLoanId !== position.id) throw new Error('Unresolved lender operation requires manual recovery');
          await service.run(pending); return;
        }
        if (!source.enabled()) return;
        const f = await source.facts(bot.id,position.id);
        if (f.intent.botId !== bot.id || f.intent.ownerWallet !== bot.walletAddress || f.intent.botLoanId !== position.id
          || String(f.intent.botVenueId) !== position.venuePositionId || f.intent.collateralMint !== position.collateralMint) throw new Error('Automatic loan binding mismatch');
        const decision = decidePhoenixDefense(f,now());
        if (decision.action === 'execute') await service.run(decision.intent);
        else if (decision.action === 'needs_attention') await source.attention(bot.id,position.id,decision.reason);
      } catch { await source.attention(bot.id,position.id,'Automatic defense needs attention; preserve the existing request for recovery'); }
    },
  };
}

// Off by default and deliberately uninstalled, like U11. An environment flag
// cannot manufacture the reviewed lender, consent, reserve or custody bindings.
const runtime: PhoenixDefenseRuntime | null = null;
export function phoenixDefenseCapabilities(env: NodeJS.ProcessEnv = process.env): AutoDefenseCapabilities {
  const installed = runtime as PhoenixDefenseRuntime | null;
  const caps = installed?.capabilities();
  return {topup:!!caps?.topup && phoenixFeatureEnabled('defense',env),repay:!!caps?.repay};
}
export async function dispatchPhoenixDefense(position: BorrowPosition, bot: TradingBot) {
  await (runtime as PhoenixDefenseRuntime | null)?.defend(position,bot);
}
