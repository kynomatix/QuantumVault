import type {PoolClient} from 'pg';
import {MAIN_QUOTA_GUARD_LOCK_NAMESPACE} from '../wallet-lock-constants';
import type {ClientLane} from './transaction';

// Separate from every worker host/wallet advisory-lock namespace. No table or migration.
const LOCK_ID=1;
export class MainQuotaGuard {
  private client:PoolClient|undefined;
  private acquiredAt=Infinity;
  private generation=0;
  private connecting:Promise<void>|undefined;
  constructor(private lane:ClientLane,private now:()=>number=Date.now,private lost:()=>void=()=>{}){}
  close(){
    const c=this.client;this.client=undefined;this.acquiredAt=Infinity;this.generation++;
    this.lost();if(c)c.release(true);
  }
  async refresh():Promise<void>{
    if(this.connecting)return this.connecting;
    this.connecting=this.check().finally(()=>{this.connecting=undefined;});
    return this.connecting;
  }
  private async check(){
    try {
      if(!this.client){
        const c=await this.lane.connect();this.client=c;
        c.on('error',()=>{if(this.client===c)this.close();});
        c.on('end',()=>{if(this.client===c)this.close();});
        const result=await c.query('SELECT pg_try_advisory_lock($1,$2) AS held',[MAIN_QUOTA_GUARD_LOCK_NAMESPACE,LOCK_ID]);
        if(this.client!==c||result.rows[0]?.held!==true)throw Error('GRID_MAIN_OWNER_UNAVAILABLE');
        this.acquiredAt=this.now();this.generation++;
      }
      const c=this.client;
      const result=await c.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND granted) AS held`,[MAIN_QUOTA_GUARD_LOCK_NAMESPACE,LOCK_ID]);
      if(this.client!==c||result.rows[0]?.held!==true)throw Error('GRID_MAIN_OWNER_UNAVAILABLE');
    } catch(error){this.close();throw error;}
  }
  async beforeSend():Promise<()=>void>{
    await this.refresh();
    const generation=this.generation,checkedAt=this.now();
    const assert=()=>{
      const now=this.now();
      if(!this.client||generation!==this.generation||now<this.acquiredAt||now-this.acquiredAt<65000
        ||now<checkedAt||now-checkedAt>=5000)throw Error('GRID_MAIN_OWNER_UNAVAILABLE');
    };
    assert();return assert;
  }
}
let active:MainQuotaGuard|undefined;
export function installMainQuotaGuard(guard:MainQuotaGuard){active=guard;}
export async function verifyMainSend():Promise<()=>void>{
  if(process.env.GRID_REMOTE_WORKER_ENABLED!=='true'||process.env.QV_PROCESS_ROLE==='grid-worker')return ()=>{};
  if(!active)throw Error('GRID_MAIN_OWNER_UNAVAILABLE');
  return active.beforeSend();
}
