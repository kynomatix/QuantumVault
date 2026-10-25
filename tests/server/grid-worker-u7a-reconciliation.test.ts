import {expect,it,vi} from 'vitest';
vi.mock('../../server/grid-worker/transaction',()=>({fencedTransaction:async(p:unknown,work:(p:unknown)=>unknown)=>work(p)}));
import {WorkerReconciliation} from '../../server/grid-worker/reconciliation';
const master='EXAMPLE_MASTER';
async function pass({foreignGrid=false,unknown=false,latched=false,negative=false,deleted=false,bound=false}={}){
  const incidents:any[]=[],writes:any[]=[],accounts=deleted?[]:[{account:'EXAMPLE_CHILD',master_account:master,bot_id:null,wallet_address:'EXAMPLE_WALLET',market:null,created_at:null}];
  const pool={query:async(sql:string,values?:any[])=>{
    if(sql.startsWith('SELECT p.protocol_subaccount_id')){expect(sql).toContain('p.agent_public_key=ANY($1::text[])');expect(values).toEqual([[master]]);return {rows:bound?Array(101).fill(accounts[0]):accounts};}
    if(sql.startsWith('SELECT 1 FROM grid_bots'))return {rowCount:foreignGrid?1:0};
    if(sql.startsWith('SELECT address FROM wallets'))return {rows:[{address:'EXAMPLE_WALLET'}]};
    if(sql.startsWith('SELECT 1 FROM grid_worker_incidents'))return {rowCount:latched?1:0};
    if(sql.startsWith('INSERT INTO grid_worker_reconciliation')){writes.push(values);return {rows:[],rowCount:1};}
    return {rows:[],rowCount:0};
  }};
  const reads={subaccounts:async()=>({success:true,error:null,data:{subaccounts:[{address:unknown?'EXAMPLE_UNKNOWN':'EXAMPLE_CHILD'}]}}),json:async(_m:string,path:string)=>{
    if(path==='/account')return {success:true,data:{balance:negative?'1':'0',pending_balance:'0'}};
    return {success:true,has_more:false,next_cursor:null,data:path==='/account/balance/history'&&negative?[{amount:'2',balance:'2',pending_balance:'0',event_type:'deposit',created_at:1},{amount:'-1',balance:'1',pending_balance:'0',event_type:'withdraw',created_at:2}]:[]};
  }};
  const security={umk:async()=>({umk:Buffer.alloc(32),cleanup(){}}),unlock:async()=>({masterAccount:master,signingKey:new Uint8Array(64),current:async()=>true,cleanup(){}})};
  const result=await new WorkerReconciliation(pool as any,async()=>{},reads as any,{} as any,security as any,{record:async(i:unknown)=>incidents.push(i)} as any,[master]).pass(new AbortController().signal);
  return {result,incidents,writes};
}
it('ignores other users signal rows while proving the owner master and its child',async()=>{
  const r=await pass();expect(r.result).toBe(true);expect(r.incidents).toEqual([]);expect(r.writes).toHaveLength(4);
});
it.each([{foreignGrid:true},{unknown:true},{deleted:true},{bound:true}])('latches scope/inventory refusal %j',async(options)=>{const r=await pass(options);expect(r.result).toBe(false);expect(r.incidents.some(i=>i.code==='reconciliation_unavailable')).toBe(true);});
it('latches a venue withdrawal absent locally and keeps unacknowledged mismatches closed',async()=>{
  const r=await pass({negative:true});expect(r.result).toBe(false);expect(r.incidents.some(i=>i.code==='audit_mismatch'&&i.dedupKey.startsWith('balance-unexplained:'))).toBe(true);
  const held=await pass({latched:true});expect(held.result).toBe(false);expect(held.writes.every(v=>v[4]==='incomplete')).toBe(true);
});
