import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { canonicalGridPolicy, type GridPolicy } from './policy-hmac';
import { retainedGridPolicy } from './retained-policy';

export function archivedEpochPolicy(epoch: Record<string, any>): GridPolicy {
  const snapshot=epoch.policy_snapshot;
  const policy=snapshot?.legacyBot?retainedGridPolicy(snapshot.legacyBot,snapshot.legacyLevels):snapshot;
  if(!canonicalGridPolicy(policy)||policy.id!==epoch.bot_id||policy.policyVersion!==epoch.policy_version
    ||policy.direction!==epoch.direction||policy.lowerPrice!==epoch.lower_price||policy.upperPrice!==epoch.upper_price
    ||policy.stopLossPrice!==epoch.stop_loss_price||policy.gridCount!==epoch.grid_count)throw Error('Archived epoch authority changed');
  return policy;
}

/** New drafts get the same deterministic original identity as the migration backfill. */
export async function createOriginalGridEpoch(c: PoolClient, bot: Record<string, any>, levels: Record<string, any>[]) {
  const p=retainedGridPolicy(bot,levels);
  if(!p.stopLossPrice||(p.direction==='long'?new Decimal(p.stopLossPrice).gte(p.lowerPrice):new Decimal(p.stopLossPrice).lte(p.upperPrice)))return;
  const result=await c.query(`INSERT INTO grid_epochs(id,bot_id,ordinal,policy_version,policy_snapshot,policy_hmac,carry_snapshot,confirmation,reason,activated_at,direction,lower_price,upper_price,stop_loss_price,grid_count)
    VALUES(md5('grid-epoch-1:'||($1::uuid)::text)::uuid,$1,1,$2,$3,$4,'{}','{}','original',$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [bot.id,p.policyVersion,p,bot.policy_hmac,bot.created_at,p.direction,p.lowerPrice,p.upperPrice,p.stopLossPrice,p.gridCount]);
  if(!result.rows[0])throw Error('Original epoch already exists');
  const id=result.rows[0].id;
  await c.query('UPDATE grid_bots SET active_epoch_id=$2 WHERE id=$1 AND active_epoch_id IS NULL',[bot.id,id]);
  await c.query('UPDATE grid_levels SET epoch_id=$2 WHERE bot_id=$1 AND epoch_id IS NULL',[bot.id,id]);
  await c.query('INSERT INTO grid_trailing(bot_id) VALUES($1) ON CONFLICT DO NOTHING',[bot.id]);
  bot.active_epoch_id=id;
}
