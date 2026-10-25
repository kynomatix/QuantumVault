import type {PoolClient} from 'pg';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';
import {RECONCILIATION_STREAMS} from './reconciliation';
export async function transitionHistoryReady(c:PoolClient):Promise<boolean>{return OWNER_MASTER_PUBLIC_KEYS.length>0&&!(await c.query(`WITH accounts AS (
      SELECT unnest($2::text[]) AS account,false AS grid
      UNION SELECT p.protocol_subaccount_id,EXISTS(SELECT 1 FROM grid_launch_accounts a WHERE a.protocol_subaccount_id=p.id)
        FROM protocol_subaccounts p WHERE p.protocol='pacifica' AND p.agent_public_key=ANY($2::text[]) AND p.protocol_subaccount_id IS NOT NULL)
    SELECT 1 FROM accounts a CROSS JOIN jsonb_array_elements_text($1::jsonb) s(stream)
    WHERE (a.grid OR s.stream IN ('transfers','withdrawals')) AND NOT EXISTS(
      SELECT 1 FROM grid_worker_reconciliation r WHERE r.account=a.account AND r.stream=s.stream
      AND r.state='complete' AND r.last_complete_at BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()
      AND r.covered_through_at BETWEEN clock_timestamp()-interval '125 seconds' AND clock_timestamp()) LIMIT 1`,
    [JSON.stringify(RECONCILIATION_STREAMS),OWNER_MASTER_PUBLIC_KEYS])).rowCount;}
