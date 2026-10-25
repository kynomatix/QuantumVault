import type {PoolClient} from 'pg';
export interface HolderIdentity {bootId:string;epoch:string}
/** Shared host fence must precede this check and remain held through COMMIT. */
export async function currentWorkerHolder(c:PoolClient,h:HolderIdentity,allowExpired=false):Promise<boolean>{
  return !!(await c.query(`SELECT 1 FROM grid_worker_host WHERE singleton_id=1
    AND grid_worker_has_host_lock(false) AND holder_role='grid-worker'
    AND holder_boot_id=$1::uuid AND fencing_epoch=$2::bigint AND ($3::boolean OR lease_expires_at>clock_timestamp())`,[h.bootId,h.epoch,allowExpired])).rowCount;
}
