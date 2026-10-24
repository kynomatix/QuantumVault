import {mainQuota} from './main-quota';
import type {Pool} from 'pg';
let timer:ReturnType<typeof setTimeout>|undefined;
/** No lease import or mutation. Even an unavailable host suppresses local money when the flag is on. */
export async function startMainQuotaRefresh(pool:Pool){
  if(process.env.GRID_REMOTE_WORKER_ENABLED!=='true'||timer)return;
  const refresh=async()=>{
    try{mainQuota.install((await pool.query('SELECT * FROM grid_worker_quota_policy WHERE valid_until>clock_timestamp()')).rows);}
    catch{mainQuota.install([]);}
    timer=setTimeout(()=>{void refresh();},5000);timer.unref();
  };
  await refresh();
}
export const mainMoneySuppressed=()=>process.env.GRID_REMOTE_WORKER_ENABLED==='true';
