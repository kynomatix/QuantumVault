/**
 * WO-7.1 — live trade signing for AI Trader bots.
 *
 * A live bot WITH a provisioned venue subaccount signs with the bot's OWN
 * subaccount key (Phase 4b model: each Pacifica subaccount is its own account,
 * the signed `account` field IS the sub pubkey, and the adapter `subaccountId`
 * param stays undefined). The unsigned Pacifica `subaccount_id` body field is
 * UNVERIFIED and never relied on — signing a live bot's orders with the MAIN
 * agent key would silently trade the user's main account (money-safety bug).
 *
 * Fail closed: if the sub key is missing or undecryptable we refuse to sign at
 * all; we NEVER fall back to the main agent key for a bot that has a subaccount.
 *
 * Legacy founder-canary bots (protocolSubaccountId = null) keep the original
 * main-agent-key path — they genuinely trade the main account.
 */
import { decryptBotSubaccountKey } from "../session-v3";
import type { AiTraderBot } from "@shared/schema";

/**
 * Decrypt the bot's own venue-subaccount key (V3 ciphertext, AAD bound to
 * walletAddress + bot.id — same envelope as trading_bots; agent-HD re-derive
 * fallback applies when derivation metadata is present). Returns null on any
 * failure — callers must treat null as auth-unavailable, never downgrade to
 * the main agent key.
 */
export async function resolveAiTraderSubaccountSigner(
  bot: AiTraderBot,
  umk: Buffer
): Promise<{ secretKey: Uint8Array; cleanup: () => void } | null> {
  if (!bot.protocolSubaccountId) return null;
  if (!bot.botSubaccountKeyEncryptedV3 && (bot.derivationIndex == null || bot.derivationPathVersion == null)) {
    console.error(
      `[AiTrader] Bot ${bot.id.slice(0, 8)} has venue subaccount ${bot.protocolSubaccountId} but NO key material (no V3 ciphertext, no HD derivation metadata) — refusing to sign (fail closed)`
    );
    return null;
  }
  return decryptBotSubaccountKey(
    {
      id: bot.id,
      walletAddress: bot.walletAddress,
      protocolSubaccountId: bot.protocolSubaccountId,
      botSubaccountKeyEncrypted: null,
      botSubaccountKeyEncryptedV3: bot.botSubaccountKeyEncryptedV3,
      derivationIndex: bot.derivationIndex,
      derivationPathVersion: bot.derivationPathVersion,
    },
    umk
  );
}

/**
 * The account pubkey all live READS (positions, balances, stop orders, trade
 * history) must target: the bot's own subaccount when provisioned, else the
 * main agent account (legacy canary). The adapter `subaccountId` param is
 * always undefined on this model.
 */
export function liveReadAccount(bot: AiTraderBot, agentPublicKey: string): string {
  return bot.protocolSubaccountId ?? agentPublicKey;
}
