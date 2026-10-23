import { sql, type SQL } from "drizzle-orm";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";

export interface MarketEntryKey { ownerWallet: string; market: string; paperMode: boolean }
export type CooldownQuery = (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }>;
export type MarketEntryBlock = { status: "market_cooldown" | "market_entry_pending"; availableAt?: string };
export type AiTraderExecutionClaim =
  | { status: "claimed"; bot: AiTraderBot; decision: AiTraderDecision }
  | MarketEntryBlock
  | { status: "bot_conflict" | "schema_unavailable" };
export const COOLDOWN_SCHEMA_CHECK = "SELECT\n(SELECT count(*) = 10 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_trader_market_entry_attempts')\nAND NOT EXISTS (SELECT 1 FROM (VALUES\n ('attempt_id','text','NO'),('decision_id','character varying','NO'),('bot_id','character varying','NO'),\n ('owner_wallet','text','NO'),('market','text','NO'),('paper_mode','boolean','NO'),('state','text','NO'),\n ('admitted_at','timestamp with time zone','NO'),('first_confirmed_at','timestamp with time zone','YES'),('terminal_reason','text','YES')\n) e(n,t,z) LEFT JOIN information_schema.columns c ON c.table_schema=current_schema() AND c.table_name='ai_trader_market_entry_attempts' AND c.column_name=e.n WHERE c.data_type IS DISTINCT FROM e.t OR c.is_nullable IS DISTINCT FROM e.z)\nAND (SELECT count(*) = 6 FROM pg_constraint c WHERE c.conrelid=to_regclass('ai_trader_market_entry_attempts') AND c.convalidated AND (\n (c.contype='p' AND pg_get_constraintdef(c.oid)='PRIMARY KEY (attempt_id)') OR\n (c.contype='u' AND pg_get_constraintdef(c.oid)='UNIQUE (decision_id)') OR\n (c.conname='ai_market_entry_state' AND pg_get_constraintdef(c.oid)='CHECK ((state = ANY (ARRAY[''pending''::text, ''confirmed''::text, ''no_entry''::text])))') OR\n (c.conname='ai_market_entry_clock' AND pg_get_constraintdef(c.oid)='CHECK ((((state = ''confirmed''::text) AND (first_confirmed_at IS NOT NULL)) OR ((state <> ''confirmed''::text) AND (first_confirmed_at IS NULL))))') OR\n (c.conname='ai_market_entry_finite' AND pg_get_constraintdef(c.oid)='CHECK ((isfinite(admitted_at) AND ((first_confirmed_at IS NULL) OR (isfinite(first_confirmed_at) AND (first_confirmed_at >= admitted_at)))))') OR\n (c.conname='ai_market_entry_identity' AND pg_get_constraintdef(c.oid)='CHECK (((length(owner_wallet) > 0) AND (length(market) > 0) AND (length(attempt_id) > 0)))')))\nAND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('ai_trader_market_entry_attempts') AND contype='f')\nAND (SELECT count(*)=2 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=to_regclass('ai_trader_market_entry_attempts') AND i.indisvalid AND i.indisready AND NOT i.indisunique AND (\n (c.relname='ai_market_entry_pending' AND pg_get_expr(i.indpred,i.indrelid)='(state = ''pending''::text)' AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (owner_wallet, market, paper_mode) WHERE %') OR\n (c.relname='ai_market_entry_confirmed' AND pg_get_expr(i.indpred,i.indrelid)='(state = ''confirmed''::text)' AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (owner_wallet, market, paper_mode, first_confirmed_at) WHERE %')))\nAS ok";

// A bound-parameter adapter shared by Drizzle transactions and the pg writer.
export function cooldownQuery(tx: { execute(query: SQL): PromiseLike<{ rows: unknown[] }> }): CooldownQuery {
  return async (text, values = []) => {
    const fragments = text.split(/(\$\d+)/).map((part: string) => /^\$\d+$/.test(part)
      ? sql`${values[Number(part.slice(1)) - 1]}` : sql.raw(part));
    const result = await tx.execute(sql.join(fragments, sql.raw("")));
    return { rows: result.rows as Record<string, unknown>[] };
  };
}
export function marketEntryKey(bot: Pick<AiTraderBot, "walletAddress" | "market" | "paperMode">): MarketEntryKey {
  return { ownerWallet: bot.walletAddress, market: bot.market, paperMode: bot.paperMode };
}
export function sameMarketEntryKey(a: MarketEntryKey, b: MarketEntryKey): boolean {
  return a.ownerWallet === b.ownerWallet && a.market === b.market && a.paperMode === b.paperMode;
}
export async function lockMarketEntry(query: CooldownQuery, key: MarketEntryKey): Promise<void> {
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["ai-trader-market-entry-v1", key.ownerWallet, key.market, key.paperMode])]);
}
export async function verifyMarketEntrySchema(query: CooldownQuery): Promise<boolean> {
  return (await query(COOLDOWN_SCHEMA_CHECK)).rows[0]?.ok === true;
}
export async function marketEntryBlock(query: CooldownQuery, key: MarketEntryKey, botId: string): Promise<MarketEntryBlock | null> {
  // Sample after the advisory lock. Never compare dates rounded through JS.
  const { rows } = await query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT bool_or(state='pending') AS pending,
      max(first_confirmed_at + interval '4 hours')::text AS available_at
    FROM ai_trader_market_entry_attempts, clock
    WHERE owner_wallet=$1 AND market=$2 AND paper_mode=$3 AND bot_id<>$4
      AND (state='pending' OR (state='confirmed' AND first_confirmed_at + interval '4 hours' > clock.at))`,
    [key.ownerWallet, key.market, key.paperMode, botId]);
  if (rows[0]?.pending === true) return { status: "market_entry_pending" };
  return typeof rows[0]?.available_at === "string"
    ? { status: "market_cooldown", availableAt: rows[0].available_at } : null;
}
export async function reserveMarketEntry(query: CooldownQuery, key: MarketEntryKey, botId: string, decisionId: string): Promise<void> {
  await query(`INSERT INTO ai_trader_market_entry_attempts
    (attempt_id, decision_id, bot_id, owner_wallet, market, paper_mode)
    VALUES ($1,$2,$3,$4,$5,$6)`, [`entry:${decisionId}`, decisionId, botId, key.ownerWallet, key.market, key.paperMode]);
}
export async function lockRetainedMarketEntry(query: CooldownQuery, botId: string, decisionId: string): Promise<boolean> {
  const { rows } = await query(`SELECT owner_wallet,market,paper_mode FROM ai_trader_market_entry_attempts
    WHERE attempt_id=$1 AND decision_id=$2 AND bot_id=$3`, [`entry:${decisionId}`, decisionId, botId]);
  const row = rows[0];
  if (!row || typeof row.owner_wallet !== "string" || typeof row.market !== "string" || typeof row.paper_mode !== "boolean") return false;
  await lockMarketEntry(query, { ownerWallet: row.owner_wallet, market: row.market, paperMode: row.paper_mode });
  return true;
}
// Call only after a *new* durable entry transition; replay must never call this.
export async function confirmMarketEntry(query: CooldownQuery, botId: string, decisionId: string): Promise<void> {
  await query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE ai_trader_market_entry_attempts SET state='confirmed',first_confirmed_at=clock.at
    FROM clock WHERE attempt_id=$1 AND decision_id=$2 AND bot_id=$3 AND state='pending'`,
    [`entry:${decisionId}`, decisionId, botId]);
}
// Only the executing call that has not invoked an order sender may use this.
export async function releaseNeverSentMarketEntry(query: CooldownQuery, botId: string, decisionId: string): Promise<void> {
  await query(`UPDATE ai_trader_market_entry_attempts SET state='no_entry',terminal_reason='never_sent'
    WHERE attempt_id=$1 AND decision_id=$2 AND bot_id=$3 AND state='pending'`, [`entry:${decisionId}`, decisionId, botId]);
}
export function marketEntryClaimFailure(claim: Exclude<AiTraderExecutionClaim, { status: "claimed" }>) {
  if (claim.status === "market_cooldown" || claim.status === "market_entry_pending") return {
    ok: false as const, skipped: true as const, reason: claim.status, availableAt: claim.availableAt,
    detail: claim.status === "market_entry_pending" ? "Entry pending on this market — waiting for reconciliation"
      : `Market cooldown — eligible after ${claim.availableAt}`,
  };
  return { ok: false as const, reason: claim.status === "schema_unavailable" ? "schema_unavailable" as const : "bot_busy" as const,
    detail: claim.status === "schema_unavailable" ? "Market entry readiness unavailable" : "Exact execution claim lost" };
}

export async function preflightMarketEntries(bot: AiTraderBot, markets: readonly string[]): Promise<Record<string, MarketEntryBlock> | null> {
  try {
    const { db } = await import("../db");
    const query = cooldownQuery(db);
    if (!await verifyMarketEntrySchema(query)) return null;
    const { rows } = await query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT market,bool_or(state='pending') AS pending,max(first_confirmed_at + interval '4 hours')::text AS available_at
      FROM ai_trader_market_entry_attempts,clock
      WHERE owner_wallet=$1 AND paper_mode=$2 AND bot_id<>$3 AND market IN (SELECT jsonb_array_elements_text($4::jsonb))
        AND (state='pending' OR (state='confirmed' AND first_confirmed_at + interval '4 hours'>clock.at)) GROUP BY market`,
      // One JSON text parameter: Drizzle expands a JS array into a parameter list, which broke ANY($4::text[]) in production.
      [bot.walletAddress, bot.paperMode, bot.id, JSON.stringify([...new Set(markets)])]);
    const blocked: Record<string, MarketEntryBlock> = {};
    for (const row of rows) if (typeof row.market === "string") blocked[row.market] = row.pending === true
      ? { status: "market_entry_pending" } : { status: "market_cooldown", availableAt: String(row.available_at) };
    return blocked;
  } catch { return null; }
}
