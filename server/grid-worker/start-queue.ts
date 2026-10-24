import type {Pool,PoolClient} from 'pg';
import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
import type {LaunchFacts} from '../grid-bot/launch-preflight';
import type {SpendingFacts} from './spending';
import {WorkerStartRequests,verifyAdmittedStart,releaseTerminalReservation,type WorkerRequestContext} from './requests';
import type {GridIncidents} from './incidents';
import type {GridStartRequest} from '../../shared/grid-start';
export interface StartFacts {launch:LaunchFacts;spending:SpendingFacts}
/** Every admission, refresh and final verifier uses the same request identity. */
export class WorkerStartQueue {
  private readonly requests:WorkerStartRequests;
  constructor(private pool:Pool,terminate:(pid:number)=>Promise<void>,incidents:GridIncidents,
    private holder:()=>WorkerRequestContext,private security:Pick<GridRuntimeDependencies,'umk'>,
    private facts:(botId:string,umk:Buffer,signal:AbortSignal)=>Promise<StartFacts>,
    private start:(wallet:string,id:string,expected:GridStartRequest,signal:AbortSignal)=>Promise<unknown>){
    this.requests=new WorkerStartRequests(pool,terminate,incidents);
  }
  async one(signal:AbortSignal){
    const row=(await this.pool.query(`SELECT id,owner_wallet,bot_id,draft_revision,server_intent_digest FROM grid_worker_requests
      WHERE state='pending' AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 1`)).rows[0];
    if(!row)return;
    const key=await this.security.umk(row.owner_wallet);if(!key)throw Error('GRID_START_AUTHORITY_UNAVAILABLE');
    try{
      const facts=await this.facts(row.bot_id,key.umk,signal);signal.throwIfAborted();
      await this.requests.admit(row.id,this.holder(),key.umk,facts.launch,facts.spending);
      // admit has COMMITTED before custody/start can run. Abort never releases a reservation.
      signal.throwIfAborted();
      await this.requests.refresh(row.id,this.holder(),facts.spending);
      await this.start(row.owner_wallet,row.bot_id,{draftRevision:row.draft_revision,serverIntentDigest:row.server_intent_digest},signal);
    }finally{key.cleanup();}
  }
  async verify(c:PoolClient,botId:string){
    const row=(await c.query("SELECT id,owner_wallet FROM grid_worker_requests WHERE bot_id=$1 AND state='admitted'",[botId])).rows[0];
    if(!row)throw Error('GRID_START_AUTHORITY_UNAVAILABLE');
    // The locked connection is used for the key read, avoiding pool starvation under the final fence.
    const {getExecutionUmk}=await import('../execution/umk');const key=await getExecutionUmk(c,row.owner_wallet);
    if(!key)throw Error('GRID_START_AUTHORITY_UNAVAILABLE');
    try{await verifyAdmittedStart(c,row.id,this.holder(),key.umk);}finally{key.cleanup();}
  }
  async release(c:PoolClient,botId:string){
    const row=(await c.query("SELECT start_request_id FROM grid_worker_reservations WHERE bot_id=$1 AND state IN ('held','uncertain')",[botId])).rows[0];
    if(row)await releaseTerminalReservation(c,row.start_request_id,this.holder());
  }
}
