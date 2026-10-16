import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradingBot } from '../../shared/schema';
import { authority, identity, intent, now } from '../helpers/phoenix-orders';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import * as lab from '../../server/protocol/phoenix/lab-provenance';
import { dispatchPhoenixSignal, phoenixSignalIdentity, phoenixSignalStatus } from '../../server/protocol/phoenix/signal-runtime';
import { configurePhoenixSignal } from '../../server/protocol/phoenix/signal-control';
import { signalMicros, validatePhoenixSignalPolicy } from '../../server/protocol/phoenix/signal-policy';
import { botPolicyRecord } from '../../server/protocol/phoenix/policy';
const flags=vi.hoisted(()=>({allowed:true}));
vi.mock('../../server/protocol/phoenix/rollout',()=>({phoenixCanaryAllows:()=>flags.allowed}));

function bot(patch:Record<string,unknown>={}):TradingBot {
  return {id:'EXAMPLE-bot',walletAddress:'EXAMPLE-owner',activeProtocol:'phoenix',derivationIndex:1,...phoenixIdentityColumns(identity),
    name:'EXAMPLE Signal',botType:'signal',side:'both',market:'SOL',leverage:2,maxPositionSize:'10',totalInvestment:'10',
    riskConfig:{stopLossPercent:5,takeProfitPercent:10},signalConfig:null,isActive:true,executionActive:true,
    webhookSecret:'EXAMPLE',...patch} as TradingBot;
}
const payload=()=>({time:new Date(now).toISOString(),action:'buy'});
function record(i=intent(),state='admitted',data:Record<string,unknown>={}) {
  return {id:'EXAMPLE-order',intent:i,state,intent_hash:'EXAMPLE-intentHash',revision:0,data:{...data}} as any;
}
function runtime() {
  const events:string[]=[];
  const d={find:vi.fn(async()=>null as any),authorize:vi.fn(async()=>{events.push('authorize');}),
    snapshot:vi.fn(async()=>{events.push('snapshot');return authority();}),execute:vi.fn(async(i:any)=>{events.push('durable-service');return record(i);}),
    close:vi.fn(async()=>({positionClosed:false,state:'unknown'}))};
  return {d,events};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.stubEnv('PHOENIX_CANARY_MARKET','SOL');flags.allowed=true;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
describe('Phoenix fixed Signal boundary',()=>{
  it('keeps unlinked bots blocked despite an environment override',async()=>{
    vi.stubEnv('PHOENIX_LAB_PROVENANCE_ENABLED','true');
    expect(lab.phoenixLabProvenanceSatisfied(bot())).toMatchObject({satisfied:false,reason:'LAB_UNLINKED',message:'Find and confirm a Lab source in Settings before starting.'});
    const {d}=runtime();await expect(dispatchPhoenixSignal(bot(),payload(),d,now)).rejects.toThrow('LAB_UNLINKED');
    expect(d.authorize).toHaveBeenCalledOnce();expect(d.snapshot).not.toHaveBeenCalled();expect(d.execute).not.toHaveBeenCalled();
  });
  it('uses parsed bar time/action, normalizes equivalent times and refuses missing or invalid dates',()=>{
    const a=phoenixSignalIdentity(payload());
    expect(phoenixSignalIdentity({...payload(),time:payload().time.replace('.000Z','Z')})).toEqual(a);
    expect(phoenixSignalIdentity({time:payload().time,signalType:'trade',data:{action:'buy'}})).toEqual(a);
    expect(phoenixSignalIdentity({...payload(),position_size:0}).requestKey).not.toBe(a.requestKey);
    for(const p of [{action:'buy'},{time:'2026-02-30T00:00:00Z',action:'buy'},{time:now,action:'buy'},{...payload(),action:'BUY'}]) expect(()=>phoenixSignalIdentity(p)).toThrow('RELIABLE_SIGNAL_ID_REQUIRED');
  });
  it('returns the original duplicate before reauthorization, quotation or signing even paused and expired',async()=>{
    const {d}=runtime();const prior=record(intent({requestKey:phoenixSignalIdentity(payload()).requestKey}),'settled',{fills:[{fillId:'EXAMPLE-fill'}]});
    d.find.mockResolvedValue(prior);
    const result=await dispatchPhoenixSignal(bot({isActive:false,executionActive:false}),payload(),d,now+999999);
    expect(result).toMatchObject({duplicate:true,signal:{id:prior.id,status:'filled'}});
    expect(d.execute).not.toHaveBeenCalled();expect(d.snapshot).not.toHaveBeenCalled();expect(d.authorize).not.toHaveBeenCalled();
  });
  it('rejects cross-owner replay and absent reliable identity before any execution',async()=>{
    const {d}=runtime();d.find.mockResolvedValue(record(intent({ownerWallet:'EXAMPLE-other'})));
    await expect(dispatchPhoenixSignal(bot(),payload(),d,now)).rejects.toThrow('OWNER_MISMATCH');
    await expect(dispatchPhoenixSignal(bot(),{action:'buy'},d,now)).rejects.toThrow('RELIABLE_SIGNAL_ID_REQUIRED');expect(d.execute).not.toHaveBeenCalled();
  });
  it('uses stored sizing/risk and native quote instead of hostile webhook amounts and prices',async()=>{
    vi.spyOn(lab,'phoenixLabProvenanceSatisfied').mockReturnValue({satisfied:true,reason:null,message:''});
    const {d,events}=runtime();await dispatchPhoenixSignal(bot(),{...payload(),price:1,quantity:999999,leverage:100,stopLoss:0,takeProfit:0},d,now);
    const i=d.execute.mock.calls[0][0];expect(i).toMatchObject({action:'entry',side:'buy',leverage:'2',maxNotionalMicros:'10000000',baseUnits:'0.06',sequence:String(BigInt(now)*4n),lastValidSlot:'120',protection:{tp:{triggerTicks:'16500'},sl:{triggerTicks:'14250'}}});
    expect(events).toEqual(['authorize','snapshot','durable-service']);
  });
  it('refuses disabled, stale, side-mismatched and over-cap entries',async()=>{
    const {d}=runtime();await expect(dispatchPhoenixSignal(bot({isActive:false}),payload(),d,now)).rejects.toThrow('ACTIVE_AUTHORIZED');
    vi.spyOn(lab,'phoenixLabProvenanceSatisfied').mockReturnValue({satisfied:true,reason:null,message:''});
    await expect(dispatchPhoenixSignal(bot(),payload(),d,now+300001)).rejects.toThrow('TIME_OUTSIDE');
    await expect(dispatchPhoenixSignal(bot({side:'short'}),payload(),d,now)).rejects.toThrow('SIDE_REFUSED');
    flags.allowed=false;expect(()=>validatePhoenixSignalPolicy(bot())).toThrow('ENTRY_DISABLED');
    expect(()=>signalMicros('1e9')).toThrow();expect(()=>validatePhoenixSignalPolicy(bot({maxPositionSize:'21'}))).toThrow('FIXED_SIGNAL_ONLY');
    expect(d.execute).not.toHaveBeenCalled();
  });
  it('passes the same durable identity to reduce-only close, never sizing it as an entry',async()=>{
    vi.spyOn(lab,'phoenixLabProvenanceSatisfied').mockReturnValue({satisfied:true,reason:null,message:''});
    const {d}=runtime(),p={...payload(),position_size:0};await dispatchPhoenixSignal(bot(),p,d,now);
    const s=phoenixSignalIdentity(p);expect(d.close).toHaveBeenCalledWith(expect.anything(),s.requestKey,s.sequence);expect(d.snapshot).not.toHaveBeenCalled();expect(d.execute).not.toHaveBeenCalled();
  });
  it('reports accepted/submitted/filled/rejected/unknown without treating an ACK as a fill',()=>{
    expect(['admitted','accepted','settled','rejected','unknown'].map(s=>phoenixSignalStatus(record(intent(),s)))).toEqual(['accepted','submitted','submitted','rejected','unknown']);
    expect(phoenixSignalStatus(record(intent(),'settled',{fills:[{}]}))).toBe('filled');
  });
  it('authenticates fixed capital, side and native TP/SL while retaining legacy policy bytes',()=>{
    const original=botPolicyRecord(bot());
    for(const patch of [{totalInvestment:'11'},{side:'short'},{riskConfig:{stopLossPercent:6,takeProfitPercent:10}}]) expect(botPolicyRecord(bot(patch))).not.toEqual(original);
    const legacy={activeProtocol:'pacifica',market:'SOL',leverage:2,maxPositionSize:'10'} as any;
    expect(botPolicyRecord(legacy)).toEqual({market:'SOL',leverage:2,maxPositionSize:'10'});
  });
});

function control(options:{funded?:boolean;conditional?:boolean;owned?:boolean}={}) {
  const b=bot({isActive:false,executionActive:false}),sql:string[]=[],updates:any[]=[];
  const row=Object.fromEntries(Object.entries(b).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
  const client={release:vi.fn(),query:vi.fn(async(q:string,p?:unknown[])=>{sql.push(q);
    if(q.startsWith('SELECT * FROM trading_bots'))return {rows:options.owned===false?[]:[row]};
    if(q.startsWith('SELECT id FROM phoenix_operations'))return {rows:options.funded===false?[]:[{id:'EXAMPLE-deposit'}]};
    if(q.startsWith('UPDATE trading_bots'))updates.push(p);return {rows:[]};})};
  const io={authorize:vi.fn(async()=>{}),policyHmac:vi.fn(async()=> 'EXAMPLE-policyHmac'),snapshot:vi.fn(async()=>{const a=authority();if(options.conditional===false)a.protection!.conditionalExists=false;return a;})};
  return {pool:{connect:async()=>client} as any,io,sql,updates,client};
}
describe('atomic owned configure/start',()=>{
  it('commits authenticated fixed configuration with a fresh secret while inactive',async()=>{
    const c=control(),first=await configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{name:'EXAMPLE-renamed'});
    const second=await configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{name:'EXAMPLE-renamed'});
    expect(first.isActive).toBe(false);expect(first.webhookSecret).toHaveLength(43);expect(second.webhookSecret).not.toBe(first.webhookSecret);
    expect(first.start.reason).toBe('LAB_UNLINKED');expect(c.sql.at(-1)).toBe('COMMIT');expect(c.updates[0][9]).toBe(false);
    expect(c.sql[1]).toContain('wallet_address=$2 FOR UPDATE');expect(c.io.policyHmac).toHaveBeenCalledWith(expect.objectContaining({name:'EXAMPLE-renamed'}));
  });
  it('reaches the Lab gate after all readiness checks and rolls back activation atomically',async()=>{
    const c=control();await expect(configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{isActive:true})).rejects.toThrow('LAB_UNLINKED');
    expect(c.io.snapshot).toHaveBeenCalledTimes(2);expect(c.io.policyHmac).toHaveBeenCalledOnce();expect(c.updates).toEqual([]);expect(c.sql.at(-1)).toBe('ROLLBACK');expect(c.client.release).toHaveBeenCalledOnce();
  });
  it.each([{funded:false},{conditional:false},{owned:false}])('refuses missing prerequisite %j without a partial config write',async option=>{
    const c=control(option);await expect(configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{isActive:true})).rejects.toThrow();expect(c.updates).toEqual([]);expect(c.sql.at(-1)).toBe('ROLLBACK');
  });
  it('refuses unknown keys and a market switch before changing policy',async()=>{
    const c=control();await expect(configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{webhookSecret:'EXAMPLE'})).rejects.toThrow('CONFIGURATION_REFUSED');
    await expect(configurePhoenixSignal(c.pool,c.io,'EXAMPLE-owner','EXAMPLE-bot',{market:'BTC'})).rejects.toThrow('CONFIGURATION_REFUSED');expect(c.updates).toEqual([]);
  });
});
