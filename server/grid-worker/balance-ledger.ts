import {gridPayload} from './payload';
import type {Pool} from 'pg';
import Decimal from 'decimal.js';
import type {OwnedBalanceEvent} from './balance-history';
import {balanceDecimal} from './balance-history';

/** Account-bound retained records only. Missing order/fill lineage never explains an outflow. */
export async function ownedBalanceEvents(pool:Pick<Pool,'query'>,account:string):Promise<OwnedBalanceEvent[]> {
  const events:OwnedBalanceEvent[]=[];
  const transfers=(await pool.query(`SELECT id,exact_request,submitted_at,terminal_at,state FROM grid_operations
    WHERE type IN ('fund_subaccount','sweep_subaccount') AND state IN ('submitted','unconfirmed','confirmed')
      AND (exact_request->>'account'=$1 OR exact_request->>'masterAccount'=$1) ORDER BY created_at,id LIMIT 10001`,[account])).rows;
  if(transfers.length>10000)throw Error('GRID_BALANCE_LEDGER_BOUND');
  for(const row of transfers){
    const r=row.exact_request;
    if(!r||!['fund','sweep'].includes(r.kind)||!Number.isSafeInteger(r.timestamp)||!Number.isSafeInteger(r.expiryMs)
      ||r.expiryMs<1||r.expiryMs>15000||!row.submitted_at)throw Error('GRID_BALANCE_LEDGER_TRANSFER');
    const payload=gridPayload(r);
    const amount=new Decimal(balanceDecimal(payload.amount));
    if(!amount.gt(0)||r.account===r.masterAccount)throw Error('GRID_BALANCE_LEDGER_TRANSFER');
    const decreases=r.kind==='fund'?account===r.masterAccount:account===r.account;
    events.push({id:'grid:'+row.id,account,kind:'subaccount_transfer',amount:amount.mul(decreases?-1:1).toFixed(),
      earliest:r.timestamp,latest:r.timestamp+r.expiryMs,publicationRequired:true});
  }
  return events;
}

export interface LedgerFill {id:string;orderId:string;fillId:string|null;symbol:string;size:string;price:string;fee:string}
export async function retainedBalanceFills(pool:Pick<Pool,'query'>,account:string):Promise<LedgerFill[]>{
  const rows=(await pool.query(`SELECT 'grid:'||f.trade_id AS id,f.order_id AS "orderId",f.trade_id AS "fillId",
      replace(b.market,'-PERP','') AS symbol,f.size,f.price,f.fee
    FROM grid_exact_fills f JOIN grid_bots b ON b.id=f.bot_id JOIN grid_operations o ON o.id=f.operation_id AND o.bot_id=f.bot_id
    WHERE f.account=$1 AND o.venue_order_id=f.order_id
    UNION ALL SELECT 'signal:'||t.id,t.protocol_order_id,t.protocol_fill_id,replace(t.market,'-PERP',''),
      t.filled_size_base,t.average_fill_price,t.fee FROM bot_trades t JOIN trading_bots b ON b.id=t.trading_bot_id
      LEFT JOIN protocol_subaccounts p ON p.bot_id=b.id AND p.protocol='pacifica'
      WHERE t.protocol='pacifica' AND t.protocol_status IN ('filled','partial_fill')
        AND coalesce(p.protocol_subaccount_id,b.agent_public_key)=$1 AND t.protocol_order_id IS NOT NULL
        AND t.filled_size_base IS NOT NULL AND t.average_fill_price IS NOT NULL AND t.fee IS NOT NULL
    UNION ALL SELECT 'ai:'||id,venue_order_id,NULL,replace(market,'-PERP',''),size_base,price,fee
      FROM ai_trader_execution_events WHERE protocol='pacifica' AND account_ref=$1 AND event_type='fill_observed'
        AND venue_order_id IS NOT NULL AND size_base IS NOT NULL AND price IS NOT NULL AND fee IS NOT NULL
    LIMIT 10001`,[account])).rows;
  if(rows.length>10000)throw Error('GRID_BALANCE_LEDGER_BOUND');
  return rows;
}
