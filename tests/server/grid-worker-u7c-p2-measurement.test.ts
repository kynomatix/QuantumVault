import {expect,it} from 'vitest';
import {Pool} from 'pg';
import {createHash,randomInt,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';

// Test-only first-install sizing. Never connects outside the runner's qvtest DB.
it('measures the real P2 first-install transaction at 135 wallets',async()=>{
  const connectionString=process.env.DATABASE_URL;
  if(process.platform!=='linux'||!connectionString||new URL(connectionString).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--skipLibCheck','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--esModuleInterop','tests/server/grid-worker-u7c-p2-measurement.test.ts'],{stdio:'pipe',timeout:120_000});
  const namespace='grid_u7c_'+randomUUID().replaceAll('-','');
  const lockPrefix='qv:grid-worker:v3:'+randomUUID()+':',walletNamespace=String(randomInt(1_000_000,2_000_000_000));
  const isolate=(sql:string)=>sql.replaceAll('qv:grid-worker:v3:',lockPrefix).replaceAll('927412',walletNamespace)
    .replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+namespace);
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const sourceSql=readFileSync('tests/fixtures/grid-worker-p2-held.sql','utf8');
  const executedSql=isolate(sourceSql);
  const packageSql=readFileSync('migrations/grid_worker_v3_owner.sql','utf8');
  const admin=new Pool({connectionString,max:1});
  let pool:Pool|undefined,created=false;
  try{
    await admin.query('CREATE SCHEMA '+namespace);created=true;
    pool=new Pool({connectionString,max:2,options:'-c search_path='+namespace+',pg_catalog'});
    // Same real table/default/index setup as the accepted U2c PostgreSQL suite.
    // Rows are private; explicit IDs avoid advancing any public serial sequence.
    const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename !~ '^grid_worker_' AND tablename<>'owner_action_receipts'")).rows;
    for(const {tablename} of tables){
      if(!/^[a-z0-9_]+$/.test(tablename))throw Error('EXAMPLE_TABLE');
      await pool.query(`CREATE TABLE ${tablename} (LIKE public.${tablename} INCLUDING ALL)`);
    }
    await pool.query(isolate(packageSql));
    const count=135,agentCount=Math.ceil(count*26/35),subaccountCount=Math.ceil(count/35);
    await pool.query(`INSERT INTO wallets(address,agent_public_key) SELECT 'EXAMPLE_WALLET_'||lpad(i::text,3,'0'),
      CASE WHEN i<=$2 THEN 'EXAMPLE_MASTER_'||i ELSE NULL END FROM generate_series(1,$1::integer) i`,[count,agentCount]);
    await pool.query(`INSERT INTO protocol_subaccounts(id,wallet_address,protocol,protocol_subaccount_id,status,agent_public_key)
      SELECT i,'EXAMPLE_WALLET_'||lpad(i::text,3,'0'),'pacifica','EXAMPLE_ACCOUNT_'||i,'spare','EXAMPLE_MASTER_'||i
      FROM generate_series(1,$1::integer) i`,[subaccountCount]);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query(isolate("SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0))"));
      await c.query("INSERT INTO grid_worker_owner(wallet_address) VALUES('EXAMPLE_WALLET_001')");
      await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1','EXAMPLE_WALLET_001')");
      await c.query('COMMIT');
      const before=(await c.query(`SELECT (SELECT count(*)::integer FROM wallets) AS wallets,
        (SELECT count(*)::integer FROM wallets WHERE agent_public_key IS NOT NULL) AS agents,
        (SELECT count(*)::integer FROM protocol_subaccounts) AS subaccounts,
        (SELECT count(*)::integer FROM grid_bots) AS bots,(SELECT count(*)::integer FROM grid_launch_accounts) AS launches,
        (SELECT count(*)::integer FROM grid_worker_wallet_authority) AS authority`)).rows[0];
      expect(before).toEqual({wallets:135,agents:101,subaccounts:4,bots:0,launches:0,authority:0});
      // This readiness value permits an isolated experiment; it is NOT its result.
      await c.query("SELECT set_config('qv.u2c_readiness',$1,false)",[JSON.stringify({published:true,incompatibleProcessesRetired:true,
        outsideDbFirstInstallRecord:'EXAMPLE_U7C_MEASUREMENT_ONLY',productionWalletCount:count,measuredP2DurationMs:1})]);
      const started=performance.now();
      await c.query(executedSql); // Includes BEGIN, both lock loops, backfill and COMMIT.
      const elapsedMs=performance.now()-started;
      // Read back using another connection to establish committed visibility.
      const after=(await pool.query(`SELECT (SELECT count(*)::integer FROM grid_worker_wallet_authority) AS authority,
        (SELECT count(*)::integer FROM wallets w LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=w.address WHERE a.wallet_address IS NULL) AS missing,
        (SELECT bool_and(generation=0) FROM grid_worker_wallet_authority) AS initial,
        (SELECT authority_tracking_enabled FROM grid_worker_host) AS tracking`)).rows[0];
      expect(after).toEqual({authority:135,missing:0,initial:true,tracking:true});
      console.log('P2_MEASUREMENT '+JSON.stringify({kind:'P2_MEASUREMENT',elapsedMs,walletCount:count,agentCount,subaccountCount,
        gridBotCount:0,gridLaunchAccountCount:0,sqlSha256:hash(sourceSql),executedSqlSha256:hash(executedSql),packageSha256:hash(packageSql),
        commitHash:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),host:hostname(),thresholdMs:2000,
        passed:elapsedMs<2000,committed:true,lockNamespaceIsolated:true}));
      expect(elapsedMs).toBeLessThan(2000);
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }finally{
    await pool?.end();
    if(created)await admin.query('DROP SCHEMA '+namespace+' CASCADE');
    await admin.end();
  }
},180_000);
