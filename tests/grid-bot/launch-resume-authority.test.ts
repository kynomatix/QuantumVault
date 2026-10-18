import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import Decimal from 'decimal.js';
import {gridProductionResume,GridLaunchAuthority} from '../../server/grid-bot/launch-authority';
import {gridResumeClearance} from '../../server/grid-bot/lifecycle-service';
import {preflightGridResume,preflightGridLaunch} from '../../server/grid-bot/provision';
import {launchAuthorityFixture,retainedFixture,clock,umk} from './launch-authority-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const f=launchAuthorityFixture(),row=retainedFixture(f),key=umk(),cleanup=vi.fn(()=>key.fill(0));
  const claim={id:f.policy.id,account:f.account.account,masterAccount:f.account.masterAccount,leaseToken:f.account.leaseToken};
  const storage={snapshot:vi.fn(async()=>structuredClone(row) as never)},security=vi.fn(async()=>({umk:key,cleanup}));
  const run=()=>gridProductionResume(storage,f.authority,security)(claim,new AbortController().signal);
  return {...f,row,claim,key,keyCleanup:cleanup,storage,security,run};
}
describe('C5 retained production resume',()=>{
  it('revalidates exact retained policy and transfers UMK ownership only on success',async()=>{
    const f=fixture(),result=await f.run();expect(result).not.toBeNull();
    expect(result!.policy).toEqual(f.policy);expect(result!.policyHmac).toBe(f.policyHash);
    expect(result!.facts.account).toBe(f.claim.account);expect(result!.risk).toMatchObject({account:f.claim.account,symbol:'BTC',positionSize:'0',liquidationPrice:null,observedAt:clock});
    expect(f.storage.snapshot).toHaveBeenCalledTimes(2);expect(f.security).toHaveBeenCalledWith(f.account.wallet);
    expect(f.cleanup).toHaveBeenCalledOnce();expect(f.keyCleanup).not.toHaveBeenCalled();
    result!.cleanup();expect(f.keyCleanup).toHaveBeenCalledOnce();expect(f.key.every(v=>v===0)).toBe(true);
  });
  it('supplies fresh actual liquidation instead of reusing the launch projection',async()=>{
    const f=fixture();f.raw.sub.positions_count=1;
    f.raw.positions=[{account:f.claim.account,symbol:'BTC',side:'bid',amount:'1',liquidation_price:'79.9',updated_at:clock}];
    const result=await f.run();expect(result).not.toBeNull();expect(result!.risk.liquidationPrice).toBe('79.9');
    expect(gridResumeClearance(result!.risk,{account:f.claim.account,symbol:'BTC',position:{direction:'long',size:'1'},observedAt:clock} as never,f.policy,'0.01',clock)).toBe(false);
    result!.cleanup();
  });
  it.each(['missing UMK','bad HMAC','changed policy','changed account','changed master','missing liquidation','wrong leverage','generation revoked','read failure'])('blocks %s and cleans every acquired secret',async defect=>{
    const f=fixture();
    if(defect==='missing UMK')f.security.mockResolvedValueOnce(null as never);
    if(defect==='bad HMAC')f.row.bot.policy_hmac='EXAMPLE_INVALID_HASH';
    if(defect==='changed policy')f.row.levels[0].size='999.00000000';
    if(defect==='changed account')f.row.bot.account='EXAMPLE_OTHER';
    if(defect==='changed master')f.row.bot.master_account='EXAMPLE_OTHER';
    if(defect==='wrong leverage')f.raw.settings.margin_settings[0].leverage=3;
    if(defect==='generation revoked')f.current.mockResolvedValue(false);
    if(defect==='read failure')vi.mocked(f.deps.reads.json).mockRejectedValue(Error('EXAMPLE failure'));
    if(defect==='missing liquidation'){f.raw.sub.positions_count=1;f.raw.positions=[{symbol:'BTC',side:'bid',amount:'1',liquidation_price:null,updated_at:clock}];}
    expect(await f.run()).toBeNull();
    if(!['missing UMK','changed account','changed master'].includes(defect)){expect(f.keyCleanup).toHaveBeenCalledOnce();expect(f.key.every(v=>v===0)).toBe(true);}
    if(['bad HMAC','changed policy','changed account','changed master','missing UMK'].includes(defect))expect(f.deps.reads.json).not.toHaveBeenCalled();
  });
  it.each(['policy','signature','wallet','account','master','status'])('detects a retained %s change during observation',async field=>{
    const f=fixture(),changed=structuredClone(f.row);
    if(field==='policy')changed.levels[0].price='1.00000000';
    if(field==='signature')changed.bot.policy_hmac='EXAMPLE_CHANGED_HASH';
    if(field==='wallet')changed.bot.wallet_address='EXAMPLE_OTHER';
    if(field==='account')changed.bot.account='EXAMPLE_OTHER';
    if(field==='master')changed.bot.master_account='EXAMPLE_OTHER';
    if(field==='status')changed.bot.status='stopping';
    f.storage.snapshot.mockResolvedValueOnce(structuredClone(f.row) as never).mockResolvedValueOnce(changed as never);
    expect(await f.run()).toBeNull();expect(f.keyCleanup).toHaveBeenCalledOnce();expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('cleans UMK and signing key on abort without converting abort into authority',async()=>{
    const f=fixture(),controller=new AbortController();f.current.mockImplementationOnce(async()=>{controller.abort();return true;});
    await expect(gridProductionResume(f.storage,new GridLaunchAuthority(f.deps),f.security)(f.claim,controller.signal)).rejects.toThrow();
    expect(f.keyCleanup).toHaveBeenCalledOnce();expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

describe('Resume admission uses current rolling inventory rather than original Start',()=>{
  async function current(book:string,investment='100'){
    const f=launchAuthorityFixture(false,investment);f.raw.book={s:'BTC',t:clock,l:[[{p:new Decimal(book).minus('0.01').toFixed(2),a:'1'}],[{p:new Decimal(book).plus('0.01').toFixed(2),a:'1'}]]};
    const result=await f.authority.collect(f.account.wallet,f.policy,f.account,umk(),new AbortController().signal);
    const input={direction:f.policy.direction,levels:f.policy.levels.map(l=>({...l,id:'EXAMPLE_LEVEL_'+l.ordinal,attempt:0,status:'pending'})),fills:[],reserved:[],owned:[],positionSize:'0',bookPrice:book,lot:result.facts.lot,minimumQuote:result.facts.minimumQuote,freeSlots:result.facts.availableSlots,inventoryComplete:true,entriesAllowed:true,canaryRemaining:String(Number(investment)*2)};
    return {...f,...result,input};
  }
  it.each(['91.8','107.8'])('admits retained orders at inner edge %s far from the original Start without flipping entry roles',async book=>{
    const f=await current(book),before=structuredClone(f.policy);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),f.facts,clock,true).ok).toBe(false);
    const gate=preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,f.input);expect(gate.ok).toBe(true);
    if(gate.ok)for(const action of gate.plan.chunks.flat())if(action.kind==='place'&&!action.level.reduceOnly){expect(action.level.side).toBe('buy');expect(Number(action.level.price)).toBeLessThan(Number(book));}
    expect(f.policy).toEqual(before);
  });
  it('keeps actual reserved exits backed and refuses unknown or overallocated position',async()=>{
    const f=await current('107.8'),entry=f.input.levels[0],exit=f.input.levels[1];
    const input={...f.input,positionSize:'1',fills:[{tradeId:'EXAMPLE_TRADE',orderId:'EXAMPLE_ORDER',operationId:'EXAMPLE_OPERATION',levelId:entry.id,leg:'entry' as const,side:'buy' as const,size:'1',price:entry.price,fee:'0',time:clock}],reserved:[{tradeId:'EXAMPLE_TRADE',size:'1'}],owned:[{levelId:exit.id,orderId:'EXAMPLE_EXIT',clientOrderId:'EXAMPLE_CLIENT',remaining:'1',reduceOnly:true}]};
    const gate=preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,input);expect(gate.ok).toBe(true);
    expect(preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,{...input,positionSize:'0.9'}).ok).toBe(false);
    expect(preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,{...input,positionSize:null,inventoryComplete:false}).ok).toBe(false);
  });
  it('does not add a $250 or active-bot cap, require new funding/seed, or expand exposure',async()=>{
    const f=await current('107.8','1000');f.facts.masterWithdrawable='0';f.facts.taker=null;
    expect(preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,f.input).ok).toBe(true);
    expect(preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,{...f.input,canaryRemaining:'0'}).ok).toBe(false);
    f.facts.margin.available='0';expect(preflightGridResume(f.policy,f.policyHash,umk(),f.facts,clock,f.input).ok).toBe(false);
  });
});
