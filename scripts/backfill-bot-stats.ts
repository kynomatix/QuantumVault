#!/usr/bin/env tsx
/**
 * Backfill bot stats — Task #67.
 *
 * 1. Resolves duplicate close-event rows by `protocolFillId`. The
 *    "winner" is the *most complete* row, ranked by:
 *      - status priority: executed > liquidated > recovered > pending > failed
 *      - has non-null pnl  > null pnl
 *      - has txSignature   > null
 *      - oldest executedAt (deterministic tiebreaker)
 *    All other duplicates are deleted. The DB unique index on
 *    `bot_trades.protocol_fill_id` then prevents re-introduction.
 * 2. Recomputes `tradingBots.stats.{totalTrades,winningTrades,losingTrades}`
 *    from canonical SQL (closed-position events with realized PnL) and
 *    JSON-merges them, preserving `totalPnl` / `totalVolume` /
 *    `lastTradeAt`. Emits structured per-bot before/after logs.
 *
 * Run: `tsx scripts/backfill-bot-stats.ts`
 */
import { db } from "../server/db";
import { storage } from "../server/storage";
import { tradingBots } from "../shared/schema";
import { sql } from "drizzle-orm";

interface DedupeReport {
  groups: number;
  rowsDeleted: number;
}

// Dedupes legacy null-protocolFillId close rows by structural fingerprint
// (bot, market, side, rounded size/price, minute bucket). Apply by default;
// pass --audit to dry-run.
async function auditOrApplyLegacyNullDedupe(apply: boolean): Promise<void> {
  const audit: any = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id, trading_bot_id, market, side, size, price, executed_at,
        ROW_NUMBER() OVER (
          PARTITION BY
            trading_bot_id, market, side,
            ROUND(size::numeric, 8),
            ROUND(price::numeric, 6),
            DATE_TRUNC('minute', executed_at)
          ORDER BY
            CASE status
              WHEN 'executed' THEN 0 WHEN 'liquidated' THEN 1
              WHEN 'recovered' THEN 2 WHEN 'pending' THEN 3
              WHEN 'failed' THEN 4 ELSE 5 END ASC,
            CASE WHEN pnl IS NOT NULL THEN 0 ELSE 1 END ASC,
            CASE WHEN tx_signature IS NOT NULL THEN 0 ELSE 1 END ASC,
            executed_at ASC, id ASC
        ) AS rn
      FROM bot_trades
      WHERE protocol_fill_id IS NULL
        AND status IN ('executed','liquidated','recovered')
        AND pnl IS NOT NULL
    )
    SELECT COUNT(*)::int AS losers,
           COUNT(DISTINCT trading_bot_id)::int AS affected_bots
    FROM ranked WHERE rn > 1
  `);
  const auditRow = audit.rows?.[0] ?? audit[0] ?? {};
  const loserCount = Number(auditRow.losers ?? 0);
  const affectedBots = Number(auditRow.affected_bots ?? 0);
  if (loserCount === 0) {
    console.log('[Backfill] Legacy null-protocolFillId audit: 0 candidate duplicates found');
    return;
  }
  console.log(`[Backfill] Legacy null-protocolFillId audit: ${loserCount} candidate duplicate row(s) across ${affectedBots} bot(s)`);
  if (!apply) {
    console.log('[Backfill] AUDIT MODE — no rows deleted. Drop --audit to apply.');
    return;
  }
  const result: any = await db.execute(sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY trading_bot_id, market, side,
          ROUND(size::numeric, 8), ROUND(price::numeric, 6),
          DATE_TRUNC('minute', executed_at)
        ORDER BY
          CASE status WHEN 'executed' THEN 0 WHEN 'liquidated' THEN 1
            WHEN 'recovered' THEN 2 WHEN 'pending' THEN 3
            WHEN 'failed' THEN 4 ELSE 5 END ASC,
          CASE WHEN pnl IS NOT NULL THEN 0 ELSE 1 END ASC,
          CASE WHEN tx_signature IS NOT NULL THEN 0 ELSE 1 END ASC,
          executed_at ASC, id ASC
      ) AS rn
      FROM bot_trades
      WHERE protocol_fill_id IS NULL
        AND status IN ('executed','liquidated','recovered')
        AND pnl IS NOT NULL
    ), deleted AS (
      DELETE FROM bot_trades WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM deleted)::int AS rows_deleted
  `);
  const row = result.rows?.[0] ?? result[0] ?? {};
  console.log(`[Backfill] APPLIED: deleted ${Number(row.rows_deleted ?? 0)} legacy duplicate row(s)`);
}

async function dedupeProtocolFills(): Promise<DedupeReport> {
  const result: any = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        protocol_fill_id,
        ROW_NUMBER() OVER (
          PARTITION BY protocol_fill_id
          ORDER BY
            CASE status
              WHEN 'executed'   THEN 0
              WHEN 'liquidated' THEN 1
              WHEN 'recovered'  THEN 2
              WHEN 'pending'    THEN 3
              WHEN 'failed'     THEN 4
              ELSE 5
            END ASC,
            CASE WHEN pnl IS NOT NULL THEN 0 ELSE 1 END ASC,
            CASE WHEN tx_signature IS NOT NULL THEN 0 ELSE 1 END ASC,
            executed_at ASC,
            id ASC
        ) AS rn
      FROM bot_trades
      WHERE protocol_fill_id IS NOT NULL
    ),
    losers AS (
      SELECT id, protocol_fill_id FROM ranked WHERE rn > 1
    ),
    deleted AS (
      DELETE FROM bot_trades
      WHERE id IN (SELECT id FROM losers)
      RETURNING id
    )
    SELECT
      (SELECT COUNT(DISTINCT protocol_fill_id) FROM losers)::int AS groups,
      (SELECT COUNT(*) FROM deleted)::int                       AS rows_deleted
  `);
  const row = result.rows?.[0] ?? result[0] ?? {};
  return {
    groups: Number(row.groups ?? 0),
    rowsDeleted: Number(row.rows_deleted ?? 0),
  };
}

interface BotBeforeAfter {
  botId: string;
  before: { totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number; totalVolume: number };
  after: { totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number; totalVolume: number };
}

async function recomputeAllBotStats(): Promise<{ updated: number; skipped: number; reports: BotBeforeAfter[] }> {
  const bots = await db.select({ id: tradingBots.id, stats: tradingBots.stats }).from(tradingBots);
  let updated = 0;
  let skipped = 0;
  const reports: BotBeforeAfter[] = [];
  for (const { id, stats } of bots) {
    const beforeRaw: any = stats ?? {};
    const before = {
      totalTrades: Number(beforeRaw.totalTrades ?? 0),
      winningTrades: Number(beforeRaw.winningTrades ?? 0),
      losingTrades: Number(beforeRaw.losingTrades ?? 0),
      totalPnl: Number(beforeRaw.totalPnl ?? 0),
      totalVolume: Number(beforeRaw.totalVolume ?? 0),
    };
    try {
      // Pass empty deltas so totalPnl / totalVolume / lastTradeAt are
      // preserved unchanged; only the SQL-derived counters get rewritten.
      await storage.recomputeAndMergeBotStats(id, {});
      const refreshed = await db.select({ stats: tradingBots.stats }).from(tradingBots).where(sql`${tradingBots.id} = ${id}`).limit(1);
      const afterRaw: any = refreshed[0]?.stats ?? {};
      const after = {
        totalTrades: Number(afterRaw.totalTrades ?? 0),
        winningTrades: Number(afterRaw.winningTrades ?? 0),
        losingTrades: Number(afterRaw.losingTrades ?? 0),
        totalPnl: Number(afterRaw.totalPnl ?? 0),
        totalVolume: Number(afterRaw.totalVolume ?? 0),
      };
      reports.push({ botId: id, before, after });
      const drift =
        after.totalTrades !== before.totalTrades ||
        after.winningTrades !== before.winningTrades ||
        after.losingTrades !== before.losingTrades;
      console.log(
        `[Backfill] bot=${id} ` +
        `trades ${before.totalTrades}→${after.totalTrades} ` +
        `wins ${before.winningTrades}→${after.winningTrades} ` +
        `losses ${before.losingTrades}→${after.losingTrades} ` +
        `pnl=${after.totalPnl.toFixed(2)} vol=${after.totalVolume.toFixed(2)}` +
        (drift ? "  [DRIFT CORRECTED]" : "")
      );
      updated++;
    } catch (err) {
      console.error(`[Backfill] Failed to recompute stats for bot ${id}:`, err);
      skipped++;
    }
  }
  return { updated, skipped, reports };
}

async function main() {
  console.log("[Backfill] Starting bot-stats backfill (task #67)...");
  const { groups, rowsDeleted } = await dedupeProtocolFills();
  console.log(`[Backfill] Deduped ${rowsDeleted} duplicate close-event row(s) across ${groups} protocolFillId group(s)`);

  // Legacy null-protocolFillId dedupe. Default APPLIES to fully correct
  // historical drift (canonical counts read directly from bot_trades).
  // Pass --audit to dry-run only.
  const auditOnly = process.argv.includes('--audit');
  await auditOrApplyLegacyNullDedupe(!auditOnly);

  const { updated, skipped, reports } = await recomputeAllBotStats();
  const drifted = reports.filter(r =>
    r.before.totalTrades !== r.after.totalTrades ||
    r.before.winningTrades !== r.after.winningTrades ||
    r.before.losingTrades !== r.after.losingTrades
  );
  console.log(`[Backfill] Recomputed stats for ${updated} bot(s) (${skipped} failed, ${drifted.length} had drift corrected)`);

  console.log("[Backfill] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
