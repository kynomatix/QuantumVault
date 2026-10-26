import type {Pool} from 'pg';
import {latchProviderEndpoint} from '../grid-bot/provider-request-cost';
import {GridIncidents} from './incidents';
import {independentLane,backendTerminator} from './lanes';
import type {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';

/** A restart is not an owner/conductor unlatch. Retained incidents restore the latch. */
export async function restoreProviderCostLatches(pool:Pool){
  const rows=(await pool.query("SELECT dedup_key FROM grid_worker_incidents WHERE code='quota_pressure' AND dedup_key LIKE 'cost-latch:%'")).rows;
  for(const row of rows)latchProviderEndpoint(row.dedup_key.slice('cost-latch:'.length));
}
export function bindProviderCostIncidents(pool:Pool,transport:PacificaTransportAuthority){
  const incidents=new GridIncidents(independentLane(pool),backendTerminator(independentLane(pool)));
  transport.onCostLatch(async endpoint=>{
    if(!await incidents.record({code:'quota_pressure',dedupKey:'cost-latch:'+endpoint}))
      throw Error('GRID_COST_LATCH_RECORD_UNAVAILABLE');
  });
}
