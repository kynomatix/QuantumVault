import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readDbSchemaMigrationManifest} from '../helpers/schema-migration-manifest';
import {applySchemaMigrationManifest,probeSchemaMigrationManifest,type CatalogQuery} from '../../server/schema-readiness';
import {behaviourPolicy} from './behaviour-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {umk} from './draft-fixtures';

const entries=readDbSchemaMigrationManifest().manifest.slice(201,203);
const sql=(name:string)=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const epochFks=[
  ['grid_epochs','grid_epochs_control_request_fk'],['grid_epochs','grid_epochs_predecessor_fk'],
  ['grid_bots','grid_bots_active_epoch_fk'],['grid_levels','grid_levels_epoch_fk'],
  ['grid_operations','grid_operations_epoch_fk'],['grid_operations','grid_operations_level_epoch_fk'],
  ['grid_exact_fills','grid_exact_fills_operation_epoch_fk'],['grid_control_requests','grid_control_origin_epoch_fk'],
  ['grid_auto_resume','grid_auto_resume_epoch_fk'],
];
async function catalog(pool:Pool,schema:string){
  const normalize=(s:string)=>s.replaceAll(quote(schema)+'.','').replaceAll(schema+'.','');
  const columns=(await pool.query(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[schema])).rows;
  const constraints=(await pool.query(`SELECT r.relname AS table_name,c.conname AS name,c.contype AS type,
    pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    WHERE c.connamespace=$1::regnamespace ORDER BY r.relname,c.conname`,[schema])).rows;
  const indexes=(await pool.query(`SELECT t.relname AS table_name,c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    WHERE t.relnamespace=$1::regnamespace AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u','x'))
    ORDER BY t.relname,c.relname`,[schema])).rows;
  const triggers=(await pool.query(`SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=$1::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,[schema])).rows;
  const functions=(await pool.query(`SELECT proname AS name,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=$1::regnamespace ORDER BY proname`,[schema])).rows;
  return JSON.parse(normalize(JSON.stringify({columns,constraints,indexes,triggers,functions}))) as {
    columns:Array<{table_name:string;name:string;type:string;required:boolean;value:string|null}>;
    constraints:Array<{table_name:string;name:string;type:string;definition:string}>;
    indexes:Array<{table_name:string;name:string;definition:string}>;
    triggers:Array<{table_name:string;name:string;definition:string}>;
    functions:Array<{name:string;definition:string}>;
  };
}

describe('publish from the live dev catalog before runtime entries 201/202',()=>{
  let admin:Pool,dev:Pool,prod:Pool,devSchema:string,prodSchema:string;
  beforeAll(()=>{
    const url=process.env.DATABASE_URL;
    if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schemas required');
    admin=new Pool({connectionString:url,max:1});
  });
  beforeEach(async()=>{
    const prefix='grid_publish_'+randomUUID().replaceAll('-','');devSchema=prefix+'_dev';prodSchema=prefix+'_prod';
    for(const name of [devSchema,prodSchema])await admin.query('CREATE SCHEMA '+quote(name));
    dev=new Pool({connectionString:process.env.DATABASE_URL,max:4,options:'-c search_path='+devSchema+',pg_catalog'});
    prod=new Pool({connectionString:process.env.DATABASE_URL,max:4,options:'-c search_path='+prodSchema+',pg_catalog'});
    for(const pool of [dev,prod]){
      // Only non-grid dependencies are stubs. Every grid table/index/constraint
      // comes from the actual migrations through 0011, with no epoch entry.
      await pool.query('CREATE TABLE wallets(address text PRIMARY KEY); CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY)');
      for(const name of ['0004_grid_bot_drafts.sql','0005_grid_launch.sql','0006_grid_monitor.sql','0007_grid_lifecycle.sql','0011_grid_auto_resume.sql'])await pool.query(sql(name));
      await pool.query("INSERT INTO wallets VALUES('EXAMPLE')");
    }
  });
  afterEach(async()=>{
    await dev?.end();await prod?.end();
    for(const name of [devSchema,prodSchema])if(name)await admin.query('DROP SCHEMA IF EXISTS '+quote(name)+' CASCADE');
  });
  afterAll(async()=>{await admin?.end();});

  async function legacy(pool:Pool){
    const p={...behaviourPolicy('repeat_all','long',false),id:randomUUID()};
    const signed=computeGridPolicyHmac(p,umk());if(!signed.ok)throw Error('EXAMPLE policy invalid');
    const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=p;
    const record={...base,walletAddress:'EXAMPLE',clientRequestId:randomUUID(),serverIntentDigest:createHash('sha256').update('EXAMPLE').digest('hex').toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},policyHmac:signed.digest,rangeSource:'manual',chartTimeframe:'15m'};
    const fields=Object.entries(record),snake=(s:string)=>s.replace(/[A-Z]/g,(c)=>'_'+c.toLowerCase());
    await pool.query(`INSERT INTO grid_bots(${fields.map(([k])=>snake(k)).join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,fields.map(([,v])=>v));
    for(const l of levels)await pool.query('INSERT INTO grid_levels(id,bot_id,ordinal,price,size,side,reduce_only) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.id,l.ordinal,l.price,l.size,l.side,l.reduceOnly]);
    return p.id;
  }
  function scopedQuery(pool:Pool):CatalogQuery{
    const schema=pool===dev?devSchema:prodSchema;
    // Production readiness deliberately targets public; redirect only its
    // catalog namespace into this test's isolated, disposable schema.
    return (text,values)=>pool.query(text.replaceAll("'public'",`'${schema}'`),values?.map((v)=>typeof v==='string'?v.replace(/^public\./,schema+'.'):v));
  }
  async function startup(pool:Pool){
    const result=await applySchemaMigrationManifest(scopedQuery(pool),entries);
    expect(result.evidence).toEqual([]);return result;
  }
  async function fixture(){
    const a=await legacy(dev),b=await legacy(dev);await startup(dev);
    const epoch=async(id:string)=>(await dev.query('SELECT active_epoch_id AS id FROM grid_bots WHERE id=$1',[id])).rows[0].id as string;
    const level=async(id:string)=>(await dev.query('SELECT id FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal LIMIT 1',[id])).rows[0].id as string;
    return {a,b,ae:await epoch(a),be:await epoch(b),al:await level(a),bl:await level(b)};
  }
  async function operation(bot:string,level:string|null,epoch?:string){
    const id=randomUUID();await dev.query("INSERT INTO grid_operations(id,bot_id,level_id,epoch_id,idempotency_key,request_identity,type,state) VALUES($1::uuid,$2,$3,$4,$1::uuid::text,$1::uuid::text,'sync','prepared')",[id,bot,level,epoch??null]);return id;
  }
  async function request(bot:string,epoch:string){
    const id=randomUUID();await dev.query("INSERT INTO grid_control_requests(id,bot_id,origin_epoch_id,request_key,action,source,previous_status,evidence) VALUES($1::uuid,$2,$3,$1::uuid::text,'regrid','owner','range_exhausted','{}')",[id,bot,epoch]);return id;
  }
  async function successor(bot:string,predecessor:string,control:string,client:Pick<Pool,'query'>=dev){
    const id=randomUUID();await client.query(`INSERT INTO grid_epochs(id,bot_id,ordinal,predecessor_id,creating_control_request_id,policy_version,policy_snapshot,policy_hmac,carry_snapshot,carry_digest,confirmation,reason,activated_at,direction,lower_price,upper_price,stop_loss_price,grid_count)
      SELECT $1,$2,2,$3,$4,policy_version,policy_snapshot,policy_hmac,carry_snapshot,policy_hmac,confirmation,'EXAMPLE',activated_at,direction,lower_price,upper_price,stop_loss_price,grid_count FROM grid_epochs WHERE id=$3`,[id,bot,predecessor,control]);return id;
  }

  it('reproduces the original missing-unique failure and applies catalog DDL with every FK before new uniques/indexes',async()=>{
    const devBot=await legacy(dev),prodBot=await legacy(prod);
    await dev.query(entries[0].sql); // Already-migrated dev, the reported failure state.
    expect((await prod.query("SELECT to_regclass('grid_epochs') AS value")).rows[0].value).toBeNull();
    const old=(await catalog(dev,devSchema)).constraints.find((c)=>c.name==='grid_epochs_control_request_fk')!;
    await prod.query('CREATE TABLE publish_failure_probe(bot_id uuid,creating_control_request_id uuid)');
    await expect(prod.query('ALTER TABLE publish_failure_probe ADD CONSTRAINT probe_fk '+old.definition)).rejects.toThrow('there is no unique constraint');
    await prod.query('DROP TABLE publish_failure_probe');
    await dev.query(entries[1].sql); // 202 must repair dev without replaying 201.
    const shape=await catalog(dev,devSchema),before=await catalog(prod,prodSchema);
    const oldTables=new Set(before.columns.map((c)=>c.table_name)),newTables=[...new Set(shape.columns.map((c)=>c.table_name))].filter((t)=>!oldTables.has(t));
    expect(newTables.sort()).toEqual(['grid_epochs','grid_trailing']);
    const columnSql=(c:typeof shape.columns[number])=>`${quote(c.name)} ${c.type}${c.value===null?'':' DEFAULT '+c.value}${c.required?' NOT NULL':''}`;
    for(const table of newTables){
      const pk=shape.constraints.filter((c)=>c.table_name===table&&c.type==='p').map((c)=>'CONSTRAINT '+quote(c.name)+' '+c.definition);
      await prod.query(`CREATE TABLE ${quote(table)} (${[...shape.columns.filter((c)=>c.table_name===table).map(columnSql),...pk].join(',')})`);
    }
    const addedColumns=shape.columns.filter((c)=>oldTables.has(c.table_name)&&!before.columns.some((b)=>b.table_name===c.table_name&&b.name===c.name));
    expect(addedColumns).toHaveLength(6);
    for(const c of addedColumns)await prod.query(`ALTER TABLE ${quote(c.table_name)} ADD COLUMN ${columnSql(c)}`);
    const changes=shape.constraints.filter((c)=>!(newTables.includes(c.table_name)&&c.type==='p')&&!before.constraints.some((b)=>b.table_name===c.table_name&&b.name===c.name&&b.definition===c.definition));
    // Adversarial but realistic publish order: all referenced PKs exist, while
    // *no* newly introduced non-PK unique/index has been installed yet.
    for(const c of [...changes.filter((c)=>c.type==='f'),...changes.filter((c)=>c.type!=='f')]){
      if(before.constraints.some((b)=>b.table_name===c.table_name&&b.name===c.name))await prod.query(`ALTER TABLE ${quote(c.table_name)} DROP CONSTRAINT ${quote(c.name)}`);
      await prod.query(`ALTER TABLE ${quote(c.table_name)} ADD CONSTRAINT ${quote(c.name)} ${c.definition}`);
    }
    for(const i of shape.indexes.filter((i)=>!before.indexes.some((b)=>b.name===i.name&&b.definition===i.definition))){
      if(before.indexes.some((b)=>b.name===i.name))await prod.query('DROP INDEX '+quote(i.name));
      await prod.query(i.definition);
    }
    expect((await prod.query('SELECT count(*) AS n FROM grid_epochs')).rows[0].n).toBe('0');
    await startup(prod);await startup(dev);
    expect(await catalog(prod,prodSchema)).toEqual(await catalog(dev,devSchema));
    for(const [pool,bot] of [[dev,devBot],[prod,prodBot]] as const){
      expect((await pool.query('SELECT count(*) AS n FROM grid_epochs WHERE bot_id=$1',[bot])).rows[0].n).toBe('1');
      expect((await pool.query('SELECT count(*) AS n FROM grid_levels WHERE bot_id=$1 AND epoch_id IS NULL',[bot])).rows[0].n).toBe('0');
    }
    const stable=await catalog(prod,prodSchema);await startup(prod);expect(await catalog(prod,prodSchema)).toEqual(stable);
    const fks=(await prod.query(`SELECT c.conname,cardinality(c.conkey) AS width,p.contype AS parent_type
      FROM pg_constraint c JOIN pg_constraint p ON p.conrelid=c.confrelid AND p.conindid=c.conindid AND p.contype='p'
      WHERE c.connamespace=$1::regnamespace AND c.conname=ANY($2)`,[prodSchema,epochFks.map(([,name])=>name)])).rows;
    expect(fks).toHaveLength(9);expect(fks.every((f)=>f.width===1&&f.parent_type==='p')).toBe(true);
  },30000);

  it('rejects cross-bot epochs, control requests, levels and fills on INSERT and UPDATE',async()=>{
    const f=await fixture(),ar=await request(f.a,f.ae),br=await request(f.b,f.be);
    await expect(request(f.a,f.be)).rejects.toThrow('Grid epoch scope mismatch');
    await expect(successor(f.a,f.be,ar)).rejects.toThrow('Grid epoch scope mismatch');
    await expect(successor(f.a,f.ae,br)).rejects.toThrow('Grid epoch scope mismatch');
    await expect(dev.query('UPDATE grid_bots SET active_epoch_id=$2 WHERE id=$1',[f.a,f.be])).rejects.toThrow('Grid epoch scope mismatch');
    await expect(dev.query('UPDATE grid_control_requests SET origin_epoch_id=$2 WHERE id=$1',[ar,f.be])).rejects.toThrow('Grid epoch scope mismatch');
    await expect(dev.query('INSERT INTO grid_auto_resume(bot_id,armed_epoch_id) VALUES($1,$2)',[f.a,f.be])).rejects.toThrow('Grid epoch scope mismatch');
    await dev.query('INSERT INTO grid_auto_resume(bot_id) VALUES($1)',[f.a]);
    await expect(dev.query('UPDATE grid_auto_resume SET armed_epoch_id=$2 WHERE bot_id=$1',[f.a,f.be])).rejects.toThrow('Grid epoch scope mismatch');
    await expect(dev.query("INSERT INTO grid_levels(id,bot_id,epoch_id,ordinal,price,size,side,reduce_only) VALUES($1,$2,$3,50,80,1,'buy',false)",[randomUUID(),f.a,f.be])).rejects.toThrow('Grid epoch scope mismatch');
    await expect(operation(f.a,f.bl)).rejects.toThrow('Grid epoch scope mismatch');
    const ao=await operation(f.a,f.al),bo=await operation(f.b,f.bl);
    await expect(dev.query('UPDATE grid_operations SET level_id=$2 WHERE id=$1',[ao,f.bl])).rejects.toThrow('Grid epoch scope mismatch');
    const fillSql="INSERT INTO grid_exact_fills(account,trade_id,bot_id,operation_id,order_id,venue_time,leg,size,price,fee) VALUES('EXAMPLE',$1,$2,$3,'EXAMPLE',1,'entry',1,80,0)";
    await expect(dev.query(fillSql,['bad',f.a,bo])).rejects.toThrow('Grid epoch scope mismatch');
    await dev.query(fillSql,['good',f.a,ao]);
    await expect(dev.query("UPDATE grid_exact_fills SET operation_id=$1 WHERE trade_id='good'",[bo])).rejects.toThrow('Grid epoch scope mismatch');
    for(const [table,key,id] of [['grid_levels','id',f.al],['grid_operations','id',ao],['grid_control_requests','id',ar],['grid_exact_fills','trade_id','good']]){
      await expect(dev.query(`UPDATE ${table} SET bot_id=$1 WHERE ${key}=$2`,[f.b,id])).rejects.toThrow('Grid scope identity is immutable');
    }
    await expect(dev.query('UPDATE grid_bots SET id=$2 WHERE id=$1',[f.a,randomUUID()])).rejects.toThrow('Grid scope identity is immutable');
    const next=await successor(f.a,f.ae,ar);await dev.query('UPDATE grid_bots SET active_epoch_id=$2 WHERE id=$1',[f.a,next]);
    const newLevel=randomUUID();await dev.query("INSERT INTO grid_levels(id,bot_id,ordinal,price,size,side,reduce_only) VALUES($1,$2,1,80,1,'buy',false)",[newLevel,f.a]);
    await expect(dev.query('UPDATE grid_operations SET level_id=$2 WHERE id=$1',[ao,newLevel])).rejects.toThrow('Grid epoch scope mismatch');
    await expect(operation(f.a,newLevel,f.ae)).rejects.toThrow('Grid epoch scope mismatch');
    const newOp=await operation(f.a,newLevel);
    await expect(dev.query("UPDATE grid_exact_fills SET operation_id=$1 WHERE trade_id='good'",[newOp])).rejects.toThrow('Grid epoch scope mismatch');
    // Updating historical non-identity state remains valid after activation.
    await dev.query("UPDATE grid_levels SET status='cancelled' WHERE id=$1",[f.al]);
    await dev.query('UPDATE grid_operations SET attempt=attempt+1 WHERE id=$1',[ao]);
    await dev.query("UPDATE grid_exact_fills SET fee=0 WHERE trade_id='good'");
    await expect(dev.query('DELETE FROM grid_control_requests WHERE id=$1',[ar])).rejects.toThrow('foreign key constraint');
  },30000);

  it('locks the referenced control row and prevents parent reassignment after validation',async()=>{
    const f=await fixture(),ar=await request(f.a,f.ae),c=await dev.connect(),racer=await dev.connect();
    try{
      await c.query('BEGIN');await successor(f.a,f.ae,ar,c);
      await expect(racer.query('SELECT 1 FROM grid_control_requests WHERE id=$1 FOR UPDATE NOWAIT',[ar])).rejects.toThrow('could not obtain lock');
      await c.query('COMMIT');
      await expect(racer.query('UPDATE grid_control_requests SET bot_id=$2 WHERE id=$1',[ar,f.b])).rejects.toThrow('Grid scope identity is immutable');
    }finally{await c.query('ROLLBACK');c.release();racer.release();}
  });

  it('repairs each FK independently and fails readiness for a disabled or weakened scope guard',async()=>{
    await fixture();const stable=await catalog(dev,devSchema);
    for(const [table,name] of epochFks){
      await dev.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);await dev.query(entries[1].sql);
      expect(await catalog(dev,devSchema)).toEqual(stable);
    }
    const probe=()=>probeSchemaMigrationManifest(scopedQuery(dev),entries);
    for(const trigger of stable.triggers.filter((t)=>t.name!=='grid_epoch_immutable')){
      await dev.query(`ALTER TABLE ${trigger.table_name} DISABLE TRIGGER ${trigger.name}`);
      expect((await probe()).unavailableCapabilities).toContain('grid_bot');
      await dev.query(`DROP TRIGGER ${trigger.name} ON ${trigger.table_name}`);await dev.query(entries[1].sql);
    }
    await dev.query("CREATE OR REPLACE FUNCTION grid_assign_epoch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'");
    expect((await probe()).unavailableCapabilities).toContain('grid_bot');
    await dev.query(entries[1].sql);expect((await probe()).evidence).toEqual([]);
    // A publish-created weak FK cannot bless pre-existing cross-bot data.
    await dev.query('ALTER TABLE grid_bots DISABLE TRIGGER grid_bots_validate_scope');
    await dev.query('UPDATE grid_bots b SET active_epoch_id=e.id FROM grid_epochs e WHERE e.bot_id<>b.id');
    await expect(dev.query(entries[1].sql)).rejects.toThrow('Grid epoch scope mismatch during publish migration');
  },30000);
});
