import type {PoolClient} from 'pg';

/** Every runtime geometry read uses the active epoch; NULL retains unmigrated legacy drafts. */
export function loadActiveGridLevels(client:Pick<PoolClient,'query'>,botId:string,view:'all'|'policy'|'reduction'='all'){
  const columns=view==='policy'?'ordinal,price,size,side,reduce_only':view==='reduction'?'price,size::text AS exact_size,reduce_only':
    'id,bot_id,ordinal,price,size,side,reduce_only,status,venue_order_id,client_order_uuid,placement_attempt,cumulative_filled_size,last_filled_at,created_at,updated_at';
  const order=view==='reduction'?'price,ordinal':'ordinal';
  return client.query(`SELECT ${columns} FROM grid_levels WHERE bot_id=$1 AND epoch_id IS NOT DISTINCT FROM (SELECT active_epoch_id FROM grid_bots WHERE id=$1) ORDER BY ${order}`,[botId]);
}
