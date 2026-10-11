import { Keypair } from '@solana/web3.js';
import type { BorrowVaultConfig } from '../../vault/jupiter-lend-borrow-route';
import { lendLegTerms, withPhoenixLendContext, type PhoenixLendContext } from '../../vault/phoenix-lend-context';
import { addsBorrowRisk, assertBorrowSnapshot, authorizeDebtDeployment, borrowHash, cappedRepayment, raw,
  type BorrowLiquidityPolicy, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';
import type { BorrowRepository } from './borrow-store';
import type { FundingIntent } from './funding-contract';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

export interface PhoenixBorrowIO {
  /** Bound to owner/session and existing lender vault + wallet allowlists. */
  eligible(i: PhoenixBorrowIntent): Promise<boolean>;
  enabled(): boolean;
  /** Reviewed U12 binding re-reads per-action opt-in, health, limits and reserve.
   * Required at every primitive and broadcast for an autonomous intent. */
  authorizeAutomatic?(i: PhoenixBorrowIntent, s: BorrowSnapshot): Promise<void>;
  snapshot(i: PhoenixBorrowIntent): Promise<BorrowSnapshot>;
  vault(i: PhoenixBorrowIntent): Promise<BorrowVaultConfig>;
  /** Uses U02 authenticated custody; callback receives disposable key copies. */
  custody<T>(i: PhoenixBorrowIntent, work: (keys: { account: Uint8Array; bot: Uint8Array }) => Promise<T>): Promise<T>;
  /** U04 immutable child, idempotent create/resume; queued is never settled cash. */
  deposit(i: PhoenixBorrowIntent, child: { borrowIntentId: string; requestKey: string; amountRaw: string }): Promise<{ success: boolean; finalized: boolean; operationId: string }>;
}
export type LendExecutors = Pick<typeof import('../../vault/jupiter-lend-perbot-carve'),
  'runPerbotCarveOpen' | 'runPerbotGrowLoan' | 'runPerbotCollateralTopUp' | 'runPerbotRemoveCollateral' | 'runPerbotUnwindClose'>
  & Pick<typeof import('../../vault/jupiter-lend-borrow-executor'), 'repayPartialOnExistingBotPosition'>;

const usdcMint = PHOENIX_PUBLIC_ADDRESSES.usdcMint;
const jsonResult = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => {
  if (/secret|private.?key/i.test(key) || v instanceof Uint8Array) throw new Error('Secret in lender result');
  return typeof v === 'bigint' ? { phoenixBigInt: v.toString() } : v;
}));
const restoreResult = (value: unknown) => JSON.parse(JSON.stringify(value), (_key,v) => v?.phoenixBigInt !== undefined ? BigInt(v.phoenixBigInt) : v);

/** One manual intent binds loan IDs, account carve, reserve and deployment consent.
 * Legacy multi-leg executors keep their journals; the outer journal adds durable
 * cross-process primitive claims and protects Phoenix reserves from other paths. */
export class PhoenixBorrowService {
  constructor(private readonly store: BorrowRepository, private readonly io: PhoenixBorrowIO,
    private readonly policy: BorrowLiquidityPolicy, private readonly now = Date.now,
    private readonly executors?: LendExecutors) {}
  private async fresh(i: PhoenixBorrowIntent) {
    if (addsBorrowRisk(i.action) && (!this.io.enabled() || !await this.io.eligible(i))) throw new Error('Phoenix new borrowing disabled or ineligible');
    const s = await this.io.snapshot(i);
    assertBorrowSnapshot(i,s,this.now(),this.policy.maxAgeMs);
    if (i.automation) {
      if (!this.io.authorizeAutomatic) throw new Error('Automatic defense binding unavailable');
      await this.io.authorizeAutomatic(i,s);
    }
    return s;
  }
  /** Wire into U04's authorizeBorrowDeployment using the persisted parent,
   * including for prepared-child recovery after process restart. */
  async authorizeFunding(parent: PhoenixBorrowIntent, child: FundingIntent) {
    const i = structuredClone(parent), r = await this.store.read(i);
    if (i.action !== 'deploy' || r.status === 'completed' || r.id !== child.borrowIntentId
      || child.botId !== i.botId || child.ownerWallet !== i.ownerWallet || borrowHash(child.identity) !== borrowHash(i.identity)
      || child.requestKey !== `${i.requestKey}:deposit` || child.amountBaseUnits !== i.amountRaw || child.borrowReserveRaw !== i.reserveRaw
      || child.kind !== 'deposit' || child.funding.leg !== 'deposit' || r.metadata.legs.deposit?.state !== 'claimed') throw new Error('Debt deployment parent binding mismatch');
    authorizeDebtDeployment(i,await this.fresh(i),this.policy,this.now());
  }
  async run(input: PhoenixBorrowIntent) {
    const i = structuredClone(input);
    // Recovery reads do not depend on the new-borrow gate or allowlist.
    let record;
    try { record = await this.store.read(i); } catch (error) {
      // prepare independently revalidates ownership, identity and replay terms;
      // it cannot replace a mismatched existing request.
      await this.fresh(i); record = await this.store.prepare(i);
    }
    if (record.status === 'completed') return record;
    try {
      if (i.action === 'deploy') {
        const child = {borrowIntentId:record.id,requestKey:`${i.requestKey}:deposit`,amountRaw:i.amountRaw};
        // U04's child journal owns submission/queue replay. Calling it again is
        // safe even when our process died after its durable create.
        const old = record.metadata.legs.deposit;
        if (!old) {
          const s = await this.fresh(i); authorizeDebtDeployment(i,s,this.policy,this.now());
          await this.store.claim(i,'deposit',child);
        }
        else if (old.termsHash !== borrowHash(child)) throw new Error('Debt deposit replay changed');
        if (old?.state !== 'completed') {
          // Observe an existing U04 child even after new borrowing is disabled.
          // U04 still requires authorizeFunding before any new signing attempt.
          const result = await this.io.deposit(i,child);
          if (!result.success || !result.finalized) { await this.store.finish(i,false); return this.store.read(i); }
          await this.store.complete(i,'deposit',result);
        }
      } else {
        await this.io.custody(i, async keys => {
          try {
            if (Keypair.fromSecretKey(keys.bot).publicKey.toBase58() !== i.identity.authorityWalletAddress
              || Keypair.fromSecretKey(keys.account).publicKey.toBase58() !== i.accountAuthority) throw new Error('Phoenix lender signer mismatch');
            const vault = await this.io.vault(i);
            if (vault.collateralMint !== i.collateralMint) throw new Error('Lender collateral mint mismatch');
            const executor = this.executors ?? {...await import('../../vault/jupiter-lend-perbot-carve'), ...await import('../../vault/jupiter-lend-borrow-executor')};
            const scope = this.scope(i,keys);
            const common = {walletAddress:i.ownerWallet,vault,accountPublicKey:i.accountAuthority,accountSecretKey:keys.account,
              botPublicKey:i.identity.authorityWalletAddress,botSecretKey:keys.bot,tradingBotId:i.botId,
              clientRequestId:`phoenix:${i.botId}:${i.requestKey}:lender`,targetLtv:i.targetLtv};
            const result = await withPhoenixLendContext(scope, async () => {
              // Existing lender implementations also re-read health immediately
              // before signing. This fresh bound snapshot is a second boundary.
              const s = await this.fresh(i);
              switch (i.action) {
                case 'open': return executor.runPerbotCarveOpen({...common,accountBorrowPositionId:i.accountLoanId!,accountVenuePositionId:i.accountVenueId!,
                  carveRaw:raw(i.collateralRaw),requestedDebtRaw:raw(i.amountRaw)});
                case 'grow': return executor.runPerbotGrowLoan({...common,accountBorrowPositionId:i.accountLoanId,accountVenuePositionId:i.accountVenueId,
                  botBorrowPositionId:i.botLoanId!,botVenuePositionId:i.botVenueId!,carveRaw:raw(i.collateralRaw),requestedDebtRaw:raw(i.amountRaw)});
                case 'topup': return executor.runPerbotCollateralTopUp({...common,botBorrowPositionId:i.botLoanId!,botVenuePositionId:i.botVenueId!,
                  sourceMint:i.collateralMint,sourceAmountRaw:raw(i.collateralRaw)});
                case 'release': return executor.runPerbotRemoveCollateral({...common,botBorrowPositionId:i.botLoanId!,accountBorrowPositionId:i.accountLoanId,
                  removeRaw:raw(i.collateralRaw)});
                case 'unwind': return executor.runPerbotUnwindClose({...common,botBorrowPositionId:i.botLoanId!,accountBorrowPositionId:i.accountLoanId!,accountVenuePositionId:i.accountVenueId!});
                case 'repay': {
                  const old = (await this.store.read(i)).metadata.legs.repay;
                  const amount = old ? BigInt(old.terms.amount as string) : cappedRepayment(i,s);
                  const target = old ? BigInt(old.terms.targetFinalDebtRaw as string) : raw(s.debtRaw!) - amount;
                  return scope.leg('repay',{...common,collateralMint:i.collateralMint,borrowPositionId:i.botLoanId!,amount,targetFinalDebtRaw:target},
                    executor.repayPartialOnExistingBotPosition);
                }
                default: throw new Error('Unsupported lender action');
              }
            });
            if (!result.success) throw new Error('Lender journal needs attention; resume the same request');
          } finally { keys.account.fill(0); keys.bot.fill(0); }
        });
      }
      await this.store.finish(i,true);
    } catch (error) { await this.store.finish(i,false); throw error; }
    return this.store.read(i);
  }
  private scope(i: PhoenixBorrowIntent, keys: {account: Uint8Array; bot: Uint8Array}): PhoenixLendContext {
    return {
      freshDebt: async () => raw((await this.fresh(i)).debtRaw!),
      leg: async <T>(kind: string, input: Record<string, any>, execute: (p: any) => Promise<T>): Promise<T> => {
        const p = {...input};
        const signer = p.agentPublicKey ?? p.botPublicKey;
        if (i.automation) {
          const allowed = i.action === 'repay' ? ['repay'] : ['transferTokenToWalletExact','supplyToExistingBotPosition'];
          if (!allowed.includes(kind) || (kind !== 'transferTokenToWalletExact' && signer !== i.identity.authorityWalletAddress)
            || (kind === 'transferTokenToWalletExact' && (signer !== i.accountAuthority || p.toWalletAddress !== i.identity.authorityWalletAddress))
            || (kind === 'supplyToExistingBotPosition' && (typeof p.collateralRaw !== 'bigint' || p.collateralRaw > raw(i.collateralRaw)))) {
            throw new Error('Automatic defense cannot borrow, carve, swap or subsidize repayment');
          }
        }
        if (![i.accountAuthority,i.identity.authorityWalletAddress].includes(signer)) throw new Error('Unbound lender signer');
        if (p.walletAddress && p.walletAddress !== i.ownerWallet || p.tradingBotId && p.tradingBotId !== i.botId) throw new Error('Lender account/bot isolation failure');
        if (p.borrowPositionId && ![i.botLoanId,i.accountLoanId].includes(p.borrowPositionId) && kind !== 'executeBorrowOpen') throw new Error('Lender loan identity mismatch');
        // Existing executors automatically top up gas. Self-funding prevents an
        // implicit account-to-bot subsidy, including on repay and close.
        const signerKey = signer === i.accountAuthority ? keys.account : keys.bot;
        p.funderPublicKey = signer; p.funderSecretKey = signerKey;
        if (['repay','supplyToExistingBotPosition','borrowMoreOnExistingBotPosition','withdrawFromExistingBotPosition'].includes(kind)) {
          p.accountPublicKey = signer; p.accountSecretKey = signerKey;
        }
        if (kind === 'executeAgentSwap') throw new Error('Phoenix collateral swaps require a separate explicit consent');
        if (kind === 'transferTokenToWalletExact') {
          if (![i.accountAuthority,i.identity.authorityWalletAddress].includes(p.toWalletAddress) || p.toWalletAddress === signer) throw new Error('Unbound collateral destination');
          if (signer === i.accountAuthority && (p.mint !== i.collateralMint || !i.consent.accountCollateral || p.amountRaw > raw(i.collateralRaw))) throw new Error('Account subsidy not authorized');
          if (p.mint !== i.collateralMint && p.mint !== usdcMint) throw new Error('Unbound lender mint');
        }
        const key = kind === 'repay' ? 'repay' : `${kind}:${signer === i.accountAuthority ? 'account' : 'bot'}`;
        const terms = lendLegTerms(kind,p);
        const existing = (await this.store.read(i)).metadata.legs[key];
        if (existing?.state === 'completed') {
          if (existing.termsHash !== borrowHash(terms)) throw new Error('Lender replay terms changed');
          return restoreResult(existing.result);
        }
        await this.fresh(i);
        const claim = await this.store.claim(i,key,terms);
        if (!claim.execute) return restoreResult(claim.leg.result);
        const before = p.onBeforeBroadcast;
        p.onBeforeBroadcast = async (info: {signature:string;lastValidBlockHeight:number}) => {
          if (i.automation) await this.fresh(i);
          await this.store.signature(i,key,info.signature,info.lastValidBlockHeight);
          if (before) await before(info);
        };
        const result: any = await execute(p);
        // An error/timeout without a signature is STILL ambiguous. Only an
        // authoritative reconciler may mark this attempt absent for retry.
        if (!result?.success || result.finalized === false) throw new Error('Lender leg outcome needs reconciliation');
        await this.store.complete(i,key,jsonResult(result));
        return result;
      },
    };
  }
}
