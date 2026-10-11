import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defenseFacts } from '../helpers/phoenix-defense';
import { now } from '../helpers/phoenix-orders';
import { decidePhoenixDefense } from '../../server/protocol/phoenix/auto-defense-policy';
import { automaticDefenseAuthorizer, createPhoenixDefenseRuntime, phoenixDefenseCapabilities, type PhoenixDefenseSource } from '../../server/protocol/phoenix/auto-defense-runtime';
import { autoDefenseProtocols, autoDefenseOptedIn } from '../../server/vault/auto-defense-capabilities';
import { cappedRepayment } from '../../server/protocol/phoenix/borrow-contract';

function proposal(f = defenseFacts()) {
  const d = decidePhoenixDefense(f,now);
  if (d.action !== 'execute') throw new Error('EXAMPLE-proposal-required');
  return d.intent;
}
describe('U12 autonomous debt policy',()=>{
  it('considers opted-in repayment when top-up has no suggestion',()=>{
    const f=defenseFacts(); f.suggestion=null;
    expect(proposal(f).action).toBe('repay');
  });
  it('canonicalizes persisted attempt time before binding the request key',()=>{
    const f=defenseFacts(); f.previousAttemptAt='2026-10-11T10:00:00+10:00';
    const first=proposal(f).requestKey; f.previousAttemptAt='2026-10-11T00:00:00.000Z';
    expect(proposal(f).requestKey).toBe(first);
    f.previousAttemptAt='EXAMPLE-invalid-time';
    expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('keeps production disabled even with the environment switch and gates candidate actions independently',()=>{
    expect(phoenixDefenseCapabilities({PHOENIX_AUTO_DEFENSE_ENABLED:'true'})).toEqual({topup:false,repay:false});
    expect(autoDefenseProtocols({topup:false,repay:false})).toEqual(['flash']);
    expect(autoDefenseProtocols({topup:false,repay:true})).toContain('phoenix');
    expect(autoDefenseOptedIn({autoCollateralTopUp:true,autoRepayEnabled:false},{topup:false,repay:true})).toBe(false);
    expect(autoDefenseOptedIn({autoCollateralTopUp:false,autoRepayEnabled:true},{topup:false,repay:true})).toBe(true);
  });
  it('prefers capped authorized account collateral and never adds debt',()=>{
    const i=proposal();expect(i).toMatchObject({action:'topup',collateralRaw:'20000000',amountRaw:'0',consent:{accountCollateral:true,deployBorrowed:false}});
  });
  it('repay-only opt-in spends capped bot cash without account consent',()=>{
    const f=defenseFacts();f.autoCollateralTopUp=false;
    expect(proposal(f)).toMatchObject({action:'repay',amountRaw:'30000000',collateralRaw:'0',consent:{accountCollateral:false},automation:{targetFinalDebtRaw:'60000000'}});
  });
  it('does not silently fall back to repayment when repayment is opted out',()=>{
    const f=defenseFacts();f.autoRepayEnabled=false;f.heldAccountCollateralRaw='0';
    expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('keeps both opt-outs silent',()=>{
    const f=defenseFacts();f.autoRepayEnabled=false;f.autoCollateralTopUp=false;
    expect(decidePhoenixDefense(f,now)).toEqual({action:'skip'});
  });
  it.each(['observedAt','oracleObservedAt'] as const)('refuses stale lender %s even with a queued return',field=>{
    const f=defenseFacts();f.snapshot[field]=now-15001;f.snapshot.queuedUsdcRaw='1000000000';
    expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('never substitutes queued cash or account collateral for bot repayment liquidity',()=>{
    const f=defenseFacts();f.autoCollateralTopUp=false;f.snapshot.walletUsdcRaw='0';f.snapshot.queuedUsdcRaw='1000000000';
    expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('refuses new top-up risk without a liquid reserve but can repay from a smaller balance',()=>{
    const f=defenseFacts();f.snapshot.walletUsdcRaw='5000000';
    expect(proposal(f)).toMatchObject({action:'repay',amountRaw:'5000000'});
    f.autoRepayEnabled=false;expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('requires independent reserve authorization and matching health identity',()=>{
    const f=defenseFacts();f.reserveAuthorized=false;expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
    f.reserveAuthorized=true;f.health.borrowPositionId='EXAMPLE-other';expect(decidePhoenixDefense(f,now).action).toBe('needs_attention');
  });
  it('preserves request identity through repeated observations and preserves its debt floor',()=>{
    const f=defenseFacts();f.autoCollateralTopUp=false;const i=proposal(f);
    f.snapshot.queuedUsdcRaw='1000000';expect(proposal(f).requestKey).toBe(i.requestKey);
    expect(cappedRepayment(i,{...f.snapshot,debtRaw:'70000000'})).toBe(10000000n);
    expect(()=>cappedRepayment(i,{...f.snapshot,debtRaw:'60000000'})).toThrow();
  });
  it('rechecks opt-out, reserve and health transitions at the execution boundary',async()=>{
    const f=defenseFacts(),i=proposal(f);
    const source: PhoenixDefenseSource={enabled:()=>true,facts:async()=>f,
      pending:async()=>{throw new Error('Unexpected pending read');},attention:async()=>{throw new Error('Unexpected attention');}};
    const guard=automaticDefenseAuthorizer(source,()=>now);
    await expect(guard(i,f.snapshot)).resolves.toBeUndefined();
    f.snapshot.walletUsdcRaw='0';f.snapshot.queuedUsdcRaw='1000000000';await expect(guard(i,f.snapshot)).rejects.toThrow('reserve');
    f.snapshot.walletUsdcRaw='50000000';f.autoCollateralTopUp=false;await expect(guard(i,f.snapshot)).rejects.toThrow('consent');
    f.autoCollateralTopUp=true;f.snapshot.oracleObservedAt=now-15001;await expect(guard(i,f.snapshot)).rejects.toThrow();
  });
  it('allows pending repayment recovery after the new-risk switch is disabled',async()=>{
    const f=defenseFacts();f.autoCollateralTopUp=false;const i=proposal(f);let calls=0;
    const source={enabled:()=>false,facts:async()=>f,pending:async()=>i,attention:async()=>{throw new Error('Unexpected attention');}};
    await expect(automaticDefenseAuthorizer(source,()=>now)(i,f.snapshot)).resolves.toBeUndefined();
    const runtime=createPhoenixDefenseRuntime({run:async(received)=>{expect(received).toEqual(i);calls++;return {} as any;}},source,()=>now);
    await runtime.defend({id:i.botLoanId,kind:'borrow',status:'open',debtVenue:'jupiter_lend',tradingBotId:i.botId,walletAddress:i.ownerWallet} as any,
      {id:i.botId,walletAddress:i.ownerWallet,activeProtocol:'phoenix'} as any);
    expect(calls).toBe(1);
  });
  it.each([{kind:'loop',tradingBotId:'EXAMPLE-bot'},{kind:'borrow',tradingBotId:null}])('never steals account/managed SOL-loop ownership: %j',row=>{
    const runtime=createPhoenixDefenseRuntime({run:async()=>{throw new Error('Unexpected spend');}},
      {enabled:()=>true,pending:async()=>{throw new Error('Unexpected loop read');},facts:async()=>defenseFacts(),attention:async()=>{throw new Error('Unexpected attention');}});
    return runtime.defend({...row,status:'open',debtVenue:'jupiter_lend',walletAddress:'EXAMPLE-owner'} as any,
      {id:'EXAMPLE-bot',walletAddress:'EXAMPLE-owner',activeProtocol:'phoenix'} as any);
  });
  it('wires capability selection and Phoenix dispatch before legacy account-wallet reads',()=>{
    const storage=readFileSync('server/storage.ts','utf8'),routes=readFileSync('server/routes.ts','utf8');
    const selector=storage.slice(storage.indexOf('async getAutoTopUpCandidatePositions()'),storage.indexOf('async claimBorrowPositionAutoTopupAttempt('));
    expect(selector).toContain('autoDefenseProtocols(phoenix)');expect(selector).toContain("eq(borrowPositions.kind, 'borrow')");
    const defender=routes.slice(routes.indexOf('async function defendOneLoanAutonomously('));
    expect(defender.indexOf('dispatchPhoenixDefense(position,bot)')).toBeLessThan(defender.indexOf('storage.getWallet('));
  });
});
