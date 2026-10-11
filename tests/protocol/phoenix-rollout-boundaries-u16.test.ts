import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoenixOrderService, type PhoenixOrderIO } from '../../server/protocol/phoenix/order-service';
import { signOrderTransaction } from '../../server/protocol/phoenix/order-builder';
import type { OrderRepository, PhoenixOrderRecord } from '../../server/protocol/phoenix/order-store';
import { PHOENIX_RISK_FLAGS, type PhoenixCanaryPolicy } from '../../server/protocol/phoenix/rollout';
import { authority, intent, lifetime, now, pin } from '../helpers/phoenix-orders';
vi.mock('../../server/protocol/phoenix/order-builder',async importOriginal=>({
  ...await importOriginal<typeof import('../../server/protocol/phoenix/order-builder')>(),
  signOrderTransaction:vi.fn(()=>({transaction:'EXAMPLE-transaction',signature:'EXAMPLE-signature',
    blockhash:'EXAMPLE-blockhash',lastValidBlockHeight:'500',transactionHash:'EXAMPLE-transaction-digest'})),
}));
function grant() {
  const p:PhoenixCanaryPolicy={version:1,authorizationId:'EXAMPLE-owner-launch',ownerWallet:'EXAMPLE-owner',botIds:['EXAMPLE-bot'],maxBots:1,
    expiresAt:now+60000,stage:'trading',acceptedUnits:Array.from({length:16},(_,i)=>`U${String(i+1).padStart(2,'0')}`),reviewedDeployment:true,
    recoveryDrillPassed:true,caps:{maxRegistrationLamports:'100',maxTransferUsdcMicros:'1000000000',maxExposureUsdcMicros:'1000000000',
      maxDebtUsdcMicros:'100',maxParkUsdcMicros:'100',maxCollateralRaw:'100',collateralMint:'EXAMPLE-mint',maxLeverage:'2'}};
  vi.stubEnv('PHOENIX_CANARY_POLICY',JSON.stringify(p));vi.stubEnv('PHOENIX_NEW_RISK_ENABLED','true');
  vi.stubEnv('PHOENIX_OWNER_LAUNCH_AUTHORIZED','true');for(const flag of Object.values(PHOENIX_RISK_FLAGS))vi.stubEnv(flag,'true');
}
function harness(killAt?: 'prepare'|'lifetime'|'signer'|'journal') {
  let row:PhoenixOrderRecord|undefined;
  const snapshot={...authority(),canaryExposureMicros:'0'};
  const kill=()=>vi.stubEnv('PHOENIX_NEW_RISK_ENABLED','false');
  const store:OrderRepository={find:vi.fn(async()=>row?structuredClone(row):null),read:vi.fn(async()=>structuredClone(row!)),
    prepare:vi.fn(async(i,admission)=>{row={id:'EXAMPLE-order',intent:i,intent_hash:'EXAMPLE-intent-hash',state:'admitted',revision:0,data:{admission}};
      if(killAt==='prepare')kill();return {record:structuredClone(row),created:true};}),
    change:vi.fn(async(r,state,patch)=>{row={...r,state,revision:r.revision+1,data:{...r.data,...patch}};
      if(killAt==='journal'&&state==='submission_pending')kill();return structuredClone(row);})};
  const io:PhoenixOrderIO={snapshot:vi.fn(async()=>structuredClone(snapshot)),fund:vi.fn(),
    lifetime:vi.fn(async()=>{if(killAt==='lifetime')kill();return lifetime;}),blockHeight:vi.fn(async()=>400),
    withSigner:vi.fn(async(_i,fn)=>{if(killAt==='signer')kill();return fn(new Uint8Array());}),
    submit:vi.fn(async()=> 'EXAMPLE-signature'),receipt:vi.fn(async()=>null)};
  return {service:new PhoenixOrderService(store,io,pin,()=>true,()=>now),store,io,snapshot};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.clearAllMocks();vi.stubEnv('PHOENIX_CANARY_POLICY','');});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe('U16 real gate at execution boundaries',()=>{
  it('cannot activate an injected service with its old enabled callback alone',async()=>{
    const h=harness();await expect(h.service.execute(intent())).rejects.toThrow('disabled');
    expect(h.io.withSigner).not.toHaveBeenCalled();expect(h.io.submit).not.toHaveBeenCalled();
  });
  it('allows the approved bounded owner entry with fake IO only',async()=>{
    grant();const h=harness();expect((await h.service.execute(intent())).state).toBe('accepted');
    expect(h.io.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['prepare','lifetime','signer','journal'] as const)('kill at %s prevents send, retaining any attempted signature',async at=>{
    grant();const h=harness(at);const r=await h.service.execute(intent());
    expect(h.io.submit).not.toHaveBeenCalled();expect(['rejected','signing','unknown']).toContain(r.state);
    if(at==='journal')expect(r.data.attempt?.signature).toBe('EXAMPLE-signature');
    else expect(signOrderTransaction).not.toHaveBeenCalled();
  });
  it('rejects missing all-market exposure and aggregate cap excess before prepare',async()=>{
    grant();const h=harness();delete (h.snapshot as {canaryExposureMicros?:string}).canaryExposureMicros;
    await expect(h.service.execute(intent())).rejects.toThrow('exposure');expect(h.store.prepare).not.toHaveBeenCalled();
    h.snapshot.canaryExposureMicros='1';await expect(h.service.execute(intent())).rejects.toThrow('exposure');
  });
  it('permits reduce-only close after grant removal and kill',async()=>{
    const h=harness();h.snapshot.position={...h.snapshot.position,side:'long',baseLots:'200'};
    vi.stubEnv('PHOENIX_NEW_RISK_ENABLED','false');
    await h.service.execute(intent({action:'close',side:'sell',baseUnits:'2',protection:undefined}));
    expect(h.io.submit).toHaveBeenCalledTimes(1);
  });
});
