import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {GridLaunchStorage} from '../../server/grid-bot/launch-storage';
import {GridCustody} from '../../server/grid-bot/custody';
import {GridMonitorStorage,type GridMonitorClaim} from '../../server/grid-bot/monitor-storage';
import {GridLifecycleStorage} from '../../server/grid-bot/lifecycle-storage';
import {GridLifecycleService} from '../../server/grid-bot/lifecycle-service';
import {GridMoveStorage,type GridMoveAuthority} from '../../server/grid-bot/move-storage';
import {canonicalGridPolicy,computeGridPolicyHmac,verifyGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {archivedEpochPolicy} from '../../server/grid-bot/epoch-storage';
import {readCycleState} from '../../server/grid-bot/cycle-storage';
import {createGridFeeQuote} from '../../server/grid-bot/fee-authority';
import {loadActiveGridLevels} from '../../server/grid-bot/active-epoch';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {behaviourPolicy} from './behaviour-fixtures';
import {marginTestReading} from './margin-fixture';
import {umk} from './draft-fixtures';
import {moveCandles,moveBase,moveDuration} from './range-move-fixtures';

// Only the external signing key and venue authority are replaced; SQL, migration,
// custody, band detection/completion, move activation and archived replay are real.
vi.mock('../../server/grid-bot/service',async original=>({...await original<typeof import('../../server/grid-bot/service')>(),durableGridUmk:async()=>({umk:Buffer.alloc(32,7),cleanup:()=>{}})}));
const sql=(name:string)=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
const migration=sql('0012_grid_range_epochs.sql')+'\n'+sql('0013_grid_epoch_publish_safe.sql');
const wallet=bs58.encode(Buffer.alloc(32,3));
describe('range moves from real pre-epoch PostgreSQL data',()=>{
  let admin:Pool,pool:Pool,schema:string,now:number,launch:GridLaunchStorage,monitor:GridMonitorStorage,life:GridLifecycleStorage;
  beforeAll(()=>{const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schema required');admin=new Pool({connectionString:url,max:1});});
  beforeEach(async()=>{
    schema='grid_move_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
    // Explicit pg_catalog ordering lets this isolated schema control elapsed time,
    // including the second move cooldown, without touching the shared database clock.
    pool=new Pool({connectionString:process.env.DATABASE_URL,max:6,options:'-c search_path='+schema+',pg_catalog'});
    now=moveBase;vi.spyOn(Date,'now').mockImplementation(()=>now);
    await pool.query(`CREATE TABLE test_clock(at timestamptz NOT NULL); INSERT INTO test_clock VALUES(to_timestamp(${moveBase}/1000)); CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT at FROM test_clock';
      CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text,agent_private_key_encrypted_v3 text DEFAULT 'EXAMPLE',execution_enabled boolean DEFAULT true,emergency_stop_triggered boolean DEFAULT false,umk_version integer DEFAULT 1,umk_encrypted_for_execution text DEFAULT 'EXAMPLE');
      CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY,wallet_address text,bot_id text,protocol text,protocol_subaccount_id text UNIQUE,status text,agent_public_key text,subaccount_key_encrypted_v3 text,aad_version integer,claim_token text,claimed_at timestamptz,confirmed_at timestamptz,derivation_index integer,last_verified_empty_at timestamptz,released_at timestamptz);`);
    for(const name of ['0004_grid_bot_drafts.sql','0005_grid_launch.sql','0006_grid_monitor.sql','0007_grid_lifecycle.sql','0011_grid_auto_resume.sql'])await pool.query(sql(name));
    await pool.query('INSERT INTO wallets(address,agent_public_key) VALUES($1,$2)',[wallet,'EXAMPLE_MASTER']);
    launch=new GridLaunchStorage(pool,async()=>{},async r=>marginTestReading(r));monitor=new GridMonitorStorage(launch);life=new GridLifecycleStorage(monitor);
  });
  afterEach(async()=>{vi.restoreAllMocks();await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');});
  afterAll(async()=>{await admin?.end();});
  async function legacy(){
    const p={...behaviourPolicy('repeat_all','long',false),id:randomUUID()},signed=computeGridPolicyHmac(p,umk());if(!signed.ok)throw Error('EXAMPLE policy invalid');
    const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=p;
    const record={...base,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:createHash('sha256').update('EXAMPLE_INTENT').digest('hex').toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},policyHmac:signed.digest,rangeSource:'manual',chartTimeframe:'15m',createdAt:new Date(now)};
    const entries=Object.entries(record),snake=(s:string)=>s.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
    await pool.query(`INSERT INTO grid_bots(${entries.map(([k])=>snake(k)).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));
    for(const l of levels)await pool.query('INSERT INTO grid_levels(id,bot_id,ordinal,price,size,side,reduce_only) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.id,l.ordinal,l.price,l.size,l.side,l.reduceOnly]);
    expect((await pool.query("SELECT to_regclass('grid_epochs') AS epochs")).rows[0].epochs).toBeNull();
    await pool.query(migration);
    return {p,policyHash:signed.digest,epoch:(await pool.query('SELECT * FROM grid_epochs WHERE bot_id=$1',[p.id])).rows[0]};
  }
  it('backfills exact signed decimals, exhausts an ordinary bot and activates/replays two successive moves',async()=>{
    const f=await legacy(),snapshot=f.epoch.policy_snapshot;
    expect(snapshot.legacyBot).toMatchObject({lower_price:'80.00000000',total_investment:'600.00',stop_loss_percent:'20.0000'});
    expect(snapshot.legacyLevels[0]).toMatchObject({price:'80.00000000',size:'1.00000000'});
    expect(canonicalGridPolicy(archivedEpochPolicy(f.epoch))).toBe(canonicalGridPolicy(f.p));
    expect(verifyGridPolicyHmac(archivedEpochPolicy(f.epoch),umk(),f.policyHash).ok).toBe(true);
    const oldJson=structuredClone(f.epoch);
    for(const key of ['lower_price','upper_price','start_price','total_investment','stop_loss_percent','stop_loss_price'])oldJson.policy_snapshot.legacyBot[key]=Number(oldJson.policy_snapshot.legacyBot[key]);
    for(const l of oldJson.policy_snapshot.legacyLevels){l.price=Number(l.price);l.size=Number(l.size);}
    expect(canonicalGridPolicy(archivedEpochPolicy(oldJson))).toBe(canonicalGridPolicy(f.p));
    const account=await new GridCustody(launch).reserve({botId:f.p.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:f.policyHash},umk());
    const claim:GridMonitorClaim={id:f.p.id,leaseToken:account.leaseToken,account:account.account,masterAccount:account.masterAccount};
    let offset=0;
    const observe=():GridObservation=>({account:claim.account,symbol:'BTC',observedAt:now,inventoryComplete:true,history:{from:0,through:now,inclusive:true,publicationLagMs:0,source:'EXAMPLE'},mark:{price:String(123+offset),observedAt:now},position:{direction:'long',size:'0'},orders:[],trades:[]});
    const reconcile=async()=>{const o=observe();await life.safetyObservation(claim,o);await monitor.reconcile(claim,randomUUID(),o);};
    const advance=async(ms:number)=>{now+=ms;await pool.query('UPDATE test_clock SET at=$1',[new Date(now)]);await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[claim.id]);};
    const collect=async():Promise<GridMoveAuthority>=>{
      const quote=(role:'maker'|'taker',intent:'entry'|'profit')=>{const r=createGridFeeQuote({account:claim.account,subaccountId:null,market:'BTC-PERP',liquidityRole:role,builderCode:'CARRY',intent},{account:claim.account,maker_fee:'0',taker_fee:'0'},[{builder_code:'CARRY',fee_rate:'0'}],[{builder_code:'CARRY',max_fee_rate:'0'}],now);if(r.availability!=='available')throw Error(r.reason);return r.quote;};
      return {umk:umk(),cleanup:()=>{},candles:moveCandles(false,Math.floor(now/moveDuration)*moveDuration-15*moveDuration,offset),risk:{account:claim.account,symbol:'BTC',positionSize:'0',liquidationPrice:null,observedAt:now,source:'EXAMPLE'},facts:{market:'BTC-PERP',margin:{account:claim.account,symbol:'BTC',available:'600',leverage:'1',feeRate:'0',observedAt:now,accountUpdatedAt:now},agentGeneration:{wallet,masterAccount:claim.masterAccount,umkVersion:1},observedAt:now,expiresAt:now+5000,masterAccount:claim.masterAccount,account:claim.account,bookPrice:String(123+offset),bookSource:'/book',tick:'0.01',lot:'0.001',minimumQuote:'1',maximumQuote:'10000',minimumPrice:'1',maximumPrice:'10000',maxLeverage:'10',restrictions:'unrestricted',maker:quote('maker','entry'),profit:quote('maker','profit'),taker:quote('taker','entry'),masterWithdrawable:'600',sol:'0.1',availableSlots:100,subaccountCount:1,observedCredits:'300',availableGridCredits:'150',transportReady:true,inventoryComplete:true,recycler:{reuse:true,recycle:true,deployment:'EXAMPLE',expectedDeployment:'EXAMPLE',checkedAt:now}}};
    };
    const moves=new GridMoveStorage(life,collect,()=>true),signal=new AbortController().signal;
    const service=new GridLifecycleService({storage:life,observe:async()=>observe(),sol:async()=>({balance:'0.1',observedAt:now}),send:vi.fn(),recover:vi.fn(),resume:vi.fn(),settlement:vi.fn(),recycle:vi.fn()});
    await pool.query("UPDATE grid_bots SET status='active' WHERE id=$1",[claim.id]);
    for(const ordinal of [2,3]){
      await advance(moveDuration);
      expect(await service.tick(claim,signal)).toBe('paused');
      expect((await life.state(claim)).bot.status).toBe('range_exhausted');
      const band=(await pool.query("SELECT state,source FROM grid_control_requests WHERE bot_id=$1 AND action='band' ORDER BY completed_at DESC LIMIT 1",[claim.id])).rows[0];
      expect(band).toEqual({state:'complete',source:'risk'});
      await advance(15*moveDuration);await reconcile();
      const proposal=await moves.proposal(wallet,claim.id,signal);expect(proposal.proposal.ordinal).toBe(ordinal);
      await moves.confirm(wallet,claim.id,randomUUID(),proposal.proposal,proposal.proposalHash,signal);await reconcile();
      expect(await moves.activate(claim,signal)).toBe('range_moved');await reconcile();
      const replay=await launch.transaction(async c=>readCycleState(c,(await c.query('SELECT * FROM grid_bots WHERE id=$1',[claim.id])).rows[0],claim.account,now));
      expect(replay.policy.epochAuthority?.ordinal).toBe(ordinal);
      expect(replay.policy.lowerPrice).toBe((80+(ordinal-1)*10).toFixed(8));
      expect(replay.levels.every(l=>!Object.hasOwn(l,'epoch_id'))).toBe(true);
      offset+=10;
    }
    expect((await pool.query('SELECT count(*) AS n FROM grid_epochs WHERE bot_id=$1',[claim.id])).rows[0].n).toBe('3');
  },30000);
  it('repairs each missing FK and validates a legacy NULL epoch assignment against its parent',async()=>{
    const f=await legacy();
    const fks=[['grid_bots','grid_bots_active_epoch_fk'],['grid_levels','grid_levels_epoch_fk'],['grid_operations','grid_operations_epoch_fk'],['grid_operations','grid_operations_level_epoch_fk'],['grid_exact_fills','grid_exact_fills_operation_epoch_fk'],['grid_control_requests','grid_control_origin_epoch_fk'],['grid_auto_resume','grid_auto_resume_epoch_fk']];
    for(const [table,name] of fks){await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);await pool.query(migration);expect((await pool.query('SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',[table,name])).rowCount).toBe(1);}
    const level=(await pool.query('SELECT id FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal LIMIT 1',[f.p.id])).rows[0].id;
    const op=randomUUID();
    await pool.query("INSERT INTO grid_operations(id,bot_id,level_id,idempotency_key,request_identity,type,state) VALUES($1,$2,$3,'EXAMPLE','EXAMPLE','sync','prepared')",[op,f.p.id,level]);
    await pool.query("INSERT INTO grid_exact_fills(account,trade_id,bot_id,operation_id,level_id,order_id,venue_time,leg,size,price,fee) VALUES('EXAMPLE','EXAMPLE',$1,$2,$3,'EXAMPLE',1,'entry',1,80,0)",[f.p.id,op,level]);
    // Reproduce pre-backfill rows with NULL epoch columns, then exercise the real triggers.
    const triggers=[['grid_levels','grid_levels_assign_epoch'],['grid_operations','grid_operations_assign_epoch'],['grid_exact_fills','grid_fills_assign_epoch']];
    for(const [table,trigger] of [...triggers].reverse()){
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);await pool.query(`UPDATE ${table} SET epoch_id=NULL WHERE bot_id=$1`,[f.p.id]);await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    for(const [table] of triggers){
      await expect(pool.query(`UPDATE ${table} SET epoch_id=$2 WHERE bot_id=$1`,[f.p.id,randomUUID()])).rejects.toThrow('Grid epoch scope mismatch');
      await pool.query(`UPDATE ${table} SET epoch_id=$2 WHERE bot_id=$1`,[f.p.id,f.epoch.id]);
      await expect(pool.query(`UPDATE ${table} SET epoch_id=NULL WHERE bot_id=$1`,[f.p.id])).rejects.toThrow('Grid epoch identity is immutable');
    }
    const c=await pool.connect();try{expect((await loadActiveGridLevels(c,f.p.id,'all')).rows.every(l=>!Object.hasOwn(l,'epoch_id'))).toBe(true);}finally{c.release();}
  },30000);
});
