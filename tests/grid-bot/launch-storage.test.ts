import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,GridLaunchTransientError,requestDigest,type ExactGridRequest,type GridClaim} from '../../server/grid-bot/launch-storage';
import {GridCustody,GRID_LAUNCH_LEASE_MS} from '../../server/grid-bot/custody';
import {AGENT_WALLET_RESET_LOCK_NAMESPACE} from '../../server/storage';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {policy,umk,intent} from './draft-fixtures';
import {gridDraftRevision} from '../../client/src/lib/grid-draft-view';
const migration=readFileSync(new URL('../../migrations/0005_grid_launch.sql',import.meta.url),'utf8');
describe('Grid launch durable PostgreSQL ledger and isolated custody',()=>{
  let admin:Pool,pool:Pool,storage:GridLaunchStorage,custody:GridCustody;
  const schema='grid_u4_'+randomUUID().replaceAll('-',''),wallet=bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey);
  beforeAll(async()=>{const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schema required');
    admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:url,max:5,options:'-c search_path='+schema});
    await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text); CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY,wallet_address text,bot_id text,protocol text,protocol_subaccount_id text UNIQUE,status text,agent_public_key text,subaccount_key_encrypted_v3 text,aad_version integer,claim_token text,claimed_at timestamptz,confirmed_at timestamptz,derivation_index integer,last_verified_empty_at timestamptz,released_at timestamptz);`);
    await pool.query(readFileSync(new URL('../../migrations/0004_grid_bot_drafts.sql',import.meta.url),'utf8'));await pool.query(migration);
    await pool.query(readFileSync(new URL('../../migrations/0006_grid_monitor.sql',import.meta.url),'utf8'));
    await pool.query(readFileSync(new URL('../../migrations/0007_grid_lifecycle.sql',import.meta.url),'utf8'));
    storage=new GridLaunchStorage(pool,async()=>{});custody=new GridCustody(storage);
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
  beforeEach(async()=>{await pool.query('TRUNCATE grid_read_claims,grid_execution_claims,grid_launch_accounts,grid_master_quota,grid_fills,grid_operations,grid_levels,grid_bots,protocol_subaccounts,wallets CASCADE');await pool.query('INSERT INTO wallets VALUES($1,NULL)',[wallet]);});
  async function draft(){const p=policy(),h=computeGridPolicyHmac(p,umk());if(!h.ok)throw Error();const {levels,...snapshot}=p;
    const bot:DraftRecord={...snapshot,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:'A'.repeat(64),draftRevision:gridDraftRevision(intent),createIntent:intent,authoritySnapshot:{state:'EXAMPLE'},policyHmac:h.digest,name:'Grid draft',rangeSource:'manual',chartTimeframe:'1h'};
    await new GridStorage(pool,async()=>{}).createDraftWithLevels(bot,levels);return bot;
  }
  async function reserve(master='EXAMPLE_MASTER',share='0.5'){const bot=await draft();await pool.query('UPDATE wallets SET agent_public_key=$1 WHERE address=$2',[master,wallet]);const account=await custody.reserve({botId:bot.id,wallet,masterAccount:master,policyHmac:bot.policyHmac,canaryLimit:'250',share},umk());return {bot,account};}
  const input=(account:Awaited<ReturnType<typeof reserve>>['account'])=>{const now=Date.now();return {request:{kind:'fund',botId:account.botId,account:account.account,masterAccount:account.masterAccount,path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now,expiryMs:5000,data:{to_account:account.account,amount:'100'},authority:{}} as ExactGridRequest,
    claim:{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000} as GridClaim};};

  it('counts five exact terminal denials once, invalidates canary and persists the entry pause',async()=>{
    const {account}=await reserve();
    await pool.query("UPDATE grid_bots SET canary_clean_since=clock_timestamp(),canary_clean_ticks=2 WHERE id=$1",[account.botId]);
    await pool.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'canary-clock','internal_canary_clock',$2,clock_timestamp())",[account.botId,{clock:{cleanTicks:2},full:{generation:'EXAMPLE'}}]);
    const classes=['authentication','transport','authentication','transport','quota'] as const;
    for(const [i,classification] of classes.entries()){
      const v=input(account),op=await storage.prepare('EXAMPLE_FAILURE_'+i,v.request,v.claim,account.leaseToken);
      expect(await storage.submit(op,account.leaseToken)).toBe(true);
      const outcome={state:'failed' as const,reason:classification,releaseSlot:true,rateLimited:classification==='quota',terminalFailure:{requestDigest:requestDigest(v.request),classification}};
      const attempts=await Promise.allSettled([storage.settle(op,outcome),new GridLaunchStorage(pool,async()=>{}).settle(op,outcome)]);
      expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);
      const b=(await pool.query('SELECT consecutive_failures,status,canary_clean_since,canary_clean_ticks FROM grid_bots WHERE id=$1',[account.botId])).rows[0];
      expect(b).toMatchObject({consecutive_failures:i+1,canary_clean_since:null,canary_clean_ticks:0,status:i===4?'pausing':'provisioning'});
      expect((await pool.query('SELECT state,failure_classification FROM grid_operations WHERE id=$1',[op.id])).rows[0]).toEqual({state:'failed',failure_classification:classification});
      expect((await pool.query('SELECT slot_released,settled_at IS NOT NULL AS settled FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0]).toEqual({slot_released:true,settled:true});
    }
    const checkpoint=(await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='canary-clock'",[account.botId])).rows[0].evidence;
    expect(checkpoint).toEqual({clock:null,full:{generation:'EXAMPLE'}});
    const v=input(account);
    await expect(storage.prepare('EXAMPLE_DENIED',v.request,v.claim,account.leaseToken)).rejects.toThrow('ownership');
    expect((await pool.query('SELECT pause_reason FROM grid_bots WHERE id=$1',[account.botId])).rows[0].pause_reason).toBe('circuit_breaker');
  });
  it('rejects unbound failure evidence and excludes unknown sends and expected ALO from counting or resetting',async()=>{
    const {account}=await reserve(),v=input(account),op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);
    await storage.submit(op,account.leaseToken);await pool.query('UPDATE grid_bots SET consecutive_failures=2 WHERE id=$1',[account.botId]);
    await expect(storage.settle(op,{state:'failed',reason:'authentication',releaseSlot:true})).rejects.toThrow('authority');
    await expect(storage.settle(op,{state:'failed',reason:'authentication',releaseSlot:true,terminalFailure:{classification:'authentication',requestDigest:'EXAMPLE'}})).rejects.toThrow('authority');
    await storage.settle(op,{state:'unconfirmed',reason:'unknown',releaseSlot:false});
    expect((await pool.query('SELECT consecutive_failures FROM grid_bots WHERE id=$1',[account.botId])).rows[0].consecutive_failures).toBe(2);
    await storage.settle(op,{state:'failed',reason:'expected_rejection',releaseSlot:true});
    expect((await pool.query('SELECT consecutive_failures FROM grid_bots WHERE id=$1',[account.botId])).rows[0].consecutive_failures).toBe(2);
    const next=input(account),success=await storage.prepare('EXAMPLE_SUCCESS',next.request,next.claim,account.leaseToken);
    await storage.submit(success,account.leaseToken);await storage.settle(success,{state:'confirmed',reason:null,releaseSlot:true});
    expect((await pool.query('SELECT consecutive_failures FROM grid_bots WHERE id=$1',[account.botId])).rows[0].consecutive_failures).toBe(2);
  });
  it('migration repeats without table DDL and enforces exact-request pairs',async()=>{
    const c=await pool.connect();await c.query('BEGIN');await c.query('LOCK TABLE grid_operations IN ACCESS SHARE MODE');
    try{await pool.query("SET lock_timeout='500ms'");await pool.query(migration);}finally{await c.query('ROLLBACK');c.release();}
    const {account}=await reserve(),v=input(account),op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);
    await expect(pool.query('UPDATE grid_operations SET exact_request_digest=NULL WHERE id=$1',[op.id])).rejects.toThrow();
  });
  it('keeps the launch lease beyond durable backoff and exposes quota denials as transient',async()=>{
    const {account}=await reserve();expect(GRID_LAUNCH_LEASE_MS).toBeGreaterThan(60000);
    await storage.recordRateLimit(account.masterAccount);
    const row=(await pool.query('SELECT b.lease_expires_at>q.backoff_until AS survives FROM grid_bots b CROSS JOIN grid_master_quota q WHERE b.id=$1 AND q.master_account=$2',[account.botId,account.masterAccount])).rows[0];
    expect(row.survives).toBe(true);const v=input(account);
    await expect(storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).rejects.toBeInstanceOf(GridLaunchTransientError);
    await expect(storage.claimRead(account.masterAccount)).rejects.toBeInstanceOf(GridLaunchTransientError);
    expect((await pool.query('SELECT id FROM grid_operations')).rowCount).toBe(0);
    await pool.query("UPDATE grid_master_quota SET backoff_until=clock_timestamp()-interval '1 second'");
    await storage.claimRead(account.masterAccount,'150');
    await expect(storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).rejects.toBeInstanceOf(GridLaunchTransientError);
  });
  it('uses the same advisory lock namespace as wallet reset',async()=>{
    const bot=await draft();await pool.query('UPDATE wallets SET agent_public_key=$1 WHERE address=$2',['EXAMPLE_MASTER',wallet]);
    const c=await pool.connect();await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))',[AGENT_WALLET_RESET_LOCK_NAMESPACE,wallet]);
    const boundedPool=new Pool({connectionString:process.env.DATABASE_URL,max:1,options:'-c search_path='+schema+' -c lock_timeout=100ms'});
    try{await expect(new GridCustody(new GridLaunchStorage(boundedPool,async()=>{})).reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:bot.policyHmac,canaryLimit:'250'},umk())).rejects.toThrow('lock timeout');}
    finally{await c.query('ROLLBACK');c.release();await boundedPool.end();}
    expect((await pool.query('SELECT bot_id FROM grid_launch_accounts')).rowCount).toBe(0);
  });
  it('still checks stale request timestamps against the advancing database clock',async()=>{
    const {account}=await reserve(),v=input(account);v.request.timestamp-=6000;
    await expect(storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).rejects.toThrow('Stale admission');
    expect((await pool.query('SELECT id FROM grid_operations')).rowCount).toBe(0);
    v.request.timestamp=Date.now();expect((await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).state).toBe('prepared');
  });
  it('stores independent Grid ownership and decrypts only the matching owner/account/UMK',async()=>{const {account}=await reserve();const p=(await pool.query('SELECT bot_id,status FROM protocol_subaccounts')).rows[0];expect(p).toEqual({bot_id:null,status:'grid_reserved'});
    let captured:Buffer|undefined;await custody.withSecret(account,umk(),async keyBytes=>{captured=keyBytes;expect(bs58.encode(keyBytes.subarray(32))).toBe(account.account);});expect(captured!.every(x=>x===0)).toBe(true);
    await expect(custody.withSecret({...account,wallet:'EXAMPLE_WRONG'},umk(),async()=>{})).rejects.toThrow();await expect(custody.withSecret(account,Buffer.alloc(32,8),async()=>{})).rejects.toThrow();
  });
  it('refuses custody signing after master generation changes',async()=>{const {account}=await reserve();await pool.query('UPDATE wallets SET agent_public_key=$1 WHERE address=$2',['EXAMPLE_ROTATED',wallet]);await expect(custody.withSecret(account,umk(),async()=>{})).rejects.toThrow('ownership');});
  it('concurrent duplicate reservation creates one mapping and one retained key',async()=>{const bot=await draft();await pool.query('UPDATE wallets SET agent_public_key=$1 WHERE address=$2',['EXAMPLE_MASTER',wallet]);const results=await Promise.allSettled([0,1].map(()=>custody.reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:bot.policyHmac,canaryLimit:'250'},umk())));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await pool.query('SELECT * FROM grid_launch_accounts')).rowCount).toBe(1);});
  it('serializes one fixed master share across separate workers and retains uncertain claims beyond 60s',async()=>{const a=await reserve(),b=await reserve(),av=input(a.account),bv=input(b.account);av.claim.credits='100';bv.claim.credits='100';
    const results=await Promise.allSettled([storage.prepare('EXAMPLE_A',av.request,av.claim,a.account.leaseToken),new GridLaunchStorage(pool,async()=>{}).prepare('EXAMPLE_B',bv.request,bv.claim,b.account.leaseToken)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);await pool.query("UPDATE grid_execution_claims SET prepared_at=clock_timestamp()-interval '2 minutes'");
    const loser=results[0].status==='rejected'?{v:av,a:a.account}:{v:bv,a:b.account};await expect(storage.prepare('EXAMPLE_RETRY',loser.v.request,loser.v.claim,loser.a.leaseToken)).rejects.toThrow('quota');
  });
  it('retains quota for a full window after confirmation of an old uncertain send',async()=>{const {account}=await reserve(),v=input(account);v.claim.credits='150';const op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);await storage.submit(op,account.leaseToken);await pool.query("UPDATE grid_execution_claims SET prepared_at=clock_timestamp()-interval '2 minutes'");await storage.settle(op,{state:'confirmed',reason:null,releaseSlot:true});expect(await storage.availableCredits(account.masterAccount)).toBe('0');});
  it('paces 95 serial placements through the same durable rolling quota across worker restarts',async()=>{
    const {account}=await reserve();let windows=1;
    // Exercise the shared write ledger without consuming level/fill authority; every write costs the same ten credits.
    for(let i=0;i<95;i++){
      const s=new GridLaunchStorage(pool,async()=>{}),v=input(account);
      if(i&&i%15===0){
        await expect(s.prepare('EXAMPLE_DENIED_'+i,v.request,v.claim,account.leaseToken)).rejects.toBeInstanceOf(GridLaunchTransientError);
        expect(await s.availableCredits(account.masterAccount)).toBe('0');
        await pool.query("UPDATE grid_execution_claims SET settled_at=clock_timestamp()-interval '61 seconds' WHERE settled_at IS NOT NULL");windows++;
      }
      const op=await s.prepare('EXAMPLE_WRITE_'+i,v.request,v.claim,account.leaseToken);
      expect(await s.submit(op,account.leaseToken)).toBe(true);expect(await s.submit(op,account.leaseToken)).toBe(false);
      await s.settle(op,{state:'confirmed',reason:null,releaseSlot:true});
      expect((await s.read(account.botId,'EXAMPLE_WRITE_'+i))?.state).toBe('confirmed');
    }
    expect(windows).toBe(7);expect((await pool.query('SELECT id FROM grid_operations')).rowCount).toBe(95);
    expect(await storage.availableCredits(account.masterAccount)).toBe('100');
  });
  it('commits capacity failure, observed count and one outbox entry atomically; the latch survives restart and resume',async()=>{
    const {account}=await reserve(),v=input(account),level=(await pool.query('SELECT id FROM grid_levels WHERE bot_id=$1 AND ordinal=1',[account.botId])).rows[0];
    const s=new GridLaunchStorage(pool,async()=>{},async r=>({account:r.account,symbol:'BTC',available:'100000',leverage:'1',feeRate:'0',observedAt:Date.now(),accountUpdatedAt:Date.now()}));
    v.request={...v.request,kind:'limit',path:'/orders/create',operationType:'create_order',data:{symbol:'BTC',price:'90.00000000',amount:'1.00000000',side:'bid',reduce_only:false,tif:'ALO',client_order_id:randomUUID()},authority:{levelId:level.id,levelAttempt:0}};
    v.claim={...v.claim,slots:1,canaryIncrement:'90'};
    const op=await s.prepare('EXAMPLE_CAPACITY',v.request,v.claim,account.leaseToken);expect(await s.submit(op,account.leaseToken)).toBe(true);
    const observation={account:account.account,inventoryComplete:true,observedAt:Date.now(),orders:Array.from({length:38},(_,i)=>({orderId:String(i+1),status:'open'}))};
    await pool.query('INSERT INTO grid_monitor_state(bot_id,observation,reconciled_at) VALUES($1,$2,clock_timestamp())',[account.botId,observation]);
    await s.settle(op,{state:'failed',reason:'venue_rejection',capacityRejected:true,releaseSlot:true},account.leaseToken);
    expect((await pool.query('SELECT state,failure_classification FROM grid_operations WHERE id=$1',[op.id])).rows[0]).toEqual({state:'failed',failure_classification:'venue_rejection'});
    expect((await pool.query('SELECT status,pause_reason FROM grid_bots WHERE id=$1',[account.botId])).rows[0]).toEqual({status:'paused',pause_reason:'venue_capacity'});
    expect((await pool.query('SELECT evidence FROM grid_risk_events WHERE bot_id=$1',[account.botId])).rows[0].evidence).toMatchObject({classification:'venue_capacity',observedOpenOrders:38,account:account.account});
    expect((await pool.query('SELECT slot_released,settled_at IS NOT NULL AS settled FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0]).toEqual({slot_released:true,settled:true});
    await expect(s.settle(op,{state:'failed',reason:'venue_rejection',capacityRejected:true,releaseSlot:true},account.leaseToken)).rejects.toThrow('CAS');
    await pool.query("UPDATE grid_bots SET status='active',pause_reason=NULL WHERE id=$1",[account.botId]);
    await expect(new GridLaunchStorage(pool,async()=>{}).prepare('EXAMPLE_AFTER_RESUME',input(account).request,input(account).claim,account.leaseToken)).rejects.toThrow('venue-capacity pause');
    expect(await new GridLaunchStorage(pool,async()=>{}).submit(op,account.leaseToken)).toBe(false);
    expect((await pool.query('SELECT event_key FROM grid_risk_events WHERE bot_id=$1',[account.botId])).rowCount).toBe(1);
    // Existing reduction authority still applies, but capacity itself never blocks these operations.
    for(const r of [{...v.request,kind:'cancel' as const},{...v.request,kind:'close' as const},{...v.request,kind:'sweep' as const},{...v.request,data:{...v.request.data,reduce_only:true}}])
      expect(await (s as any).capacityBlocked(pool,r)).toBe(false);
  });
  it('does not partition different masters together and enforces the global pilot',async()=>{const a=await reserve('EXAMPLE_A'),b=await reserve('EXAMPLE_B');for(const account of [a.account,b.account]){const v=input(account);v.claim.credits='150';await storage.prepare(randomUUID(),v.request,v.claim,account.leaseToken);}await expect(reserve('EXAMPLE_C')).rejects.toThrow('pilot');});
  it('persists rate-limit backoff and blocks a prepared send after another worker receives 429',async()=>{const a=await reserve(),b=await reserve(),av=input(a.account),bv=input(b.account);const op=await storage.prepare('EXAMPLE_A',av.request,av.claim,a.account.leaseToken),other=await storage.prepare('EXAMPLE_B',bv.request,bv.claim,b.account.leaseToken);
    expect(await storage.submit(op,a.account.leaseToken)).toBe(true);await storage.settle(op,{state:'unconfirmed',reason:'quota',releaseSlot:false,rateLimited:true});
    expect(await new GridLaunchStorage(pool,async()=>{}).submit(other,b.account.leaseToken)).toBe(false);expect((await pool.query('SELECT settled_at FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0].settled_at).toBe(null);
  });
  it('CAS grants send exactly once and refuses stale lease or modified retained payload',async()=>{const {account}=await reserve(),v=input(account),op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);
    expect(await storage.submit(op,randomUUID())).toBe(false);expect(await storage.submit({...op,exact_request:{...op.exact_request,timestamp:1}},account.leaseToken)).toBe(false);
    expect(await Promise.all([storage.submit(op,account.leaseToken),storage.submit(op,account.leaseToken)])).toEqual([true,false]);
  });
  it('does not prepare any next money operation while funding is uncertain',async()=>{const {account}=await reserve(),v=input(account),op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);await storage.submit(op,account.leaseToken);await storage.settle(op,{state:'unconfirmed',reason:'unknown',releaseSlot:false});await expect(storage.prepare('EXAMPLE_NEXT',{...v.request,kind:'leverage'},v.claim,account.leaseToken)).rejects.toThrow('Unresolved');});
  it('same idempotency key demands the same exact request and observation expiry',async()=>{const {account}=await reserve(),v=input(account),op=await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken);expect((await storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).id).toBe(op.id);await expect(storage.prepare('EXAMPLE',{...v.request,expiryMs:4000},v.claim,account.leaseToken)).rejects.toThrow('conflict');});
  it('reserve rollback leaves a draft and no quota or custody row after a bad policy',async()=>{const bot=await draft();await expect(custody.reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:'EXAMPLE_HASH',canaryLimit:'250'},umk())).rejects.toThrow();expect((await pool.query('SELECT * FROM protocol_subaccounts')).rowCount).toBe(0);expect((await pool.query('SELECT status FROM grid_bots')).rows[0].status).toBe('draft');});
  it('read traffic and mutations consume one master budget and share durable backoff',async()=>{const {account}=await reserve();await storage.claimRead(account.masterAccount,'145');expect(await storage.availableCredits(account.masterAccount)).toBe('5');const v=input(account);await expect(storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).rejects.toThrow('quota');await storage.recordRateLimit(account.masterAccount);expect(await storage.availableCredits(account.masterAccount)).toBe('0');await expect(storage.claimRead(account.masterAccount)).rejects.toThrow('authority');});
  it('returns only an exactly proven empty owned reservation to the spare pool and reclaims its retained key',async()=>{
    const {account}=await reserve(),now=Date.now();await expect(custody.releaseReservation({...account,leaseToken:randomUUID()},umk(),{account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:now,expiresAt:now+5000},now)).rejects.toThrow();
    expect(await custody.releaseReservation(account,umk(),{account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:now,expiresAt:now+5000},now)).toBe('spare');
    const next=await reserve();expect(next.account).toMatchObject({account:account.account,reused:true});expect((await pool.query('SELECT bot_id FROM protocol_subaccounts')).rows[0].bot_id).toBeNull();
    await custody.withSecret(next.account,umk(),async keyBytes=>expect(bs58.encode(keyBytes.subarray(32))).toBe(account.account));
  });
  it('unknown reservation state quarantines while retaining the encrypted key',async()=>{const {account}=await reserve(),now=Date.now();expect(await custody.releaseReservation(account,umk(),{account:account.account,masterAccount:account.masterAccount,state:'unknown',observedAt:now,expiresAt:now+5000},now)).toBe('quarantined');const p=(await pool.query('SELECT status,subaccount_key_encrypted_v3 FROM protocol_subaccounts')).rows[0];expect(p.status).toBe('grid_quarantined');expect(p.subaccount_key_encrypted_v3).toBeTruthy();});
  it('will not understate seed canary commitment',async()=>{const {account}=await reserve(),v=input(account);v.request={...v.request,kind:'seed',data:{amount:'2'},authority:{seedWorstPrice:'100'}};v.claim.canaryIncrement='199';await expect(storage.prepare('EXAMPLE',v.request,v.claim,account.leaseToken)).rejects.toThrow('Understated');});
});
