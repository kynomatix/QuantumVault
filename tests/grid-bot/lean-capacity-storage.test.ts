import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,type ExactGridRequest,type GridClaim,type DurableGridOperation} from '../../server/grid-bot/launch-storage';
import {GridCustody} from '../../server/grid-bot/custody';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {gridClientOrderId} from '../../server/grid-bot/order-identity';
import {readCycleState} from '../../server/grid-bot/cycle-storage';
import {cycleCapacity} from '../../server/grid-bot/cycle-capacity';
import {recordGridWorker} from '../../server/grid-bot/worker-ownership';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {cyclePolicy} from './cycle-fixtures';
import {withBehaviour} from './behaviour-fixtures';
import type {GridBehaviourMode} from '../../shared/grid-behaviour';
import {retainedGridCycles} from '../../server/grid-bot/cycle-policy';
import {replayGridCycles} from '../../server/grid-bot/cycle-replay';
import {intent,umk} from './draft-fixtures';
import {marginTestReading} from './margin-fixture';
vi.mock('../../server/grid-bot/service',()=>({durableGridUmk:async()=>({umk:Buffer.alloc(32,7),cleanup:()=>{}})}));

describe.each(['legacy','repeat_all'] as const)('lean capacity under PostgreSQL admission and send locks: %s',(mode)=>{
  let admin:Pool,pool:Pool;
  const schema='grid_lean_'+randomUUID().replaceAll('-',''),wallet=bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey);
  const store=(p=pool)=>new GridLaunchStorage(p,async()=>{},async r=>marginTestReading(r));
  beforeAll(async()=>{
    const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schema required');
    admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);
    pool=new Pool({connectionString:url,max:5,options:'-c search_path='+schema});
    await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text); CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY,wallet_address text,bot_id text,protocol text,protocol_subaccount_id text UNIQUE,status text,agent_public_key text,subaccount_key_encrypted_v3 text,aad_version integer,claim_token text,claimed_at timestamptz,confirmed_at timestamptz,derivation_index integer,last_verified_empty_at timestamptz,released_at timestamptz);`);
    for(const file of ['0004_grid_bot_drafts','0005_grid_launch','0006_grid_monitor','0007_grid_lifecycle','0011_grid_auto_resume'])await pool.query(readFileSync(new URL('../../migrations/'+file+'.sql',import.meta.url),'utf8'));
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
  beforeEach(async()=>{await pool.query('TRUNCATE grid_bots,protocol_subaccounts,wallets,grid_master_quota CASCADE');await pool.query('INSERT INTO wallets VALUES($1,$2)',[wallet,'EXAMPLE_MASTER']);});
  async function fixture(behaviour:GridBehaviourMode|'legacy'=mode){
    const base={...cyclePolicy('long',false),id:randomUUID(),totalInvestment:'300.00',sizingVersion:'lean-1' as const,safetyEnvelopePrice:'120.00000000'};
    const policy=behaviour==='legacy'?base:withBehaviour(base,behaviour);
    const signed=computeGridPolicyHmac(policy,umk());if(!signed.ok)throw Error('EXAMPLE signature');const {levels,...snapshot}=policy;
    const bot:DraftRecord={...snapshot,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:'A'.repeat(64),draftRevision:'EXAMPLE_REVISION',createIntent:intent,
      authoritySnapshot:{state:'EXAMPLE'},policyHmac:signed.digest,name:'Grid draft',rangeSource:'manual',chartTimeframe:'1h'};
    await new GridStorage(pool,async()=>{}).createDraftWithLevels(bot,levels);
    const account=await new GridCustody(store()).reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:bot.policyHmac},umk());
    const now=Date.now(),boot=randomUUID(),through=now-120000;
    await pool.query("UPDATE grid_bots SET created_at=$2,sol_balance='0.1',sol_balance_observed_at=$3 WHERE id=$1",[bot.id,new Date(now-200000),new Date(now)]);
    const observation:GridObservation={account:account.account,symbol:'BTC',observedAt:now,orders:[],trades:[],position:{direction:'long',size:'0'},inventoryComplete:true,
      history:{from:0,through,inclusive:true,publicationLagMs:120000,source:'pacifica_full_replay_stable_last_id',lastId:'EXAMPLE_LAST'},mark:{price:'95',observedAt:now}};
    await pool.query("INSERT INTO grid_monitor_state(bot_id,boot_id,generation,safe_through,observation,blocked_reasons,reconciled_at) VALUES($1,$2,1,$3,$4,'[]',$5)",[bot.id,boot,through,observation,new Date(now)]);
    await pool.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'canary-clock','internal_canary_clock',$2,clock_timestamp())",[bot.id,{full:{generation:'1',safeThrough:through,completedAt:now}}]);
    await store().transaction(c=>recordGridWorker(c,bot.id,account.leaseToken,false));
    const rows=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal',[bot.id])).rows;
    const request=(owner:number)=>{
      const price=String(Number(retainedGridCycles(policy)!.find(c=>c.ownerOrdinal===owner)!.openingPrice));
      const r:ExactGridRequest={kind:'limit',botId:bot.id,account:account.account,masterAccount:account.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
        data:{symbol:'BTC',amount:'1',price,side:'bid',reduce_only:false,tif:'ALO',client_order_id:gridClientOrderId({botId:bot.id,level:owner+1,attempt:0,leg:'entry'})},
        authority:{policy,policyHmac:signed.digest,levelId:rows[owner].id,levelAttempt:0,cycle:{ownerOrdinal:owner,leg:'opening'},initialCredit:'1',recycleAllocations:[],monitorBootId:boot,monitorGeneration:'1',
          cycleRisk:{account:account.account,symbol:'BTC',positionSize:'0',liquidationPrice:null,observedAt:now,source:'EXAMPLE'},
          facts:{tick:'0.01',lot:'0.001',minimumQuote:'1',maximumQuote:'10000',minimumPrice:'1',maximumPrice:'10000',maker:{effectiveRate:'0'},profit:{effectiveRate:'0'},observedAt:now,expiresAt:now+5000}}};
      const claim:GridClaim={credits:'10',slots:1,canaryIncrement:price,observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};return {r,claim};
    };
    return {bot,policy,account,now,observation,request};
  }
  async function live(c:PoolClient,op:DurableGridOperation){
    const r=op.exact_request,orderId='EXAMPLE_ORDER_'+r.authority.levelId;
    await c.query("UPDATE grid_operations SET state='confirmed',terminal_at=clock_timestamp(),venue_order_id=$2 WHERE id=$1",[op.id,orderId]);
    const observation=(await c.query('SELECT observation FROM grid_monitor_state WHERE bot_id=$1',[r.botId])).rows[0].observation as GridObservation;
    // Requests and simulated venue observations share one fixture tick. Advancing
    // it inside a lock holder would put it after the waiting admission's clock.
    observation.orders.push({orderId,clientOrderId:String(r.data.client_order_id),symbol:'BTC',side:'long',price:String(r.data.price),amount:'1',filledAmount:'0',cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:r.timestamp,updatedAt:r.timestamp,status:'open'});
    await c.query('UPDATE grid_monitor_state SET observation=$2 WHERE bot_id=$1',[r.botId,observation]);
    await c.query('UPDATE grid_monitor_orders p SET observed_at=$2 FROM grid_operations o WHERE o.id=p.operation_id AND o.bot_id=$1',[r.botId,observation.observedAt]);
    await c.query("INSERT INTO grid_monitor_orders(operation_id,order_id,status,filled,remaining,observed_at) VALUES($1,$2,'open',0,1,$3)",[op.id,orderId,observation.observedAt]);
  }
  it('serializes two independent admissions, retaining a denied owner and all reservations across restart',async()=>{
    const f=await fixture(),first=f.request(0),s=store();
    const initial=await s.prepare('EXAMPLE_INITIAL',first.r,first.claim,f.account.leaseToken);await s.transaction(c=>live(c,initial));
    await s.transaction(async c=>{
      const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 FOR UPDATE',[f.bot.id])).rows[0];
      expect(cycleCapacity((await readCycleState(c,bot,f.account.account,Date.now())).input,'95')?.used).toBe('120');
    });
    const workers=[0,1].map(()=>new Pool({connectionString:process.env.DATABASE_URL,max:1,options:'-c search_path='+schema}));
    let started=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;}),pids=new Set<number>();
    class ConcurrentStorage extends GridLaunchStorage {
      override transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{return super.transaction(async c=>{
        await c.query("SET LOCAL statement_timeout='10s'");pids.add((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if(++started===2)release();await barrier;
        const result=await work(c);if(result)await live(c,result as DurableGridOperation);return result;
      }).catch(e=>{release();throw e;});}
    }
    try{
      const candidates=[f.request(1),f.request(2)];
      const outcomes=await Promise.allSettled(candidates.map((v,i)=>new ConcurrentStorage(workers[i],async()=>{},async r=>marginTestReading(r)).prepare('EXAMPLE_RACE_'+i,v.r,v.claim,f.account.leaseToken)));
      expect(pids.size).toBe(2);expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
      const denied=outcomes.findIndex(o=>o.status==='rejected');expect(denied).toBeGreaterThanOrEqual(0);
      expect(String((outcomes[denied] as PromiseRejectedResult).reason)).toContain('Waiting for room');
      const restarted=store();await restarted.transaction(async c=>{
        const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 FOR UPDATE',[f.bot.id])).rows[0],state=await readCycleState(c,bot,f.account.account,Date.now());
        expect(state.policy.sizingVersion).toBe('lean-1');expect(cycleCapacity(state.input,'95')?.used).toBe('240');
        expect(state.cycles.find(c=>c.cycle.ownerOrdinal===denied+1)?.openingCredit).toBe('1');
        expect(state.levels.find(l=>l.ordinal===denied+2).placement_attempt).toBe(0);
        const risk=await restarted.pilotExposure(c,f.bot.id,Date.now(),undefined,{request:candidates[denied].r,increment:'90'});
        expect(risk.exposureUsd).toBe('285');expect(risk.limitUsd).toBe('300');
      });
      expect((await pool.query('SELECT count(*) FROM grid_operations')).rows[0].count).toBe('2');
    }finally{release();await Promise.all(workers.map(w=>w.end()));}
  },30000);
  it('checks the envelope again at admission, submission, and final send without calling POST',async()=>{
    const f=await fixture(),v=f.request(0),s=store(),setMark=async(price:string)=>{
      f.observation.mark!.price=price;await pool.query('UPDATE grid_monitor_state SET observation=$2 WHERE bot_id=$1',[f.bot.id,f.observation]);
    };
    await setMark('121');await expect(s.prepare('EXAMPLE_DENIED',v.r,v.claim,f.account.leaseToken)).rejects.toThrow('Waiting for room');
    await setMark('95');const op=await s.prepare('EXAMPLE_SEND',v.r,v.claim,f.account.leaseToken);
    await setMark('121');await expect(store().submit(op,f.account.leaseToken)).rejects.toThrow('Waiting for room');
    await setMark('95');expect(await store().submit(op,f.account.leaseToken)).toBe(true);
    const post=vi.fn(async()=>true);await setMark('121');await expect(store().sendOwned(v.r,f.account.leaseToken,post)).rejects.toThrow('Waiting for room');expect(post).not.toHaveBeenCalled();
    await setMark('95');expect(await store().sendOwned(v.r,f.account.leaseToken,post)).toBe(true);expect(post).toHaveBeenCalledOnce();
  });
  it.each(['step_back','step_back_edge'] as const)('retains %s and denies disabled openings after restart',async behaviour=>{
    const f=await fixture(behaviour),owner=retainedGridCycles(f.policy)!.find(c=>c.enabled===false)!,v=f.request(owner.ownerOrdinal);
    await store().transaction(async c=>{
      const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 FOR UPDATE',[f.bot.id])).rows[0];
      const restored=await readCycleState(c,bot,f.account.account,Date.now());
      expect(restored.policy.gridPolicyExtension).toEqual(f.policy.gridPolicyExtension);
      expect(replayGridCycles(restored.input).ok).toBe(true);
    });
    await expect(store().prepare('EXAMPLE_DISABLED',v.r,v.claim,f.account.leaseToken)).rejects.toThrow();
    expect((await pool.query('SELECT count(*) FROM grid_operations')).rows[0].count).toBe('0');
  });
});
