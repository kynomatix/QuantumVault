import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TradingBot } from '../../../shared/schema';
import { recordPhoenixCustodyHealth, type PhoenixCustodyHealthSample } from '../../dependency-health-record';
import { phoenixBotFromRow } from './signal-control';
import type { StoredPhoenixOperation } from './operation-store';
import type { PhoenixOrderRecord } from './order-store';

export interface PhoenixRecoveryIO {
  operation(bot: TradingBot, op: StoredPhoenixOperation): Promise<unknown>;
  order(record: PhoenixOrderRecord): Promise<unknown>;
  accounting(bot: TradingBot): Promise<unknown>;
  /** Null means any cohort/domain is incomplete. Never substitute zero counts. */
  health(): Promise<PhoenixCustodyHealthSample | null>;
}
export class PhoenixRecoveryWorker {
  private running = false;
  private cursor = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly pool: Pick<Pool,'connect'>, private readonly io: PhoenixRecoveryIO) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => console.warn('[Phoenix] Recovery batch unavailable')); },30_000);
    this.timer.unref();
    void this.runOnce().catch(() => console.warn('[Phoenix] Recovery batch unavailable'));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer=null; }
  async runOnce() {
    if (this.running) return { skipped: true };
    this.running=true;
    let c: PoolClient | undefined, locked=false;
    try {
      c=await this.pool.connect();
      // Session exclusion covers other processes and releases on crash. The
      // JSON claim below retains the admission/completion across restarts.
      locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('phoenix-runtime-recovery',0)) AS locked")).rows[0]?.locked===true;
      if (!locked) return { skipped: true };
      const bots=(await c.query(`SELECT b.* FROM trading_bots b WHERE active_protocol='phoenix' AND id>$1
        AND EXISTS(SELECT 1 FROM phoenix_operations o WHERE o.bot_id=b.id AND o.kind='register') ORDER BY id LIMIT 8`,[this.cursor])).rows;
      if (!bots.length) this.cursor='';
      let failures=0;
      for (const row of bots) {
        const bot=phoenixBotFromRow(row);
        const previous=(await c.query("SELECT observation->'runtimeRecovery' AS claim FROM phoenix_operations WHERE bot_id=$1 AND kind='register'",[bot.id])).rows[0]?.claim;
        const claim={claimId:randomUUID(),startedAt:Date.now(),status:'running',
          operationCursor:typeof previous?.operationCursor==='string'?previous.operationCursor:'',orderCursor:typeof previous?.orderCursor==='string'?previous.orderCursor:''};
        this.cursor=bot.id;
        await c.query(`UPDATE phoenix_operations SET observation=COALESCE(observation,'{}'::jsonb)||jsonb_build_object('runtimeRecovery',$2::jsonb),
          revision=revision+1,updated_at=now() WHERE bot_id=$1 AND kind='register'`,[bot.id,JSON.stringify(claim)]);
        let failed=false;
        const attempt=async (fn:()=>Promise<unknown>) => { try { await fn(); } catch { failures++; failed=true; } };
        // Inactive, paused, archived and expired-policy bots remain in the cohort.
        const ops=(await c.query(`SELECT * FROM phoenix_operations WHERE bot_id=$1 AND id::text>$2 AND (state IN ('submission_pending','queued','unknown')
          OR (kind='protection' AND state='prepared' AND (observation->'protection'->>'step') ~ '^[1-9][0-9]*$'))
          ORDER BY id::text LIMIT 16`,[bot.id,claim.operationCursor])).rows as StoredPhoenixOperation[];
        for (const op of ops) await attempt(()=>this.io.operation(bot,op));
        claim.operationCursor=ops.at(-1)?.id??'';
        const orders=(await c.query(`SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND id::text>$2 AND data ? 'attempt'
          AND state NOT IN ('settled','rejected') ORDER BY id::text LIMIT 16`,[bot.id,claim.orderCursor])).rows as PhoenixOrderRecord[];
        for (const order of orders) await attempt(()=>this.io.order(order));
        claim.orderCursor=orders.at(-1)?.id??'';
        await attempt(()=>this.io.accounting(bot));
        await c.query(`UPDATE phoenix_operations SET observation=COALESCE(observation,'{}'::jsonb)||jsonb_build_object('runtimeRecovery',$2::jsonb),
          revision=revision+1,updated_at=now() WHERE bot_id=$1 AND kind='register'`,[bot.id,JSON.stringify({...claim,finishedAt:Date.now(),status:failed?'incomplete':'observed'})]);
      }
      const health=await this.io.health();
      if (health?.complete===true && Date.now()-health.observedAt<=30_000 && Date.now()-health.observedAt>=0) recordPhoenixCustodyHealth(health);
      return { skipped:false,bots:bots.length,failures };
    } finally {
      try { if (c) { try { if (locked) await c.query("SELECT pg_advisory_unlock(hashtextextended('phoenix-runtime-recovery',0))"); } finally { c.release(); } } }
      finally { this.running=false; }
    }
  }
}
