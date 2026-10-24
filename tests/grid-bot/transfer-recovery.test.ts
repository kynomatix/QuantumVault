import {describe,expect,it,vi} from 'vitest';
import {GridExecution,gridReconciliationOutcome,type GridExecutionDeps} from '../../server/grid-bot/execution';
import {reconcileGridTransfer} from '../../server/grid-bot/launch-reconciliation';
import {gridProvisionAttempt,requestDigest,type DurableGridOperation,type ExactGridRequest,type GridClaim} from '../../server/grid-bot/launch-storage';
import {readGridTransferEvidence,type GridTransferEvidence} from '../../server/grid-bot/transfer-evidence';
import {gridNotificationText} from '../../server/grid-bot/notifications';

const now=9000,signal=()=>new AbortController().signal;
function fixture(kind:'fund'|'sweep',landed=true){
  const r:ExactGridRequest={kind,botId:crypto.randomUUID(),account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',path:'/account/subaccount/transfer',
    operationType:'transfer_funds',timestamp:1000,expiryMs:5000,data:{amount:'100',to_account:kind==='fund'?'EXAMPLE_SUB':'EXAMPLE_MASTER',idempotency_key:crypto.randomUUID()},
    authority:kind==='sweep'?{settlementComplete:true,settlement:{account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',settlementComplete:true,balance:'100',withdrawable:'100',observedAt:900}}:{}};
  const op:DurableGridOperation={id:'EXAMPLE_TRANSFER',state:'unconfirmed',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:'unknown',submitted_at:new Date(1000)};
  const create:ExactGridRequest={...r,kind:'create',timestamp:100,path:'/account/subaccount/create',operationType:'subaccount_confirm',data:{},authority:{}};
  const operations:DurableGridOperation[]=kind==='fund'?[{id:'EXAMPLE_CREATE',state:'confirmed',exact_request:create,exact_request_digest:requestDigest(create),failure_classification:null},op]:[op];
  const evidence:GridTransferEvidence={account:r.account,masterAccount:r.masterAccount,complete:true,startedAt:8000,observedAt:8500,balanceAt:8000,
    balance:kind==='fund'?(landed?'100':'0'):(landed?'0':'100'),ownedAccounts:[r.account],
    subaccountHistory:landed?[{amount:kind==='fund'?'100':'-100',eventType:'subaccount_transfer',createdAt:2000}]:[],
    mainHistory:landed?[{amount:kind==='fund'?'-100':'100',eventType:'subaccount_transfer',createdAt:2000}]:[]};
  const context={reused:false,operations};
  return {r,op,context,evidence,recover:()=>reconcileGridTransfer(r,evidence,context,now)};
}
describe.each(['fund','sweep'] as const)('C4 %s exact outcome',kind=>{
  it('confirms a landed transfer only with the matching main-account event',()=>{
    const f=fixture(kind),result=f.recover();expect(result).toMatchObject({state:'confirmed',requestDigest:f.op.exact_request_digest,releaseSlot:true});
    if(result.state==='unknown')throw Error('EXAMPLE missing result');
    expect(gridReconciliationOutcome(result)).toMatchObject({state:'confirmed',reason:null,transferProof:{state:'confirmed'}});
  });
  it('proves not landed strictly after expiry and preserves the original request',()=>{
    const f=fixture(kind,false),retained=structuredClone(f.r),result=f.recover();
    expect(result.state).toBe('not_landed');expect(f.r).toEqual(retained);
    if(result.state==='unknown')throw Error('EXAMPLE missing result');
    expect(gridReconciliationOutcome(result)).toMatchObject({state:'failed',reason:'expected_rejection',transferProof:{state:'not_landed'}});
  });
  it.each(['unexpected_amount','extra_activity','partial','stale_balance','stale_read','before_expiry','at_expiry','missing_main','wrong_direction','wrong_event','outside_window','duplicate_main'] as const)
    ('retains UNKNOWN for %s',fault=>{
      const f=fixture(kind);let at=now;
      if(fault==='unexpected_amount')f.evidence.balance='27';
      if(fault==='extra_activity')f.evidence.subaccountHistory.push({amount:'1',eventType:'deposit',createdAt:7000});
      if(fault==='partial')f.evidence.complete=false;
      if(fault==='stale_balance')f.evidence.balanceAt=6000;
      if(fault==='stale_read')f.evidence.startedAt=6000;
      if(fault==='before_expiry')at=5999;
      if(fault==='at_expiry')at=6000;
      if(fault==='missing_main')f.evidence.mainHistory=[];
      if(fault==='wrong_direction')f.evidence.mainHistory[0].amount=kind==='fund'?'100':'-100';
      if(fault==='wrong_event')f.evidence.mainHistory[0].eventType='deposit';
      if(fault==='outside_window')f.evidence.mainHistory[0].createdAt=6001;
      if(fault==='duplicate_main')f.evidence.mainHistory.push({...f.evidence.mainHistory[0]});
      expect(reconcileGridTransfer(f.r,f.evidence,f.context,at)).toEqual({state:'unknown'});
    });
  it('rejects a conflicting local operation even when balances match',()=>{
    const f=fixture(kind),other:ExactGridRequest={...f.r,kind:'limit',timestamp:7000};
    f.context.operations.push({id:'EXAMPLE_EXTRA',state:'confirmed',exact_request:other,exact_request_digest:requestDigest(other),failure_classification:null});
    expect(f.recover()).toEqual({state:'unknown'});
  });
  it('rejects partial or failed evidence instead of treating it as zero',()=>{
    const f=fixture(kind,false);expect(reconcileGridTransfer(f.r,null,f.context,now)).toEqual({state:'unknown'});
  });
  it.each(['landed','not_landed','unknown'] as const)('never resends the retained key for %s, including after restart',async outcome=>{
    const f=fixture(kind,outcome!=='not_landed');if(outcome==='unknown')f.evidence.balance='17';
    const retained=structuredClone(f.r),rows=new Map<string,DurableGridOperation>([['EXAMPLE_OLD_KEY',f.op]]);
    const deps:GridExecutionDeps={now:()=>now,storage:{read:async(_bot,key)=>rows.get(key)??null,
      prepare:vi.fn(async()=>{throw Error('EXAMPLE unexpected prepare');}),submit:vi.fn(async()=>false),
      settle:async(op,result)=>{op.state=result.state;op.failure_classification=result.reason;op.transfer_recovery=result.transferProof;}},
      preflight:vi.fn(async()=>true),send:vi.fn(async()=>({rateLimited:false})),reconcile:async()=>f.recover()};
    await new GridExecution(deps).run('EXAMPLE_OLD_KEY',f.r,{recoveryOnly:true},'EXAMPLE_LEASE');
    await new GridExecution(deps).run('EXAMPLE_OLD_KEY',f.r,{recoveryOnly:true},'EXAMPLE_LEASE');
    expect(deps.send).not.toHaveBeenCalled();expect(deps.storage.prepare).not.toHaveBeenCalled();expect(deps.storage.submit).not.toHaveBeenCalled();expect(f.r).toEqual(retained);
    expect(f.op.state).toBe(outcome==='landed'?'confirmed':outcome==='not_landed'?'failed':'unconfirmed');
  });
});
describe('C4 boundaries and replacement attempts',()=>{
  it.each(['reused','missing_inventory','other_funding'] as const)('does not fund from %s evidence',fault=>{
    const f=fixture('fund');
    if(fault==='reused')f.context.reused=true;
    if(fault==='missing_inventory')f.evidence.ownedAccounts=[];
    if(fault==='other_funding')f.context.operations.push({...f.op,id:'EXAMPLE_OTHER_FUND',state:'confirmed'});
    expect(f.recover()).toEqual({state:'unknown'});
  });
  it('does not call an undocumented nonzero sweep residual dust',()=>{
    const f=fixture('sweep');f.evidence.balance='0.001';expect(f.recover()).toEqual({state:'unknown'});
  });
  it('requires the exact retained pre-sweep balance',()=>{
    const f=fixture('sweep',false);f.r.authority.settlement={account:f.r.account,masterAccount:f.r.masterAccount,settlementComplete:true,balance:'101',observedAt:900};
    f.op.exact_request_digest=requestDigest(f.r);expect(f.recover()).toEqual({state:'unknown'});
  });
  it('only a persisted, digest-bound absence proof advances funding to a fresh key',async()=>{
    const f=fixture('fund',false),base=`grid:${f.r.botId}:launch:fund`,result=f.recover();
    if(result.state==='unknown')throw Error('EXAMPLE absence proof missing');
    const settlement=gridReconciliationOutcome(result);f.op.state=settlement.state;f.op.failure_classification=settlement.reason;
    const read=async(key:string)=>key===base?f.op:null;
    expect((await gridProvisionAttempt(read,f.r.botId,'fund',now)).key).toBe(base);
    f.op.transfer_recovery=settlement.transferProof;
    const attempt=await gridProvisionAttempt(read,f.r.botId,'fund',now);expect(attempt).toEqual({key:base+':retry:'+f.op.id,op:null});
    f.op.transfer_recovery={...settlement.transferProof!,requestDigest:'EXAMPLE_WRONG_DIGEST'};
    expect((await gridProvisionAttempt(read,f.r.botId,'fund',now)).key).toBe(base);
  });
  it('sends at most one replacement with a different transfer key after proven absence',async()=>{
    const f=fixture('fund',false),base=`grid:${f.r.botId}:launch:fund`,result=f.recover();
    if(result.state==='unknown')throw Error('EXAMPLE absence proof missing');
    const terminal=gridReconciliationOutcome(result);Object.assign(f.op,{state:terminal.state,failure_classification:terminal.reason,transfer_recovery:terminal.transferProof});
    const rows=new Map<string,DurableGridOperation>([[base,f.op]]),read=async(key:string)=>rows.get(key)??null;
    const attempt=await gridProvisionAttempt(read,f.r.botId,'fund',now);
    const fresh:ExactGridRequest={...f.r,timestamp:now,data:{...f.r.data,idempotency_key:crypto.randomUUID()}};
    const deps:GridExecutionDeps={now:()=>now,storage:{read:async(_bot,key)=>read(key),
      prepare:async(key,r)=>{const op:DurableGridOperation={id:'EXAMPLE_NEW_OPERATION',state:'prepared',submitted_at:null,exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null};rows.set(key,op);return op;},
      submit:async op=>{op.state='submitted';op.submitted_at=new Date(now);return true;},settle:async(op,o)=>{op.state=o.state;op.failure_classification=o.reason;}},
      preflight:async()=>true,send:vi.fn(async(r:ExactGridRequest)=>({rateLimited:false,terminalTransferDigest:requestDigest(r)})),reconcile:async()=>({state:'unknown'})};
    const claim:GridClaim={credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:10,observedAt:now,expiresAt:now+5000};
    expect(await new GridExecution(deps).run(attempt.key,fresh,claim,'EXAMPLE_LEASE')).toBe('confirmed');
    expect(await new GridExecution(deps).run(attempt.key,fresh,claim,'EXAMPLE_LEASE')).toBe('confirmed');
    expect(deps.send).toHaveBeenCalledOnce();expect(fresh.data.idempotency_key).not.toBe(f.r.data.idempotency_key);
    expect((await gridProvisionAttempt(read,f.r.botId,'fund',now)).op?.state).toBe('confirmed');
  });
  it('gives the owner a clear UNKNOWN notification',()=>{
    expect(gridNotificationText({bot_id:'EXAMPLE_BOT',event_key:'EXAMPLE_EVENT',kind:'transfer_unknown',evidence:{},wallet_address:'EXAMPLE_WALLET',market:'BTC-PERP'}).body)
      .toContain('Transfer outcome UNKNOWN; new entries paused');
  });
});

function readerFixture(kind:'fund'|'sweep'){
  const f=fixture(kind),calls:string[]=[],faults=new Map<string,unknown>();
  let balanceReads=0;
  const account=(balance:string)=>({success:true,error:null,data:{account:f.r.account,updated_at:now,balance,available_to_withdraw:balance,account_equity:balance,
    pending_balance:'0',pending_interest:'0',spot_collateral:'0',spot_market_value:'0',total_margin_used:'0',positions_count:0,orders_count:0,stop_orders_count:0,spot_balances:[]}});
  const json=vi.fn(async(_master:string,path:string,params:Record<string,string>):Promise<unknown>=>{
    calls.push(path+':'+params.account);const key=path+':'+params.account;
    if(faults.has(key))return faults.get(key);
    if(path==='/account'){balanceReads++;return account(f.evidence.balance);}
    if(path==='/orders'||path==='/positions')return {success:true,error:null,data:[]};
    if(path==='/account/balance/history'){
      expect(params.include_trades).toBe('true');
      const history=params.account===f.r.account?f.evidence.subaccountHistory:f.evidence.mainHistory;
      return {success:true,error:null,data:history.map(x=>({amount:x.amount,event_type:x.eventType,created_at:x.createdAt})),has_more:false,next_cursor:null};
    }
    throw Error('EXAMPLE unexpected read');
  });
  const inventory=vi.fn(async()=>[f.r.account]);
  return {...f,json,inventory,calls,faults,account,get balanceReads(){return balanceReads;},
    read:()=>readGridTransferEvidence(f.r,{json},inventory,signal(),()=>now)};
}
describe.each(['fund','sweep'] as const)('C4 %s production evidence reads',kind=>{
  it('uses fresh full-account inventory, all balance histories, and a second balance read',async()=>{
    const f=readerFixture(kind),e=await f.read();expect(e).not.toBeNull();
    expect(f.balanceReads).toBe(2);expect(f.calls).toContain('/orders:'+f.r.account);expect(f.calls).toContain('/positions:'+f.r.account);
    expect(reconcileGridTransfer(f.r,e,f.context,now).state).toBe('confirmed');
    expect(f.inventory).toHaveBeenCalledTimes(kind==='fund'?1:0);
  });
  it.each(['partial','stale','orders','positions','failed','missing_page','stale_history'] as const)('refuses %s evidence',fault=>{
    const f=readerFixture(kind);
    if(fault==='partial')f.faults.set('/account:'+f.r.account,{...f.account(f.evidence.balance),partial:true});
    if(fault==='stale'){const raw=f.account(f.evidence.balance);raw.data.updated_at=6000;f.faults.set('/account:'+f.r.account,raw);}
    if(fault==='orders'||fault==='positions')f.faults.set('/'+fault+':'+f.r.account,{success:true,error:null,data:[{symbol:'EXAMPLE_OTHER_MARKET'}]});
    if(fault==='failed')f.faults.set('/account:'+f.r.account,{success:false,error:'EXAMPLE_READ_FAILED',data:null});
    if(fault==='missing_page')f.faults.set('/account/balance/history:'+f.r.masterAccount,{success:true,error:null,data:[],has_more:true,next_cursor:'EXAMPLE_CURSOR'});
    if(fault==='stale_history')f.faults.set('/account/balance/history:'+f.r.masterAccount,{success:true,error:null,data:[],has_more:false,updated_at:6000});
    return expect(f.read()).resolves.toBeNull();
  });
  it('does not fetch or reinterpret balances before or at expiry',async()=>{
    const f=readerFixture(kind);
    expect(await readGridTransferEvidence(f.r,{json:f.json},f.inventory,signal(),()=>6000)).toBeNull();expect(f.json).not.toHaveBeenCalled();expect(f.inventory).not.toHaveBeenCalled();
  });
  it('requires every page of main-account history before deciding',async()=>{
    const f=readerFixture(kind),seen:string[]=[];
    const json:Parameters<typeof readGridTransferEvidence>[1]['json']=async(master,path,params)=>{
      if(path==='/account/balance/history'&&params.account===f.r.masterAccount){
        seen.push(params.cursor??'EXAMPLE_FIRST_PAGE');
        if(!params.cursor)return {success:true,error:null,data:[{amount:'1',event_type:'deposit',created_at:0}],has_more:true,next_cursor:'EXAMPLE_NEXT_PAGE'};
      }
      return f.json(master,path,params);
    };
    const evidence=await readGridTransferEvidence(f.r,{json},f.inventory,signal(),()=>now);
    expect(seen).toEqual(['EXAMPLE_FIRST_PAGE','EXAMPLE_NEXT_PAGE']);expect(reconcileGridTransfer(f.r,evidence,f.context,now).state).toBe('confirmed');
  });
  it('refuses a balance that changes while history is being read',async()=>{
    const f=readerFixture(kind);let accounts=0;
    const json:Parameters<typeof readGridTransferEvidence>[1]['json']=async(master,path,params)=>{
      if(path==='/account'&&++accounts>1)return f.account('37');return f.json(master,path,params);
    };
    expect(await readGridTransferEvidence(f.r,{json},f.inventory,signal(),()=>now)).toBeNull();
  });
  it('rejects a read batch that becomes stale while collecting history',async()=>{
    const f=readerFixture(kind);let time=now;
    const evidence=await readGridTransferEvidence(f.r,{json:async(master,path,params)=>{const raw=await f.json(master,path,params);time+=1000;return raw;}},
      f.inventory,signal(),()=>time);
    expect(evidence).toBeNull();
  });
});
