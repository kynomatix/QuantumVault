import { describe, expect, it, vi } from 'vitest';
describe('U16 graceful recovery-preserving shutdown',()=>{
  it('kills risk synchronously before drain and leaves recovery admitted',async()=>{
    vi.resetModules();const rollout=await import('../../server/protocol/phoenix/rollout');
    const {createGracefulHttpShutdown}=await import('../../server/graceful-http-shutdown');
    let closeCallback:((error?:Error)=>void)|undefined;
    const beforeStorageClose=vi.fn(async()=>{}),closeStorage=vi.fn(async()=>{});
    const run=createGracefulHttpShutdown({server:{close:vi.fn(cb=>{closeCallback=cb;})},beforeStorageClose,closeStorage,
      onTimeout:vi.fn(),onStorageTimeout:vi.fn(),timeoutMs:1000,storageTimeoutMs:1000});
    const env = {PHOENIX_NEW_RISK_ENABLED:'true',PHOENIX_OWNER_LAUNCH_AUTHORIZED:'true',PHOENIX_ENTRY_ENABLED:'true',
      PHOENIX_CANARY_POLICY:JSON.stringify({version:1,authorizationId:'EXAMPLE-launch',ownerWallet:'EXAMPLE-owner',
        botIds:['EXAMPLE-bot'],maxBots:1,expiresAt:Date.now()+60_000,stage:'trading',
        acceptedUnits:Array.from({length:16},(_,i)=>`U${String(i+1).padStart(2,'0')}`),reviewedDeployment:true,recoveryDrillPassed:true,
        caps:{maxRegistrationLamports:'100',maxTransferUsdcMicros:'100',maxExposureUsdcMicros:'1000',maxDebtUsdcMicros:'100',
          maxParkUsdcMicros:'100',maxCollateralRaw:'100',collateralMint:'EXAMPLE-mint',maxLeverage:'2'}})};
    const intent={ownerWallet:'EXAMPLE-owner',botId:'EXAMPLE-bot',notionalMicros:'100',leverage:'2'};
    expect(rollout.phoenixCanaryAllows('entry',intent,env)).toBe(true);
    const shutdown=run();
    expect(rollout.phoenixCanaryAllows('entry',intent,env)).toBe(false);
    expect(rollout.phoenixCanaryAllows('repay',{ownerWallet:'EXAMPLE-owner',botId:'EXAMPLE-bot'},{})).toBe(true);
    expect(beforeStorageClose).not.toHaveBeenCalled();
    closeCallback!();expect(await shutdown).toBe('drained');
    expect(beforeStorageClose).toHaveBeenCalledTimes(1);expect(closeStorage).toHaveBeenCalledTimes(1);
  });
});
