import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { identity, now } from '../helpers/phoenix-orders';
import { assertBorrowSnapshot, authorizeDebtDeployment, borrowHash, cappedRepayment, validateBorrowIntent,
  type PhoenixBorrowIntent, type BorrowSnapshot, type BorrowLiquidityPolicy } from '../../server/protocol/phoenix/borrow-contract';
import { phoenixBorrowCapabilities, createPhoenixBorrowRuntime } from '../../server/protocol/phoenix/borrow-runtime';
import { assessPhoenixEmpty, PHOENIX_RESIDUAL_DOMAINS } from '../../server/protocol/phoenix/lifecycle';
import { phoenixLendLeg, withPhoenixLendContext } from '../../server/vault/phoenix-lend-context';
import { createPhoenixBorrowRuntime } from '../../server/protocol/phoenix/borrow-runtime';

const account = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
describe('U11 receipt-bound post-borrow handoff',()=>{
  it('dispatches only completed open/grow outcomes, including recovery',async()=>{
    const intent=makeIntent({action:'open'}), postBorrow=vi.fn(async()=>{});
    const run=vi.fn(async()=>({status:'completed',id:'EXAMPLE-completed-borrow'}));
    const runtime=createPhoenixBorrowRuntime({run} as any,{intent:async()=>intent,postBorrow});
    await runtime.request(intent.ownerWallet,intent.botId,'resume',{});
    expect(postBorrow).toHaveBeenCalledWith(intent,'EXAMPLE-completed-borrow');
    run.mockResolvedValueOnce({status:'active',id:'EXAMPLE-completed-borrow'});
    await runtime.request(intent.ownerWallet,intent.botId,'resume',{});
    expect(postBorrow).toHaveBeenCalledTimes(1);
  });
});
const measurement = {samples:3,maxSeconds:60,observedAt:now,reference:'EXAMPLE-receipts'};
const makeIntent = (patch: Partial<PhoenixBorrowIntent> = {}): PhoenixBorrowIntent => ({version:1,botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',requestKey:'EXAMPLE-request',identity,
  accountAuthority:account,action:'deploy',collateralMint:'EXAMPLE-collateral',accountLoanId:'EXAMPLE-account-loan',accountVenueId:1,
  botLoanId:'EXAMPLE-bot-loan',botVenueId:2,amountRaw:'100',collateralRaw:'0',targetLtv:0.4,
  consent:{accountCollateral:true,reserve:true,deployBorrowed:true},reserveRaw:'110',measurementHash:borrowHash(measurement),...patch});
const snapshot = (patch: Partial<BorrowSnapshot> = {}): BorrowSnapshot => ({observedAt:now,oracleObservedAt:now,reference:'EXAMPLE-live',authority:identity.authorityWalletAddress,
  accountAuthority:account,collateralMint:'EXAMPLE-collateral',accountLoanId:'EXAMPLE-account-loan',accountVenueId:1,botLoanId:'EXAMPLE-bot-loan',botVenueId:2,
  debtRaw:'1000',collateralRaw:'2000',walletUsdcRaw:'210',queuedUsdcRaw:'0',complete:true,accountCarveAllowed:true,botHealthAllowed:true,
  measured:measurement,queueCostRaw:'10',expectedQueueSeconds:61,...patch});
const policy: BorrowLiquidityPolicy = {reviewed:true,maxAgeMs:15000,measurementMaxAgeMs:86400000,maxQueueSeconds:120,maxQueueCostRaw:'20',minimumReserveRaw:'50',reserveBps:1000};

describe('U11 external debt admission and recovery', () => {
  it('keeps production borrowing and recovery unavailable without reviewed bindings even with an env switch', () => {
    expect(phoenixBorrowCapabilities({PHOENIX_BORROW_ENABLED:'true'})).toMatchObject({newBorrowing:false,manualRecovery:false,phoenixMarginIsCollateral:false});
  });
  it('admits an informed deployment with a separate liquid reserve and real measured delay', () => {
    expect(() => authorizeDebtDeployment(makeIntent(),snapshot(),policy,now)).not.toThrow();
  });
  it.each([null,{...measurement,samples:0},{...measurement,observedAt:now-86400001},{...measurement,maxSeconds:121}])('denies missing, stale or excessive measured queue delay: %j', measured => {
    expect(() => authorizeDebtDeployment(makeIntent(),snapshot({measured}),policy,now)).toThrow();
  });
  it('does not replace explicit deployment and reserve funding consent with a policy decision', () => {
    for (const consent of [{accountCollateral:true,reserve:false,deployBorrowed:true},{accountCollateral:true,reserve:true,deployBorrowed:false}])
      expect(() => authorizeDebtDeployment(makeIntent({consent}),snapshot(),policy,now)).toThrow('consent');
  });
  it('binds consent to the delay that was shown and fails closed on missing costs', () => {
    expect(() => authorizeDebtDeployment(makeIntent({measurementHash:'EXAMPLE-other'}),snapshot(),policy,now)).toThrow();
    expect(() => authorizeDebtDeployment(makeIntent(),snapshot({queueCostRaw:null}),policy,now)).toThrow();
    expect(() => authorizeDebtDeployment(makeIntent(),snapshot(),{...policy,reviewed:false},now)).toThrow();
  });
  it('never counts queued withdrawal or margin as repayment reserve', () => {
    expect(() => authorizeDebtDeployment(makeIntent(),snapshot({walletUsdcRaw:'100',queuedUsdcRaw:'1000000'}),policy,now)).toThrow('reserve');
    expect(() => cappedRepayment(makeIntent({action:'repay'}),snapshot({walletUsdcRaw:'0',queuedUsdcRaw:'1000000'}))).toThrow('Settled');
  });
  it('caps repayments at current debt even if the original request is larger', () => {
    expect(cappedRepayment(makeIntent({action:'repay',amountRaw:'2000'}),snapshot({walletUsdcRaw:'3000',debtRaw:'175'}))).toBe(175n);
  });
  it('requires fresh lender oracle for new risk but permits repayment with stale oracle and fresh debt', () => {
    expect(() => assertBorrowSnapshot(makeIntent({action:'grow'}),snapshot({oracleObservedAt:now-15001}),now,15000)).toThrow('oracle');
    expect(() => assertBorrowSnapshot(makeIntent({action:'repay'}),snapshot({oracleObservedAt:now-15001}),now,15000)).not.toThrow();
    expect(() => assertBorrowSnapshot(makeIntent({action:'repay'}),snapshot({observedAt:now-15001}),now,15000)).toThrow('Fresh');
  });
  it.each(['authority','accountAuthority','accountLoanId','botLoanId','collateralMint'] as const)('rejects account/bot/loan isolation mismatch: %s', field => {
    expect(() => assertBorrowSnapshot(makeIntent(),snapshot({[field]:'EXAMPLE-wrong'}),now,15000)).toThrow('bound');
  });
  it('keeps unknown loans and dust debt/collateral out of destructive teardown', () => {
    const binding = {botId:'EXAMPLE-bot',authority:identity.authorityWalletAddress,trader:identity.traderAccountAddress};
    const proof = {...binding,observedAt:now,domains:Object.fromEntries(PHOENIX_RESIDUAL_DOMAINS.map(d=>[d,{complete:true,residual:'0'}]))};
    proof.domains.debt = {complete:true,residual:'1'};
    proof.domains.collateral = {complete:false,residual:'0'};
    expect(assessPhoenixEmpty(proof,binding,now)).toMatchObject({empty:false,blockers:['debt','collateral']});
    expect(() => assertBorrowSnapshot(makeIntent({action:'repay'}),snapshot({debtRaw:null}),now,15000)).toThrow('recoverable');
  });
  it('preserves legacy executor arguments and behavior outside a Phoenix context', async () => {
    const args = {accountPublicKey:'EXAMPLE-account',amount:3n}; let received: unknown;
    const wrapped = phoenixLendLeg('EXAMPLE-legacy',async p => {received=p;return {success:true};});
    expect(await wrapped(args)).toEqual({success:true}); expect(received).toBe(args);
    await withPhoenixLendContext({freshDebt:async()=>0n,leg:async()=>{throw new Error('EXAMPLE-guard');}},async()=>{
      await expect(wrapped(args)).rejects.toThrow('guard');
    });
    await expect(wrapped(args)).resolves.toEqual({success:true});
  });
  it('binds recovery route requests to their owner, bot and persisted action', async () => {
    const service = {run:async()=>({ok:true})};
    const runtime = createPhoenixBorrowRuntime(service as any,{intent:async()=>makeIntent({action:'repay'})});
    await expect(runtime.request('EXAMPLE-owner','EXAMPLE-bot','repay',{})).resolves.toEqual({ok:true});
    await expect(runtime.request('EXAMPLE-other','EXAMPLE-bot','resume',{})).rejects.toThrow('binding');
  });
  it('rejects changed grow identity, incomplete loan ids and account collateral without consent', () => {
    expect(() => validateBorrowIntent(makeIntent({action:'grow',botVenueId:null}))).toThrow();
    expect(() => validateBorrowIntent(makeIntent({action:'grow',collateralRaw:'10',consent:{accountCollateral:false,reserve:true,deployBorrowed:true}}))).toThrow('consent');
  });
});
