/**
 * Subaccount Recycling Plan — Phase B backfill (§5, §9.7).
 *
 * Mirrors the CURRENT live allocation into the `protocol_subaccounts` registry so it
 * reflects reality before later phases start driving create/delete off it. Today the
 * live allocation lives on `trading_bots.protocol_subaccount_id`; this seeds one
 * registry row (status='active') per active bot that holds a subaccount.
 *
 * IMPORTANT (per §6.1): this does NOT copy any subaccount signing key. The bot row keeps
 * its own key during the transition; the registry's retained-key column is populated only
 * in later phases (recycle-on-delete). This is a pure, additive, idempotent data backfill.
 *
 * Idempotent: re-running inserts nothing new and only fills a NULL agent_public_key on
 * rows that already existed. Existing `status` is never overwritten (won't clobber a
 * future 'spare'/'stuck_funds' row).
 *
 * Run:  npx tsx scripts/backfill-protocol-subaccounts.ts
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, pool } from "../server/db.js";
import {walletWrite} from '../server/grid-worker/wallet-writers.js';
import { tradingBots, wallets, protocolSubaccounts } from "../shared/schema.js";

async function main() {
  const rows = await db
    .select({
      botId: tradingBots.id,
      walletAddress: tradingBots.walletAddress,
      protocol: tradingBots.activeProtocol,
      protocolSubaccountId: tradingBots.protocolSubaccountId,
      agentPublicKey: wallets.agentPublicKey,
    })
    .from(tradingBots)
    .innerJoin(wallets, eq(tradingBots.walletAddress, wallets.address))
    .where(and(eq(tradingBots.isActive, true), isNotNull(tradingBots.protocolSubaccountId)));

  let inserted = 0;
  let filledAgent = 0;
  let alreadyComplete = 0;

  for (const r of rows) {
    const subId = r.protocolSubaccountId;
    if (!subId) continue;

    const result = await walletWrite(pool,[r.walletAddress],async(tx,poolId)=>{
    const ins = await tx
      .insert(protocolSubaccounts)
      .values({
        id: poolId,
        walletAddress: r.walletAddress,
        botId: r.botId,
        protocol: r.protocol,
        protocolSubaccountId: subId,
        status: "active",
        agentPublicKey: r.agentPublicKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: protocolSubaccounts.id });

    if (ins.length > 0) {
      return 'inserted';
    }

    // Row already existed — only backfill a missing agent_public_key. Never touch status.
    const upd = await tx
      .update(protocolSubaccounts)
      .set({ agentPublicKey: r.agentPublicKey ?? null })
      .where(
        and(
          eq(protocolSubaccounts.protocol, r.protocol),
          eq(protocolSubaccounts.protocolSubaccountId, subId),
          isNull(protocolSubaccounts.agentPublicKey),
        ),
      )
      .returning({ id: protocolSubaccounts.id });

    return upd.length > 0 ? 'filled' : 'existing';
    },{identity:{protocol:r.protocol,protocolSubaccountId:subId,insert:true}});
    if(result==='inserted')inserted++;
    else if(result==='filled')filledAgent++;
    else alreadyComplete++;
  }

  console.log(
    `[backfill-protocol-subaccounts] active bots with subaccount: ${rows.length} | ` +
      `inserted: ${inserted} | agent_public_key filled: ${filledAgent} | already complete: ${alreadyComplete}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-protocol-subaccounts] FAILED:", err);
  process.exit(1);
});
