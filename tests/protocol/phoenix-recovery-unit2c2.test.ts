import { afterEach, expect, it, vi } from 'vitest';
import { PhoenixRecoveryWorker } from '../../server/protocol/phoenix/recovery-worker';
import { recordPhoenixCustodyHealth } from '../../server/dependency-health-record';
vi.mock('../../server/dependency-health-record',()=>({recordPhoenixCustodyHealth:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
function fixture(locked=true) {
  const calls:{q:string;p?:any[]}[]=[],claims:any[]=[];
  const client={release:vi.fn(),query:vi.fn(async(q:string,p?:any[])=>{calls.push({q,p});
    if(q.includes('pg_try_advisory_lock'))return {rows:[{locked}]};
    if(q.includes('SELECT b.*'))return {rows:[{id:'EXAMPLE-archived',wallet_address:'EXAMPLE-owner',active_protocol:'phoenix',is_active:false,execution_active:false,subaccount_status:'phoenix_archived',policy_hmac:null}]};
    if(q.startsWith('SELECT observation'))return {rows:[{claim:{operationCursor:'EXAMPLE-earlier',orderCursor:'EXAMPLE-earlier'}}]};
    if(q.startsWith('UPDATE phoenix_operations'))claims.push(JSON.parse(p![1]));
    if(q.startsWith('SELECT * FROM phoenix_operations'))return {rows:[{id:'EXAMPLE-submitted',kind:'register',state:'submission_pending'}]};
    if(q.startsWith('SELECT * FROM phoenix_order_intents'))return {rows:[{id:'EXAMPLE-order',state:'unknown',data:{attempt:{}}}]};
    return {rows:[]};})};
  const io={operation:vi.fn(async()=>{expect(claims[0].status).toBe('running');}),order:vi.fn(async()=>{}),accounting:vi.fn(async()=>{}),health:vi.fn(async()=>null as any)};
  return {worker:new PhoenixRecoveryWorker({connect:async()=>client} as any,io),io,calls,claims,client};
}
it('recovers retained archived/paused/expired bots with all flags off and durable bounded cursors',async()=>{
  const f=fixture();expect(await f.worker.runOnce()).toEqual({skipped:false,bots:1,failures:0});
  expect(f.io.operation).toHaveBeenCalledOnce();expect(f.io.order).toHaveBeenCalledOnce();expect(f.io.accounting).toHaveBeenCalledOnce();
  expect(f.calls.find(c=>c.q.includes('SELECT b.*'))!.q).not.toMatch(/is_active|execution_active|subaccount_status|policy_hmac/);
  expect(f.calls.find(c=>c.q.includes('SELECT b.*'))!.q).toContain('LIMIT 8');
  const ops=f.calls.find(c=>c.q.startsWith('SELECT * FROM phoenix_operations'))!;expect(ops.p).toEqual(['EXAMPLE-archived','EXAMPLE-earlier']);expect(ops.q).toContain('LIMIT 16');
  expect(ops.q).toContain("kind='protection' AND state='prepared'");expect(ops.q).toContain("~ '^[1-9][0-9]*$'");
  expect(f.claims.at(-1)).toMatchObject({status:'observed',operationCursor:'EXAMPLE-submitted',orderCursor:'EXAMPLE-order'});expect(recordPhoenixCustodyHealth).not.toHaveBeenCalled();
});
it('excludes overlapping runs in-process and across processes',async()=>{
  const f=fixture();let finish!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
  f.io.operation.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;started();}));
  const first=f.worker.runOnce();await entered;
  expect(await f.worker.runOnce()).toEqual({skipped:true});finish();await first;
  const other=fixture(false);expect(await other.worker.runOnce()).toEqual({skipped:true});expect(other.io.operation).not.toHaveBeenCalled();expect(other.client.release).toHaveBeenCalledOnce();
});
it('retains failures honestly, continues other domains and only publishes complete fresh health',async()=>{
  const f=fixture();f.io.operation.mockRejectedValueOnce(new Error('EXAMPLE-RPC-unavailable'));
  f.io.health.mockResolvedValueOnce({complete:true,observedAt:Date.now()-31000});
  expect(await f.worker.runOnce()).toMatchObject({failures:1});expect(f.io.order).toHaveBeenCalledOnce();expect(f.claims.at(-1).status).toBe('incomplete');expect(recordPhoenixCustodyHealth).not.toHaveBeenCalled();
  const sample={complete:true,observedAt:Date.now()};f.io.health.mockResolvedValueOnce(sample);await f.worker.runOnce();expect(recordPhoenixCustodyHealth).toHaveBeenCalledWith(sample);
});
