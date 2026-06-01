import type { Express } from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import crypto from "crypto";
// V3 Phase 5b: legacy crypto helpers (encrypt/decrypt) are no longer imported
// here. Every agent-key and bot-subaccount-key write goes through the V3
// helpers in `./session-v3`. The legacy column is left untouched for existing
// rows; new writes only ever populate the V3 column.
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { storage, DatabaseStorage } from "./storage";
import { insertUserSchema, insertTradingBotSchema, type TradingBot, webhookLogs, botTrades, tradingBots, botSubscriptions, publishedBots, pendingProfitShares, wallets, referralLinks, referralRewardEvents, marketplaceEquitySnapshots, userApiTokens, labOptimizationRuns } from "@shared/schema";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { db } from "./db";
import { desc, eq, sql, asc, and } from "drizzle-orm";
import { ZodError } from "zod";
import { getDefaultAdapter, getAdapterForBot, getAdapter } from './protocol/adapter-registry';
import type { ProtocolAdapter } from './protocol/adapter';
import { parseAndValidateAdapterSubaccountId } from './protocol/persist-canonical-subaccount-id';
import { resolveAgentKeypair } from './agent-wallet';
import { reconcileWalletDeposits } from './deposit-reconciler';
import { publicPortfolioHandler } from './public-portfolio';

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

/**
 * Resolve a Uint8Array secret key from either a legacy-encrypted string blob
 * OR an already-decrypted Uint8Array. Phase 3 (V3 retirement) migrated user-
 * online callers to pass Uint8Array (obtained via decryptAgentKeyStrict). The
 * remaining string callers are out-of-scope (Phase 3b subscriber fan-out and
 * Phase 4 background services) and continue using the legacy decrypt until
 * their phase migrates them.
 */
function _decryptToSecretKey(input: Uint8Array): { secretKey: Uint8Array; publicKey: string } {
  const keypair = Keypair.fromSecretKey(input);
  return { secretKey: input, publicKey: keypair.publicKey.toBase58() };
}

interface BotSubaccountContext {
  useBotKeypair: true;
  botPublicKey: string;
  // Phase 4b: ciphertext is no longer carried in the context. We look it up on
  // the bot record and decrypt with the owner's UMK at the moment of use.
  botId: string;
  walletAddress: string;
}

function getBotSubaccountContext(bot: TradingBot): BotSubaccountContext | null {
  if (
    bot.subaccountAuthMode === 'external_key' &&
    bot.subaccountStatus === 'active' &&
    bot.protocolSubaccountId &&
    // Accept either v3 or legacy ciphertext during the Phase 4b/5b migration window.
    (bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted)
  ) {
    return {
      useBotKeypair: true,
      botPublicKey: bot.protocolSubaccountId,
      botId: bot.id,
      walletAddress: bot.walletAddress,
    };
  }
  return null;
}

/**
 * Phase 4b: decrypt a bot's subaccount secret key (V3 path with JIT migration
 * for legacy-only rows). Returns the raw 64-byte ed25519 secret key plus a
 * cleanup callback the caller MUST invoke after the keypair has been used.
 *
 * Throws on any failure — callers must surface the error (or 5xx the request)
 * because there is no safe fallback after Phase 4b: the legacy path of
 * decrypting `bot.botSubaccountKeyEncrypted` with AGENT_ENCRYPTION_KEY only
 * works while that env var is still defined, and Phase 6 deletes it.
 */
async function _resolveBotSubaccountSecretKey(
  botCtx: BotSubaccountContext,
): Promise<{ secretKey: Uint8Array; cleanup: () => void }> {
  const { getUmkForWebhook, decryptBotSubaccountKey } = await import('./session-v3');
  const umkResult = await getUmkForWebhook(botCtx.walletAddress);
  if (!umkResult) {
    throw new Error(
      `Cannot decrypt bot subaccount key for ${botCtx.botId.slice(0, 8)}...: ` +
      `no active execution authorization for owner ${botCtx.walletAddress.slice(0, 8)}...`,
    );
  }
  try {
    const bot = await storage.getTradingBotById(botCtx.botId);
    if (!bot) {
      throw new Error(`Bot ${botCtx.botId} not found during signing-key resolution`);
    }
    const decrypted = await decryptBotSubaccountKey(
      {
        id: bot.id,
        walletAddress: bot.walletAddress,
        protocolSubaccountId: bot.protocolSubaccountId,
        botSubaccountKeyEncrypted: bot.botSubaccountKeyEncrypted,
        botSubaccountKeyEncryptedV3: bot.botSubaccountKeyEncryptedV3,
        // Phase 4b (Flash agent-HD wallets): enable seed re-derivation when the
        // encrypted cache is missing/unusable.
        derivationIndex: bot.derivationIndex,
        derivationPathVersion: bot.derivationPathVersion,
      },
      umkResult.umk,
    );
    if (!decrypted) {
      throw new Error(
        `Failed to decrypt bot subaccount key for ${botCtx.botId.slice(0, 8)}... (no usable ciphertext or AAD mismatch)`,
      );
    }
    return decrypted;
  } finally {
    umkResult.cleanup();
  }
}

/**
 * Phase 4b emergency recovery for a Flash agent-derived per-bot wallet. Re-derives
 * the bot key from the agent seed (via _resolveBotSubaccountSecretKey, which works
 * even if the encrypted blob is gone), closes any open positions, cancels leftover
 * trigger orders, tops up gas from the agent, sweeps ALL funds back to the agent
 * wallet, and verifies the wallet is genuinely empty. Idempotent: re-running on an
 * already-empty wallet is a safe no-op. Fails closed on any unreadable balance or
 * unfinished close/sweep — never reports success while funds may remain.
 *
 * Does NOT delete the bot row — recovery only returns the capital to the agent.
 */
async function recoverFlashBotWallet(
  bot: TradingBot,
  agentAddress: string,
  agentSecret: Uint8Array | null,
  logPrefix: string = '[Recover]',
): Promise<{
  recovered: boolean;
  closedPositions: number;
  usdcSwept: number;
  solReclaimed: number;
  alreadyEmpty: boolean;
  error?: string;
}> {
  const empty = (error?: string) => ({
    recovered: false, closedPositions: 0, usdcSwept: 0, solReclaimed: 0, alreadyEmpty: false, error,
  });

  if (bot.activeProtocol !== 'flash' || !bot.protocolSubaccountId || bot.protocolSubaccountId === agentAddress) {
    return empty('Bot has no separate Flash wallet to recover');
  }
  const isAgentHd = bot.derivationIndex != null && bot.derivationPathVersion != null;
  const hasKey = !!(bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted);
  if (!isAgentHd && !hasKey) {
    return empty('Bot wallet is not recoverable (random keypair with no stored key)');
  }

  const flashAdapter = getAdapterForBot(bot) as import('./protocol/flash/flash-adapter').FlashAdapter;
  const subId = bot.protocolSubaccountId;
  const botCtx: BotSubaccountContext = {
    useBotKeypair: true, botPublicKey: subId, botId: bot.id, walletAddress: bot.walletAddress,
  };

  // Refuse to recover a bot that is still executing — a webhook/manual trade could
  // reopen a position between our close and our sweep, locking collateral that the
  // wallet-USDC check would not catch. Operator must stop the bot first. Fail closed.
  if (bot.executionActive) {
    return empty('Bot execution is still active — stop the bot before recovering its wallet (a live trade could reopen a position mid-sweep)');
  }

  let decrypted: { secretKey: Uint8Array; cleanup: () => void } | null = null;
  try {
    // Re-derive (or decrypt) the bot key. Throws/fails closed if unrecoverable.
    decrypted = await _resolveBotSubaccountSecretKey(botCtx);

    // 1) Close any open positions — recovery CLOSES (delete refuses); fail closed.
    let closedPositions = 0;
    let positions = await flashAdapter.getPositions(subId);
    for (const pos of positions) {
      console.log(`${logPrefix} Closing ${pos.internalSymbol} position on bot wallet ${subId.slice(0, 8)}...`);
      const close = await flashAdapter.closePosition({
        agentPublicKey: subId,
        agentSecretKey: decrypted.secretKey,
        mainWalletAddress: agentAddress,
        internalSymbol: pos.internalSymbol,
        subaccountId: subId,
      });
      if (!close.success) {
        return empty(`Failed to close ${pos.internalSymbol} position: ${close.error}`);
      }
      closedPositions++;
    }

    // Best-effort cancel of leftover trigger (TP/SL) orders — never blocks the sweep.
    try {
      await flashAdapter.cancelAllOrders({
        agentPublicKey: subId,
        agentSecretKey: decrypted.secretKey,
        mainWalletAddress: agentAddress,
        subaccountId: subId,
      });
    } catch (cancelErr: any) {
      console.warn(`${logPrefix} cancelAllOrders failed (non-fatal): ${cancelErr?.message || cancelErr}`);
    }

    // Re-verify NO positions remain before sweeping — fail closed.
    positions = await flashAdapter.getPositions(subId);
    if (positions.length > 0) {
      return empty(`${positions.length} position(s) still open after close attempt`);
    }

    // 2) Gas top-up so the bot wallet can pay its own sweep fee (USDC-rich/SOL-poor).
    if (agentSecret) {
      const gas = await flashAdapter.topUpBotWalletGas({ mainSecretKey: agentSecret, botWalletAddress: subId });
      if (gas.error) {
        return empty(`Could not top up bot gas for the sweep: ${gas.error}`);
      }
    }

    // 3) Sweep everything (USDC + reclaim SOL) back to the agent wallet.
    const sweep = await flashAdapter.sweepBotWallet({ subSecretKey: decrypted.secretKey, destWalletAddress: agentAddress });
    if (sweep.error) {
      return empty(`Sweep failed: ${sweep.error}`);
    }

    // 4) Verify the wallet is genuinely empty — reads + position check fail CLOSED.
    //    A position reopened mid-recovery would lock collateral that the wallet-USDC
    //    balance check cannot see, so re-check positions one final time after the sweep.
    const residualPositions = await flashAdapter.getPositions(subId);
    if (residualPositions.length > 0) {
      return empty(`${residualPositions.length} position(s) reopened during recovery — collateral is locked; stop the bot and retry`);
    }
    let usdcResidual: number;
    let solResidual: number;
    try {
      usdcResidual = await flashAdapter.getWalletCollateralBalanceStrict(subId);
      solResidual = await flashAdapter.getWalletSolBalance(subId);
    } catch (balErr: any) {
      return empty(`Could not verify the bot wallet is empty after sweep: ${balErr?.message || balErr}`);
    }
    if (usdcResidual > 0) {
      return empty(`$${usdcResidual.toFixed(6)} USDC still remains in the bot wallet after sweep`);
    }
    // A successful SOL reclaim leaves only sub-fee dust (< ~0.000005 SOL). A residual
    // above the dust threshold means the reclaim leg FAILED and real SOL (including the
    // gas we just topped up) is stranded — fail closed so the operator re-runs. The
    // wallet is agent-HD recoverable, so a re-run is always safe.
    const FLASH_SOL_DUST = 0.001;
    if (solResidual > FLASH_SOL_DUST) {
      return empty(`${solResidual.toFixed(6)} SOL still remains in the bot wallet after sweep (SOL reclaim failed) — retry recovery`);
    }

    const alreadyEmpty = closedPositions === 0 && sweep.usdcSwept === 0;
    console.log(`${logPrefix} Recovered bot ${bot.id}: closed ${closedPositions} position(s), swept $${sweep.usdcSwept.toFixed(2)} USDC + ${sweep.solReclaimed.toFixed(6)} SOL to agent`);
    return {
      recovered: true,
      closedPositions,
      usdcSwept: sweep.usdcSwept,
      solReclaimed: sweep.solReclaimed,
      alreadyEmpty,
    };
  } finally {
    try { decrypted?.cleanup(); } catch { /* noop */ }
  }
}

async function sweepPacificaSubaccount(
  bot: TradingBot,
  agentPublicKey: string,
  logPrefix: string = '[Delete]',
  agentSecret: Uint8Array | null = null,
): Promise<{ handled: boolean; swept: boolean; amount: number; withdrawnToWallet?: boolean; error?: string }> {
  const botCtx = getBotSubaccountContext(bot);
  if (!botCtx) return { handled: false, swept: false, amount: 0 };

  try {
    const adapter = getAdapterForBot(bot);
    const accountInfo = await adapter.getAccountInfo(botCtx.botPublicKey);
    const balance = accountInfo?.equity ?? accountInfo?.freeCollateral ?? 0;
    console.log(`${logPrefix} Pacifica subaccount ${botCtx.botPublicKey.slice(0, 8)}... balance: $${balance.toFixed(6)}`);

    if (balance >= adapter.minTransferAmount) {
      // Read main balance BEFORE the transfer so we can (a) wait for the transfer
      // to be indexed at main and (b) withdraw only THIS bot's contribution (the
      // observed delta), never sweeping unrelated funds already sitting in main.
      // A READ FAILURE is recorded as null (unknown) — NOT 0 — because assuming 0
      // when main already holds funds would let the indexing wait pass instantly
      // off that pre-existing balance and withdraw the wrong money, leaving this
      // bot's swept funds stranded in main with no marker. Unknown ⇒ defer withdraw.
      let mainBefore: number | null = 0;
      try {
        const mainInfo = await adapter.getAccountInfo(agentPublicKey);
        mainBefore = mainInfo.exists ? mainInfo.balance : 0;
      } catch (mainErr: any) {
        mainBefore = null;
        console.warn(`${logPrefix} Could not read main balance before transfer (will defer withdraw, leave funds in main): ${mainErr.message}`);
      }

      const decrypted = await _resolveBotSubaccountSecretKey(botCtx);
      try {
        console.log(`${logPrefix} Step 1: transferring $${balance.toFixed(4)} from bot subaccount ${botCtx.botPublicKey.slice(0, 8)}... → main account`);
        const transferResult = await adapter.transferBetweenSubaccounts({
          agentSecretKey: decrypted.secretKey,
          mainWalletAddress: agentPublicKey,
          fromSubaccountId: botCtx.botPublicKey,
          toSubaccountId: agentPublicKey,
          amount: balance,
        });

        if (!transferResult.success) {
          // Funds genuinely still in the subaccount — this is the blocking error.
          console.error(`${logPrefix} Pacifica subaccount→main transfer failed: ${transferResult.error}`);
          return { handled: true, swept: false, amount: balance, error: transferResult.error };
        }
        console.log(`${logPrefix} Step 1 ok: $${balance.toFixed(4)} moved to main account`);
      } finally {
        decrypted.cleanup();
      }

      // Step 2: complete the round-trip — withdraw main → on-chain agent wallet.
      // The transfer above only moved funds WITHIN Pacifica; without this leg the
      // capital sits in the agent's Pacifica MAIN account and never returns to the
      // user's wallet (the gap this fix closes). A failure here is NOT fatal: funds
      // are safe in main and recoverable, so we never block deletion on it.
      const withdrawnToWallet = await withdrawSweptFundsToWallet(
        bot, agentPublicKey, agentSecret, mainBefore, balance, logPrefix,
      );
      return { handled: true, swept: true, amount: balance, withdrawnToWallet };
    }

    if (balance > 0) {
      // Residual balance is below the $10 Pacifica minimum transfer. We cannot sweep
      // it back to the agent wallet, so we record the dust amount as an equity event
      // for later reconciliation and proceed with deletion anyway. We record every
      // positive sub-$10 residual (including tiny amounts) so the missing-cents
      // investigation can account for all stranded funds.
      console.log(
        `${logPrefix} Subaccount balance $${balance.toFixed(6)} is below $${adapter.minTransferAmount} minimum — skipping sweep, recording dust and deleting bot`,
      );
      try {
        await storage.createEquityEvent({
          walletAddress: bot.walletAddress,
          tradingBotId: bot.id,
          eventType: 'pacifica_dust_stranded',
          amount: String(balance),
          txSignature: null,
          notes: `Bot deleted with $${balance.toFixed(6)} stranded in subaccount ${botCtx.botPublicKey} (below $${adapter.minTransferAmount} minimum transfer)`,
        });
      } catch (eventErr: any) {
        console.error(`${logPrefix} Failed to record stranded dust event: ${eventErr.message}`);
      }
      return { handled: true, swept: false, amount: balance };
    }

    console.log(`${logPrefix} Pacifica subaccount has zero balance, proceeding with deletion`);
    return { handled: true, swept: false, amount: 0 };
  } catch (err: any) {
    console.error(`${logPrefix} Pacifica sweep error: ${err.message}`);
    return { handled: true, swept: false, amount: 0, error: err.message };
  }
}

/**
 * Subaccount Recycling Plan §7.2 / §10 (Phase D) — kill switch for "recycle on
 * delete". Default OFF: when unset/false the delete path behaves exactly as it
 * does today (sweep + delete, key discarded, nothing pooled). Set the env var
 * `RECYCLE_ON_DELETE=true` to enable flattening + pooling swept-empty subaccounts.
 * This is independent from `subaccountCaps.recyclable` (which gates reuse-on-create,
 * Phase E) — pooling can run while reuse stays off.
 */
function isRecycleOnDeleteEnabled(): boolean {
  const v = (process.env.RECYCLE_ON_DELETE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Subaccount Recycling Plan §8 / §10 (Phase E) — kill switch for "reuse on
 * create". Default OFF: when unset/false bot creation always provisions a fresh
 * subaccount (today's behavior), regardless of how many spares are pooled. Set
 * `REUSE_ON_CREATE=true` to let creates drain the spare pool first (claim → verify
 * empty → re-fund → rebind key → finalize) and fall back to fresh provisioning when
 * no usable spare exists. Independent of `RECYCLE_ON_DELETE`: pooling and reuse are
 * gated separately, and reuse additionally requires `subaccountCaps.recyclable`.
 */
function isReuseOnCreateEnabled(): boolean {
  const v = (process.env.REUSE_ON_CREATE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Phase D (§7.2) — decide whether a sweep result must BLOCK bot deletion.
 *
 * Every error-returning path in `sweepPacificaSubaccount` leaves the funds INTACT in
 * the subaccount: the sub→main transfer either returned success:false, or it (or the
 * pre-transfer balance read / key decrypt) threw before the move completed. The
 * non-fatal main→wallet withdraw leg never sets `error`. So a set `error` always means
 * "money may still be in the subaccount".
 *
 * - Recycling OFF: preserve the exact legacy gate (a real transfer failure with a
 *   non-trivial balance) so the flag-off path stays byte-identical to today.
 * - Recycling ON: fail CLOSED on ANY error — the caller will quarantine the subaccount
 *   as stuck_funds and refuse to delete, so a thrown failure can never delete the bot
 *   (and discard its key) while funds are still stranded.
 */
export function shouldBlockDeleteForSweep(
  recycleOnDelete: boolean,
  sweep: { error?: string; amount: number },
): boolean {
  if (recycleOnDelete) return !!sweep.error;
  return !!sweep.error && sweep.amount > 0.01;
}

/**
 * Phase D step 1 (§7.2) — flatten a Pacifica bot subaccount before sweeping:
 * cancel ALL resting orders, cancel any stop/TP-SL orders, close every open
 * position, then RE-VERIFY that no positions or orders remain. Returns ok:false
 * if anything is still open after a short settle/retry so the caller aborts the
 * delete (funds stay put) rather than sweeping a still-active account.
 *
 * Signing mirrors the trade path for external_key bots: the bot's own subaccount
 * key signs, agentPublicKey = the subaccount pubkey, subaccountId = undefined.
 */
async function teardownPacificaSubaccountForDelete(
  bot: TradingBot,
  logPrefix: string,
): Promise<{ ok: boolean; error?: string }> {
  const botCtx = getBotSubaccountContext(bot);
  if (!botCtx) return { ok: true };
  const adapter = getAdapterForBot(bot);
  const acct = botCtx.botPublicKey;
  let decrypted: { secretKey: Uint8Array; cleanup: () => void } | null = null;
  try {
    decrypted = await _resolveBotSubaccountSecretKey(botCtx);
    const sk = decrypted.secretKey;

    // 1) Cancel all resting (non-stop) orders across every symbol.
    try {
      await adapter.cancelAllOrders({
        agentPublicKey: acct,
        agentSecretKey: sk,
        mainWalletAddress: bot.walletAddress,
      });
    } catch (e: any) {
      console.warn(`${logPrefix} teardown: cancelAllOrders failed: ${e.message}`);
    }

    // 2) Cancel any stop / TP-SL orders individually.
    try {
      const stops = adapter.getOpenStopOrders ? await adapter.getOpenStopOrders(acct) : [];
      for (const s of stops) {
        if (!adapter.cancelStopOrder) break;
        try {
          await adapter.cancelStopOrder({
            agentPublicKey: acct,
            agentSecretKey: sk,
            mainWalletAddress: bot.walletAddress,
            orderId: s.order_id,
          });
        } catch (e: any) {
          console.warn(`${logPrefix} teardown: cancelStopOrder ${s.order_id} failed: ${e.message}`);
        }
      }
    } catch (e: any) {
      console.warn(`${logPrefix} teardown: stop-order listing failed: ${e.message}`);
    }

    // 3) Close every open position with a reduce-only market order.
    try {
      const positions = await adapter.getPositions(acct);
      for (const p of positions) {
        if (Math.abs(p.baseSize) === 0) continue;
        try {
          await adapter.closePosition({
            agentPublicKey: acct,
            agentSecretKey: sk,
            mainWalletAddress: bot.walletAddress,
            internalSymbol: p.internalSymbol,
          });
        } catch (e: any) {
          console.warn(`${logPrefix} teardown: closePosition ${p.internalSymbol} failed: ${e.message}`);
        }
      }
    } catch (e: any) {
      console.warn(`${logPrefix} teardown: position listing failed: ${e.message}`);
    }

    // 4) Re-verify zero positions AND zero orders (balance is still funded here, so we
    //    check positions/orders only — NOT verifySubaccountEmpty, which also gates on
    //    balance). One short retry lets close fills settle on the exchange.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const positions = await adapter.getPositions(acct);
      if (positions.some((p) => Math.abs(p.baseSize) > 0)) continue;
      const openOrders = adapter.getOpenOrders ? await adapter.getOpenOrders(acct) : [];
      if (openOrders.length > 0) continue;
      const stops = adapter.getOpenStopOrders ? await adapter.getOpenStopOrders(acct) : [];
      if (stops.length > 0) continue;
      return { ok: true };
    }
    return { ok: false, error: 'positions or orders still open after flatten + retry' };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    decrypted?.cleanup();
  }
}

/**
 * Result of attempting to recycle a deleted bot's subaccount.
 * - `ok: true`  → the subaccount is verified EMPTY and it is SAFE to delete the bot
 *   row. `pooled` says whether we also retained the key as a `spare` (best-effort).
 * - `ok: false` → funds may still be in the subaccount (or we could not confirm it
 *   empty). The caller MUST quarantine it as stuck_funds and NOT delete the bot, so
 *   the signing key (on the bot row) is preserved for recovery.
 */
type RecycleOutcome =
  | { ok: true; pooled: boolean }
  | { ok: false; reason: string };

/**
 * Phase D (§7.2 / §8) — after a successful sweep, decide the fate of the deleted
 * bot's Pacifica subaccount.
 *
 * SAFETY GATE (can block deletion): the subaccount MUST be verifiably empty before
 * the bot row (which holds the signing key) is deleted. If it still holds funds /
 * positions / orders — e.g. sub-min-transfer dust the sweep cannot move — or if the
 * empty-check cannot be completed (read error → fail CLOSED), we return ok:false so
 * the caller quarantines it as stuck_funds and refuses to delete. Never
 * delete-and-lose-track of funds (safety invariant, §7.2).
 *
 * POOLING (best-effort, never blocks): once the account is verified empty we retain
 * its signing key (re-bound from the transient BOT_UUID AAD to the stable POOLED
 * subaccount-pubkey AAD) and upsert a `spare` registry row. V3-strict: a legacy-only
 * key (no V3 ciphertext) or a missing owner UMK means we cannot retain the key — the
 * account is still empty and safe to delete, we just lose the recycling opportunity
 * (returns ok:true, pooled:false).
 */
async function recycleDeletedSubaccount(
  bot: TradingBot,
  agentPublicKey: string,
  umk: Buffer | null,
  logPrefix: string,
): Promise<RecycleOutcome> {
  const botCtx = getBotSubaccountContext(bot);
  if (!botCtx) return { ok: true, pooled: false };
  const acct = botCtx.botPublicKey;

  // 1) SAFETY: confirm the subaccount is genuinely empty before any delete.
  const adapter = getAdapterForBot(bot);
  if (!adapter.verifySubaccountEmpty) {
    // This path is Pacifica-only and the Pacifica adapter always implements
    // verifySubaccountEmpty; if some adapter ever lacks it we cannot confirm empty,
    // so don't pool — but don't block the existing delete behavior either.
    console.warn(`${logPrefix} ${acct.slice(0, 8)}...: adapter lacks verifySubaccountEmpty, skipping recycle`);
    return { ok: true, pooled: false };
  }
  let empty: boolean;
  try {
    empty = await adapter.verifySubaccountEmpty({ agentPublicKey: acct });
  } catch (e: any) {
    // Fail CLOSED: could not confirm empty ⇒ must not delete-and-discard the key.
    return { ok: false, reason: `empty-check failed: ${e.message}` };
  }
  if (!empty) {
    return { ok: false, reason: 'subaccount not empty after sweep (funds/positions/orders remain)' };
  }

  // 2) POOLING (best-effort): retain the key as a spare. Any failure here is logged
  //    and swallowed — the account is empty, so deletion is safe regardless.
  try {
    if (!bot.botSubaccountKeyEncryptedV3) {
      console.warn(`${logPrefix} Not pooling ${acct.slice(0, 8)}...: no V3 subaccount key to retain`);
      return { ok: true, pooled: false };
    }
    if (!umk) {
      console.warn(`${logPrefix} Not pooling ${acct.slice(0, 8)}...: owner UMK unavailable`);
      return { ok: true, pooled: false };
    }

    const { rebindSubaccountKeyToPooledV3 } = await import('./session-v3');
    const { SUBACCOUNT_AAD_VERSION } = await import('./crypto-v3');
    const rebound = rebindSubaccountKeyToPooledV3({
      umk,
      currentEncryptedV3: bot.botSubaccountKeyEncryptedV3,
      currentAadVersion: SUBACCOUNT_AAD_VERSION.BOT_UUID,
      protocol: 'pacifica',
      walletAddress: bot.walletAddress,
      protocolSubaccountId: acct,
      legacyBotId: bot.id,
    });
    if (!rebound) {
      console.warn(`${logPrefix} Not pooling ${acct.slice(0, 8)}...: key rebind failed (AAD mismatch?)`);
      return { ok: true, pooled: false };
    }

    await storage.poolSubaccountAsSpare({
      walletAddress: bot.walletAddress,
      protocol: 'pacifica',
      protocolSubaccountId: acct,
      agentPublicKey,
      subaccountKeyEncryptedV3: rebound.encryptedV3,
      aadVersion: rebound.aadVersion,
    });
    console.log(`${logPrefix} Pooled subaccount ${acct.slice(0, 8)}... as spare for reuse`);
    return { ok: true, pooled: true };
  } catch (e: any) {
    console.error(`${logPrefix} Failed to pool subaccount as spare (non-fatal): ${e.message}`);
    return { ok: true, pooled: false };
  }
}

/**
 * Second leg of the Pacifica delete sweep: withdraw funds that were just moved
 * subaccount→main back out to the on-chain agent wallet.
 *
 * Returns `true` only when the on-chain withdraw succeeded. Every failure mode is
 * NON-FATAL — the funds are safely in the agent's Pacifica main account and can be
 * withdrawn later — so this never throws and never blocks bot deletion. Whenever
 * the funds do NOT reach the wallet, it records a `pacifica_main_pending_withdraw`
 * equity event so reconciliation/recovery can find them.
 *
 * @param mainBefore main-account balance observed BEFORE the subaccount→main
 *   transfer. We only withdraw the observed delta (capped at `sweptAmount`) so we
 *   never sweep unrelated funds already sitting in main.
 * @param sweptAmount amount moved from the subaccount into main.
 */
async function withdrawSweptFundsToWallet(
  bot: TradingBot,
  agentPublicKey: string,
  agentSecret: Uint8Array | null,
  mainBefore: number | null,
  sweptAmount: number,
  logPrefix: string,
): Promise<boolean> {
  const adapter = getAdapterForBot(bot);
  let withdrawnToWallet = false;
  let pendingReason: string | undefined;

  if (!agentSecret) {
    pendingReason = 'agent key unavailable';
    console.warn(`${logPrefix} ${pendingReason} — $${sweptAmount.toFixed(4)} swept to main but cannot withdraw to wallet`);
  } else if (mainBefore === null) {
    // We never read a trustworthy pre-transfer main balance, so we cannot tell
    // this bot's swept funds apart from any pre-existing main balance. Withdrawing
    // could pull the wrong money and strand the swept amount. Defer to recovery.
    pendingReason = 'pre-transfer main balance unknown — cannot safely delta-match';
    console.warn(`${logPrefix} ${pendingReason}; leaving $${sweptAmount.toFixed(4)} in main (recoverable)`);
  } else {
    try {
      // Wait for Pacifica to index the transfer at main before withdrawing, else
      // the withdraw reads $0 and 422s ("account value: 0"). The target is the
      // observed delta reaching the swept amount within a 1-cent rounding
      // tolerance — NOT a percentage — so we don't treat a materially short
      // (under-indexed) balance as "ready" and silently strand principal.
      const target = mainBefore + sweptAmount - 0.01;
      const waitRes = adapter.waitForMainAccountBalance
        ? await adapter.waitForMainAccountBalance(agentPublicKey, target, { seedBalance: mainBefore })
        : { indexed: true, lastBalance: mainBefore + sweptAmount, elapsedMs: 0 };

      if (!waitRes.indexed) {
        pendingReason = `Pacifica did not index the transfer within ${(waitRes.elapsedMs / 1000).toFixed(0)}s`;
        console.warn(`${logPrefix} ${pendingReason} (funds safe in main, recoverable)`);
      } else {
        // Withdraw only this bot's contribution (observed delta, capped at the
        // swept amount), floored to cents to avoid precision 422s. With the
        // cent-accurate target above, delta is within ~1 cent of sweptAmount, so
        // any residual left behind is sub-cent dust, not material principal.
        const delta = Math.max(0, waitRes.lastBalance - mainBefore);
        const withdrawAmount = Math.floor(Math.min(sweptAmount, delta) * 100) / 100;

        if (withdrawAmount < adapter.minTransferAmount) {
          pendingReason = `post-transfer main delta $${withdrawAmount.toFixed(2)} below $${adapter.minTransferAmount} minimum withdraw`;
          console.log(`${logPrefix} ${pendingReason} — leaving in main`);
        } else {
          console.log(`${logPrefix} Step 2: withdrawing $${withdrawAmount.toFixed(2)} main → agent wallet`);
          const wr = await executeAgentDriftWithdraw(agentPublicKey, agentSecret, withdrawAmount, 0, {
            tradingBotId: bot.id,
            context: logPrefix,
          }, getAdapterForBot(bot));
          if (wr.success) {
            withdrawnToWallet = true;
            console.log(`${logPrefix} Step 2 ok: withdrew $${withdrawAmount.toFixed(2)} to agent wallet: ${wr.signature}`);
            // Record the principal as its own equity event. The $1 Pacifica
            // withdraw fee is recorded separately inside executeAgentDriftWithdraw
            // using THIS SAME tx signature, so we must NOT gate the principal on
            // getEquityEventByTxSignature (the fee row already occupies that
            // signature and would suppress the principal). Mirror the canonical
            // withdraw path: insert unconditionally, log CRITICAL on failure.
            try {
              await storage.createEquityEvent({
                walletAddress: bot.walletAddress,
                tradingBotId: bot.id,
                eventType: 'drift_withdraw',
                amount: String(-withdrawAmount),
                txSignature: wr.signature || null,
                notes: 'Capital returned to wallet on bot delete',
              });
            } catch (eventErr: any) {
              console.error(`${logPrefix} CRITICAL: withdraw succeeded (tx ${wr.signature}) but principal equity event failed: ${eventErr.message}. Untracked withdraw: wallet=${bot.walletAddress}, botId=${bot.id}, amount=${withdrawAmount}`);
            }
          } else {
            pendingReason = wr.error || 'withdraw failed';
            console.warn(`${logPrefix} Withdraw main → wallet failed: ${pendingReason} (funds safe in main, recoverable)`);
          }
        }
      }
    } catch (err: any) {
      pendingReason = err.message;
      console.warn(`${logPrefix} Withdraw leg threw: ${err.message} (funds safe in main, recoverable)`);
    }
  }

  // Non-blocking reconciliation marker: funds reached main but not the wallet.
  if (!withdrawnToWallet) {
    try {
      await storage.createEquityEvent({
        walletAddress: bot.walletAddress,
        tradingBotId: bot.id,
        eventType: 'pacifica_main_pending_withdraw',
        amount: String(sweptAmount),
        txSignature: null,
        notes: `Bot deleted; $${sweptAmount.toFixed(4)} swept to Pacifica main but not withdrawn to wallet${pendingReason ? ` (${pendingReason})` : ''}. Recoverable via main → wallet withdraw.`,
      });
    } catch (eventErr: any) {
      console.error(`${logPrefix} Failed to record pending-withdraw event: ${eventErr.message}`);
    }
  }

  return withdrawnToWallet;
}

/**
 * Phase 4b: now async because the bot-key path goes through V3 (UMK lookup +
 * subkey derivation). When `botCtx` is present, the returned object carries a
 * `cleanup` callback the caller MUST invoke after the secretKey is no longer
 * needed (it zeroizes the buffer). For the agent-key path `cleanup` is a noop.
 */
async function _resolveSigningContext(
  agentEncryptedKey: Uint8Array,
  subAccountId: number,
  botCtx: BotSubaccountContext | null,
): Promise<{ secretKey: Uint8Array; publicKey: string; subaccountId: string | undefined; cleanup: () => void }> {
  if (botCtx) {
    const decrypted = await _resolveBotSubaccountSecretKey(botCtx);
    // _resolveBotSubaccountSecretKey already verified the derived pubkey matches
    // protocolSubaccountId; we mirror the legacy paranoia check here for the
    // public-key value we hand back to callers.
    return {
      secretKey: decrypted.secretKey,
      publicKey: botCtx.botPublicKey,
      subaccountId: undefined,
      cleanup: decrypted.cleanup,
    };
  }
  const { secretKey, publicKey } = _decryptToSecretKey(agentEncryptedKey);
  return { secretKey, publicKey, subaccountId: _subIdStr(subAccountId), cleanup: () => { /* noop */ } };
}

async function _lookupMainWallet(agentPublicKey: string): Promise<string> {
  const [w] = await db.select({ address: wallets.address })
    .from(wallets)
    .where(eq(wallets.agentPublicKey, agentPublicKey))
    .limit(1);
  if (!w) throw new Error('No wallet found for agent public key ' + agentPublicKey.slice(0, 12) + '...');
  return w.address;
}

function _mapPositionToDrift(p: { internalSymbol: string; baseSize: number; entryPrice: number; markPrice: number; unrealizedPnl: number; liquidationPrice?: number | null }) {
  return {
    marketIndex: 0,
    market: p.internalSymbol,
    baseAssetAmount: p.baseSize,
    quoteAssetAmount: 0,
    quoteEntryAmount: 0,
    side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
    sizeUsd: Math.abs(p.baseSize) * p.markPrice,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    unrealizedPnl: p.unrealizedPnl,
    unrealizedPnlPercent: p.entryPrice > 0
      ? ((p.markPrice - p.entryPrice) / p.entryPrice) * 100 * (p.baseSize >= 0 ? 1 : -1)
      : 0,
    liquidationPrice: p.liquidationPrice ?? null,
  };
}

function _mapAccountInfoToDrift(info: { balance: number; equity: number; availableMargin: number; maintenanceMargin: number; unrealizedPnl: number }) {
  const hasOpenPositions = Math.abs(info.unrealizedPnl) > 0.001 || info.maintenanceMargin > 0;
  return {
    usdcBalance: info.balance,
    totalCollateral: info.equity,
    freeCollateral: info.availableMargin,
    hasOpenPositions,
    marginUsed: info.maintenanceMargin,
    unrealizedPnl: info.unrealizedPnl,
    totalPositionNotional: info.maintenanceMargin > 0 ? info.maintenanceMargin / 0.03 : 0,
  };
}

async function getMarketPrice(symbol: string, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<number | null> {
  return adapter.getPrice(symbol);
}

async function getAllPrices(): Promise<Record<string, number>> {
  return getDefaultAdapter().getAllPrices();
}

async function forceRefreshPrices(): Promise<Record<string, number>> {
  return getDefaultAdapter().getAllPrices();
}

async function buildDepositTransaction(walletAddress: string, amountUsdc: number) {
  const { PacificaTxBuilder } = await import('./protocol/pacifica/pacifica-tx-builder');
  return new PacificaTxBuilder().buildDepositTransaction(walletAddress, amountUsdc);
}

async function buildWithdrawTransaction(_walletAddress: string, _amountUsdc: number) {
  throw new Error('Pacifica withdrawals are API-based. Use the exchange withdraw endpoint instead.');
}

async function getUsdcBalance(walletAddress: string): Promise<number> {
  return getAgentUsdcBalance(walletAddress);
}

async function getExchangeBalance(walletAddress: string, subAccountId: number = 0, adapter = getDefaultAdapter()): Promise<number> {
  try {
    const info = await adapter.getAccountInfo(walletAddress, _subIdStr(subAccountId));
    return info.balance;
  } catch { return 0; }
}

async function buildTransferToSubaccountTransaction(_a: string, _b: number, _c: number, _d: number) {
  throw new Error('Pacifica subaccount transfers are API-based. Use executeAgentTransferBetweenSubaccounts instead.');
}

async function buildTransferFromSubaccountTransaction(_a: string, _b: number, _c: number, _d: number) {
  throw new Error('Pacifica subaccount transfers are API-based. Use executeAgentTransferBetweenSubaccounts instead.');
}

async function subaccountExists(walletAddress: string, subAccountId: number, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<boolean> {
  try {
    const subs = await adapter.listSubaccounts(walletAddress);
    return subs.some(s => s.subaccountId === String(subAccountId));
  } catch { return false; }
}

async function buildAgentDriftDepositTransaction(_a: string, _b: string, _c: number) {
  throw new Error('Pacifica agent deposits are executed directly. Use executeAgentDeposit instead.');
}

async function buildAgentDriftWithdrawTransaction(_a: string, _b: string, _c: number) {
  throw new Error('Pacifica agent withdrawals are API-based. Use executeAgentDriftWithdraw instead.');
}

async function executeAgentDeposit(
  agentPublicKey: string,
  agentSecretKey: Uint8Array,
  amountUsdc: number,
  subAccountId: number = 0,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const result = await adapter.executeDeposit({
      agentPublicKey,
      agentSecretKey,
      amount: amountUsdc,
      subaccountId: _subIdStr(subAccountId),
    });
    return { success: result.success, signature: result.txSignature, error: result.error };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

async function executeAgentDriftWithdraw(
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  amountUsdc: number,
  subAccountId: number = 0,
  feeContext?: { tradingBotId?: string | null; context?: string },
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { secretKey } = _decryptToSecretKey(encryptedPrivateKey);
    const mainWalletAddress = await _lookupMainWallet(agentPublicKey);
    const result = await adapter.executeWithdraw({
      agentPublicKey,
      agentSecretKey: secretKey,
      mainWalletAddress,
      amount: amountUsdc,
      subaccountId: _subIdStr(subAccountId),
    });
    if (result.success) {
      // Pacifica charges $1 USDC per on-chain withdrawal — mirror it as its
      // own equity event so user-visible balances reconcile. No-op for Drift.
      await recordPacificaWithdrawFeeIfApplicable({
        walletAddress: mainWalletAddress,
        tradingBotId: feeContext?.tradingBotId ?? null,
        txSignature: result.txSignature ?? null,
        context: feeContext?.context ?? 'Withdraw',
        adapter,
      });
    }
    return { success: result.success, signature: result.txSignature, error: result.error };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

// Pacifica deducts a flat $1 USDC fee on every on-chain withdrawal. We don't
// take this fee — Pacifica does — but the user-visible balance change won't
// match the recorded withdraw amount unless we mirror it as its own equity
// event. Call this AFTER any successful on-chain withdraw (subaccount→
// agent wallet leg). Never call after a pure subaccount-to-subaccount
// transfer — those are internal and free.
async function recordPacificaWithdrawFeeIfApplicable(args: {
  walletAddress: string;
  tradingBotId: string | null;
  txSignature: string | null;
  context: string; // for logs only
  adapter?: ReturnType<typeof getDefaultAdapter>;
}): Promise<void> {
  try {
    if ((args.adapter ?? getDefaultAdapter()).protocolName !== 'pacifica') return;
    const { PACIFICA_WITHDRAW_FEE_USDC } = await import('./protocol/pacifica/pacifica-constants');
    await storage.createEquityEvent({
      walletAddress: args.walletAddress,
      tradingBotId: args.tradingBotId,
      eventType: 'pacifica_withdraw_fee',
      amount: String(-PACIFICA_WITHDRAW_FEE_USDC),
      txSignature: args.txSignature,
      notes: 'Exchange withdrawal fee (charged by Pacifica, not QuantumVault)',
    });
  } catch (feeErr: any) {
    console.error(`[${args.context}] Failed to record Pacifica withdraw fee event (non-blocking):`, feeErr.message);
  }
}

async function executeAgentTransferBetweenSubaccounts(
  agentPublicKey: string,
  encryptedPrivateKey: Uint8Array,
  fromSubAccountId: number,
  toSubAccountId: number,
  amountUsdc: number,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { secretKey } = _decryptToSecretKey(encryptedPrivateKey);
    const mainWalletAddress = await _lookupMainWallet(agentPublicKey);
    const result = await adapter.transferBetweenSubaccounts({
      agentSecretKey: secretKey,
      mainWalletAddress,
      fromSubaccountId: String(fromSubAccountId),
      toSubaccountId: String(toSubAccountId),
      amount: amountUsdc,
    });
    return { success: result.success, error: result.error };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

async function getAgentExchangeBalance(agentPublicKey: string, adapter = getDefaultAdapter()): Promise<number> {
  return getExchangeBalance(agentPublicKey, 0, adapter);
}

async function getExchangeAccountInfo(walletAddress: string, subAccountId: number = 0, adapter = getDefaultAdapter()) {
  try {
    const info = await adapter.getAccountInfo(walletAddress, _subIdStr(subAccountId));
    return _mapAccountInfoToDrift(info);
  } catch (error) {
    console.error('[Adapter] Error reading account info:', error);
    return { usdcBalance: 0, totalCollateral: 0, freeCollateral: 0, hasOpenPositions: false, marginUsed: 0, unrealizedPnl: 0, totalPositionNotional: 0 };
  }
}

async function getBatchDriftAccountInfo(walletAddress: string, subAccountIds: number[], adapter = getDefaultAdapter()) {
  try {
    const results = await adapter.getBatchAccountInfo(walletAddress, subAccountIds.map(String));
    const mapped = new Map<number, any>();
    for (let i = 0; i < subAccountIds.length; i++) {
      if (results[i]) mapped.set(subAccountIds[i], _mapAccountInfoToDrift(results[i]));
    }
    return mapped;
  } catch (error) {
    console.error('[Adapter] Batch account info error:', error);
    return new Map<number, any>();
  }
}

async function getBatchPerpPositions(walletAddress: string, subAccountIds: number[], adapter = getDefaultAdapter()) {
  try {
    const batchResult = await adapter.getBatchPositions(walletAddress, subAccountIds.map(String));
    const mapped = new Map<number, any[]>();
    batchResult.forEach((positions, stringId) => {
      mapped.set(parseInt(stringId, 10), positions.map(_mapPositionToDrift));
    });
    return mapped;
  } catch (error) {
    console.error('[Adapter] Batch positions error:', error);
    return new Map<number, any[]>();
  }
}

async function executePerpOrder(
  encryptedPrivateKey: Uint8Array,
  market: string,
  side: 'long' | 'short',
  sizeInBase: number,
  subAccountId: number = 0,
  reduceOnly: boolean = false,
  _slippageBps: number = 50,
  _privateKeyBase58?: string,
  expectedAgentPubkey?: string,
  leverage?: number,
  botCtx?: BotSubaccountContext | null,
  mainWalletOverride?: string,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; txSignature?: string; error?: string; fillPrice?: number; actualFee?: number; executionMethod?: string; swiftOrderId?: string | null }> {
  let signing: Awaited<ReturnType<typeof _resolveSigningContext>> | null = null;
  try {
    signing = await _resolveSigningContext(encryptedPrivateKey, subAccountId, botCtx ?? null);
    const agentPubKey = expectedAgentPubkey && !botCtx ? expectedAgentPubkey : signing.publicKey;
    // Phase 4b: in botCtx mode the main wallet IS the bot owner's wallet (botCtx.walletAddress).
    // Avoid legacy decrypt of the agent key just to look it up by agent pubkey.
    const mainWalletAddress = mainWalletOverride
      || (botCtx ? botCtx.walletAddress : await _lookupMainWallet(agentPubKey));
    const orderResult = await adapter.placeMarketOrder({
      agentPublicKey: agentPubKey,
      agentSecretKey: signing.secretKey,
      mainWalletAddress,
      internalSymbol: market,
      side,
      sizeBase: sizeInBase,
      reduceOnly,
      subaccountId: signing.subaccountId,
      maxSlippagePct: _slippageBps / 100,
      leverage,
    });
    return {
      success: orderResult.success,
      signature: orderResult.orderId,
      txSignature: orderResult.orderId,
      fillPrice: orderResult.fillPrice,
      actualFee: orderResult.fee,
      error: orderResult.error,
      executionMethod: 'adapter',
      swiftOrderId: null,
    };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  } finally {
    signing?.cleanup();
  }
}

async function getPerpPositions(walletAddress: string, subAccountId: number = 0, botCtx?: BotSubaccountContext | null, adapter = getDefaultAdapter()) {
  try {
    if (botCtx) {
      const positions = await adapter.getPositions(botCtx.botPublicKey);
      return positions.map(_mapPositionToDrift);
    }
    const positions = await adapter.getPositions(walletAddress, _subIdStr(subAccountId));
    return positions.map(_mapPositionToDrift);
  } catch { return []; }
}

async function getExchangeAccountInfoForBot(agentPublicKey: string, subAccountId: number, botCtx: BotSubaccountContext | null, adapter = getDefaultAdapter()) {
  if (botCtx) {
    try {
      const info = await adapter.getAccountInfo(botCtx.botPublicKey);
      return _mapAccountInfoToDrift(info);
    } catch (error) {
      console.error('[Adapter] Error reading bot subaccount info:', error);
      return { usdcBalance: 0, totalCollateral: 0, freeCollateral: 0, hasOpenPositions: false, marginUsed: 0, unrealizedPnl: 0, totalPositionNotional: 0 };
    }
  }
  return getExchangeAccountInfo(agentPublicKey, subAccountId, adapter);
}

async function closePerpPosition(
  encryptedPrivateKey: Uint8Array,
  market: string,
  subAccountId: number = 0,
  positionSizeBase?: number,
  _slippageBps: number = 50,
  _privateKeyBase58?: string,
  expectedAgentPubkey?: string,
  positionSide?: 'long' | 'short',
  botCtx?: BotSubaccountContext | null,
  mainWalletOverride?: string,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; error?: string; executionMethod?: string; fillPrice?: number }> {
  let signing: Awaited<ReturnType<typeof _resolveSigningContext>> | null = null;
  try {
    signing = await _resolveSigningContext(encryptedPrivateKey, subAccountId, botCtx ?? null);
    const agentPubKey = expectedAgentPubkey && !botCtx ? expectedAgentPubkey : signing.publicKey;
    // Phase 4b: in botCtx mode the main wallet IS the bot owner's wallet (botCtx.walletAddress).
    // Avoid legacy decrypt of the agent key just to look it up by agent pubkey.
    const mainWalletAddress = mainWalletOverride
      || (botCtx ? botCtx.walletAddress : await _lookupMainWallet(agentPubKey));
    let orderResult;
    if (positionSizeBase && positionSide) {
      const closeSide: 'long' | 'short' = positionSide === 'long' ? 'short' : 'long';
      orderResult = await adapter.placeMarketOrder({
        agentPublicKey: agentPubKey,
        agentSecretKey: signing.secretKey,
        mainWalletAddress,
        internalSymbol: market,
        side: closeSide,
        sizeBase: positionSizeBase,
        reduceOnly: true,
        subaccountId: signing.subaccountId,
        maxSlippagePct: _slippageBps / 100,
      });
    } else {
      orderResult = await adapter.closePosition({
        agentPublicKey: agentPubKey,
        agentSecretKey: signing.secretKey,
        mainWalletAddress,
        internalSymbol: market,
        subaccountId: signing.subaccountId,
      });
    }
    return {
      success: orderResult.success,
      signature: orderResult.orderId,
      error: orderResult.error,
      executionMethod: 'adapter',
      fillPrice: orderResult.fillPrice,
    };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  } finally {
    signing?.cleanup();
  }
}

async function getNextOnChainSubaccountId(walletAddress: string, dbAllocatedIds: number[] = []): Promise<number> {
  try {
    const subs = await getDefaultAdapter().listSubaccounts(walletAddress);
    const existingIds = subs.map(s => parseInt(s.subaccountId, 10)).filter(n => !isNaN(n));
    const allIds = new Set([...existingIds, ...dbAllocatedIds]);
    let nextId = 1;
    while (allIds.has(nextId)) nextId++;
    return nextId;
  } catch {
    const maxDb = dbAllocatedIds.length > 0 ? Math.max.apply(null, dbAllocatedIds) : 0;
    return maxDb + 1;
  }
}

async function discoverOnChainSubaccounts(walletAddress: string): Promise<number[]> {
  try {
    const subs = await getDefaultAdapter().discoverSubaccounts(walletAddress);
    return subs.map(s => parseInt(s.subaccountId, 10)).filter(n => !isNaN(n));
  } catch { return []; }
}

async function closeDriftSubaccount(
  encryptedPrivateKey: Uint8Array,
  subAccountId: number,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { publicKey } = _decryptToSecretKey(encryptedPrivateKey);
    if (adapter.closeSubaccount) {
      await adapter.closeSubaccount(publicKey, String(subAccountId));
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

async function settleAllPnl(
  encryptedPrivateKey: Uint8Array,
  subAccountId: number,
  adapter = getDefaultAdapter(),
): Promise<{ success: boolean; settledMarkets?: any[]; error?: string }> {
  try {
    if (!adapter.getCapabilities().supportsSettlePnl) {
      return { success: true, settledMarkets: [] };
    }
    const { secretKey, publicKey } = _decryptToSecretKey(encryptedPrivateKey);
    const result = await adapter.settlePnl({
      agentPublicKey: publicKey,
      agentSecretKey: secretKey,
      subaccountId: _subIdStr(subAccountId),
    });
    return { success: result.success, settledMarkets: [], error: result.error };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}
import { reconcileBotPosition, syncPositionFromOnChain } from "./reconciliation-service";
import { PositionService } from "./position-service";
import { getAgentUsdcBalance, getAgentSolBalance, buildTransferToAgentTransaction, buildWithdrawFromAgentTransaction, buildSolTransferToAgentTransaction, buildWithdrawSolFromAgentTransaction, executeAgentWithdraw, executeAgentSolWithdraw, transferUsdcToWallet } from "./agent-wallet";
import { getAllPerpMarkets, getAllPerpMarketsForExchange, getMarketBySymbol, getRiskTierInfo, isValidMarket, refreshMarketData, getCacheStatus, getMinOrderSize, getMinOrderSizeUsd, getMarketMaxLeverage } from "./market-liquidity-service";
import { getAllCachedLeverageLimits, getLeverageCacheStatus, isMarketNonTradable } from "./leverage-cache-service";
import { sendTradeNotification, getCloseReasonLabel, schedulePartialCloseNotification, type TradeNotification, buildDefaultInlineKeyboard } from "./notification-service";
import { classifySignal } from "./trading/signal-classifier";
import { registerTelegramMiniAppRoutes } from "./telegram-mini-app";
import { createSigningNonce, verifySignatureAndConsumeNonce, initializeWalletSecurity, getSession, getSessionByWalletAddress, invalidateSession, cleanupExpiredNonces, revealMnemonic, enableExecution, revokeExecution, emergencyStopWallet, getUmkForWebhook, computeBotPolicyHmac, verifyBotPolicyHmac, decryptAgentKeyStrict, repairStaleV3AgentKeyFromLegacy, generateAgentWalletWithMnemonic, encryptAndStoreMnemonic, encryptAgentKeyV3, encryptBotSubaccountKeyV3, rebindRetainedKeyToBotUuidV3, decryptMnemonic, deriveBotKeypairFromAgentSeed, BOT_DERIVATION_PATH_VERSION } from "./session-v3";
import { queueTradeRetry, isRateLimitError, isTransientError, getQueueStatus, registerRoutingCallback, cancelRetryJobsForBot } from "./trade-retry-service";
import { startAnalyticsIndexer, getMetrics } from "./analytics-indexer";
import { DOCS_MARKDOWN } from "./docs-markdown";

async function getSwiftMetrics() {
  try {
    const s = (await import("./drift-service")).getSwiftHealthTracker().getSnapshot();
    return {
      summary: {
        totalOrders: s.totalAttempts,
        successCount: s.successCount,
        failureCount: s.failureCount,
        fallbackCount: s.fallbackCount,
        successRate: s.successRate,
        avgLatencyMs: s.avgLatencyMs,
        avgPriceImprovementBps: s.avgPriceImprovementBps,
      },
      perMarket: Object.fromEntries(
        Object.entries(s.perOperation).map(([market, m]) => [market, {
          totalOrders: m.totalAttempts,
          successCount: m.successCount,
          failureCount: m.failureCount,
          fallbackCount: m.fallbackCount,
          avgLatencyMs: m.avgLatencyMs,
          successRate: m.successRate,
        }])
      ),
      errorDistribution: s.errorDistribution,
      uptimeSinceReset: s.uptimeSinceReset,
      lastResetAt: s.lastResetAt,
    };
  } catch { return null; }
}
async function getSwiftDiagnostics() { try { return (await import("./swift-config")).getSwiftDiagnostics(); } catch { return null; } }
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

const DEFAULT_EXCHANGE_FEE_RATE = 0.0004;

function getExchangeFeeRate(_protocol?: string | null): number {
  return DEFAULT_EXCHANGE_FEE_RATE;
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    walletAddress: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
    }
  }
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateSignalHash(botId: string, payload: any): string {
  // Create a deterministic hash from botId + key signal data
  // This prevents duplicate orders from the same TradingView alert
  const signalData = {
    botId,
    action: payload?.data?.action || payload?.action || '',
    contracts: payload?.data?.contracts || payload?.contracts || '',
    symbol: payload?.symbol || '',
    time: payload?.time || '',
    // Include price to distinguish different signals (rounded to reduce noise)
    price: payload?.price ? Math.round(parseFloat(payload.price) * 100) / 100 : 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(signalData)).digest('hex').substring(0, 32);
}

function generateWebhookUrl(botId: string, secret: string): string {
  // Use production domain for webhooks, falling back to Replit domains for dev
  const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
    ? 'https://myquantumvault.com'
    : process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://localhost:5000';
  return `${baseUrl}/api/webhook/tradingview/${botId}?secret=${secret}`;
}

// Parse Drift protocol errors into user-friendly messages
function parseDriftError(error: string | undefined): string {
  if (!error) return "Trade execution failed";
  
  // Always log the full error for debugging
  console.log(`[Drift Error] Full error: ${error}`);
  
  // Check for common Drift errors and provide clear messages
  if (error.includes("InsufficientCollateral")) {
    return "Insufficient capital in bot's account. Add more funds or reduce your Max Position Size.";
  }
  if (error.includes("OracleNotFound") || error.includes("Stale")) {
    return "Price feed temporarily unavailable. Try again in a few seconds.";
  }
  if (error.includes("MaxNumberOfPositions")) {
    return "Maximum positions reached. Close existing positions first.";
  }
  if (error.includes("InvalidOracle")) {
    return "Market price data unavailable. Try again later.";
  }
  if (error.includes("MarketWrongMutability") || error.includes("MarketNotActive")) {
    return "Market is currently paused or unavailable.";
  }
  if (error.includes("ReduceOnlyOrderIncreasedRisk")) {
    return "Cannot increase position size with reduce-only order.";
  }
  if (error.includes("timeout") || error.includes("Timeout")) {
    return "Transaction timed out. The trade may have executed - check Drift.";
  }
  // Additional common Drift/Anchor errors
  if (error.includes("ReduceOnly") || error.includes("FillPaused")) {
    return "Market is in reduce-only mode. Only closing positions is allowed.";
  }
  if (error.includes("AMMPaused")) {
    return "Market trading is temporarily paused. Try again later.";
  }
  if (error.includes("AccountOwnedByWrongProgram") || error.includes("wrong owner")) {
    return "Account initialization issue. Try resetting your trading account in Settings.";
  }
  if (error.includes("userStats account") || error.includes("Main account") || error.includes("account does not exist")) {
    return "Trading account not properly initialized. Please deposit funds first.";
  }
  if (error.includes("Key mismatch") || error.includes("decrypted key")) {
    return "Wallet key error. Please contact support.";
  }
  if (error.includes("subscription failed") || error.includes("Market data could not be loaded")) {
    return "Could not load market data. Try again in a few seconds.";
  }
  if (error.includes("0x1") || error.includes("InstructionError")) {
    // Try to extract more specific info from Anchor/instruction errors
    const hexMatch = error.match(/0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      return `Trade rejected by Drift (code: ${hexMatch[0]}). Check account balance.`;
    }
    return "Trade instruction rejected. Check account balance and try again.";
  }
  if (error.includes("unauthorized to sign on behalf of")) {
    return error;
  }
  if (error.includes("SlippageToleranceExceeded") || error.includes("slippage")) {
    return "Price moved too much. Try increasing slippage in Settings.";
  }
  if (error.includes("BorrowLimitExceeded")) {
    return "Borrow limit exceeded. Reduce position size or add more collateral.";
  }
  
  // For other errors, extract a useful portion instead of hiding it
  if (error.length > 150) {
    // Try to extract the main error message
    const errMsgMatch = error.match(/Error Message: ([^.]+)/);
    if (errMsgMatch) return errMsgMatch[1].trim();
    
    // Try to extract Anchor error names
    const anchorMatch = error.match(/Error Name: (\w+)/);
    if (anchorMatch) return `Drift error: ${anchorMatch[1]}`;
    
    // Try to extract the key part of the error
    const errorMatch = error.match(/Error: ([^.]+)/);
    if (errorMatch) return errorMatch[1].trim().slice(0, 100);
    
    // Return a truncated version with the start of the error, not a generic message
    return `Trade failed: ${error.slice(0, 120)}...`;
  }
  
  return error;
}

// Shared trade sizing and capital management helper
// Used by all trade execution paths for consistent behavior
interface TradeSizingParams {
  agentPublicKey: string;
  // V3 Phase 3b: accept either legacy encrypted blob (string) or an
  // already-decrypted secret key (Uint8Array) from decryptAgentKeyStrict.
  // Subscriber fan-out always passes Uint8Array; remaining string callers
  // are out-of-scope until their phase migrates.
  agentPrivateKeyEncrypted: Uint8Array;
  subAccountId: number;
  botId: string;
  walletAddress: string;
  market: string;
  baseCapital: number;
  leverage: number;
  autoTopUp: boolean;
  profitReinvestEnabled: boolean;
  signalPercent: number;
  oraclePrice: number;
  logPrefix: string;
  botCtx?: BotSubaccountContext | null;
  adapter?: ReturnType<typeof getDefaultAdapter>;
}

interface TradeSizingResult {
  success: boolean;
  tradeAmountUsd: number;
  finalContractSize: number;
  freeCollateral: number;
  maxTradeableValue: number;
  effectiveLeverage: number;
  error?: string;
  pauseReason?: string;
  shouldPauseBot?: boolean;
}

async function computeTradeSizingAndTopUp(params: TradeSizingParams): Promise<TradeSizingResult> {
  const {
    agentPublicKey,
    agentPrivateKeyEncrypted,
    subAccountId,
    botId,
    walletAddress,
    market,
    baseCapital,
    leverage,
    autoTopUp,
    profitReinvestEnabled,
    signalPercent,
    oraclePrice,
    logPrefix,
    botCtx,
    adapter = getDefaultAdapter(),
  } = params;

  // Calculate effective leverage (capped by market max)
  const botLeverage = Math.max(1, leverage || 1);
  const marketMaxLeverage = getMarketMaxLeverage(market);
  const effectiveLeverage = Math.min(botLeverage, marketMaxLeverage);

  if (botLeverage > marketMaxLeverage) {
    console.log(`${logPrefix} Leverage capped: ${botLeverage}x → ${marketMaxLeverage}x (${market} max)`);
  }

  // Validate base capital for non-profit-reinvest mode
  if (baseCapital <= 0 && !profitReinvestEnabled) {
    return {
      success: false,
      tradeAmountUsd: 0,
      finalContractSize: 0,
      freeCollateral: 0,
      maxTradeableValue: 0,
      effectiveLeverage,
      error: 'Bot has no capital configured. Set Max Position Size on the bot.',
    };
  }

  let tradeAmountUsd = 0;
  let maxTradeableValue = 0;
  let freeCollateral = 0;

  try {
    const accountInfo = await getExchangeAccountInfoForBot(agentPublicKey, subAccountId, botCtx ?? null, adapter);
    freeCollateral = Math.max(0, accountInfo.freeCollateral);
  } catch (collateralErr: any) {
    console.warn(`${logPrefix} Could not check collateral: ${collateralErr.message}`);
    if (profitReinvestEnabled) {
      return {
        success: false,
        tradeAmountUsd: 0,
        finalContractSize: 0,
        freeCollateral: 0,
        maxTradeableValue: 0,
        effectiveLeverage,
        error: 'Cannot execute trade: profit reinvest enabled but collateral check failed',
      };
    }
    // Fallback for normal mode
    tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
    const contractSize = tradeAmountUsd / oraclePrice;
    return {
      success: true,
      tradeAmountUsd,
      finalContractSize: contractSize,
      freeCollateral: 0,
      maxTradeableValue: 0,
      effectiveLeverage,
    };
  }

  // STEP 2: Auto top-up (run FIRST, before any trade size calculations)
  // baseCapital from DB is the LEVERAGED maxPositionSize, divide by leverage to get actual investment amount
  // Investment amount IS the target equity - simple: deposit enough to reach it
  if (autoTopUp && baseCapital > 0) {
    const currentEquity = freeCollateral;
    const investmentAmount = baseCapital / effectiveLeverage; // Convert leveraged position to equity target
    const targetEquity = investmentAmount;
    const topUpNeeded = Math.max(0, targetEquity - currentEquity);

    console.log(`${logPrefix} Auto top-up check: current equity $${currentEquity.toFixed(2)}, target equity $${targetEquity.toFixed(2)}, need $${topUpNeeded.toFixed(2)}`);

    if (topUpNeeded > 0) {
      try {
        if (botCtx) {
          const agentKeypair = resolveAgentKeypair(agentPrivateKeyEncrypted);
          const depositAmount = Math.ceil(topUpNeeded * 100) / 100;

          const agentAccountInfo = await getExchangeAccountInfo(agentPublicKey, 0, adapter);
          const agentFreeCollateral = agentAccountInfo.freeCollateral;
          console.log(`${logPrefix} Agent main account free collateral: $${agentFreeCollateral.toFixed(2)}, need: $${depositAmount.toFixed(2)}`);

          if (agentFreeCollateral >= depositAmount) {
            console.log(`${logPrefix} Transferring $${depositAmount} from agent to bot subaccount ${botCtx.botPublicKey}`);
            const transferResult = await adapter.transferBetweenSubaccounts({
              agentSecretKey: agentKeypair.secretKey,
              mainWalletAddress: agentKeypair.publicKey.toString(),
              fromSubaccountId: agentKeypair.publicKey.toString(),
              toSubaccountId: botCtx.botPublicKey,
              amount: depositAmount,
            });
            if (transferResult.success) {
              console.log(`${logPrefix} Auto top-up transfer successful: $${depositAmount.toFixed(2)}`);
              freeCollateral += depositAmount;
              await storage.createEquityEvent({
                walletAddress,
                tradingBotId: botId,
                eventType: 'auto_topup',
                amount: String(depositAmount),
                txSignature: null,
                notes: `Auto top-up transfer: agent→${botCtx.botPublicKey.slice(0,8)}... $${depositAmount.toFixed(2)}`,
              });
            } else {
              console.log(`${logPrefix} Auto top-up transfer failed: ${transferResult.error}, will proceed with available margin`);
            }
          } else {
            console.log(`${logPrefix} Agent main ($${agentFreeCollateral.toFixed(2)}) insufficient for top-up ($${depositAmount.toFixed(2)})`);
          }
        } else {
          const agentUsdcBalance = await getAgentUsdcBalance(agentPublicKey);
          console.log(`${logPrefix} Agent wallet USDC balance: $${agentUsdcBalance.toFixed(2)}, need: $${topUpNeeded.toFixed(2)}`);

          if (agentUsdcBalance >= topUpNeeded) {
            const depositAmount = Math.ceil(topUpNeeded * 100) / 100;
            const depositResult = await executeAgentDeposit(
              agentPublicKey,
              agentPrivateKeyEncrypted,
              depositAmount,
              subAccountId,
              adapter,
            );

            if (depositResult.success) {
              console.log(`${logPrefix} Auto top-up successful: deposited $${depositAmount.toFixed(2)} (equity $${currentEquity.toFixed(2)} → $${(currentEquity + depositAmount).toFixed(2)}), tx: ${depositResult.signature}`);
              freeCollateral += depositAmount;
              await storage.createEquityEvent({
                walletAddress,
                tradingBotId: botId,
                eventType: 'auto_topup',
                amount: String(depositAmount),
                txSignature: depositResult.signature || null,
                notes: `Auto top-up: equity $${currentEquity.toFixed(2)} → $${freeCollateral.toFixed(2)} for $${baseCapital.toFixed(2)} position`,
              });
              console.log(`${logPrefix} Updated equity after top-up: $${freeCollateral.toFixed(2)}`);
            } else {
              console.log(`${logPrefix} Auto top-up deposit failed: ${depositResult.error}, will proceed with available margin`);
            }
          } else {
            console.log(`${logPrefix} Agent wallet ($${agentUsdcBalance.toFixed(2)}) insufficient for top-up ($${topUpNeeded.toFixed(2)}), will proceed with available margin`);
          }
        }
      } catch (topUpErr: any) {
        console.log(`${logPrefix} Auto top-up error: ${topUpErr.message}, will proceed with available margin`);
      }
    }
  }

  // GUARD: Minimum equity check - prevent submitting trades that will fail on-chain
  // Check BOTH base-unit minimum AND notional USD minimum (Pacifica enforces $10 notional minimum)
  const minOrderSize = getMinOrderSize(market);
  const minOrderUsd = getMinOrderSizeUsd(market);
  const minEquityFromBase = (minOrderSize * oraclePrice / effectiveLeverage) * 1.2;
  const minEquityFromUsd = (minOrderUsd / effectiveLeverage) * 1.15;
  const minEquityNeeded = Math.max(minEquityFromBase, minEquityFromUsd);
  const minEquityThreshold = Math.max(0.50, minEquityNeeded);
  
  if (freeCollateral < minEquityThreshold) {
    const pauseReason = `Bot underfunded: $${freeCollateral.toFixed(2)} equity available but need $${minEquityThreshold.toFixed(2)} minimum for ${market} ($${minOrderUsd} min notional at ${effectiveLeverage}x leverage). Top up your bot to continue trading.`;
    console.log(`${logPrefix} ${pauseReason}`);
    return {
      success: false,
      tradeAmountUsd: 0,
      finalContractSize: 0,
      freeCollateral,
      maxTradeableValue: 0,
      effectiveLeverage,
      error: pauseReason,
      pauseReason,
      shouldPauseBot: true,
    };
  }

  // STEP 3: Calculate max tradeable value after potential top-up
  const maxNotionalCapacity = freeCollateral * effectiveLeverage;
  maxTradeableValue = maxNotionalCapacity * 0.90; // 90% buffer for fees/slippage/oracle drift

  // STEP 4: Calculate trade amount based on mode
  if (profitReinvestEnabled) {
    // PROFIT REINVEST MODE: Use full available margin
    if (maxTradeableValue <= 0) {
      return {
        success: false,
        tradeAmountUsd: 0,
        finalContractSize: 0,
        freeCollateral,
        maxTradeableValue: 0,
        effectiveLeverage,
        error: `Cannot trade: profit reinvest enabled but no margin available (freeCollateral=$${freeCollateral.toFixed(2)})`,
      };
    }
    const requestedAmount = signalPercent > 0 ? (signalPercent / 100) * maxTradeableValue : maxTradeableValue;
    tradeAmountUsd = Math.min(requestedAmount, maxTradeableValue);
    console.log(`${logPrefix} PROFIT REINVEST: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x × 90% = $${maxTradeableValue.toFixed(2)} max`);
    if (requestedAmount > maxTradeableValue) {
      console.log(`${logPrefix} Requested $${requestedAmount.toFixed(2)} exceeds available, capped to $${tradeAmountUsd.toFixed(2)}`);
    } else {
      console.log(`${logPrefix} ${signalPercent.toFixed(2)}% of $${maxTradeableValue.toFixed(2)} available margin = $${tradeAmountUsd.toFixed(2)} trade`);
    }
  } else {
    // NORMAL MODE: Use fixed maxPositionSize, scale down if needed
    tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
    console.log(`${logPrefix} ${signalPercent.toFixed(2)}% of $${baseCapital} maxPositionSize = $${tradeAmountUsd.toFixed(2)} trade (before collateral check)`);
    console.log(`${logPrefix} Dynamic scaling: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x leverage = $${maxNotionalCapacity.toFixed(2)} max notional`);

    // Scale down if needed (use 95% buffer for normal mode - more aggressive than profit reinvest)
    const adjustedMaxTradeable = freeCollateral * effectiveLeverage * 0.95;
    if (adjustedMaxTradeable <= 0) {
      console.log(`${logPrefix} No margin available after top-up check, will attempt minimum viable trade`);
    } else if (tradeAmountUsd > adjustedMaxTradeable) {
      const originalAmount = tradeAmountUsd;
      tradeAmountUsd = adjustedMaxTradeable;
      const scalePercent = ((tradeAmountUsd / originalAmount) * 100).toFixed(1);
      console.log(`${logPrefix} SCALED: Trade $${originalAmount.toFixed(2)} → $${tradeAmountUsd.toFixed(2)} (${scalePercent}% of requested)`);
    } else {
      console.log(`${logPrefix} Full size available: $${tradeAmountUsd.toFixed(2)} within $${adjustedMaxTradeable.toFixed(2)} capacity`);
    }
  }

  console.log(`${logPrefix} Final trade amount: $${tradeAmountUsd.toFixed(2)}`);

  // STEP 5: Calculate contract size
  let contractSize = tradeAmountUsd / oraclePrice;
  console.log(`${logPrefix} $${tradeAmountUsd.toFixed(2)} / $${oraclePrice.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

  // STEP 6: Handle minimum order size (minOrderSize already computed in equity guard above)
  let finalContractSize = contractSize;

  if (contractSize < minOrderSize) {
    const minCapitalNeeded = minOrderSize * oraclePrice;
    const maxCapacity = freeCollateral * effectiveLeverage * 0.9;

    if (minCapitalNeeded <= maxCapacity) {
      finalContractSize = minOrderSize;
      console.log(`${logPrefix} BUMPED UP: ${contractSize.toFixed(4)} contracts → ${minOrderSize} minimum (requires $${minCapitalNeeded.toFixed(2)}, you have $${maxCapacity.toFixed(2)} capacity)`);
    } else {
      // Cannot meet minimum order size with current margin - try secondary auto top-up
      const requiredCollateral = (minCapitalNeeded / effectiveLeverage) * 1.2;
      const shortfall = Math.max(0, requiredCollateral - freeCollateral);

      console.log(`${logPrefix} Insufficient margin: need $${requiredCollateral.toFixed(2)} collateral, have $${freeCollateral.toFixed(2)}, shortfall: $${shortfall.toFixed(2)}`);

      if (autoTopUp) {
        console.log(`${logPrefix} Auto top-up enabled, attempting secondary top-up for min order`);

        try {
          if (botCtx) {
            const agentKeypair = resolveAgentKeypair(agentPrivateKeyEncrypted);
            const depositAmount = Math.ceil(shortfall * 100) / 100;

            const agentAccountInfo = await getExchangeAccountInfo(agentPublicKey, 0, adapter);
            if (agentAccountInfo.freeCollateral >= depositAmount) {
              const transferResult = await adapter.transferBetweenSubaccounts({
                agentSecretKey: agentKeypair.secretKey,
                mainWalletAddress: agentKeypair.publicKey.toString(),
                fromSubaccountId: agentKeypair.publicKey.toString(),
                toSubaccountId: botCtx.botPublicKey,
                amount: depositAmount,
              });
              if (transferResult.success) {
                console.log(`${logPrefix} Secondary top-up transfer successful: $${depositAmount.toFixed(2)}`);
                freeCollateral += depositAmount;
                finalContractSize = minOrderSize;
                await storage.createEquityEvent({
                  walletAddress,
                  tradingBotId: botId,
                  eventType: 'auto_topup',
                  amount: String(depositAmount),
                  txSignature: null,
                  notes: `Secondary top-up transfer: agent→${botCtx.botPublicKey.slice(0,8)}... $${depositAmount.toFixed(2)} for min order`,
                });
              } else {
                const pauseReason = `Insufficient margin for ${minOrderSize} ${market}. Transfer failed: ${transferResult.error}`;
                return { success: false, tradeAmountUsd, finalContractSize: contractSize, freeCollateral, maxTradeableValue, effectiveLeverage, error: pauseReason, pauseReason, shouldPauseBot: true };
              }
            } else {
              const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} for ${minOrderSize} ${market}. Agent main has $${agentAccountInfo.freeCollateral.toFixed(2)}.`;
              return { success: false, tradeAmountUsd, finalContractSize: contractSize, freeCollateral, maxTradeableValue, effectiveLeverage, error: pauseReason, pauseReason, shouldPauseBot: true };
            }
          } else {
          const agentUsdcBalance = await getAgentUsdcBalance(agentPublicKey);
          console.log(`${logPrefix} Agent wallet USDC balance: $${agentUsdcBalance.toFixed(2)}, shortfall: $${shortfall.toFixed(2)}`);

          if (agentUsdcBalance >= shortfall) {
            const depositAmount = Math.ceil(shortfall * 100) / 100;
            const depositResult = await executeAgentDeposit(
              agentPublicKey,
              agentPrivateKeyEncrypted,
              depositAmount,
              subAccountId,
              adapter,
            );

            if (depositResult.success) {
              console.log(`${logPrefix} Auto top-up successful: deposited $${depositAmount.toFixed(2)}, tx: ${depositResult.signature}`);
              freeCollateral += depositAmount;
              finalContractSize = minOrderSize;

              await storage.createEquityEvent({
                walletAddress,
                tradingBotId: botId,
                eventType: 'auto_topup',
                amount: String(depositAmount),
                txSignature: depositResult.signature || null,
                notes: `Auto top-up triggered: margin $${(freeCollateral - depositAmount).toFixed(2)} insufficient for ${minOrderSize} ${market} (need $${requiredCollateral.toFixed(2)})`,
              });

              console.log(`${logPrefix} Proceeding with trade after auto top-up: ${finalContractSize} contracts`);
            } else {
              const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${market}. Auto top-up failed: ${depositResult.error}`;
              return {
                success: false,
                tradeAmountUsd,
                finalContractSize: contractSize,
                freeCollateral,
                maxTradeableValue,
                effectiveLeverage,
                error: pauseReason,
                pauseReason,
                shouldPauseBot: true,
              };
            }
          } else {
            const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${market}. Agent wallet only has $${agentUsdcBalance.toFixed(2)} USDC available for top-up.`;
            return {
              success: false,
              tradeAmountUsd,
              finalContractSize: contractSize,
              freeCollateral,
              maxTradeableValue,
              effectiveLeverage,
              error: pauseReason,
              pauseReason,
              shouldPauseBot: true,
            };
          }
          }
        } catch (topUpErr: any) {
          const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${market}. Auto top-up failed: ${topUpErr.message}`;
          return {
            success: false,
            tradeAmountUsd,
            finalContractSize: contractSize,
            freeCollateral,
            maxTradeableValue,
            effectiveLeverage,
            error: pauseReason,
            pauseReason,
            shouldPauseBot: true,
          };
        }
      } else {
        // Auto top-up disabled - pause the bot
        const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${market}, but only $${freeCollateral.toFixed(2)} available. Top up your bot to continue trading.`;
        return {
          success: false,
          tradeAmountUsd,
          finalContractSize: contractSize,
          freeCollateral,
          maxTradeableValue,
          effectiveLeverage,
          error: pauseReason,
          pauseReason,
          shouldPauseBot: true,
        };
      }
    }
  }

  // STEP 7: Final notional floor check — Pacifica enforces a minimum notional (typically $10)
  const finalNotional = finalContractSize * oraclePrice;
  if (finalNotional < minOrderUsd) {
    const minContractsForNotional = minOrderUsd / oraclePrice;
    const requiredCollateralForMin = (minOrderUsd / effectiveLeverage) * 1.05;
    if (freeCollateral >= requiredCollateralForMin) {
      console.log(`${logPrefix} NOTIONAL FLOOR: $${finalNotional.toFixed(2)} < $${minOrderUsd} minimum. Bumping ${finalContractSize.toFixed(6)} → ${minContractsForNotional.toFixed(6)} contracts (need $${requiredCollateralForMin.toFixed(2)} collateral, have $${freeCollateral.toFixed(2)})`);
      finalContractSize = minContractsForNotional;
      tradeAmountUsd = minOrderUsd;
    } else {
      const pauseReason = `Order notional $${finalNotional.toFixed(2)} below Pacifica minimum of $${minOrderUsd}. Need $${requiredCollateralForMin.toFixed(2)} equity at ${effectiveLeverage}x leverage, but only $${freeCollateral.toFixed(2)} available. Deposit more funds to trade.`;
      console.log(`${logPrefix} ${pauseReason}`);
      return {
        success: false,
        tradeAmountUsd,
        finalContractSize,
        freeCollateral,
        maxTradeableValue,
        effectiveLeverage,
        error: pauseReason,
        pauseReason,
        shouldPauseBot: true,
      };
    }
  }

  return {
    success: true,
    tradeAmountUsd,
    finalContractSize,
    freeCollateral,
    maxTradeableValue,
    effectiveLeverage,
  };
}

// Distribute profit share from subscriber bot to signal creator
// Called after a profitable close trade on subscriber bots
async function distributeCreatorProfitShare(params: {
  subscriberBotId: string;
  subscriberWalletAddress: string;
  subscriberAgentPublicKey: string;
  // V3 Phase 3b: live subscriber fan-out passes a Uint8Array secret key from
  // decryptAgentKeyStrict; legacy IOU-retry callers still pass the encrypted
  // string blob. Downstream helpers (settleAllPnl, executeAgentDriftWithdraw,
  // payCreatorAndReferrals → transferUsdcToWallet) already accept both.
  subscriberEncryptedPrivateKey: Uint8Array;
  driftSubaccountId: number;
  realizedPnl: number;
  tradeId: string;
}): Promise<{ success: boolean; amount?: number; signature?: string; error?: string }> {
  const { 
    subscriberBotId, 
    subscriberWalletAddress,
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    driftSubaccountId,
    realizedPnl, 
    tradeId 
  } = params;

  // Validation 1: Only process profitable trades
  if (realizedPnl <= 0) {
    return { success: true }; // No profit = no share to distribute
  }

  // Validation 2: Check if this is a subscriber bot
  const subscription = await storage.getBotSubscriptionBySubscriberBotId(subscriberBotId);
  if (!subscription) {
    return { success: true }; // Not a subscriber bot, no profit share
  }

  const { publishedBot } = subscription;
  const profitSharePercent = parseFloat(String(publishedBot.profitSharePercent ?? 0));

  // Validation 3: Check if profit sharing is enabled
  if (profitSharePercent <= 0 || isNaN(profitSharePercent)) {
    console.log(`[ProfitShare] No profit share configured for published bot ${publishedBot.id}`);
    return { success: true };
  }

  // Calculate profit share amount
  const profitShareAmount = (realizedPnl * profitSharePercent) / 100;
  
  // Validation 4: Dust check - don't process amounts below $0.01
  if (profitShareAmount < 0.01) {
    console.log(`[ProfitShare] Dust amount $${profitShareAmount.toFixed(4)}, skipping for trade ${tradeId}`);
    return { success: true };
  }

  // Get creator's wallet address directly from published bot
  const creatorWalletAddress = publishedBot.creatorWalletAddress;
  if (!creatorWalletAddress) {
    console.error(`[ProfitShare] Creator wallet address not found for published bot ${publishedBot.id}`);
    return { success: false, error: 'Creator wallet address not found' };
  }

  // Validation 5: Validate creator wallet address
  try {
    new PublicKey(creatorWalletAddress);
  } catch (e) {
    console.error(`[ProfitShare] Invalid creator wallet address: ${creatorWalletAddress}`);
    return { success: false, error: 'Invalid creator wallet address' };
  }

  console.log(`[ProfitShare] Processing: trade=${tradeId}, pnl=$${realizedPnl.toFixed(4)}, share=${profitSharePercent}%, amount=$${profitShareAmount.toFixed(4)}, creator=${creatorWalletAddress}`);

  // 12i: Look up subscriber bot once to get the canonical `protocolSubaccountId`
  // (populated correctly per auth mode by 12f/12h-A: pubkey for Pacifica, numeric
  // string for Drift). Prefer this over the legacy `String(driftSubaccountId)` cast,
  // which only happens to be correct for Drift bots and would store the wrong
  // identifier shape for any future Pacifica subscriber.
  const subscriberBotRow = await storage.getTradingBotById(subscriberBotId);
  const canonicalProtocolSubaccountId =
    subscriberBotRow?.protocolSubaccountId ?? String(driftSubaccountId);
  if (!subscriberBotRow?.protocolSubaccountId) {
    console.warn(`[ProfitShare] IOU for trade ${tradeId} (bot ${subscriberBotId}) missing canonical protocolSubaccountId on bot row; falling back to String(driftSubaccountId)=${String(driftSubaccountId)}`);
  }

  // Route the subscriber's withdraw through the subscriber bot's adapter (no-op
  // for Pacifica today; fail-closed default if the bot row vanished mid-flight).
  const profitShareAdapter = subscriberBotRow ? getAdapterForBot(subscriberBotRow) : getDefaultAdapter();

  // Helper function to create IOU on failure
  const createIouOnFailure = async (errorMsg: string) => {
    try {
      await storage.createPendingProfitShare({
        subscriberBotId,
        subscriberWalletAddress,
        creatorWalletAddress,
        amount: profitShareAmount.toString(),
        realizedPnl: realizedPnl.toString(),
        profitSharePercent: profitSharePercent.toString(),
        tradeId,
        publishedBotId: publishedBot.id,
        driftSubaccountId,
        protocolSubaccountId: canonicalProtocolSubaccountId,
      });
      console.log(`[ProfitShare] IOU created for $${profitShareAmount.toFixed(4)} to ${creatorWalletAddress} (trade: ${tradeId})`);
    } catch (iouErr: any) {
      console.error(`[ProfitShare] Failed to create IOU: ${iouErr.message}`);
    }
  };

  // Step 1: Settle PnL from on-chain position
  const settleResult = await settleAllPnl(subscriberEncryptedPrivateKey, driftSubaccountId, profitShareAdapter);
  if (!settleResult.success) {
    console.error(`[ProfitShare] Failed to settle PnL: ${settleResult.error}`);
    await createIouOnFailure(`Settle PnL failed: ${settleResult.error}`);
    return { success: false, error: `Settle PnL failed: ${settleResult.error}` };
  }

  // Step 2: Withdraw from Drift subaccount to agent wallet
  const withdrawResult = await executeAgentDriftWithdraw(
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    profitShareAmount,
    driftSubaccountId,
    undefined,
    profitShareAdapter
  );

  if (!withdrawResult.success) {
    // Handle cross-margin collateral and other withdrawal failures
    const errorMsg = withdrawResult.error || 'Unknown withdrawal error';
    console.error(`[ProfitShare] Drift withdrawal failed: ${errorMsg}`);
    
    // Check for dust error and retry with slightly less
    if (errorMsg.includes('Withdraw leaves user negative USDC') || errorMsg.includes('6088')) {
      const dustAdjustedAmount = profitShareAmount - 0.000001;
      if (dustAdjustedAmount >= 0.01) {
        console.log(`[ProfitShare] Retrying withdrawal with dust-adjusted amount: $${dustAdjustedAmount.toFixed(6)}`);
        const retryResult = await executeAgentDriftWithdraw(
          subscriberAgentPublicKey,
          subscriberEncryptedPrivateKey,
          dustAdjustedAmount,
          driftSubaccountId,
          undefined,
          profitShareAdapter
        );
        if (!retryResult.success) {
          await createIouOnFailure(`Drift withdrawal failed after dust adjustment: ${retryResult.error}`);
          return { success: false, error: `Drift withdrawal failed after dust adjustment: ${retryResult.error}`, amount: profitShareAmount };
        }
      } else {
        await createIouOnFailure('Amount too small after dust adjustment');
        return { success: false, error: 'Amount too small after dust adjustment', amount: profitShareAmount };
      }
    } else {
      await createIouOnFailure(`Drift withdrawal failed: ${errorMsg}`);
      return { success: false, error: `Drift withdrawal failed: ${errorMsg}`, amount: profitShareAmount };
    }
  }

  console.log(`[ProfitShare] Drift withdrawal succeeded for trade ${tradeId}; routing through payCreatorAndReferrals (Model A)`);

  // MLM Model A: net referral cuts out of the creator transfer. The helper pays
  // the creator their NET amount, then distributes the reserved cut to up to 3
  // upline ancestors. All transfers come out of the subscriber's agent wallet,
  // which already holds the full `profitShareAmount` post-Drift-withdrawal.
  const payoutResult = await payCreatorAndReferrals({
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    creatorWalletAddress,
    profitShareAmount,
    sourceType: 'profit_share_paid',
    sourceId: tradeId,
    fundingWallet: subscriberWalletAddress,
  });

  if (!payoutResult.success) {
    const errorMsg = payoutResult.error || 'Unknown payout error';
    console.error(`[ProfitShare] payCreatorAndReferrals failed for trade ${tradeId}: ${errorMsg}`);
    await createIouOnFailure(errorMsg);
    if (errorMsg.includes('Insufficient SOL')) {
      return {
        success: false,
        error: `Transfer failed - agent wallet needs SOL for gas`,
        amount: profitShareAmount,
      };
    }
    return { success: false, error: `Transfer failed: ${errorMsg}`, amount: profitShareAmount };
  }

  console.log(`[ProfitShare] SUCCESS: trade=${tradeId}, creator $${(payoutResult.creatorAmount ?? 0).toFixed(4)} (signature: ${payoutResult.creatorSignature}), referrals: ${payoutResult.referralSummary}`);

  return {
    success: true,
    amount: payoutResult.creatorAmount,
    signature: payoutResult.creatorSignature,
  };
}

// MLM referral reward percentages per level, applied to the creator's profit-share amount.
// L1 = direct referrer of the creator, L2 = L1's referrer, L3 = L2's referrer.
const REFERRAL_LEVEL_PERCENTS: Record<1 | 2 | 3, number> = { 1: 5, 2: 2, 3: 1 };
const MIN_PAYABLE_MICRO_USDC = 10_000; // $0.01

type ReferralLeg = {
  level: 1 | 2 | 3;
  earnerWallet: string;
  amountMicro: number;
};

/**
 * Compute the per-ancestor referral cuts for a given gross profit-share amount.
 * Operates in integer micro-USDC to avoid floating-point drift. Skips dust legs
 * (< $0.01) and de-duplicates ancestors so the same wallet can't double-claim
 * across levels in a single source event.
 */
function computeReferralLegs(
  chain: { ancestorWallet: string; level: number }[],
  refereeWallet: string,
  profitShareAmount: number,
): { legs: ReferralLeg[]; totalCutMicro: number } {
  const grossMicro = Math.round(profitShareAmount * 1_000_000);
  if (grossMicro <= 0) return { legs: [], totalCutMicro: 0 };
  const seenEarners = new Set<string>([refereeWallet]);
  const legs: ReferralLeg[] = [];
  let totalCutMicro = 0;
  for (const link of chain) {
    const lvl = link.level as 1 | 2 | 3;
    const pct = REFERRAL_LEVEL_PERCENTS[lvl];
    if (!pct) continue;
    if (seenEarners.has(link.ancestorWallet)) {
      console.warn(`[ReferralRewards] Skipping duplicate ancestor ${link.ancestorWallet} at L${lvl} (referee=${refereeWallet})`);
      continue;
    }
    const cutMicro = Math.floor((grossMicro * pct) / 100);
    if (cutMicro < MIN_PAYABLE_MICRO_USDC) continue;
    seenEarners.add(link.ancestorWallet);
    legs.push({ level: lvl, earnerWallet: link.ancestorWallet, amountMicro: cutMicro });
    totalCutMicro += cutMicro;
  }
  return { legs, totalCutMicro };
}

/**
 * Pay a single referral leg: upsert the pending event, then attempt the on-chain
 * transfer. Idempotent — if the row already exists with status='paid', this is a
 * no-op. Updates row status based on outcome and returns the final status.
 */
async function payOneReferralLeg(params: {
  sourceType: string;
  sourceId: string;
  refereeWallet: string;
  fundingWallet: string;
  subscriberAgentPublicKey: string;
  // V3 Phase 3b: string for legacy callers, Uint8Array for live subscriber
  // fan-out (post-decryptAgentKeyStrict). transferUsdcToWallet handles both.
  subscriberEncryptedPrivateKey: Uint8Array;
  leg: ReferralLeg;
}): Promise<{ status: 'paid' | 'pending' | 'skipped'; signature?: string; error?: string }> {
  const { sourceType, sourceId, refereeWallet, fundingWallet, subscriberAgentPublicKey, subscriberEncryptedPrivateKey, leg } = params;
  const amountUsdc = leg.amountMicro / 1_000_000;

  const event = await storage.upsertReferralRewardEventPending({
    sourceType,
    sourceId,
    earnerWallet: leg.earnerWallet,
    refereeWallet,
    fundingWallet,
    level: leg.level,
    amountUsdc: amountUsdc.toFixed(6),
    status: 'pending',
  });

  if (event.status === 'paid') {
    return { status: 'paid', signature: event.transferSignature ?? undefined };
  }

  const transferResult = await transferUsdcToWallet(
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    leg.earnerWallet,
    amountUsdc,
  );

  if (transferResult.success) {
    await storage.updateReferralRewardEventStatus(event.id, {
      status: 'paid',
      transferSignature: transferResult.signature ?? null,
      lastError: null,
      lastAttemptAt: new Date(),
    });
    console.log(`[ReferralRewards] PAID L${leg.level} +$${amountUsdc.toFixed(4)} to ${leg.earnerWallet} (referee=${refereeWallet}, source=${sourceType}:${sourceId}, sig=${transferResult.signature})`);
    return { status: 'paid', signature: transferResult.signature };
  }

  const errMsg = transferResult.error || 'Unknown transfer error';
  await storage.updateReferralRewardEventStatus(event.id, {
    status: 'pending',
    retryCount: (event.retryCount ?? 0) + 1,
    lastError: errMsg,
    lastAttemptAt: new Date(),
  });
  console.warn(`[ReferralRewards] PENDING (will retry) L${leg.level} $${amountUsdc.toFixed(4)} earner=${leg.earnerWallet}: ${errMsg}`);
  return { status: 'pending', error: errMsg };
}

/**
 * Shared payout pipeline (Model A). Splits a gross profit-share amount into a
 * net creator payment and per-level referral payments, then transfers each from
 * the subscriber's agent wallet sequentially. Returns success based on the
 * creator transfer; referral leg failures are tracked on referral_reward_events
 * and retried by the referral-rewards-retry-job worker.
 *
 * Called from both the live profit-share path and the IOU retry job, so it is
 * fully idempotent on (sourceType, sourceId).
 */
async function payCreatorAndReferrals(params: {
  subscriberAgentPublicKey: string;
  // V3 Phase 3b: string for legacy/IOU-retry callers, Uint8Array for live
  // subscriber fan-out (post-decryptAgentKeyStrict).
  subscriberEncryptedPrivateKey: Uint8Array;
  creatorWalletAddress: string;
  profitShareAmount: number;
  sourceType: string;
  sourceId: string;
  fundingWallet: string;
}): Promise<{
  success: boolean;
  creatorAmount?: number;
  creatorSignature?: string;
  referralSummary?: string;
  error?: string;
}> {
  const {
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    creatorWalletAddress,
    profitShareAmount,
    sourceType,
    sourceId,
    fundingWallet,
  } = params;

  if (!(profitShareAmount > 0)) {
    return { success: false, error: 'Non-positive profit share amount' };
  }

  // Validate creator wallet
  try {
    new PublicKey(creatorWalletAddress);
  } catch {
    return { success: false, error: `Invalid creator wallet address: ${creatorWalletAddress}` };
  }

  const grossMicro = Math.round(profitShareAmount * 1_000_000);

  // Compute referral split. Self-referrals against the creator are excluded by
  // computeReferralLegs (creator is added to seenEarners up front).
  const chain = await storage.getReferralChain(creatorWalletAddress);
  const { legs, totalCutMicro } = computeReferralLegs(chain, creatorWalletAddress, profitShareAmount);

  let creatorMicro = grossMicro - totalCutMicro;
  let payableLegs = legs;

  // Edge case: if netting referrals would leave the creator with dust (<$0.01),
  // pay creator the full gross and skip referrals entirely. This mostly applies
  // when profit share itself is tiny (e.g. <$0.10).
  if (creatorMicro < MIN_PAYABLE_MICRO_USDC) {
    console.warn(`[Payout] Creator net would be dust ($${(creatorMicro / 1_000_000).toFixed(6)}); paying full gross and skipping ${legs.length} referral legs (source=${sourceType}:${sourceId})`);
    creatorMicro = grossMicro;
    payableLegs = [];
  }

  const creatorAmount = creatorMicro / 1_000_000;

  // Step 1: pay the creator (sequential — must succeed before we touch referrals).
  const creatorTransfer = await transferUsdcToWallet(
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    creatorWalletAddress,
    creatorAmount,
  );

  if (!creatorTransfer.success) {
    return {
      success: false,
      error: creatorTransfer.error || 'Creator transfer failed',
      creatorAmount,
    };
  }

  // Step 2: pay referral legs sequentially. Failures here do NOT roll back the
  // creator payment — they're tracked on referral_reward_events and retried by
  // the dedicated worker. Sequential is required: parallel transfers from the
  // same agent wallet would collide on blockhash/nonce.
  let paidLegs = 0;
  let pendingLegs = 0;
  for (const leg of payableLegs) {
    try {
      const r = await payOneReferralLeg({
        sourceType,
        sourceId,
        refereeWallet: creatorWalletAddress,
        fundingWallet,
        subscriberAgentPublicKey,
        subscriberEncryptedPrivateKey,
        leg,
      });
      if (r.status === 'paid') paidLegs++;
      else if (r.status === 'pending') pendingLegs++;
    } catch (err: any) {
      pendingLegs++;
      console.error(`[ReferralRewards] payOneReferralLeg threw L${leg.level} earner=${leg.earnerWallet}: ${err?.message || err}`);
    }
  }

  return {
    success: true,
    creatorAmount,
    creatorSignature: creatorTransfer.signature,
    referralSummary: `${paidLegs} paid, ${pendingLegs} pending (of ${payableLegs.length})`,
  };
}

export { payCreatorAndReferrals };

/**
 * Write the referral chain (up to 3 levels) for a newly-referred descendant.
 * Performs a cycle check: refuses to write if the referrer is itself a descendant
 * of the new wallet (would form a cycle). Idempotent via the unique
 * (descendant_wallet, level) constraint.
 *
 * Returns true if any links were written (or already existed), false if the
 * relationship was rejected as cyclic / self-referential.
 */
async function writeReferralChain(descendantWallet: string, referrerWallet: string): Promise<boolean> {
  if (!descendantWallet || !referrerWallet) return false;
  if (descendantWallet === referrerWallet) {
    console.warn(`[Referral] Refusing self-referral for ${descendantWallet}`);
    return false;
  }

  // Cycle check: walk the referrer's ancestor chain; if the new descendant
  // appears anywhere in it, this would create a cycle.
  const referrerChain = await storage.getReferralChain(referrerWallet);
  for (const link of referrerChain) {
    if (link.ancestorWallet === descendantWallet) {
      console.warn(`[Referral] Refusing cyclic referral: ${referrerWallet} -> ${descendantWallet} (cycle via L${link.level})`);
      return false;
    }
  }

  const links: { descendantWallet: string; ancestorWallet: string; level: number }[] = [
    { descendantWallet, ancestorWallet: referrerWallet, level: 1 },
  ];
  const l1OfReferrer = referrerChain.find(l => l.level === 1);
  if (l1OfReferrer && l1OfReferrer.ancestorWallet !== descendantWallet) {
    links.push({ descendantWallet, ancestorWallet: l1OfReferrer.ancestorWallet, level: 2 });
  }
  const l2OfReferrer = referrerChain.find(l => l.level === 2);
  if (l2OfReferrer && l2OfReferrer.ancestorWallet !== descendantWallet) {
    links.push({ descendantWallet, ancestorWallet: l2OfReferrer.ancestorWallet, level: 3 });
  }

  try {
    await storage.createReferralLinks(links);
    console.log(`[Referral] Wrote chain for ${descendantWallet}: ${links.map(l => `L${l.level}=${l.ancestorWallet.slice(0, 6)}`).join(', ')}`);
    return true;
  } catch (err: any) {
    console.error(`[Referral] Failed to write chain for ${descendantWallet}: ${err?.message || err}`);
    return false;
  }
}

function parseSignalForRouting(body: any): { action: string | null; contracts: string; isCloseSignal: boolean; price: string; strategyPositionSize: string | null } {
  let action: string | null = null;
  let contracts = "0";
  let strategyPositionSize: string | null = null;
  let price = "0";
  
  if (typeof body === 'object' && body !== null) {
    if (body.position_size !== undefined) strategyPositionSize = String(body.position_size);
    if (body.data?.position_size !== undefined) strategyPositionSize = String(body.data.position_size);
    if (body.action) action = String(body.action).toLowerCase();
    if (body.contracts) contracts = String(body.contracts);
    if (body.price) price = String(body.price);
    
    if (body.signalType === 'trade' && body.data) {
      if (body.data.action) action = body.data.action.toLowerCase();
      if (body.data.contracts) contracts = String(body.data.contracts);
      if (body.data.position_size !== undefined) strategyPositionSize = String(body.data.position_size);
    }
  }
  
  if (!action && typeof body === 'object' && body !== null) {
    const message = body.message;
    if (typeof message === 'string') {
      const regex = /order\s+(buy|sell)/i;
      const match = message.match(regex);
      if (match) action = match[1].toLowerCase();
    }
  }
  
  const isCloseSignal = strategyPositionSize !== null && 
    (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
  
  return { action, contracts, isCloseSignal, price, strategyPositionSize };
}

// V3 Phase 3b: Subscriber fan-out now uses the V3 strict-decrypt path on a
// per-subscriber basis. Each subscriber wallet must have executionEnabled and
// a valid stored UMK_STORAGE_SECRET-wrapped UMK (see getUmkForWebhook +
// decryptAgentKeyStrict in session-v3.ts). Subscribers whose execution
// authorization has been revoked, emergency-stopped, or whose strict decrypt
// fails are paused for that signal with a `subscriptionStatusReason` so the UI
// can prompt them to re-enable execution. The subscribe endpoint enforces
// executionEnabled up-front (412), so the steady-state expectation is that
// every active subscriber has a usable V3 key.
// ── Per-bot webhook serialization ─────────────────────────────────────────
// Prevents concurrent partial-close signals from racing each other on the same
// bot-market combination. The promise chain ensures only one webhook handler
// for a given key runs at a time. Keys auto-expire when the handler returns.
const botWebhookLocks = new Map<string, Promise<void>>();

function acquireBotWebhookLock(key: string): Promise<() => void> {
  let release!: () => void;
  const current = botWebhookLocks.get(key) ?? Promise.resolve();
  const next = current.then(() => new Promise<void>(resolve => { release = resolve; }));
  botWebhookLocks.set(key, next.catch(() => {}));
  return next.then(() => release);
}

async function routeSignalToSubscribers(
  sourceBotId: string,
  signal: {
    action: 'buy' | 'sell';
    contracts: string;
    positionSize: string;
    price: string;
    isCloseSignal: boolean;
    strategyPositionSize: string | null;
    /** Fraction of source position closed [0,1]; present for PARTIAL_CLOSE signals. */
    partialCloseFraction?: number;
  }
): Promise<void> {
  try {
    console.log(`[Subscriber Routing] Starting routing for source bot ${sourceBotId}, signal: ${signal.action}, close=${signal.isCloseSignal}`);
    
    const publishedBot = await storage.getPublishedBotByTradingBotId(sourceBotId);
    if (!publishedBot) {
      console.log(`[Subscriber Routing] Source bot ${sourceBotId} is not published - skipping routing`);
      return;
    }
    if (!publishedBot.isActive) {
      console.log(`[Subscriber Routing] Published bot ${publishedBot.id} (${publishedBot.name}) is not active - skipping routing`);
      return;
    }
    console.log(`[Subscriber Routing] Found published bot: ${publishedBot.id} (${publishedBot.name}), active=${publishedBot.isActive}`);

    const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
    if (!subscriberBots || subscriberBots.length === 0) {
      console.log(`[Subscriber Routing] No active subscriber bots found for published bot ${publishedBot.id} - skipping routing`);
      return;
    }

    console.log(`[Subscriber Routing] Routing ${signal.action} (close=${signal.isCloseSignal}) to ${subscriberBots.length} subscribers IN PARALLEL`);

    // Result type for per-subscriber processing - collected and reduced after Promise.all
    type SubscriberResult = 'skippedInactive' | 'skippedFlat' | 'skippedTooSmall' | 'tradeSuccess' | 'tradeFailed' | 'closeSuccess' | 'closeFailed' | 'partialCloseSuccess' | 'partialCloseFailed' | 'error';

    // Process subscriber function - returns result for aggregation after parallel execution
    const processSubscriber = async (subBot: typeof subscriberBots[0]): Promise<SubscriberResult> => {
      console.log(`[Subscriber Routing] Processing subscriber bot ${subBot.id} (${subBot.name}), isActive=${subBot.isActive}, market=${subBot.market}`);
      
      // Allow close signals to route to inactive (paused) bots to prevent orphaned positions
      if (!subBot.isActive && !signal.isCloseSignal) {
        console.log(`[Subscriber Routing] Skipping inactive subscriber bot ${subBot.id} for non-close signal`);
        return 'skippedInactive';
      }

      try {
        const subWallet = await storage.getWallet(subBot.walletAddress);
        console.log(`[Subscriber Routing] Wallet lookup for ${subBot.walletAddress}: found=${!!subWallet}, hasAgentKey=${!!subWallet?.agentPublicKey}`);
        if (!subWallet) {
          // Create failed trade record for visibility
          await storage.createBotTrade({
            tradingBotId: subBot.id,
            walletAddress: subBot.walletAddress,
            market: subBot.market,
            side: signal.action === 'buy' ? 'LONG' : 'SHORT',
            size: '0',
            price: signal.price,
            status: 'failed',
            fee: '0',
            errorMessage: 'Wallet not found in database',
            webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'wallet_not_found' },
            executionMethod: 'legacy',
          });
          return 'tradeFailed';
        }
        // V3 Phase 3b: readiness check is V3-only. We need an agent public key
        // and a V3 envelope; the legacy AGENT_ENCRYPTION_KEY blob is no longer
        // consulted on the fan-out path, so V3-only subscribers must NOT be
        // rejected here. The strict decrypt below is the source of truth.
        if (!subWallet.agentPublicKey || !subWallet.agentPrivateKeyEncryptedV3) {
          await storage.createBotTrade({
            tradingBotId: subBot.id,
            walletAddress: subBot.walletAddress,
            market: subBot.market,
            side: signal.action === 'buy' ? 'LONG' : 'SHORT',
            size: '0',
            price: signal.price,
            status: 'failed',
            fee: '0',
            errorMessage: 'No V3 agent wallet configured for trading',
            webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'no_v3_agent_keys' },
            executionMethod: 'legacy',
          });
          return 'tradeFailed';
        }

        // V3 Phase 3b: strict-decrypt the subscriber's agent key for this
        // signal. If the subscriber has revoked execution / emergency-stopped
        // or no longer has a usable V3 key, pause the subscription with a
        // reason and skip — never fall back to legacy AGENT_ENCRYPTION_KEY.
        const umkResult = await getUmkForWebhook(subBot.walletAddress);
        if (!umkResult) {
          const pauseReason = subWallet.emergencyStopTriggered
            ? 'emergency_stopped'
            : 'execution_disabled';
          await storage.markBotSubscriptionPausedBySubscriberBotId(subBot.id, pauseReason);
          console.warn(`[Subscriber Routing] Subscriber ${subBot.walletAddress.slice(0,8)}... has no UMK (${pauseReason}); subscription paused, signal skipped for bot ${subBot.id}`);
          await storage.createBotTrade({
            tradingBotId: subBot.id,
            walletAddress: subBot.walletAddress,
            market: subBot.market,
            side: signal.action === 'buy' ? 'LONG' : 'SHORT',
            size: '0',
            price: signal.price,
            status: 'failed',
            fee: '0',
            errorMessage: `Subscriber execution authorization unavailable (${pauseReason}). Subscription paused — re-enable execution to resume.`,
            webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: pauseReason },
            executionMethod: 'v3_strict',
          });
          return 'tradeFailed';
        }
        const agentKeyResult = await decryptAgentKeyStrict(
          subBot.walletAddress,
          umkResult.umk,
          subWallet,
          subWallet.agentPublicKey,
        );
        if (!agentKeyResult) {
          umkResult.cleanup();
          await storage.markBotSubscriptionPausedBySubscriberBotId(subBot.id, 'v3_decrypt_failed');
          console.error(`[Subscriber Routing] V3 strict decrypt failed for subscriber ${subBot.walletAddress.slice(0,8)}...; subscription paused, signal skipped for bot ${subBot.id}`);
          await storage.createBotTrade({
            tradingBotId: subBot.id,
            walletAddress: subBot.walletAddress,
            market: subBot.market,
            side: signal.action === 'buy' ? 'LONG' : 'SHORT',
            size: '0',
            price: signal.price,
            status: 'failed',
            fee: '0',
            errorMessage: 'V3 strict decrypt failed for subscriber agent key. Subscription paused.',
            webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'v3_decrypt_failed' },
            executionMethod: 'v3_strict',
          });
          return 'tradeFailed';
        }

        try {
        const subAgentSecretKey = agentKeyResult.secretKey;
        const subAccountId = subBot.driftSubaccountId ?? 0;
        const subCloseCtx = getBotSubaccountContext(subBot);

        if (signal.isCloseSignal) {
          const subCloseQueryAccount = subCloseCtx ? subCloseCtx.botPublicKey : subWallet.agentPublicKey;
          const subCloseQuerySubId = subCloseCtx ? 0 : subAccountId;
          const position = await PositionService.getPositionForExecution(
            subBot.id,
            subCloseQueryAccount,
            subCloseQuerySubId,
            subBot.market,
            subCloseCtx?.botPublicKey
          );

          if (position.side === 'FLAT' || Math.abs(position.size) < 0.0001) {
            return 'skippedFlat';
          }
          
          const subCloseSlippageBps = subWallet.slippageBps ?? 50;
          const closeResult = await closePerpPosition(
            subAgentSecretKey,
            subBot.market,
            subCloseQuerySubId,
            Math.abs(position.size),
            subCloseSlippageBps,
            undefined,
            subWallet.agentPublicKey || undefined,
            position.side === 'LONG' ? 'long' : 'short',
            subCloseCtx,
            subBot.walletAddress,
            getAdapterForBot(subBot),
          );

          if (closeResult.success) {
            const fillPrice = parseFloat(signal.price);
            
            // Estimate fee from notional (closePerpPosition doesn't return actualFee)
            const closeNotional = Math.abs(position.size) * fillPrice;
            const closeFee = closeNotional * getExchangeFeeRate();
            
            // Calculate PnL for subscriber close
            const closeEntryPrice = position.entryPrice || 0;
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && fillPrice > 0) {
              if (position.side === 'LONG') {
                // Closing LONG: profit if exitPrice > entryPrice
                closeTradePnl = (fillPrice - closeEntryPrice) * Math.abs(position.size) - closeFee;
              } else {
                // Closing SHORT: profit if entryPrice > exitPrice
                closeTradePnl = (closeEntryPrice - fillPrice) * Math.abs(position.size) - closeFee;
              }
              console.log(`[Subscriber Routing] PnL calculated for ${subBot.id}: entry=$${closeEntryPrice.toFixed(2)}, exit=$${fillPrice.toFixed(2)}, pnl=$${closeTradePnl.toFixed(4)}`);
            }
            
            const subRouteFillId = DatabaseStorage.canonicalCloseFillId({
              signature: closeResult.signature,
              botId: subBot.id,
              side: 'CLOSE',
              size: Math.abs(position.size).toFixed(8),
              market: subBot.market,
              fillPrice,
              timestampMs: Date.now(),
            });
            await storage.recordCloseEventAtomic({
              botId: subBot.id,
              insert: {
                tradingBotId: subBot.id,
                walletAddress: subBot.walletAddress,
                market: subBot.market,
                side: "CLOSE",
                size: Math.abs(position.size).toFixed(8),
                price: closeResult.fillPrice?.toString() || fillPrice.toFixed(6),
                status: 'executed',
                fee: closeFee.toFixed(6),
                pnl: closeTradePnl.toFixed(6),
                txSignature: closeResult.signature || null,
                protocolFillId: subRouteFillId,
                webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
                executionMethod: closeResult.executionMethod || 'legacy',
              },
              deltas: {
                totalPnlDelta: closeTradePnl,
                totalVolumeDelta: closeNotional,
                lastTradeAt: new Date().toISOString(),
              },
            });

            // PROFIT SHARE: Distribute to creator if subscriber closed with profit
            if (closeTradePnl > 0) {
              const tradeId = `${subBot.id}-${Date.now()}`;
              console.log(`[Subscriber Routing] Initiating profit share for ${subBot.id}: pnl=$${closeTradePnl.toFixed(4)}`);
              // V3 Phase 3b fund-safety: this is fire-and-forget, but the
              // outer try/finally zeros `subAgentSecretKey` as soon as the
              // trade call returns. Hand the profit-share path an isolated
              // copy that it owns and zeros itself in its own finally.
              const profitShareKeyCopy = new Uint8Array(subAgentSecretKey);
              distributeCreatorProfitShare({
                subscriberBotId: subBot.id,
                subscriberWalletAddress: subBot.walletAddress,
                subscriberAgentPublicKey: subWallet.agentPublicKey!,
                subscriberEncryptedPrivateKey: profitShareKeyCopy,
                driftSubaccountId: subAccountId,
                realizedPnl: closeTradePnl,
                tradeId,
              }).then(result => {
                if (result.success && result.amount) {
                  console.log(`[Subscriber Routing] Profit share distributed: $${result.amount.toFixed(4)} from ${subBot.id}`);
                } else if (!result.success && result.error) {
                  console.error(`[Subscriber Routing] Profit share failed for ${subBot.id}: ${result.error}`);
                }
              }).catch(err => console.error(`[Subscriber Routing] Profit share error for ${subBot.id}:`, err))
                .finally(() => { profitShareKeyCopy.fill(0); });
            }

            sendTradeNotification(subWallet.address, {
              type: 'position_closed',
              botName: subBot.name,
              market: subBot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
            
            return 'closeSuccess';
          } else {
            console.error(`[Subscriber Routing] Close failed for subscriber bot ${subBot.id}:`, closeResult.error);
            const closeErrorMsg = parseDriftError(closeResult.error);
            
            const failedCloseTrade = await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: "CLOSE",
              size: Math.abs(position.size).toFixed(8),
              price: signal.price,
              status: 'failed',
              fee: '0',
              errorMessage: closeErrorMsg,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
              executionMethod: 'legacy',
            });

            // V3 Phase 3b: subscriber-fanout transient retries are intentionally
            // DISABLED in this phase. queueTradeRetry persists the agent key in
            // the in-memory retry queue, which today only accepts the legacy
            // encrypted string. Storing another user's plaintext secret in a
            // shared retry queue would defeat V3's per-signal strict-decrypt
            // contract, and the queued job would outlive `agentKeyResult.cleanup`.
            // The transient failure is recorded on the failed_trade row; the
            // retry queue migration is tracked in Phase 4 of the V3 plan.
            if (isTransientError(closeErrorMsg)) {
              console.warn(`[Subscriber Routing] Transient close error for ${subBot.id} NOT auto-retried (subscriber fan-out retry deferred to V3 Phase 4): ${closeErrorMsg}`);
            }

            return 'closeFailed';
          }
        } else if (signal.partialCloseFraction !== undefined && signal.partialCloseFraction > 0) {
          // ── Proportional partial close fan-out ──────────────────────────
          // Close `fraction × subscriber_position_size` contracts (reduce-only).
          const subPartialCtx = subCloseCtx;
          const subPartialQueryAccount = subPartialCtx ? subPartialCtx.botPublicKey : subWallet.agentPublicKey;
          const subPartialQuerySubId = subPartialCtx ? 0 : subAccountId;
          const subPartialPosition = await PositionService.getPositionForExecution(
            subBot.id,
            subPartialQueryAccount,
            subPartialQuerySubId,
            subBot.market,
            subPartialCtx?.botPublicKey
          );

          if (subPartialPosition.side === 'FLAT' || Math.abs(subPartialPosition.size) < 0.0001) {
            console.log(`[Subscriber Routing] Partial close skipped for ${subBot.id} — no position`);
            return 'skippedFlat';
          }

          const subPartialSize = signal.partialCloseFraction * Math.abs(subPartialPosition.size);
          if (subPartialSize < 0.0001) {
            console.log(`[Subscriber Routing] Partial close size too small for ${subBot.id}: ${subPartialSize.toFixed(6)}`);
            return 'skippedTooSmall';
          }

          console.log(`[Subscriber Routing] Partial close for ${subBot.id}: fraction=${(signal.partialCloseFraction * 100).toFixed(1)}%, size=${subPartialSize.toFixed(4)}`);
          const subPartialCloseSlippage = subWallet.slippageBps ?? 50;
          const subPartialResult = await closePerpPosition(
            subAgentSecretKey,
            subBot.market,
            subPartialQuerySubId,
            subPartialSize,
            subPartialCloseSlippage,
            undefined,
            subWallet.agentPublicKey || undefined,
            subPartialPosition.side === 'LONG' ? 'long' : 'short',
            subPartialCtx,
            subBot.walletAddress,
            getAdapterForBot(subBot),
          );

          if (subPartialResult.success) {
            const subPartialFillPrice = subPartialResult.fillPrice ?? parseFloat(signal.price);
            const subPartialEntryPrice = subPartialPosition.entryPrice || 0;
            const subPartialNotional = subPartialSize * subPartialFillPrice;
            const subPartialFee = subPartialNotional * getExchangeFeeRate();
            const subPartialPnl = subPartialPosition.side === 'LONG'
              ? (subPartialFillPrice - subPartialEntryPrice) * subPartialSize - subPartialFee
              : (subPartialEntryPrice - subPartialFillPrice) * subPartialSize - subPartialFee;

            const subPartialDedupKey = DatabaseStorage.canonicalCloseFillId({
              signature: subPartialResult.signature ? `tx-${subPartialResult.signature}` : undefined,
              botId: subBot.id,
              side: subPartialPosition.side === 'LONG' ? 'short' : 'long',
              size: subPartialSize,
              market: subBot.market,
              fillPrice: subPartialFillPrice,
              timestampMs: Date.now(),
            });

            await storage.recordCloseEventAtomic({
              botId: subBot.id,
              insert: {
                tradingBotId: subBot.id,
                walletAddress: subBot.walletAddress,
                market: subBot.market,
                side: subPartialPosition.side === 'LONG' ? 'short' : 'long',
                size: String(subPartialSize),
                price: String(subPartialFillPrice),
                fee: String(subPartialFee),
                pnl: String(subPartialPnl),
                status: 'executed',
                txSignature: subPartialResult.signature || null,
                protocolFillId: subPartialDedupKey,
                webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, partialClose: true, fraction: signal.partialCloseFraction },
                executionMethod: subPartialResult.executionMethod || 'legacy',
              },
              deltas: {
                totalPnlDelta: subPartialPnl,
                totalVolumeDelta: subPartialNotional,
                lastTradeAt: new Date().toISOString(),
              },
            });

            schedulePartialCloseNotification({
              walletAddress: subBot.walletAddress,
              botId: subBot.id,
              botName: subBot.name,
              market: subBot.market,
              side: subPartialPosition.side as 'LONG' | 'SHORT',
              closedFraction: signal.partialCloseFraction,
              realizedPnl: subPartialPnl,
              price: subPartialFillPrice,
            });

            return 'partialCloseSuccess';
          } else {
            console.error(`[Subscriber Routing] Partial close failed for ${subBot.id}: ${subPartialResult.error}`);
            return 'partialCloseFailed';
          }
        } else {
          const oraclePrice = parseFloat(signal.price);
          const maxPos = parseFloat(subBot.maxPositionSize || '0');
          const profitReinvestEnabled = subBot.profitReinvest === true;
          
          // Allow profit reinvest bots to proceed even without maxPositionSize
          if (maxPos <= 0 && !profitReinvestEnabled) {
            
            // Create a failed trade record for visibility
            const oraclePriceForLog = parseFloat(signal.price);
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: signal.action === 'buy' ? 'LONG' : 'SHORT',
              size: '0',
              price: oraclePriceForLog.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: 'Bot has no Max Position Size configured',
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'no_max_position_size' },
              executionMethod: 'legacy',
            });
            return 'tradeFailed';
          }

          // Calculate signal percentage from source signal
          const sourceContracts = parseFloat(signal.contracts);
          const sourcePositionSize = parseFloat(signal.positionSize) || 100;
          const tradePercent = Math.min(sourceContracts / sourcePositionSize, 1);
          const signalPercent = tradePercent * 100; // Convert to 0-100 range

          // Use shared trade sizing helper
          const subBotCtx = getBotSubaccountContext(subBot);
          const sizingResult = await computeTradeSizingAndTopUp({
            agentPublicKey: subWallet.agentPublicKey!,
            agentPrivateKeyEncrypted: subAgentSecretKey,
            subAccountId: subBotCtx ? 0 : subAccountId,
            botId: subBot.id,
            walletAddress: subBot.walletAddress,
            market: subBot.market,
            baseCapital: maxPos,
            leverage: subBot.leverage || 1,
            autoTopUp: subBot.autoTopUp ?? false,
            profitReinvestEnabled,
            signalPercent,
            oraclePrice,
            logPrefix: `[Subscriber Routing] Bot ${subBot.id}`,
            botCtx: subBotCtx,
            adapter: getAdapterForBot(subBot),
          });

          if (!sizingResult.success) {
            
            // Create a failed trade record for visibility
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: signal.action === 'buy' ? 'LONG' : 'SHORT',
              size: '0',
              price: oraclePrice.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: sizingResult.error || 'Trade sizing failed',
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'sizing_failed' },
              executionMethod: 'legacy',
            });
            
            if (sizingResult.shouldPauseBot && sizingResult.pauseReason) {
              await storage.updateTradingBot(subBot.id, { isActive: false, pauseReason: sizingResult.pauseReason } as any);
              console.log(`[Subscriber Routing] Bot ${subBot.id} paused: ${sizingResult.pauseReason}`);
            }
            return 'tradeFailed';
          }

          const contractSize = sizingResult.finalContractSize;

          if (contractSize < 0.001) {
            
            // Create a failed trade record for visibility
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: signal.action === 'buy' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: oraclePrice.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: 'Trade size too small (minimum 0.001 contracts)',
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId, failReason: 'size_too_small' },
              executionMethod: 'legacy',
            });
            return 'tradeFailed';
          }


          // V3 Phase 3b: subscriber agent key is the Uint8Array secret produced
          // by decryptAgentKeyStrict above; the encrypted blob is never used.
          const side = signal.action === 'buy' ? 'long' : 'short';
          const subSlippageBps = subWallet.slippageBps ?? 50;

          // FLIP DETECTION: Snapshot existing position before trade execution
          // If subscriber has an opposite position, this trade will close it (flip)
          // We need to track this to calculate realized PnL and trigger profit sharing
          let preTradePosition: { side: string; size: number; entryPrice: number } | null = null;
          try {
            const subQueryAccount = subBotCtx ? subBotCtx.botPublicKey : subWallet.agentPublicKey!;
            const subQuerySubId = subBotCtx ? 0 : subAccountId;
            const existingPos = await PositionService.getPositionForExecution(
              subBot.id,
              subQueryAccount,
              subQuerySubId,
              subBot.market,
              subBotCtx?.botPublicKey
            );
            if (existingPos.side !== 'FLAT' && Math.abs(existingPos.size) >= 0.0001) {
              const isOpposite = (existingPos.side === 'LONG' && side === 'short') || 
                                 (existingPos.side === 'SHORT' && side === 'long');
              if (isOpposite) {
                preTradePosition = {
                  side: existingPos.side,
                  size: Math.abs(existingPos.size),
                  entryPrice: existingPos.entryPrice || 0,
                };
                console.log(`[Subscriber Routing] FLIP DETECTED for ${subBot.id}: existing ${preTradePosition.side} ${preTradePosition.size} @ $${preTradePosition.entryPrice.toFixed(2)} will be closed by incoming ${side.toUpperCase()}`);
              }
            }
          } catch (err) {
            console.error(`[Subscriber Routing] Pre-trade position check failed for ${subBot.id}:`, err);
          }

          const orderResult = await executePerpOrder(
            subAgentSecretKey,
            subBot.market,
            side,
            contractSize,
            subBotCtx ? 0 : subAccountId,
            false,
            subSlippageBps,
            undefined,
            subWallet.agentPublicKey || undefined,
            subBot.leverage || 1,
            subBotCtx,
            subBot.walletAddress,
            getAdapterForBot(subBot),
          );

          if (orderResult.success) {
            let fillPrice = orderResult.fillPrice ?? oraclePrice;

            const tradeNotional = contractSize * fillPrice;
            const tradeFee = orderResult.actualFee ?? (tradeNotional * getExchangeFeeRate());
            
            const subTrade = await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: fillPrice.toFixed(6),
              status: 'executed',
              fee: tradeFee.toFixed(6),
              txSignature: orderResult.txSignature || orderResult.signature || null,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
              executionMethod: orderResult.executionMethod || 'legacy',
              swiftOrderId: orderResult.swiftOrderId || null,
            });

            const syncResult = await syncPositionFromOnChain(
              subBot.id,
              subBot.walletAddress,
              subWallet.agentPublicKey!,
              subAccountId,
              subBot.market,
              subTrade.id,
              tradeFee,
              fillPrice,
              side,
              contractSize,
              subBotCtx?.botPublicKey
            );

            if (syncResult?.onChainEntryPrice && syncResult.onChainEntryPrice > 0 && Math.abs(syncResult.onChainEntryPrice - fillPrice) > 0.001) {
              console.log(`[Subscriber Routing] Updating fill price for ${subBot.id}: oracle=$${fillPrice.toFixed(6)} -> on-chain=$${syncResult.onChainEntryPrice.toFixed(6)}`);
              fillPrice = syncResult.onChainEntryPrice;
              const tradeUpdate: Record<string, string> = {
                price: fillPrice.toFixed(6),
              };
              if (!orderResult.actualFee) {
                const updatedNotional = contractSize * fillPrice;
                tradeUpdate.fee = (updatedNotional * getExchangeFeeRate()).toFixed(6);
              }
              await storage.updateBotTrade(subTrade.id, tradeUpdate);
            }

            // FLIP PROFIT SHARE: If a flip occurred, calculate realized PnL from closing the old position
            // The closed portion is the minimum of pre-trade position size and new order size
            // (handles both full flips and partial reduces that flip direction)
            let flipPnl: number = 0;
            if (preTradePosition && preTradePosition.entryPrice > 0) {
              const closedSize = Math.min(preTradePosition.size, contractSize);
              const closedEntryPrice = preTradePosition.entryPrice;
              const exitPrice = fillPrice;
              // Fee on the close leg only (proportional to closed size, not full order)
              const closeFee = closedSize * exitPrice * getExchangeFeeRate();
              
              if (preTradePosition.side === 'LONG') {
                flipPnl = (exitPrice - closedEntryPrice) * closedSize - closeFee;
              } else {
                flipPnl = (closedEntryPrice - exitPrice) * closedSize - closeFee;
              }
              
              console.log(`[Subscriber Routing] Flip PnL for ${subBot.id}: closed ${preTradePosition.side} ${closedSize}/${preTradePosition.size} @ entry=$${closedEntryPrice.toFixed(2)}, exit=$${exitPrice.toFixed(2)}, pnl=$${flipPnl.toFixed(4)}`);
              
              // Update the trade record with realized PnL from the flip (always
              // record a number — '0' for breakeven, never null — so the
              // canonical SQL count picks it up).
              await storage.updateBotTrade(subTrade.id, {
                pnl: flipPnl.toFixed(6),
              });
              
              // Trigger profit sharing if the flip realized a profit
              if (flipPnl > 0) {
                const flipTradeId = `${subBot.id}-flip-${Date.now()}`;
                console.log(`[Subscriber Routing] Initiating profit share for FLIP on ${subBot.id}: pnl=$${flipPnl.toFixed(4)}`);
                // V3 Phase 3b fund-safety: see close-path note above — hand
                // the profit-share an isolated key copy so the outer finally
                // doesn't zeroize the buffer mid-settlement.
                const flipProfitShareKeyCopy = new Uint8Array(subAgentSecretKey);
                distributeCreatorProfitShare({
                  subscriberBotId: subBot.id,
                  subscriberWalletAddress: subBot.walletAddress,
                  subscriberAgentPublicKey: subWallet.agentPublicKey!,
                  subscriberEncryptedPrivateKey: flipProfitShareKeyCopy,
                  driftSubaccountId: subAccountId,
                  realizedPnl: flipPnl,
                  tradeId: flipTradeId,
                }).then(result => {
                  if (result.success && result.amount) {
                    console.log(`[Subscriber Routing] Flip profit share distributed: $${result.amount.toFixed(4)} from ${subBot.id}`);
                  } else if (!result.success && result.error) {
                    console.error(`[Subscriber Routing] Flip profit share failed for ${subBot.id}: ${result.error}`);
                  }
                }).catch(err => console.error(`[Subscriber Routing] Flip profit share error for ${subBot.id}:`, err))
                  .finally(() => { flipProfitShareKeyCopy.fill(0); });
              }
            }

            // Open + (optional) flip-close; counters come from canonical SQL.
            await storage.recomputeAndMergeBotStats(subBot.id, {
              totalPnlDelta: flipPnl,
              totalVolumeDelta: contractSize * fillPrice,
              lastTradeAt: new Date().toISOString(),
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_executed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * fillPrice,
              price: fillPrice,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
            
            return 'tradeSuccess';
          } else {
            console.error(`[Subscriber Routing] Order failed for subscriber bot ${subBot.id}:`, orderResult.error);
            const errorMsg = parseDriftError(orderResult.error);
            
            const failedTrade = await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: oraclePrice.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: errorMsg,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
              executionMethod: 'legacy',
            });

            // V3 Phase 3b: subscriber-fanout transient retries are intentionally
            // DISABLED in this phase. See close-path note above; the retry
            // queue migration is tracked in Phase 4 of the V3 plan.
            if (isTransientError(errorMsg)) {
              console.warn(`[Subscriber Routing] Transient order error for ${subBot.id} NOT auto-retried (subscriber fan-out retry deferred to V3 Phase 4): ${errorMsg}`);
            }

            sendTradeNotification(subWallet.address, {
              type: 'trade_failed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * oraclePrice,
              price: oraclePrice,
              error: errorMsg,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
            
            return 'tradeFailed';
          }
        }
        // Should never reach here, but return error just in case
        return 'error';
        } finally {
          // V3 Phase 3b: always zero out the per-signal subscriber agent key
          // and the UMK regardless of trade outcome.
          agentKeyResult.cleanup();
          umkResult.cleanup();
        }
      } catch (subError) {
        console.error(`[Subscriber Routing] Error processing subscriber bot ${subBot.id}:`, subError);
        return 'error';
      }
    };

    const SUBSCRIBER_STAGGER_MS = 2000;
    const startTime = Date.now();
    const results: SubscriberResult[] = [];

    console.log(`[Subscriber Routing] Processing ${subscriberBots.length} subscribers SEQUENTIALLY with ${SUBSCRIBER_STAGGER_MS}ms stagger to prevent RPC contention`);

    for (let i = 0; i < subscriberBots.length; i++) {
      const subBot = subscriberBots[i];
      if (i > 0) {
        console.log(`[Subscriber Routing] Stagger delay ${SUBSCRIBER_STAGGER_MS}ms before subscriber ${i + 1}/${subscriberBots.length} (${subBot.id})`);
        await new Promise(resolve => setTimeout(resolve, SUBSCRIBER_STAGGER_MS));
      }
      const result = await processSubscriber(subBot);
      results.push(result);
    }

    const elapsed = Date.now() - startTime;

    const outcomes = results.reduce((acc, result) => {
      if (result === 'skippedInactive') acc.skippedInactive++;
      else if (result === 'skippedFlat') acc.skippedFlat++;
      else if (result === 'tradeSuccess') acc.tradeSuccess++;
      else if (result === 'tradeFailed') acc.tradeFailed++;
      else if (result === 'closeSuccess') acc.closeSuccess++;
      else if (result === 'closeFailed') acc.closeFailed++;
      else if (result === 'error') acc.errors++;
      return acc;
    }, { skippedInactive: 0, skippedFlat: 0, tradeSuccess: 0, tradeFailed: 0, closeSuccess: 0, closeFailed: 0, errors: 0 });

    const total = subscriberBots.length;
    const processed = outcomes.tradeSuccess + outcomes.tradeFailed + outcomes.closeSuccess + outcomes.closeFailed;
    console.log(`[Subscriber Routing] SUMMARY for source ${sourceBotId}: ${total} subscribers processed in ${elapsed}ms (SEQUENTIAL, ${SUBSCRIBER_STAGGER_MS}ms stagger), ${outcomes.skippedInactive} skipped (inactive), ${outcomes.skippedFlat} skipped (flat), ${outcomes.tradeSuccess} trades OK, ${outcomes.tradeFailed} trades FAILED, ${outcomes.closeSuccess} closes OK, ${outcomes.closeFailed} closes FAILED, ${outcomes.errors} errors`);

      // Store routing audit trail in webhook log for visibility
      try {
        const routingSummary = {
          publishedBotId: publishedBot.id,
          publishedBotName: publishedBot.name,
          subscriberCount: subscriberBots.length,
          results: { success: results.filter(r => r === 'tradeSuccess' || r === 'closeSuccess').length, failed: results.filter(r => r === 'tradeFailed' || r === 'closeFailed').length, skipped: results.filter(r => r === 'skippedInactive' || r === 'skippedFlat').length, errors: results.filter(r => r === 'error').length },
          timestamp: new Date().toISOString(),
        };
        console.log(`[Subscriber Routing] AUDIT: ${JSON.stringify(routingSummary)}`);
      } catch (auditErr) {
        console.error(`[Subscriber Routing] Failed to log audit trail:`, auditErr);
      }
  } catch (error) {
    console.error('[Subscriber Routing] Error:', error);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Trust proxy for secure cookies behind Replit's reverse proxy
  if (process.env.NODE_ENV === "production") {
    app.set('trust proxy', 1);
  }

  const { sessionMiddleware } = await import("./session");
  app.use(sessionMiddleware);

  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const requireWallet = (req: any, res: any, next: any) => {
    const headerWallet = req.query.wallet || req.body.walletAddress || req.headers['x-wallet-address'];
    const sessionWallet = req.session?.walletAddress;
    
    // Debug logging for close-position requests
    if (req.path.includes('close-position')) {
      console.log(`[requireWallet] close-position request - sessionWallet: ${sessionWallet}, headerWallet: ${headerWallet}`);
    }
    
    if (!sessionWallet) {
      console.log(`[requireWallet] Rejecting - no session wallet for ${req.method} ${req.path}`);
      return res.status(401).json({ error: "Wallet not connected - please connect your wallet first" });
    }
    
    if (headerWallet && sessionWallet !== headerWallet) {
      console.log(`[requireWallet] Rejecting - wallet mismatch for ${req.method} ${req.path}: session=${sessionWallet}, header=${headerWallet}`);
      return res.status(403).json({ error: "Wallet mismatch - please reconnect wallet" });
    }
    
    req.walletAddress = sessionWallet;
    next();
  };

  // Helper to generate a unique referral code
  const generateReferralCode = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  async function verifySolanaSignature(message: string, signature: Uint8Array, publicKey: string): Promise<boolean> {
    try {
      const messageBytes = new TextEncoder().encode(message);
      const pubkeyBytes = bs58.decode(publicKey);
      return nacl.sign.detached.verify(messageBytes, signature, pubkeyBytes);
    } catch {
      return false;
    }
  }

  // Start analytics indexer for platform metrics
  startAnalyticsIndexer();
  
  // Register routing callback for trade retry service
  // This allows successful retries to route signals to subscribers
  registerRoutingCallback(routeSignalToSubscribers);

  app.get("/llms.txt", (_req, res) => {
    const llmsTxt = `# QuantumVault
> Automated perpetual futures trading on Solana via Drift Protocol.

URL: https://myquantumvault.com
Full Documentation: https://myquantumvault.com/api/docs

QuantumVault connects TradingView alerts and AI trading agents to Drift Protocol for automated perpetual futures trading on Solana. Features include webhook-based trade execution, automated capital management (profit reinvest, auto withdraw, auto top-up), copy trading marketplace, Swift gasless execution, and bank-grade wallet security.

## Docs
- [Full Documentation (Markdown)](https://myquantumvault.com/api/docs)
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(llmsTxt);
  });

  app.get("/api/docs", (_req, res) => {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(DOCS_MARKDOWN);
  });

  // Public API: Portfolio aggregation (no auth required) - powers SonarWatch
  // QuantumVault plugin for jup.ag/portfolio. Returns portfolio-safe fields
  // only; rate-limited per IP and per wallet, with a 30s response cache.
  app.get("/api/public/portfolio", publicPortfolioHandler);

  // Public TVL endpoint — consumed by DeFiLlama's adapter.
  // Returns the sum of the most recent portfolio snapshot per wallet
  // (deployed Pacifica capital + uninvested agent wallet balance).
  // No auth, rate-limited naturally by DeFiLlama polling cadence (~5 min).
  app.get("/api/tvl", async (_req, res) => {
    try {
      const metrics = await getMetrics();
      // DeFiLlama expects: { [tokenSymbol_or_coingeckoId]: usdAmount }
      // Our TVL is USDC-denominated so we return the USDC coingecko id.
      res.json({
        usd_coin: metrics.tvl,
      });
    } catch (error) {
      console.error("[TVL] Error:", error);
      res.status(500).json({ error: "Failed to fetch TVL" });
    }
  });

  // Public API: Platform metrics (no auth required) - for landing page
  app.get("/api/metrics", async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      let metrics;
      
      if (forceRefresh) {
        const { calculateAndStoreMetrics } = await import("./analytics-indexer");
        metrics = await calculateAndStoreMetrics();
      } else {
        metrics = await getMetrics();
      }
      
      res.json({
        tvl: metrics.tvl,
        totalVolume: metrics.totalVolume,
        volume24h: metrics.volume24h,
        volume7d: metrics.volume7d,
        activeBots: metrics.activeBots,
        activeUsers: metrics.activeUsers,
        totalTrades: metrics.totalTrades,
        lastUpdated: metrics.lastUpdated.toISOString(),
      });
    } catch (error) {
      console.error("[Metrics] Error fetching platform metrics:", error);
      res.status(500).json({ error: "Failed to fetch platform metrics" });
    }
  });

  // Public API: Historical metrics for charts (no auth required)
  app.get("/api/metrics/history", async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      
      const tvlHistory = await storage.getPlatformMetricHistory('tvl', since, 100);
      const volumeHistory = await storage.getPlatformMetricHistory('total_volume', since, 100);
      
      res.json({
        tvl: tvlHistory.map(m => ({
          timestamp: m.calculatedAt.toISOString(),
          value: parseFloat(m.value),
        })),
        volume: volumeHistory.map(m => ({
          timestamp: m.calculatedAt.toISOString(),
          value: parseFloat(m.value),
        })),
      });
    } catch (error) {
      console.error("[Metrics] Error fetching metrics history:", error);
      res.status(500).json({ error: "Failed to fetch metrics history" });
    }
  });

  app.post("/api/auth/nonce", async (req, res) => {
    try {
      const { walletAddress, purpose } = req.body;
      if (!walletAddress || !purpose) {
        return res.status(400).json({ error: "Wallet address and purpose required" });
      }

      const validPurposes = ['unlock_umk', 'authorize_trade', 'enable_execution', 'revoke_execution', 'reveal_mnemonic'];
      if (!validPurposes.includes(purpose)) {
        return res.status(400).json({ error: "Invalid purpose" });
      }

      const { nonce, message } = await createSigningNonce(walletAddress, purpose);
      res.json({ nonce, message });
    } catch (error) {
      console.error("Nonce creation error:", error);
      res.status(500).json({ error: "Failed to create nonce" });
    }
  });

  app.post("/api/auth/verify", async (req, res) => {
    try {
      const { walletAddress, nonce, signature, purpose } = req.body;
      if (!walletAddress || !nonce || !signature || !purpose) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = Uint8Array.from(
        typeof signature === 'string' ? bs58.decode(signature) : signature
      );

      const result = await verifySignatureAndConsumeNonce(
        walletAddress,
        nonce,
        purpose,
        signatureBytes,
        verifySolanaSignature
      );

      if (!result.success) {
        return res.status(401).json({ error: result.error });
      }

      if (purpose === 'unlock_umk') {
        const initResult = await initializeWalletSecurity(walletAddress, signatureBytes);
        req.session.walletAddress = walletAddress;
        
        // Create agent wallet with mnemonic if one doesn't exist yet
        let wallet = await storage.getWallet(walletAddress);
        if (wallet && !wallet.agentPublicKey) {
          const session = getSession(initResult.sessionId);
          if (session) {
            const generatedWallet = generateAgentWalletWithMnemonic();
            const agentPublicKey = generatedWallet.keypair.publicKey.toString();

            // V3 Phase 5b: encrypt the private key with v3 (UMK-based) only. The
            // legacy `agent_private_key_encrypted` column is intentionally left
            // NULL for new wallets — Phase 6 will drop it entirely.
            const encryptedV3 = encryptAgentKeyV3(session.umk, generatedWallet.secretKeyBuffer, walletAddress);

            // Store the mnemonic encrypted with UMK
            await encryptAndStoreMnemonic(walletAddress, generatedWallet.mnemonicBuffer, session.umk);

            // Persist the agent public key and V3 ciphertext only.
            await storage.updateWallet(walletAddress, { agentPublicKey });
            await storage.updateWalletAgentKeyV3(walletAddress, encryptedV3);

            console.log(`[Agent] Generated new agent wallet with mnemonic for ${walletAddress}: ${agentPublicKey}`);
          }
        }
        
        return res.json({ 
          success: true, 
          sessionId: initResult.sessionId,
          isNewWallet: initResult.isNewWallet 
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Signature verification error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.get("/api/auth/session", requireWallet, async (req, res) => {
    try {
      const result = getSessionByWalletAddress(req.walletAddress!);
      if (!result) {
        return res.json({
          hasSession: false,
          sessionMissing: true,
          sessionId: null,
          walletAddress: req.walletAddress,
          message: 'Session expired. Please reconnect your wallet.',
        });
      }
      res.json({
        hasSession: true,
        sessionMissing: false,
        sessionId: result.sessionId,
        walletAddress: result.session.walletAddress,
      });
    } catch (error) {
      console.error("Session check error:", error);
      res.status(500).json({ error: "Session check failed" });
    }
  });

  // Public endpoint to check if a wallet has an active session (no auth required)
  // Used by frontend to skip signature prompt if already authenticated
  app.post("/api/auth/status", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      
      // Check if this wallet has an active session in express-session
      const sessionWallet = req.session?.walletAddress;
      const hasSession = sessionWallet === walletAddress;
      
      res.json({
        authenticated: hasSession,
        walletAddress: hasSession ? sessionWallet : null,
      });
    } catch (error) {
      console.error("Auth status check error:", error);
      res.status(500).json({ error: "Status check failed" });
    }
  });

  app.post("/api/auth/logout", requireWallet, async (req, res) => {
    try {
      invalidateSession(req.walletAddress!);
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
        }
        res.json({ success: true });
      });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ error: "Logout failed" });
    }
  });

  app.post("/api/auth/reveal-mnemonic", requireWallet, async (req, res) => {
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        return res.status(400).json({ error: "Session ID, nonce, and signature required" });
      }

      const signatureBytes = Uint8Array.from(
        typeof signature === 'string' ? bs58.decode(signature) : signature
      );

      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'reveal_mnemonic',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        return res.status(401).json({ error: sigResult.error });
      }

      const result = await revealMnemonic(req.walletAddress!, sessionId);
      
      if (!result.success) {
        const status = 'retryAfterMs' in result && result.retryAfterMs ? 429 : 400;
        return res.status(status).json({
          error: result.error,
          retryAfterMs: 'retryAfterMs' in result ? result.retryAfterMs : undefined,
        });
      }
      
      res.json({
        mnemonic: result.mnemonic,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error("Mnemonic reveal error:", error);
      res.status(500).json({ error: "Failed to reveal recovery phrase" });
    }
  });

  // Enable execution - allows headless trade execution via webhooks
  app.post("/api/auth/enable-execution", requireWallet, async (req, res) => {
    console.log(`[Enable Execution] Request received for wallet ${req.walletAddress?.slice(0, 8)}...`);
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        console.log(`[Enable Execution] Missing fields - sessionId: ${!!sessionId}, nonce: ${!!nonce}, signature: ${!!signature}`);
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = typeof signature === 'string' 
        ? bs58.decode(signature) 
        : new Uint8Array(Object.values(signature));

      console.log(`[Enable Execution] Verifying signature for nonce: ${nonce.slice(0, 8)}...`);
      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'enable_execution',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        console.log(`[Enable Execution] Signature verification failed: ${sigResult.error}`);
        return res.status(401).json({ error: sigResult.error });
      }

      console.log(`[Enable Execution] Signature verified, calling enableExecution with sessionId: ${sessionId.slice(0, 8)}...`);
      const result = await enableExecution(sessionId, req.walletAddress!);
      
      if (!result.success) {
        console.log(`[Enable Execution] enableExecution failed: ${result.error}`);
        return res.status(400).json({ error: result.error });
      }
      
      console.log(`[Enable Execution] Success for wallet ${req.walletAddress?.slice(0, 8)}...`);
      res.json({
        success: true,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error("[Enable Execution] Error:", error);
      res.status(500).json({ error: "Failed to enable execution" });
    }
  });

  // Revoke execution - disables headless trade execution
  app.post("/api/auth/revoke-execution", requireWallet, async (req, res) => {
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = typeof signature === 'string' 
        ? bs58.decode(signature) 
        : new Uint8Array(Object.values(signature));

      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'revoke_execution',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        return res.status(401).json({ error: sigResult.error });
      }

      const result = await revokeExecution(sessionId, req.walletAddress!);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Revoke execution error:", error);
      res.status(500).json({ error: "Failed to revoke execution" });
    }
  });

  // Get execution status
  app.get("/api/auth/execution-status", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      const isExpired = wallet.executionExpiresAt && new Date() > wallet.executionExpiresAt;
      
      res.json({
        executionEnabled: wallet.executionEnabled && !isExpired,
        executionExpiresAt: wallet.executionExpiresAt,
        emergencyStopTriggered: wallet.emergencyStopTriggered,
        emergencyStopAt: wallet.emergencyStopAt,
      });
    } catch (error) {
      console.error("Execution status error:", error);
      res.status(500).json({ error: "Failed to get execution status" });
    }
  });

  setInterval(() => {
    cleanupExpiredNonces().catch(console.error);
  }, 60 * 1000);

  // Emergency admin stop - immediately disables all execution for a wallet
  // Requires ADMIN_SECRET environment variable for authorization
  app.post("/api/admin/emergency-stop", async (req, res) => {
    try {
      const adminSecret = process.env.ADMIN_SECRET;
      if (!adminSecret) {
        console.error("[Emergency Stop] ADMIN_SECRET not configured");
        return res.status(503).json({ error: "Admin operations not configured" });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Admin authorization required" });
      }

      const providedSecret = authHeader.slice(7);
      if (providedSecret !== adminSecret) {
        console.warn("[Emergency Stop] Invalid admin secret attempted");
        return res.status(403).json({ error: "Invalid admin authorization" });
      }

      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Use fixed admin ID for audit trail - adminId is not client-supplied to prevent spoofing
      const adminId = "platform_admin";
      const requestIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      
      const result = await emergencyStopWallet(walletAddress, adminId);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }

      console.log(`[Emergency Stop] Admin triggered emergency stop for wallet ${walletAddress.slice(0, 8)}... from IP: ${requestIp}`);
      
      res.json({ 
        success: true, 
        message: "Emergency stop activated. All execution disabled for this wallet." 
      });
    } catch (error) {
      console.error("Emergency stop error:", error);
      res.status(500).json({ error: "Failed to trigger emergency stop" });
    }
  });

  // Update policy HMAC for a bot (requires active session)
  app.post("/api/trading-bots/:id/update-policy-hmac", requireWallet, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Active session required" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const policyHmac = computeBotPolicyHmac(
        session.umk,
        { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize }
      );

      await storage.updateTradingBot(bot.id, { policyHmac } as any);

      res.json({ success: true, policyHmac });
    } catch (error) {
      console.error("Update policy HMAC error:", error);
      res.status(500).json({ error: "Failed to update policy HMAC" });
    }
  });

  // Update policy HMAC for all user's bots (requires active session)
  app.post("/api/trading-bots/update-all-policy-hmacs", requireWallet, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Active session required" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }

      const bots = await storage.getTradingBots(req.walletAddress!);
      let updated = 0;

      for (const bot of bots) {
        const policyHmac = computeBotPolicyHmac(
          session.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize }
        );
        await storage.updateTradingBot(bot.id, { policyHmac } as any);
        updated++;
      }

      res.json({ success: true, updatedCount: updated });
    } catch (error) {
      console.error("Update all policy HMACs error:", error);
      res.status(500).json({ error: "Failed to update policy HMACs" });
    }
  });

  // Wallet auth routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const { walletAddress, referredByCode } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const isNewWallet = !(await storage.getWallet(walletAddress));
      let wallet = await storage.getOrCreateWallet(walletAddress);
      
      // Agent wallet is now created in /api/auth/verify after security initialization
      // This ensures the mnemonic can be encrypted with the UMK

      // Generate user webhook secret if not already set
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(walletAddress, userWebhookSecret);
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Webhook] Generated user webhook secret for ${walletAddress}`);
      }

      // Generate referral code if not already set
      if (!wallet.referralCode) {
        let referralCode = generateReferralCode();
        let attempts = 0;
        while (attempts < 10) {
          const existing = await storage.getWalletByReferralCode(referralCode);
          if (!existing) break;
          referralCode = generateReferralCode();
          attempts++;
        }
        await storage.updateWallet(walletAddress, { referralCode });
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Referral] Generated referral code for ${walletAddress}: ${referralCode}`);
      }

      // Track referral if this is a new wallet and referral code was provided
      if (isNewWallet && referredByCode && !wallet.referredBy) {
        const referrer = await storage.getWalletByReferralCode(referredByCode);
        if (referrer && referrer.address !== walletAddress) {
          const written = await writeReferralChain(walletAddress, referrer.address);
          if (written) {
            await storage.updateWallet(walletAddress, { referredBy: referrer.address });
            wallet = (await storage.getWallet(walletAddress))!;
            console.log(`[Referral] ${walletAddress} was referred by ${referrer.address} (code: ${referredByCode})`);
          }
        }
      }
      
      req.session.walletAddress = walletAddress;

      res.json({
        address: wallet.address,
        displayName: wallet.displayName,
        driftSubaccount: wallet.driftSubaccount,
        agentPublicKey: wallet.agentPublicKey,
        referralCode: wallet.referralCode,
      });
    } catch (error) {
      console.error("Wallet connect error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // MLM Referrals: overview for the authenticated wallet
  app.get("/api/referrals/overview", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      const [earnings, l1Descendants] = await Promise.all([
        storage.getReferralEarnings(walletAddress),
        storage.getReferralDescendantsByLevel(walletAddress, 1),
      ]);

      // Per-referee earnings (sum across all levels for this earner & referee) — single grouped query
      const earningsByReferee = await storage.getReferralEarningsByReferee(
        walletAddress,
        l1Descendants.map((d) => d.descendantWallet),
      );
      const directReferrals = l1Descendants.map((d) => ({
        wallet: d.descendantWallet,
        joinedAt: d.createdAt.toISOString(),
        totalEarned: earningsByReferee.get(d.descendantWallet) ?? 0,
      }));

      let referredBy: { wallet: string; joinedAt: string } | null = null;
      if (wallet.referredBy) {
        const ownChain = await storage.getReferralChain(walletAddress);
        const l1 = ownChain.find(l => l.level === 1);
        referredBy = {
          wallet: wallet.referredBy,
          joinedAt: (l1?.createdAt ?? wallet.createdAt).toISOString(),
        };
      }

      res.json({
        myReferralCode: wallet.referralCode ?? null,
        referredBy,
        directReferrals,
        earningsByLevel: earnings,
        levelPercents: REFERRAL_LEVEL_PERCENTS,
      });
    } catch (error) {
      console.error("Get referrals overview error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/me", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json(wallet);
    } catch (error) {
      console.error("Get wallet error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        dailySummaryEnabled: wallet.dailySummaryEnabled ?? false,
        telegramConnected: wallet.telegramConnected ?? false,
        referralCode: wallet.referralCode,
        referredBy: wallet.referredBy,
      });
    } catch (error) {
      console.error("Get wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const { displayName, xUsername, defaultLeverage, slippageBps, notificationsEnabled, notifyTradeExecuted, notifyTradeFailed, notifyPositionClosed, dailySummaryEnabled } = req.body;
      
      const updates: any = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (xUsername !== undefined) updates.xUsername = xUsername;
      if (defaultLeverage !== undefined) {
        const leverage = parseInt(defaultLeverage);
        if (isNaN(leverage) || leverage < 1 || leverage > 20) {
          return res.status(400).json({ error: "Invalid leverage (must be 1-20)" });
        }
        updates.defaultLeverage = leverage;
      }
      if (slippageBps !== undefined) {
        const slippage = parseInt(slippageBps);
        if (isNaN(slippage) || slippage < 1 || slippage > 500) {
          return res.status(400).json({ error: "Invalid slippage (must be 1-500 bps)" });
        }
        updates.slippageBps = slippage;
      }
      if (notificationsEnabled !== undefined) updates.notificationsEnabled = !!notificationsEnabled;
      if (notifyTradeExecuted !== undefined) updates.notifyTradeExecuted = !!notifyTradeExecuted;
      if (notifyTradeFailed !== undefined) updates.notifyTradeFailed = !!notifyTradeFailed;
      if (notifyPositionClosed !== undefined) updates.notifyPositionClosed = !!notifyPositionClosed;
      if (dailySummaryEnabled !== undefined) updates.dailySummaryEnabled = !!dailySummaryEnabled;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }

      const wallet = await storage.updateWallet(req.walletAddress!, updates);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        dailySummaryEnabled: wallet.dailySummaryEnabled ?? false,
        telegramConnected: wallet.telegramConnected ?? false,
      });
    } catch (error) {
      console.error("Update wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Personal API tokens (for AI agents like Claude/MCP, n8n, scripts).
  // Tokens grant access only to the QuantumLab endpoints (read + create
  // backtests, list strategies/results). They never authorize on-chain
  // trading or wallet key operations — those still require an active
  // user session.
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/agent-tokens", requireWallet, async (req, res) => {
    try {
      const rows = await db.select({
        id: userApiTokens.id,
        name: userApiTokens.name,
        tokenPrefix: userApiTokens.tokenPrefix,
        scopes: userApiTokens.scopes,
        lastUsedAt: userApiTokens.lastUsedAt,
        createdAt: userApiTokens.createdAt,
      }).from(userApiTokens).where(eq(userApiTokens.walletAddress, req.walletAddress!)).orderBy(desc(userApiTokens.createdAt));
      res.json(rows);
    } catch (error) {
      console.error("List agent tokens error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent-tokens", requireWallet, async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim().slice(0, 60) || "API Token";
      // Generate token: qv_<32 bytes base64url> = ~46 chars total.
      const raw = crypto.randomBytes(32).toString("base64url");
      const token = `qv_${raw}`;
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const tokenPrefix = token.slice(0, 11); // "qv_" + 8 chars
      const wallet = req.walletAddress!;
      // Atomically enforce the 10-tokens-per-wallet cap. Use a per-wallet
      // advisory lock inside a transaction so concurrent POSTs from the same
      // wallet serialize and cannot race past the cap.
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${wallet}))`);
        const existing = await tx.select({ id: userApiTokens.id }).from(userApiTokens).where(eq(userApiTokens.walletAddress, wallet));
        if (existing.length >= 10) {
          const err: any = new Error("TOKEN_LIMIT");
          err.code = "TOKEN_LIMIT";
          throw err;
        }
        const [row] = await tx.insert(userApiTokens).values({
          walletAddress: wallet,
          name,
          tokenPrefix,
          tokenHash,
        }).returning({
          id: userApiTokens.id,
          name: userApiTokens.name,
          tokenPrefix: userApiTokens.tokenPrefix,
          createdAt: userApiTokens.createdAt,
        });
        return row;
      });
      // Return the full token ONCE — never retrievable again.
      res.json({ ...created, token });
    } catch (error: any) {
      if (error?.code === "TOKEN_LIMIT") {
        return res.status(400).json({ error: "Token limit reached (10). Revoke an unused token first." });
      }
      console.error("Create agent token error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/agent-tokens/:id", requireWallet, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid token id" });
      const result = await db.delete(userApiTokens).where(and(eq(userApiTokens.id, id), eq(userApiTokens.walletAddress, req.walletAddress!))).returning({ id: userApiTokens.id });
      if (result.length === 0) return res.status(404).json({ error: "Token not found" });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete agent token error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/wallet/reset-account", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentKey = agentKeyResult.secretKey;
      const agentPubKey = wallet.agentPublicKey;
      const log = (msg: string) => console.log(`[Reset Account] ${msg}`);
      const progress: string[] = [];

      log(`Starting automated account reset for ${agentPubKey}`);
      progress.push("Starting reset process...");

      // 1. Discover all existing subaccounts on-chain
      const existingSubaccounts = await discoverOnChainSubaccounts(agentPubKey);
      if (existingSubaccounts.length === 0) {
        return res.json({ 
          success: true, 
          message: "No trading accounts found",
          progress: ["No trading accounts to reset"]
        });
      }

      log(`Found ${existingSubaccounts.length} subaccounts: [${existingSubaccounts.join(', ')}]`);
      progress.push(`Found ${existingSubaccounts.length} subaccount(s)`);

      // Sort: process higher subaccounts first, subaccount 0 last
      const sortedSubaccounts = [...existingSubaccounts].sort((a, b) => b - a);
      const deletedSubaccounts: number[] = [];
      const errors: string[] = [];
      let totalSwept = 0;

      // 2. For each subaccount: close positions, sweep funds to subaccount 0
      for (const subId of sortedSubaccounts) {
        if (subId === 0) continue; // Handle subaccount 0 separately at the end

        log(`Processing subaccount ${subId}...`);
        
        try {
          // 2a. Close all open positions in this subaccount
          const positions = await getPerpPositions(agentPubKey, subId);
          const openPositions = positions.filter((p: any) => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in subaccount ${subId}`);
            progress.push(`Closing ${openPositions.length} position(s) in bot subaccount ${subId}...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, subId, Math.abs(pos.baseAssetAmount), 50, undefined, agentPubKey, pos.side === 'LONG' ? 'long' : 'short');
                if (closeResult.success) {
                  log(`Closed ${pos.market} position in subaccount ${subId}: ${closeResult.signature}`);
                } else {
                  log(`Failed to close ${pos.market}: ${closeResult.error}`);
                  errors.push(`Failed to close ${pos.market} in subaccount ${subId}: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                log(`Error closing ${pos.market}: ${e.message}`);
                errors.push(`Error closing ${pos.market} in subaccount ${subId}: ${e.message}`);
              }
            }
            
            // Wait for positions to settle
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 2b. Settle any unrealized PnL to make it sweepable
          log(`Settling PnL for subaccount ${subId}...`);
          try {
            const settleResult = await settleAllPnl(agentKey, subId);
            if (settleResult.success) {
              log(`Settled PnL for subaccount ${subId}`);
            } else {
              log(`No PnL to settle for subaccount ${subId}: ${settleResult.error || 'none'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (settleErr: any) {
            log(`PnL settlement error (non-fatal): ${settleErr.message}`);
          }

          // 2c. Get balance and sweep to subaccount 0
          const accountInfo = await getExchangeAccountInfo(agentPubKey, subId);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.001) {
            log(`Sweeping $${balance.toFixed(2)} from subaccount ${subId} to main account`);
            progress.push(`Sweeping $${balance.toFixed(2)} from subaccount ${subId}...`);
            
            try {
              const transferResult = await executeAgentTransferBetweenSubaccounts(agentPubKey, agentKey, subId, 0, balance);
              if (transferResult.success) {
                totalSwept += balance;
                log(`Swept $${balance.toFixed(2)} to subaccount 0: ${transferResult.signature}`);
              } else {
                log(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
                errors.push(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (e: any) {
              log(`Error sweeping from subaccount ${subId}: ${e.message}`);
              errors.push(`Error sweeping from subaccount ${subId}: ${e.message}`);
            }
          }

          // 2d. Verify subaccount is empty before deletion
          const verifyInfo = await getExchangeAccountInfo(agentPubKey, subId);
          if (verifyInfo.hasOpenPositions || verifyInfo.usdcBalance > 0.001 || verifyInfo.totalCollateral > 0.001) {
            log(`Subaccount ${subId} still has funds or positions, skipping deletion`);
            errors.push(`Subaccount ${subId} still has funds ($${verifyInfo.usdcBalance.toFixed(2)}) or positions - cannot delete`);
            continue; // Skip deletion, move to next subaccount
          }

          // 2e. Delete the subaccount (only if verified empty)
          log(`Deleting subaccount ${subId}...`);
          const deleteResult = await closeDriftSubaccount(agentKey, subId);
          if (deleteResult.success) {
            deletedSubaccounts.push(subId);
            log(`Deleted subaccount ${subId}: ${deleteResult.signature}`);
            progress.push(`Deleted subaccount ${subId}`);
          } else {
            log(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
            errors.push(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          
        } catch (e: any) {
          log(`Error processing subaccount ${subId}: ${e.message}`);
          errors.push(`Error processing subaccount ${subId}: ${e.message}`);
        }
      }

      // 3. Handle subaccount 0 (main account)
      if (existingSubaccounts.includes(0)) {
        log(`Processing main account (subaccount 0)...`);
        
        try {
          // 3a. Close any positions in subaccount 0
          const positions = await getPerpPositions(agentPubKey, 0);
          const openPositions = positions.filter((p: any) => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in main account`);
            progress.push(`Closing ${openPositions.length} position(s) in main account...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, 0, Math.abs(pos.baseAssetAmount), 50, undefined, agentPubKey, pos.side === 'LONG' ? 'long' : 'short');
                if (closeResult.success) {
                  log(`Closed ${pos.market} in main account: ${closeResult.signature}`);
                } else {
                  errors.push(`Failed to close ${pos.market} in main account: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                errors.push(`Error closing ${pos.market} in main account: ${e.message}`);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 3b. Settle any unrealized PnL for main account
          log(`Settling PnL for main account...`);
          try {
            const settleResult = await settleAllPnl(agentKey, 0);
            if (settleResult.success) {
              log(`Settled PnL for main account`);
            } else {
              log(`No PnL to settle for main account: ${settleResult.error || 'none'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (settleErr: any) {
            log(`PnL settlement error (non-fatal): ${settleErr.message}`);
          }

          // 3c. Withdraw all funds from Drift to agent wallet
          const accountInfo = await getExchangeAccountInfo(agentPubKey, 0);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.001) {
            log(`Withdrawing $${balance.toFixed(2)} from Drift to agent wallet`);
            progress.push(`Withdrawing $${balance.toFixed(2)} to agent wallet...`);
            
            try {
              const withdrawResult = await executeAgentDriftWithdraw(agentPubKey, agentKey, balance, 0);
              if (withdrawResult.success) {
                log(`Withdrawn $${balance.toFixed(2)}: ${withdrawResult.signature}`);
              } else {
                log(`Failed to withdraw: ${withdrawResult.error}`);
                errors.push(`Failed to withdraw from Drift: ${withdrawResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (e: any) {
              log(`Error withdrawing: ${e.message}`);
              errors.push(`Error withdrawing from Drift: ${e.message}`);
            }
          }

          // 3d. Note: Main account (subaccount 0) cannot be deleted because it was created with a referral code.
          // Drift protocol prevents deletion of referred accounts. The ~0.035 SOL rent is forfeited,
          // but the account can be reused for future trading without needing to recreate it.
          log(`Main account (subaccount 0) kept active - referred accounts cannot be deleted by Drift protocol rules`);
          progress.push(`Main Drift account preserved (can be reused for trading)`);
          
        } catch (e: any) {
          log(`Error processing main account: ${e.message}`);
          errors.push(`Error processing main account: ${e.message}`);
        }
      }

      // 4. Check results and determine response
      if (errors.length > 0 && deletedSubaccounts.length === 0) {
        progress.push("Reset failed - see errors for details");
        return res.status(400).json({
          success: false,
          message: "Reset failed - could not delete any accounts. Your funds are safe, please try again or close positions manually.",
          progress,
          errors
        });
      }

      if (errors.length > 0) {
        // Partial success - only clear assignments for bots whose subaccounts were actually deleted
        const bots = await storage.getTradingBots(req.walletAddress!);
        for (const bot of bots) {
          if (bot.driftSubaccountId !== null && deletedSubaccounts.includes(bot.driftSubaccountId)) {
            await storage.clearTradingBotSubaccount(bot.id);
            log(`Cleared driftSubaccountId for bot ${bot.id} (subaccount ${bot.driftSubaccountId} was deleted)`);
          }
        }
        
        progress.push(`Partially completed with ${errors.length} issue(s)`);
        return res.status(207).json({
          success: false,
          partialSuccess: true,
          message: `Partial reset: Deleted ${deletedSubaccounts.length} subaccount(s) but some operations failed. Check the errors and try again if needed.`,
          progress,
          deletedSubaccounts,
          totalSwept,
          errors
        });
      }

      // Full success - clear all bot subaccount assignments
      const bots = await storage.getTradingBots(req.walletAddress!);
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          await storage.clearTradingBotSubaccount(bot.id);
          log(`Cleared driftSubaccountId for bot ${bot.id}`);
        }
      }

      progress.push("Reset complete!");
      log(`Successfully reset Drift account. Deleted ${deletedSubaccounts.length} subaccounts, swept $${totalSwept.toFixed(2)}`);
      
      res.json({
        success: true,
        message: `Successfully reset trading account. Deleted ${deletedSubaccounts.length} subaccount(s).`,
        progress,
        deletedSubaccounts,
        totalSwept
      });

      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error: any) {
      console.error("Reset Drift account error:", error);
      res.status(500).json({ error: error.message || "Failed to reset trading account" });
    }
  });

  const pendingBindChallenges = new Map<string, { timestamp: number; expiryWindow: number; createdAt: number }>();
  const BIND_CHALLENGE_TTL_MS = 60_000;
  const MAX_BIND_CHALLENGES = 100;

  app.post("/api/agent/prepare-bind", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      const adapter = getDefaultAdapter();
      if (typeof adapter.prepareBindMessage !== 'function') {
        return res.status(501).json({ error: "Protocol does not support agent binding" });
      }
      const { message, timestamp, expiryWindow } = adapter.prepareBindMessage!(
        req.walletAddress!,
        wallet.agentPublicKey,
      );
      if (pendingBindChallenges.size >= MAX_BIND_CHALLENGES) {
        const now = Date.now();
        for (const [k, v] of pendingBindChallenges) {
          if (now - v.createdAt > BIND_CHALLENGE_TTL_MS) pendingBindChallenges.delete(k);
        }
      }
      pendingBindChallenges.set(req.walletAddress!, { timestamp, expiryWindow, createdAt: Date.now() });
      res.json({ message, timestamp, expiryWindow, agentPublicKey: wallet.agentPublicKey });
    } catch (error: any) {
      console.error("[AgentBind] prepare-bind error:", error);
      res.status(500).json({ error: error.message || "Failed to prepare bind" });
    }
  });

  app.post("/api/agent/confirm-bind", requireWallet, async (req, res) => {
    try {
      const { signature } = req.body;
      if (!signature || typeof signature !== 'string') {
        return res.status(400).json({ error: "Missing or invalid signature" });
      }
      const challenge = pendingBindChallenges.get(req.walletAddress!);
      if (!challenge) {
        return res.status(400).json({ error: "No pending bind challenge — call prepare-bind first" });
      }
      if (Date.now() - challenge.createdAt > BIND_CHALLENGE_TTL_MS) {
        pendingBindChallenges.delete(req.walletAddress!);
        return res.status(400).json({ error: "Bind challenge expired — call prepare-bind again" });
      }
      pendingBindChallenges.delete(req.walletAddress!);
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      const adapter = getDefaultAdapter();
      if (typeof adapter.confirmBind !== 'function') {
        return res.status(501).json({ error: "Protocol does not support agent binding" });
      }
      await adapter.confirmBind!(
        req.walletAddress!,
        wallet.agentPublicKey,
        signature,
        challenge.timestamp,
        challenge.expiryWindow,
      );
      res.json({ success: true });
    } catch (error: any) {
      console.error("[AgentBind] confirm-bind error:", error);
      res.status(500).json({ error: error.message || "Failed to bind agent wallet" });
    }
  });

  // Reset Agent Wallet - Withdraw all funds to user wallet and generate a new agent wallet
  app.post("/api/wallet/reset-agent-wallet", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID required for security verification" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }
      if (!session.umk) {
        return res.status(401).json({ error: "Security session not initialized. Please reconnect your wallet." });
      }

      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, session.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentPubKey = wallet.agentPublicKey;
      const agentKey = agentKeyResult.secretKey;
      const userWallet = req.walletAddress!;
      const log = (msg: string) => console.log(`[Reset Agent] ${msg}`);
      const progress: string[] = [];

      log(`Starting agent wallet reset for ${agentPubKey.slice(0, 8)}...`);
      progress.push("Checking Drift account status...");

      // Step 1: Check if there are any Drift subaccounts with positions or funds
      const existingSubaccounts = await discoverOnChainSubaccounts(agentPubKey);
      
      for (const subId of existingSubaccounts) {
        const positions = await getPerpPositions(agentPubKey, subId);
        const openPositions = positions.filter((p: any) => Math.abs(p.baseAssetAmount) > 0.0001);
        
        if (openPositions.length > 0) {
          return res.status(400).json({ 
            error: "Cannot reset: You have open positions. Please close all positions first using 'Close All Positions' or 'Reset Trading Account'.",
            hasOpenPositions: true 
          });
        }

        const accountInfo = await getExchangeAccountInfo(agentPubKey, subId);
        if (accountInfo.usdcBalance > 0.01) {
          return res.status(400).json({ 
            error: `Cannot reset: You have $${accountInfo.usdcBalance.toFixed(2)} in trading subaccount ${subId}. Please use 'Reset Trading Account' to withdraw funds first.`,
            hasDriftFunds: true 
          });
        }
      }

      progress.push("Drift account verified clean");
      log("Drift account is clean, proceeding with agent wallet reset");

      // Step 2: Check agent wallet balances
      const usdcBalance = await getAgentUsdcBalance(agentPubKey);
      const solBalance = await getAgentSolBalance(agentPubKey);
      
      log(`Agent wallet balances: ${usdcBalance} USDC, ${solBalance} SOL`);
      progress.push(`Found ${usdcBalance.toFixed(2)} USDC, ${solBalance.toFixed(4)} SOL in agent wallet`);

      // Step 3: Withdraw USDC to user wallet
      if (usdcBalance > 0.001) {
        progress.push(`Withdrawing ${usdcBalance.toFixed(2)} USDC to your wallet...`);
        log(`Withdrawing ${usdcBalance} USDC to ${userWallet.slice(0, 8)}...`);
        
        try {
          const usdcWithdrawResult = await executeAgentWithdraw(agentPubKey, agentKey, userWallet, usdcBalance);
          if (!usdcWithdrawResult.success) {
            return res.status(400).json({ 
              error: `USDC withdrawal failed: ${usdcWithdrawResult.error}. Your funds are safe, please try again.`,
              step: 'usdc_withdrawal' 
            });
          }
          log(`USDC withdrawal successful: ${usdcWithdrawResult.signature}`);
          progress.push(`USDC withdrawn successfully`);
          
          // Wait for confirmation
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e: any) {
          return res.status(400).json({ 
            error: `USDC withdrawal error: ${e.message}. Your funds are safe, please try again.`,
            step: 'usdc_withdrawal' 
          });
        }
      }

      // Step 4: Withdraw SOL to user wallet (leave minimum for rent-exempt)
      const solToWithdraw = solBalance - 0.002; // Leave 0.002 SOL for final transaction fees
      if (solToWithdraw > 0.001) {
        progress.push(`Withdrawing ${solToWithdraw.toFixed(4)} SOL to your wallet...`);
        log(`Withdrawing ${solToWithdraw} SOL to ${userWallet.slice(0, 8)}...`);
        
        try {
          const solWithdrawResult = await executeAgentSolWithdraw(agentPubKey, agentKey, userWallet, solToWithdraw);
          if (!solWithdrawResult.success) {
            log(`SOL withdrawal failed (non-critical): ${solWithdrawResult.error}`);
            progress.push(`SOL withdrawal failed (non-critical): Small amount may remain`);
          } else {
            log(`SOL withdrawal successful: ${solWithdrawResult.signature}`);
            progress.push(`SOL withdrawn successfully`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e: any) {
          log(`SOL withdrawal error (non-critical): ${e.message}`);
          progress.push(`SOL withdrawal error (non-critical): Small amount may remain`);
        }
      }

      // Step 5: Generate new agent wallet with mnemonic
      progress.push("Generating new agent wallet...");
      log("Generating new agent wallet with mnemonic");

      const generatedWallet = generateAgentWalletWithMnemonic();
      const newAgentPublicKey = generatedWallet.keypair.publicKey.toString();

      // V3 Phase 5b: encrypt with v3 (UMK-based) only. The legacy
      // `agent_private_key_encrypted` column is intentionally left NULL for
      // newly-generated wallets — Phase 6 will drop it entirely.
      const encryptedV3 = encryptAgentKeyV3(session.umk, generatedWallet.secretKeyBuffer, userWallet);

      // Store mnemonic encrypted with UMK
      await encryptAndStoreMnemonic(userWallet, generatedWallet.mnemonicBuffer, session.umk);

      // Update database with new agent wallet (public key + V3 ciphertext only).
      await storage.updateWallet(userWallet, { agentPublicKey: newAgentPublicKey });
      await storage.updateWalletAgentKeyV3(userWallet, encryptedV3);
      
      log(`New agent wallet generated: ${newAgentPublicKey.slice(0, 8)}...`);
      progress.push(`New agent wallet created: ${newAgentPublicKey.slice(0, 8)}...`);

      // Step 6: Clear all bot subaccount assignments (they're linked to old wallet)
      const bots = await storage.getTradingBots(userWallet);
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          await storage.clearTradingBotSubaccount(bot.id);
          log(`Cleared driftSubaccountId for bot ${bot.id}`);
        }
      }

      progress.push("Agent wallet reset complete!");
      log(`Successfully reset agent wallet. Old: ${agentPubKey.slice(0, 8)}..., New: ${newAgentPublicKey.slice(0, 8)}...`);

      res.json({
        success: true,
        message: "Agent wallet has been reset. A new wallet has been generated.",
        oldAgentWallet: agentPubKey,
        newAgentWallet: newAgentPublicKey,
        progress,
        withdrawnUsdc: usdcBalance,
        withdrawnSol: solToWithdraw > 0.001 ? solToWithdraw : 0
      });

      } finally {
        agentKeyResult.cleanup();
      }
    } catch (error: any) {
      console.error("Reset agent wallet error:", error);
      res.status(500).json({ error: error.message || "Failed to reset agent wallet" });
    }
  });

  app.post("/api/close-all-positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const bots = await storage.getTradingBots(req.walletAddress!);
      const activeBots = bots.filter(b => b.isActive);

      const results: Array<{
        botId: string;
        botName: string;
        market: string;
        success: boolean;
        closed?: { side: string; size: number };
        error?: string;
      }> = [];

      for (const bot of activeBots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        
        try {
          const onChainPositions = await getPerpPositions(wallet.agentPublicKey, subAccountId, null, getAdapterForBot(bot));
          const position = onChainPositions.find((p: any) => p.market === bot.market);
          
          if (!position || Math.abs(position.baseAssetAmount) < 0.0001) {
            continue;
          }

          const closeAllSlippageBps = wallet.slippageBps ?? 50;
          const result = await closePerpPosition(
            agentSecret,
            bot.market,
            subAccountId,
            Math.abs(position.baseAssetAmount),
            closeAllSlippageBps,
            undefined,
            wallet.agentPublicKey || undefined,
            position.side === 'LONG' ? 'long' : 'short',
            undefined,
            undefined,
            getAdapterForBot(bot),
          );

          if (result.success) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: true,
              closed: { side: position.side, size: Math.abs(position.baseAssetAmount) },
            });
          } else {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: false,
              error: result.error || "Unknown error",
            });
          }
        } catch (error: any) {
          results.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            success: false,
            error: error.message || "Unknown error",
          });
        }
      }

      res.json({
        success: true,
        totalBotsChecked: activeBots.length,
        positionsClosed: results.filter(r => r.success).length,
        results,
      });
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Close all positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/capital", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      const wallet = await storage.getWallet(walletAddress);
      const agentAddress = wallet?.agentPublicKey;
      
      const exchangeAccountInfo = agentAddress ? await getExchangeAccountInfo(agentAddress, 0) : { totalCollateral: 0 };
      const exchangeBalance = exchangeAccountInfo.totalCollateral;
      
      const bots = await storage.getTradingBots(walletAddress);
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) { /* prices unavailable */ }
      
      const botAllocations: Array<{
        botId: string;
        botName: string;
        subaccountId: number;
        balance: number;
      }> = [];
      
      let allocatedToBot = 0;
      
      for (const bot of bots) {
        let botBalance = 0;
        try {
          const capBotCtx = getBotSubaccountContext(bot);
          if (capBotCtx) {
            const liveInfo = await getExchangeAccountInfoForBot('', 0, capBotCtx, getAdapterForBot(bot));
            botBalance = liveInfo.totalCollateral;
          } else {
          const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
          const netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
          const position = await storage.getBotPosition(bot.id, bot.market);
          const realizedPnl = parseFloat(position?.realizedPnl || '0');
          const totalFees = parseFloat(position?.totalFees || '0');
          
          let unrealizedPnl = 0;
          if (position) {
            const baseSize = parseFloat(position.baseSize);
            const entryPrice = parseFloat(position.avgEntryPrice);
            const markPrice = prices[position.market] || entryPrice;
            if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
              unrealizedPnl = baseSize > 0
                ? (markPrice - entryPrice) * Math.abs(baseSize)
                : (entryPrice - markPrice) * Math.abs(baseSize);
            }
          }
          
          botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
          }
        } catch (err) {
          console.warn(`[capital] Failed to calc bot balance for ${bot.id}:`, err);
        }
        
        allocatedToBot += botBalance;
        botAllocations.push({
          botId: bot.id,
          botName: bot.name,
          subaccountId: bot.driftSubaccountId ?? 0,
          balance: botBalance,
        });
      }
      
      const mainAccountBalance = Math.max(0, exchangeBalance - allocatedToBot);
      const totalEquity = exchangeBalance;
      
      res.json({
        mainAccountBalance,
        allocatedToBot,
        totalEquity,
        botAllocations,
      });
    } catch (error) {
      console.error("Get capital pool error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Agent wallet routes
  app.get("/api/agent/balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const [balance, solBalance, bots, exchangeAccountExists] = await Promise.all([
        getAgentUsdcBalance(wallet.agentPublicKey),
        getAgentSolBalance(wallet.agentPublicKey),
        storage.getTradingBots(req.walletAddress!),
        subaccountExists(wallet.agentPublicKey, 0),
      ]);
      
      // Existing user = has completed onboarding at some point.
      // Using bot count alone is wrong — a user who deposited funds and enabled execution
      // but hasn't created a bot yet is still an existing user and should not see the
      // new-user welcome popup again.
      const isExistingUser = wallet.executionEnabled || bots.length > 0 || balance > 0;
      
      const TRADING_GAS = 0.005;
      const requiredSolForBot = TRADING_GAS;
      
      const solDeficit = Math.max(0, requiredSolForBot - solBalance);
      const canCreateBot = solBalance >= requiredSolForBot;
      
      res.json({
        agentPublicKey: wallet.agentPublicKey,
        balance,
        solBalance,
        isExistingUser,
        exchangeAccountExists,
        botCreationSolRequirement: {
          required: requiredSolForBot,
          current: solBalance,
          deficit: solDeficit,
          canCreate: canCreateBot,
        },
      });
    } catch (error) {
      console.error("Get agent balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit-sol", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildSolTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build SOL deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
        const txData = await buildWithdrawFromAgentTransaction(
          req.walletAddress!,
          wallet.agentPublicKey,
          agentKeyResult.secretKey,
          amount
        );

        res.json(txData);
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Build agent withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/exchange/deposit", requireWallet, async (req, res) => {
    try {
      const { amount, botId } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      let tradingBotId: string | null = null;
      let subAccountId = 0;
      let botForTransfer: TradingBot | null = null;
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        const depositHasAnyKey = !!(bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted);
        if (
          bot.subaccountAuthMode === 'external_key' &&
          bot.subaccountStatus === 'active' &&
          bot.protocolSubaccountId &&
          depositHasAnyKey
        ) {
          subAccountId = 0;
          botForTransfer = bot;
          console.log(`[Deposit] Bot ${bot.name} uses external_key auth (subaccount ${bot.protocolSubaccountId}), depositing to agent main then transferring`);
        } else if (bot.subaccountAuthMode === 'external_key') {
          // Invariant violation: mode says external_key but required fields are missing/inactive.
          // Fail fast rather than silently fall through to legacy Drift path (would misroute funds).
          const detail = `subaccountAuthMode=external_key but status=${bot.subaccountStatus}, hasProtocolSubaccountId=${!!bot.protocolSubaccountId}, hasKey=${depositHasAnyKey}`;
          console.error(`[Deposit][INTEGRITY] Bot ${bot.id}: ${detail}`);
          return res.status(409).json({
            code: 'BOT_SUBACCOUNT_INTEGRITY_ERROR',
            error: `Bot ${bot.id} integrity error: ${detail}`,
          });
        } else {
          subAccountId = bot.driftSubaccountId ?? 0;
          console.log(`[Deposit] Bot ${bot.name} using main_plus_id auth, subAccountId=${subAccountId}`);
        }
      } else {
        console.log(`[Deposit] No botId provided, depositing to main account (subaccount 0)`);
      }

      // Security v3: Get UMK and decrypt agent key (same path as webhooks)
      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(403).json({ 
          error: "Execution not enabled. Please enable execution authorization in Settings first." 
        });
      }

      // Self-heal step (separate from strict decrypt to preserve the strict
      // helper's "V3 only, never legacy" contract): probe the stored V3
      // ciphertext; if it was encrypted under a different UMK (the UMK-init
      // race damage mode), re-migrate from the legacy ciphertext using the
      // current UMK before the strict decrypt below. Emits a dedicated
      // [StaleV3SelfHeal] telemetry log that audits can count separately.
      const repairResult = await repairStaleV3AgentKeyFromLegacy(req.walletAddress!, umkResult.umk);
      let walletForDecrypt = wallet;
      if (repairResult === 'repaired') {
        const refreshed = await storage.getWallet(req.walletAddress!);
        if (refreshed) walletForDecrypt = refreshed;
      }

      const agentKeyResult = await decryptAgentKeyStrict(
        req.walletAddress!,
        umkResult.umk,
        walletForDecrypt,
        walletForDecrypt.agentPublicKey
      );
      
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet or sign in again." });
      }
      
      // CRITICAL: Copy secret key bytes immediately to prevent buffer zeroization issues
      // The cleanup() function will zero the original buffer, so we must copy before any async operations
      const secretKeyCopy = Buffer.from(agentKeyResult.secretKey);
      
      // DEBUG: Check if secretKey has valid data
      const nonZeroBytes = secretKeyCopy.filter(b => b !== 0).length;
      console.log(`[Drift Deposit] Secret key stats: length=${secretKeyCopy.length}, nonZeroBytes=${nonZeroBytes}`);
      
      if (nonZeroBytes === 0) {
        console.error(`[Drift Deposit] CRITICAL: Decrypted key is all zeros! This indicates a decryption failure.`);
        agentKeyResult.cleanup();
        return res.status(500).json({ 
          error: "Decryption failed - key data is corrupted. Please reconfigure your agent wallet in Settings." 
        });
      }
      
      const privateKeyBase58 = bs58.encode(secretKeyCopy);
      console.log(`[Drift Deposit] Base58 key length: ${privateKeyBase58.length} chars`);
      
      // Validate the decrypted key matches stored agentPublicKey before sending to executor
      // This catches key mismatches early with clear error messages
      const decryptedKeypair = nacl.sign.keyPair.fromSecretKey(secretKeyCopy);
      const derivedPubkey = bs58.encode(decryptedKeypair.publicKey);
      
      if (derivedPubkey !== wallet.agentPublicKey) {
        console.error(`[Drift Deposit] CRITICAL: Keypair mismatch detected!`);
        console.error(`  Stored agentPublicKey: ${wallet.agentPublicKey}`);
        console.error(`  Derived from decrypted key: ${derivedPubkey}`);
        console.error(`  Wallet has v3 key: ${!!wallet.agentPrivateKeyEncryptedV3}`);
        agentKeyResult.cleanup();
        return res.status(500).json({ 
          error: "Agent key mismatch detected. Your agent wallet security may be corrupted. Please reconfigure your agent wallet in Settings." 
        });
      }
      
      console.log(`[Drift Deposit] Key validation passed. Executing deposit: amount=${amount}, subAccountId=${subAccountId} (v3 security)`);
      
      const result = await executeAgentDeposit(
        wallet.agentPublicKey,
        secretKeyCopy,
        amount,
        subAccountId,
        botForTransfer ? getAdapterForBot(botForTransfer) : getDefaultAdapter(),
      );
      
      agentKeyResult.cleanup();

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Deposit failed" });
      }

      let subaccountTransferSuccess = true;
      if (botForTransfer) {
        try {
          const adapter = getAdapterForBot(botForTransfer);
          const agentKeypair = Keypair.fromSecretKey(secretKeyCopy);

          console.log(`[Deposit] Waiting for exchange deposit to settle before transferring to bot subaccount...`);
          await new Promise(resolve => setTimeout(resolve, 5000));

          let transferSuccess = false;
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              console.log(`[Deposit] Transfer attempt ${attempt}/5: ${amount} USDC agent→${botForTransfer.protocolSubaccountId}`);
              const transferResult = await adapter.transferBetweenSubaccounts({
                agentSecretKey: agentKeypair.secretKey,
                mainWalletAddress: agentKeypair.publicKey.toString(),
                fromSubaccountId: agentKeypair.publicKey.toString(),
                toSubaccountId: botForTransfer.protocolSubaccountId!,
                amount,
              });

              if (transferResult.success) {
                console.log(`[Deposit] Successfully transferred ${amount} USDC to bot subaccount ${botForTransfer.protocolSubaccountId}`);
                transferSuccess = true;
                break;
              } else {
                console.warn(`[Deposit] Transfer attempt ${attempt} failed: ${transferResult.error}`);
              }
            } catch (attemptErr: any) {
              console.warn(`[Deposit] Transfer attempt ${attempt} error: ${attemptErr.message}`);
            }

            if (attempt < 5) {
              const delay = attempt <= 2 ? 5000 : 10000;
              console.log(`[Deposit] Waiting ${delay / 1000}s before retry (deposit may still be settling)...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }

          if (!transferSuccess) {
            subaccountTransferSuccess = false;
            console.error(`[Deposit] All transfer attempts failed. Funds remain in agent main account.`);
          }
        } catch (transferErr: any) {
          subaccountTransferSuccess = false;
          console.error(`[Deposit] Transfer to bot subaccount error: ${transferErr.message}. Funds remain in agent main account.`);
        }
      }

      const depositNotes = botForTransfer
        ? (subaccountTransferSuccess ? `Deposit to bot subaccount ${botForTransfer.protocolSubaccountId}` : `Deposit to agent main (subaccount transfer failed)`)
        : (tradingBotId ? `Deposit to bot` : 'Deposit to exchange');

      try {
        await storage.createEquityEvent({
          walletAddress: req.walletAddress!,
          tradingBotId: tradingBotId || null,
          eventType: 'drift_deposit',
          amount: String(amount),
          txSignature: result.signature || null,
          notes: depositNotes,
        });
      } catch (eventErr: any) {
        console.error(`[Deposit] Equity event recording failed:`, eventErr.message);
        if (result.signature) {
          const existing = await storage.getEquityEventByTxSignature(result.signature);
          if (!existing) {
            try {
              await storage.createEquityEvent({
                walletAddress: req.walletAddress!,
                tradingBotId: tradingBotId || null,
                eventType: 'drift_deposit',
                amount: String(amount),
                txSignature: result.signature,
                notes: `${depositNotes} (recovered)`,
              });
            } catch (retryErr: any) {
              console.error(`[Deposit] Equity event retry also failed:`, retryErr.message);
            }
          }
        }
      }

      res.json({
        ...result,
        subaccountTransferSuccess: botForTransfer ? subaccountTransferSuccess : undefined,
        subaccountTransferWarning: botForTransfer && !subaccountTransferSuccess
          ? 'Exchange deposit succeeded but transfer to bot subaccount failed. Funds are in your agent wallet.'
          : undefined,
      });
    } catch (error) {
      console.error("Agent drift deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/exchange/withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, botId } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      // If botId provided, verify ownership and get subaccount
      let tradingBotId: string | null = null;
      let subAccountId = 0; // Default to main account
      let withdrawRoutedAdapter = getDefaultAdapter();
      // Each exchange enforces its own minimum on money movements. For a main-account
      // withdrawal (no bot) gate on the default exchange; a bot withdrawal is gated on
      // the bot's own adapter below, once its protocol is known. Reject up-front so the
      // user gets a clear message instead of a cryptic protocol failure.
      if (!botId && amount < withdrawRoutedAdapter.minTransferAmount) {
        return res.status(400).json({ error: `${withdrawRoutedAdapter.protocolName} minimum transfer is $${withdrawRoutedAdapter.minTransferAmount}` });
      }
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        withdrawRoutedAdapter = getAdapterForBot(bot);
        // Gate on the bot's own protocol minimum before any IOU payout below.
        if (amount < withdrawRoutedAdapter.minTransferAmount) {
          return res.status(400).json({ error: `${withdrawRoutedAdapter.protocolName} minimum transfer is $${withdrawRoutedAdapter.minTransferAmount}` });
        }
        // Use bot's specific subaccount, not the main account
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          subAccountId = bot.driftSubaccountId;
        }
        
        // Check for pending profit share IOUs before allowing withdrawal
        const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(botId);
        if (pendingIOUs.length > 0) {
          const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
          console.log(`[Drift Withdraw] Bot ${botId} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
          
          // Try to pay IOUs first
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              agentSecret,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[Drift Withdraw] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[Drift Withdraw] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              // Check if it's SOL starvation
              if (transferResult.error?.includes('Insufficient SOL')) {
                return res.status(400).json({
                  error: `Cannot withdraw - pending creator profit share of $${totalOwed.toFixed(2)} cannot be paid. Agent wallet needs more SOL for transaction fees (current: ${transferResult.solBalance?.toFixed(4) || '0'} SOL)`,
                  pendingIOUs: pendingIOUs.length,
                  totalOwed
                });
              }
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot withdraw - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please ensure your agent wallet has enough USDC to cover these payments.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        }
      }

      let withdrawFromMain = false;
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        const withdrawBotCtx = bot ? getBotSubaccountContext(bot) : null;
        if (withdrawBotCtx && bot) {
          try {
            const adapter = getAdapterForBot(bot);
            const decrypted = await _resolveBotSubaccountSecretKey(withdrawBotCtx);
            try {
              console.log(`[Withdraw] Transferring ${amount} USDC from bot subaccount ${withdrawBotCtx.botPublicKey} to agent wallet`);
              const transferResult = await adapter.transferBetweenSubaccounts({
                agentSecretKey: decrypted.secretKey,
                mainWalletAddress: wallet.agentPublicKey,
                fromSubaccountId: withdrawBotCtx.botPublicKey,
                toSubaccountId: wallet.agentPublicKey,
                amount,
              });

              if (!transferResult.success) {
                return res.status(400).json({ error: `Failed to transfer from bot subaccount: ${transferResult.error}` });
              }
              console.log(`[Withdraw] Successfully transferred ${amount} USDC from bot subaccount to agent wallet`);
              withdrawFromMain = true;
            } finally {
              decrypted.cleanup();
            }
          } catch (transferErr: any) {
            return res.status(500).json({ error: `Subaccount transfer failed: ${transferErr.message}` });
          }
        } else if (bot?.subaccountAuthMode === 'external_key') {
          // Invariant violation: mode says external_key but required fields are missing/inactive.
          // Fail fast rather than silently fall through to legacy Drift withdraw path.
          const hasAnyKey = !!(bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted);
          const detail = `subaccountAuthMode=external_key but status=${bot.subaccountStatus}, hasProtocolSubaccountId=${!!bot.protocolSubaccountId}, hasKey=${hasAnyKey}`;
          console.error(`[Withdraw][INTEGRITY] Bot ${bot.id}: ${detail}`);
          return res.status(409).json({
            code: 'BOT_SUBACCOUNT_INTEGRITY_ERROR',
            error: `Bot ${bot.id} integrity error: ${detail}`,
          });
        }
      }

      const result = await executeAgentDriftWithdraw(
        wallet.agentPublicKey,
        agentSecret,
        amount,
        withdrawFromMain ? 0 : subAccountId,
        { tradingBotId, context: 'Withdraw' },
        withdrawRoutedAdapter
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Withdraw failed" });
      }

      try {
        await storage.createEquityEvent({
          walletAddress: req.walletAddress!,
          tradingBotId,
          eventType: 'drift_withdraw',
          amount: String(-amount),
          txSignature: result.signature || null,
          notes: tradingBotId ? `Withdraw from bot` : 'Withdraw from Drift Protocol',
        });
      } catch (eventErr: any) {
        console.error(`[Drift Withdraw] CRITICAL: On-chain withdraw succeeded (tx: ${result.signature}) but equity event recording failed:`, eventErr.message);
        console.error(`[Drift Withdraw] Untracked withdraw: wallet=${req.walletAddress}, botId=${tradingBotId}, amount=${amount}, subAccount=${subAccountId}`);
        if (result.signature) {
          const existing = await storage.getEquityEventByTxSignature(result.signature);
          if (!existing) {
            try {
              await storage.createEquityEvent({
                walletAddress: req.walletAddress!,
                tradingBotId,
                eventType: 'drift_withdraw',
                amount: String(-amount),
                txSignature: result.signature,
                notes: tradingBotId ? `Withdraw from bot (recovered)` : 'Withdraw from Drift Protocol (recovered)',
              });
              console.log(`[Drift Withdraw] Equity event retry succeeded`);
            } catch (retryErr: any) {
              console.error(`[Drift Withdraw] Equity event retry also failed:`, retryErr.message);
            }
          } else {
            console.log(`[Drift Withdraw] Event already recorded for tx ${result.signature}, skipping retry`);
          }
        }
      }

      res.json(result);
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Agent drift withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/exchange/balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const accountInfo = await getExchangeAccountInfo(wallet.agentPublicKey, 0);
      res.json({ 
        balance: accountInfo.usdcBalance,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        marginUsed: accountInfo.marginUsed,
      });
    } catch (error) {
      console.error("Get exchange balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.json({ positions: [] });
      }

      // Use database positions (tracked from actual trade executions with real fill prices)
      const botPositions = await storage.getBotPositions(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      const botMap = new Map(bots.map(b => [b.id, b]));
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) {
        console.log('[Positions] Failed to fetch prices');
      }

      const positions: any[] = [];

      for (const pos of botPositions) {
        const baseSize = parseFloat(pos.baseSize);
        if (Math.abs(baseSize) < 0.0001) continue;

        const bot = botMap.get(pos.tradingBotId);
        if (!bot) continue;

        const side = baseSize > 0 ? 'LONG' : 'SHORT';
        const entryPrice = parseFloat(pos.avgEntryPrice);
        const rawMarkPrice = prices[pos.market] || 0;
        const markPrice = rawMarkPrice > 0 ? rawMarkPrice : entryPrice;
        const sizeUsd = Math.abs(baseSize) * markPrice;
        const realizedPnl = parseFloat(pos.realizedPnl);
        const totalFees = parseFloat(pos.totalFees || "0");
        
        const unrealizedPnl = rawMarkPrice > 0
          ? (side === 'LONG'
              ? (markPrice - entryPrice) * Math.abs(baseSize)
              : (entryPrice - markPrice) * Math.abs(baseSize))
          : 0;
        
        const unrealizedPnlPercent = rawMarkPrice > 0 && Math.abs(entryPrice * Math.abs(baseSize)) > 0
          ? (unrealizedPnl / (entryPrice * Math.abs(baseSize))) * 100
          : 0;

        positions.push({
          botId: bot.id,
          botName: bot.name,
          market: pos.market,
          side,
          baseAssetAmount: baseSize,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          realizedPnl,
          totalFees,
          lastTradeAt: pos.lastTradeAt,
        });
      }

      res.json({ positions });
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reconcile endpoint - sync database with on-chain Drift positions
  // OPTIMIZED: Uses batch RPC call instead of N sequential calls
  app.post("/api/positions/reconcile", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not found" });
      }

      // Get all bots for this wallet
      const bots = await storage.getTradingBots(req.walletAddress!);
      const reconciled: any[] = [];
      const discrepancies: any[] = [];
      let totalOnChainPositions = 0;

      // BATCH OPTIMIZATION: Fetch all positions in single RPC call (deduplicated)
      const subAccountIds = Array.from(new Set(bots.map(b => b.driftSubaccountId ?? 0)));
      const batchPositions = await getBatchPerpPositions(wallet.agentPublicKey, subAccountIds);

      // Process each bot using batch-fetched positions
      for (const bot of bots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        const onChainPositions = batchPositions.get(subAccountId) || [];
        totalOnChainPositions += onChainPositions.length;
        console.log(`[Reconcile] Bot ${bot.name} (subaccount ${subAccountId}): Found ${onChainPositions.length} on-chain positions`);

        // Find position matching this bot's market
        const pos = onChainPositions.find((p: any) => p.market === bot.market);
        const dbPosition = await storage.getBotPosition(bot.id, bot.market);
        const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;

        if (pos) {
          const onChainBaseSize = pos.baseAssetAmount;
          
          // Check for discrepancy
          if (Math.abs(dbBaseSize - onChainBaseSize) > 0.0001) {
            discrepancies.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              database: { baseSize: dbBaseSize },
              onChain: { 
                baseSize: onChainBaseSize, 
                side: pos.side,
                entryPrice: pos.entryPrice 
              }
            });

            // Update database with on-chain data
            await storage.upsertBotPosition({
              tradingBotId: bot.id,
              walletAddress: bot.walletAddress,
              market: pos.market,
              baseSize: String(onChainBaseSize),
              avgEntryPrice: String(pos.entryPrice),
              costBasis: String(Math.abs(onChainBaseSize) * pos.entryPrice),
              realizedPnl: dbPosition?.realizedPnl || "0",
              totalFees: dbPosition?.totalFees || "0",
              lastTradeId: dbPosition?.lastTradeId || null,
              lastTradeAt: new Date(),
            });

            reconciled.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              newPosition: {
                baseSize: onChainBaseSize,
                side: pos.side,
                entryPrice: pos.entryPrice
              }
            });
          }
        } else if (dbPosition && Math.abs(dbBaseSize) > 0.0001) {
          discrepancies.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            database: { baseSize: dbBaseSize },
            onChain: { baseSize: 0, side: 'FLAT' },
            action: 'preserved_db'
          });

          console.log(`[Reconcile] On-chain empty but DB has ${dbBaseSize} ${bot.market} for bot ${bot.name} — preserving DB (source of truth)`);

          reconciled.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            newPosition: { baseSize: 0, side: 'FLAT' }
          });
        }
      }

      res.json({ 
        success: true,
        totalOnChainPositions,
        botsChecked: bots.length,
        discrepancies,
        reconciled,
      });
    } catch (error) {
      console.error("Reconcile positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health metrics endpoint - uses byte-parsing only to avoid SDK memory leaks
  app.get("/api/health-metrics", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const bots = await storage.getTradingBots(req.walletAddress!);

      let totalCollateral = 0;
      let freeCollateral = 0;
      let unrealizedPnl = 0;
      const formattedPositions: any[] = [];
      const prices = await getAllPrices();

      const agentAccountInfo = await getExchangeAccountInfo(wallet.agentPublicKey, 0);
      totalCollateral += agentAccountInfo.totalCollateral;
      freeCollateral += agentAccountInfo.freeCollateral;

      for (const bot of bots) {
        const hmBotCtx = getBotSubaccountContext(bot);
        if (hmBotCtx) {
          try {
            const botInfo = await getExchangeAccountInfoForBot('', 0, hmBotCtx, getAdapterForBot(bot));
            totalCollateral += botInfo.totalCollateral;
            freeCollateral += botInfo.freeCollateral;
            unrealizedPnl += botInfo.unrealizedPnl;
          } catch (err) {
            console.warn(`[health-metrics] Failed to query Pacifica bot ${bot.id}:`, err);
          }
        }
      }

      const dbPositions = await storage.getBotPositions(req.walletAddress!);
      for (const pos of dbPositions) {
        const baseSize = parseFloat(pos.baseSize);
        if (Math.abs(baseSize) < 0.0001) continue;
        const entryPrice = parseFloat(pos.avgEntryPrice);
        const markPrice = prices[pos.market] || entryPrice;
        const posUnrealizedPnl = baseSize > 0
          ? (markPrice - entryPrice) * Math.abs(baseSize)
          : (entryPrice - markPrice) * Math.abs(baseSize);
        unrealizedPnl += posUnrealizedPnl;

        let estLiqPrice: number | null = null;
        if (freeCollateral > 0 && Math.abs(baseSize) > 0.0001) {
          const priceBuffer = freeCollateral / Math.abs(baseSize);
          estLiqPrice = baseSize > 0
            ? Math.max(0, markPrice - priceBuffer)
            : markPrice + priceBuffer;
        }

        formattedPositions.push({
          marketIndex: 0,
          market: pos.market,
          baseSize,
          notionalValue: Math.abs(baseSize) * markPrice,
          liquidationPrice: estLiqPrice,
          entryPrice,
          unrealizedPnl: posUnrealizedPnl,
        });
      }

      let healthFactor = 100;
      if (formattedPositions.length > 0 && totalCollateral > 0) {
        healthFactor = Math.max(0, Math.min(100, (freeCollateral / totalCollateral) * 100));
      }
      
      res.json({
        healthFactor,
        marginRatio: totalCollateral > 0 ? (totalCollateral - freeCollateral) / totalCollateral : 0,
        totalCollateral,
        freeCollateral,
        unrealizedPnl,
        positions: formattedPositions,
        subAccountId: 0,
        isEstimate: true,
        estimateNote: "Health metrics from exchange account data (aggregated across subaccounts)",
      });
    } catch (error) {
      console.error("Health metrics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manual close position endpoint - query on-chain and close with reduce-only order
  app.post("/api/trading-bots/:id/close-position", requireWallet, async (req, res) => {
    console.log(`[ClosePosition] *** CLOSE POSITION REQUEST RECEIVED *** botId=${req.params.id}`);
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const subAccountId = bot.driftSubaccountId ?? 0;
      const closeBotCtx = getBotSubaccountContext(bot);
      const closeQueryAccount = closeBotCtx ? closeBotCtx.botPublicKey : wallet.agentPublicKey;
      const closeQuerySubId = closeBotCtx ? 0 : subAccountId;

      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          bot.id,
          closeQueryAccount,
          closeQuerySubId,
          bot.market,
          closeBotCtx?.botPublicKey
        );
        console.log(`[ClosePosition] On-chain position for ${bot.market}: ${onChainPosition.side} ${onChainPosition.size}`);
      } catch (err) {
        console.error(`[ClosePosition] Failed to query on-chain position:`, err);
        return res.status(500).json({ 
          error: "Failed to query on-chain position",
          details: err instanceof Error ? err.message : "Unknown error"
        });
      }

      // Check if there's actually a position to close
      if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
        return res.status(400).json({ 
          error: "No open position to close",
          onChainPositionSize: 0,
          side: 'FLAT'
        });
      }

      // Determine close side (opposite of current position)
      const closeSide: 'long' | 'short' = onChainPosition.side === 'LONG' ? 'short' : 'long';
      const closeSize = Math.abs(onChainPosition.size);

      const positionSide: 'long' | 'short' = onChainPosition.side === 'LONG' ? 'long' : 'short';
      console.log(`[ClosePosition] Closing ${closeSize} ${bot.market} (${closeSide}) with closePerpPosition (exact BN precision)`);

      // Create trade record BEFORE attempting close (with pending status)
      // This ensures we can track and update status whether trade succeeds or needs retry
      const closeSlippageBps = wallet.slippageBps ?? 50;
      const closeEntryPrice = onChainPosition.entryPrice || 0;
      // Pending row carries no protocolFillId yet — the canonical
      // `tx-<sig>` identity is set atomically when the close completes
      // (so it's the SAME key the reconciler / retry would use for the
      // same on-chain close, achieving cross-path dedup).
      const pendingCloseTrade = await storage.createBotTrade({
        tradingBotId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: "CLOSE",
        size: String(closeSize),
        price: "0",
        fee: "0",
        status: "pending",
        webhookPayload: { action: "manual_close", reason: "User requested position close", entryPrice: closeEntryPrice },
        executionMethod: 'legacy',
      });
      console.log(`[ClosePosition] Created pending trade record: ${pendingCloseTrade.id}`);

      // Execute close order using closePerpPosition for exact BN precision
      // Pass positionSizeBase and positionSide so Swift can be used for closes
      const result = await closePerpPosition(
        agentSecret,
        bot.market,
        closeBotCtx ? 0 : subAccountId,
        closeSize,
        closeSlippageBps,
        undefined,
        wallet.agentPublicKey,
        positionSide,
        closeBotCtx,
        bot.walletAddress,
        getAdapterForBot(bot),
      );

      // Map closePerpPosition result format (signature) to expected format (txSignature)
      const txSignature = result.signature || null;

      // Handle error case
      if (!result.success) {
        // Check if this is a transient error (rate limit, price feed, etc.) - queue for CRITICAL automatic retry
        if (isTransientError(result.error || '')) {
          console.log(`[ClosePosition] CRITICAL: Transient error on close order, queueing for priority retry`);
          
          const retryJobId = await queueTradeRetry({
            botId: bot.id,
            walletAddress: wallet.address,
            agentPublicKey: wallet.agentPublicKey!,
            market: bot.market,
            side: 'close',
            size: closeSize,
            subAccountId,
            reduceOnly: true,
            slippageBps: closeSlippageBps,
            priority: 'critical',
            lastError: result.error,
            entryPrice: closeEntryPrice,
            originalTradeId: pendingCloseTrade.id,
          });
          
          await storage.updateBotTrade(pendingCloseTrade.id, {
            status: "pending",
            errorMessage: `Rate limited - CRITICAL auto-retry queued (job: ${retryJobId})`,
          });
          
          return res.status(202).json({ 
            status: "queued_for_retry",
            retryJobId,
            tradeId: pendingCloseTrade.id,
            message: "Close order rate limited - CRITICAL auto-retry scheduled (priority queue)",
            warning: "Position may remain open until retry succeeds"
          });
        }

        // Permanent failure - mark trade as failed
        await storage.updateBotTrade(pendingCloseTrade.id, {
          status: "failed",
          errorMessage: result.error || "Unknown error",
        });

        // Fire trade_failed Telegram alert; fire-and-forget so a notification
        // failure never masks the 500 we return to the client.
        sendTradeNotification(bot.walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: closeSide === 'long' ? 'LONG' : 'SHORT',
          error: result.error || "Unknown error",
        }).catch(err => console.error('[ClosePosition] Failed to send trade_failed notification:', err));

        return res.status(500).json({ 
          error: "Failed to execute close order",
          details: result.error || "Unknown error",
          tradeId: pendingCloseTrade.id,
        });
      }

      // Handle case where subprocess found no position to close (success=true, signature=null)
      // This can happen if position was closed by another process (e.g., liquidation, webhook)
      if (result.success && !txSignature) {
        console.log(`[ClosePosition] closePerpPosition returned success but no signature - position was already closed`);
        
        // Still run a reconciliation to ensure database matches on-chain state
        // This handles the case where liquidation or another process closed the position
        // but the database wasn't updated
        try {
          const { reconcileBotPosition } = await import("./reconciliation-service.js");
          await reconcileBotPosition(bot.id, wallet.address, wallet.agentPublicKey, subAccountId, bot.market, closeBotCtx?.botPublicKey);
          console.log(`[ClosePosition] Ran reconciliation after "already closed" scenario`);
        } catch (reconcileErr) {
          console.warn(`[ClosePosition] Reconciliation failed (non-critical):`, reconcileErr);
        }
        
        return res.json({ 
          success: true,
          message: "Position was already closed (no trade executed)",
          warning: null,
          closedSize: 0,
          closeSide,
          fillPrice: 0,
          fee: 0,
          txSignature: null,
          tradeId: null,
        });
      }

      console.log(`[ClosePosition] Close order executed: ${txSignature}`);
      console.log(`[ClosePosition] Entry price from on-chain: $${closeEntryPrice}`);

      // Fetch current ticker price for accurate exit price
      let fillPrice = 0;
      try {
        const priceRes = await fetch(`http://localhost:5000/api/prices`);
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          console.log(`[ClosePosition] Price data keys: ${Object.keys(priceData).join(', ')}, looking for: ${bot.market}`);
          fillPrice = priceData[bot.market] || 0;
          if (fillPrice > 0) {
            console.log(`[ClosePosition] Fetched ticker price for ${bot.market}: $${fillPrice}`);
          } else {
            console.warn(`[ClosePosition] Market ${bot.market} not found in price data`);
          }
        } else {
          console.warn(`[ClosePosition] Price fetch failed with status: ${priceRes.status}`);
        }
      } catch (priceErr) {
        console.warn(`[ClosePosition] Could not fetch ticker price:`, priceErr);
      }
      
      // Fallback: use entry price if ticker fetch failed (price will be close enough for PnL estimate)
      if (!fillPrice && closeEntryPrice > 0) {
        fillPrice = closeEntryPrice;
        console.log(`[ClosePosition] Using entry price as fallback exit price: $${fillPrice}`);
      }

      // Calculate fee (0.05% taker fee on notional value)
      const closeNotional = closeSize * fillPrice;
      const closeFee = closeNotional * getExchangeFeeRate();

      // Calculate trade PnL based on entry and exit prices
      // closeSide = 'short' means we're closing a LONG (bought low, selling high)
      // closeSide = 'long' means we're closing a SHORT (sold high, buying low)
      let tradePnl = 0;
      if (closeEntryPrice > 0 && fillPrice > 0) {
        if (closeSide === 'short') {
          // Closing LONG: profit if exitPrice > entryPrice
          tradePnl = (fillPrice - closeEntryPrice) * closeSize - closeFee;
        } else {
          // Closing SHORT: profit if entryPrice > exitPrice
          tradePnl = (closeEntryPrice - fillPrice) * closeSize - closeFee;
        }
        console.log(`[ClosePosition] Trade PnL: entry=$${closeEntryPrice.toFixed(2)}, exit=$${fillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${tradePnl.toFixed(4)}`);
      } else {
        console.warn(`[ClosePosition] Cannot calculate PnL - entryPrice=$${closeEntryPrice}, fillPrice=$${fillPrice}`);
      }

      // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
      // This handles partial fills and ensures position is truly flat
      // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
      let verificationWarning: string | null = null;
      let finalTxSignature = txSignature;
      let retryCount = 0;
      const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
      
      while (retryCount < maxRetries) {
        try {
          // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
          const delayMs = 1000;
          console.log(`[ClosePosition] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          
          const postClosePosition = await PositionService.getPositionForExecution(
            bot.id,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            closeBotCtx?.botPublicKey
          );
          
          if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
            console.log(`[ClosePosition] Post-close verification: Position confirmed FLAT`);
            break; // Position fully closed, exit retry loop
          }
          
          // Position still exists - this is dust that needs cleanup
          console.warn(`[ClosePosition] Position NOT fully closed (attempt ${retryCount + 1}/${maxRetries})`);
          console.warn(`[ClosePosition] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
          
          // Retry closePerpPosition to clean up the dust
          const dustSlippageBps = wallet.slippageBps ?? 50;
          const retryResult = await closePerpPosition(
            agentSecret,
            bot.market,
            subAccountId,
            Math.abs(postClosePosition.size),
            dustSlippageBps,
            undefined,
            wallet.agentPublicKey,
            postClosePosition.side === 'LONG' ? 'long' : 'short',
            undefined,
            undefined,
            getAdapterForBot(bot),
          );
          
          if (retryResult.success && retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
            finalTxSignature = retryResult.signature;
          } else if (retryResult.success && !retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup: position already closed`);
            break;
          } else {
            console.error(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
          }
          
          retryCount++;
        } catch (verifyErr) {
          console.warn(`[ClosePosition] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
          retryCount++;
        }
      }
      
      // Final verification after all retries
      try {
        const finalCheck = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          closeBotCtx?.botPublicKey
        );
        if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
          verificationWarning = `Position not fully closed after ${maxRetries} attempts. Remaining: ${finalCheck.side} ${finalCheck.size}`;
          console.error(`[ClosePosition] CRITICAL: ${verificationWarning}`);
        }
      } catch (finalVerifyErr) {
        console.warn(`[ClosePosition] Could not perform final position verification:`, finalVerifyErr);
      }

      // Atomic: mark pending row executed AND recompute stats counters in
      // one DB transaction. Volume delta = size × fill so totalVolume stays
      // consistent with on-chain notional even if the deferred sync below
      // crashes or the process is killed.
      const manualClosePrice = parseFloat(String(fillPrice || result.fillPrice || 0));
      const manualCloseNotional = closeSize * (Number.isFinite(manualClosePrice) ? manualClosePrice : 0);
      const manualCloseAtomicResult = await storage.recordCloseEventAtomic({
        botId: bot.id,
        update: {
          tradeId: pendingCloseTrade.id,
          fields: {
            price: String(fillPrice || result.fillPrice || 0),
            fee: String(closeFee),
            pnl: String(tradePnl),
            status: "executed",
            txSignature: finalTxSignature,
            protocolFillId: DatabaseStorage.canonicalCloseFillId({
              signature: finalTxSignature,
              botId: bot.id,
              side: 'CLOSE',
              size: closeSize,
              market: bot.market,
              fillPrice: fillPrice || result.fillPrice || 0,
              timestampMs: Date.now(),
            }),
            webhookPayload: { action: "manual_close", reason: "User requested position close", entryPrice: closeEntryPrice, exitPrice: result.fillPrice || fillPrice },
            errorMessage: verificationWarning,
            executionMethod: result.executionMethod || 'legacy',
          },
        },
        deltas: {
          totalPnlDelta: tradePnl,
          totalVolumeDelta: manualCloseNotional,
          lastTradeAt: new Date().toISOString(),
        },
      });

      // Fire position_closed Telegram alert ONLY when this handler is the
      // writer that promoted the close to canonical (isNew=true). If the
      // reconciler / retry queue already wrote the canonical row, isNew=false
      // and that path already fired (or will fire) the notification —
      // suppressing here is what guarantees exactly-once delivery per close.
      if (manualCloseAtomicResult.isNew) {
        sendTradeNotification(bot.walletAddress, {
          type: 'position_closed',
          botName: bot.name,
          market: bot.market,
          side: closeSide === 'long' ? 'LONG' : 'SHORT',
          size: closeSize,
          price: fillPrice,
          pnl: tradePnl,
          closeReason: getCloseReasonLabel('manual'),
        }).catch(err => console.error('[ClosePosition] Failed to send position_closed notification:', err));
      }

      // Sync position from on-chain (updates database with actual Drift state)
      await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        pendingCloseTrade.id,
        closeFee,
        fillPrice,
        closeSide,
        closeSize,
        closeBotCtx?.botPublicKey
      );
      
      // PROFIT SHARE: If this is a subscriber bot with profitable close, distribute to creator
      // This must happen BEFORE auto-withdraw to ensure creator gets their share
      if (tradePnl > 0) {
        const tradeId = `${bot.id}-${Date.now()}`;
        distributeCreatorProfitShare({
          subscriberBotId: bot.id,
          subscriberWalletAddress: wallet.address,
          subscriberAgentPublicKey: wallet.agentPublicKey!,
          subscriberEncryptedPrivateKey: agentSecret,
          driftSubaccountId: subAccountId,
          realizedPnl: tradePnl,
          tradeId,
        }).then(result => {
          if (result.success && result.amount) {
            console.log(`[ClosePosition] Profit share distributed: $${result.amount.toFixed(4)}`);
          } else if (!result.success && result.error) {
            console.error(`[ClosePosition] Profit share failed: ${result.error}`);
            // IOU is now created inside distributeCreatorProfitShare
          }
        }).catch(err => console.error('[ClosePosition] Profit share error:', err));
      }
      
      // NOTE: Manual close positions are NOT routed to subscribers - only webhook signals are
      // This prevents creators from accidentally affecting subscribers with test/personal actions

      res.json({ 
        success: true,
        message: verificationWarning ? "Position closed with warning" : "Position closed successfully",
        warning: verificationWarning,
        closedSize: closeSize,
        closeSide,
        fillPrice,
        fee: closeFee,
        txSignature: finalTxSignature,
        tradeId: pendingCloseTrade.id
      });
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Close position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trading-bots/:id/set-tpsl", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) return res.status(404).json({ error: "Bot not found" });
      if (bot.walletAddress !== req.walletAddress) return res.status(403).json({ error: "Forbidden" });

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const { takeProfitPrice, stopLossPrice } = req.body;
      if (takeProfitPrice === undefined && stopLossPrice === undefined) {
        return res.status(400).json({ error: "At least one of takeProfitPrice or stopLossPrice is required" });
      }
      if (takeProfitPrice !== undefined && (typeof takeProfitPrice !== 'number' || !Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)) {
        return res.status(400).json({ error: "takeProfitPrice must be a finite positive number" });
      }
      if (stopLossPrice !== undefined && (typeof stopLossPrice !== 'number' || !Number.isFinite(stopLossPrice) || stopLossPrice <= 0)) {
        return res.status(400).json({ error: "stopLossPrice must be a finite positive number" });
      }

      const dbPosition = await storage.getBotPosition(bot.id, bot.market);
      if (!dbPosition || Math.abs(parseFloat(dbPosition.baseSize || '0')) < 0.0001) {
        return res.status(400).json({ error: "No open position — TP/SL can only be set on an active position" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const tpslBotCtx = getBotSubaccountContext(bot);
      const signing = await _resolveSigningContext(agentSecret, subAccountId, tpslBotCtx);
      try {
      const mainWalletAddress = await _lookupMainWallet(
        tpslBotCtx ? wallet.agentPublicKey : signing.publicKey
      );
      const adapter = getAdapterForBot(bot);

      if (!adapter.setTpSl) {
        return res.status(400).json({ error: "Current protocol adapter does not support TP/SL" });
      }

      if (adapter.cancelTpSlOrders) {
        try {
          const cancelResult = await adapter.cancelTpSlOrders({
            agentPublicKey: signing.publicKey,
            agentSecretKey: signing.secretKey,
            mainWalletAddress,
            internalSymbol: bot.market,
            subaccountId: signing.subaccountId,
          });
          console.log(`[SetTpSl] Pre-cleared existing TP/SL for bot ${bot.id}: canceled=${cancelResult.canceledCount}`);
        } catch (err: any) {
          console.log(`[SetTpSl] Pre-clear failed (non-fatal): ${err.message}`);
        }
      }

      const result = await adapter.setTpSl({
        agentPublicKey: signing.publicKey,
        agentSecretKey: signing.secretKey,
        mainWalletAddress,
        internalSymbol: bot.market,
        takeProfitPrice: takeProfitPrice || undefined,
        stopLossPrice: stopLossPrice || undefined,
        subaccountId: signing.subaccountId,
      });

      if (!result.success) {
        console.warn(`[SetTpSl] Adapter pre-flight rejection for bot ${bot.id} (${bot.market}): ${result.error}`);
        return res.status(400).json({
          success: false,
          status: result.status,
          error: result.error || 'TP/SL rejected by pre-flight validation',
          appliedTakeProfitPrice: result.appliedTakeProfitPrice ?? null,
          appliedStopLossPrice: result.appliedStopLossPrice ?? null,
          droppedLegs: result.droppedLegs ?? [],
        });
      }

      const appliedTp = result.appliedTakeProfitPrice ?? null;
      const appliedSl = result.appliedStopLossPrice ?? null;

      console.log(`[SetTpSl] Set TP/SL for bot ${bot.id} (${bot.market}): TP=${appliedTp ?? 'none'}, SL=${appliedSl ?? 'none'}, orderId=${result.orderId}${result.error ? ` (warning: ${result.error})` : ''}`);

      const updatedRiskConfig = { ...(bot.riskConfig as Record<string, unknown> || {}) };
      if (appliedTp != null) updatedRiskConfig.takeProfitPrice = appliedTp;
      if (appliedSl != null) updatedRiskConfig.stopLossPrice = appliedSl;
      await storage.updateTradingBot(bot.id, { riskConfig: updatedRiskConfig });

      res.json({
        success: true,
        takeProfitPrice: appliedTp,
        stopLossPrice: appliedSl,
        appliedTakeProfitPrice: appliedTp,
        appliedStopLossPrice: appliedSl,
        droppedLegs: result.droppedLegs ?? [],
        orderId: result.orderId,
        ...(result.error ? { warning: result.error } : {}),
      });
      } finally {
        signing.cleanup();
      }
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("[SetTpSl] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to set TP/SL" });
    }
  });

  app.post("/api/trading-bots/:id/cancel-tpsl", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) return res.status(404).json({ error: "Bot not found" });
      if (bot.walletAddress !== req.walletAddress) return res.status(403).json({ error: "Forbidden" });

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const subAccountId = bot.driftSubaccountId ?? 0;
      const cancelBotCtx = getBotSubaccountContext(bot);
      const agentPubKey = wallet.agentPublicKey;
      const mainWalletAddress = await _lookupMainWallet(agentPubKey);
      const adapter = getAdapterForBot(bot);

      const signing = await _resolveSigningContext(agentSecret, subAccountId, cancelBotCtx);

      try {
      if (adapter.cancelTpSlOrders) {
        const result = await adapter.cancelTpSlOrders({
          agentPublicKey: signing.publicKey,
          agentSecretKey: signing.secretKey,
          mainWalletAddress,
          internalSymbol: bot.market,
          subaccountId: signing.subaccountId,
        });
        console.log(`[CancelTpSl] cancel_all response for bot ${bot.id} (${bot.market}): canceled_count=${result.canceledCount}, success=${result.success}, error=${result.error || 'none'}`);

        let positionStillOpen = false;
        try {
          const positions = await adapter.getPositions(signing.publicKey, signing.subaccountId);
          const pos = positions.find((p: any) => p.internalSymbol.toUpperCase() === bot.market.toUpperCase());
          positionStillOpen = !!pos && Math.abs(pos.baseSize) > 0.0001;
          console.log(`[CancelTpSl] Position verification after cancel: ${positionStillOpen ? `still open (size=${pos?.baseSize})` : 'no position found'}`);
        } catch (err: any) {
          console.log(`[CancelTpSl] Position verification skipped: ${err.message}`);
        }

        const clearedRiskConfig = { ...(bot.riskConfig as Record<string, unknown> || {}) };
        delete clearedRiskConfig.takeProfitPrice;
        delete clearedRiskConfig.stopLossPrice;
        await storage.updateTradingBot(bot.id, { riskConfig: clearedRiskConfig });
        res.json({ success: true, canceledCount: result.canceledCount, positionStillOpen });
      } else if (adapter.setTpSl) {
        const result = await adapter.setTpSl({
          agentPublicKey: signing.publicKey,
          agentSecretKey: signing.secretKey,
          mainWalletAddress,
          internalSymbol: bot.market,
          takeProfitPrice: 0,
          stopLossPrice: 0,
          subaccountId: signing.subaccountId,
        });
        console.log(`[CancelTpSl] Cleared TP/SL for bot ${bot.id} (${bot.market}), orderId=${result.orderId}`);
        res.json({ success: true, orderId: result.orderId });
      } else {
        return res.status(400).json({ error: "Current protocol adapter does not support TP/SL" });
      }
      } finally {
        signing.cleanup();
      }
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("[CancelTpSl] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to cancel TP/SL" });
    }
  });

  // Close a specific market position in a bot's subaccount (for cleaning up dust/misrouted positions)
  app.post("/api/trading-bots/:id/close-market-position", requireWallet, async (req, res) => {
    console.log(`[CloseMarketPosition] *** CLOSE MARKET POSITION REQUEST *** botId=${req.params.id}`);
    try {
      const { market } = req.body;
      if (!market || typeof market !== 'string') {
        return res.status(400).json({ error: "Market parameter required (e.g., SOL-PERP)" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const subAccountId = bot.driftSubaccountId ?? 0;
      const closeMarketBotCtx = getBotSubaccountContext(bot);
      console.log(`[CloseMarketPosition] Closing ${market} in subaccount ${subAccountId} (bot: ${bot.name})`);

      // Query position for Swift support
      let marketPositionSide: 'long' | 'short' | undefined;
      let marketPositionSize: number | undefined;
      try {
        const marketPos = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          market,
          closeMarketBotCtx?.botPublicKey
        );
        if (marketPos.side !== 'FLAT' && Math.abs(marketPos.size) > 0) {
          marketPositionSide = marketPos.side === 'LONG' ? 'long' : 'short';
          marketPositionSize = Math.abs(marketPos.size);
        }
      } catch (posErr) {
        console.warn(`[CloseMarketPosition] Could not query position for Swift, will use legacy:`, posErr);
      }

      const marketCloseSlippageBps = wallet.slippageBps ?? 50;
      const result = await closePerpPosition(
        agentSecret,
        market,
        closeMarketBotCtx ? 0 : subAccountId,
        marketPositionSize,
        marketCloseSlippageBps,
        undefined,
        wallet.agentPublicKey,
        marketPositionSide,
        closeMarketBotCtx,
        bot.walletAddress,
        getAdapterForBot(bot),
      );

      if (!result.success) {
        return res.status(500).json({ 
          error: "Failed to close position",
          details: result.error || "Unknown error"
        });
      }

      if (result.success && !result.signature) {
        return res.json({ 
          success: true,
          message: "Position was already closed or doesn't exist",
          market,
          txSignature: null,
        });
      }

      console.log(`[CloseMarketPosition] Position closed: ${result.signature}`);
      res.json({ 
        success: true,
        message: `${market} position closed successfully`,
        market,
        txSignature: result.signature,
      });
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Close market position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manual trade - trigger a trade without webhook (uses bot's config)
  app.post("/api/trading-bots/:id/manual-trade", requireWallet, async (req, res) => {
    console.log(`[ManualTrade] *** MANUAL TRADE REQUEST *** botId=${req.params.id}`);
    try {
      const { side } = req.body;
      if (!side || !['long', 'short'].includes(side)) {
        return res.status(400).json({ error: "Side must be 'long' or 'short'" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!bot.isActive) {
        return res.status(400).json({ error: "Bot is paused. Activate it first." });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
      const agentSecret = agentKeyResult.secretKey;

      const subAccountId = bot.driftSubaccountId ?? 0;
      const manualBotCtx = getBotSubaccountContext(bot);
      const baseCapital = parseFloat(bot.maxPositionSize || "0");

      const oraclePrice = await getMarketPrice(bot.market, getAdapterForBot(bot));
      if (!oraclePrice || oraclePrice <= 0) {
        // Early failure (no on-chain order placed yet) — still surface a
        // trade_failed alert so the user sees why the manual trade didn't
        // execute. Fire-and-forget; never mask the HTTP error.
        sendTradeNotification(bot.walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: 'Could not get market price',
        }).catch(err => console.error('[ManualTrade] Failed to send trade_failed notification:', err));
        return res.status(500).json({ error: "Could not get market price" });
      }

      const sizingResult = await computeTradeSizingAndTopUp({
        agentPublicKey: wallet.agentPublicKey,
        agentPrivateKeyEncrypted: agentSecret,
        subAccountId: manualBotCtx ? 0 : subAccountId,
        botId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        baseCapital,
        leverage: bot.leverage || 1,
        autoTopUp: bot.autoTopUp ?? false,
        profitReinvestEnabled: bot.profitReinvest === true,
        signalPercent: 0,
        oraclePrice,
        logPrefix: "[ManualTrade]",
        botCtx: manualBotCtx,
        adapter: getAdapterForBot(bot),
      });

      if (!sizingResult.success) {
        if (sizingResult.shouldPauseBot && sizingResult.pauseReason) {
          await storage.updateTradingBot(bot.id, { isActive: false, pauseReason: sizingResult.pauseReason } as any);
        }
        // Early failure (no on-chain order placed yet) — fire trade_failed
        // so the user is notified of sizing / top-up failures (insufficient
        // collateral, etc.) the same way as executor failures.
        sendTradeNotification(bot.walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: sizingResult.error || "Trade sizing failed",
        }).catch(err => console.error('[ManualTrade] Failed to send trade_failed notification:', err));
        return res.status(400).json({ error: sizingResult.error || "Trade sizing failed" });
      }

      const contractSize = sizingResult.finalContractSize;

      console.log(`[ManualTrade] Executing ${side.toUpperCase()} ${contractSize.toFixed(4)} contracts @ $${oraclePrice.toFixed(2)}`);

      const trade = await storage.createBotTrade({
        tradingBotId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side,
        size: contractSize.toFixed(8),
        price: oraclePrice.toString(),
        status: "pending",
        webhookPayload: { manual: true, action: side === 'long' ? 'buy' : 'sell' },
        executionMethod: 'legacy',
      });

      const userSlippageBps = wallet.slippageBps ?? 50;
      const orderResult = await executePerpOrder(
        agentSecret,
        bot.market,
        side,
        contractSize,
        manualBotCtx ? 0 : subAccountId,
        false,
        userSlippageBps,
        undefined,
        wallet.agentPublicKey,
        bot.leverage || 1,
        manualBotCtx,
        bot.walletAddress,
        getAdapterForBot(bot),
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          errorMessage: userFriendlyError,
        });
        // Mirror webhook/copy-trade pattern: fire-and-forget; never let a
        // notification failure mask the real trade error returned to client.
        sendTradeNotification(bot.walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[ManualTrade] Failed to send trade_failed notification:', err));
        return res.status(500).json({ error: userFriendlyError });
      }

      let fillPrice = orderResult.fillPrice || oraclePrice;
      const tradeNotional = contractSize * fillPrice;
      // Use actual fee from executor if available, otherwise estimate
      const tradeFee = orderResult.actualFee ?? (tradeNotional * getExchangeFeeRate());

      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: fillPrice.toString(),
        fee: tradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8),
        executionMethod: orderResult.executionMethod || 'legacy',
        swiftOrderId: orderResult.swiftOrderId || null,
      });

      // Sync position
      const syncResult = await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        trade.id,
        tradeFee,
        fillPrice,
        side,
        contractSize,
        manualBotCtx?.botPublicKey
      );

      // Update trade with real on-chain fill price if available (more accurate than oracle estimate)
      if (syncResult?.onChainEntryPrice && syncResult.onChainEntryPrice > 0 && Math.abs(syncResult.onChainEntryPrice - fillPrice) > 0.001) {
        console.log(`[ManualTrade] Updating fill price: oracle=$${fillPrice.toFixed(6)} -> on-chain=$${syncResult.onChainEntryPrice.toFixed(6)}`);
        fillPrice = syncResult.onChainEntryPrice;
        const tradeUpdate: Record<string, string> = {
          price: fillPrice.toFixed(6),
        };
        if (!orderResult.actualFee) {
          const updatedNotional = contractSize * fillPrice;
          tradeUpdate.fee = (updatedNotional * getExchangeFeeRate()).toFixed(6);
        }
        await storage.updateBotTrade(trade.id, tradeUpdate);
      }

      // Stats: recompute counters from canonical SQL, merge volume delta.
      await storage.recomputeAndMergeBotStats(bot.id, {
        totalVolumeDelta: tradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      console.log(`[ManualTrade] Trade executed via ${orderResult.executionMethod || 'legacy'}: ${side.toUpperCase()} ${contractSize.toFixed(4)} @ $${fillPrice.toFixed(2)}`);

      // NOTE: Manual trades are NOT routed to subscribers - only webhook signals are
      // This prevents creators from accidentally affecting subscribers with test/personal trades

      // Branch notification on sync outcome: when the manual order closed
      // (or reduced to zero) an existing position, fire `position_closed`
      // with realized PnL — NOT `trade_executed`. This is the case where a
      // user uses the manual-trade endpoint to send an opposite-side order
      // to flatten a position. The reconciler won't observe an external
      // close here (the close was confirmed synchronously in-handler with
      // the trade row written), so this path owns the notification.
      if (syncResult?.isClosingTrade) {
        sendTradeNotification(bot.walletAddress, {
          type: 'position_closed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          size: contractSize,
          price: fillPrice,
          pnl: syncResult.tradePnl ?? 0,
          closeReason: getCloseReasonLabel('manual'),
        }).catch(err => console.error('[ManualTrade] Failed to send position_closed notification:', err));
      } else {
        // Open / increase: fire trade_executed (mirrors webhook open path
        // at routes.ts:9416). Fire-and-forget so HTTP response isn't
        // blocked on Telegram latency.
        sendTradeNotification(bot.walletAddress, {
          type: 'trade_executed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          size: tradeNotional,
          price: fillPrice,
        }).catch(err => console.error('[ManualTrade] Failed to send trade_executed notification:', err));
      }

      res.json({
        success: true,
        side,
        size: contractSize,
        price: fillPrice,
        notional: tradeNotional,
        fee: tradeFee,
        txSignature: orderResult.txSignature || orderResult.signature,
        tradeId: trade.id,
      });
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Manual trade error:", error);
      // Best-effort trade_failed alert for unexpected errors (e.g. sizing /
      // RPC failures BEFORE executePerpOrder ran). Wrapped so a Telegram
      // failure can't mask the 500 we already return to the client.
      try {
        const failedBot = await storage.getTradingBotById(req.params.id);
        if (failedBot && failedBot.walletAddress === req.walletAddress) {
          sendTradeNotification(failedBot.walletAddress, {
            type: 'trade_failed',
            botName: failedBot.name,
            market: failedBot.market,
            side: (req.body?.side === 'long' || req.body?.side === 'short')
              ? (req.body.side === 'long' ? 'LONG' : 'SHORT')
              : undefined,
            error: error instanceof Error ? error.message : 'Internal server error',
          }).catch(err => console.error('[ManualTrade] Failed to send trade_failed notification:', err));
        }
      } catch (notifLookupErr) {
        console.error('[ManualTrade] Could not dispatch trade_failed notification:', notifLookupErr);
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Force refresh position from blockchain - updates cached database entry price AND oracle prices
  app.post("/api/trading-bots/:id/refresh-position", requireWallet, async (req, res) => {
    console.log(`[RefreshPosition] Force refresh request for botId=${req.params.id}`);
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "No agent wallet" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const refreshBotCtx = getBotSubaccountContext(bot);
      
      // Also force refresh oracle prices while we're at it
      const freshPrices = await forceRefreshPrices();
      console.log(`[RefreshPosition] Refreshed ${Object.keys(freshPrices).length} oracle prices`);
      
      // Force sync from on-chain with zero trade params - this just updates entry price
      const syncResult = await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        `refresh-${Date.now()}`,
        0, // no fee
        0, // no fill price
        '', // no side
        0,  // no size
        refreshBotCtx?.botPublicKey
      );

      if (syncResult.success) {
        console.log(`[RefreshPosition] Successfully refreshed position from blockchain`);
        res.json({ 
          success: true, 
          message: "Position refreshed from blockchain",
          position: syncResult.position
        });
      } else {
        res.status(500).json({ error: syncResult.error || "Failed to refresh" });
      }
    } catch (error) {
      console.error("Refresh position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_deposit',
        amount: String(amount),
        txSignature,
        notes: 'Deposit to agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_withdraw',
        amount: String(-amount),
        txSignature,
        notes: 'Withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-sol-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'sol_deposit',
        amount: String(amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL deposit to agent wallet for gas',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw-sol", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const solBalance = await getAgentSolBalance(wallet.agentPublicKey);
      const SOL_RESERVE = 0.005;
      
      if (amount > (solBalance - SOL_RESERVE)) {
        return res.status(400).json({ error: "Insufficient SOL balance (must keep 0.005 SOL reserve for gas)" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      try {
        const txData = await buildWithdrawSolFromAgentTransaction(
          wallet.agentPublicKey,
          req.walletAddress!,
          agentKeyResult.secretKey,
          amount
        );

        res.json(txData);
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Build agent SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-sol-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'sol_withdraw',
        amount: String(-amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/equity-events", requireWallet, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const botId = req.query.botId as string | undefined;
      
      let events;
      if (botId) {
        // Verify bot ownership
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Forbidden" });
        }
        events = await storage.getBotEquityEvents(botId, limit);
      } else {
        events = await storage.getEquityEvents(req.walletAddress!, limit);
      }
      
      // Enrich events with bot names
      const enrichedEvents = await Promise.all(events.map(async (event: any) => {
        if (event.tradingBotId) {
          const bot = await storage.getTradingBotById(event.tradingBotId);
          return { ...event, botName: bot?.name || null };
        }
        return { ...event, botName: null };
      }));
      
      res.json(enrichedEvents);
    } catch (error) {
      console.error("Get equity events error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:botId/net-deposited", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      // First try bot-specific deposits
      let netDeposited = await storage.getBotNetDeposited(botId);
      
      // For legacy bots on subaccount 0 with no bot-specific deposits,
      // fall back to wallet-level deposits
      if (netDeposited === 0 && (bot.driftSubaccountId === 0 || bot.driftSubaccountId === null)) {
        netDeposited = await storage.getWalletNetDeposited(req.walletAddress!);
      }
      
      // NOTE: Deposit reconciliation disabled — Pacifica uses a single shared account
      // so exchange balance != per-bot balance. DB equity events are the source of truth.
      
      res.json({ netDeposited });
    } catch (error) {
      console.error("Get bot net deposited error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:botId/balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const balBotCtx = getBotSubaccountContext(bot);

      if (balBotCtx) {
        try {
          const liveInfo = await getExchangeAccountInfoForBot(wallet.agentPublicKey!, subAccountId, balBotCtx, getAdapterForBot(bot));
          const livePositions = await getPerpPositions(wallet.agentPublicKey!, subAccountId, balBotCtx, getAdapterForBot(bot));
          const hasOpen = livePositions.some((p: any) => Math.abs(p.baseAssetAmount) > 0.0001);
          return res.json({
            balance: liveInfo.totalCollateral,
            usdcBalance: liveInfo.usdcBalance,
            totalCollateral: liveInfo.totalCollateral,
            freeCollateral: Math.max(0, liveInfo.freeCollateral),
            hasOpenPositions: hasOpen,
            subAccountId: balBotCtx.botPublicKey,
            subaccountExists: true,
            unrealizedPnl: liveInfo.unrealizedPnl,
            source: 'protocol',
          });
        } catch (err: any) {
          console.error(`[BotBalance] Protocol query failed for ${balBotCtx.botPublicKey}: ${err.message}`);
        }
      }
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) { /* prices unavailable */ }

      const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
      const netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
      const position = await storage.getBotPosition(bot.id, bot.market);
      const realizedPnl = parseFloat(position?.realizedPnl || '0');
      const totalFees = parseFloat(position?.totalFees || '0');
      
      let unrealizedPnl = 0;
      const hasOpenPositions = !!(position && Math.abs(parseFloat(position.baseSize)) > 0.0001);
      if (position) {
        const baseSize = parseFloat(position.baseSize);
        const entryPrice = parseFloat(position.avgEntryPrice);
        const markPrice = prices[position.market] || entryPrice;
        if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
          unrealizedPnl = baseSize > 0
            ? (markPrice - entryPrice) * Math.abs(baseSize)
            : (entryPrice - markPrice) * Math.abs(baseSize);
        }
      }
      
      const botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
      const freeCollateral = netDeposited + realizedPnl - totalFees;
      
      res.json({ 
        balance: botBalance,
        usdcBalance: botBalance,
        totalCollateral: botBalance,
        freeCollateral: Math.max(0, freeCollateral),
        hasOpenPositions,
        subAccountId,
        subaccountExists: netDeposited > 0,
      });
    } catch (error) {
      console.error("Get bot balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Consolidated bot overview endpoint - reduces RPC calls from 7-8 to 2-3
  // Combines: /api/bot/:id/balance, /api/bots/:id/drift-balance, /api/bots/:id/net-deposited,
  //           /api/agent/balance, /api/trading-bots/:id/position, /api/user/webhook-url
  app.get("/api/bots/:botId/overview", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const overviewBotCtx = getBotSubaccountContext(bot);
      const overviewQueryAccount = overviewBotCtx ? overviewBotCtx.botPublicKey : wallet.agentPublicKey;
      const overviewQuerySubId = overviewBotCtx ? 0 : subAccountId;
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) { /* prices unavailable */ }

      const results = await Promise.allSettled([
        getAgentUsdcBalance(wallet.agentPublicKey),
        PositionService.getPosition(
          bot.id,
          bot.walletAddress,
          overviewQueryAccount,
          overviewQuerySubId,
          bot.market,
          overviewBotCtx?.botPublicKey
        ),
        storage.getBotNetDeposited(botId),
        storage.getCanonicalBotTradeCount(botId),
        storage.getBotPosition(botId, bot.market),
        storage.getBotEquityEvents(bot.id, 1000),
        overviewBotCtx ? getExchangeAccountInfoForBot(wallet.agentPublicKey, subAccountId, overviewBotCtx, getAdapterForBot(bot)) : Promise.resolve(null),
      ]);
      
      const mainAccountBalance = results[0].status === 'fulfilled' ? results[0].value : 0;
      const posData = results[1].status === 'fulfilled' ? results[1].value : { 
        position: null, 
        source: 'error', 
        driftDetected: false,
        staleWarning: false,
        driftDetails: null,
        healthMetrics: null,
      };
      let netDeposited = results[2].status === 'fulfilled' ? results[2].value : 0;
      const tradeCount = results[3].status === 'fulfilled' ? results[3].value : 0;
      const dbPosition = results[4].status === 'fulfilled' ? results[4].value : null;
      const botEvents = results[5].status === 'fulfilled' ? results[5].value : [];
      const liveAccountInfo = results[6].status === 'fulfilled' ? results[6].value : null;
      
      let accountInfo;
      if (overviewBotCtx && liveAccountInfo) {
        accountInfo = {
          usdcBalance: liveAccountInfo.totalCollateral,
          totalCollateral: liveAccountInfo.totalCollateral,
          freeCollateral: Math.max(0, liveAccountInfo.freeCollateral),
          hasOpenPositions: liveAccountInfo.hasOpenPositions,
          source: 'protocol',
        };
      } else {
        const eventsNetDeposited = (botEvents as any[]).reduce((sum: number, e: any) => sum + parseFloat(e.amount || '0'), 0);
        if (eventsNetDeposited > 0) netDeposited = eventsNetDeposited;
        
        const realizedPnl = parseFloat(dbPosition?.realizedPnl || '0');
        const totalFees = parseFloat(dbPosition?.totalFees || '0');
        
        let unrealizedPnl = 0;
        const hasOpenPositions = !!(dbPosition && Math.abs(parseFloat(dbPosition.baseSize)) > 0.0001);
        if (dbPosition) {
          const baseSize = parseFloat(dbPosition.baseSize);
          const entryPrice = parseFloat(dbPosition.avgEntryPrice);
          const markPrice = prices[dbPosition.market] || entryPrice;
          if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
            unrealizedPnl = baseSize > 0
              ? (markPrice - entryPrice) * Math.abs(baseSize)
              : (entryPrice - markPrice) * Math.abs(baseSize);
          }
        }
        
        const botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
        const botFreeCollateral = Math.max(0, netDeposited + realizedPnl - totalFees);
        
        accountInfo = {
          usdcBalance: botBalance,
          totalCollateral: botBalance,
          freeCollateral: botFreeCollateral,
          hasOpenPositions,
        };
      }
      
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(`[Bot Overview] ${failures.length} calls failed:`, 
          failures.map((f, i) => `[${i}]: ${(f as PromiseRejectedResult).reason}`).join(', '));
      }
      
      // Build position response — use oracle price for currentPrice/unrealizedPnl
      // to match /api/positions behavior (Pacifica may omit mark_price)
      let enrichedCurrentPrice = posData.position?.currentPrice ?? 0;
      let enrichedUnrealizedPnl = posData.position?.unrealizedPnl ?? 0;
      if (posData.position?.hasPosition && posData.position.avgEntryPrice) {
        const oraclePrice = prices[posData.position.market] || prices[bot.market] || 0;
        if (oraclePrice > 0) {
          enrichedCurrentPrice = oraclePrice;
          const baseSize = posData.position.size ?? 0;
          if (baseSize > 0.0001) {
            enrichedUnrealizedPnl = posData.position.side === 'LONG'
              ? (oraclePrice - posData.position.avgEntryPrice) * baseSize
              : (posData.position.avgEntryPrice - oraclePrice) * baseSize;
          }
        }
      }

      const position = posData.position?.hasPosition ? {
        hasPosition: true,
        side: posData.position.side,
        size: posData.position.size,
        avgEntryPrice: posData.position.avgEntryPrice,
        currentPrice: enrichedCurrentPrice,
        unrealizedPnl: enrichedUnrealizedPnl,
        realizedPnl: posData.position.realizedPnl,
        market: posData.position.market,
        source: posData.source,
        staleWarning: posData.staleWarning,
        driftDetected: posData.driftDetected,
        driftDetails: posData.driftDetails,
        healthFactor: posData.healthMetrics?.healthFactor,
        liquidationPrice: posData.healthMetrics?.liquidationPrice,
      } : {
        hasPosition: false,
        source: posData.source,
        driftDetected: posData.driftDetected,
      };
      
      // Construct webhook URL dynamically
      const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? 'https://myquantumvault.com'
        : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';
      const webhookUrl = wallet.userWebhookSecret 
        ? `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${wallet.userWebhookSecret}`
        : null;
      
      res.json({
        // Bot status (for auto-pause detection)
        isActive: bot.isActive,
        pauseReason: bot.pauseReason,
        autoTopUp: bot.autoTopUp,
        
        // From adapter getAccountInfo
        usdcBalance: accountInfo.usdcBalance,
        totalCollateral: accountInfo.totalCollateral,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        subAccountId,
        
        // From getAgentUsdcBalance
        mainAccountBalance,
        
        // From PositionService
        position,
        
        // From database
        netDeposited,
        tradeCount,
        realizedPnl: parseFloat(dbPosition?.realizedPnl || "0"),
        totalFees: parseFloat(dbPosition?.totalFees || "0"),
        
        // Webhook URL (constructed dynamically)
        webhookUrl,
        
        // Indicates if some data may be stale due to failed calls
        partialData: failures.length > 0,
      });
    } catch (error) {
      console.error("Get bot overview error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Trading bot CRUD routes
  app.get("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);
      const wallet = await storage.getWallet(req.walletAddress!);
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) { /* prices unavailable */ }

      const enrichedBots = await Promise.all(bots.map(async (bot) => {
        const botCtx = getBotSubaccountContext(bot);
        const [tradeCount, position, publishedBot] = await Promise.all([
          storage.getCanonicalBotTradeCount(bot.id),
          storage.getBotPosition(bot.id, bot.market),
          storage.getPublishedBotByTradingBotId(bot.id),
        ]);
        
        let netDeposited = 0;
        let totalDeposits = 0;
        let botBalance = 0;
        let netPnl = 0;
        let netPnlPercent = 0;
        
        try {
          const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
          netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
          totalDeposits = botEvents.reduce((sum, e) => {
            const amt = parseFloat(e.amount || '0');
            return amt > 0 ? sum + amt : sum;
          }, 0);

          if (botCtx && wallet?.agentPublicKey) {
            const liveInfo = await getExchangeAccountInfoForBot(wallet.agentPublicKey, 0, botCtx, getAdapterForBot(bot));
            botBalance = liveInfo.totalCollateral;
            netPnl = botBalance - netDeposited;
            netPnlPercent = totalDeposits > 0 ? (netPnl / totalDeposits) * 100 : 0;
          } else {
            const realizedPnl = parseFloat(position?.realizedPnl || '0');
            const totalFees = parseFloat(position?.totalFees || '0');
            
            let unrealizedPnl = 0;
            if (position) {
              const baseSize = parseFloat(position.baseSize);
              const entryPrice = parseFloat(position.avgEntryPrice);
              const markPrice = prices[position.market] || entryPrice;
              if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
                unrealizedPnl = baseSize > 0
                  ? (markPrice - entryPrice) * Math.abs(baseSize)
                  : (entryPrice - markPrice) * Math.abs(baseSize);
              }
            }
            
            botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
            netPnl = botBalance - netDeposited;
            netPnlPercent = totalDeposits > 0 ? (netPnl / totalDeposits) * 100 : 0;
          }
        } catch (err) {
          console.warn(`[trading-bots] Failed to calculate net PnL for bot ${bot.id}:`, err);
        }
        
        return {
          ...bot,
          actualTradeCount: tradeCount,
          realizedPnl: position?.realizedPnl || "0",
          totalFees: position?.totalFees || "0",
          exchangeBalance: botBalance,
          netDeposited,
          netPnl,
          netPnlPercent,
          isPublished: !!publishedBot && publishedBot.isActive,
          publishedBotId: publishedBot?.id || null,
          botSubaccountIdentifier: bot.protocolSubaccountId || null,
        };
      }));
      
      res.json(enrichedBots);
    } catch (error) {
      console.error("Get trading bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig } = req.body;
      
      if (!name || !market) {
        return res.status(400).json({ error: "Name and market are required" });
      }

      const nonTradable = isMarketNonTradable(market);
      if (nonTradable === true) {
        return res.status(400).json({ error: `${market} is reduce-only or delisted on Drift — new positions cannot be opened` });
      }

      // Ensure wallet exists before creating bot
      const wallet = await storage.getOrCreateWallet(req.walletAddress!);
      
      // Server-side SOL balance check for bot creation
      if (wallet.agentPublicKey) {
        const [solBalance, exchangeAccountExists] = await Promise.all([
          getAgentSolBalance(wallet.agentPublicKey),
          subaccountExists(wallet.agentPublicKey, 0),
        ]);
        
        const TRADING_GAS = 0.005;
        const requiredSol = TRADING_GAS;
        
        if (solBalance < requiredSol) {
          const deficit = requiredSol - solBalance;
          return res.status(400).json({ 
            error: `Insufficient SOL for transaction fees. Need ${requiredSol.toFixed(3)} SOL, have ${solBalance.toFixed(4)} SOL. Please deposit at least ${deficit.toFixed(3)} SOL to your agent wallet.` 
          });
        }
      }

      const webhookSecret = generateWebhookSecret();
      
      let nextSubaccountId: number = 0;
      let botSubaccountPublicKey: string | null = null;
      // V3 Phase 5b: the legacy `bot_subaccount_key_encrypted` column is no
      // longer written for new bots. Phase 4b's V3 path (post-insert) is the
      // only writer, and `bot_subaccount_key_encrypted_v3` is the only column
      // populated. Phase 6 will drop the legacy column entirely.
      let pendingBotSecretKeyForV3: Uint8Array | null = null;
      let subaccountStatus: string = 'none';
      // 12h Option A: holds the adapter-returned canonical numeric subaccount ID for
      // `main_plus_id` mode (Drift). For `external_key` mode (Pacifica) this stays null
      // because the adapter returns a pubkey string, not a numeric ID. When set, this
      // value (not the pre-allocated `nextSubaccountId`) is persisted into the legacy
      // `driftSubaccountId` column to keep DB and on-chain state in sync.
      let adapterReturnedNumericSubaccountId: number | null = null;
      // Phase 4b (Flash agent-HD wallets): the non-secret HD index + path version for
      // an agent_hd bot, carried across the bot insert below. NULL for legacy random
      // bots. `_botAgentMnemonic` holds the decrypted recovery phrase only long enough
      // to derive the bot wallet, then is zeroized.
      let botDerivationIndex: number | null = null;
      let botDerivationPathVersion: number | null = null;
      let _botAgentMnemonic: Buffer | null = null;
      // Subaccount Recycling Plan §8 (Phase E) — when a create reuses a pooled spare
      // instead of provisioning fresh, this carries the claim across the bot insert so
      // the post-insert block can rebind the retained key onto the new bot row and
      // CAS-finalize the reservation. Null ⇒ a normal (fresh-provision) create.
      let _reuseContext: {
        claimToken: string;
        protocol: string;
        protocolSubaccountId: string;
        agentPublicKey: string;
        currentEncryptedV3: string;
        currentAadVersion: number;
        legacyBotId: string | null;
      } | null = null;

      // Phase 5: create the bot against the protocol the client selected (defaults to
      // the platform default adapter). Only pacifica + flash are user-selectable; drift
      // is retired (no new bots). getAdapter fails closed on an unknown/unregistered
      // protocol, so an invalid value can never silently fall back to the default.
      const requestedProtocol = String((req.body as any).activeProtocol ?? getDefaultAdapter().protocolName).toLowerCase();
      if (requestedProtocol !== 'pacifica' && requestedProtocol !== 'flash') {
        return res.status(400).json({ error: `Unsupported protocol: ${requestedProtocol}` });
      }
      const createAdapter = getAdapter(requestedProtocol);
      const createCaps = createAdapter.getCapabilities();
      const subaccountAuthMode: 'external_key' | 'main_plus_id' =
        createCaps.requiresExternalSubaccountKey ? 'external_key' : 'main_plus_id';

      if (wallet.agentPublicKey && wallet.agentPrivateKeyEncryptedV3) {
        const { Keypair } = await import('@solana/web3.js');

        console.log(`[BotCreate][RekeyGuard] wallet=${req.walletAddress!.slice(0,8)}... agentPub=${wallet.agentPublicKey.slice(0,8)}... umkVersion=${(wallet as any).umkVersion} executionEnabled=${(wallet as any).executionEnabled} hasUmkExec=${!!(wallet as any).umkEncryptedForExecution} hasAgentV3=${!!wallet.agentPrivateKeyEncryptedV3} hasLegacy=${!!(wallet as any).agentPrivateKeyEncrypted} emergencyStop=${(wallet as any).emergencyStopTriggered}`);
        const _botCreateUmk = await getUmkForWebhook(req.walletAddress!);
        if (!_botCreateUmk) {
          console.error(`[BotCreate][RekeyGuard] FAIL_AT=getUmkForWebhook wallet=${req.walletAddress!.slice(0,8)}...`);
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }

        // Self-heal step (mirrors /api/exchange/deposit): probe the stored V3
        // ciphertext; if it was encrypted under a different UMK (UMK-init race
        // damage mode), re-migrate from legacy using the current UMK before
        // the strict decrypt below. Without this, users hit by the race see
        // a hard "needs to be re-keyed" wall when deploying a bot.
        // try/finally guarantees the UMK buffer is zeroized even if repair,
        // wallet refresh, or strict-decrypt throws — secrets must not outlive
        // the synchronous decrypt window.
        let _botCreateAgentKey: { secretKey: Uint8Array; cleanup: () => void } | null;
        let _botCreateRepair: 'ok' | 'repaired' | 'unrepairable' = 'ok';
        let _botCreateWallet = wallet;
        try {
          _botCreateRepair = await repairStaleV3AgentKeyFromLegacy(req.walletAddress!, _botCreateUmk.umk);
          if (_botCreateRepair === 'repaired') {
            const refreshed = await storage.getWallet(req.walletAddress!);
            if (refreshed) _botCreateWallet = refreshed;
          }
          _botCreateAgentKey = await decryptAgentKeyStrict(req.walletAddress!, _botCreateUmk.umk, _botCreateWallet, _botCreateWallet.agentPublicKey);
          // Phase 4b (Flash agent-HD wallets): while the UMK is still live, decrypt the
          // agent recovery phrase so we can derive a recoverable per-bot wallet below.
          // Only for agent_hd adapters (Flash) — minimizes the mnemonic's blast radius.
          if (_botCreateAgentKey && createCaps.walletDerivation === 'agent_hd') {
            _botAgentMnemonic = await decryptMnemonic(req.walletAddress!, _botCreateUmk.umk);
          }
        } finally {
          _botCreateUmk.cleanup();
        }
        if (!_botCreateAgentKey) {
          console.error(`[BotCreate][RekeyGuard] FAIL_AT=decryptAgentKeyStrict wallet=${req.walletAddress!.slice(0,8)}... expectedAgentPub=${_botCreateWallet.agentPublicKey?.slice(0,8) ?? 'null'}... repair=${_botCreateRepair}`);
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        // Phase 4b (Flash agent-HD wallets): agent_hd REQUIRES a recoverable seed. If
        // the wallet has no recovery phrase on file, fail closed — never silently fall
        // back to an unrecoverable random key (that would defeat the whole point).
        if (createCaps.walletDerivation === 'agent_hd' && !_botAgentMnemonic) {
          console.error(`[BotCreate][AgentHD] FAIL_AT=decryptMnemonic wallet=${req.walletAddress!.slice(0,8)}... — agent_hd requires a recovery phrase`);
          _botCreateAgentKey.cleanup();
          return res.status(400).json({ error: "This wallet has no recovery phrase on file, which is required to create a recoverable Flash bot. Please sign out and sign back in to re-key your wallet." });
        }
        const agentKeypair = resolveAgentKeypair(_botCreateAgentKey.secretKey);
        const adapter = createAdapter;
        const caps = createCaps;

        let botKeypair: import('@solana/web3.js').Keypair | null = null;
        if (caps.requiresExternalSubaccountKey) {
          if (caps.walletDerivation === 'agent_hd') {
            // Recoverable per-bot wallet: allocate a monotonic, never-reused HD index
            // (burn-on-allocate) and derive from the agent seed. The encrypted key
            // written post-insert is only a hot-path cache — seed + index is the real
            // recovery source. Zeroize the mnemonic the instant we're done with it.
            botDerivationIndex = await storage.allocateBotDerivationIndex(req.walletAddress!);
            botDerivationPathVersion = BOT_DERIVATION_PATH_VERSION;
            try {
              botKeypair = deriveBotKeypairFromAgentSeed(_botAgentMnemonic!, botDerivationIndex, botDerivationPathVersion);
            } finally {
              _botAgentMnemonic?.fill(0);
              _botAgentMnemonic = null;
            }
          } else {
            botKeypair = Keypair.generate();
          }
        }

        // Pacifica atomic provision path: if the active adapter is Pacifica and a
        // funding amount was provided, use provisionFundedSubaccount which handles
        // the deposit-to-register quirk (Pacifica only registers the main_account
        // record on first deposit). For existing accounts the deposit step is
        // skipped automatically via the gap calc inside the adapter method.
        //
        // QuantumLab sends `initialFundingAmount` separately when it wants to deposit
        // more than `totalInvestment` (e.g. trade size + drawdown-protection buffer).
        // Fall back to totalInvestment when not provided so other clients (CreateBotModal)
        // continue to work unchanged.
        const initialFundingRaw = (req.body as any).initialFundingAmount;
        const initialFundingNum = initialFundingRaw != null ? Number(initialFundingRaw) : NaN;
        const fundingAmountNum = Number.isFinite(initialFundingNum) && initialFundingNum > 0
          ? initialFundingNum
          : (totalInvestment ? Number(totalInvestment) : 0);
        const usePacificaAtomicProvision =
          adapter.protocolName === 'pacifica' &&
          botKeypair !== null &&
          Number.isFinite(fundingAmountNum) &&
          fundingAmountNum > 0;

        // Flash atomic provision path: each Flash bot owns its OWN minted Solana
        // wallet (botKeypair). We fund it from the agent wallet in one atomic tx
        // (SOL seed + USDC collateral). The bot.id is NOT needed for funding (the
        // recipient is just an address), so this runs here in the pre-insert block
        // while the agent key is still in scope.
        const useFlashAtomicProvision =
          adapter.protocolName === 'flash' &&
          botKeypair !== null &&
          Number.isFinite(fundingAmountNum) &&
          fundingAmountNum > 0;

        console.log(`[Bot Creation] Creating ${adapter.protocolName} subaccount under agent ${agentKeypair.publicKey.toString()}${botKeypair ? ` with pre-generated sub key ${botKeypair.publicKey.toString()}` : ''}${usePacificaAtomicProvision ? ` (atomic provision, fundingAmount=$${fundingAmountNum})` : ''}${useFlashAtomicProvision ? ` (flash per-bot wallet, fundingAmount=$${fundingAmountNum})` : ''}`);

        // Subaccount Recycling Plan §8 (Phase E) — reuse on create. Behind the
        // REUSE_ON_CREATE kill switch (default OFF) AND the adapter's `recyclable`
        // capability, try to drain the spare pool before provisioning fresh. ALL the
        // Pacifica work (verify-empty + re-fund) happens HERE, outside any DB lock; the
        // only DB writes are the atomic claim / quarantine / release. On success the
        // post-insert block rebinds the retained key onto the new bot row and finalizes
        // the claim. On no-spare / any failure we fall through to fresh provisioning so
        // the user still gets a working bot.
        let reuseHandled = false;
        const attemptReuse =
          isReuseOnCreateEnabled() &&
          usePacificaAtomicProvision &&
          adapter.subaccountCaps?.recyclable === true &&
          typeof (adapter as any).reuseSubaccount === 'function' &&
          typeof adapter.verifySubaccountEmpty === 'function';

        if (attemptReuse) {
          const { randomUUID } = await import('crypto');
          const claimToken = randomUUID();
          const agentPub = agentKeypair.publicKey.toString();
          const spare = await storage.claimSpareSubaccount({
            walletAddress: req.walletAddress!,
            protocol: adapter.protocolName,
            agentPublicKey: agentPub,
            claimToken,
          });
          if (spare && spare.protocolSubaccountId && spare.subaccountKeyEncryptedV3 && spare.aadVersion != null) {
            const subId = spare.protocolSubaccountId;
            try {
              const isEmpty = await adapter.verifySubaccountEmpty!({ agentPublicKey: agentPub, subaccountId: subId });
              if (!isEmpty) {
                // Residual funds/positions/orders — not safe to reuse. Quarantine the
                // slot (out of the pool) and fall through to fresh provisioning.
                console.warn(`[Bot Creation][Reuse] spare ${subId} failed verify-empty; quarantining and provisioning fresh`);
                await storage.markSubaccountStuckFunds({
                  walletAddress: req.walletAddress!,
                  protocol: adapter.protocolName,
                  protocolSubaccountId: subId,
                  botId: null,
                  agentPublicKey: agentPub,
                  lastError: 'reuse verify-empty returned false (residual funds/positions/orders)',
                  claimToken,
                });
              } else {
                await storage.markSubaccountVerifiedEmpty(adapter.protocolName, subId);
                const pacificaAdapter = adapter as import('./protocol/pacifica/pacifica-adapter').PacificaAdapter;
                const reuseResult = await pacificaAdapter.reuseSubaccount!({
                  mainSecretKey: agentKeypair.secretKey,
                  agentPublicKey: agentPub,
                  subaccountId: subId,
                  fundingAmount: fundingAmountNum,
                });
                botSubaccountPublicKey = subId;
                // Stay 'pending' until the post-insert rebind writes the bot-row key,
                // mirroring the fresh-provision path's CHECK-constraint handling.
                subaccountStatus = 'pending';
                _reuseContext = {
                  claimToken,
                  protocol: adapter.protocolName,
                  protocolSubaccountId: subId,
                  agentPublicKey: agentPub,
                  currentEncryptedV3: spare.subaccountKeyEncryptedV3,
                  currentAadVersion: spare.aadVersion,
                  legacyBotId: spare.botId,
                };
                (req as any)._pacificaProvisionResult = {
                  funded: reuseResult.transferSucceeded,
                  wasNewAccount: false,
                  depositTxSignature: reuseResult.depositTxSignature,
                  warning: reuseResult.warning,
                  fundedAmount: reuseResult.transferSucceeded ? fundingAmountNum : 0,
                };
                reuseHandled = true;
                console.log(`[Bot Creation][Reuse] reused spare subaccount=${subId} funded=${reuseResult.transferSucceeded}${reuseResult.warning ? ` warning="${reuseResult.warning}"` : ''}`);
              }
            } catch (reuseErr: any) {
              // Reuse failed AFTER claiming. reuseSubaccount keeps funds safe in the
              // main account on any failure, and the slot is still a verified-empty
              // spare, so return it to the pool and fall through to fresh provisioning.
              console.error(`[Bot Creation][Reuse] reuse failed for spare ${subId}, releasing and provisioning fresh:`, reuseErr?.message || reuseErr);
              try {
                await storage.releaseReservationToSpare({ protocol: adapter.protocolName, protocolSubaccountId: subId, claimToken });
              } catch (relErr: any) {
                console.error(`[Bot Creation][Reuse] failed to release reservation ${subId}:`, relErr?.message || relErr);
              }
            }
          } else if (spare && spare.protocolSubaccountId) {
            // Claimed a row missing its retained key/version (claim filters these out,
            // so this is defensive). Return it to the pool rather than strand it.
            console.warn(`[Bot Creation][Reuse] claimed spare ${spare.protocolSubaccountId} missing key/version; releasing`);
            try {
              await storage.releaseReservationToSpare({ protocol: adapter.protocolName, protocolSubaccountId: spare.protocolSubaccountId, claimToken });
            } catch { /* best-effort */ }
          }
        }

        try {
          if (usePacificaAtomicProvision && !reuseHandled) {
            const pacificaAdapter = adapter as import('./protocol/pacifica/pacifica-adapter').PacificaAdapter;
            const result = await pacificaAdapter.provisionFundedSubaccount({
              mainSecretKey: agentKeypair.secretKey,
              subSecretKey: botKeypair!.secretKey,
              agentPublicKey: agentKeypair.publicKey.toString(),
              fundingAmount: fundingAmountNum,
            });

            botSubaccountPublicKey = result.subaccountId;
            pendingBotSecretKeyForV3 = botKeypair!.secretKey;
            // Phase 4b: leave status as 'pending' until V3 ciphertext is written
            // post-insert. This keeps the CHECK constraint (external_key+active ⇒ key)
            // satisfied because at insert time we have no key yet.
            subaccountStatus = 'pending';

            // Stash provisioning result for the response builder below.
            (req as any)._pacificaProvisionResult = {
              funded: result.transferSucceeded,
              wasNewAccount: result.wasNewAccount,
              depositTxSignature: result.depositTxSignature,
              warning: result.warning,
              fundedAmount: result.transferSucceeded ? fundingAmountNum : 0,
            };

            console.log(`[Bot Creation] Pacifica atomic provision done: subaccount=${botSubaccountPublicKey} wasNew=${result.wasNewAccount} transferred=${result.transferSucceeded}${result.warning ? ` warning="${result.warning}"` : ''}`);

            // Task 143: proactively warm builder-code approval + referral claim
            // for the user's main account now that it exists on Pacifica. This
            // makes the FIRST trade already tagged with our builder_code. The
            // adapter retries on the next trade if this fails — never block
            // bot creation on enrollment.
            try {
              const pacificaAdapter = adapter as import('./protocol/pacifica/pacifica-adapter').PacificaAdapter;
              const agentPub = agentKeypair.publicKey.toString();
              await Promise.allSettled([
                pacificaAdapter.approveBuilderCodeForUser({
                  agentPublicKey: agentPub,
                  agentSecretKey: agentKeypair.secretKey,
                }),
                pacificaAdapter.claimReferralCodeForUser({
                  agentPublicKey: agentPub,
                  agentSecretKey: agentKeypair.secretKey,
                }),
              ]);
            } catch (enrollErr: any) {
              console.warn('[Bot Creation] Pacifica enrollment warm-up failed (non-fatal, retries on next trade):', enrollErr?.message || enrollErr);
            }
          } else if (useFlashAtomicProvision && !reuseHandled) {
            // Flash: mint-and-fund the bot's OWN wallet atomically from the agent
            // wallet. If the funding tx fails, NO funds move (atomic) and we throw
            // → caught below → 500 with nothing stranded and no bot row inserted.
            const flashAdapter = adapter as import('./protocol/flash/flash-adapter').FlashAdapter;
            const result = await flashAdapter.provisionBotWallet({
              mainSecretKey: agentKeypair.secretKey,
              subSecretKey: botKeypair!.secretKey,
              fundingAmount: fundingAmountNum,
            });

            botSubaccountPublicKey = result.subaccountId;
            pendingBotSecretKeyForV3 = botKeypair!.secretKey;
            // Phase 4b: stay 'pending' until the V3 ciphertext is written post-insert.
            subaccountStatus = 'pending';

            if (result.ambiguous) {
              // The funding tx was sent but its on-chain outcome could NOT be
              // confirmed (RPC degraded) — it MAY have committed. Do NOT discard
              // the key/funds. Let the flow below insert the bot row AND persist
              // the encrypted key, but flag the bot 'error' (action-required) and
              // do NOT treat it as funded. Deleting the bot later sweeps any landed
              // funds back to the agent wallet via the Flash delete safeguard.
              (req as any)._flashProvisionAmbiguous = {
                txSignature: result.txSignature,
                walletAddress: botSubaccountPublicKey,
              };
              console.error(`[Bot Creation] Flash funding AMBIGUOUS — wallet=${botSubaccountPublicKey} tx=${result.txSignature}; persisting bot+key in 'error' state for recovery`);
            } else if (!result.transferSucceeded) {
              throw new Error(result.warning || 'Flash bot wallet funding failed');
            } else {
              (req as any)._flashProvisionResult = {
                funded: true,
                depositTxSignature: result.txSignature,
                fundedAmount: result.fundedAmount,
                solSeeded: result.solSeeded,
              };
              console.log(`[Bot Creation] Flash per-bot wallet provisioned: wallet=${botSubaccountPublicKey} funded=$${result.fundedAmount} solSeed=${result.solSeeded} tx=${result.txSignature}`);
            }
          } else if (!usePacificaAtomicProvision && !useFlashAtomicProvision) {
            const sub = await adapter.createSubaccount({
              mainSecretKey: agentKeypair.secretKey,
              subSecretKey: botKeypair?.secretKey,
              agentPublicKey: agentKeypair.publicKey.toString(),
            });

            // Task 143: warm enrollment for the non-atomic branch too (Drift
            // bots skip this — adapter check inside is safe because helpers
            // are no-ops without config). Non-fatal.
            if (adapter.protocolName === 'pacifica') {
              try {
                const pacificaAdapter = adapter as import('./protocol/pacifica/pacifica-adapter').PacificaAdapter;
                const agentPub = agentKeypair.publicKey.toString();
                await Promise.allSettled([
                  pacificaAdapter.approveBuilderCodeForUser({
                    agentPublicKey: agentPub,
                    agentSecretKey: agentKeypair.secretKey,
                  }),
                  pacificaAdapter.claimReferralCodeForUser({
                    agentPublicKey: agentPub,
                    agentSecretKey: agentKeypair.secretKey,
                  }),
                ]);
              } catch (enrollErr: any) {
                console.warn('[Bot Creation] Pacifica enrollment warm-up failed (non-fatal, retries on next trade):', enrollErr?.message || enrollErr);
              }
            }

            botSubaccountPublicKey = sub.subaccountId;
            if (botKeypair) {
              pendingBotSecretKeyForV3 = botKeypair.secretKey;
              // Phase 4b: stay 'pending' until post-insert V3 write succeeds.
              subaccountStatus = 'pending';
            } else {
              subaccountStatus = 'active';
            }

            // 12h Option A: For `main_plus_id` mode (Drift), the adapter is the canonical
            // source of the numeric subaccount ID. Parse and validate it now; we'll
            // reconcile against the pre-allocated `nextSubaccountId` once that's computed.
            // Group D item 17d: validation lifted into shared helper so the marketplace
            // creation path (which now also calls adapter.createSubaccount) applies the
            // identical contract.
            if (subaccountAuthMode === 'main_plus_id') {
              try {
                adapterReturnedNumericSubaccountId = parseAndValidateAdapterSubaccountId(
                  sub.subaccountId,
                  adapter.protocolName,
                );
              } catch (validationErr: any) {
                console.error(`[Bot Creation] ${validationErr.message}`);
                _botCreateAgentKey.cleanup();
                _botCreateUmk.cleanup();
                return res.status(500).json({
                  error: `Failed to create trading subaccount: adapter returned invalid subaccount ID format`,
                });
              }
            }
          }

          console.log(`[Bot Creation] ${adapter.protocolName} subaccount created: ${botSubaccountPublicKey}`);
        } catch (subErr: any) {
          console.error(`[Bot Creation] ${adapter.protocolName} subaccount creation failed:`, subErr.message);
          _botCreateAgentKey.cleanup();
          _botCreateUmk.cleanup();
          return res.status(500).json({ error: `Failed to create trading subaccount: ${subErr.message}` });
        }
        _botCreateAgentKey.cleanup();
        _botCreateUmk.cleanup();
      }

      try {
        const dbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
        if (wallet.agentPublicKey) {
          const existingOnChain = await discoverOnChainSubaccounts(wallet.agentPublicKey);
          const dbIdSet = new Set(dbAllocatedIds);
          for (const subId of existingOnChain) {
            if (subId > 0 && !dbIdSet.has(subId)) {
              try {
                const orphanedWebhookSecret = generateWebhookSecret();
                const orphanedBot = await storage.createTradingBot({
                  walletAddress: req.walletAddress!,
                  name: `Recovered Bot (SA${subId})`,
                  market: 'SOL-PERP',
                  webhookSecret: orphanedWebhookSecret,
                  driftSubaccountId: subId,
                  isActive: false,
                  side: 'both',
                  leverage: 1,
                  totalInvestment: '0',
                  maxPositionSize: null,
                  signalConfig: { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
                  riskConfig: {},
                  subaccountAuthMode: 'main_plus_id',
                  // Group D item 18: orphan recovery in main bot-creation flow scans
                  // on-chain Drift subaccounts via discoverOnChainSubaccounts; any bot
                  // created here is by definition a Drift bot.
                  activeProtocol: 'drift',
                } as any);
                console.log(`[Bot Creation] Created recovered bot ${orphanedBot.id} for orphaned subaccount ${subId}`);
              } catch (syncErr: any) {
                console.error(`[Bot Creation] Failed to create placeholder for subaccount ${subId}:`, syncErr.message);
              }
            }
          }
          const updatedDbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
          nextSubaccountId = await getNextOnChainSubaccountId(wallet.agentPublicKey, updatedDbAllocatedIds);
        } else {
          const usedSet = new Set(dbAllocatedIds);
          nextSubaccountId = 1;
          while (usedSet.has(nextSubaccountId)) nextSubaccountId++;
        }
      } catch (error) {
        console.error(`[Bot Creation] Subaccount ID fallback:`, error);
        nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      }

      // 12h Option A: For `main_plus_id` mode (Drift), prefer the adapter's canonical
      // numeric ID over the pre-allocated `nextSubaccountId`. They should match — if
      // they don't, the adapter's value is the source of truth (it reflects what was
      // actually created on-chain) and we log the divergence loudly.
      const persistedDriftSubaccountId = adapterReturnedNumericSubaccountId ?? nextSubaccountId;
      if (
        adapterReturnedNumericSubaccountId !== null &&
        adapterReturnedNumericSubaccountId !== nextSubaccountId
      ) {
        console.warn(
          `[Bot Creation] Subaccount ID divergence: pre-allocated=${nextSubaccountId}, adapter-returned=${adapterReturnedNumericSubaccountId}. ` +
          `Persisting adapter value as canonical (driftSubaccountId=${adapterReturnedNumericSubaccountId}).`
        );
      }

      const bot = await storage.createTradingBot({
        walletAddress: req.walletAddress!,
        name,
        market,
        webhookSecret,
        driftSubaccountId: persistedDriftSubaccountId,
        protocolSubaccountId: botSubaccountPublicKey,
        // Group D item 18 (April 17, 2026): always tag the bot with the adapter that
        // created it, regardless of subaccount auth mode. The previous conditional
        // (botSubaccountPublicKey ? ... : null) only emitted a value for `external_key`
        // mode (Pacifica's keypair-generation branch). For `main_plus_id` mode bots
        // (Drift) it would have written NULL, which the new schema CHECK constraint
        // forbids. The tag is a property of the protocol the bot was created against,
        // not of how its subaccount is authed — both modes need the tag.
        activeProtocol: createAdapter.protocolName,
        subaccountStatus,
        subaccountAuthMode,
        isActive: true,
        side: side || 'both',
        leverage: leverage || 1,
        totalInvestment: totalInvestment ? String(totalInvestment) : '100',
        maxPositionSize: maxPositionSize || null,
        signalConfig: signalConfig || { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
        riskConfig: riskConfig || {},
        // Phase 4b (Flash agent-HD wallets): non-secret HD index + path version so the
        // per-bot wallet stays re-derivable from the agent seed. NULL for random bots.
        derivationIndex: botDerivationIndex,
        derivationPathVersion: botDerivationPathVersion,
      } as any);

      const webhookUrl = generateWebhookUrl(bot.id, webhookSecret);
      await storage.updateTradingBot(bot.id, { webhookUrl } as any);

      // Phase 4b: write V3 ciphertext for the bot-subaccount key now that we have bot.id.
      // We require the UMK to encrypt V3. Prefer the execution-UMK envelope
      // (same source the rekey guard at line ~6615 uses) and fall back to the
      // in-memory session UMK only if execution isn't enabled. Without this
      // fallback any bot creation where the browser session doesn't carry a
      // materialised UMK fails AFTER the Pacifica deposit+transfer has already
      // landed funds in the new subaccount — orphaning the deposit.
      // try/finally zeroizes both the temp UMK and the pending bot secret.
      if (pendingBotSecretKeyForV3) {
        let _botSubUmk: { umk: Buffer; cleanup: () => void } | null = null;
        try {
          _botSubUmk = await getUmkForWebhook(req.walletAddress!);
          let umkBuf: Buffer | null = _botSubUmk ? _botSubUmk.umk : null;
          if (!umkBuf) {
            const sessionRes = getSessionByWalletAddress(req.walletAddress!);
            if (!sessionRes) {
              throw new Error('No active session available to derive bot-subaccount subkey');
            }
            umkBuf = sessionRes.session.umk;
          }
          const v3Ciphertext = encryptBotSubaccountKeyV3(
            umkBuf,
            Buffer.from(pendingBotSecretKeyForV3),
            req.walletAddress!,
            bot.id,
          );
          await storage.updateBotSubaccountKeyV3(bot.id, v3Ciphertext);
          // Ambiguous Flash funding stays 'error' (action-required) even though the
          // key persisted — we are NOT sure the funds actually landed. Everything
          // else goes 'active'.
          await storage.updateTradingBot(bot.id, {
            subaccountStatus: (req as any)._flashProvisionAmbiguous ? 'error' : 'active',
          } as any);
        } catch (v3Err: any) {
          console.error(`[Bot Creation] Failed to write V3 bot-subaccount key for bot ${bot.id}:`, v3Err.message);
          // Flash: provisionBotWallet already moved funds into the bot's OWN wallet.
          // The V3 key was NOT persisted, so the in-memory key (zeroized in the
          // finally below) is the ONLY copy. Sweep funds back to the agent wallet
          // NOW, and only delete the row once the wallet is CONFIRMED empty. If the
          // sweep fails or any USDC remains, do NOT delete — that would discard the
          // last key reference AND the audit trail. Instead preserve the row as
          // 'error' and fail closed so the stranded wallet stays traceable.
          if (createAdapter.protocolName === 'flash' && wallet?.agentPublicKey) {
            const flashAdapter = createAdapter as import('./protocol/flash/flash-adapter').FlashAdapter;
            let swept = false;
            for (let attempt = 0; attempt < 2 && !swept; attempt++) {
              try {
                const rollback = await flashAdapter.sweepBotWallet({
                  subSecretKey: pendingBotSecretKeyForV3,
                  destWalletAddress: wallet.agentPublicKey,
                });
                if (rollback.error) {
                  console.error(`[Bot Creation] Flash rollback sweep attempt ${attempt + 1} failed: ${rollback.error}`);
                } else {
                  console.warn(`[Bot Creation] Flash rollback swept $${rollback.usdcSwept.toFixed(6)} USDC + ${rollback.solReclaimed.toFixed(6)} SOL back to agent wallet`);
                }
              } catch (sweepErr: any) {
                console.error(`[Bot Creation] Flash rollback sweep attempt ${attempt + 1} threw: ${sweepErr?.message || sweepErr}`);
              }
              // Trust the sweep only after the bot wallet is verified empty of BOTH
              // USDC and reclaimable SOL. Reads fail CLOSED (any error ⇒ not swept).
              let residualUsdc = -1, residualSol = Number.POSITIVE_INFINITY;
              try {
                residualUsdc = await flashAdapter.getWalletCollateralBalanceStrict(botSubaccountPublicKey!);
                residualSol = await flashAdapter.getWalletSolBalance(botSubaccountPublicKey!);
              } catch { /* leave sentinels → not swept */ }
              if (residualUsdc === 0 && residualSol <= 0.001) swept = true;
            }
            if (!swept) {
              // Funds may remain in the bot wallet whose key we are about to lose.
              // Preserve the row (status 'error') so the wallet address stays on
              // record, and tell the user funds may be stranded. Fail closed.
              try { await storage.updateTradingBot(bot.id, { subaccountStatus: 'error' } as any); } catch {}
              console.error(`[Bot Creation] CRITICAL: Flash rollback could not confirm empty wallet ${botSubaccountPublicKey} — preserving bot row ${bot.id} for recovery`);
              return res.status(500).json({
                error: `Failed to secure bot subaccount key and could not fully return funds. Your bot wallet ${botSubaccountPublicKey} may still hold funds — please contact support before creating another bot.`,
              });
            }
          }
          // Wallet confirmed empty (or non-Flash) — safe to delete the row.
          try { await storage.deleteTradingBot(bot.id); } catch {}
          return res.status(500).json({ error: `Failed to secure bot subaccount key: ${v3Err.message}` });
        } finally {
          try { _botSubUmk?.cleanup(); } catch {}
          // Zeroize the secret key buffer we held in memory.
          try { pendingBotSecretKeyForV3.fill(0); } catch {}
        }
      } else if (_reuseContext) {
        // Subaccount Recycling Plan §8 (Phase E) reuse finalize. Rebind the retained
        // spare key onto the NEW bot row (under its bot-UUID AAD) so the unchanged
        // read path keeps working, then CAS the reservation to active. The rebind
        // re-verifies the key's pubkey matches the subaccount before writing
        // (fund-safety) and never touches legacy crypto. Same UMK-source +
        // try/finally zeroize discipline as the fresh-provision path above.
        let _reuseUmk: { umk: Buffer; cleanup: () => void } | null = null;
        try {
          _reuseUmk = await getUmkForWebhook(req.walletAddress!);
          let umkBuf: Buffer | null = _reuseUmk ? _reuseUmk.umk : null;
          if (!umkBuf) {
            const sessionRes = getSessionByWalletAddress(req.walletAddress!);
            if (!sessionRes) {
              throw new Error('No active session available to derive bot-subaccount subkey');
            }
            umkBuf = sessionRes.session.umk;
          }
          const rebind = rebindRetainedKeyToBotUuidV3({
            umk: umkBuf,
            currentEncryptedV3: _reuseContext.currentEncryptedV3,
            currentAadVersion: _reuseContext.currentAadVersion,
            protocol: _reuseContext.protocol,
            walletAddress: req.walletAddress!,
            protocolSubaccountId: _reuseContext.protocolSubaccountId,
            newBotId: bot.id,
            legacyBotId: _reuseContext.legacyBotId,
          });
          if (!rebind) {
            throw new Error(`retained-key rebind failed (pubkey verification) for reused subaccount ${_reuseContext.protocolSubaccountId}`);
          }
          await storage.updateBotSubaccountKeyV3(bot.id, rebind.encryptedV3);
          await storage.updateTradingBot(bot.id, { subaccountStatus: 'active' } as any);
          const finalized = await storage.finalizeReusedSubaccount({
            protocol: _reuseContext.protocol,
            protocolSubaccountId: _reuseContext.protocolSubaccountId,
            claimToken: _reuseContext.claimToken,
            botId: bot.id,
          });
          if (!finalized) {
            // Lease TTL (10m) ≫ reuse duration, so this is effectively unreachable. If
            // it ever happens the recovery job reclaimed the slot mid-flight; the bot
            // already holds the key and the funds are in the subaccount, so keep the bot
            // active and log loudly for reconciliation rather than tear the bot down.
            console.error(`[Bot Creation][Reuse] finalize CAS lost for ${_reuseContext.protocolSubaccountId} (bot ${bot.id}); registry not flipped to active — needs reconciliation`);
          }
        } catch (reuseKeyErr: any) {
          console.error(`[Bot Creation][Reuse] failed to bind retained key for reused subaccount ${_reuseContext.protocolSubaccountId} (bot ${bot.id}):`, reuseKeyErr?.message || reuseKeyErr);
          // Funds were transferred into the reused subaccount, but its key is still
          // retained in the spare row (POOLED AAD) — recoverable, not a loss. Tear down
          // the half-created bot and quarantine the slot for admin/recovery sweep.
          try { await storage.deleteTradingBot(bot.id); } catch {}
          try {
            await storage.markSubaccountStuckFunds({
              walletAddress: req.walletAddress!,
              protocol: _reuseContext.protocol,
              protocolSubaccountId: _reuseContext.protocolSubaccountId,
              botId: null,
              agentPublicKey: _reuseContext.agentPublicKey,
              lastError: `reuse key-rebind failed: ${reuseKeyErr?.message || reuseKeyErr}`,
              claimToken: _reuseContext.claimToken,
            });
          } catch { /* best-effort quarantine */ }
          return res.status(500).json({ error: `Failed to secure reused subaccount key: ${reuseKeyErr?.message || reuseKeyErr}` });
        } finally {
          try { _reuseUmk?.cleanup(); } catch {}
        }
      }

      // Pacifica atomic-provision: surface funding status so frontend skips the
      // follow-up /api/exchange/deposit call (the deposit + transfer already happened
      // server-side inside provisionFundedSubaccount).
      const provisionResult = (req as any)._pacificaProvisionResult as
        | { funded: boolean; wasNewAccount: boolean; depositTxSignature?: string; warning?: string; fundedAmount: number }
        | undefined;

      // Record the equity event so the P&L system has the correct deposit baseline.
      // This is the same write that /api/exchange/deposit does after a successful deposit.
      // Without it, the balance in the bot subaccount would appear as pure profit.
      if (provisionResult?.funded === true && provisionResult.fundedAmount > 0) {
        try {
          await storage.createEquityEvent({
            walletAddress: req.walletAddress!,
            tradingBotId: bot.id,
            eventType: 'drift_deposit',
            amount: String(provisionResult.fundedAmount),
            txSignature: provisionResult.depositTxSignature || null,
            notes: `Initial funding for bot subaccount ${botSubaccountPublicKey}${provisionResult.wasNewAccount ? ' (new Pacifica account)' : ''}`,
          });
          console.log(`[Bot Creation] Equity event recorded: $${provisionResult.fundedAmount} deposit for bot ${bot.id}`);
        } catch (eventErr: any) {
          console.error(`[Bot Creation] Failed to record equity event for bot ${bot.id}:`, eventErr.message);
          // Non-fatal — bot is created and funded. P&L will be off but funds are safe.
        }
      }

      // Flash per-bot wallet funding — record the same deposit baseline so the
      // funded USDC is treated as a deposit (not phantom profit) by the P&L system.
      const flashProvisionResult = (req as any)._flashProvisionResult as
        | { funded: boolean; depositTxSignature?: string; fundedAmount: number; solSeeded?: number }
        | undefined;
      if (flashProvisionResult?.funded === true && flashProvisionResult.fundedAmount > 0) {
        try {
          await storage.createEquityEvent({
            walletAddress: req.walletAddress!,
            tradingBotId: bot.id,
            eventType: 'drift_deposit',
            amount: String(flashProvisionResult.fundedAmount),
            txSignature: flashProvisionResult.depositTxSignature || null,
            notes: `Initial funding for Flash bot wallet ${botSubaccountPublicKey}`,
          });
          console.log(`[Bot Creation] Equity event recorded: $${flashProvisionResult.fundedAmount} deposit for Flash bot ${bot.id}`);
        } catch (eventErr: any) {
          console.error(`[Bot Creation] Failed to record Flash equity event for bot ${bot.id}:`, eventErr.message);
          // Non-fatal — bot is created and funded. P&L will be off but funds are safe.
        }
      }

      const provisionResultForResponse = (req as any)._pacificaProvisionResult as
        | { funded: boolean; wasNewAccount: boolean; depositTxSignature?: string; warning?: string; fundedAmount: number }
        | undefined;

      res.json({
        ...bot,
        webhookUrl,
        botSubaccountIdentifier: botSubaccountPublicKey,
        ...(provisionResult ? {
          funded: provisionResult.funded,
          fundedAmount: provisionResult.fundedAmount,
          wasNewAccount: provisionResult.wasNewAccount,
          depositTxSignature: provisionResult.depositTxSignature,
          fundingWarning: provisionResult.warning,
        } : {}),
        ...(flashProvisionResult ? {
          funded: flashProvisionResult.funded,
          fundedAmount: flashProvisionResult.fundedAmount,
          depositTxSignature: flashProvisionResult.depositTxSignature,
        } : {}),
        ...((req as any)._flashProvisionAmbiguous ? {
          fundingActionRequired: true,
          fundingTxSignature: (req as any)._flashProvisionAmbiguous.txSignature,
          fundingWarning: `We could not confirm the funding transaction for your Flash bot wallet ${(req as any)._flashProvisionAmbiguous.walletAddress}. The bot was saved but is NOT active. Verify the transaction on-chain, then delete this bot to recover any funds before retrying.`,
        } : {}),
      });
    } catch (error) {
      console.error("Create trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig, isActive, profitReinvest, autoWithdrawThreshold, autoTopUp } = req.body;
      
      if (leverage !== undefined) {
        const leverageNum = Number(leverage);
        if (isNaN(leverageNum) || leverageNum < 1 || leverageNum > 20 || !Number.isInteger(leverageNum)) {
          return res.status(400).json({ error: "Leverage must be an integer between 1 and 20" });
        }
      }
      
      // PAUSE BOT = CLOSE POSITION: If bot is being paused (isActive changing to false)
      // close any open position on Drift first
      let positionClosed = false;
      let closeError: string | null = null;
      
      if (isActive === false && bot.isActive === true) {
        console.log(`[Bot] Pausing bot ${bot.name} - checking for open positions to close`);
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
          // No agent wallet - check if there's a DB position we can't close
          const dbPosition = await storage.getBotPosition(bot.id, bot.market);
          if (dbPosition && parseFloat(dbPosition.baseSize) !== 0) {
            return res.status(400).json({ 
              error: "Cannot pause: Agent wallet not configured to close position",
              hasPosition: true,
              positionSize: dbPosition.baseSize,
            });
          }
        }
        
        const pauseBotCtx = getBotSubaccountContext(bot);
        const pauseSubAccountId = pauseBotCtx ? 0 : (bot.driftSubaccountId ?? 0);
        const pauseQueryAccount = pauseBotCtx ? pauseBotCtx.botPublicKey : wallet!.agentPublicKey!;
        let actualPositionSize = 0;
        
        let pauseEntryPrice = 0;
        let pauseOnChainPosition: any = null;
        try {
          const onChainPositions = await getPerpPositions(pauseQueryAccount, pauseSubAccountId, null, getAdapterForBot(bot));
          const marketName = bot.market.toUpperCase();
          pauseOnChainPosition = onChainPositions.find((p: any) => 
            p.market.toUpperCase() === marketName || 
            p.market.toUpperCase().replace('-', '-') === marketName
          );
          actualPositionSize = pauseOnChainPosition?.baseAssetAmount || 0;
          pauseEntryPrice = pauseOnChainPosition?.entryPrice || 0;
          console.log(`[Bot] On-chain position for ${bot.market}: ${actualPositionSize} @ entry $${pauseEntryPrice}`);
        } catch (err) {
          console.error(`[Bot] CRITICAL: Failed to query on-chain position:`, err);
          // DO NOT fall back to database - that's what caused the bug!
          // Instead, fail the pause so user knows there's a problem
          return res.status(500).json({ 
            error: "Cannot pause: Failed to query on-chain position from Drift. Please try again.",
            details: err instanceof Error ? err.message : "Unknown error"
          });
        }
        
        if (Math.abs(actualPositionSize) > 0.0001 && wallet?.agentPrivateKeyEncryptedV3) {
          console.log(`[Bot] Found open position: ${actualPositionSize} ${bot.market} - closing before pause`);
          
          const _pauseUmk = await getUmkForWebhook(bot.walletAddress);
          if (!_pauseUmk) {
            return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
          }
          const _pauseAgentKey = await decryptAgentKeyStrict(bot.walletAddress, _pauseUmk.umk, wallet!, wallet!.agentPublicKey!);
          if (!_pauseAgentKey) {
            _pauseUmk.cleanup();
            return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
          }
          try {
            // Determine close side (opposite of current position)
            const closeSide: 'long' | 'short' = actualPositionSize > 0 ? 'short' : 'long';
            const closeSize = Math.abs(actualPositionSize);
            
            const result = await executePerpOrder(
              _pauseAgentKey.secretKey,
              bot.market,
              closeSide,
              closeSize,
              pauseSubAccountId,
              true,
              50,
              undefined,
              wallet.agentPublicKey || undefined,
              undefined,
              pauseBotCtx,
              bot.walletAddress,
              getAdapterForBot(bot),
            );
            
            if (result.success && result.txSignature) {
              console.log(`[Bot] Position closed successfully: ${result.txSignature}`);
              
              // VERIFY position is actually closed by re-querying on-chain
              let verifyAttempts = 0;
              let positionVerified = false;
              while (verifyAttempts < 3 && !positionVerified) {
                try {
                  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for blockchain confirmation
                  const verifyPositions = await getPerpPositions(pauseQueryAccount, pauseSubAccountId, null, getAdapterForBot(bot));
                  const verifyPosition = verifyPositions.find((p: any) => 
                    p.market.toUpperCase() === bot.market.toUpperCase()
                  );
                  const remainingSize = Math.abs(verifyPosition?.baseAssetAmount || 0);
                  if (remainingSize < 0.0001) {
                    positionVerified = true;
                    console.log(`[Bot] Position verified closed on-chain`);
                  } else {
                    console.log(`[Bot] Position still shows ${remainingSize} on-chain, attempt ${verifyAttempts + 1}/3`);
                  }
                } catch (verifyErr) {
                  console.error(`[Bot] Position verify attempt ${verifyAttempts + 1} failed:`, verifyErr);
                }
                verifyAttempts++;
              }
              
              if (!positionVerified) {
                console.error(`[Bot] WARNING: Position close tx succeeded but verification failed - position may still be open`);
                closeError = "Close order sent but verification failed - please check Drift manually";
              }
              
              // Calculate fee (0.05% taker fee on notional value)
              const pauseFillPrice = result.fillPrice || 0;
              const closeNotional = closeSize * pauseFillPrice;
              const closeFee = closeNotional * getExchangeFeeRate();
              
              // Calculate trade PnL for pause close
              let pauseClosePnl = 0;
              if (pauseEntryPrice > 0 && pauseFillPrice > 0) {
                if (closeSide === 'short') {
                  // Closing LONG: profit if exitPrice > entryPrice
                  pauseClosePnl = (pauseFillPrice - pauseEntryPrice) * closeSize - closeFee;
                } else {
                  // Closing SHORT: profit if entryPrice > exitPrice
                  pauseClosePnl = (pauseEntryPrice - pauseFillPrice) * closeSize - closeFee;
                }
                console.log(`[Bot] Pause close PnL: entry=$${pauseEntryPrice.toFixed(2)}, exit=$${pauseFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${pauseClosePnl.toFixed(4)}`);
              }
              
              const pauseFillId = DatabaseStorage.canonicalCloseFillId({
                signature: result.txSignature,
                botId: bot.id,
                side: 'CLOSE',
                size: closeSize,
                market: bot.market,
                fillPrice: pauseFillPrice,
                timestampMs: Date.now(),
              });
              const pauseNotional = closeSize * (pauseFillPrice || 0);
              const { trade: closeTradeRow } = await storage.recordCloseEventAtomic({
                botId: bot.id,
                insert: {
                  tradingBotId: bot.id,
                  walletAddress: bot.walletAddress,
                  market: bot.market,
                  side: "CLOSE",
                  size: String(closeSize),
                  price: pauseFillPrice ? String(pauseFillPrice) : "0",
                  fee: String(closeFee),
                  pnl: String(pauseClosePnl),
                  status: "executed",
                  txSignature: result.txSignature,
                  protocolFillId: pauseFillId,
                  webhookPayload: { action: "pause_close", reason: "Bot paused by user", entryPrice: pauseEntryPrice, exitPrice: pauseFillPrice },
                  executionMethod: result.executionMethod || 'legacy',
                  swiftOrderId: result.swiftOrderId || null,
                },
                deltas: {
                  totalPnlDelta: pauseClosePnl,
                  totalVolumeDelta: pauseNotional,
                  lastTradeAt: new Date().toISOString(),
                },
              });
              const closeTrade = closeTradeRow!;
              
              // Sync position from on-chain (replaces client-side math with actual Drift state)
              await syncPositionFromOnChain(
                bot.id,
                bot.walletAddress,
                wallet.agentPublicKey!,
                pauseSubAccountId,
                bot.market,
                closeTrade.id,
                closeFee,
                result.fillPrice || 0,
                closeSide,
                closeSize,
                pauseBotCtx?.botPublicKey
              );
              
              positionClosed = positionVerified;
            } else {
              throw new Error(result.error || "Close order execution failed");
            }
          } catch (err: any) {
            console.error(`[Bot] Failed to close position on pause:`, err);
            closeError = err.message || "Failed to close position";
            _pauseAgentKey.cleanup();
            _pauseUmk.cleanup();
            // DON'T pause the bot if close failed - position is still open!
            return res.status(500).json({ 
              error: "Cannot pause: Failed to close open position on Drift",
              details: closeError,
              hasPosition: true,
              positionSize: actualPositionSize
            });
          } finally {
            _pauseAgentKey.cleanup();
            _pauseUmk.cleanup();
          }
        }
      }
      
      const updated = await storage.updateTradingBot(req.params.id, {
        ...(name && { name }),
        ...(market && { market }),
        ...(side && { side }),
        ...(leverage !== undefined && { leverage: Number(leverage) }),
        ...(totalInvestment !== undefined && { totalInvestment: String(totalInvestment) }),
        ...(maxPositionSize !== undefined && { maxPositionSize }),
        ...(signalConfig && { signalConfig }),
        ...(riskConfig && { riskConfig }),
        ...(isActive !== undefined && { isActive }),
        ...(isActive === true && { pauseReason: null }), // Clear pause reason when reactivating
        ...(profitReinvest !== undefined && { profitReinvest }),
        ...(autoWithdrawThreshold !== undefined && { autoWithdrawThreshold: autoWithdrawThreshold !== null ? String(autoWithdrawThreshold) : null }),
        ...(autoTopUp !== undefined && { autoTopUp }),
      });

      // Include position close info in response
      const response: any = { ...updated };
      if (positionClosed) {
        response.positionClosed = true;
        response.message = "Bot paused and open position was closed on Drift";
      } else if (closeError) {
        response.positionCloseError = closeError;
        response.message = "Bot paused but position close failed - please close manually";
      }

      res.json(response);
    } catch (error) {
      console.error("Update trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/trading-bots/:id", requireWallet, async (req, res) => {
    let _deleteAgentKeyCleanup: (() => void) | null = null;
    // Phase D: owner UMK, captured for eager key-rebind when pooling a spare. Valid
    // until _deleteAgentKeyCleanup runs in the finally (which zeroizes it).
    let _deleteOwnerUmk: Buffer | null = null;
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;

      // V3 strict-decrypt: hoist once for the whole delete flow.
      let agentSecret: Uint8Array | null = null;
      if (wallet?.agentPrivateKeyEncryptedV3 && wallet?.agentPublicKey) {
        const _delUmk = await getUmkForWebhook(req.walletAddress!);
        if (!_delUmk) {
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        const _delKey = await decryptAgentKeyStrict(req.walletAddress!, _delUmk.umk, wallet, wallet.agentPublicKey);
        if (!_delKey) {
          _delUmk.cleanup();
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        agentSecret = _delKey.secretKey;
        _deleteOwnerUmk = _delUmk.umk;
        _deleteAgentKeyCleanup = () => { _delKey.cleanup(); _delUmk.cleanup(); };
      }
      
      // Check for pending profit share IOUs before allowing deletion
      const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(req.params.id);
      if (pendingIOUs.length > 0) {
        const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
        console.log(`[Delete] Bot ${req.params.id} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
        
        // Try to pay IOUs first if we have wallet access
        if (wallet?.agentPublicKey && agentSecret) {
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              agentSecret,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[Delete] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[Delete] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please fund your agent wallet and try again.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        } else {
          return res.status(400).json({
            error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments. Agent wallet access is required to pay these.`,
            pendingIOUs: pendingIOUs.length,
            totalOwed
          });
        }
      }
      
      // Flash per-bot wallet sweep — Flash bots are external_key bots so they ALSO
      // satisfy getBotSubaccountContext, but their funds live in the bot's OWN
      // Solana wallet and must be swept with sweepBotWallet (NOT Pacifica's
      // transferBetweenSubaccounts, which Flash rejects). Handle them here and
      // return so they never fall through to the Pacifica block below.
      // Flash bots route through the Flash-specific sweep safeguard whenever they
      // own a separate wallet (protocolSubaccountId), REGARDLESS of subaccountStatus
      // — 'error'/recovery rows (e.g. ambiguous funding at creation) must NOT bypass
      // the sweep and fall through to the generic delete path below.
      if (bot.activeProtocol === 'flash' && bot.protocolSubaccountId && agentAddress) {
        // Legacy/broken Flash bots created before per-bot wallets have
        // protocolSubaccountId === the agent wallet itself; their funds already
        // live in the agent wallet, so there is nothing to sweep — just delete.
        if (bot.protocolSubaccountId === agentAddress) {
          console.log(`[Delete] Flash bot ${bot.id} maps to the agent wallet (legacy) — no separate wallet to sweep, deleting`);
          await storage.deleteTradingBot(req.params.id);
          return res.json({ success: true, swept: false, message: 'Bot deleted' });
        }

        // Phase 4b (Flash agent-HD wallets): an agent_hd bot is ALWAYS recoverable
        // from the agent seed + its non-secret derivation index, even with no persisted
        // encrypted blob — so it must NOT take the "no key ⇒ delete audit row" shortcut.
        // _resolveBotSubaccountSecretKey re-derives transparently; if that fails (e.g. no
        // recovery phrase) the sweep below throws and deletion is blocked (fail closed).
        // Only a legacy RANDOM bot (no blob AND no derivation index) is truly
        // unrecoverable; for those, deleting clears the orphaned audit row.
        const hasKey = !!(bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted);
        const isAgentHd = bot.derivationIndex != null && bot.derivationPathVersion != null;
        if (!hasKey && !isAgentHd) {
          console.warn(`[Delete] Flash bot ${bot.id} has no persisted subaccount key and is not agent-derived — cannot sweep wallet ${bot.protocolSubaccountId}; deleting audit row only`);
          await storage.deleteTradingBot(req.params.id);
          return res.json({ success: true, swept: false, message: 'Bot deleted (no recoverable wallet key)' });
        }

        const flashAdapter = getAdapterForBot(bot) as import('./protocol/flash/flash-adapter').FlashAdapter;

        // Refuse to delete while a position is open — closing needs the bot key,
        // which we discard on delete. Fail closed.
        try {
          const openPositions = await flashAdapter.getPositions(bot.protocolSubaccountId!);
          if (openPositions && openPositions.length > 0) {
            return res.status(409).json({
              error: 'Cannot delete bot - it has an open Flash position.',
              message: 'Close the position first, then delete the bot.',
            });
          }
        } catch (posErr: any) {
          console.error(`[Delete] Flash position check failed for bot ${bot.id}: ${posErr?.message || posErr}`);
          return res.status(500).json({
            error: 'Cannot delete bot - unable to verify open positions.',
            message: 'Please try again in a moment.',
          });
        }

        // Sweep the bot wallet (all USDC + reclaim SOL) back to the agent wallet
        // with the bot's own key, verify empty, then delete. USDC leg fails closed.
        // Build the signing context directly: getBotSubaccountContext requires status
        // 'active', but we deliberately also handle 'error'/recovery rows here.
        const flashBotCtx: BotSubaccountContext = {
          useBotKeypair: true,
          botPublicKey: bot.protocolSubaccountId!,
          botId: bot.id,
          walletAddress: bot.walletAddress,
        };
        let decrypted: { secretKey: Uint8Array; cleanup: () => void } | null = null;
        try {
          decrypted = await _resolveBotSubaccountSecretKey(flashBotCtx);
          const sweep = await flashAdapter.sweepBotWallet({
            subSecretKey: decrypted.secretKey,
            destWalletAddress: agentAddress,
          });
          if (sweep.error) {
            return res.status(500).json({
              error: `Cannot delete bot - failed to sweep funds from the Flash bot wallet: ${sweep.error}`,
              message: 'Please try again, or withdraw funds manually before deleting.',
            });
          }
          // Confirm the wallet is genuinely empty of BOTH USDC and reclaimable SOL
          // before discarding the key. Reads fail CLOSED: an unreadable balance
          // blocks deletion (never mistake an RPC outage for an empty wallet).
          let usdcResidual: number;
          let solResidual: number;
          try {
            usdcResidual = await flashAdapter.getWalletCollateralBalanceStrict(bot.protocolSubaccountId!);
            solResidual = await flashAdapter.getWalletSolBalance(bot.protocolSubaccountId!);
          } catch (balErr: any) {
            return res.status(500).json({
              error: `Cannot delete bot - could not verify the Flash bot wallet is empty: ${balErr?.message || balErr}`,
              message: 'Please try again in a moment.',
            });
          }
          if (usdcResidual > 0) {
            return res.status(409).json({
              error: `Cannot delete bot - $${usdcResidual.toFixed(6)} USDC still remains in the Flash bot wallet.`,
              message: 'Please try again in a moment, or withdraw funds manually before deleting.',
            });
          }
          // A successful SOL reclaim leaves ~0; anything above this dust line means
          // the SOL leg did not fully reclaim and recoverable funds remain.
          const FLASH_SOL_DUST = 0.001;
          if (solResidual > FLASH_SOL_DUST) {
            return res.status(409).json({
              error: `Cannot delete bot - ${solResidual.toFixed(6)} SOL still remains in the Flash bot wallet.`,
              message: 'Please try again in a moment to reclaim it, or withdraw funds manually before deleting.',
            });
          }
          await storage.deleteTradingBot(req.params.id);
          const msg = sweep.usdcSwept > 0
            ? `Returned $${sweep.usdcSwept.toFixed(2)} USDC to your agent wallet before deletion`
            : 'Bot deleted';
          return res.json({
            success: true,
            swept: sweep.usdcSwept > 0,
            withdrawnToWallet: sweep.usdcSwept > 0,
            withdrawnAmount: sweep.usdcSwept,
            solReclaimed: sweep.solReclaimed,
            message: msg,
          });
        } catch (sweepErr: any) {
          console.error(`[Delete] Flash sweep error for bot ${bot.id}: ${sweepErr?.message || sweepErr}`);
          return res.status(500).json({
            error: `Cannot delete bot - error sweeping the Flash bot wallet: ${sweepErr?.message || sweepErr}`,
            message: 'Please try again, or withdraw funds manually before deleting.',
          });
        } finally {
          try { decrypted?.cleanup(); } catch {}
        }
      }

      // Pacifica subaccount sweep — transfer funds back to agent wallet before deletion
      if (getBotSubaccountContext(bot) && agentAddress) {
        const recycleOnDelete = isRecycleOnDeleteEnabled();

        // Phase D (§7.2): when recycling is enabled, FLATTEN the subaccount first
        // (cancel all orders, close positions, re-verify) so the sweep can move 100%
        // of collateral and the account ends genuinely empty. Gated — flag OFF leaves
        // today's behavior untouched.
        if (recycleOnDelete) {
          const teardown = await teardownPacificaSubaccountForDelete(bot, '[Delete]');
          if (!teardown.ok) {
            return res.status(500).json({
              error: `Cannot delete bot - could not flatten Pacifica subaccount: ${teardown.error}`,
              message: "Open positions or orders remain on this bot. Please close them and try again.",
            });
          }
        }

        const sweepResult = await sweepPacificaSubaccount(bot, agentAddress, '[Delete]', agentSecret);
        if (sweepResult.handled) {
          // Quarantine the subaccount as stuck_funds WITHOUT deleting the bot row — the
          // signing key lives on the bot row, so not deleting preserves it for recovery.
          // Best-effort: a registry-write failure is logged, never fatal.
          const quarantineStuckFunds = async (reason: string) => {
            const _stuckCtx = getBotSubaccountContext(bot);
            if (!_stuckCtx) return;
            try {
              await storage.markSubaccountStuckFunds({
                walletAddress: bot.walletAddress,
                protocol: 'pacifica',
                protocolSubaccountId: _stuckCtx.botPublicKey,
                botId: bot.id,
                agentPublicKey: agentAddress,
                lastError: reason,
              });
            } catch (e: any) {
              console.error(`[Delete] Failed to mark subaccount stuck_funds (non-fatal): ${e.message}`);
            }
          };

          if (shouldBlockDeleteForSweep(recycleOnDelete, sweepResult)) {
            // Sweep error ⇒ funds may still be in the subaccount, so it must NEVER be
            // pooled or deleted. When recycling, quarantine it as stuck_funds for recovery.
            if (recycleOnDelete) {
              await quarantineStuckFunds(sweepResult.error ?? 'unknown sweep failure');
            }
            return res.status(500).json({
              error: `Cannot delete bot - failed to sweep $${sweepResult.amount.toFixed(2)} from Pacifica subaccount: ${sweepResult.error}`,
              message: "Please withdraw funds manually before deleting."
            });
          }
          // Phase D (§7.2/§8): with recycling on, the subaccount MUST be verified empty
          // before we delete the bot row (and its signing key). If funds remain — e.g.
          // sub-min-transfer dust the sweep can't move, or the empty-check can't complete
          // — quarantine as stuck_funds and refuse to delete (never delete-and-lose-track).
          // If empty, retain the key as a spare (best-effort) and proceed.
          if (recycleOnDelete) {
            const outcome = await recycleDeletedSubaccount(bot, agentAddress, _deleteOwnerUmk, '[Delete]');
            if (!outcome.ok) {
              await quarantineStuckFunds(outcome.reason);
              return res.status(409).json({
                error: `Cannot delete bot - funds remain in the Pacifica subaccount: ${outcome.reason}`,
                message: "The subaccount still holds funds (possibly below the minimum transfer amount). It's been flagged for recovery — please withdraw manually before deleting.",
              });
            }
          }
          await storage.deleteTradingBot(req.params.id);
          let message = 'Bot deleted';
          if (sweepResult.swept) {
            message = sweepResult.withdrawnToWallet
              ? `Returned $${sweepResult.amount.toFixed(2)} USDC to your agent wallet before deletion`
              : `Moved $${sweepResult.amount.toFixed(2)} USDC to your main account; it will return to your wallet shortly`;
          }
          return res.json({
            success: true,
            swept: sweepResult.swept,
            withdrawnToWallet: sweepResult.withdrawnToWallet ?? false,
            withdrawnAmount: sweepResult.amount,
            message
          });
        }
      }

      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      // This prevents orphaning funds when wallet record is corrupted or missing
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress) {
          console.error(`[Delete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent is missing`);
          return res.status(500).json({
            error: "Cannot verify bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to check if this bot has funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true });
      }

      // Check if bot has funds to sweep before deletion
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        let withdrawnAmount = 0;
        let withdrawTxSignature: string | undefined;
        
        const botCtx = getBotSubaccountContext(bot);
        let exists = false;

        if (botCtx && bot.protocolSubaccountId) {
          if (!agentSecret) {
            console.error(`[Delete] Cannot withdraw - agent key missing for bot ${bot.id}`);
            return res.status(500).json({
              error: "Cannot withdraw funds - wallet key missing",
              message: "Unable to access agent wallet to withdraw funds. Please contact support."
            });
          }

          let decryptedBotKey: { secretKey: Uint8Array; cleanup: () => void } | null = null;
          try {
            const adapter = getAdapterForBot(bot);
            decryptedBotKey = await _resolveBotSubaccountSecretKey(botCtx);
            const botSecretKey = decryptedBotKey.secretKey;

            const balanceInfo = await adapter.getBalances(bot.protocolSubaccountId);
            const balance = balanceInfo.balance;
            console.log(`[Delete] Bot ${bot.id} Pacifica subaccount ${bot.protocolSubaccountId} balance: $${balance.toFixed(6)}`);

            if (balance > 0.001) {
              const sweepAmount = Math.floor(balance * 100) / 100;

              if (sweepAmount > 0) {
                console.log(`[Delete] Step 1: Transfer $${sweepAmount.toFixed(2)} from bot subaccount → main account`);
                const transferResult = await adapter.transferBetweenSubaccounts({
                  agentSecretKey: botSecretKey,
                  mainWalletAddress: wallet.agentPublicKey!,
                  fromSubaccountId: bot.protocolSubaccountId,
                  toSubaccountId: wallet.agentPublicKey!,
                  amount: sweepAmount,
                });

                if (!transferResult.success) {
                  console.warn(`[Delete] Transfer warning: ${transferResult.error}`);
                } else {
                  console.log(`[Delete] Transfer successful`);

                  if (sweepAmount > 0.01) {
                    console.log(`[Delete] Step 2: Withdraw $${sweepAmount.toFixed(2)} from main account → agent wallet`);
                    const withdrawResult = await executeAgentDriftWithdraw(
                      agentAddress,
                      agentSecret,
                      sweepAmount,
                      0,
                      undefined,
                      getAdapterForBot(bot)
                    );

                    if (withdrawResult.success) {
                      withdrawnAmount = sweepAmount;
                      withdrawTxSignature = withdrawResult.signature;
                      console.log(`[Delete] Withdrawal successful: ${withdrawResult.signature}`);
                    } else {
                      console.warn(`[Delete] Withdrawal warning: ${withdrawResult.error} (funds in main account, use Recover)`);
                    }
                  } else {
                    console.log(`[Delete] Dust amount $${sweepAmount.toFixed(6)} transferred to main account (not withdrawing to save fees)`);
                  }
                }
              }
            } else {
              console.log(`[Delete] Bot subaccount balance negligible ($${balance.toFixed(6)}), skipping sweep`);
            }
          } catch (err: any) {
            console.warn(`[Delete] Pacifica sweep error (continuing to delete):`, err.message);
          } finally {
            decryptedBotKey?.cleanup();
          }
        } else {
          exists = await subaccountExists(agentAddress, bot.driftSubaccountId, getAdapterForBot(bot));

          if (exists) {
            const balance = await getExchangeBalance(agentAddress, bot.driftSubaccountId, getAdapterForBot(bot));

            if (bot.driftSubaccountId > 0 && balance > 0.01) {
              if (!agentSecret) {
                console.error(`[Delete] Cannot withdraw - agent key missing for bot ${bot.id}`);
                return res.status(500).json({
                  error: "Cannot withdraw funds - wallet key missing",
                  balance,
                  message: "Unable to access agent wallet to withdraw funds. Please contact support."
                });
              }

              console.log(`[Delete] Legacy sweep: subaccount ${bot.driftSubaccountId}, balance $${balance.toFixed(6)}`);
              try {
                const sweepAmount = Math.max(balance, 0.000001);
                const transferResult = await executeAgentTransferBetweenSubaccounts(
                  agentAddress,
                  agentSecret,
                  bot.driftSubaccountId,
                  0,
                  sweepAmount,
                  getAdapterForBot(bot)
                );
                if (transferResult.success && balance > 0.01) {
                  const withdrawResult = await executeAgentDriftWithdraw(agentAddress, agentSecret, balance, 0, undefined, getAdapterForBot(bot));
                  if (withdrawResult.success) {
                    withdrawnAmount = balance;
                    withdrawTxSignature = withdrawResult.signature;
                  }
                }
              } catch (err: any) {
                console.warn(`[Delete] Legacy sweep error:`, err.message);
              }
            } else if (balance > 0.01 && bot.driftSubaccountId === 0) {
              console.log(`[Delete] Bot ${bot.id} is on shared subaccount 0 with $${balance.toFixed(2)} - not auto-withdrawing`);
            }
          }
        }
        
        // Try to close the subaccount to reclaim rent (~0.023 SOL)
        let rentReclaimed = false;
        let rentReclaimError: string | undefined;
        
        // Edge case: subaccount exists but agent keys are missing (data corruption)
        if (exists && !agentSecret && bot.driftSubaccountId > 0) {
          console.error(`[Delete] CRITICAL: Subaccount ${bot.driftSubaccountId} exists but agent keys missing - cannot auto-recover!`);
          console.error(`[Delete] User must use "Reset Trading Account" in Settings or manually close positions`);
          rentReclaimError = "Agent keys missing - manual recovery required";
        }
        
        if (exists && agentSecret && bot.driftSubaccountId > 0) {
          console.log(`[Delete] Attempting to close subaccount ${bot.driftSubaccountId} to reclaim rent...`);
          try {
            const closeResult = await closeDriftSubaccount(
              agentSecret,
              bot.driftSubaccountId,
              getAdapterForBot(bot)
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed: ${closeResult.signature}`);
              rentReclaimed = true;
            } else {
              console.error(`[Delete] RENT NOT RECLAIMED - subaccount ${bot.driftSubaccountId}: ${closeResult.error}`);
              rentReclaimError = closeResult.error;
            }
          } catch (closeErr: any) {
            console.error(`[Delete] RENT RECLAIM FAILED - subaccount ${bot.driftSubaccountId}:`, closeErr.message);
            rentReclaimError = closeErr.message;
          }
          
          // Track orphaned subaccount if rent could not be reclaimed
          if (!rentReclaimed) {
            console.warn(`[Delete] Tracking orphaned subaccount ${bot.driftSubaccountId} for later cleanup`);
            try {
              // V3 Phase 4: do NOT write the legacy encrypted key column. The
              // cleanup job resolves the agent key from the wallet's V3
              // envelope at execution time (strict-decrypt via UMK).
              await storage.createOrphanedSubaccount({
                walletAddress: req.walletAddress!,
                agentPublicKey: agentAddress,
                driftSubaccountId: bot.driftSubaccountId,
                reason: rentReclaimError,
              });
            } catch (orphanErr: any) {
              console.error(`[Delete] Failed to track orphaned subaccount:`, orphanErr.message);
            }
          }
        }
        
        await storage.deleteTradingBot(req.params.id);
        const rentReclaimPending = !rentReclaimed && bot.driftSubaccountId > 0;
        const needsManualRecovery = rentReclaimError?.includes('Agent keys missing');
        
        let message = 'Bot deleted';
        if (withdrawnAmount > 0) {
          message = `Automatically withdrew $${withdrawnAmount.toFixed(2)} USDC to your agent wallet`;
          if (rentReclaimed) {
            message += ' and reclaimed subaccount rent';
          } else if (needsManualRecovery) {
            message += '. Subaccount requires manual recovery via Settings.';
          } else if (rentReclaimPending) {
            message += '. Rent reclaim pending.';
          }
        } else if (rentReclaimed) {
          message = 'Subaccount closed and rent reclaimed';
        } else if (needsManualRecovery) {
          message = 'Bot deleted. Subaccount requires manual recovery - use "Reset Trading Account" in Settings.';
        } else if (rentReclaimPending) {
          message = 'Bot deleted. Subaccount rent reclaim pending.';
        }
        
        return res.json({ 
          success: true, 
          rentReclaimed,
          rentReclaimPending,
          needsManualRecovery,
          withdrawn: withdrawnAmount > 0,
          withdrawnAmount,
          withdrawTxSignature,
          message
        });
      }

      // Bot without driftSubaccountId - check subaccount 0 (main account) for safety
      // This prevents orphaning funds in the main Drift account
      const mainBalance = await getExchangeBalance(agentAddress, 0, getAdapterForBot(bot));
      if (mainBalance > 0.01) {
        console.log(`[Delete] Warning: Main Drift account has $${mainBalance.toFixed(2)} - may be from this bot`);
        // Don't block deletion for main account funds, but log warning
        // Main account funds can still be withdrawn via wallet management
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      _deleteAgentKeyCleanup?.();
    }
  });

  // Phase 4b emergency recovery: re-derive a Flash agent-HD bot wallet, close any
  // open positions, sweep ALL funds back to the agent wallet, and verify empty.
  // Works even if the encrypted per-bot key blob is lost (re-derives from the agent
  // seed). Idempotent — re-running on an already-empty wallet is a safe no-op. Does
  // NOT delete the bot row; it only returns the capital to the agent wallet.
  app.post("/api/trading-bots/:id/recover-wallet", requireWallet, async (req, res) => {
    let _recoverCleanup: (() => void) | null = null;
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      if (!agentAddress) {
        return res.status(400).json({ error: "No agent wallet found — cannot recover bot funds." });
      }

      // V3 strict-decrypt the agent key so we can fund the bot wallet's sweep gas.
      let agentSecret: Uint8Array | null = null;
      if (wallet?.agentPrivateKeyEncryptedV3 && wallet?.agentPublicKey) {
        const _recUmk = await getUmkForWebhook(req.walletAddress!);
        if (!_recUmk) {
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        const _recKey = await decryptAgentKeyStrict(req.walletAddress!, _recUmk.umk, wallet, wallet.agentPublicKey);
        if (!_recKey) {
          _recUmk.cleanup();
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        agentSecret = _recKey.secretKey;
        _recoverCleanup = () => { _recKey.cleanup(); _recUmk.cleanup(); };
      }

      const result = await recoverFlashBotWallet(bot, agentAddress, agentSecret, '[RecoverEndpoint]');
      if (!result.recovered) {
        return res.status(500).json({
          error: result.error || "Recovery failed",
          message: "The bot wallet could not be safely recovered. Funds remain in the bot wallet; please retry or contact support.",
        });
      }
      return res.json({
        success: true,
        closedPositions: result.closedPositions,
        usdcSwept: result.usdcSwept,
        solReclaimed: result.solReclaimed,
        alreadyEmpty: result.alreadyEmpty,
        message: result.alreadyEmpty
          ? "Bot wallet was already empty — nothing to recover."
          : `Recovered $${result.usdcSwept.toFixed(2)} USDC to your agent wallet${result.closedPositions > 0 ? ` after closing ${result.closedPositions} position(s)` : ''}.`,
      });
    } catch (err) {
      console.error('[RecoverEndpoint] Unexpected error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : "Recovery failed" });
    } finally {
      _recoverCleanup?.();
    }
  });

  // Force delete with sweep - auto-withdraws funds before deletion
  app.delete("/api/trading-bots/:id/force", requireWallet, async (req, res) => {
    let _forceDeleteCleanup: (() => void) | null = null;
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;

      // V3 strict-decrypt: hoist once for the whole force-delete flow.
      let agentSecret: Uint8Array | null = null;
      if (wallet?.agentPrivateKeyEncryptedV3 && wallet?.agentPublicKey) {
        const _fdUmk = await getUmkForWebhook(req.walletAddress!);
        if (!_fdUmk) {
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        const _fdKey = await decryptAgentKeyStrict(req.walletAddress!, _fdUmk.umk, wallet, wallet.agentPublicKey);
        if (!_fdKey) {
          _fdUmk.cleanup();
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        agentSecret = _fdKey.secretKey;
        _forceDeleteCleanup = () => { _fdKey.cleanup(); _fdUmk.cleanup(); };
      }
      
      // Check for pending profit share IOUs before allowing deletion
      const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(req.params.id);
      if (pendingIOUs.length > 0) {
        const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
        console.log(`[ForceDelete] Bot ${req.params.id} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
        
        // Try to pay IOUs first if we have wallet access
        if (wallet?.agentPublicKey && agentSecret) {
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              agentSecret,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[ForceDelete] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[ForceDelete] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please fund your agent wallet and try again.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        } else {
          return res.status(400).json({
            error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments. Agent wallet access is required to pay these.`,
            pendingIOUs: pendingIOUs.length,
            totalOwed
          });
        }
      }
      
      // Pacifica subaccount sweep — transfer funds back to agent wallet before deletion
      if (getBotSubaccountContext(bot) && agentAddress) {
        const sweepResult = await sweepPacificaSubaccount(bot, agentAddress, '[ForceDelete]', agentSecret);
        if (sweepResult.handled) {
          if (sweepResult.error && sweepResult.amount > 0.01) {
            return res.status(500).json({
              error: `Cannot delete bot - failed to sweep $${sweepResult.amount.toFixed(2)} from Pacifica subaccount: ${sweepResult.error}`,
              message: "Please withdraw funds manually before deleting."
            });
          }
          await storage.deleteTradingBot(req.params.id);
          let message = 'Bot deleted';
          if (sweepResult.swept) {
            message = sweepResult.withdrawnToWallet
              ? `Returned $${sweepResult.amount.toFixed(2)} USDC to your agent wallet before deletion`
              : `Moved $${sweepResult.amount.toFixed(2)} USDC to your main account; it will return to your wallet shortly`;
          }
          return res.json({
            success: true,
            swept: sweepResult.swept,
            withdrawnToWallet: sweepResult.withdrawnToWallet ?? false,
            amount: sweepResult.amount,
            message
          });
        }
      }

      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress || !agentSecret) {
          console.error(`[ForceDelete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent keys are missing`);
          return res.status(500).json({
            error: "Cannot sweep bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to access the agent wallet to sweep funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Legacy: Must have a drift subaccount to sweep
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        // No subaccount, just delete directly
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Check balance using correct agent wallet address
      const balance = await getExchangeBalance(agentAddress, bot.driftSubaccountId, getAdapterForBot(bot));
      
      if (balance <= 0.01) {
        // No meaningful balance, try to close subaccount to reclaim rent
        let rentReclaimed = false;
        if (agentSecret) {
          try {
            const closeResult = await closeDriftSubaccount(
              agentSecret,
              bot.driftSubaccountId,
              getAdapterForBot(bot)
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
              rentReclaimed = true;
            }
          } catch (closeErr) {
            console.warn(`[Delete] Rent reclaim failed:`, closeErr);
          }
        }
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false, rentReclaimed });
      }

      // Auto-sweep: Transfer funds from bot's subaccount to main account (subaccount 0)
      // This is done server-side using the agent wallet
      if (agentSecret && bot.driftSubaccountId !== 0) {
        try {
          console.log(`[Delete] Auto-sweeping $${balance.toFixed(2)} from subaccount ${bot.driftSubaccountId} to main account`);
          const sweepResult = await executeAgentTransferBetweenSubaccounts(
            agentAddress,
            agentSecret,
            bot.driftSubaccountId,
            0, // to main account
            balance,
            getAdapterForBot(bot)
          );
          
          if (sweepResult.success) {
            console.log(`[Delete] Sweep successful: ${sweepResult.signature}`);
            
            // Try to close the now-empty subaccount
            let rentReclaimed = false;
            try {
              const closeResult = await closeDriftSubaccount(
                agentSecret,
                bot.driftSubaccountId,
                getAdapterForBot(bot)
              );
              if (closeResult.success) {
                console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
                rentReclaimed = true;
              }
            } catch (closeErr) {
              console.warn(`[Delete] Rent reclaim failed:`, closeErr);
            }
            
            await storage.deleteTradingBot(req.params.id);
            return res.json({ 
              success: true, 
              swept: true, 
              amount: balance,
              txSignature: sweepResult.signature,
              rentReclaimed,
              message: `Swept $${balance.toFixed(2)} USDC to main account before deletion`
            });
          } else {
            // Sweep failed - don't delete, let user know
            return res.status(500).json({
              error: "Failed to sweep funds before deletion",
              sweepError: sweepResult.error,
              balance,
              driftSubaccountId: bot.driftSubaccountId,
              message: `Could not transfer $${balance.toFixed(2)} from subaccount. Please withdraw manually first.`
            });
          }
        } catch (sweepErr: any) {
          console.error(`[Delete] Sweep error:`, sweepErr);
          return res.status(500).json({
            error: "Sweep transaction failed",
            details: sweepErr.message,
            balance,
            driftSubaccountId: bot.driftSubaccountId
          });
        }
      }

      // Subaccount 0 or no encrypted key - can't auto-sweep, inform user
      return res.status(409).json({
        error: "Bot has funds in main trading account",
        balance,
        driftSubaccountId: bot.driftSubaccountId,
        message: `This bot has $${balance.toFixed(2)} USDC. Please withdraw from Trading Account to Agent Wallet first via Wallet Management.`
      });
    } catch (error) {
      console.error("Force delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      _forceDeleteCleanup?.();
    }
  });

  // Confirm deletion after sweep transaction is confirmed (legacy endpoint)
  app.post("/api/trading-bots/:id/confirm-delete", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { txSignature } = req.body;
      
      // Get the wallet's agent key for subaccount operations
      const wallet = await storage.getWallet(req.walletAddress!);

      // Safety check: verify wallet exists for bots with subaccounts
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && !wallet?.agentPublicKey) {
        console.error(`[ConfirmDelete] Warning: Bot ${bot.id} has subaccount but wallet is missing`);
        // Still allow deletion since this is a confirmation after user signed sweep tx
      }

      // Try to close the subaccount to reclaim rent (~0.035 SOL)
      let rentReclaimed = false;
      let _confirmDeleteCleanup: (() => void) | null = null;
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && wallet?.agentPrivateKeyEncryptedV3 && wallet?.agentPublicKey) {
        const _cdUmk = await getUmkForWebhook(req.walletAddress!);
        if (!_cdUmk) {
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        const _cdKey = await decryptAgentKeyStrict(req.walletAddress!, _cdUmk.umk, wallet, wallet.agentPublicKey);
        if (!_cdKey) {
          _cdUmk.cleanup();
          return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
        }
        _confirmDeleteCleanup = () => { _cdKey.cleanup(); _cdUmk.cleanup(); };
        try {
          const closeResult = await closeDriftSubaccount(
            _cdKey.secretKey,
            bot.driftSubaccountId,
            getAdapterForBot(bot)
          );
          if (closeResult.success) {
            console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed after sweep, rent reclaimed`);
            rentReclaimed = true;
          } else {
            console.warn(`[Delete] Could not reclaim rent after sweep: ${closeResult.error}`);
          }
        } catch (closeErr) {
          console.warn(`[Delete] Rent reclaim failed after sweep:`, closeErr);
        }
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true, txSignature, rentReclaimed });
      _confirmDeleteCleanup?.();
    } catch (error) {
      console.error("Confirm delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot trades routes
  app.get("/api/trading-bots/:id/trades", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getBotTrades(req.params.id, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trading-bots/:id/performance", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const timeframe = (req.query.timeframe as string) || '7d';
      let since: Date | undefined;
      const now = new Date();
      switch (timeframe) {
        case '7d':
          since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case 'all':
        default:
          since = undefined;
          break;
      }

      const tradeSeries = await storage.getBotPerformanceSeries(req.params.id, since);
      
      // Add initial 0 point at bot creation date for proper chart baseline
      const botCreatedAt = new Date(bot.createdAt);
      const initialPoint = {
        timestamp: botCreatedAt,
        pnl: 0,
        cumulativePnl: 0,
      };
      
      // Only add initial point if it's before the first trade and within requested timeframe
      let series = tradeSeries;
      const shouldAddInitialPoint = !since || botCreatedAt >= since;
      if (shouldAddInitialPoint) {
        if (tradeSeries.length === 0 || botCreatedAt < tradeSeries[0].timestamp) {
          series = [initialPoint, ...tradeSeries];
        }
      }
      
      const totalPnl = tradeSeries.length > 0 ? tradeSeries[tradeSeries.length - 1].cumulativePnl : 0;
      res.json({
        series,
        totalPnl,
        tradeCount: tradeSeries.length,
      });
    } catch (error) {
      console.error("Get bot performance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bot-trades", requireWallet, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getWalletBotTrades(req.walletAddress!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get wallet bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/portfolio/bot-performance", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);

      // Range filtering — mirrors the portfolio-performance endpoint convention
      const validRanges = ['7d', '1m', '3m', '12m', 'all'] as const;
      type RangeParam = typeof validRanges[number];
      const rawRange = (req.query.range as string | undefined)?.toLowerCase();
      const rangeParam: RangeParam = (validRanges as readonly string[]).includes(rawRange ?? '') ? (rawRange as RangeParam) : 'all';

      let sinceDate: Date | undefined;
      const now = new Date();
      if (rangeParam === '7d') {
        sinceDate = new Date(now); sinceDate.setDate(sinceDate.getDate() - 7);
      } else if (rangeParam === '1m') {
        sinceDate = new Date(now); sinceDate.setDate(sinceDate.getDate() - 30);
      } else if (rangeParam === '3m') {
        sinceDate = new Date(now); sinceDate.setDate(sinceDate.getDate() - 90);
      } else if (rangeParam === '12m') {
        sinceDate = new Date(now); sinceDate.setDate(sinceDate.getDate() - 365);
      }

      // One query for all trades, then filter by range
      const allTrades = await storage.getWalletBotTrades(req.walletAddress!, 10000);
      const executed = allTrades.filter(t => {
        if (t.status !== "executed" || t.pnl === null || !t.executedAt) return false;
        if (sinceDate && new Date(t.executedAt) < sinceDate) return false;
        return true;
      });

      // Group trades by bot ID
      const tradesByBot: Record<string, typeof executed> = {};
      for (const bot of bots) tradesByBot[bot.id] = [];
      for (const trade of executed) {
        if (trade.tradingBotId && tradesByBot[trade.tradingBotId] !== undefined) {
          tradesByBot[trade.tradingBotId].push(trade);
        }
      }

      // Annualised Sharpe ratio from daily net P&L returns (uses trading-day factor √252)
      function computeSharpe(botTradeList: typeof executed): number | null {
        if (botTradeList.length < 2) return null;
        const dailyPnl: Record<string, number> = {};
        for (const t of botTradeList) {
          const day = new Date(t.executedAt!).toISOString().slice(0, 10);
          const net = parseFloat(t.pnl as string || "0") - parseFloat(t.fee as string || "0");
          dailyPnl[day] = (dailyPnl[day] ?? 0) + net;
        }
        const returns = Object.values(dailyPnl);
        if (returns.length < 2) return null;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        const std = Math.sqrt(variance);
        if (std === 0) return null;
        return Math.round((mean / std) * Math.sqrt(252) * 100) / 100;
      }

      // Per-bot net deposits (for pnlPercent). Sequential is fine — bots/wallet
      // is a small set and this route refetches every 60s.
      const netDepositedByBot: Record<string, number> = {};
      for (const bot of bots) {
        try {
          const events = await storage.getBotEquityEvents(bot.id, 1000);
          netDepositedByBot[bot.id] = events.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
        } catch {
          netDepositedByBot[bot.id] = 0;
        }
      }
      const totalNetDeposited = Object.values(netDepositedByBot).reduce((a, b) => a + b, 0);

      const botPerformance = bots.map((bot) => {
        const botTradeList = (tradesByBot[bot.id] || []).sort(
          (a, b) => new Date(a.executedAt!).getTime() - new Date(b.executedAt!).getTime()
        );

        let cumPnl = 0;
        let wins = 0;
        const sparkline: { t: string; v: number }[] = [];

        for (const t of botTradeList) {
          const net = parseFloat(t.pnl as string || "0") - parseFloat(t.fee as string || "0");
          cumPnl += net;
          sparkline.push({ t: new Date(t.executedAt!).toISOString().slice(0, 10), v: Math.round(cumPnl * 100) / 100 });
          if (net > 0) wins++;
        }

        const totalTrades = botTradeList.length;
        const deposited = netDepositedByBot[bot.id] ?? 0;
        const pnlPercent = deposited > 0 ? Math.round((cumPnl / deposited) * 10000) / 100 : 0;
        return {
          id: bot.id,
          name: bot.name,
          market: bot.market,
          isActive: bot.isActive,
          netPnl: Math.round(cumPnl * 100) / 100,
          pnlPercent,
          netDeposited: Math.round(deposited * 100) / 100,
          totalTrades,
          winRate: totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0,
          sharpe: computeSharpe(botTradeList),
          sparkline,
        };
      });

      botPerformance.sort((a, b) => b.netPnl - a.netPnl);

      // Market-level P&L breakdown for the same range. We don't have per-market
      // deposits, so percent is taken vs the wallet's total net deposited so the
      // numbers stay comparable across markets.
      const marketPnl: Record<string, { pnl: number; count: number; wins: number }> = {};
      for (const trade of executed) {
        const net = parseFloat(trade.pnl as string || "0") - parseFloat(trade.fee as string || "0");
        const market = trade.market || "Unknown";
        if (!marketPnl[market]) marketPnl[market] = { pnl: 0, count: 0, wins: 0 };
        marketPnl[market].pnl += net;
        marketPnl[market].count += 1;
        if (net > 0) marketPnl[market].wins += 1;
      }

      const markets = Object.entries(marketPnl)
        .map(([market, data]) => ({
          market,
          pnl: Math.round(data.pnl * 100) / 100,
          pnlPercent: totalNetDeposited > 0
            ? Math.round((data.pnl / totalNetDeposited) * 10000) / 100
            : 0,
          count: data.count,
          winRate: data.count > 0 ? Math.round((data.wins / data.count) * 100) : 0,
        }))
        .sort((a, b) => b.pnl - a.pnl);

      res.json({ bots: botPerformance, markets, range: rangeParam });
    } catch (error) {
      console.error("Bot performance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get bot's current position
  app.get("/api/trading-bots/:id/position", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPublicKey) {
        return res.json({ hasPosition: false, source: 'none' });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const posBotCtx = getBotSubaccountContext(bot);
      const posQueryAccount = posBotCtx ? posBotCtx.botPublicKey : wallet.agentPublicKey;
      const posQuerySubId = posBotCtx ? 0 : subAccountId;
      
      // Use PositionService - always queries on-chain first, auto-corrects database drift
      const posData = await PositionService.getPosition(
        bot.id,
        bot.walletAddress,
        posQueryAccount,
        posQuerySubId,
        bot.market,
        posBotCtx?.botPublicKey
      );

      if (!posData.position?.hasPosition) {
        return res.json({ 
          hasPosition: false, 
          source: posData.source,
          driftDetected: posData.driftDetected,
        });
      }

      let posCurrentPrice = posData.position.currentPrice;
      let posUnrealizedPnl = posData.position.unrealizedPnl;
      const oraclePrice = await getMarketPrice(bot.market, getAdapterForBot(bot));
      if (oraclePrice && oraclePrice > 0) {
        posCurrentPrice = oraclePrice;
        const baseSize = posData.position.size ?? 0;
        if (baseSize > 0.0001) {
          posUnrealizedPnl = posData.position.side === 'LONG'
            ? (oraclePrice - posData.position.avgEntryPrice) * baseSize
            : (posData.position.avgEntryPrice - oraclePrice) * baseSize;
        }
      }

      res.json({
        hasPosition: true,
        side: posData.position.side,
        size: posData.position.size,
        avgEntryPrice: posData.position.avgEntryPrice,
        currentPrice: posCurrentPrice,
        unrealizedPnl: posUnrealizedPnl,
        realizedPnl: posData.position.realizedPnl,
        market: posData.position.market,
        source: posData.source,
        staleWarning: posData.staleWarning,
        driftDetected: posData.driftDetected,
        driftDetails: posData.driftDetails,
        healthFactor: posData.healthMetrics?.healthFactor,
        liquidationPrice: posData.healthMetrics?.liquidationPrice,
        totalCollateral: posData.healthMetrics?.totalCollateral,
        freeCollateral: posData.healthMetrics?.freeCollateral,
      });
    } catch (error) {
      console.error("Get bot position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // TradingView Webhook endpoint - receives signals from TradingView strategy alerts
  app.post("/api/webhook/tradingview/:botId", async (req, res) => {
    const webhookStartTime = Date.now();
    const { botId } = req.params;
    const { secret } = req.query;
    
    console.log(`[Webhook] ⏱️ START botId=${botId.slice(0, 8)}... at ${new Date().toISOString()}`);
    console.log(`[WEBHOOK-TRACE] ========== WEBHOOK RECEIVED ==========`);
    console.log(`[WEBHOOK-TRACE] Bot ID: ${botId}`);
    console.log(`[WEBHOOK-TRACE] Timestamp: ${new Date().toISOString()}`);
    console.log(`[WEBHOOK-TRACE] Payload: ${JSON.stringify(req.body).slice(0, 500)}`);
    
    // Generate signal hash for deduplication
    const signalHash = generateSignalHash(botId, req.body);
    
    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId,
        payload: req.body,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[Webhook] Bot ${botId} not found (deleted) - ignoring signal`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted. Please remove this alert from TradingView." });
      }
      throw dbError;
    }

    try {
      // Get bot
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }
      
      const botPublishedInfo = await storage.getPublishedBotByTradingBotId(botId);
      console.log(`[WEBHOOK-TRACE] Bot found: name="${bot.name}", market=${bot.market}`);
      console.log(`[WEBHOOK-TRACE] Bot publish status: isPublished=${!!botPublishedInfo}, publishedBotId=${botPublishedInfo?.id || 'none'}`);
      console.log(`[WEBHOOK-TRACE] Bot active: ${bot.isActive}`);

      // Validate secret
      if (secret !== bot.webhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Check if bot is active
      if (!bot.isActive) {
        // DECOUPLED ROUTING: If source bot is published, still route signal to subscribers
        // Subscribers should trade independently even if creator's bot is paused/underfunded
        if (botPublishedInfo && botPublishedInfo.isActive) {
          const routingSignal = parseSignalForRouting(req.body);
          if (routingSignal.action) {
            console.log(`[Webhook] Source bot ${botId.slice(0, 8)}... is paused but published - routing ${routingSignal.action} (close=${routingSignal.isCloseSignal}) to subscribers`);
            routeSignalToSubscribers(botId, {
              action: routingSignal.action as 'buy' | 'sell',
              contracts: routingSignal.contracts,
              positionSize: routingSignal.contracts,
              price: routingSignal.price,
              isCloseSignal: routingSignal.isCloseSignal,
              strategyPositionSize: routingSignal.strategyPositionSize,
            }).catch(err => console.error(`[Subscriber Routing] Error routing from paused source ${botId.slice(0, 8)}...:`, err));
          }
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused (subscribers routed)" });
        } else {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused" });
        }
        return res.status(400).json({ error: "Bot is paused" });
      }

      // Security v3: Check execution authorization
      const ownerWallet = await storage.getWallet(bot.walletAddress);
      if (!ownerWallet) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Wallet not found" });
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      if (ownerWallet.emergencyStopTriggered) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Emergency stop active" });
        return res.status(403).json({ error: "Trade execution blocked: Emergency stop is active for this wallet" });
      }
      
      if (!ownerWallet.executionEnabled) {
        if (botPublishedInfo && botPublishedInfo.isActive) {
          const routingSignal = parseSignalForRouting(req.body);
          if (routingSignal.action) {
            console.log(`[Webhook] Source bot ${botId.slice(0, 8)}... execution disabled but published - routing ${routingSignal.action} (close=${routingSignal.isCloseSignal}) to subscribers`);
            routeSignalToSubscribers(botId, {
              action: routingSignal.action as 'buy' | 'sell',
              contracts: routingSignal.contracts,
              positionSize: routingSignal.contracts,
              price: routingSignal.price,
              isCloseSignal: routingSignal.isCloseSignal,
              strategyPositionSize: routingSignal.strategyPositionSize,
            }).catch(err => console.error(`[Subscriber Routing] Error routing from auth-disabled source ${botId.slice(0, 8)}...:`, err));
          }
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization required (subscribers routed)" });
        } else {
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization required" });
        }
        return res.status(403).json({ error: "Trade execution disabled. Please enable automated trading in the app." });
      }
      
      if (ownerWallet.executionExpiresAt && new Date() > ownerWallet.executionExpiresAt) {
        if (botPublishedInfo && botPublishedInfo.isActive) {
          const routingSignal = parseSignalForRouting(req.body);
          if (routingSignal.action) {
            console.log(`[Webhook] Source bot ${botId.slice(0, 8)}... execution expired but published - routing ${routingSignal.action} (close=${routingSignal.isCloseSignal}) to subscribers`);
            routeSignalToSubscribers(botId, {
              action: routingSignal.action as 'buy' | 'sell',
              contracts: routingSignal.contracts,
              positionSize: routingSignal.contracts,
              price: routingSignal.price,
              isCloseSignal: routingSignal.isCloseSignal,
              strategyPositionSize: routingSignal.strategyPositionSize,
            }).catch(err => console.error(`[Subscriber Routing] Error routing from expired-auth source ${botId.slice(0, 8)}...:`, err));
          }
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization expired (subscribers routed)" });
        } else {
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization expired" });
        }
        await storage.updateWalletExecution(bot.walletAddress, {
          executionEnabled: false,
          umkEncryptedForExecution: null,
          executionExpiresAt: null,
        });
        return res.status(403).json({ error: "Trade execution authorization expired. Please re-enable automated trading." });
      }

      // Security v3: Verify execution key can be unwrapped (validates SERVER_EXECUTION_KEY is correct)
      // This ensures the EUMK_exec is valid and the server has the correct key material
      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Invalid execution authorization" });
        return res.status(403).json({ error: "Invalid execution authorization. Please re-enable automated trading." });
      }
      
      // Security v3: Verify bot policy HMAC if one exists (detects tampering with critical settings)
      if (bot.policyHmac) {
        const policyValid = verifyBotPolicyHmac(
          umkResult.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize },
          bot.policyHmac
        );
        if (!policyValid) {
          umkResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Bot policy tampered" });
          return res.status(403).json({ error: "Bot configuration has been tampered with. Please reconfigure the bot." });
        }
      }
      
      // Security v3 (Phase 3 strict): V3-only — fail explicitly if owner has not migrated to v3.
      const agentKeyResult = await decryptAgentKeyStrict(
        bot.walletAddress,
        umkResult.umk,
        ownerWallet,
        ownerWallet.agentPublicKey
      );
      
      // Cleanup the unwrapped UMK immediately after deriving agent key
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        // Agent key decryption failed - this is a critical error
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Agent key decryption failed" });
        return res.status(403).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet." });
      }
      
      // Log migration status for tracking
      const usedV3 = ownerWallet.agentPrivateKeyEncryptedV3 ? true : false;
      if (usedV3) {
        console.log(`[Webhook] Agent key decryption: v3 path used for ${bot.walletAddress.slice(0, 8)}...`);
      } else {
        console.log(`[Webhook] Agent key decryption: legacy fallback used for ${bot.walletAddress.slice(0, 8)}... (v3 not yet migrated)`);
      }
      
      // Helper to cleanup agent key after use (defined early for use in error paths)
      const cleanupAgentKey = () => {
        agentKeyResult.cleanup();
      };
      
      // DEBUG: Validate secret key bytes before encoding
      const nonZeroBytes = Array.from(agentKeyResult.secretKey).filter(b => b !== 0).length;
      console.log(`[Webhook] Secret key validation: length=${agentKeyResult.secretKey.length}, nonZeroBytes=${nonZeroBytes}`);
      if (nonZeroBytes === 0) {
        cleanupAgentKey();
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent key is all zeros - possible encryption/decryption issue" });
        return res.status(500).json({ error: "Agent key decryption produced invalid key (all zeros). Please reconfigure your agent wallet." });
      }
      
      // Convert secretKey (Uint8Array) to base58 for passing to executor
      const privateKeyBase58 = bs58.encode(agentKeyResult.secretKey);
      
      // DEBUG: Log base58 key length and first few chars (not the full key for security)
      console.log(`[Webhook] Base58 key: length=${privateKeyBase58.length}`);

      // PHASE 6.2: Wrap execution in try/finally to ensure agent key cleanup
      try {

      // Parse TradingView strategy signal
      // Expected JSON format:
      // {
      //   "signalType": "trade",
      //   "data": { "action": "buy", "contracts": "33.33", "positionSize": "100" },
      //   "symbol": "SOLUSD",
      //   "price": "195.50",
      //   "time": "2025-01-09T12:00:00Z",
      //   "position_size": "0"  // NEW: strategy.position_size - 0 means closing position (SL/TP)
      // }
      const payload = req.body;
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let strategyPositionSize: string | null = null; // NEW: Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      // This ensures close signal detection works regardless of payload format
      if (typeof payload === 'object' && payload !== null) {
        // Check for position_size at root level (most common format)
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        // Also check nested data.position_size
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        // Extract other common fields from root level
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

      // Try parsing as the new JSON format first
      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        // New JSON format
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        // Parse strategy.position_size for close signal detection
        if (payload.position_size !== undefined) strategyPositionSize = String(payload.position_size);
        if (payload.data.position_size !== undefined) strategyPositionSize = String(payload.data.position_size);
        console.log(`[Webhook] Parsed JSON signal: action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}, time=${signalTime}, strategyPositionSize=${strategyPositionSize}`);
      } else {
        // Fallback: legacy format parsing
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        // Try regex parsing for legacy format: "order buy @ 33.33 filled on TICKER. New strategy position is 100"
        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
          strategyPositionSize = match[4]; // Legacy format includes position size
        } else {
          // Fallback: try simple JSON parsing
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size !== undefined) {
              positionSize = String(parsed.position_size);
              strategyPositionSize = String(parsed.position_size);
            }
          } catch {
            // Last resort: simple keyword detection
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
        console.log(`[Webhook] Parsed legacy signal: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}`);
      }

      // Map TradingView action to trade side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check if bot allows this side
      if (side && bot.side !== 'both') {
        if (bot.side === 'long' && side !== 'long') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts long signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts long signals" });
        }
        if (bot.side === 'short' && side !== 'short') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts short signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts short signals" });
        }
      }

      if (!side) {
        await storage.updateWebhookLog(log.id, { errorMessage: "No valid action found (expected buy or sell)", processed: true });
        return res.status(400).json({ error: "No valid action found", received: payload });
      }

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);

      // ── Signal classifier (partial-close / flip disambiguation) ──────────
      // Fetch the DB position BEFORE any on-chain read to avoid Pacifica's
      // ~10s propagation lag that would cause a stale read to misclassify a
      // partial reduce as OPEN or FLIP.
      const dbPositionForClassification = await storage.getBotPosition(botId, bot.market);
      const classifiedSignal = classifySignal(
        {
          side: dbPositionForClassification
            ? (parseFloat(dbPositionForClassification.baseSize) > 0 ? 'LONG' : parseFloat(dbPositionForClassification.baseSize) < 0 ? 'SHORT' : 'FLAT')
            : 'FLAT',
          size: dbPositionForClassification ? Math.abs(parseFloat(dbPositionForClassification.baseSize)) : 0,
          entryPrice: dbPositionForClassification ? parseFloat(dbPositionForClassification.avgEntryPrice) : 0,
        },
        {
          action: side as 'buy' | 'sell',
          contracts: parseFloat(contracts),
          strategyPositionSize: strategyPositionSize !== null ? parseFloat(strategyPositionSize) : null,
        },
      );
      const isPartialClose = !isCloseSignal && classifiedSignal.type === 'PARTIAL_CLOSE';
      const partialCloseSize = isPartialClose ? classifiedSignal.closeSize : 0;
      const partialCloseFraction = isPartialClose ? classifiedSignal.closedFraction : 0;
      if (isPartialClose) {
        console.log(`[Webhook] *** PARTIAL CLOSE DETECTED *** (slice=${partialCloseSize.toFixed(4)}, fraction=${(partialCloseFraction * 100).toFixed(1)}%, classified=${classifiedSignal.type})`);
      }

      const webhookBotCtx = getBotSubaccountContext(bot);
      console.log(`[Webhook] Signal: action=${action}, contracts=${contracts}, close=${isCloseSignal}, published=${!!botPublishedInfo}, pacificaSubaccount=${!!webhookBotCtx}`);
      console.log(`[WEBHOOK-TRACE] ========== SIGNAL BRANCHING ==========`);
      console.log(`[WEBHOOK-TRACE] isCloseSignal=${isCloseSignal} (will take ${isCloseSignal ? 'CLOSE' : 'OPEN/REGULAR'} path)`);
      console.log(`[WEBHOOK-TRACE] Bot isPublished=${!!botPublishedInfo} - routing ${botPublishedInfo ? 'WILL' : 'will NOT'} be attempted`);
      
      // CRITICAL FIX: Wrap entire close signal handling in outer try/catch to guarantee no fallthrough
      // to open-order logic. Any exception inside this block MUST return, not continue to open-order flow.
      if (isCloseSignal) {
        console.log(`[Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler (GUARANTEED RETURN)`);
        
        try {
          // === BEGIN CLOSE SIGNAL HANDLING - All paths must return ===
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
          await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
          return res.status(400).json({ error: "Agent wallet not configured" });
        }
        
        const subAccountId = bot.driftSubaccountId ?? 0;
        const queryAccount = webhookBotCtx ? webhookBotCtx.botPublicKey : wallet.agentPublicKey;
        const querySubId = webhookBotCtx ? 0 : subAccountId;
        console.log(`[Webhook] Close signal: querying position for bot=${bot.name}, market=${bot.market}, account=${queryAccount}, subaccount=${querySubId}`);
        
        let onChainPosition;
        try {
          onChainPosition = await PositionService.getPositionForExecution(
            botId,
            queryAccount,
            querySubId,
            bot.market,
            webhookBotCtx?.botPublicKey
          );
          console.log(`[Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
        } catch (onChainErr) {
          console.error(`[Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Failed to query on-chain position - cannot safely close", 
            processed: true 
          });
          return res.status(500).json({ error: "Failed to query on-chain position" });
        }
        
        if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
          // No position to close - this is likely a SL/TP for a position that doesn't exist in this bot
          console.log(`[Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Close signal ignored - no on-chain position", 
            processed: true 
          });

          if (botPublishedInfo && botPublishedInfo.isActive) {
            console.log(`[Webhook] Source bot flat but published - routing close signal to subscribers`);
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || '0',
              isCloseSignal: true,
              strategyPositionSize,
            }).catch(err => console.error(`[Subscriber Routing] Error routing close from flat source:`, err));
          }

          return res.status(200).json({ 
            status: "skipped", 
            reason: "No on-chain position to close - this may be a stale SL/TP signal" 
          });
        }
        
        // There IS an on-chain position to close - use ACTUAL on-chain size
        const currentPositionSize = onChainPosition.size;
        console.log(`[Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
        
        // Determine close side (opposite of current position)
        const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
        const closeSize = Math.abs(currentPositionSize);
        const webhookPositionSide: 'long' | 'short' = onChainPosition.side === 'LONG' ? 'long' : 'short';
        
        // Capture entry price BEFORE trying to close (needed for retry queue if close fails)
        const closeEntryPrice = onChainPosition.entryPrice || 0;
        
        // Pending row — no protocolFillId yet. The canonical `tx-<sig>`
        // identity is set atomically when the close completes so it
        // matches the key the reconciler/retry would use for the same
        // on-chain close (cross-path dedup via the unique index).
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: payload,
          executionMethod: 'legacy',
        });
        
        try {
          // Execute close order on Drift using closePerpPosition
          // Pass closeSize and positionSide so Swift can be used for closes
          const closeSubAccountId = webhookBotCtx ? 0 : (bot.driftSubaccountId ?? 0);
          const closeSlippageBps2 = wallet.slippageBps ?? 50;
          const execStartTime = Date.now();
          console.log(`[Webhook] ⏱️ CLOSE EXEC START at +${execStartTime - webhookStartTime}ms, closeSize=${closeSize}, slippage=${closeSlippageBps2}bps`);
          const result = await closePerpPosition(
            agentKeyResult.secretKey,
            bot.market,
            closeSubAccountId,
            closeSize,
            closeSlippageBps2,
            privateKeyBase58,
            wallet.agentPublicKey!,
            webhookPositionSide,
            webhookBotCtx,
            bot.walletAddress,
            getAdapterForBot(bot),
          );
          
          // closePerpPosition returns { success, signature, error } - map to expected format
          const execEndTime = Date.now();
          console.log(`[Webhook] ⏱️ CLOSE EXEC END at +${execEndTime - webhookStartTime}ms (took ${execEndTime - execStartTime}ms), success=${result.success}`);
          const txSignature = result.signature || null;
          
          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is a benign case - position was already flat or closed by another process
          if (result.success && !txSignature) {
            console.log(`[Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && txSignature) {
            // Calculate fee (0.05% taker fee on notional value)
            // Since closePerpPosition doesn't return fillPrice, use the signal price as estimate
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * getExchangeFeeRate();
            
            // Calculate trade PnL based on entry and exit prices
            // IMPORTANT: closeEntryPrice was captured BEFORE close attempt
            console.log(`[Webhook] PnL calculation inputs: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice}, closeSide=${closeSide}, closeSize=${closeSize}`);
            
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                // Closing LONG: profit if exitPrice > entryPrice
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                // Closing SHORT: profit if entryPrice > exitPrice
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[Webhook] Close PnL CALCULATED: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${closeTradePnl.toFixed(4)}`);
            } else {
              console.warn(`[Webhook] PnL NOT calculated: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice} - one or both are zero`);
            }
            
            // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
            // This handles partial fills and ensures position is truly flat
            // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
            let finalTxSignature = txSignature;
            let retryCount = 0;
            const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
            
            while (retryCount < maxRetries) {
              try {
                // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
                const delayMs = 1000;
                console.log(`[Webhook] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                
                const postClosePosition = await PositionService.getPositionForExecution(
                  botId,
                  wallet.agentPublicKey,
                  subAccountId,
                  bot.market,
                  webhookBotCtx?.botPublicKey
                );
                
                if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
                  console.log(`[Webhook] Post-close verification: Position confirmed FLAT`);
                  break; // Position fully closed, exit retry loop
                }
                
                // Position still exists - this is dust that needs cleanup
                console.warn(`[Webhook] Position NOT fully closed after close order (attempt ${retryCount + 1}/${maxRetries})`);
                console.warn(`[Webhook] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
                
                // Retry closePerpPosition to clean up the dust
                const webhookDustSlippageBps = wallet.slippageBps ?? 50;
                const retryResult = await closePerpPosition(
                  agentKeyResult.secretKey,
                  bot.market,
                  subAccountId,
                  Math.abs(postClosePosition.size),
                  webhookDustSlippageBps,
                  privateKeyBase58,
                  wallet.agentPublicKey!,
                  postClosePosition.side === 'LONG' ? 'long' : 'short',
                  undefined,
                  undefined,
                  getAdapterForBot(bot),
                );
                
                if (retryResult.success && retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
                  finalTxSignature = retryResult.signature; // Use the latest successful signature
                } else if (retryResult.success && !retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup: position already closed`);
                  break;
                } else {
                  console.error(`[Webhook] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
                }
                
                retryCount++;
              } catch (verifyErr) {
                console.warn(`[Webhook] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
                retryCount++;
              }
            }
            
            // Final verification after all retries
            let finalPositionRemaining = null;
            try {
              const finalCheck = await PositionService.getPositionForExecution(
                botId,
                wallet.agentPublicKey,
                subAccountId,
                bot.market,
                webhookBotCtx?.botPublicKey
              );
              if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
                finalPositionRemaining = { side: finalCheck.side, size: finalCheck.size };
                console.error(`[Webhook] CRITICAL: Position still not flat after ${maxRetries} cleanup attempts!`);
                console.error(`[Webhook] Final remaining: ${finalCheck.side} ${finalCheck.size}`);
              }
            } catch (finalVerifyErr) {
              console.warn(`[Webhook] Could not perform final position verification:`, finalVerifyErr);
            }
            
            // If dust still remains after all retries, log error but continue
            if (finalPositionRemaining) {
              await storage.updateBotTrade(closeTrade.id, {
                status: "executed",
                txSignature: finalTxSignature,
                price: result.fillPrice ? String(result.fillPrice) : signalPrice,
                fee: String(closeFee),
                pnl: String(closeTradePnl),
                errorMessage: `WARNING: Position not fully closed after ${maxRetries} attempts. Remaining: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`,
                executionMethod: result.executionMethod || 'legacy',
              });
              
              await storage.updateWebhookLog(log.id, { 
                processed: true, 
                tradeExecuted: true,
                errorMessage: `Close executed but dust remains after ${maxRetries} attempts: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`
              });
              
              return res.json({
                status: "partial",
                warning: `Position not fully closed after ${maxRetries} attempts - dust remains`,
                type: "close",
                trade: closeTrade.id,
                txSignature: finalTxSignature,
                closedSize: closeSize,
                side: closeSide,
                remainingPosition: finalPositionRemaining,
              });
            }
            
            // Update trade record with execution details and PnL (use finalTxSignature which may include retry signatures)
            // Atomic: mark close row executed + recompute stats counters in
            // a single DB transaction. PnL/volume deltas are merged here so
            // the deferred sync only handles position state, not stats.
            const webhookClosePrice = result.fillPrice ?? parseFloat(signalPrice || "0");
            const webhookCloseVolume = closeSize * (Number.isFinite(webhookClosePrice) ? webhookClosePrice : 0);
            await storage.recordCloseEventAtomic({
              botId,
              update: {
                tradeId: closeTrade.id,
                fields: {
                  status: "executed",
                  txSignature: finalTxSignature,
                  price: result.fillPrice ? String(result.fillPrice) : signalPrice,
                  fee: String(closeFee),
                  pnl: String(closeTradePnl),
                  executionMethod: result.executionMethod || 'legacy',
                  protocolFillId: DatabaseStorage.canonicalCloseFillId({
                    signature: finalTxSignature,
                    botId,
                    side: 'CLOSE',
                    size: closeSize,
                    market: bot.market,
                    fillPrice: result.fillPrice ?? parseFloat(signalPrice || '0'),
                    timestampMs: Date.now(),
                  }),
                },
              },
              deltas: {
                totalPnlDelta: closeTradePnl,
                totalVolumeDelta: webhookCloseVolume,
                lastTradeAt: new Date().toISOString(),
              },
            });
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            console.log(`[Webhook] Position closed successfully: ${closeSize} ${bot.market} ${closeSide.toUpperCase()}`);
            res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: finalTxSignature,
              closedSize: closeSize,
              side: closeSide,
            });

            console.log(`[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS (CLOSE) ==========`);
            console.log(`[WEBHOOK-TRACE] Calling routeSignalToSubscribers for bot ${botId}`);
            console.log(`[WEBHOOK-TRACE] Signal: action=${action}, contracts=${contracts}, isCloseSignal=true, price=${signalPrice || closeFillPrice.toString()}`);
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || closeFillPrice.toString(),
              isCloseSignal: true,
              strategyPositionSize,
            }).then(() => {
              console.log(`[WEBHOOK-TRACE] CLOSE routing completed successfully for bot ${botId}`);
            }).catch(routingErr => {
              console.error(`[WEBHOOK-TRACE] CLOSE routing FAILED for bot ${botId}:`, routingErr);
              console.error(`[Subscriber Routing] Deferred routing error for bot ${botId}:`, routingErr);
            });

            // --- Deferred post-trade work (fire-and-forget, non-blocking) ---
            console.log('[Webhook] Response sent, deferring post-trade work...');
            (async () => {
              try {
                const syncResult = await syncPositionFromOnChain(
                  botId,
                  bot.walletAddress,
                  wallet.agentPublicKey!,
                  subAccountId,
                  bot.market,
                  closeTrade.id,
                  closeFee,
                  closeFillPrice,
                  closeSide,
                  closeSize,
                  webhookBotCtx?.botPublicKey
                );

              } catch (err) {
                console.error(`[Webhook] Deferred post-trade sync failed (non-blocking): ${err}`);
              }

              if (closeTradePnl > 0) {
                const tradeId = `${botId}-${Date.now()}`;
                distributeCreatorProfitShare({
                  subscriberBotId: botId,
                  subscriberWalletAddress: wallet.address,
                  subscriberAgentPublicKey: wallet.agentPublicKey!,
                  subscriberEncryptedPrivateKey: agentKeyResult.secretKey,
                  driftSubaccountId: subAccountId,
                  realizedPnl: closeTradePnl,
                  tradeId,
                }).then(result => {
                  if (result.success && result.amount) {
                    console.log(`[Webhook] Profit share distributed: $${result.amount.toFixed(4)}`);
                  } else if (!result.success && result.error) {
                    console.error(`[Webhook] Profit share failed: ${result.error}`);
                  }
                }).catch(err => console.error('[Webhook] Profit share error:', err));
              }

              if (bot.profitReinvest && getAdapterForBot(bot).getCapabilities().supportsSettlePnl) {
                try {
                  console.log(`[Webhook] Settling PnL for subaccount ${subAccountId} (profit reinvest enabled)`);
                  const settleResult = await settleAllPnl(agentKeyResult.secretKey, subAccountId, getAdapterForBot(bot));
                  if (settleResult.success) {
                    console.log(`[Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                  } else {
                    console.warn(`[Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                  }
                } catch (settleErr: any) {
                  console.warn(`[Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
                }
              }

              const autoWithdrawThreshold = parseFloat(bot.autoWithdrawThreshold || "0");
              if (autoWithdrawThreshold > 0) {
                try {
                  const botCtx = getBotSubaccountContext(bot);
                  const accountInfo = botCtx
                    ? await getExchangeAccountInfoForBot(wallet.agentPublicKey!, subAccountId, botCtx, getAdapterForBot(bot))
                    : await getExchangeAccountInfo(wallet.agentPublicKey!, subAccountId, getAdapterForBot(bot));
                  const currentEquity = accountInfo.totalCollateral;

                  if (currentEquity > autoWithdrawThreshold) {
                    const excessAmount = currentEquity - autoWithdrawThreshold;
                    const withdrawAmount = Math.floor(Math.max(0, excessAmount - 0.01) * 100) / 100;

                    // Each exchange enforces its own minimum on every money-movement leg.
                    // We hold the auto-withdraw until the excess accrues above the threshold
                    // so we never attempt a transfer the exchange will reject.
                    const minAutoWithdraw = getAdapterForBot(bot).minTransferAmount;

                    if (withdrawAmount >= minAutoWithdraw) {
                      console.log(`[Webhook] AUTO-WITHDRAW: Equity $${currentEquity.toFixed(2)} exceeds threshold $${autoWithdrawThreshold.toFixed(2)}, withdrawing $${withdrawAmount.toFixed(2)}`);

                      const webhookAwBotCtx = botCtx && bot.protocolSubaccountId ? botCtx : null;
                      if (webhookAwBotCtx && bot.protocolSubaccountId) {
                        const adapter = getAdapterForBot(bot);
                        const decryptedWh = await _resolveBotSubaccountSecretKey(webhookAwBotCtx);
                        try {
                          console.log(`[Webhook] AUTO-WITHDRAW Step 1: Transfer $${withdrawAmount.toFixed(2)} from bot subaccount ${bot.protocolSubaccountId} → main account`);
                          const transferResult = await adapter.transferBetweenSubaccounts({
                            agentSecretKey: decryptedWh.secretKey,
                            mainWalletAddress: wallet.agentPublicKey!,
                            fromSubaccountId: bot.protocolSubaccountId,
                            toSubaccountId: wallet.agentPublicKey!,
                            amount: withdrawAmount,
                          });

                          if (!transferResult.success) {
                            console.error(`[Webhook] AUTO-WITHDRAW transfer failed: ${transferResult.error}`);
                          } else {
                            console.log(`[Webhook] AUTO-WITHDRAW Step 2: Withdraw $${withdrawAmount.toFixed(2)} from main account → agent wallet`);
                            const withdrawResult = await executeAgentDriftWithdraw(
                              wallet.agentPublicKey!,
                              agentKeyResult.secretKey,
                              withdrawAmount,
                              0,
                              { tradingBotId: botId, context: 'Webhook AUTO-WITHDRAW' },
                              getAdapterForBot(bot)
                            );

                            if (withdrawResult.success) {
                              console.log(`[Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn to agent wallet, tx: ${withdrawResult.signature}`);
                              await storage.createEquityEvent({
                                walletAddress: bot.walletAddress,
                                tradingBotId: botId,
                                eventType: 'auto_withdraw',
                                amount: String(withdrawAmount),
                                txSignature: withdrawResult.signature || null,
                                notes: `Auto-withdraw: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)} (bot→main→wallet)`,
                              });
                            } else {
                              console.error(`[Webhook] AUTO-WITHDRAW on-chain withdraw failed: ${withdrawResult.error} (funds are in main account, use Recover button)`);
                            }
                          }
                        } finally {
                          decryptedWh.cleanup();
                        }
                      } else {
                        const withdrawResult = await executeAgentDriftWithdraw(
                          wallet.agentPublicKey!,
                          agentKeyResult.secretKey,
                          withdrawAmount,
                          subAccountId,
                          { tradingBotId: botId, context: 'Webhook AUTO-WITHDRAW' },
                          getAdapterForBot(bot)
                        );

                        if (withdrawResult.success) {
                          console.log(`[Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn, tx: ${withdrawResult.signature}`);
                          await storage.createEquityEvent({
                            walletAddress: bot.walletAddress,
                            tradingBotId: botId,
                            eventType: 'auto_withdraw',
                            amount: String(withdrawAmount),
                            txSignature: withdrawResult.signature || null,
                            notes: `Auto-withdraw triggered: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)}`,
                          });
                        } else {
                          console.error(`[Webhook] AUTO-WITHDRAW FAILED: ${withdrawResult.error}`);
                        }
                      }
                    } else if (excessAmount > 0) {
                      console.log(`[Webhook] AUTO-WITHDRAW skipped: candidate $${withdrawAmount.toFixed(4)} below minimum $${minAutoWithdraw} (equity $${currentEquity.toFixed(2)} vs threshold $${autoWithdrawThreshold.toFixed(2)}); funds will accumulate until threshold is met`);
                    }
                  }
                } catch (autoWithdrawErr: any) {
                  console.error(`[Webhook] AUTO-WITHDRAW check error (non-blocking):`, autoWithdrawErr.message);
                }
              }

              sendTradeNotification(wallet.address, {
                type: 'position_closed',
                botName: bot.name,
                market: bot.market,
                pnl: closeTradePnl,
              }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            })();

            return;
          } else {
            throw new Error(result.error || "Close order execution failed");
          }
        } catch (closeError: any) {
          console.error(`[Webhook] Close order failed:`, closeError);
          
          // Check if this is a transient error (rate limit, price feed, etc.) - queue for CRITICAL automatic retry
          if (isTransientError(closeError.message || String(closeError))) {
            console.log(`[Webhook] CRITICAL: Transient error on close order, queueing for priority retry`);
            
            const retryJobId = await queueTradeRetry({
              botId: bot.id,
              walletAddress: wallet.address,
              agentPublicKey: wallet.agentPublicKey!,
              market: bot.market,
              side: 'close',
              size: closeSize,
              subAccountId,
              reduceOnly: true,
              slippageBps: wallet.slippageBps ?? 50,
              priority: 'critical', // CLOSE orders get highest priority
              lastError: closeError.message,
              originalTradeId: closeTrade.id,
              entryPrice: closeEntryPrice, // For profit share calculation on retry success
            });
            
            await storage.updateBotTrade(closeTrade.id, {
              status: "pending",
              txSignature: null,
              errorMessage: `Rate limited - CRITICAL auto-retry queued (job: ${retryJobId})`,
            });
            await storage.updateWebhookLog(log.id, { 
              errorMessage: `Rate limited on close - CRITICAL retry queued: ${retryJobId}`, 
              processed: true 
            });
            
            return res.status(202).json({ 
              status: "queued_for_retry",
              retryJobId,
              type: "close",
              message: "CRITICAL: Close order rate limited - auto-retry scheduled with highest priority",
              warning: "Position may remain open until retry succeeds"
            });
          }
          
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close order failed: ${closeError.message}`, 
            processed: true 
          });
          return res.status(500).json({ error: "Close order execution failed", details: closeError.message });
        }
        // === END INNER TRY/CATCH ===
        
        } catch (closeHandlerError: any) {
          // CRITICAL: This outer catch ensures NO exception escapes the close signal handler
          // Any error here MUST return to prevent fallthrough to open-order logic
          console.error(`[Webhook] CRITICAL: Unexpected error in close signal handler - returning to prevent fallthrough:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close handler unexpected error: ${closeHandlerError.message}`, 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed unexpectedly", 
            details: closeHandlerError.message 
          });
        }
        // === END OUTER TRY/CATCH FOR CLOSE SIGNAL HANDLING ===
      }

      // ── PARTIAL CLOSE HANDLER ──────────────────────────────────────────────
      // Handles PARTIAL_CLOSE signals (TV sell 1 while LONG 3, tvSize=2 etc.).
      // Must appear AFTER the full close block and BEFORE the defense-in-depth
      // check so that partial closes are fully handled and returned before any
      // open/flip logic runs.
      if (isPartialClose) {
        console.log(`[Webhook] *** PARTIAL CLOSE HANDLER *** size=${partialCloseSize.toFixed(4)}, fraction=${(partialCloseFraction * 100).toFixed(1)}%`);
        const releaseBotLock = await acquireBotWebhookLock(`${botId}:${bot.market}`);
        const lockTimer = setTimeout(() => releaseBotLock(), 30_000);
        try {
          const pcWallet = await storage.getWallet(bot.walletAddress);
          if (!pcWallet?.agentPublicKey) {
            await storage.updateWebhookLog(log.id, { errorMessage: "No agent wallet for partial close", processed: true });
            return res.status(400).json({ error: "Agent wallet not configured" });
          }

          const pcSubAccountId = webhookBotCtx ? 0 : (bot.driftSubaccountId ?? 0);
          const pcPositionSide = dbPositionForClassification
            ? (parseFloat(dbPositionForClassification.baseSize) > 0 ? 'long' : 'short')
            : 'long';

          console.log(`[Webhook] Partial close: executing closePerpPosition(${partialCloseSize.toFixed(4)} ${pcPositionSide} ${bot.market}, reduceOnly)`);
          const pcResult = await closePerpPosition(
            agentKeyResult.secretKey,
            bot.market,
            pcSubAccountId,
            partialCloseSize,
            pcWallet.slippageBps ?? 50,
            privateKeyBase58,
            pcWallet.agentPublicKey!,
            pcPositionSide,
            webhookBotCtx,
            bot.walletAddress,
            getAdapterForBot(bot),
          );

          if (!pcResult.success) {
            console.error(`[Webhook] Partial close failed: ${pcResult.error}`);
            await storage.updateWebhookLog(log.id, { errorMessage: `Partial close failed: ${pcResult.error}`, processed: true });
            return res.status(500).json({ error: "Partial close failed", details: pcResult.error });
          }

          // Book realized PnL for the closed slice.
          const pcFillPrice = pcResult.fillPrice ?? (signalPrice ? parseFloat(signalPrice) : 0);
          const pcEntryPrice = dbPositionForClassification ? parseFloat(dbPositionForClassification.avgEntryPrice) : 0;
          const pcFee = partialCloseSize * (pcFillPrice || pcEntryPrice) * getExchangeFeeRate();
          const pcPnl = pcPositionSide === 'long'
            ? (pcFillPrice - pcEntryPrice) * partialCloseSize - pcFee
            : (pcEntryPrice - pcFillPrice) * partialCloseSize - pcFee;

          const pcDedupKey = DatabaseStorage.canonicalCloseFillId({
            signature: pcResult.signature ? `tx-${pcResult.signature}` : undefined,
            botId,
            side: pcPositionSide === 'long' ? 'short' : 'long',
            size: partialCloseSize,
            market: bot.market,
            fillPrice: pcFillPrice,
            timestampMs: Date.now(),
          });

          await storage.recordCloseEventAtomic({
            botId,
            insert: {
              tradingBotId: botId,
              walletAddress: bot.walletAddress,
              market: bot.market,
              side: pcPositionSide === 'long' ? 'short' : 'long',
              size: String(partialCloseSize),
              price: String(pcFillPrice),
              fee: String(pcFee),
              pnl: String(pcPnl),
              status: 'executed',
              txSignature: pcResult.signature || null,
              protocolFillId: pcDedupKey,
              webhookPayload: { ...payload, partialClose: true, fraction: partialCloseFraction },
              executionMethod: pcResult.executionMethod || 'legacy',
            },
            deltas: {
              totalPnlDelta: pcPnl,
              totalVolumeDelta: partialCloseSize * pcFillPrice,
              lastTradeAt: new Date().toISOString(),
            },
          });

          // Sync position state from on-chain (reflects the new reduced size).
          syncPositionFromOnChain(botId, bot.walletAddress, bot.market).catch(err =>
            console.error(`[Webhook] Post-partial-close sync error:`, err));

          // Schedule debounced Telegram notification.
          schedulePartialCloseNotification({
            walletAddress: bot.walletAddress,
            botId,
            botName: bot.name,
            market: bot.market,
            side: pcPositionSide === 'long' ? 'LONG' : 'SHORT',
            closedFraction: partialCloseFraction,
            realizedPnl: pcPnl,
            price: pcFillPrice,
          });

          // Fan out to copy-trade subscribers proportionally.
          if (botPublishedInfo?.isActive) {
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || String(pcFillPrice),
              isCloseSignal: false,
              strategyPositionSize,
              partialCloseFraction,
            }).catch(err => console.error(`[Subscriber Routing] Partial close routing error:`, err));
          }

          await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
          return res.json({
            status: "success",
            type: "partial_close",
            fraction: partialCloseFraction,
            closedSize: partialCloseSize,
            pnl: pcPnl,
            signature: pcResult.signature,
          });
        } catch (pcErr: any) {
          console.error(`[Webhook] Partial close handler error:`, pcErr);
          await storage.updateWebhookLog(log.id, { errorMessage: `Partial close error: ${pcErr.message}`, processed: true });
          return res.status(500).json({ error: "Partial close failed", details: pcErr.message });
        } finally {
          clearTimeout(lockTimer);
          releaseBotLock();
        }
      }

      // DEFENSE-IN-DEPTH: Double-check we're not proceeding with a close signal
      // If isCloseSignal was true, all code paths above should have returned
      // This is a safety net to prevent any edge case from opening new positions on close signals
      if (isCloseSignal || isPartialClose) {
        console.error(`[Webhook] CRITICAL: Close/partial signal fell through without returning! This should never happen.`);
        await storage.updateWebhookLog(log.id, { 
          errorMessage: "Close signal fell through to regular execution - blocked for safety", 
          processed: true 
        });
        return res.status(500).json({ 
          error: "Internal error: close signal processing failed",
          details: "Close signal did not complete properly - blocked to prevent unintended position"
        });
      }

      // POSITION FLIP DETECTION: Check if signal direction conflicts with existing position
      // If we're LONG and receive a SHORT signal (or vice versa), we need to:
      // 1. First close the existing position completely
      // 2. Then execute the new order in the opposite direction
      
      // Get wallet for execution (needed for on-chain position check)
      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }
      
      const subAccountId = bot.driftSubaccountId ?? 0;
      const openQueryAccount = webhookBotCtx ? webhookBotCtx.botPublicKey : wallet.agentPublicKey;
      const openQuerySubId = webhookBotCtx ? 0 : subAccountId;
      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          botId,
          openQueryAccount,
          openQuerySubId,
          bot.market,
          webhookBotCtx?.botPublicKey
        );
        console.log(`[Webhook] Position flip check: on-chain position is ${onChainPosition.side} ${Math.abs(onChainPosition.size).toFixed(6)} on ${bot.market}`);
      } catch (posErr) {
        console.warn(`[Webhook] Could not query on-chain position for flip detection:`, posErr);
        onChainPosition = { side: 'FLAT', size: 0 };
      }
      
      // Use on-chain position size for accurate flip detection
      const actualOnChainSize = onChainPosition.side === 'LONG' ? onChainPosition.size : 
                                onChainPosition.side === 'SHORT' ? -onChainPosition.size : 0;
      const isCurrentlyLong = onChainPosition.side === 'LONG';
      const isCurrentlyShort = onChainPosition.side === 'SHORT';
      const signalIsLong = side === 'long';
      const signalIsShort = side === 'short';
      
      console.log(`[Webhook] On-chain position check: ${bot.market} size=${actualOnChainSize.toFixed(6)} (${isCurrentlyLong ? 'LONG' : isCurrentlyShort ? 'SHORT' : 'FLAT'})`);
      
      // Detect position flip: signal direction opposite to current position
      const isPositionFlip = (isCurrentlyLong && signalIsShort) || (isCurrentlyShort && signalIsLong);
      
      if (isPositionFlip && Math.abs(actualOnChainSize) > 0) {
        console.log(`[Webhook] POSITION FLIP detected: On-chain ${isCurrentlyLong ? 'LONG' : 'SHORT'} ${Math.abs(actualOnChainSize).toFixed(6)} contracts, signal wants to go ${side.toUpperCase()}`);
        
        // Step 1: Close existing position first using ACTUAL on-chain size
        const closeSide = isCurrentlyLong ? 'short' : 'long';
        const closeSize = Math.abs(actualOnChainSize); // Use actual on-chain size, not tracked
        
        console.log(`[Webhook] Step 1: Closing existing ${isCurrentlyLong ? 'LONG' : 'SHORT'} position of ${closeSize} contracts`);
        
        // Pending row — canonical `tx-<sig>` is set in the executed
        // update below, matching the cross-path identity scheme.
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: { ...payload, _flipClose: true },
          executionMethod: 'legacy',
        });
        
        try {
          // Use closePerpPosition for exact BN precision (prevents float precision dust)
          const flipSlippageBps = wallet.slippageBps ?? 50;
          console.log(`[Webhook] Using closePerpPosition (exact BN) for position flip close, slippage=${flipSlippageBps}bps`);
          const closeResult = await closePerpPosition(
            agentKeyResult.secretKey,
            bot.market,
            webhookBotCtx ? 0 : subAccountId,
            closeSize,
            flipSlippageBps,
            privateKeyBase58,
            wallet.agentPublicKey!,
            isCurrentlyLong ? 'long' : 'short',
            webhookBotCtx,
            bot.walletAddress,
            getAdapterForBot(bot),
          );
          
          if (!closeResult.success) {
            await storage.updateBotTrade(closeTrade.id, { status: "failed", errorMessage: `Position flip close failed: ${closeResult.error}` });
            await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeResult.error}`, processed: true });
            return res.status(500).json({ error: `Position flip close failed: ${closeResult.error}` });
          }
          
          // closePerpPosition returns signature, not txSignature
          const flipTxSignature = closeResult.signature || null;
          
          // Calculate PnL for the flip close regardless of whether we have a signature
          // This ensures PnL is recorded even if position was closed by another process
          const closeFillPrice = parseFloat(signalPrice || "0");
          const closeNotional = closeSize * closeFillPrice;
          const closeFee = closeNotional * getExchangeFeeRate();
          
          // Calculate trade PnL for position flip close
          const flipEntryPrice = onChainPosition.entryPrice || 0;
          let flipClosePnl = 0;
          if (flipEntryPrice > 0 && closeFillPrice > 0) {
            if (closeSide === 'short') {
              // Closing LONG: profit if exitPrice > entryPrice
              flipClosePnl = (closeFillPrice - flipEntryPrice) * closeSize - closeFee;
            } else {
              // Closing SHORT: profit if entryPrice > exitPrice
              flipClosePnl = (flipEntryPrice - closeFillPrice) * closeSize - closeFee;
            }
            console.log(`[Webhook] Flip close PnL: entry=$${flipEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${flipClosePnl.toFixed(4)}`);
          }

          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is unexpected for flip since we verified position exists, but handle gracefully
          if (closeResult.success && !flipTxSignature) {
            console.warn(`[Webhook] Position flip close: success but no signature - position may have been closed by another process`);
            // Still save the PnL + atomically recompute stats so counters
            // stay correct even when there's no on-chain signature.
            await storage.recordCloseEventAtomic({
              botId,
              update: {
                tradeId: closeTrade.id,
                fields: {
                  status: "executed",
                  txSignature: null,
                  price: String(closeFillPrice),
                  fee: String(closeFee),
                  pnl: String(flipClosePnl),
                  protocolFillId: DatabaseStorage.canonicalCloseFillId({
                    signature: null,
                    botId,
                    side: 'CLOSE',
                    size: closeSize,
                    market: bot.market,
                    fillPrice: closeFillPrice,
                    timestampMs: bot.stats?.lastTradeAt
                      ? new Date(bot.stats.lastTradeAt).getTime()
                      : Date.now(),
                  }),
                  errorMessage: "Position was already closed (no trade executed)",
                },
              },
              deltas: {
                totalPnlDelta: flipClosePnl,
                totalVolumeDelta: closeSize * closeFillPrice,
                lastTradeAt: new Date().toISOString(),
              },
            });
            
            // Defer sync for no-signature case (fire-and-forget)
            (async () => {
              try {
                await syncPositionFromOnChain(botId, bot.walletAddress, wallet.agentPublicKey!, subAccountId, bot.market, closeTrade.id, closeFee, closeFillPrice, closeSide, closeSize, webhookBotCtx?.botPublicKey);
              } catch (err) {
                console.error(`[Webhook] Deferred flip close sync failed (non-blocking): ${err}`);
              }
            })();
            
            // Continue to execute the new position anyway
            console.log(`[Webhook] Proceeding to open ${side.toUpperCase()} position despite no close signature`);
          } else {
            // Update close trade with execution details + atomic recompute.
            await storage.recordCloseEventAtomic({
              botId,
              update: {
                tradeId: closeTrade.id,
                fields: {
                  status: "executed",
                  txSignature: flipTxSignature,
                  price: String(closeFillPrice),
                  fee: String(closeFee),
                  pnl: String(flipClosePnl),
                  protocolFillId: DatabaseStorage.canonicalCloseFillId({
                    signature: flipTxSignature,
                    botId,
                    side: 'CLOSE',
                    size: closeSize,
                    market: bot.market,
                    fillPrice: closeFillPrice,
                    timestampMs: Date.now(),
                  }),
                },
              },
              deltas: {
                totalPnlDelta: flipClosePnl,
                totalVolumeDelta: closeSize * closeFillPrice,
                lastTradeAt: new Date().toISOString(),
              },
            });
          
            console.log(`[Webhook] Position closed successfully. Now proceeding to open ${side.toUpperCase()} position.`);
            
            // SETTLE PNL after flip close to make profits available for the new position
            // This MUST stay blocking - profits need to be available as margin for the new OPEN
            if (bot.profitReinvest && getAdapterForBot(bot).getCapabilities().supportsSettlePnl) {
              try {
                console.log(`[Webhook] Settling PnL for subaccount ${subAccountId} after flip close (profit reinvest enabled)`);
                const settleResult = await settleAllPnl(agentKeyResult.secretKey, subAccountId, getAdapterForBot(bot));
                if (settleResult.success) {
                  console.log(`[Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                } else {
                  console.warn(`[Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                }
              } catch (settleErr: any) {
                console.warn(`[Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
              }
            }
          
            // Defer position sync only — stats already recomputed atomically above.
            (async () => {
              try {
                await syncPositionFromOnChain(botId, bot.walletAddress, wallet.agentPublicKey!, subAccountId, bot.market, closeTrade.id, closeFee, closeFillPrice, closeSide, closeSize, webhookBotCtx?.botPublicKey);
              } catch (err) {
                console.error(`[Webhook] Deferred flip close sync failed (non-blocking): ${err}`);
              }
            })();
          }
          
        } catch (closeError: any) {
          console.error(`[Webhook] Position flip close failed:`, closeError);
          await storage.updateBotTrade(closeTrade.id, { status: "failed", errorMessage: `Position flip close failed: ${closeError.message}` });
          await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeError.message}`, processed: true });
          return res.status(500).json({ error: `Position flip close failed: ${closeError.message}` });
        }
        
        // Step 2: Now fall through to execute the new position in the opposite direction
        console.log(`[Webhook] Step 2: Opening new ${side.toUpperCase()} position`);
      }

      // Regular order execution (not a close signal)
      // Create trade record (pending execution)
      // Use contracts as the trade size (what TradingView sent for this order)
      // Include the signal price and time from TradingView
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
        executionMethod: 'legacy',
      });

      // Store signal time in webhook log for reference
      if (signalTime) {
        console.log(`[Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading
      // Auto-deposit would only make sense for liquidation protection (future feature)

      // Execute trade on Drift Protocol
      // Wallet was already fetched earlier for position check

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market, getAdapterForBot(bot));
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const rawSignalPercent = usdtValue; // Treat USDT value as percentage
      const signalPercent = Math.min(rawSignalPercent, 100); // Cap at 100% to prevent accidental oversized orders
      
      console.log(`[Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → ${rawSignalPercent > 100 ? `capped from ${rawSignalPercent.toFixed(2)}% to ` : ''}${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");

      const sizingResult = await computeTradeSizingAndTopUp({
        agentPublicKey: wallet.agentPublicKey!,
        agentPrivateKeyEncrypted: agentKeyResult.secretKey,
        subAccountId: webhookBotCtx ? 0 : subAccountId,
        botId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        baseCapital,
        leverage: bot.leverage || 1,
        autoTopUp: bot.autoTopUp ?? false,
        profitReinvestEnabled: bot.profitReinvest === true,
        signalPercent,
        oraclePrice,
        logPrefix: "[Webhook]",
        botCtx: webhookBotCtx,
        adapter: getAdapterForBot(bot),
      });

      if (!sizingResult.success) {
        const errorMsg = sizingResult.error || "Trade sizing failed";
        if (sizingResult.shouldPauseBot && sizingResult.pauseReason) {
          await storage.updateTradingBot(bot.id, { isActive: false, pauseReason: sizingResult.pauseReason } as any);
        }
        await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, errorMessage: errorMsg });
        await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
        return res.status(400).json({ error: errorMsg });
      }

      const finalContractSize = sizingResult.finalContractSize;
      const freeCollateral = sizingResult.freeCollateral;
      const maxTradeableValue = sizingResult.maxTradeableValue;
      const tradeAmountUsd = sizingResult.tradeAmountUsd;

      // Execute on Drift using the subAccountId already declared for position check
      const userSlippageBps = wallet.slippageBps ?? 50;
      const openExecStartTime = Date.now();
      console.log(`[Webhook] ⏱️ OPEN EXEC START at +${openExecStartTime - webhookStartTime}ms, ${side} ${finalContractSize} ${bot.market}`);
      const orderResult = await executePerpOrder(
        agentKeyResult.secretKey,
        bot.market,
        side,
        finalContractSize,
        webhookBotCtx ? 0 : subAccountId,
        false,
        userSlippageBps,
        privateKeyBase58,
        wallet.agentPublicKey || undefined,
        undefined,
        webhookBotCtx,
        bot.walletAddress,
        getAdapterForBot(bot),
      );
      const openExecEndTime = Date.now();
      console.log(`[Webhook] ⏱️ OPEN EXEC END at +${openExecEndTime - webhookStartTime}ms (took ${openExecEndTime - openExecStartTime}ms), success=${orderResult.success}`);

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[Webhook] Trade failed: ${orderResult.error}`);
        console.log(`[Webhook] TRADE FAILURE CONTEXT: freeCollateral=$${freeCollateral.toFixed(2)}, maxTradeableValue=$${maxTradeableValue.toFixed(2)}, tradeAmountUsd=$${tradeAmountUsd.toFixed(2)}, finalContractSize=${finalContractSize}, oraclePrice=$${oraclePrice.toFixed(2)}, notional=$${(finalContractSize * oraclePrice).toFixed(2)}`);
        
        // Check if this is a transient error (rate limit, price feed, oracle) or temporary collateral issue - queue for automatic retry
        const errorToCheck = orderResult.error || '';
        const isTransient = isTransientError(errorToCheck);
        const isCollateralError = errorToCheck.includes('InsufficientCollateral') || errorToCheck.includes('6010');
        console.log(`[Webhook] Retry eligibility: isTransient=${isTransient}, isCollateralError=${isCollateralError}, error="${errorToCheck.slice(0, 100)}..."`);
        
        // Also retry on InsufficientCollateral - sometimes it's a temporary condition due to oracle price spikes
        if (isTransient || isCollateralError) {
          console.log(`[Webhook] Retryable error detected (transient=${isTransient}, collateral=${isCollateralError}), queueing trade for automatic retry`);
          
          const retryJobId = await queueTradeRetry({
            botId: bot.id,
            walletAddress: wallet.address,
            agentPublicKey: wallet.agentPublicKey!,
            market: bot.market,
            side: side,
            size: finalContractSize,
            subAccountId,
            reduceOnly: false,
            slippageBps: userSlippageBps,
            privateKeyBase58,
            priority: 'normal',
            lastError: orderResult.error,
            originalTradeId: trade.id,
            webhookPayload: { action, contracts, market: bot.market },
          });
          
          const retryReason = isCollateralError ? 'Temporary margin issue' : 'Rate limited';
          await storage.updateBotTrade(trade.id, {
            status: "pending",
            txSignature: null,
            size: finalContractSize.toFixed(8),
            errorMessage: `${retryReason} - auto-retry queued (job: ${retryJobId})`,
          });
          await storage.updateWebhookLog(log.id, { errorMessage: `${retryReason} - retry queued: ${retryJobId}`, processed: true });
          
          return res.status(202).json({ 
            status: "queued_for_retry",
            retryJobId,
            message: `${retryReason} - automatic retry scheduled`
          });
        }
        
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: finalContractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(wallet.address, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      const fillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee - use actual fee from executor if available
      const tradeNotional = finalContractSize * fillPrice;
      const tradeFee = orderResult.actualFee ?? (tradeNotional * getExchangeFeeRate());
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: fillPrice.toString(),
        fee: tradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: finalContractSize.toFixed(8),
        executionMethod: orderResult.executionMethod || 'legacy',
        swiftOrderId: orderResult.swiftOrderId || null,
      });

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        if (dbError?.code === '23505') {
          console.log(`[Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        signalHash,
      });

      console.log(`[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS (OPEN) ==========`);
      console.log(`[WEBHOOK-TRACE] Calling routeSignalToSubscribers for bot ${botId}`);
      console.log(`[WEBHOOK-TRACE] Signal: action=${action}, contracts=${contracts}, isCloseSignal=false, price=${signalPrice || fillPrice.toString()}`);
      routeSignalToSubscribers(botId, {
        action: action as 'buy' | 'sell',
        contracts,
        positionSize,
        price: signalPrice || fillPrice.toString(),
        isCloseSignal: false,
        strategyPositionSize,
      }).then(() => {
        console.log(`[WEBHOOK-TRACE] OPEN routing completed successfully for bot ${botId}`);
      }).catch(routingErr => {
        console.error(`[WEBHOOK-TRACE] OPEN routing FAILED for bot ${botId}:`, routingErr);
        console.error(`[Subscriber Routing] Deferred routing error for bot ${botId}:`, routingErr);
      });

      // --- Deferred post-trade work (fire-and-forget, non-blocking) ---
      console.log('[Webhook] Response sent, deferring post-trade work...');
      (async () => {
        try {
          const syncResult = await syncPositionFromOnChain(
            botId,
            bot.walletAddress,
            wallet.agentPublicKey!,
            subAccountId,
            bot.market,
            trade.id,
            tradeFee,
            fillPrice,
            side,
            finalContractSize,
            webhookBotCtx?.botPublicKey
          );

          // CRITICAL: Verify trade tx actually succeeded on-chain
          // Check the tx signature confirmation status rather than position state
          // (position state could change if another signal arrives between execution and verification)
          if (syncResult && syncResult.success) {
            try {
              const tradeTxSig = orderResult.txSignature || orderResult.signature;
              if (tradeTxSig) {
                const { Connection } = await import('@solana/web3.js');
                const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
                const conn = new Connection(rpcUrl, 'confirmed');
                const txStatus = await conn.getSignatureStatus(tradeTxSig);
                const confirmationStatus = txStatus?.value?.confirmationStatus;
                const txErr = txStatus?.value?.err;
                
                if (txErr) {
                  console.error(`[Webhook] ON-CHAIN TX FAILED: Trade ${trade.id} tx ${tradeTxSig.slice(0,12)}... had error: ${JSON.stringify(txErr)}`);
                  console.error(`[Webhook] Correcting trade status to 'failed'`);
                  await storage.updateBotTrade(trade.id, {
                    status: 'failed',
                    errorMessage: `On-chain verification: Transaction failed (${JSON.stringify(txErr)}). Likely insufficient collateral.`,
                  });
                } else if (!confirmationStatus) {
                  console.warn(`[Webhook] Trade ${trade.id} tx ${tradeTxSig.slice(0,12)}... not found on-chain (may have expired)`);
                  await storage.updateBotTrade(trade.id, {
                    status: 'failed',
                    errorMessage: 'On-chain verification: Transaction not found. May have expired or failed to land.',
                  });
                } else {
                  console.log(`[Webhook] Trade ${trade.id} tx confirmed on-chain: ${confirmationStatus}`);
                }
              }
            } catch (verifyErr: any) {
              console.warn(`[Webhook] Post-trade tx verification failed (non-blocking): ${verifyErr.message}`);
            }
          }

          await storage.recomputeAndMergeBotStats(botId, {
            totalPnlDelta: syncResult.tradePnl ?? 0,
            totalVolumeDelta: tradeNotional,
            lastTradeAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`[Webhook] Deferred post-trade sync/stats failed (non-blocking): ${err}`);
        }

        sendTradeNotification(wallet.address, {
          type: 'trade_executed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          size: tradeNotional,
          price: fillPrice,
        }).catch(err => console.error('[Notifications] Failed:', err));
      })();
      } finally {
        // PHASE 6.2: Ensure agent key is cleaned up after execution
        cleanupAgentKey();
      }
    } catch (error) {
      console.error("Webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // User-level webhook endpoint - single URL for all bots, routes based on botId in payload
  app.post("/api/webhook/user/:walletAddress", async (req, res) => {
    const { walletAddress } = req.params;
    const { secret } = req.query;
    const payload = req.body;

    // Extract botId early for signal hash generation
    const botId = payload?.botId;
    
    // Generate signal hash for deduplication (only if botId exists)
    const signalHash = botId ? generateSignalHash(botId, payload) : null;

    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId || null,
        payload: payload,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[User Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[User Webhook] Bot no longer exists: ${botId}`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted" });
      }
      throw dbError;
    }

    try {
      // Get wallet
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Wallet not found" });
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Validate secret
      if (secret !== wallet.userWebhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Verify botId exists
      if (!botId) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Missing botId in payload" });
        return res.status(400).json({ error: "Missing botId in payload" });
      }

      // Get bot and verify ownership
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }

      if (bot.walletAddress !== walletAddress) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot does not belong to this wallet" });
        return res.status(403).json({ error: "Bot does not belong to this wallet" });
      }

      const userWebhookBotCtx = getBotSubaccountContext(bot);

      // Security v3: Check execution authorization
      if (wallet.emergencyStopTriggered) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Emergency stop active" });
        return res.status(403).json({ error: "Trade execution blocked: Emergency stop is active for this wallet" });
      }
      
      if (!wallet.executionEnabled) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization required" });
        return res.status(403).json({ error: "Trade execution disabled. Please enable automated trading in the app." });
      }
      
      if (wallet.executionExpiresAt && new Date() > wallet.executionExpiresAt) {
        // Clear expired execution authorization
        await storage.updateWalletExecution(walletAddress, {
          executionEnabled: false,
          umkEncryptedForExecution: null,
          executionExpiresAt: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization expired" });
        return res.status(403).json({ error: "Trade execution authorization expired. Please re-enable automated trading." });
      }

      // Security v3: Verify execution key can be unwrapped (validates SERVER_EXECUTION_KEY is correct)
      const umkResult = await getUmkForWebhook(walletAddress);
      if (!umkResult) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Invalid execution authorization" });
        return res.status(403).json({ error: "Invalid execution authorization. Please re-enable automated trading." });
      }
      
      // Security v3: Verify bot policy HMAC if one exists (detects tampering with critical settings)
      if (bot.policyHmac) {
        const policyValid = verifyBotPolicyHmac(
          umkResult.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize },
          bot.policyHmac
        );
        if (!policyValid) {
          umkResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Bot policy tampered" });
          return res.status(403).json({ error: "Bot configuration has been tampered with. Please reconfigure the bot." });
        }
      }
      
      // Security v3 (Phase 3 strict): V3-only — fail explicitly if user has not migrated to v3.
      const agentKeyResult = await decryptAgentKeyStrict(
        walletAddress,
        umkResult.umk,
        wallet,
        wallet.agentPublicKey
      );
      
      // Cleanup the unwrapped UMK immediately after deriving agent key
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        // Agent key decryption failed - this is a critical error
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Agent key decryption failed" });
        return res.status(403).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet." });
      }
      
      // Log migration status for tracking
      const usedV3 = wallet.agentPrivateKeyEncryptedV3 ? true : false;
      if (usedV3) {
        console.log(`[User Webhook] Agent key decryption: v3 path used for ${walletAddress.slice(0, 8)}...`);
      } else {
        console.log(`[User Webhook] Agent key decryption: legacy fallback used for ${walletAddress.slice(0, 8)}... (v3 not yet migrated)`);
      }
      
      // Convert secretKey (Uint8Array) to base58 for passing to executor
      const privateKeyBase58 = bs58.encode(agentKeyResult.secretKey);
      
      // CRITICAL: Verify decrypted key matches stored public key before proceeding
      // This catches key corruption, wrong UMK, or v3/legacy mismatch issues
      try {
        const { Keypair } = await import("@solana/web3.js");
        const derivedKeypair = Keypair.fromSecretKey(agentKeyResult.secretKey);
        const derivedPubkey = derivedKeypair.publicKey.toBase58();
        
        if (derivedPubkey !== wallet.agentPublicKey) {
          console.error(`[User Webhook] CRITICAL: Agent key mismatch!`);
          console.error(`  Derived pubkey: ${derivedPubkey}`);
          console.error(`  Expected pubkey: ${wallet.agentPublicKey}`);
          console.error(`  Wallet has v3 key: ${!!wallet.agentPrivateKeyEncryptedV3}`);
          console.error(`  Wallet has legacy key (v3 field): ${!!wallet.agentPrivateKeyEncryptedV3}`);
          agentKeyResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Agent key mismatch - security error" });
          return res.status(500).json({ error: "Agent key verification failed. Please reconfigure your agent wallet in Settings." });
        }
        console.log(`[User Webhook] Agent key verified: ${derivedPubkey.slice(0, 8)}... matches stored pubkey`);
      } catch (verifyErr: any) {
        console.error(`[User Webhook] Agent key verification failed: ${verifyErr.message}`);
        agentKeyResult.cleanup();
        await storage.updateWebhookLog(log.id, { errorMessage: `Agent key verification failed: ${verifyErr.message}` });
        return res.status(500).json({ error: "Agent key verification failed. Please reconfigure your agent wallet." });
      }
      
      // Helper to cleanup agent key after use
      const cleanupAgentKey = () => {
        agentKeyResult.cleanup();
      };

      // PHASE 6.2: Wrap execution in try/finally to ensure agent key cleanup
      try {

      // Parse TradingView strategy signal FIRST (needed for routing even if bot is paused)
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let strategyPositionSize: string | null = null; // Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      if (typeof payload === 'object' && payload !== null) {
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[User Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[User Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        console.log(`[User Webhook] Parsed JSON signal: botId=${botId}, action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}`);
      } else {
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
        } else {
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size) positionSize = String(parsed.position_size);
          } catch {
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
      }

      // Map action to side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check bot side restrictions
      if (side && bot.side !== 'both') {
        if (bot.side === 'long' && side !== 'long') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts long signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts long signals" });
        }
        if (bot.side === 'short' && side !== 'short') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts short signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts short signals" });
        }
      }

      if (!side) {
        await storage.updateWebhookLog(log.id, { errorMessage: "No valid action found (expected buy or sell)", processed: true });
        return res.status(400).json({ error: "No valid action found", received: payload });
      }

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
      
      console.log(`[User Webhook] Signal analysis: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}, isCloseSignal=${isCloseSignal}`);

      // Check if bot is active - route to subscribers even if paused
      if (!bot.isActive) {
        const routingSignal = parseSignalForRouting(payload);
        const botPublishedInfo = await storage.getPublishedBotByTradingBotId(botId);
        if (botPublishedInfo && botPublishedInfo.isActive && routingSignal.action) {
          console.log(`[User Webhook] Source bot ${botId.slice(0, 8)}... is paused but published - routing ${routingSignal.action} (close=${routingSignal.isCloseSignal}) to subscribers`);
          routeSignalToSubscribers(botId, {
            action: routingSignal.action as 'buy' | 'sell',
            contracts: routingSignal.contracts,
            positionSize,
            price: routingSignal.price,
            isCloseSignal: routingSignal.isCloseSignal,
            strategyPositionSize: routingSignal.strategyPositionSize,
          }).catch(err => console.error(`[User Webhook] Error routing signal from paused bot:`, err));
        }
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused", processed: true });
        return res.status(400).json({ error: "Bot is paused" });
      }

      // CLOSE SIGNAL HANDLING - mirrors logic from /api/webhook/tradingview/:botId
      if (isCloseSignal) {
        console.log(`[User Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler`);
        
        try {
          // Get wallet for execution
          const wallet = await storage.getWallet(walletAddress);
          if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
            await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
            return res.status(400).json({ error: "Agent wallet not configured" });
          }
          
          const subAccountId = bot.driftSubaccountId ?? 0;
          const uwCloseQueryAccount = userWebhookBotCtx ? userWebhookBotCtx.botPublicKey : wallet.agentPublicKey;
          const uwCloseQuerySubId = userWebhookBotCtx ? 0 : subAccountId;
          console.log(`[User Webhook] Close signal: querying on-chain position for bot=${bot.name}, market=${bot.market}, subaccount=${uwCloseQuerySubId}, pacifica=${!!userWebhookBotCtx}`);
          
          let onChainPosition;
          try {
            onChainPosition = await PositionService.getPositionForExecution(
              botId,
              uwCloseQueryAccount,
              uwCloseQuerySubId,
              bot.market,
              userWebhookBotCtx?.botPublicKey
            );
            console.log(`[User Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
          } catch (onChainErr) {
            console.error(`[User Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Failed to query on-chain position - cannot safely close", 
              processed: true 
            });
            return res.status(500).json({ error: "Failed to query on-chain position" });
          }
          
          if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
            console.log(`[User Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Close signal ignored - no on-chain position", 
              processed: true 
            });

            // Route close signal to subscribers even if source bot is flat
            const botPublishedInfo = await storage.getPublishedBotByTradingBotId(botId);
            if (botPublishedInfo && botPublishedInfo.isActive) {
              console.log(`[User Webhook] Source bot flat but published - routing close signal to subscribers`);
              routeSignalToSubscribers(botId, {
                action: action as 'buy' | 'sell',
                contracts,
                positionSize,
                price: signalPrice || '0',
                isCloseSignal: true,
                strategyPositionSize,
              }).catch(err => console.error(`[User Webhook] Error routing close from flat source:`, err));
            }

            return res.status(200).json({ 
              status: "skipped", 
              reason: "No on-chain position to close - this may be a stale SL/TP signal" 
            });
          }
          
          // Execute close using closePerpPosition
          const currentPositionSize = onChainPosition.size;
          console.log(`[User Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
          
          const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
          const closeSize = Math.abs(currentPositionSize);
          
          // Pending row — canonical `tx-<sig>` set atomically in the
          // executed update below for cross-path dedup.
          const closeTrade = await storage.createBotTrade({
            tradingBotId: botId,
            walletAddress: bot.walletAddress,
            market: bot.market,
            side: "CLOSE",
            size: String(closeSize),
            price: signalPrice,
            status: "pending",
            webhookPayload: payload,
            executionMethod: 'legacy',
          });
          
          // Execute close
          const userCloseSlippageBps = wallet.slippageBps ?? 50;
          const uwCloseSubId = userWebhookBotCtx ? 0 : subAccountId;
          const result = await closePerpPosition(
            agentKeyResult.secretKey,
            bot.market,
            uwCloseSubId,
            closeSize,
            userCloseSlippageBps,
            privateKeyBase58,
            wallet.agentPublicKey || undefined,
            onChainPosition.side === 'LONG' ? 'long' : 'short',
            userWebhookBotCtx,
            walletAddress,
            getAdapterForBot(bot),
          );
          
          if (result.success && !result.signature) {
            console.log(`[User Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });

            // Route close signal to subscribers even when source position was already closed
            const botPubInfo = await storage.getPublishedBotByTradingBotId(botId);
            if (botPubInfo && botPubInfo.isActive) {
              console.log(`[User Webhook] Source position already flat but published - routing close to subscribers`);
              routeSignalToSubscribers(botId, {
                action: action as 'buy' | 'sell',
                contracts,
                positionSize,
                price: signalPrice || '0',
                isCloseSignal: true,
                strategyPositionSize,
              }).catch(err => console.error(`[User Webhook] Error routing close from already-closed source:`, err));
            }

            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && result.signature) {
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * getExchangeFeeRate();
            
            // Calculate PnL
            const closeEntryPrice = onChainPosition.entryPrice || 0;
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[User Webhook] Close PnL: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, pnl=$${closeTradePnl.toFixed(4)}`);
            }
            
            // Atomic close-event update + stats recompute in a single tx.
            await storage.recordCloseEventAtomic({
              botId,
              update: {
                tradeId: closeTrade.id,
                fields: {
                  status: "executed",
                  txSignature: result.signature,
                  price: closeFillPrice.toString(),
                  fee: closeFee.toString(),
                  pnl: closeTradePnl.toString(),
                  protocolFillId: DatabaseStorage.canonicalCloseFillId({
                    signature: result.signature,
                    botId,
                    side: 'CLOSE',
                    size: closeSize,
                    market: bot.market,
                    fillPrice: closeFillPrice,
                    timestampMs: Date.now(),
                  }),
                },
              },
              deltas: {
                totalPnlDelta: closeTradePnl,
                totalVolumeDelta: closeNotional,
                lastTradeAt: new Date().toISOString(),
              },
            });
            
            // Sync position from on-chain (this will clear the position since we just closed it)
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize,
              userWebhookBotCtx?.botPublicKey
            );
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            // SUBSCRIBER ROUTING: Route close signal to subscriber bots
            console.log(`[User Webhook] ========== ROUTING SUBSCRIBER BOTS (CLOSE) ==========`);
            console.log(`[User Webhook] Calling routeSignalToSubscribers for bot ${botId}`);
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || closeFillPrice.toString(),
              isCloseSignal: true,
              strategyPositionSize,
            }).then(() => {
              console.log(`[User Webhook] CLOSE routing completed successfully for bot ${botId}`);
            }).catch(routingErr => {
              console.error(`[User Webhook] CLOSE routing FAILED for bot ${botId}:`, routingErr);
            });

            // Send position closed notification
            sendTradeNotification(walletAddress, {
              type: 'position_closed',
              botName: bot.name,
              market: bot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            
            // PROFIT SHARE: If this is a subscriber bot with profitable close, distribute to creator
            // This must happen BEFORE auto-withdraw to ensure creator gets their share
            if (closeTradePnl > 0) {
              const tradeId = `${botId}-${Date.now()}`;
              distributeCreatorProfitShare({
                subscriberBotId: botId,
                subscriberWalletAddress: walletAddress,
                subscriberAgentPublicKey: wallet.agentPublicKey,
                subscriberEncryptedPrivateKey: agentKeyResult.secretKey,
                driftSubaccountId: subAccountId,
                realizedPnl: closeTradePnl,
                tradeId,
              }).then(result => {
                if (result.success && result.amount) {
                  console.log(`[User Webhook] Profit share distributed: $${result.amount.toFixed(4)}`);
                } else if (!result.success && result.error) {
                  console.error(`[User Webhook] Profit share failed: ${result.error}`);
                }
              }).catch(err => console.error('[User Webhook] Profit share error:', err));
            }
            
            // SETTLE PNL: Convert realized PnL to usable USDC balance for profit reinvest
            if (bot.profitReinvest && getAdapterForBot(bot).getCapabilities().supportsSettlePnl) {
              try {
                console.log(`[User Webhook] Settling PnL for subaccount ${subAccountId} (profit reinvest enabled)`);
                const settleResult = await settleAllPnl(agentKeyResult.secretKey, subAccountId, getAdapterForBot(bot));
                if (settleResult.success) {
                  console.log(`[User Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                } else {
                  console.warn(`[User Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                }
              } catch (settleErr: any) {
                console.warn(`[User Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
              }
            }
            
            // AUTO-WITHDRAW: Check if equity exceeds threshold and withdraw excess profits.
            // Pacifica bots require a two-step flow: bot-subaccount → main account (transfer),
            // then main account → agent wallet (withdraw). Minimum is $10 per leg.
            // Legacy/Drift bots use a single-step withdraw with a $0.10 minimum.
            let autoWithdrawInfo = null;
            const autoWithdrawThreshold = parseFloat(bot.autoWithdrawThreshold || "0");
            if (autoWithdrawThreshold > 0) {
              try {
                const botCtx = getBotSubaccountContext(bot);
                const accountInfo = botCtx
                  ? await getExchangeAccountInfoForBot(wallet.agentPublicKey!, subAccountId, botCtx, getAdapterForBot(bot))
                  : await getExchangeAccountInfo(wallet.agentPublicKey, subAccountId, getAdapterForBot(bot));
                const currentEquity = accountInfo.totalCollateral;

                if (currentEquity > autoWithdrawThreshold) {
                  const excessAmount = currentEquity - autoWithdrawThreshold;
                  const withdrawAmount = Math.floor(Math.max(0, excessAmount - 0.01) * 100) / 100;
                  const minAutoWithdraw = getAdapterForBot(bot).minTransferAmount;

                  if (withdrawAmount >= minAutoWithdraw) {
                    console.log(`[User Webhook] AUTO-WITHDRAW: Equity $${currentEquity.toFixed(2)} exceeds threshold $${autoWithdrawThreshold.toFixed(2)}, withdrawing $${withdrawAmount.toFixed(2)}`);

                    const userWhAwBotCtx = botCtx && bot.protocolSubaccountId ? botCtx : null;
                    if (userWhAwBotCtx && bot.protocolSubaccountId) {
                      const adapter = getAdapterForBot(bot);
                      const decryptedUwh = await _resolveBotSubaccountSecretKey(userWhAwBotCtx);
                      try {
                        console.log(`[User Webhook] AUTO-WITHDRAW Step 1: Transfer $${withdrawAmount.toFixed(2)} from bot subaccount ${bot.protocolSubaccountId} → main account`);
                        const transferResult = await adapter.transferBetweenSubaccounts({
                          agentSecretKey: decryptedUwh.secretKey,
                          mainWalletAddress: wallet.agentPublicKey!,
                          fromSubaccountId: bot.protocolSubaccountId,
                          toSubaccountId: wallet.agentPublicKey!,
                          amount: withdrawAmount,
                        });

                        if (!transferResult.success) {
                          console.error(`[User Webhook] AUTO-WITHDRAW transfer failed: ${transferResult.error}`);
                        } else {
                          console.log(`[User Webhook] AUTO-WITHDRAW Step 2: Withdraw $${withdrawAmount.toFixed(2)} from main account → agent wallet`);
                          const withdrawResult = await executeAgentDriftWithdraw(
                            wallet.agentPublicKey!,
                            agentKeyResult.secretKey,
                            withdrawAmount,
                            0,
                            { tradingBotId: botId, context: 'User Webhook AUTO-WITHDRAW' },
                            getAdapterForBot(bot)
                          );

                          if (withdrawResult.success) {
                            console.log(`[User Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn, tx: ${withdrawResult.signature}`);
                            autoWithdrawInfo = { amount: withdrawAmount, txSignature: withdrawResult.signature };
                            await storage.createEquityEvent({
                              walletAddress: bot.walletAddress,
                              tradingBotId: botId,
                              eventType: 'auto_withdraw',
                              amount: String(withdrawAmount),
                              txSignature: withdrawResult.signature || null,
                              notes: `Auto-withdraw: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)} (bot→main→wallet)`,
                            });
                          } else {
                            console.error(`[User Webhook] AUTO-WITHDRAW on-chain withdraw failed: ${withdrawResult.error} (funds are in main account, use Recover button)`);
                          }
                        }
                      } finally {
                        decryptedUwh.cleanup();
                      }
                    } else {
                      const withdrawResult = await executeAgentDriftWithdraw(
                        wallet.agentPublicKey,
                        agentKeyResult.secretKey,
                        withdrawAmount,
                        subAccountId,
                        { tradingBotId: botId, context: 'User Webhook AUTO-WITHDRAW' },
                        getAdapterForBot(bot)
                      );

                      if (withdrawResult.success) {
                        console.log(`[User Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn, tx: ${withdrawResult.signature}`);
                        autoWithdrawInfo = { amount: withdrawAmount, txSignature: withdrawResult.signature };
                        await storage.createEquityEvent({
                          walletAddress: bot.walletAddress,
                          tradingBotId: botId,
                          eventType: 'auto_withdraw',
                          amount: String(withdrawAmount),
                          txSignature: withdrawResult.signature || null,
                          notes: `Auto-withdraw triggered: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)}`,
                        });
                      } else {
                        console.error(`[User Webhook] AUTO-WITHDRAW FAILED: ${withdrawResult.error}`);
                      }
                    }
                  } else if (excessAmount > 0) {
                    console.log(`[User Webhook] AUTO-WITHDRAW skipped: candidate $${withdrawAmount.toFixed(4)} below minimum $${minAutoWithdraw} (equity $${currentEquity.toFixed(2)} vs threshold $${autoWithdrawThreshold.toFixed(2)}); funds will accumulate`);
                  }
                }
              } catch (autoWithdrawErr: any) {
                console.error(`[User Webhook] AUTO-WITHDRAW check error (non-blocking):`, autoWithdrawErr.message);
              }
            }
            
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: result.signature,
              closedSize: closeSize,
              pnl: closeTradePnl,
              ...(autoWithdrawInfo && { autoWithdraw: autoWithdrawInfo }),
            });
          }
          
          // Close failed
          console.error(`[User Webhook] Close order failed:`, result.error);
          
          // Check if this is a transient error (rate limit, timeout, price feed) - queue for CRITICAL automatic retry
          if (isTransientError(result.error || '')) {
            console.log(`[User Webhook] CRITICAL: Transient error on close order, queueing for priority retry`);
            
            const retryJobId = await queueTradeRetry({
              botId: bot.id,
              walletAddress: wallet.address,
              agentPublicKey: wallet.agentPublicKey!,
              market: bot.market,
              side: 'close',
              size: closeSize,
              subAccountId,
              reduceOnly: true,
              slippageBps: userCloseSlippageBps,
              priority: 'critical',
              lastError: result.error,
              originalTradeId: closeTrade.id,
              entryPrice: onChainPosition.entryPrice || 0,
            });
            
            await storage.updateBotTrade(closeTrade.id, {
              status: "pending",
              txSignature: null,
              errorMessage: `Rate limited - CRITICAL auto-retry queued (job: ${retryJobId})`,
            });
            await storage.updateWebhookLog(log.id, { 
              errorMessage: `Rate limited on close - CRITICAL retry queued: ${retryJobId}`, 
              processed: true 
            });
            
            return res.status(202).json({ 
              status: "queued_for_retry",
              retryJobId,
              type: "close",
              message: "CRITICAL: Close order rate limited - auto-retry scheduled with highest priority",
              warning: "Position may remain open until retry succeeds"
            });
          }
          
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
            errorMessage: result.error || "Close order failed",
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: result.error || "Close order failed", 
            processed: true 
          });
          return res.status(500).json({ error: result.error || "Close order failed" });
          
        } catch (closeHandlerError: any) {
          console.error(`[User Webhook] Close handler error:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: closeHandlerError.message || "Close signal processing failed", 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed", 
            details: closeHandlerError.message 
          });
        }
      }

      // Create trade record
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
        executionMethod: 'legacy',
      });

      if (signalTime) {
        console.log(`[User Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading

      // Execute trade on Drift Protocol
      // Get wallet's agent private key for signing
      const userWallet = await storage.getWallet(walletAddress);
      if (!userWallet?.agentPrivateKeyEncryptedV3) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market, getAdapterForBot(bot));
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const rawSignalPercent = usdtValue; // Treat USDT value as percentage
      const signalPercent = Math.min(rawSignalPercent, 100); // Cap at 100% to prevent accidental oversized orders
      
      console.log(`[User Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → ${rawSignalPercent > 100 ? `capped from ${rawSignalPercent.toFixed(2)}% to ` : ''}${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[User Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      const subAccountId = bot.driftSubaccountId ?? 0;

      // Use shared trade sizing helper
      const uwOpenSubAccountId = userWebhookBotCtx ? 0 : subAccountId;
      const sizingResult = await computeTradeSizingAndTopUp({
        agentPublicKey: userWallet.agentPublicKey!,
        agentPrivateKeyEncrypted: agentKeyResult.secretKey,
        subAccountId: uwOpenSubAccountId,
        botId: bot.id,
        walletAddress: userWallet.address,
        market: bot.market,
        baseCapital,
        leverage: bot.leverage || 1,
        autoTopUp: bot.autoTopUp ?? false,
        profitReinvestEnabled: bot.profitReinvest === true,
        signalPercent,
        oraclePrice,
        logPrefix: "[User Webhook]",
        botCtx: userWebhookBotCtx,
        adapter: getAdapterForBot(bot),
      });

      if (!sizingResult.success) {
        const errorMsg = sizingResult.error || "Trade sizing failed";
        if (sizingResult.shouldPauseBot && sizingResult.pauseReason) {
          await storage.updateTradingBot(bot.id, { isActive: false, pauseReason: sizingResult.pauseReason } as any);
        }
        await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, errorMessage: errorMsg });
        await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
        return res.status(400).json({ error: errorMsg });
      }

      const contractSize = sizingResult.finalContractSize;

      // Execute on Drift (subAccountId already declared above for collateral check)
      const userSlippageBps2 = userWallet.slippageBps ?? 50;
      const orderResult = await executePerpOrder(
        agentKeyResult.secretKey,
        bot.market,
        side,
        contractSize,
        userWebhookBotCtx ? 0 : subAccountId,
        false,
        userSlippageBps2,
        privateKeyBase58,
        userWallet.agentPublicKey || undefined,
        undefined,
        userWebhookBotCtx,
        walletAddress,
        getAdapterForBot(bot),
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[User Webhook] Trade failed: ${orderResult.error}`);
        
        // Check if this is a transient error (rate limit, timeout, price feed) - queue for automatic retry
        const errorToCheck = orderResult.error || '';
        const isTransient = isTransientError(errorToCheck);
        const isCollateralError = errorToCheck.includes('InsufficientCollateral') || errorToCheck.includes('6010');
        console.log(`[User Webhook] Retry eligibility: isTransient=${isTransient}, isCollateralError=${isCollateralError}, error="${errorToCheck.slice(0, 100)}..."`);
        
        if (isTransient || isCollateralError) {
          console.log(`[User Webhook] Retryable error detected, queueing trade for automatic retry`);
          
          const retryJobId = await queueTradeRetry({
            botId: bot.id,
            walletAddress: userWallet.address,
            agentPublicKey: userWallet.agentPublicKey!,
            market: bot.market,
            side: side,
            size: contractSize,
            subAccountId,
            reduceOnly: false,
            slippageBps: userSlippageBps2,
            privateKeyBase58,
            priority: 'normal',
            lastError: orderResult.error,
            originalTradeId: trade.id,
            webhookPayload: { action, contracts, market: bot.market },
          });
          
          const retryReason = isCollateralError ? 'Temporary margin issue' : 'Rate limited';
          await storage.updateBotTrade(trade.id, {
            status: "pending",
            txSignature: null,
            size: contractSize.toFixed(8),
            errorMessage: `${retryReason} - auto-retry queued (job: ${retryJobId})`,
          });
          await storage.updateWebhookLog(log.id, { errorMessage: `${retryReason} - retry queued: ${retryJobId}`, processed: true });
          
          return res.status(202).json({ 
            status: "queued_for_retry",
            retryJobId,
            message: `${retryReason} - automatic retry scheduled`
          });
        }
        
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      let userFillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee (0.05% taker fee on notional value)
      const userTradeNotional = contractSize * userFillPrice;
      const userTradeFee = userTradeNotional * getExchangeFeeRate();
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: userFillPrice.toString(),
        fee: userTradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Sync position from on-chain (replaces client-side math with actual Drift state)
      const syncResult = await syncPositionFromOnChain(
        botId,
        bot.walletAddress,
        userWallet.agentPublicKey!,
        subAccountId,
        bot.market,
        trade.id,
        userTradeFee,
        userFillPrice,
        side,
        contractSize,
        userWebhookBotCtx?.botPublicKey
      );

      if (syncResult?.onChainEntryPrice && syncResult.onChainEntryPrice > 0 && Math.abs(syncResult.onChainEntryPrice - userFillPrice) > 0.001) {
        console.log(`[Webhook] Updating fill price: oracle=$${userFillPrice.toFixed(6)} -> on-chain=$${syncResult.onChainEntryPrice.toFixed(6)}`);
        userFillPrice = syncResult.onChainEntryPrice;
        const tradeUpdate: Record<string, string> = {
          price: userFillPrice.toFixed(6),
        };
        if (!orderResult.actualFee) {
          const updatedNotional = contractSize * userFillPrice;
          tradeUpdate.fee = (updatedNotional * getExchangeFeeRate()).toFixed(6);
        }
        await storage.updateBotTrade(trade.id, tradeUpdate);
      }

      // Update bot stats (totals shown in dashboard / leaderboard).
      await storage.recomputeAndMergeBotStats(botId, {
        totalPnlDelta: syncResult.tradePnl ?? 0,
        totalVolumeDelta: userTradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      // Send trade notification (async, don't block response)
      sendTradeNotification(walletAddress, {
        type: 'trade_executed',
        botName: bot.name,
        market: bot.market,
        side: side === 'long' ? 'LONG' : 'SHORT',
        size: userTradeNotional,
        price: userFillPrice,
      }).catch(err => console.error('[Notifications] Failed to send trade_executed notification:', err));

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        // Unique constraint violation means another request already executed this signal
        if (dbError?.code === '23505') {
          console.log(`[User Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        botId: botId,
        txSignature: orderResult.txSignature || orderResult.signature,
        signalHash,
      });

      // SUBSCRIBER ROUTING: Route open signal to subscriber bots
      console.log(`[User Webhook] ========== ROUTING SUBSCRIBER BOTS (OPEN) ==========`);
      console.log(`[User Webhook] Calling routeSignalToSubscribers for bot ${botId}`);
      routeSignalToSubscribers(botId, {
        action: action as 'buy' | 'sell',
        contracts,
        positionSize,
        price: signalPrice || userFillPrice.toString(),
        isCloseSignal: false,
        strategyPositionSize,
      }).then(() => {
        console.log(`[User Webhook] OPEN routing completed successfully for bot ${botId}`);
      }).catch(routingErr => {
        console.error(`[User Webhook] OPEN routing FAILED for bot ${botId}:`, routingErr);
      });
      } finally {
        // PHASE 6.2: Ensure agent key is cleaned up after execution
        cleanupAgentKey();
      }
    } catch (error) {
      console.error("User webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Get user webhook URL
  app.get("/api/user/webhook-url", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Use production domain for webhooks, falling back to Replit domains for dev
      const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? 'https://myquantumvault.com'
        : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      // Generate secret if not exists
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(req.walletAddress!, userWebhookSecret);
        const updatedWallet = await storage.getWallet(req.walletAddress!);
        if (!updatedWallet?.userWebhookSecret) {
          return res.status(500).json({ error: "Failed to generate webhook secret" });
        }
        
        return res.json({
          webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${updatedWallet.userWebhookSecret}`,
        });
      }

      res.json({
        webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${wallet.userWebhookSecret}`,
      });
    } catch (error) {
      console.error("Get user webhook URL error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Legacy auth routes (kept for compatibility)
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = insertUserSchema.parse(req.body);
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already taken" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await storage.createUser({ username, password: passwordHash });
      await storage.upsertPortfolio({
        userId: user.id,
        totalValue: "10000",
        unrealizedPnl: "0",
        realizedPnl: "0",
        solBalance: "0",
        usdcBalance: "10000",
      });
      await storage.upsertLeaderboardStats({
        userId: user.id,
        totalVolume: "0",
        totalPnl: "0",
        winRate: "0",
        totalTrades: 0,
      });
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("Registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot marketplace routes
  app.get("/api/bots", async (req, res) => {
    try {
      const featured = req.query.featured === "true";
      const bots = featured ? await storage.getFeaturedBots() : await storage.getAllBots();
      res.json(bots);
    } catch (error) {
      console.error("Get bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:id", async (req, res) => {
    try {
      const bot = await storage.getBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const { botId } = req.body;
      const userId = req.session.userId!;
      const existingSubs = await storage.getUserSubscriptions(userId);
      if (existingSubs.some((sub) => sub.botId === botId && sub.status === "active")) {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }
      const subscription = await storage.createSubscription({ userId, botId, status: "active" });
      await storage.incrementBotSubscribers(botId, 1);
      res.json(subscription);
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const subscriptions = await storage.getUserSubscriptions(req.session.userId!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/subscriptions/:id", requireAuth, async (req, res) => {
    try {
      const { status } = req.body;
      await storage.updateSubscriptionStatus(req.params.id, status);
      res.json({ success: true });
    } catch (error) {
      console.error("Update subscription error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/portfolio", requireAuth, async (req, res) => {
    try {
      const portfolio = await storage.getPortfolio(req.session.userId!);
      res.json(portfolio);
    } catch (error) {
      console.error("Get portfolio error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/positions", requireAuth, async (req, res) => {
    try {
      const positions = await storage.getUserPositions(req.session.userId!);
      res.json(positions);
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trades", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getUserTrades(req.session.userId!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/leaderboard", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const leaderboard = await storage.getWalletLeaderboard(limit);
      res.json(leaderboard);
    } catch (error) {
      console.error("Get leaderboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Batched sparkline data for leaderboard rows. Returns one compact P&L %
  // series per requested wallet over the chosen window. One DB query for all
  // wallets, not N — keeps the leaderboard fast as it grows.
  app.get("/api/leaderboard/sparklines", async (req, res) => {
    try {
      const rawWallets = (req.query.wallets as string | undefined) ?? "";
      const wallets = rawWallets
        .split(",")
        .map(w => w.trim())
        .filter(w => w.length > 0)
        .slice(0, 200);
      if (wallets.length === 0) {
        res.json({ range: "all", sparklines: {} });
        return;
      }
      // Range covers the wallet's full snapshot history by default — a short
      // recent slump shouldn't dominate the sparkline when the producer has
      // months of strong prior performance. "all" omits the time filter
      // entirely; explicit windows are still supported for callers that want
      // a tighter view.
      const validRanges = ["7d", "30d", "90d", "all"] as const;
      type RangeParam = typeof validRanges[number];
      const rawRange = (req.query.range as string | undefined)?.toLowerCase();
      const range: RangeParam = (validRanges as readonly string[]).includes(rawRange ?? "")
        ? (rawRange as RangeParam)
        : "all";
      let since: Date | undefined;
      if (range !== "all") {
        const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
        since = new Date();
        since.setDate(since.getDate() - days);
      }

      const grouped = await storage.getPortfolioDailySnapshotsBatch(wallets, since);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const sparklines: Record<string, Array<{ date: string; pnlPercent: number }>> = {};
      for (const wallet of wallets) {
        const snaps = grouped.get(wallet) ?? [];
        const series: Array<{ date: string; pnlPercent: number }> = [];

        // Prepend a zero anchor one day before the first snapshot so the line
        // visibly starts from 0% rather than mid-curve. For "all" this is
        // always the wallet's inception; for windowed ranges we still anchor
        // at the window start so the shape reads correctly.
        if (snaps.length > 0) {
          const firstSnapDate = new Date(snaps[0].snapshotDate);
          firstSnapDate.setHours(0, 0, 0, 0);
          const dayBeforeFirst = new Date(firstSnapDate);
          dayBeforeFirst.setDate(dayBeforeFirst.getDate() - 1);
          if (!since || dayBeforeFirst >= since) {
            series.push({ date: dayBeforeFirst.toISOString(), pnlPercent: 0 });
          }
        }

        for (const s of snaps) {
          const deposits = parseFloat(s.cumulativeDeposits);
          const netPnl = parseFloat(s.netPnl);
          const pnlPercent = deposits > 0 ? (netPnl / deposits) * 100 : 0;
          series.push({
            date: (s.snapshotDate instanceof Date ? s.snapshotDate : new Date(s.snapshotDate)).toISOString(),
            pnlPercent,
          });
        }

        // Append a current-day point when today's snapshot is missing. We
        // can't afford per-wallet live RPC here (the leaderboard would burn
        // the Pacifica/Solana quota), so we carry the last known pnlPercent
        // forward to today — the tip refreshes once the snapshot job runs.
        if (snaps.length > 0) {
          const lastSnap = snaps[snaps.length - 1];
          const lastSnapDay = new Date(lastSnap.snapshotDate);
          lastSnapDay.setHours(0, 0, 0, 0);
          if (lastSnapDay.getTime() < today.getTime()) {
            const lastPoint = series[series.length - 1];
            series.push({ date: today.toISOString(), pnlPercent: lastPoint.pnlPercent });
          }
        }

        sparklines[wallet] = series;
      }
      res.json({ range, sparklines });
    } catch (error) {
      console.error("Get leaderboard sparklines error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/prices", async (req, res) => {
    try {
      const prices = await getAllPrices();
      res.json(prices);
    } catch (error) {
      console.error("Get prices error:", error);
      res.status(500).json({ error: "Failed to fetch prices" });
    }
  });

  // Get all available Drift perp markets with liquidity info
  app.get("/api/exchange/markets", async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const exchange = typeof req.query.exchange === 'string' ? req.query.exchange.trim().toLowerCase() : '';
      // Exchange-aware path: lists a SPECIFIC registered adapter's markets (e.g.
      // ?exchange=flash) without touching the global Pacifica registry. No param =
      // default behavior (global registry). Unknown exchange → 400.
      let markets;
      if (exchange) {
        try {
          markets = await getAllPerpMarketsForExchange(exchange, forceRefresh);
        } catch (err: any) {
          return res.status(400).json({ error: `Unknown or unavailable exchange: ${exchange}`, detail: err?.message });
        }
      } else {
        markets = await getAllPerpMarkets(forceRefresh);
      }
      
      // Add risk tier info to each market
      const marketsWithInfo = markets.map(market => ({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      }));
      
      res.json({
        markets: marketsWithInfo,
        totalMarkets: markets.length,
        recommended: markets.filter(m => m.riskTier === 'recommended').length,
        caution: markets.filter(m => m.riskTier === 'caution').length,
        highRisk: markets.filter(m => m.riskTier === 'high_risk').length,
      });
    } catch (error) {
      console.error("Get markets error:", error);
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  // Get single market info
  app.get("/api/exchange/markets/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const market = await getMarketBySymbol(symbol);
      
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }
      
      res.json({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      });
    } catch (error) {
      console.error("Get market error:", error);
      res.status(500).json({ error: "Failed to fetch market" });
    }
  });

  // Get market liquidity cache status
  app.get("/api/exchange/markets/cache/status", async (req, res) => {
    try {
      const status = getCacheStatus();
      res.json(status);
    } catch (error) {
      console.error("Get cache status error:", error);
      res.status(500).json({ error: "Failed to get cache status" });
    }
  });

  app.get("/api/exchange/non-tradable-markets", async (req, res) => {
    try {
      const cacheStatus = getLeverageCacheStatus();
      res.json({
        nonTradableMarkets: cacheStatus.nonTradableMarkets,
        lastUpdated: cacheStatus.lastUpdated,
      });
    } catch (error) {
      console.error("Get non-tradable markets error:", error);
      res.status(500).json({ error: "Failed to get non-tradable markets" });
    }
  });

  app.get("/api/exchange/leverage-limits", async (req, res) => {
    try {
      const leverageMap = getAllCachedLeverageLimits();
      const cacheStatus = getLeverageCacheStatus();
      res.json({
        leverageLimits: leverageMap,
        source: cacheStatus.source,
        lastUpdated: cacheStatus.lastUpdated,
        marketCount: cacheStatus.marketCount,
      });
    } catch (error) {
      console.error("Get leverage limits error:", error);
      res.status(500).json({ error: "Failed to fetch leverage limits" });
    }
  });

  // USDC APY cache and shared helper function
  let usdcApyCache: { apy: number; timestamp: number } | null = null;
  const USDC_APY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const USDC_APY_FALLBACK = 5.3; // Fallback APY percentage if fetch fails

  // Shared helper to get current USDC APY (fetches fresh if cache expired)
  async function getUsdcApy(): Promise<{ apy: number; cached: boolean; stale?: boolean }> {
    // Return cached value if still valid
    if (usdcApyCache && Date.now() - usdcApyCache.timestamp < USDC_APY_CACHE_TTL) {
      return { apy: usdcApyCache.apy, cached: true };
    }

    try {
      // Fetch fresh data from Drift Data API
      const response = await fetch('https://data.api.drift.trade/rateHistory?marketIndex=0&marketType=spot');
      if (!response.ok) {
        throw new Error(`Drift API returned ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !data.data || data.data.length === 0) {
        throw new Error('Invalid response from Drift API');
      }

      // Get the latest APY (last entry in array)
      const latestEntry = data.data[data.data.length - 1];
      const apy = parseFloat(latestEntry[1]) * 100; // Convert to percentage

      // Cache the result
      usdcApyCache = { apy, timestamp: Date.now() };

      return { apy, cached: false };
    } catch (error) {
      console.error("Get USDC APY error:", error);
      // Return cached value on error if available, otherwise fallback
      if (usdcApyCache) {
        return { apy: usdcApyCache.apy, cached: true, stale: true };
      }
      return { apy: USDC_APY_FALLBACK, cached: false, stale: true };
    }
  }

  app.get("/api/exchange/usdc-apy", async (_req, res) => {
    res.json({ apy: null, cached: false, stale: false, unavailable: true });
  });

  // Force refresh market OI data (admin endpoint)
  app.post("/api/admin/liquidity/refresh", async (req, res) => {
    try {
      console.log('[Admin] Force refreshing market liquidity data...');
      const result = await refreshMarketData();
      res.json(result);
    } catch (error: any) {
      console.error("Refresh market data error:", error);
      res.status(500).json({ error: error.message || "Failed to refresh market data" });
    }
  });

  // SSE endpoint for real-time price streaming (must come BEFORE :market route)
  app.get("/api/prices/stream", async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const sendPrices = async () => {
      try {
        const prices = await getAllPrices();
        res.write(`data: ${JSON.stringify(prices)}\n\n`);
      } catch (e) {
        console.error('[SSE] Price fetch error:', e);
      }
    };

    await sendPrices();
    const interval = setInterval(sendPrices, 3000);
    req.on('close', () => clearInterval(interval));
  });

  app.get("/api/prices/:market", async (req, res) => {
    try {
      const { market } = req.params;
      const price = await getMarketPrice(market);
      if (price === null) {
        return res.status(404).json({ error: "Market not found or price unavailable" });
      }
      res.json({ market, price });
    } catch (error) {
      console.error("Get price error:", error);
      res.status(500).json({ error: "Failed to fetch price" });
    }
  });

  app.post("/api/exchange/build-deposit", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildDepositTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Exchange deposit build error:", error);
      res.status(500).json({ error: "Failed to build deposit transaction" });
    }
  });

  app.post("/api/exchange/build-withdraw", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildWithdrawTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Exchange withdraw build error:", error);
      res.status(500).json({ error: "Failed to build withdraw transaction" });
    }
  });

  app.get("/api/exchange/wallet-balance", async (req, res) => {
    try {
      const walletAddress = req.query.wallet as string;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      const [usdcBalance, driftBalance] = await Promise.all([
        getUsdcBalance(walletAddress),
        getExchangeBalance(walletAddress),
      ]);
      res.json({ usdcBalance, exchangeBalance: driftBalance });
    } catch (error) {
      console.error("Exchange wallet balance error:", error);
      res.status(500).json({ error: "Failed to fetch balances" });
    }
  });

  app.get("/api/total-equity", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      const [agentBalance, solBalance, aggregateAccountInfo] = await Promise.all([
        agentAddress ? getAgentUsdcBalance(agentAddress) : Promise.resolve(0),
        agentAddress ? getAgentSolBalance(agentAddress) : Promise.resolve(0),
        agentAddress ? getExchangeAccountInfo(agentAddress, 0) : Promise.resolve({ totalCollateral: 0, freeCollateral: 0 }),
      ]);
      
      const aggregateExchangeEquity = aggregateAccountInfo.totalCollateral;

      const subaccountBalances: { botId: string; botName: string; subaccountId: number; balance: number }[] = [];
      
      for (const bot of bots) {
        let botBalance = 0;
        try {
          const eqBotCtx = getBotSubaccountContext(bot);
          if (bot.activeProtocol === 'flash' && agentAddress && bot.protocolSubaccountId === agentAddress) {
            // Legacy Flash bot whose "subaccount" IS the agent wallet — counting it
            // here would double-count the agent balance (already in agentBalance).
            botBalance = 0;
          } else if (eqBotCtx) {
            const liveInfo = await getExchangeAccountInfoForBot('', 0, eqBotCtx, getAdapterForBot(bot));
            botBalance = liveInfo.totalCollateral;
          } else {
            let prices: Record<string, number> = {};
            try { prices = await getAllPrices(); } catch (e) { /* prices unavailable */ }
            const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
            const netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
            const position = await storage.getBotPosition(bot.id, bot.market);
            const realizedPnl = parseFloat(position?.realizedPnl || '0');
            const totalFees = parseFloat(position?.totalFees || '0');
            
            let unrealizedPnl = 0;
            if (position) {
              const baseSize = parseFloat(position.baseSize);
              const entryPrice = parseFloat(position.avgEntryPrice);
              const markPrice = prices[position.market] || entryPrice;
              if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
                unrealizedPnl = baseSize > 0
                  ? (markPrice - entryPrice) * Math.abs(baseSize)
                  : (entryPrice - markPrice) * Math.abs(baseSize);
              }
            }
            
            botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
          }
        } catch (err) {
          console.warn(`[total-equity] Failed to calc bot balance for ${bot.id}:`, err);
        }
        
        subaccountBalances.push({
          botId: bot.id,
          botName: bot.name,
          subaccountId: bot.driftSubaccountId ?? 0,
          balance: botBalance,
        });
      }
      
      const totalBotBalances = subaccountBalances.reduce((sum, b) => sum + b.balance, 0);
      const mainAccountEquity = aggregateExchangeEquity;
      const mainAccountFreeCollateral = aggregateAccountInfo.freeCollateral ?? 0;
      
      const inTrading = mainAccountEquity + totalBotBalances;
      const totalEquity = agentBalance + inTrading;
      
      console.log(`[total-equity] agent=$${agentBalance.toFixed(2)} mainAcct=$${mainAccountEquity.toFixed(2)} bots=$${totalBotBalances.toFixed(2)} inTrading=$${inTrading.toFixed(2)} mainFree=$${mainAccountFreeCollateral.toFixed(2)} total=$${totalEquity.toFixed(2)}`);
      
      res.json({ 
        agentBalance,
        exchangeBalance: inTrading,
        mainAccountBalance: mainAccountEquity,
        mainAccountFreeCollateral,
        totalEquity,
        solBalance,
        botCount: bots.length,
        subaccountBalances,
      });
    } catch (error) {
      console.error("Total equity error:", error);
      res.status(500).json({ error: "Failed to fetch total equity" });
    }
  });

  app.post("/api/bot/:botId/deposit", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const botCtx = getBotSubaccountContext(bot);
      if (!botCtx) {
        return res.status(400).json({ error: "Bot has no active trading subaccount" });
      }

      const _botTransferAdapter = getAdapterForBot(bot);
      if (amount < _botTransferAdapter.minTransferAmount) {
        return res.status(400).json({ error: `${_botTransferAdapter.protocolName} minimum transfer is $${_botTransferAdapter.minTransferAmount}` });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(403).json({ error: "Execution not enabled. Please enable execution authorization first." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      umkResult.cleanup();
      if (!agentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please sign in again." });
      }
      const agentKeypair = Keypair.fromSecretKey(Buffer.from(agentKeyResult.secretKey));
      agentKeyResult.cleanup();

      const adapter = getAdapterForBot(bot);
      const transferResult = await adapter.transferBetweenSubaccounts({
        agentSecretKey: agentKeypair.secretKey,
        mainWalletAddress: agentKeypair.publicKey.toString(),
        fromSubaccountId: agentKeypair.publicKey.toString(),
        toSubaccountId: botCtx.botPublicKey,
        amount,
      });

      if (!transferResult.success) {
        return res.status(400).json({ error: transferResult.error || "Transfer failed" });
      }

      try {
        await storage.createEquityEvent({
          walletAddress: req.walletAddress!,
          tradingBotId: botId,
          eventType: 'drift_deposit',
          amount: String(amount),
          txSignature: null,
          notes: `Transfer to bot subaccount ${botCtx.botPublicKey}`,
        });
      } catch (eventErr: any) {
        console.error(`[Bot Deposit] Equity event recording failed:`, eventErr.message);
      }

      res.json({ success: true, message: `Transferred $${amount} to bot subaccount` });
    } catch (error: any) {
      console.error("Bot deposit error:", error);
      res.status(500).json({ error: error.message || "Failed to deposit to bot" });
    }
  });

  app.post("/api/bot/:botId/withdraw", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const botCtx = getBotSubaccountContext(bot);
      if (!botCtx) {
        return res.status(400).json({ error: "Bot has no active trading subaccount" });
      }

      const _botTransferAdapter = getAdapterForBot(bot);
      if (amount < _botTransferAdapter.minTransferAmount) {
        return res.status(400).json({ error: `${_botTransferAdapter.protocolName} minimum transfer is $${_botTransferAdapter.minTransferAmount}` });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(403).json({ error: "Execution not enabled. Please enable execution authorization first." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      umkResult.cleanup();
      if (!agentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please sign in again." });
      }
      const agentKeypair = Keypair.fromSecretKey(Buffer.from(agentKeyResult.secretKey));
      agentKeyResult.cleanup();

      const adapter = getAdapterForBot(bot);
      const decryptedBotKey = await _resolveBotSubaccountSecretKey(botCtx);
      try {
        const transferResult = await adapter.transferBetweenSubaccounts({
          agentSecretKey: decryptedBotKey.secretKey,
          mainWalletAddress: agentKeypair.publicKey.toString(),
          fromSubaccountId: botCtx.botPublicKey,
          toSubaccountId: agentKeypair.publicKey.toString(),
          amount,
        });

        if (!transferResult.success) {
          return res.status(400).json({ error: transferResult.error || "Withdraw failed" });
        }

        try {
          await storage.createEquityEvent({
            walletAddress: req.walletAddress!,
            tradingBotId: botId,
            eventType: 'drift_withdraw',
            amount: String(-amount),
            txSignature: null,
            notes: `Withdraw from bot subaccount ${botCtx.botPublicKey}`,
          });
        } catch (eventErr: any) {
          console.error(`[Bot Withdraw] Equity event recording failed:`, eventErr.message);
        }

        res.json({ success: true, message: `Withdrew $${amount} from bot subaccount` });
      } finally {
        decryptedBotKey.cleanup();
      }
    } catch (error: any) {
      console.error("Bot withdraw error:", error);
      res.status(500).json({ error: error.message || "Failed to withdraw from bot" });
    }
  });

  // RPC Status endpoint - check health of primary and backup RPC providers
  app.get("/api/rpc-status", async (req, res) => {
    try {
      const IS_MAINNET = process.env.DRIFT_ENV !== 'devnet';
      
      // Determine RPC URLs
      let primaryUrl: string;
      let primaryName: string;
      
      if (process.env.SOLANA_RPC_URL) {
        primaryUrl = process.env.SOLANA_RPC_URL;
        primaryName = 'Custom RPC';
      } else if (IS_MAINNET && process.env.HELIUS_API_KEY) {
        primaryUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
        primaryName = 'Helius';
      } else {
        primaryUrl = IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
        primaryName = 'Solana Public';
      }
      
      let backupUrl = process.env.TRITON_ONE_RPC || null;
      // Ensure backup URL has protocol prefix
      if (backupUrl && !backupUrl.startsWith('http://') && !backupUrl.startsWith('https://')) {
        backupUrl = `https://${backupUrl}`;
      }
      const backupName = backupUrl ? 'Triton One' : null;
      
      // Helper to check RPC health
      const checkRpcHealth = async (url: string): Promise<{ healthy: boolean; latency: number | null; slot: number | null; error?: string }> => {
        const start = Date.now();
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
            signal: AbortSignal.timeout(5000),
          });
          const data = await response.json() as any;
          const latency = Date.now() - start;
          
          if (data.result) {
            return { healthy: true, latency, slot: data.result };
          } else {
            return { healthy: false, latency: null, slot: null, error: data.error?.message || 'Unknown error' };
          }
        } catch (err: any) {
          return { healthy: false, latency: null, slot: null, error: err.message || 'Connection failed' };
        }
      };
      
      // Check both RPCs in parallel
      const [primaryStatus, backupStatus] = await Promise.all([
        checkRpcHealth(primaryUrl),
        backupUrl ? checkRpcHealth(backupUrl) : Promise.resolve(null),
      ]);
      
      res.json({
        primary: {
          name: primaryName,
          configured: true,
          ...primaryStatus,
        },
        backup: backupUrl ? {
          name: backupName,
          configured: true,
          ...backupStatus,
        } : {
          name: null,
          configured: false,
          healthy: false,
          latency: null,
          slot: null,
        },
        network: IS_MAINNET ? 'mainnet-beta' : 'devnet',
      });
    } catch (error: any) {
      console.error("RPC status error:", error);
      res.status(500).json({ error: "Failed to check RPC status" });
    }
  });

  // Solana RPC proxy - forwards requests to Helius securely with rate limiting and caching
  const rpcCache = new Map<string, { data: any; timestamp: number }>();
  const RPC_CACHE_TTL = 2000; // 2 second cache for balance/account queries
  const RPC_RATE_LIMIT_WINDOW = 1000; // 1 second window
  const RPC_MAX_REQUESTS_PER_WINDOW = 25; // Max requests per second
  let rpcRequestCount = 0;
  let rpcWindowStart = Date.now();
  
  app.post("/api/solana-rpc", async (req, res) => {
    try {
      const IS_MAINNET = process.env.DRIFT_ENV !== 'devnet';
      let rpcUrl: string;
      
      if (process.env.SOLANA_RPC_URL) {
        rpcUrl = process.env.SOLANA_RPC_URL;
      } else if (IS_MAINNET && process.env.HELIUS_API_KEY) {
        rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
      } else {
        rpcUrl = IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
      }
      
      // Create cache key from request body (excluding id which changes per request)
      const { id, ...bodyWithoutId } = req.body;
      const cacheKey = JSON.stringify(bodyWithoutId);
      
      // Check cache first for read-only methods
      const readOnlyMethods = ['getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getMultipleAccounts'];
      const method = req.body?.method;
      if (readOnlyMethods.includes(method)) {
        const cached = rpcCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < RPC_CACHE_TTL) {
          // Return cached response with the current request's id
          return res.json({ ...cached.data, id });
        }
      }
      
      // Rate limiting check
      const now = Date.now();
      if (now - rpcWindowStart > RPC_RATE_LIMIT_WINDOW) {
        rpcWindowStart = now;
        rpcRequestCount = 0;
      }
      
      if (rpcRequestCount >= RPC_MAX_REQUESTS_PER_WINDOW) {
        // Return rate limited response without crashing
        return res.json({
          jsonrpc: "2.0",
          error: { code: -32429, message: "rate limited" },
          id
        });
      }
      
      rpcRequestCount++;
      
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      
      const data = await response.json();
      
      // Cache successful responses for read-only methods
      if (readOnlyMethods.includes(method) && !data.error) {
        rpcCache.set(cacheKey, { data, timestamp: Date.now() });
        // Cleanup old cache entries periodically
        if (rpcCache.size > 500) {
          const cutoff = Date.now() - RPC_CACHE_TTL;
          const keysToDelete: string[] = [];
          rpcCache.forEach((value, key) => {
            if (value.timestamp < cutoff) keysToDelete.push(key);
          });
          keysToDelete.forEach(key => rpcCache.delete(key));
        }
      }
      
      res.json(data);
    } catch (error: any) {
      console.error("RPC proxy error:", error);
      res.status(500).json({ 
        jsonrpc: "2.0",
        error: { code: -32603, message: "RPC request failed" },
        id: req.body?.id || null 
      });
    }
  });

  app.get("/api/bot/:botId/balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const balSingularCtx = getBotSubaccountContext(bot);

      if (balSingularCtx) {
        const [liveInfo, tradeCount] = await Promise.all([
          getExchangeAccountInfoForBot('', 0, balSingularCtx, getAdapterForBot(bot)),
          storage.getCanonicalBotTradeCount(botId),
        ]);
        return res.json({
          driftSubaccountId: 0,
          subaccountExists: true,
          usdcBalance: liveInfo.totalCollateral,
          realizedPnl: 0,
          totalFees: 0,
          tradeCount,
        });
      }

      const [position, tradeCount, botEvents] = await Promise.all([
        storage.getBotPosition(botId, bot.market),
        storage.getCanonicalBotTradeCount(botId),
        storage.getBotEquityEvents(bot.id, 1000),
      ]);

      const netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
      const realizedPnl = parseFloat(position?.realizedPnl || "0");
      const totalFees = parseFloat(position?.totalFees || "0");
      
      let unrealizedPnl = 0;
      if (position) {
        let prices: Record<string, number> = {};
        try { prices = await getAllPrices(); } catch (e) { /* */ }
        const baseSize = parseFloat(position.baseSize);
        const entryPrice = parseFloat(position.avgEntryPrice);
        const markPrice = prices[position.market] || entryPrice;
        if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
          unrealizedPnl = baseSize > 0
            ? (markPrice - entryPrice) * Math.abs(baseSize)
            : (entryPrice - markPrice) * Math.abs(baseSize);
        }
      }
      
      const botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
      
      res.json({ 
        driftSubaccountId: bot.driftSubaccountId ?? 0,
        subaccountExists: netDeposited > 0,
        usdcBalance: botBalance,
        realizedPnl,
        totalFees,
        tradeCount,
      });
    } catch (error) {
      console.error("Bot balance error:", error);
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  // ==================== MARKETPLACE ROUTES ====================

  // Get marketplace listings
  app.get("/api/marketplace", async (req, res) => {
    try {
      const { search, market, sortBy, limit } = req.query;
      const bots = await storage.getPublishedBots({
        search: search as string,
        market: market as string,
        sortBy: sortBy as string,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json(bots);
    } catch (error) {
      console.error("Get marketplace error:", error);
      res.status(500).json({ error: "Failed to fetch marketplace" });
    }
  });

  // Get user's own published bots (must be before :id route)
  app.get("/api/marketplace/my-published", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getPublishedBotsByCreator(req.walletAddress!);
      
      // Add earnings to each bot
      const botsWithEarnings = await Promise.all(bots.map(async (bot) => {
        const earnings = await storage.getPublishedBotEarnings(bot.id);
        return {
          ...bot,
          creatorEarnings: earnings.toFixed(2),
        };
      }));
      
      res.json(botsWithEarnings);
    } catch (error) {
      console.error("Get my published bots error:", error);
      res.status(500).json({ error: "Failed to fetch published bots" });
    }
  });

  // Get single published bot details
  app.get("/api/marketplace/:id", async (req, res) => {
    try {
      const bot = await storage.getPublishedBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get published bot error:", error);
      res.status(500).json({ error: "Failed to fetch bot" });
    }
  });

  // Get public performance data for a published bot (trade-based chart like bot management drawer)
  app.get("/api/marketplace/:id/performance", async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      
      // Get performance series from trades (same as bot management drawer)
      const publishedAt = new Date(publishedBot.publishedAt);
      const tradeSeries = await storage.getBotPerformanceSeries(publishedBot.tradingBotId, publishedAt);
      
      // Get the creator's net deposited amount for percentage calculations
      const tradingBot = await storage.getTradingBotById(publishedBot.tradingBotId);
      let netDeposited = 0;
      if (tradingBot) {
        const equityEvents = await storage.getBotEquityEvents(publishedBot.tradingBotId, 1000);
        // Amounts in equity_events are already signed (+ for deposits, - for withdrawals)
        // Just sum all amounts to get net deposited
        netDeposited = equityEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
      }
      
      // Build chart data showing performance since publish (starts at 0%)
      const performanceData: { date: Date; pnl: number; pnlDollar: number }[] = [];
      
      // Add initial 0 point at publish date
      performanceData.push({
        date: publishedAt,
        pnl: 0,
        pnlDollar: 0,
      });
      
      // Add trade points with cumulative PnL as percentage of net deposited
      tradeSeries.forEach(trade => {
        const pnlPercent = netDeposited > 0 
          ? (trade.cumulativePnl / netDeposited) * 100 
          : 0;
        performanceData.push({
          date: trade.timestamp,
          pnl: parseFloat(pnlPercent.toFixed(4)),
          pnlDollar: trade.cumulativePnl,
        });
      });
      
      res.json({
        botId: publishedBot.id,
        market: publishedBot.market,
        totalTrades: publishedBot.totalTrades,
        winningTrades: publishedBot.winningTrades,
        winRate: publishedBot.totalTrades > 0 
          ? ((publishedBot.winningTrades / publishedBot.totalTrades) * 100).toFixed(1)
          : '0',
        pnlPercent7d: publishedBot.pnlPercent7d,
        pnlPercent30d: publishedBot.pnlPercent30d,
        pnlPercent90d: publishedBot.pnlPercent90d,
        pnlPercentAllTime: publishedBot.pnlPercentAllTime,
        profitSharePercent: publishedBot.profitSharePercent,
        subscriberCount: publishedBot.subscriberCount,
        creatorCapital: publishedBot.creatorCapital,
        totalCapitalInvested: publishedBot.totalCapitalInvested,
        equityHistory: performanceData,
      });
    } catch (error) {
      console.error("Get bot performance error:", error);
      res.status(500).json({ error: "Failed to fetch performance data" });
    }
  });

  // Risk analysis for a published bot — computes drawdown, Sharpe, and safe-sizing suggestions
  app.get("/api/marketplace/:id/risk-analysis", async (req, res) => {
    try {
      const bot = await storage.getPublishedBotById(req.params.id);
      if (!bot) return res.status(404).json({ error: "Bot not found" });

      // Fetch the underlying trading bot to know what leverage the equity series was
      // recorded at, so we can normalize observed drawdown to a 1x baseline.
      const sourceBot = await storage.getTradingBotById(bot.tradingBotId);
      const creatorLeverage = Math.max(1, Number(sourceBot?.leverage) || 1);

      const rawSnapshots = await db
        .select()
        .from(marketplaceEquitySnapshots)
        .where(eq(marketplaceEquitySnapshots.publishedBotId, req.params.id))
        .orderBy(asc(marketplaceEquitySnapshots.snapshotDate));

      // Dedupe to one snapshot per UTC day (keep last equity of the day).
      // Snapshots are taken every 6 hours plus on server restarts, so raw
      // counts overstate "days" and break the daily-Sharpe annualisation.
      const byDay = new Map<string, typeof rawSnapshots[number]>();
      for (const s of rawSnapshots) {
        if (parseFloat(s.equity as any) <= 0) continue;
        const day = new Date(s.snapshotDate as any).toISOString().slice(0, 10);
        byDay.set(day, s);
      }
      const snapshots = Array.from(byDay.values()).slice(-365);

      let maxDrawdownPct = 0;
      let sharpeRatio: number | null = null;

      if (snapshots.length >= 2) {
        let peak = parseFloat(snapshots[0].equity as any);
        for (const snap of snapshots) {
          const eq = parseFloat(snap.equity as any);
          if (eq > peak) peak = eq;
          if (peak > 0) {
            const dd = (peak - eq) / peak;
            if (dd > maxDrawdownPct) maxDrawdownPct = dd;
          }
        }

        if (snapshots.length >= 10) {
          const returns: number[] = [];
          for (let i = 1; i < snapshots.length; i++) {
            const prev = parseFloat(snapshots[i - 1].equity as any);
            const curr = parseFloat(snapshots[i].equity as any);
            if (prev > 0) returns.push((curr - prev) / prev);
          }
          if (returns.length >= 5) {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            const stdDev = Math.sqrt(variance);
            if (stdDev > 0) {
              sharpeRatio = Math.round((mean / stdDev) * Math.sqrt(252) * 100) / 100;
            }
          }
        }
      }

      const winRate = bot.totalTrades > 0
        ? Math.round((bot.winningTrades / bot.totalTrades) * 1000) / 10
        : null;

      // Normalize observed drawdown to a 1x baseline. The equity series is
      // recorded at the creator's leverage; dividing by creatorLeverage gives the
      // approximate underlying-strategy DD that subscribers can rescale to their
      // own chosen leverage. (Linear scaling is a first-order approximation that
      // matches QuantumLab's `levDD = baseDD × leverage` model.)
      const baseDrawdownPct1x = maxDrawdownPct / creatorLeverage;

      // At Nx leverage, effective drawdown = N × baseDD. Keep that ≤ 50%.
      // Two bounds, take the more conservative:
      // 1. Normalised bound: derived from baseDrawdownPct1x (creator-leverage-agnostic,
      //    lets a subscriber survive what a high-leverage creator got wrecked by).
      // 2. Observed bound: derived from the raw observed DD. A real-world catastrophic
      //    drawdown is a meaningful signal — normalising it away entirely would let
      //    a 91%-drawdown bot suggest 5x if the creator just happened to be at 10x.
      const suggestedFromNormalized = baseDrawdownPct1x > 0
        ? Math.max(1, Math.min(10, Math.floor(0.5 / baseDrawdownPct1x)))
        : 1;
      const suggestedFromObserved = maxDrawdownPct > 0
        ? Math.max(1, Math.min(10, Math.floor(0.5 / maxDrawdownPct)))
        : 1;
      const suggestedLeverage = Math.min(suggestedFromNormalized, suggestedFromObserved);

      // Invest this fraction of balance so worst-case loss ≤ 20% of total balance.
      const worstCasePct = baseDrawdownPct1x * suggestedLeverage;
      const suggestedEquityPct = worstCasePct > 0
        ? Math.min(1, Math.round((0.2 / worstCasePct) * 100) / 100)
        : 0.5;

      res.json({
        winRate,
        totalTrades: bot.totalTrades,
        // maxDrawdownPct is the 1x-equivalent baseline (observed DD / creator leverage),
        // returned in % units (0-100). Clients scale by their chosen leverage.
        maxDrawdownPct: Math.round(baseDrawdownPct1x * 10000) / 100,
        observedDrawdownPct: Math.round(maxDrawdownPct * 10000) / 100,
        creatorLeverage,
        sharpeRatio,
        dataPoints: snapshots.length,
        suggestedLeverage,
        suggestedEquityPct,
        hasEnoughData: snapshots.length >= 10,
      });
    } catch (error: any) {
      console.error("[risk-analysis]", error);
      res.status(500).json({ error: "Failed to compute risk analysis" });
    }
  });

  // Publish a bot to marketplace
  app.post("/api/trading-bots/:id/publish", requireWallet, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, profitSharePercent } = req.body;

      const tradingBot = await storage.getTradingBotById(id);
      if (!tradingBot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (tradingBot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Block re-publishing of subscribed/copied bots. A bot with
      // sourcePublishedBotId set is a copy of someone else's published bot
      // (created via the marketplace subscribe flow), so republishing it would
      // let a subscriber re-share another creator's strategy as their own.
      if (tradingBot.sourcePublishedBotId) {
        return res.status(403).json({ error: "Subscribed bots cannot be published to the marketplace" });
      }

      // Check if already published
      const existing = await storage.getPublishedBotByTradingBotId(id);
      if (existing) {
        // If previously unpublished (inactive), allow republishing
        if (!existing.isActive) {
          await storage.updatePublishedBot(existing.id, { 
            isActive: true,
            name: name || tradingBot.name,
            description: description || existing.description,
            profitSharePercent: String(Math.min(10, Math.max(0, Number(profitSharePercent) || 0))),
          });
          console.log(`[Marketplace] Bot ${id} republished (reactivated)`);
          const updated = await storage.getPublishedBotById(existing.id);
          return res.json(updated);
        }
        return res.status(400).json({ error: "Bot is already published" });
      }

      // Must be a signal bot (not grid)
      if (tradingBot.botType !== 'signal') {
        return res.status(400).json({ error: "Only signal bots can be published to the marketplace" });
      }

      // Validate profit share percentage (0-10%)
      const rawProfitShare = Number(profitSharePercent);
      const validProfitShare = isNaN(rawProfitShare) ? 0 : Math.min(10, Math.max(0, rawProfitShare));

      // Create published bot entry
      const publishedBot = await storage.createPublishedBot({
        tradingBotId: id,
        creatorWalletAddress: req.walletAddress!,
        name: name || tradingBot.name,
        description: description || null,
        market: tradingBot.market,
        isActive: true,
        isFeatured: false,
        profitSharePercent: validProfitShare.toString(),
      });

      // Sync initial stats from trading bot to published bot — use canonical
      // SQL-derived counts so the marketplace card matches the share card.
      const canonicalCounts = await storage.getCanonicalBotTradeStats(id);
      const totalTrades = canonicalCounts.totalTrades;
      const winningTrades = canonicalCounts.winningTrades;
      
      // Get creator's current equity from Drift
      let creatorEquity = 0;
      try {
        const wallet = await storage.getWallet(req.walletAddress!);
        if (wallet?.agentPublicKey && tradingBot.driftSubaccountId) {
          const accountInfo = await getExchangeAccountInfo(
            wallet.agentPublicKey,
            tradingBot.driftSubaccountId,
            getAdapterForBot(tradingBot)
          );
          creatorEquity = accountInfo.usdcBalance || 0;
        }
      } catch (equityError) {
        console.error(`[Marketplace] Failed to get creator equity:`, equityError);
      }
      
      // Update published bot stats including creator capital
      await storage.updatePublishedBotStats(publishedBot.id, {
        totalTrades,
        winningTrades,
        creatorCapital: String(creatorEquity),
      });
      
      // Also update totalCapitalInvested to include creator's capital
      if (creatorEquity > 0) {
        await storage.incrementPublishedBotSubscribers(publishedBot.id, 0, creatorEquity);
      }
      
      // Create initial marketplace equity snapshot
      if (creatorEquity > 0) {
        await storage.createMarketplaceEquitySnapshot({
          publishedBotId: publishedBot.id,
          snapshotDate: new Date(),
          equity: String(creatorEquity),
          pnlPercent: "0",
        });
      }
      
      console.log(`[Marketplace] Bot ${id} published with stats: ${totalTrades} trades, ${winningTrades} wins, creator capital: $${creatorEquity.toFixed(2)}`);
      res.json(publishedBot);
    } catch (error) {
      console.error("Publish bot error:", error);
      res.status(500).json({ error: "Failed to publish bot" });
    }
  });

  // Unpublish a bot from marketplace
  app.delete("/api/marketplace/:id", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (publishedBot.creatorWalletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Mark as inactive instead of deleting (preserves subscriber data)
      await storage.updatePublishedBot(req.params.id, { isActive: false });
      
      console.log(`[Marketplace] Bot ${req.params.id} unpublished by ${req.walletAddress}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Unpublish bot error:", error);
      res.status(500).json({ error: "Failed to unpublish bot" });
    }
  });

  // Subscribe to a published bot (creates a new trading bot that mirrors signals)
  app.post("/api/marketplace/:id/subscribe", requireWallet, async (req, res) => {
    try {
      // Strict numeric validation — reject NaN/Infinity/negative/oversized inputs.
      const capitalInvestedNum = Number(req.body?.capitalInvested);
      const leverageNum = Number(req.body?.leverage);
      const investmentAmountRaw = req.body?.investmentAmount;

      if (!Number.isFinite(capitalInvestedNum) || capitalInvestedNum <= 0) {
        return res.status(400).json({ error: "Valid capital amount required" });
      }
      if (capitalInvestedNum > 10_000_000) {
        return res.status(400).json({ error: "Capital exceeds maximum allowed ($10M)" });
      }

      const MIN_SUBSCRIPTION_USDC = 10;
      if (capitalInvestedNum < MIN_SUBSCRIPTION_USDC) {
        return res.status(400).json({
          error: `Minimum subscription is $${MIN_SUBSCRIPTION_USDC.toFixed(2)} USDC. You entered $${capitalInvestedNum.toFixed(2)}.`
        });
      }

      // Bound leverage to [1, 50] (exchange enforces per-market max on order placement).
      if (!Number.isFinite(leverageNum) || leverageNum < 1 || leverageNum > 50) {
        return res.status(400).json({ error: "Leverage must be between 1x and 50x" });
      }
      const leverage = Math.floor(leverageNum);
      const capitalInvested = capitalInvestedNum;

      // investmentAmount is the position-sizing baseline (capital - equityBuffer).
      // When omitted, fall back to depositing the full capital as the investment
      // (preserves backward compatibility with older clients).
      let sizingInvestment: number;
      if (investmentAmountRaw !== undefined && investmentAmountRaw !== null) {
        const investmentNum = Number(investmentAmountRaw);
        if (!Number.isFinite(investmentNum) || investmentNum <= 0) {
          return res.status(400).json({ error: "Invalid investment amount" });
        }
        sizingInvestment = Math.min(investmentNum, capitalInvested);
      } else {
        sizingInvestment = capitalInvested;
      }
      if (sizingInvestment < MIN_SUBSCRIPTION_USDC) {
        return res.status(400).json({
          error: `Investment amount must be at least $${MIN_SUBSCRIPTION_USDC.toFixed(2)} USDC. Reduce equity buffer or increase capital.`
        });
      }

      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (!publishedBot.isActive) {
        return res.status(400).json({ error: "This bot is no longer available" });
      }

      // Check if already subscribed. Only a previously 'cancelled' row is
      // eligible for reactivation below. 'active' and 'paused' both mean the
      // user is still subscribed (paused = subscribed but execution disabled,
      // recovered by re-enabling execution, NOT by re-subscribing). Allowing a
      // re-subscribe over a paused row would create a duplicate copy bot and
      // double-count subscriber/capital stats, since pausing never decrements
      // incrementPublishedBotSubscribers.
      const existingSub = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (existingSub && existingSub.status !== 'cancelled') {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }

      // Get the original trading bot to clone settings
      const originalBot = await storage.getTradingBotById(publishedBot.tradingBotId);
      if (!originalBot) {
        return res.status(404).json({ error: "Original bot not found" });
      }
      
      // Get wallet to check for agent wallet and available balance.
      // V3 Phase 3b: readiness is V3-only — agent public key + V3 envelope.
      // The legacy AGENT_ENCRYPTION_KEY blob is intentionally NOT required so
      // wallets that have already retired their legacy key can still subscribe.
      let wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not set up. Please set up your agent wallet first." });
      }

      // V3 Phase 3b: subscribing means consenting to have YOUR keys signed
      // for trades fired by another user's webhook. Require executionEnabled
      // up-front so fan-out has a UMK to derive the V3 key from. The frontend
      // routes the user through the enable-execution flow on `action`.
      if (!wallet.executionEnabled || wallet.emergencyStopTriggered) {
        return res.status(412).json({
          error: "Execution authorization required before subscribing.",
          action: "enable_execution",
        });
      }

      // AUTO-REFERRAL: Attribute referral to the bot creator if subscriber doesn't already have a referrer
      // This ensures creators get credit for users who subscribe via marketplace URLs
      if (!wallet.referredBy && publishedBot.creatorWalletAddress !== req.walletAddress) {
        const written = await writeReferralChain(req.walletAddress!, publishedBot.creatorWalletAddress);
        if (written) {
          await storage.updateWallet(req.walletAddress!, { referredBy: publishedBot.creatorWalletAddress });
          wallet = (await storage.getWallet(req.walletAddress!))!;
          console.log(`[Referral] Auto-attributed: ${req.walletAddress} referred by ${publishedBot.creatorWalletAddress} (via marketplace subscription)`);
        }
      }
      
      // Check available balance in agent wallet (SPL USDC token account, not Drift subaccount)
      const [agentUsdcBalance, solBalance, exchangeAccountExists] = await Promise.all([
        getUsdcBalance(wallet.agentPublicKey),
        getAgentSolBalance(wallet.agentPublicKey),
        subaccountExists(wallet.agentPublicKey, 0),
      ]);
      
      if (agentUsdcBalance < capitalInvested) {
        return res.status(400).json({ 
          error: `Insufficient balance. You have $${agentUsdcBalance.toFixed(2)} available but need $${capitalInvested.toFixed(2)}. Please deposit more USDC to your agent wallet first.` 
        });
      }
      
      const TRADING_GAS = 0.005;
      const requiredSol = TRADING_GAS;
      
      if (solBalance < requiredSol - 0.001) {
        const deficit = requiredSol - solBalance;
        return res.status(400).json({ 
          error: `Insufficient SOL for transaction fees. Need ${requiredSol.toFixed(3)} SOL, have ${solBalance.toFixed(4)} SOL. Please deposit at least ${deficit.toFixed(3)} SOL to your agent wallet.` 
        });
      }

      // Use on-chain discovery combined with database state to find the next valid sequential subaccount ID
      // This ensures Drift's sequential requirement is met and avoids conflicts (same as bot creation)
      const webhookSecret = generateWebhookSecret();
      let nextSubaccountId: number;
      try {
        // Get all subaccount IDs currently allocated in the database for this wallet
        const dbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
        
        const existingOnChain = await discoverOnChainSubaccounts(wallet.agentPublicKey);
        const dbIdSet = new Set(dbAllocatedIds);
        for (const subId of existingOnChain) {
          if (subId > 0 && !dbIdSet.has(subId)) {
            try {
              const orphanedWebhookSecret = generateWebhookSecret();
              await storage.createTradingBot({
                walletAddress: req.walletAddress!,
                name: `Recovered Bot (SA${subId})`,
                market: 'SOL-PERP',
                webhookSecret: orphanedWebhookSecret,
                driftSubaccountId: subId,
                isActive: false,
                side: 'both',
                leverage: 1,
                totalInvestment: '0',
                maxPositionSize: null,
                signalConfig: { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
                riskConfig: {},
                subaccountAuthMode: 'main_plus_id',
                // Group D item 18: orphan recovery in marketplace flow — same Drift-only
                // semantics as the main creation site's recovery branch.
                activeProtocol: 'drift',
              } as any);
              console.log(`[Marketplace] Created recovered bot for orphaned subaccount ${subId}`);
            } catch (syncErr: any) {
              console.error(`[Marketplace] Failed to create placeholder for subaccount ${subId}:`, syncErr.message);
            }
          }
        }
        
        // Re-fetch allocated IDs after sync (may have added orphaned bots)
        const updatedDbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
        
        nextSubaccountId = await getNextOnChainSubaccountId(wallet.agentPublicKey, updatedDbAllocatedIds);
        console.log(`[Marketplace] On-chain discovery returned subaccount ID: ${nextSubaccountId}`);
      } catch (error) {
        console.error(`[Marketplace] On-chain discovery failed, falling back to database:`, error);
        nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      }

      // Group D item 17d (April 17, 2026): route marketplace subaccount creation
      // through the protocol adapter so the same parse/validate/persist contract
      // as the main bot-creation site applies. The marketplace flow today is
      // Drift-only by construction (it persists `driftSubaccountId`, calls
      // `executeAgentDeposit` which is the Drift deposit path, and uses
      // `discoverOnChainSubaccounts`/`getNextOnChainSubaccountId` which are Drift
      // helpers). Use `getAdapter('drift')` EXPLICITLY rather than the default
      // adapter — defaultAdapter is Pacifica, and PacificaAdapter.createSubaccount
      // requires a generated `subSecretKey` (caps.requiresExternalSubaccountKey=true)
      // which this flow does not produce, so calling the default would always
      // throw and silently fall back, masking real adapter behavior.
      // When marketplace gains cross-protocol bot sharing, the adapter must be
      // selected from the published bot's protocol, not hardcoded here.
      // NOTE: known dbAllocatedIds-awareness gap — DriftAdapter.createSubaccount
      // does not pass updatedDbAllocatedIds through. Same gap exists at the main
      // creation site today. Tracked for a separate cleanup; not introduced here.
      let persistedSubaccountId: number = nextSubaccountId;
      const marketplaceUmkResult = await getUmkForWebhook(req.walletAddress!);
      if (!marketplaceUmkResult) {
        return res.status(403).json({ error: "Execution not enabled. Please enable execution authorization first." });
      }
      const marketplaceAgentKeyResult = await decryptAgentKeyStrict(
        req.walletAddress!,
        marketplaceUmkResult.umk,
        wallet,
        wallet.agentPublicKey
      );
      marketplaceUmkResult.cleanup();
      if (!marketplaceAgentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please sign in again." });
      }
      try {
        const marketplaceAgentSecret = marketplaceAgentKeyResult.secretKey;
        try {
          const { getAdapter } = await import("./protocol/adapter-registry");
          const marketplaceAdapter = getAdapter('drift');
          const marketplaceAgentKeypair = Keypair.fromSecretKey(marketplaceAgentSecret);
          const sub = await marketplaceAdapter.createSubaccount({
            mainSecretKey: marketplaceAgentKeypair.secretKey,
            agentPublicKey: marketplaceAgentKeypair.publicKey.toString(),
          });
          const parsed = parseAndValidateAdapterSubaccountId(sub.subaccountId, marketplaceAdapter.protocolName);
          if (parsed !== nextSubaccountId) {
            console.warn(
              `[Marketplace] Subaccount ID divergence: pre-allocated=${nextSubaccountId}, ` +
              `adapter-returned=${parsed}. Persisting adapter value as canonical (driftSubaccountId=${parsed}).`
            );
          }
          persistedSubaccountId = parsed;
        } catch (subErr: any) {
          console.error(
            `[Marketplace] adapter.createSubaccount failed; falling back to pre-allocated ID ${nextSubaccountId}: ${subErr.message}`
          );
        }

      // Create subscriber's bot with same settings but their own capital (with subaccount ID already set)
      // maxPositionSize = investment × leverage (same as normal bot creation)
      const effectiveLeverage = leverage || originalBot.leverage || 1;
      const maxPositionSize = sizingInvestment * effectiveLeverage;
      // Persist the deposit (capital) and sizing (investment) split so the bot's
      // position-sizing reflects the equity-buffer model consumed by the UI.
      void capitalInvested;
      
      const subscriberBot = await storage.createTradingBot({
        name: `${publishedBot.name} (Copy)`,
        market: originalBot.market,
        walletAddress: req.walletAddress!,
        botType: 'signal',
        maxPositionSize: maxPositionSize.toString(),
        leverage: effectiveLeverage,
        webhookSecret,
        isActive: true,
        sourcePublishedBotId: publishedBot.id,
        driftSubaccountId: persistedSubaccountId,
        subaccountAuthMode: 'main_plus_id',
        // Group D item 18: marketplace subscriber bot creation — Drift-only by
        // construction today (see item 17d comment above for the rationale: this
        // flow uses `getAdapter('drift')` for createSubaccount, persists
        // driftSubaccountId, and calls executeAgentDeposit which is Drift's path).
        activeProtocol: 'drift',
      } as any);
      
      // Deposit USDC from agent wallet directly to the new bot's Drift subaccount
      console.log(`[Marketplace] Depositing $${capitalInvested} from agent wallet to subaccount ${persistedSubaccountId} for subscriber bot`);
      const depositResult = await executeAgentDeposit(
        wallet.agentPublicKey,
        marketplaceAgentSecret,
        capitalInvested,
        persistedSubaccountId,
        getAdapterForBot(subscriberBot),
      );
      
      if (!depositResult.success) {
        // Rollback: delete the created bot
        console.error(`[Marketplace] Deposit failed, rolling back bot creation: ${depositResult.error}`);
        await storage.deleteTradingBot(subscriberBot.id);
        return res.status(500).json({ 
          error: `Failed to fund bot: ${depositResult.error}. Bot creation rolled back.` 
        });
      }
      
      console.log(`[Marketplace] Deposit successful: ${depositResult.signature}`);
      
      // Record the deposit as an equity event
      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId: subscriberBot.id,
        eventType: 'deposit',
        amount: String(capitalInvested),
        txSignature: depositResult.signature || null,
        notes: `Initial deposit for subscription to ${publishedBot.name}`,
      });

      // Create or reactivate subscription record. A previous unsubscribe leaves
      // a 'cancelled' row in place (the publishedBotId + wallet unique
      // constraint blocks a second INSERT), so re-subscribing must reactivate
      // that existing row rather than inserting a new one.
      const subscription = existingSub
        ? await storage.reactivateBotSubscription(existingSub.id, {
            subscriberBotId: subscriberBot.id,
            capitalInvested: capitalInvested.toString(),
          })
        : await storage.createBotSubscription({
            publishedBotId: req.params.id,
            subscriberWalletAddress: req.walletAddress!,
            subscriberBotId: subscriberBot.id,
            capitalInvested: capitalInvested.toString(),
            status: 'active',
          });

      // Update published bot stats
      await storage.incrementPublishedBotSubscribers(req.params.id, 1, capitalInvested);

      console.log(`[Marketplace] ${req.walletAddress} subscribed to ${publishedBot.name} with $${capitalInvested}`);
      res.json({
        subscription,
        tradingBot: subscriberBot,
        webhookUrl: generateWebhookUrl(subscriberBot.id, webhookSecret),
        depositTxSignature: depositResult.signature,
      });
      } finally {
        marketplaceAgentKeyResult.cleanup();
      }
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  // Unsubscribe from a published bot.
  //
  // This is a money-moving teardown, so it runs as an idempotent saga rather
  // than a simple status flip:
  //   1. Validate. Already-cancelled => 200 (absorb retries/double-clicks).
  //   2. If the copy bot has an OPEN position, fail cleanly (409) BEFORE any
  //      mutation so the user closes it first and can safely retry.
  //   3. Settle pending creator profit-share IOUs (same gate as withdraw/delete)
  //      so unsubscribing can't be used to dodge a creator payout.
  //   4. Recover the bot's capital DIRECTLY from its own Drift subaccount to the
  //      agent wallet (NOT the legacy sweep-through-main path that orphaned funds).
  //   5. Deactivate (not delete) the copy bot so its trade/PnL history survives,
  //      close its subaccount to reclaim rent, and null its subaccount link so the
  //      portfolio snapshot job stops trying to read a closed subaccount (which
  //      would otherwise skip the whole wallet's snapshot every cycle).
  //   6. Cancel any queued retry jobs for the bot.
  //   7. Finalize: cancel the subscription row + decrement marketplace stats once.
  // Each step tolerates already-done state so a crash mid-saga is retry-safe.
  app.delete("/api/marketplace/:id/unsubscribe", requireWallet, async (req, res) => {
    try {
      const subscription = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (!subscription) {
        return res.status(404).json({ error: "Subscription not found" });
      }
      // Idempotent: a previous unsubscribe already finalized this row. Return
      // success so retries/duplicate requests don't surface a confusing error.
      if (subscription.status === 'cancelled') {
        return res.json({ success: true, alreadyCancelled: true });
      }

      const capitalInvested = parseFloat(subscription.capitalInvested);
      const subscriberBotId = subscription.subscriberBotId;

      // Finalize helper: cancel the subscription row + decrement published-bot
      // stats. Stats are only decremented when the row was still counted (i.e.
      // not already cancelled), which we guaranteed above.
      const finalize = async () => {
        await storage.cancelBotSubscription(subscription.id);
        await storage.incrementPublishedBotSubscribers(req.params.id, -1, -capitalInvested);
      };

      // No copy bot linked (legacy/partial row) — nothing to recover or tear down.
      const bot = subscriberBotId ? await storage.getTradingBotById(subscriberBotId) : null;
      if (!bot) {
        await finalize();
        console.log(`[Unsubscribe] ${req.walletAddress} unsubscribed from ${req.params.id} (no linked copy bot)`);
        return res.json({ success: true });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Subscriber bot not owned by this wallet" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const hasSubaccount = bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined;
      const subId = hasSubaccount ? (bot.driftSubaccountId as number) : 0;

      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeyResult = await decryptAgentKeyStrict(req.walletAddress!, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        umkResult.cleanup();
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }

      try {
        const agentSecret = agentKeyResult.secretKey;

        // 1. Open-position guard — fail cleanly before mutating anything.
        // Call the adapter DIRECTLY (not getPerpPositions, which swallows errors
        // and returns []), so a data-source outage throws and we fail closed
        // instead of falsely concluding "no open position".
        if (hasSubaccount) {
          let positions: any[];
          try {
            const raw = await getAdapterForBot(bot).getPositions(wallet.agentPublicKey, _subIdStr(subId));
            positions = raw.map(_mapPositionToDrift);
          } catch (posErr: any) {
            console.error(`[Unsubscribe] Position check failed for bot ${bot.id}:`, posErr.message);
            return res.status(502).json({ error: "Couldn't verify the bot's positions right now. Please try again in a moment." });
          }
          const open = positions.find((p: any) => Math.abs(p.baseAssetAmount) > 0.0001);
          if (open) {
            return res.status(409).json({
              code: 'OPEN_POSITION',
              error: `This bot has an open ${open.market} position. Please close it before unsubscribing, then try again.`,
            });
          }
        }

        // 2. Settle pending creator profit-share IOUs (block if unpayable).
        const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(bot.id);
        if (pendingIOUs.length > 0) {
          const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
          console.log(`[Unsubscribe] Bot ${bot.id} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(wallet.agentPublicKey, agentSecret, iou.creatorWalletAddress, iouAmount);
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[Unsubscribe] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              return res.status(400).json({
                error: `Cannot unsubscribe yet — $${totalOwed.toFixed(2)} in creator profit share still needs to be paid. Ensure your agent wallet has enough USDC and SOL for fees, then try again.`,
                pendingIOUs: pendingIOUs.length,
                totalOwed,
              });
            }
          }
        }

        // 3. Recover capital directly from the bot's subaccount to the agent wallet.
        let recoveredAmount = 0;
        let recoverTxSignature: string | null = null;
        const minTransfer = getAdapterForBot(bot).minTransferAmount;
        if (hasSubaccount) {
          let balance = 0;
          try {
            // Adapter direct (not getExchangeBalance, which swallows errors and
            // returns 0): a read failure must NOT look like an empty subaccount,
            // or we'd skip recovery and finalize, stranding the user's capital.
            const info = await getAdapterForBot(bot).getAccountInfo(wallet.agentPublicKey, _subIdStr(subId));
            balance = info.balance;
          } catch (balErr: any) {
            console.error(`[Unsubscribe] Balance read failed for bot ${bot.id} subaccount ${subId}:`, balErr.message);
            return res.status(502).json({ error: "Couldn't read the bot's balance right now. Please try again in a moment." });
          }
          if (balance >= minTransfer) {
            const result = await executeAgentDriftWithdraw(
              wallet.agentPublicKey,
              agentSecret,
              balance,
              subId,
              { tradingBotId: bot.id, context: 'Unsubscribe' },
              getAdapterForBot(bot),
            );
            if (!result.success) {
              return res.status(400).json({ error: result.error || "Failed to recover funds. Nothing was changed — please try again." });
            }
            recoveredAmount = balance;
            recoverTxSignature = result.signature || null;
            if (recoverTxSignature) {
              const existing = await storage.getEquityEventByTxSignature(recoverTxSignature);
              if (!existing) {
                try {
                  await storage.createEquityEvent({
                    walletAddress: req.walletAddress!,
                    tradingBotId: bot.id,
                    eventType: 'drift_withdraw',
                    amount: String(-balance),
                    txSignature: recoverTxSignature,
                    notes: `Capital recovered on unsubscribe`,
                  });
                } catch (eventErr: any) {
                  console.error(`[Unsubscribe] CRITICAL: withdraw succeeded (tx ${recoverTxSignature}) but equity event failed:`, eventErr.message);
                }
              }
            }
            console.log(`[Unsubscribe] Recovered $${balance.toFixed(2)} from bot ${bot.id} subaccount ${subId}`);
          } else if (balance > 0) {
            console.log(`[Unsubscribe] Bot ${bot.id} subaccount balance $${balance.toFixed(6)} below $${minTransfer} minimum — skipping recovery`);
          }
        }

        // 4. Deactivate the bot, close its subaccount, and drop the subaccount link.
        let rentReclaimed = false;
        if (hasSubaccount && subId > 0) {
          // Adapter direct so a listing failure is distinguishable from "gone".
          let exists = false;
          let existCheckFailed = false;
          try {
            const subs = await getAdapterForBot(bot).listSubaccounts(wallet.agentPublicKey);
            exists = subs.some((s: any) => s.subaccountId === String(subId));
          } catch (existErr: any) {
            existCheckFailed = true;
            console.warn(`[Unsubscribe] subaccount existence check failed for ${subId}:`, existErr.message);
          }
          if (exists) {
            try {
              const closeResult = await closeDriftSubaccount(agentSecret, subId, getAdapterForBot(bot));
              if (closeResult.success) {
                rentReclaimed = true;
                console.log(`[Unsubscribe] Closed subaccount ${subId}, rent reclaimed: ${closeResult.signature}`);
              } else {
                console.error(`[Unsubscribe] Subaccount ${subId} close failed: ${closeResult.error}`);
                try {
                  await storage.createOrphanedSubaccount({
                    walletAddress: req.walletAddress!,
                    agentPublicKey: wallet.agentPublicKey,
                    driftSubaccountId: subId,
                    reason: closeResult.error,
                  });
                } catch (orphanErr: any) {
                  console.error(`[Unsubscribe] Failed to track orphaned subaccount ${subId}:`, orphanErr.message);
                }
              }
            } catch (closeErr: any) {
              console.error(`[Unsubscribe] Subaccount ${subId} close threw:`, closeErr.message);
              try {
                await storage.createOrphanedSubaccount({
                  walletAddress: req.walletAddress!,
                  agentPublicKey: wallet.agentPublicKey,
                  driftSubaccountId: subId,
                  reason: closeErr.message,
                });
              } catch {}
            }
          } else if (existCheckFailed) {
            // Couldn't confirm whether the subaccount is gone. Capital was
            // already recovered (fail-closed above), but we're about to null the
            // link below — so record the subaccount to reclaim its rent later
            // instead of silently losing the reference.
            try {
              await storage.createOrphanedSubaccount({
                walletAddress: req.walletAddress!,
                agentPublicKey: wallet.agentPublicKey,
                driftSubaccountId: subId,
                reason: 'Existence check failed during unsubscribe',
              });
            } catch (orphanErr: any) {
              console.error(`[Unsubscribe] Failed to track unverified subaccount ${subId}:`, orphanErr.message);
            }
          }
        }

        // Null the subaccount link so the snapshot job stops reading a dead
        // subaccount (prevents skipping the whole wallet's snapshot).
        await storage.clearTradingBotSubaccount(bot.id);
        await storage.updateTradingBot(bot.id, {
          isActive: false,
          executionActive: false,
          pauseReason: 'Unsubscribed from marketplace',
        });

        // 5. Cancel any queued retry jobs so none fire on the closed subaccount.
        try {
          await cancelRetryJobsForBot(bot.id);
        } catch (retryErr: any) {
          console.warn(`[Unsubscribe] Failed to cancel retry jobs for bot ${bot.id}:`, retryErr.message);
        }

        // 6. Finalize the subscription + marketplace stats.
        await finalize();

        console.log(`[Unsubscribe] ${req.walletAddress} unsubscribed from ${req.params.id}; recovered $${recoveredAmount.toFixed(2)}, bot ${bot.id} deactivated`);
        let message = 'Unsubscribed. Your bot was stopped and kept for your records.';
        if (recoveredAmount > 0) {
          message = `Unsubscribed. $${recoveredAmount.toFixed(2)} was returned to your wallet`;
          message += rentReclaimed ? ' and the trading account was closed.' : '.';
        }
        return res.json({
          success: true,
          recovered: recoveredAmount > 0,
          recoveredAmount,
          recoverTxSignature,
          rentReclaimed,
          message,
        });
      } finally {
        agentKeyResult.cleanup();
        umkResult.cleanup();
      }
    } catch (error) {
      console.error("Unsubscribe error:", error);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  // Get user's subscriptions
  app.get("/api/my-subscriptions", requireWallet, async (req, res) => {
    try {
      const subscriptions = await storage.getBotSubscriptionsByWallet(req.walletAddress!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Failed to fetch subscriptions" });
    }
  });

  // Check if a trading bot is published
  app.get("/api/trading-bots/:id/published", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotByTradingBotId(req.params.id);
      res.json({ 
        isPublished: !!publishedBot && publishedBot.isActive,
        publishedBot: publishedBot || null,
      });
    } catch (error) {
      console.error("Check published error:", error);
      res.status(500).json({ error: "Failed to check published status" });
    }
  });

  // Debug endpoint to diagnose subscriber routing issues
  app.get("/api/debug/subscriber-routing/:tradingBotId", requireWallet, async (req, res) => {
    try {
      const tradingBotId = req.params.tradingBotId;
      
      // Step 1: Check if the trading bot exists
      const tradingBot = await storage.getTradingBotById(tradingBotId);
      if (!tradingBot) {
        return res.json({
          success: false,
          step: "trading_bot_lookup",
          error: "Trading bot not found",
          tradingBotId,
        });
      }

      // Step 2: Check if this bot is published
      const publishedBot = await storage.getPublishedBotByTradingBotId(tradingBotId);
      if (!publishedBot) {
        return res.json({
          success: false,
          step: "published_bot_lookup",
          error: "This trading bot is not published to the marketplace",
          tradingBot: { id: tradingBot.id, name: tradingBot.name },
        });
      }

      // Step 3: Check if published bot is active
      if (!publishedBot.isActive) {
        return res.json({
          success: false,
          step: "published_bot_active",
          error: "Published bot is INACTIVE - signals will not route to subscribers",
          publishedBot: { id: publishedBot.id, name: publishedBot.name, isActive: publishedBot.isActive },
        });
      }

      // Step 4: Get all subscriptions for this published bot
      const subscriptions = await storage.getBotSubscriptionsByPublishedBot(publishedBot.id);
      
      // Step 5: Get subscriber bots using the same query as routeSignalToSubscribers
      const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);

      res.json({
        success: true,
        tradingBot: { id: tradingBot.id, name: tradingBot.name, market: tradingBot.market },
        publishedBot: { 
          id: publishedBot.id, 
          name: publishedBot.name, 
          isActive: publishedBot.isActive,
          subscriberCount: publishedBot.subscriberCount,
        },
        subscriptions: subscriptions.map(s => ({
          id: s.id,
          status: s.status,
          subscriberWalletAddress: s.subscriberWalletAddress,
          subscriberBotId: s.subscriberBotId,
          capitalInvested: s.capitalInvested,
        })),
        subscriberBotsFromQuery: subscriberBots.map(b => ({
          id: b.id,
          name: b.name,
          isActive: b.isActive,
          sourcePublishedBotId: b.sourcePublishedBotId,
          walletAddress: b.walletAddress,
        })),
        diagnosis: subscriberBots.length === 0 
          ? "No subscriber bots found - check if subscriptions exist and are active"
          : `Found ${subscriberBots.length} active subscriber bot(s) ready to receive signals`,
      });
    } catch (error) {
      console.error("Debug subscriber routing error:", error);
      res.status(500).json({ error: "Failed to debug subscriber routing" });
    }
  });

  // ==================== TELEGRAM INTEGRATION ====================

  // Generate a connection token and return deep link for Telegram
  app.post("/api/telegram/connect", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;

      // Be lenient about what the operator pastes into TELEGRAM_BOT_USERNAME:
      // accept `Foo`, `@Foo`, or even the full `https://t.me/Foo` URL.
      const rawUsername = process.env.TELEGRAM_BOT_USERNAME;
      if (!rawUsername) {
        return res.status(503).json({ error: "Telegram bot is not configured on the server." });
      }
      const botUsername = rawUsername
        .trim()
        .replace(/^https?:\/\/t\.me\//i, '')
        .replace(/^@/, '')
        .replace(/\/.*$/, '');

      // Generate a random 32-character token
      const token = crypto.randomBytes(16).toString('hex');

      // Set expiry to 15 minutes from now
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      // Delete any existing tokens for this wallet
      await storage.deleteExpiredTelegramTokens();

      // Create new token
      await storage.createTelegramConnectionToken({
        walletAddress,
        token,
        expiresAt,
      });

      // Generate deep link
      const deepLink = `https://t.me/${botUsername}?start=${token}`;

      // Generate QR code as data URL for desktop scanning
      let qrCodeDataUrl: string | null = null;
      try {
        const QRCode = (await import('qrcode')).default;
        qrCodeDataUrl = await QRCode.toDataURL(deepLink, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 256,
        });
      } catch (qrErr) {
        console.error('[Telegram] Failed to generate QR code:', qrErr);
      }

      console.log(`[Telegram] Generated connection token for ${walletAddress}, expires at ${expiresAt.toISOString()}`);

      res.json({
        success: true,
        deepLink,
        qrCodeDataUrl,
        botUsername,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      console.error("[Telegram] Connect error:", error);
      res.status(500).json({ error: "Failed to generate Telegram connection link" });
    }
  });

  // Webhook endpoint for Telegram bot updates
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      // Verify the webhook secret token. Per Telegram convention we always
      // return 200 so they don't retry, but we silently ignore any payload
      // that doesn't carry the expected secret header.
      const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      const providedSecret = req.header('x-telegram-bot-api-secret-token');
      if (!expectedSecret || providedSecret !== expectedSecret) {
        console.warn('[Telegram] Webhook called with missing/invalid secret token — ignoring payload');
        return res.json({ ok: true });
      }

      const update = req.body;

      // Callback_query handler (Task #136): inline-keyboard taps from
      // notifications and /menu route through here. Always answer the
      // callback (even on failure) so Telegram clears the spinner.
      const cb = update?.callback_query;
      if (cb && cb.data) {
        const cbChatId = cb.message?.chat?.id?.toString();
        const cbData: string = cb.data;
        const ack = async () => {
          try {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id }),
            });
          } catch (err) {
            console.error('[Telegram] answerCallbackQuery failed:', err);
          }
        };
        try {
          if (cbChatId && (cbData === 'nav:positions' || cbData === 'nav:today')) {
            const linked = await storage.getWalletsByTelegramChatId(cbChatId);
            if (linked.length === 0) {
              await sendTelegramResponse(cbChatId, "ℹ️ No QuantumVault wallets are linked to this chat.");
            } else {
              const addrs = linked.map(w => w.address);
              if (cbData === 'nav:positions') {
                const { buildStatsForChat, formatPositionsMessage } = await import("./telegram-summary");
                const stats = await buildStatsForChat(addrs);
                await sendTelegramResponse(cbChatId, formatPositionsMessage(stats), buildDefaultInlineKeyboard());
              } else {
                const { buildTodayStatsForChat, formatTodayMessage } = await import("./telegram-summary");
                const stats = await buildTodayStatsForChat(addrs);
                await sendTelegramResponse(cbChatId, formatTodayMessage(stats), buildDefaultInlineKeyboard());
              }
            }
          }
        } catch (err: any) {
          console.error('[Telegram] callback_query handler failed:', err?.message || err);
        } finally {
          await ack();
        }
        return res.json({ ok: true });
      }

      const message = update?.message;
      const text: string | undefined = message?.text;

      if (!message || !text) {
        return res.json({ ok: true });
      }

      const chatId = message.chat.id.toString();

      // /start [token]
      if (text.startsWith('/start')) {
        const parts = text.split(/\s+/);

        if (parts.length >= 2) {
          const token = parts[1];

          console.log(`[Telegram] Received /start with token ${token.substring(0, 8)}... from chat ${chatId}`);

          const connectionToken = await storage.getTelegramConnectionTokenByToken(token);

          if (!connectionToken) {
            await sendTelegramResponse(chatId, "❌ Invalid or expired connection link. Please generate a new one from QuantumVault.");
            return res.json({ ok: true });
          }

          if (new Date() > connectionToken.expiresAt) {
            await storage.deleteTelegramConnectionToken(connectionToken.id);
            await sendTelegramResponse(chatId, "❌ This connection link has expired. Please generate a new one from QuantumVault.");
            return res.json({ ok: true });
          }

          await storage.updateWallet(connectionToken.walletAddress, {
            telegramConnected: true,
            telegramChatId: chatId,
            notificationsEnabled: true,
          });

          await storage.deleteTelegramConnectionToken(connectionToken.id);

          console.log(`[Telegram] Successfully linked chat ${chatId} to wallet ${connectionToken.walletAddress}`);

          const truncated = truncateAddress(connectionToken.walletAddress);
          await sendTelegramResponse(chatId,
            "✅ <b>Connected to QuantumVault!</b>\n\n" +
            `Linked wallet: <code>${truncated}</code>\n\n` +
            "You will receive alerts for trade executions, failed trades, and position closures.\n\n" +
            "Tip: you can link this same Telegram to additional QuantumVault accounts by repeating the flow from each account.\n\n" +
            "Send /help to see available commands."
          );
        } else {
          await sendTelegramResponse(chatId,
            "👋 <b>Welcome to QuantumVault!</b>\n\n" +
            "To link your wallet, open QuantumVault → Settings → Notifications and tap <b>Connect Telegram</b>.\n\n" +
            "Send /help to see available commands."
          );
        }
        return res.json({ ok: true });
      }

      // /help
      if (text.startsWith('/help')) {
        await sendTelegramResponse(chatId,
          "<b>QuantumVault commands</b>\n\n" +
          "/menu — quick action menu with Mini App button\n" +
          "/summary — daily snapshot for every linked wallet\n" +
          "/positions — just your open positions\n" +
          "/today — today's trades and realized PnL\n" +
          "/status — connection status\n" +
          "/accounts — list linked wallets\n" +
          "/disconnect — unlink every wallet from this chat\n" +
          "/help — show this message\n\n" +
          "Turn on the <b>Daily summary</b> toggle in Settings → Notifications to receive /summary as a push once a day."
        );
        return res.json({ ok: true });
      }

      // /menu — quick action menu (Task #136). Shows the standard inline
      // keyboard so the user can tap into the Mini App or pull a fresh
      // summary without typing commands.
      if (text.startsWith('/menu')) {
        const linked = await storage.getWalletsByTelegramChatId(chatId);
        const header = linked.length === 0
          ? "ℹ️ This chat isn't linked to any QuantumVault wallet yet.\n\nOpen QuantumVault → Settings → Notifications → Connect Telegram to link one."
          : `<b>QuantumVault</b>\n\nLinked wallets: ${linked.length}\n\nTap a button below or open the Mini App for the full dashboard.`;
        await sendTelegramResponse(chatId, header, buildDefaultInlineKeyboard());
        return res.json({ ok: true });
      }

      // /status
      if (text.startsWith('/status')) {
        const wallets = await storage.getWalletsByTelegramChatId(chatId);
        if (wallets.length === 0) {
          await sendTelegramResponse(chatId,
            "ℹ️ This chat isn't linked to any QuantumVault wallet yet.\n\n" +
            "Open QuantumVault → Settings → Notifications → Connect Telegram to link one."
          );
        } else {
          const lines = wallets.map(w => {
            const types: string[] = [];
            if (w.notifyTradeExecuted) types.push('executions');
            if (w.notifyTradeFailed) types.push('failures');
            if (w.notifyPositionClosed) types.push('closes');
            const status = w.notificationsEnabled && types.length > 0
              ? `alerts on (${types.join(', ')})`
              : '⚠️ alerts off';
            return `• <code>${truncateAddress(w.address)}</code> — ${status}`;
          });
          await sendTelegramResponse(chatId,
            `<b>Linked wallets (${wallets.length})</b>\n\n${lines.join('\n')}`
          );
        }
        return res.json({ ok: true });
      }

      // /accounts
      if (text.startsWith('/accounts')) {
        const wallets = await storage.getWalletsByTelegramChatId(chatId);
        if (wallets.length === 0) {
          await sendTelegramResponse(chatId, "ℹ️ No QuantumVault wallets are linked to this chat.");
        } else {
          const lines = wallets.map(w => {
            const since = w.lastSeen ? new Date(w.lastSeen).toISOString().slice(0, 10) : 'unknown';
            return `• <code>${truncateAddress(w.address)}</code> — linked (last seen ${since})`;
          });
          await sendTelegramResponse(chatId,
            `<b>Linked QuantumVault wallets</b>\n\n${lines.join('\n')}\n\n` +
            "Send /disconnect to unlink them all from this chat."
          );
        }
        return res.json({ ok: true });
      }

      // /summary — full daily snapshot for every linked wallet
      if (text.startsWith('/summary')) {
        const linked = await storage.getWalletsByTelegramChatId(chatId);
        if (linked.length === 0) {
          await sendTelegramResponse(chatId,
            "ℹ️ This chat isn't linked to any QuantumVault wallet yet.\n\n" +
            "Open QuantumVault → Settings → Notifications → Connect Telegram to link one."
          );
          return res.json({ ok: true });
        }
        const { buildStatsForChat, formatSummaryMessage } = await import("./telegram-summary");
        const stats = await buildStatsForChat(linked.map(w => w.address));
        await sendTelegramResponse(chatId, formatSummaryMessage(stats), buildDefaultInlineKeyboard());
        return res.json({ ok: true });
      }

      // /positions — just open positions across linked wallets
      if (text.startsWith('/positions')) {
        const linked = await storage.getWalletsByTelegramChatId(chatId);
        if (linked.length === 0) {
          await sendTelegramResponse(chatId, "ℹ️ No QuantumVault wallets are linked to this chat.");
          return res.json({ ok: true });
        }
        const { buildStatsForChat, formatPositionsMessage } = await import("./telegram-summary");
        const stats = await buildStatsForChat(linked.map(w => w.address));
        await sendTelegramResponse(chatId, formatPositionsMessage(stats), buildDefaultInlineKeyboard());
        return res.json({ ok: true });
      }

      // /today — last 24h activity (trades + realized PnL + win/loss)
      if (text.startsWith('/today')) {
        const linked = await storage.getWalletsByTelegramChatId(chatId);
        if (linked.length === 0) {
          await sendTelegramResponse(chatId, "ℹ️ No QuantumVault wallets are linked to this chat.");
          return res.json({ ok: true });
        }
        const { buildTodayStatsForChat, formatTodayMessage } = await import("./telegram-summary");
        const stats = await buildTodayStatsForChat(linked.map(w => w.address));
        await sendTelegramResponse(chatId, formatTodayMessage(stats), buildDefaultInlineKeyboard());
        return res.json({ ok: true });
      }

      // /disconnect — unlink every wallet pointing at this chat
      if (text.startsWith('/disconnect')) {
        const wallets = await storage.getWalletsByTelegramChatId(chatId);
        if (wallets.length === 0) {
          await sendTelegramResponse(chatId, "ℹ️ No QuantumVault wallets are linked to this chat.");
          return res.json({ ok: true });
        }
        for (const w of wallets) {
          await storage.updateWallet(w.address, {
            telegramConnected: false,
            telegramChatId: null,
            notificationsEnabled: false,
          });
        }
        const list = wallets.map(w => `• <code>${truncateAddress(w.address)}</code>`).join('\n');
        await sendTelegramResponse(chatId,
          `🔌 <b>Disconnected ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}</b>\n\n${list}\n\n` +
          "You will no longer receive QuantumVault alerts in this chat."
        );
        return res.json({ ok: true });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("[Telegram] Webhook error:", error);
      res.json({ ok: true }); // Always return ok to Telegram
    }
  });

  // Get retry queue status (for monitoring rate-limited trade retries)
  app.get("/api/retry-queue/status", requireWallet, async (req, res) => {
    try {
      const status = getQueueStatus();
      res.json(status);
    } catch (error) {
      console.error("[RetryQueue] Status check error:", error);
      res.status(500).json({ error: "Failed to check retry queue status" });
    }
  });

  // Check Telegram connection status
  app.get("/api/telegram/status", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);

      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      res.json({
        connected: wallet.telegramConnected || false,
        hasChatId: !!wallet.telegramChatId,
        notificationsEnabled: wallet.notificationsEnabled || false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
      });
    } catch (error) {
      console.error("[Telegram] Status check error:", error);
      res.status(500).json({ error: "Failed to check Telegram status" });
    }
  });

  // Send a sample message to the user's linked Telegram chat
  app.post("/api/telegram/test-notification", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);

      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.telegramChatId) {
        return res.status(400).json({ error: "Telegram is not connected for this wallet." });
      }

      const enabled: string[] = [];
      const disabled: string[] = [];
      (wallet.notifyTradeExecuted ? enabled : disabled).push('Trade executed');
      (wallet.notifyTradeFailed ? enabled : disabled).push('Trade failed');
      (wallet.notifyPositionClosed ? enabled : disabled).push('Position closed');

      const masterOff = !wallet.notificationsEnabled;
      const truncated = truncateAddress(wallet.address);

      let body =
        "🧪 <b>QuantumVault test notification</b>\n\n" +
        `Wallet: <code>${truncated}</code>\n\n` +
        "If you're seeing this, your Telegram connection is working.";

      if (masterOff) {
        body += "\n\n⚠️ <b>Notifications are turned off</b> for this wallet — real alerts won't be sent until you re-enable them in Settings.";
      } else if (disabled.length > 0) {
        body += `\n\n⚠️ These alert types are <b>off</b> and won't reach you: ${disabled.join(', ')}.`;
      }
      if (!masterOff && enabled.length > 0) {
        body += `\n\nActive alert types: ${enabled.join(', ')}.`;
      }

      const ok = await sendTelegramResponse(wallet.telegramChatId, body);
      if (!ok) {
        return res.status(502).json({ error: "Failed to deliver test message to Telegram." });
      }

      res.json({ success: true, masterOff, enabled, disabled });
    } catch (error) {
      console.error("[Telegram] Test notification error:", error);
      res.status(500).json({ error: "Failed to send test notification" });
    }
  });

  // Retry a failed trade
  app.post("/api/trades/:tradeId/retry", requireWallet, async (req, res) => {
    try {
      const { tradeId } = req.params;
      const walletAddress = req.walletAddress!;
      
      // Get the failed trade
      const trade = await storage.getBotTrade(tradeId);
      
      if (!trade) {
        return res.status(404).json({ error: "Trade not found" });
      }
      
      if (trade.walletAddress !== walletAddress) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (trade.status !== 'failed') {
        return res.status(400).json({ error: "Only failed trades can be retried" });
      }
      
      // Get the bot and wallet
      const bots = await storage.getTradingBots(walletAddress);
      const bot = bots.find(b => b.id === trade.tradingBotId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      
      // Additional validations
      if (!bot.isActive) {
        return res.status(400).json({ error: "Cannot retry - bot is paused" });
      }
      
      // Check trade is not too old (24 hours max)
      const tradeAge = Date.now() - new Date(trade.executedAt).getTime();
      const MAX_RETRY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
      if (tradeAge > MAX_RETRY_AGE_MS) {
        return res.status(400).json({ error: "Cannot retry trades older than 24 hours" });
      }
      
      // Verify trade market matches bot's configured market
      if (trade.market && bot.market && trade.market !== bot.market) {
        return res.status(400).json({ error: "Trade market doesn't match bot configuration" });
      }
      
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      
      // Check execution authorization
      if (!wallet.executionEnabled || wallet.emergencyStopTriggered) {
        return res.status(403).json({ error: "Execution not authorized. Please enable execution first." });
      }

      const retryUmkResult = await getUmkForWebhook(walletAddress);
      if (!retryUmkResult) {
        return res.status(403).json({ error: "Execution not enabled. Please enable execution authorization first." });
      }
      const retryAgentKeyResult = await decryptAgentKeyStrict(walletAddress, retryUmkResult.umk, wallet, wallet.agentPublicKey);
      retryUmkResult.cleanup();
      if (!retryAgentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please sign in again." });
      }
      try {
      const retryAgentSecret = retryAgentKeyResult.secretKey;
      
      // Determine the side from the original trade
      const side = trade.side?.toUpperCase();
      if (!side || side === 'CLOSE') {
        return res.status(400).json({ error: "Cannot retry close orders - position may have changed" });
      }
      
      const isLong = side === 'LONG';
      const market = trade.market;
      const size = parseFloat(trade.size?.toString() || '0');
      
      if (size <= 0) {
        return res.status(400).json({ error: "Invalid trade size" });
      }
      
      console.log(`[Retry Trade] Retrying ${side} ${market} x${size} for bot ${bot.name}`);
      
      // Check if auto top-up is needed before retrying
      // SIMPLE FORMULA: deposit needed = target equity - current equity
      // Target equity = maxPositionSize / leverage (investment amount user set)
      const subAccountId = bot.driftSubaccountId ?? 0;
      const baseCapital = parseFloat(bot.maxPositionSize?.toString() || '0'); // This is leveraged position size
      const effectiveLeverage = Math.min(Number(bot.leverage) || 10, getMarketMaxLeverage(market) || 10);
      const targetEquity = baseCapital / effectiveLeverage; // The investment amount user wants
      
      const retryBotCtxForTopUp = getBotSubaccountContext(bot);
      if (bot.autoTopUp && targetEquity > 0) {
        try {
          const accountInfo = await getExchangeAccountInfoForBot(wallet.agentPublicKey!, subAccountId, retryBotCtxForTopUp, getAdapterForBot(bot));
          const currentEquity = Math.max(0, accountInfo.freeCollateral);
          const topUpNeeded = Math.max(0, targetEquity - currentEquity);
          
          console.log(`[Retry Trade] Auto top-up: current equity $${currentEquity.toFixed(2)}, target equity $${targetEquity.toFixed(2)}, need $${topUpNeeded.toFixed(2)}`);
          
          if (topUpNeeded > 0) {
            if (retryBotCtxForTopUp) {
              const adapter = getAdapterForBot(bot);
              const agentKeypairForTopUp = Keypair.fromSecretKey(retryAgentSecret);
              const depositAmount = Math.ceil(topUpNeeded * 100) / 100;
              if (depositAmount < adapter.minTransferAmount) {
                console.log(`[Retry Trade] Auto top-up skipped: $${depositAmount.toFixed(2)} below ${adapter.protocolName} $${adapter.minTransferAmount} minimum transfer`);
              } else {
              const agentMainInfo = await getExchangeAccountInfo(wallet.agentPublicKey!, 0, adapter);
              if (agentMainInfo.freeCollateral >= depositAmount) {
                const transferResult = await adapter.transferBetweenSubaccounts({
                  agentSecretKey: agentKeypairForTopUp.secretKey,
                  mainWalletAddress: agentKeypairForTopUp.publicKey.toString(),
                  fromSubaccountId: agentKeypairForTopUp.publicKey.toString(),
                  toSubaccountId: retryBotCtxForTopUp.botPublicKey,
                  amount: depositAmount,
                });
                if (transferResult.success) {
                  console.log(`[Retry Trade] Auto top-up transfer successful: $${depositAmount.toFixed(2)}`);
                  await storage.createEquityEvent({
                    walletAddress,
                    tradingBotId: bot.id,
                    eventType: 'auto_topup',
                    amount: String(depositAmount),
                    txSignature: null,
                    notes: `Retry top-up transfer: agent→${retryBotCtxForTopUp.botPublicKey.slice(0,8)}... $${depositAmount.toFixed(2)}`,
                  });
                } else {
                  console.log(`[Retry Trade] Auto top-up transfer failed: ${transferResult.error}`);
                }
              } else {
                console.log(`[Retry Trade] Agent main insufficient for top-up ($${agentMainInfo.freeCollateral.toFixed(2)} < $${depositAmount.toFixed(2)})`);
              }
              }
            } else {
            const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
            console.log(`[Retry Trade] Agent wallet: $${agentUsdcBalance.toFixed(2)}, need: $${topUpNeeded.toFixed(2)}`);
            
            if (agentUsdcBalance >= topUpNeeded) {
              const depositAmount = Math.ceil(topUpNeeded * 100) / 100;
              const depositResult = await executeAgentDeposit(
                wallet.agentPublicKey!,
                retryAgentSecret,
                depositAmount,
                subAccountId,
                getAdapterForBot(bot),
              );
              
              if (depositResult.success) {
                console.log(`[Retry Trade] Auto top-up successful: deposited $${depositAmount.toFixed(2)} (equity $${currentEquity.toFixed(2)} → $${(currentEquity + depositAmount).toFixed(2)}), tx: ${depositResult.signature}`);
                
                await storage.createEquityEvent({
                  walletAddress,
                  tradingBotId: bot.id,
                  eventType: 'auto_topup',
                  amount: String(depositAmount),
                  txSignature: depositResult.signature || null,
                  notes: `Auto top-up for retry: equity $${currentEquity.toFixed(2)} → $${(currentEquity + depositAmount).toFixed(2)} for $${baseCapital.toFixed(2)} position`,
                });
              } else {
                console.log(`[Retry Trade] Auto top-up failed: ${depositResult.error}`);
              }
            } else {
              console.log(`[Retry Trade] Agent wallet insufficient for top-up ($${agentUsdcBalance.toFixed(2)} < $${topUpNeeded.toFixed(2)})`);
            }
            }
          }
        } catch (topUpErr: any) {
          console.log(`[Retry Trade] Auto top-up check error: ${topUpErr.message}`);
        }
      }
      
      const retryBotCtx = getBotSubaccountContext(bot);
      const agentKeypair = Keypair.fromSecretKey(retryAgentSecret);
      const bs58 = await import('bs58');
      const privateKeyBase58 = bs58.default.encode(agentKeypair.secretKey);
      
      const result = await executePerpOrder(
        retryAgentSecret,
        market,
        isLong ? 'long' : 'short',
        size,
        retryBotCtx ? 0 : (bot.driftSubaccountId ?? 0),
        false,
        wallet.slippageBps ?? 50,
        privateKeyBase58,
        wallet.agentPublicKey ?? undefined,
        undefined,
        retryBotCtx,
        walletAddress,
        getAdapterForBot(bot),
      );
      
      if (result.success) {
        // Get fill price for trade record
        const fillPrice = result.fillPrice || 0;
        
        // Estimate fee (0.05% taker fee)
        const notionalValue = size * fillPrice;
        const estimatedFee = notionalValue * getExchangeFeeRate();
        
        // Create a new trade record for the retry
        const newTrade = await storage.createBotTrade({
          tradingBotId: bot.id,
          walletAddress,
          market,
          side,
          size: size.toString(),
          price: fillPrice.toString(),
          fee: estimatedFee.toString(),
          status: 'executed',
          txSignature: result.signature || result.txSignature,
          webhookPayload: { retryOf: tradeId },
          executionMethod: result.executionMethod || 'legacy',
          swiftOrderId: result.swiftOrderId || null,
        });
        
        console.log(`[Retry Trade] Success! New trade ID: ${newTrade.id}, tx: ${result.signature || result.txSignature}`);
        
        // CRITICAL: Sync position from on-chain to update entry price in database
        // This ensures PnL calculations use the actual on-chain entry price, not stale data
        try {
          await syncPositionFromOnChain(
            bot.id,
            walletAddress,
            wallet.agentPublicKey!,
            bot.driftSubaccountId ?? 0,
            market,
            newTrade.id,
            estimatedFee,
            fillPrice,
            side.toLowerCase() as 'long' | 'short',
            size,
            retryBotCtx?.botPublicKey
          );
          console.log(`[Retry Trade] Position synced from on-chain with correct entry price`);
        } catch (syncErr) {
          console.warn(`[Retry Trade] Position sync failed (non-critical):`, syncErr);
        }
        
        res.json({
          success: true,
          message: "Trade executed successfully",
          tradeId: newTrade.id,
          txSignature: result.signature || result.txSignature,
          fillPrice,
        });
      } else {
        console.error(`[Retry Trade] Failed:`, result.error);
        res.status(500).json({
          success: false,
          error: result.error || "Trade execution failed",
        });
      }
      } finally {
        retryAgentKeyResult.cleanup();
      }
    } catch (error) {
      console.error("[Retry Trade] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to retry trade" });
    }
  });

  // Disconnect Telegram
  app.post("/api/telegram/disconnect", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;

      // Capture the chat ID before we clear it so we can tell the user which
      // specific wallet just got unlinked (a chat may still be linked to
      // other QuantumVault accounts).
      const existing = await storage.getWallet(walletAddress);
      const previousChatId = existing?.telegramChatId ?? null;

      await storage.updateWallet(walletAddress, {
        telegramConnected: false,
        telegramChatId: null,
        notificationsEnabled: false,
      });

      if (previousChatId) {
        try {
          const remaining = await storage.getWalletsByTelegramChatId(previousChatId);
          const truncated = truncateAddress(walletAddress);
          const tail = remaining.length > 0
            ? `\n\n${remaining.length} other QuantumVault wallet${remaining.length === 1 ? '' : 's'} ${remaining.length === 1 ? 'is' : 'are'} still linked to this chat.`
            : '\n\nNo other QuantumVault wallets are linked to this chat.';
          await sendTelegramResponse(previousChatId,
            `🔌 <b>Wallet unlinked from QuantumVault</b>\n\nWallet: <code>${truncated}</code>${tail}`
          );
        } catch (notifyErr) {
          console.error('[Telegram] Failed to send disconnect notice:', notifyErr);
        }
      }

      console.log(`[Telegram] Disconnected for wallet ${walletAddress}`);

      res.json({ success: true });
    } catch (error) {
      console.error("[Telegram] Disconnect error:", error);
      res.status(500).json({ error: "Failed to disconnect Telegram" });
    }
  });

  // Debug endpoint to close positions by subaccount directly (for dust cleanup)
  // This is useful when a bot is deleted but positions remain on-chain
  app.post("/api/debug/close-subaccount-position", requireWallet, async (req, res) => {
    console.log(`[Debug] *** CLOSE SUBACCOUNT POSITION REQUEST ***`);
    try {
      const { subAccountId, market } = req.body;
      
      if (typeof subAccountId !== 'number' || !market) {
        return res.status(400).json({ error: "Missing required fields: subAccountId (number), market (string)" });
      }
      
      if (!req.walletAddress) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }
      
      console.log(`[Debug] Closing position on ${market} in subaccount ${subAccountId} for wallet ${wallet.agentPublicKey}`);
      
      const slippageBps = wallet.slippageBps ?? 100;

      const debugUmkResult = await getUmkForWebhook(req.walletAddress);
      if (!debugUmkResult) {
        return res.status(403).json({ error: "Execution not enabled. Please enable execution authorization first." });
      }
      const debugAgentKeyResult = await decryptAgentKeyStrict(req.walletAddress, debugUmkResult.umk, wallet, wallet.agentPublicKey);
      debugUmkResult.cleanup();
      if (!debugAgentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please sign in again." });
      }
      let result;
      try {
        result = await closePerpPosition(
          debugAgentKeyResult.secretKey,
          market,
          subAccountId,
          undefined,
          slippageBps
        );
      } finally {
        debugAgentKeyResult.cleanup();
      }
      
      console.log(`[Debug] Close result:`, result);
      
      if (result.success) {
        res.json({
          success: true,
          message: result.signature ? `Position closed successfully` : "Position was already closed",
          signature: result.signature || null,
          subAccountId,
          market
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || "Failed to close position",
          subAccountId,
          market
        });
      }
    } catch (error) {
      console.error("[Debug] Close subaccount position error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    }
  });

  // Portfolio Performance endpoint - True P&L tracking
  app.get("/api/portfolio-performance", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      // Get current live data
      const wallet = await storage.getWallet(walletAddress);
      const bots = await storage.getTradingBots(walletAddress);

      // Task 119: use the SAME balance aggregator as the snapshot writer, so
      // the leaderboard (which reads stored snapshot fields) and the live
      // portfolio endpoint are guaranteed to agree on currentBalance/netPnl/%.
      const { computeWalletTotalBalance } = await import('./portfolio-snapshot-job');
      // Live endpoint best-effort: a partial balance (one bot's read failed)
      // is still useful to render — we only refuse to PERSIST a partial total
      // (that's the snapshot writer's job).
      const { totalBalance: currentBalance, activeBotCount } = await computeWalletTotalBalance(walletAddress);

      // Backfill any deposits the client-side confirmation missed before reading totals.
      // Cached per-wallet for 5 minutes inside the reconciler so this stays cheap.
      await reconcileWalletDeposits(walletAddress);

      // Get cumulative external deposits and withdrawals (Task 119: this now
      // explicitly excludes internal transfers like auto-topup/reinvest).
      const { deposits, withdrawals } = await storage.getWalletCumulativeDepositsWithdrawals(walletAddress);

      // Task 119: trading P&L $ is flow-neutral by construction:
      //   currentBalance - (cumulativeExternalDeposits - cumulativeExternalWithdrawals)
      const netPnl = currentBalance - deposits + withdrawals;
      
      // Get trade stats
      const { totalTrades, totalVolume } = await storage.getWalletTradeStats(walletAddress);
      
      // Get creator earnings from profit sharing
      const creatorEarnings = await storage.getWalletCreatorEarnings(walletAddress);
      
      // Determine lookback window from `range` query param
      const validRanges = ['7d', '1m', '3m', '12m', 'all'] as const;
      type RangeParam = typeof validRanges[number];
      const rawRange = (req.query.range as string | undefined)?.toLowerCase();
      const rangeParam: RangeParam = (validRanges as readonly string[]).includes(rawRange ?? '') ? (rawRange as RangeParam) : '3m';
      let sinceDate: Date | undefined;
      const now = new Date();
      if (rangeParam === '7d') {
        sinceDate = new Date(now);
        sinceDate.setDate(sinceDate.getDate() - 7);
      } else if (rangeParam === '1m') {
        sinceDate = new Date(now);
        sinceDate.setDate(sinceDate.getDate() - 30);
      } else if (rangeParam === '3m') {
        sinceDate = new Date(now);
        sinceDate.setDate(sinceDate.getDate() - 90);
      } else if (rangeParam === '12m') {
        sinceDate = new Date(now);
        sinceDate.setDate(sinceDate.getDate() - 365);
      } else {
        // 'all' — no floor
        sinceDate = undefined;
      }

      // Get historical snapshots for chart
      const snapshots = await storage.getPortfolioDailySnapshots(walletAddress, sinceDate);
      
      // Build chart data from snapshots with pnlPercent for % view
      const chartData: { date: Date; netPnl: number; pnlPercent: number; balance: number }[] = [];
      
      // Add a zero-point anchor one calendar day before the first snapshot so the
      // chart starts where real data begins (avoids a long flat $0 line going back
      // to the wallet's first-deposit date when activity is much more recent).
      // Only add the anchor when it would fall within the selected range window —
      // for tight ranges (e.g. 7D) the anchor must not precede sinceDate.
      // Task 119: gate out pre-migration (Drift era) history. The protocol
      // adapter architecture landed 2026-04-14; anything before that is from
      // a different system and should not appear on the chart.
      const MIGRATION_CUTOFF = new Date('2026-04-14T00:00:00Z');
      const visibleSnapshots = snapshots.filter(s => s.snapshotDate >= MIGRATION_CUTOFF);

      // Add a zero-anchor one calendar day before the FIRST VISIBLE snapshot
      // (post-migration). Anchoring on pre-migration snapshots would leak the
      // Drift era back into the chart on range=all.
      if (visibleSnapshots.length > 0) {
        const firstSnapDate = new Date(visibleSnapshots[0].snapshotDate);
        firstSnapDate.setHours(0, 0, 0, 0);
        const dayBeforeFirst = new Date(firstSnapDate);
        dayBeforeFirst.setDate(dayBeforeFirst.getDate() - 1);
        const anchorIsInWindow = !sinceDate || dayBeforeFirst >= sinceDate;
        if (anchorIsInWindow && dayBeforeFirst >= MIGRATION_CUTOFF) {
          chartData.push({
            date: dayBeforeFirst,
            netPnl: 0,
            pnlPercent: 0,
            balance: 0,
          });
        }
      }

      // Task 119: read TRADING P&L $ and linked TWR % directly from snapshot
      // fields. Flow-neutral by construction.
      for (const s of visibleSnapshots) {
        chartData.push({
          date: s.snapshotDate,
          netPnl: parseFloat(s.cumulativeTradingPnl ?? s.netPnl),
          pnlPercent: parseFloat(s.pnlPercent ?? '0'),
          balance: parseFloat(s.totalBalance),
        });
      }

      // Append a live "today" point so the chart's tail tracks current balance
      // without waiting for the next 12-hour snapshot. We compute it the same
      // way the snapshot writer would.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const hasToday = snapshots.some(s => {
        const snapDate = new Date(s.snapshotDate);
        snapDate.setHours(0, 0, 0, 0);
        return snapDate.getTime() === today.getTime();
      });

      // Task 119: simple lifetime ratio — trading P&L / total external deposits.
      // Matches snapshot writer and backfill so all surfaces agree.
      let livePnlPercent = (netPnl / Math.max(deposits, 1)) * 100;
      if (livePnlPercent > 1000) livePnlPercent = 1000;
      if (livePnlPercent < -100) livePnlPercent = -100;

      if (!hasToday) {
        chartData.push({
          date: today,
          netPnl,
          pnlPercent: livePnlPercent,
          balance: currentBalance,
        });
      } else if (chartData.length > 0) {
        // Update the existing "today" snapshot point with live numbers so the
        // headline and chart tail always agree.
        chartData[chartData.length - 1] = {
          date: chartData[chartData.length - 1].date,
          netPnl,
          pnlPercent: livePnlPercent,
          balance: currentBalance,
        };
      }

      res.json({
        currentBalance,
        totalDeposits: deposits,
        totalWithdrawals: withdrawals,
        netPnl,
        pnlPercent: livePnlPercent,
        activeBotCount,
        totalBots: bots.length,
        totalTrades,
        totalVolume,
        creatorEarnings,
        chartData,
      });
    } catch (error) {
      console.error("[Portfolio] Error fetching portfolio performance:", error);
      res.status(500).json({ error: "Failed to fetch portfolio performance" });
    }
  });

  // ===== ADMIN LOGS ENDPOINTS =====
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
  console.log(`[Admin] ADMIN_PASSWORD configured: ${ADMIN_PASSWORD ? 'yes' : 'no'}, length: ${ADMIN_PASSWORD?.length || 0}`);
  
  // Middleware to check admin password
  const requireAdminAuth = (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({ error: "Admin endpoints disabled - ADMIN_PASSWORD not configured" });
    }
    const authHeader = req.headers.authorization;
    const providedToken = authHeader?.replace('Bearer ', '').trim();
    
    if (!providedToken || providedToken !== ADMIN_PASSWORD) {
      console.log(`[Admin] Auth failed - provided length: ${providedToken?.length || 0}, expected length: ${ADMIN_PASSWORD.length}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
  
  let lastLabRestartAt = 0;
  let labRestartInFlight = false;
  const LAB_RESTART_MIN_INTERVAL_MS = 30_000;

  app.get("/api/admin/lab/status", requireAdminAuth, async (_req, res) => {
    try {
      const { getLabSupervisor } = await import("./index");
      const status = getLabSupervisor().getStatus();
      res.json({
        ...status,
        restartInFlight: labRestartInFlight,
        cooldownRemainingMs: Math.max(0, LAB_RESTART_MIN_INTERVAL_MS - (Date.now() - lastLabRestartAt)),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to read lab status" });
    }
  });

  app.post("/api/admin/lab/restart", requireAdminAuth, async (_req, res) => {
    if (labRestartInFlight) {
      return res.status(409).json({ error: "A lab restart is already in progress" });
    }
    const sinceLast = Date.now() - lastLabRestartAt;
    if (sinceLast < LAB_RESTART_MIN_INTERVAL_MS) {
      return res.status(429).json({
        error: "Too soon since last restart",
        retryAfterMs: LAB_RESTART_MIN_INTERVAL_MS - sinceLast,
      });
    }
    labRestartInFlight = true;
    lastLabRestartAt = Date.now();
    console.log(`[LabSupervisor] Manual restart requested by admin`);
    try {
      let pausedRuns = 0;
      try {
        const runningRuns = await db
          .select()
          .from(labOptimizationRuns)
          .where(eq(labOptimizationRuns.status, "running"));
        for (const run of runningRuns) {
          const cp = run.checkpoint && typeof run.checkpoint === "object"
            ? { ...(run.checkpoint as any) }
            : null;
          if (cp) {
            cp.autoResumeAttempts = 0;
            delete cp.userCancelled;
            delete cp.resourceError;
          }
          await db
            .update(labOptimizationRuns)
            .set({
              status: "paused",
              ...(cp ? { checkpoint: cp } : {}),
            })
            .where(eq(labOptimizationRuns.id, run.id));
          pausedRuns++;
        }
        if (pausedRuns > 0) {
          console.log(`[LabSupervisor] Manual restart: paused ${pausedRuns} in-flight run(s) for auto-resume`);
        }
      } catch (pauseErr: any) {
        // Abort the restart so the auto-resume guarantee holds. The lab child
        // is still alive; the admin can retry once the DB issue clears.
        console.log(`[LabSupervisor] Manual restart aborted: pause step failed: ${pauseErr.message}`);
        return res.status(500).json({
          ok: false,
          error: `Pause/checkpoint step failed — restart aborted to preserve in-flight runs: ${pauseErr.message}`,
        });
      }

      const { getLabSupervisor } = await import("./index");
      const { newPid } = await getLabSupervisor().requestManualRestart();
      res.json({ ok: true, newPid, pausedRuns });
    } catch (err: any) {
      console.log(`[LabSupervisor] Manual restart failed: ${err?.message}`);
      res.status(500).json({ ok: false, error: err?.message || "Restart failed" });
    } finally {
      labRestartInFlight = false;
    }
  });

  app.post("/api/admin/rescue-transfer", requireAdminAuth, async (req, res) => {
    try {
      const { botId, amount } = req.body;
      const bot = await storage.getTradingBotById(botId);
      if (
        !bot ||
        bot.subaccountAuthMode !== 'external_key' ||
        bot.subaccountStatus !== 'active' ||
        !bot.protocolSubaccountId ||
        !(bot.botSubaccountKeyEncryptedV3 || bot.botSubaccountKeyEncrypted)
      ) {
        return res.status(400).json({ error: "Bot not found or does not have an active external_key subaccount" });
      }
      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncryptedV3 || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "No agent wallet" });
      }
      const rescueUmkResult = await getUmkForWebhook(bot.walletAddress);
      if (!rescueUmkResult) {
        return res.status(403).json({ error: "Execution not enabled for owner; cannot rescue-transfer" });
      }
      const rescueAgentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, rescueUmkResult.umk, wallet, wallet.agentPublicKey);
      rescueUmkResult.cleanup();
      if (!rescueAgentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed" });
      }
      try {
        const adapter = getAdapterForBot(bot);
        const agentKeypair = Keypair.fromSecretKey(rescueAgentKeyResult.secretKey);
        const transferResult = await adapter.transferBetweenSubaccounts({
          agentSecretKey: agentKeypair.secretKey,
          mainWalletAddress: agentKeypair.publicKey.toString(),
          fromSubaccountId: agentKeypair.publicKey.toString(),
          toSubaccountId: bot.protocolSubaccountId,
          amount,
        });
        if (transferResult.success) {
          await storage.createEquityEvent({
            walletAddress: bot.walletAddress,
            tradingBotId: bot.id,
            eventType: 'drift_deposit',
            amount: String(amount),
            txSignature: null,
            notes: `Rescue transfer: agent→${bot.protocolSubaccountId.slice(0,8)}... $${amount}`,
          });
        }
        res.json(transferResult);
      } finally {
        rescueAgentKeyResult.cleanup();
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/debug-positions/:botId", requireAdminAuth, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.botId);
      if (!bot) return res.status(404).json({ error: "Bot not found" });
      const wallet = await storage.getWallet(bot.walletAddress);
      const agentPubKey = wallet?.agentPublicKey || '';
      const botPubKey = bot.protocolSubaccountId || '';
      // Group D item 17c (April 17, 2026): protocol-aware probe selection.
      // Pacifica uses keypair-identified subaccounts (botPubKey is canonical),
      // Drift uses (mainWallet, numericSubId). Running Pacifica's botKeyOnly /
      // rawPositions probes against a Drift bot would either error or silently
      // return Pacifica-shaped nonsense. Use the bot's own adapter and only
      // the probes that are semantically valid for that protocol.
      const adapter = getAdapterForBot(bot);
      const results: Record<string, any> = {};
      if (bot.activeProtocol === 'drift') {
        const subId =
          bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined
            ? String(bot.driftSubaccountId)
            : null;
        if (subId === null) {
          results.error = 'Drift bot has no driftSubaccountId; cannot probe positions.';
        } else {
          try { results.driftPositions = await adapter.getPositions(agentPubKey, subId); } catch (e: any) { results.driftPositions_error = e.message; }
          try { results.driftAccountInfo = await adapter.getAccountInfo(agentPubKey); } catch (e: any) { results.driftAccountInfo_error = e.message; }
        }
      } else {
        // Pacifica (default): keep all 5 existing probes for diagnostic parity.
        try { results.botKeyOnly = await adapter.getPositions(botPubKey); } catch (e: any) { results.botKeyOnly_error = e.message; }
        try { const rawResp = await (adapter as any).get('/positions', { account: botPubKey }); results.rawPositions = rawResp; } catch (e: any) { results.rawPositions_error = e.message; }
        try { results.agentWithBotSub = await adapter.getPositions(agentPubKey, botPubKey); } catch (e: any) { results.agentWithBotSub_error = e.message; }
        try { results.agentOnly = await adapter.getPositions(agentPubKey); } catch (e: any) { results.agentOnly_error = e.message; }
        try { results.accountInfo = await adapter.getAccountInfo(botPubKey); } catch (e: any) { results.accountInfo_error = e.message; }
      }
      res.json({ activeProtocol: bot.activeProtocol, agentPubKey, botPubKey, results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/execution-diagnostics", requireAdminAuth, async (req, res) => {
    try {
      const diag = getSwiftDiagnostics();
      res.json(diag);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch Swift diagnostics" });
    }
  });

  app.get("/api/admin/execution-metrics", requireAdminAuth, async (req, res) => {
    try {
      const metrics = getSwiftMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch Swift metrics" });
    }
  });

  // Get all webhook logs (most recent first)
  app.get("/api/admin/webhook-logs", requireAdminAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await db.select().from(webhookLogs).orderBy(desc(webhookLogs.receivedAt)).limit(limit);
      res.json(logs);
    } catch (error) {
      console.error("[Admin] Webhook logs error:", error);
      res.status(500).json({ error: "Failed to fetch webhook logs" });
    }
  });
  
  // Get all bot trades (most recent first)
  app.get("/api/admin/trades", requireAdminAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const trades = await db.select().from(botTrades).orderBy(desc(botTrades.executedAt)).limit(limit);
      res.json(trades);
    } catch (error) {
      console.error("[Admin] Trades error:", error);
      res.status(500).json({ error: "Failed to fetch trades" });
    }
  });
  
  // Get all bots with their config
  app.get("/api/admin/bots", requireAdminAuth, async (req, res) => {
    try {
      const bots = await db.select().from(tradingBots).orderBy(desc(tradingBots.createdAt));
      res.json(bots);
    } catch (error) {
      console.error("[Admin] Bots error:", error);
      res.status(500).json({ error: "Failed to fetch bots" });
    }
  });
  
  // Get all subscriptions
  app.get("/api/admin/subscriptions", requireAdminAuth, async (req, res) => {
    try {
      const subs = await db.select({
        subscription: botSubscriptions,
        subscriberBot: tradingBots,
        publishedBot: publishedBots,
      })
        .from(botSubscriptions)
        .leftJoin(tradingBots, eq(botSubscriptions.subscriberBotId, tradingBots.id))
        .leftJoin(publishedBots, eq(botSubscriptions.publishedBotId, publishedBots.id))
        .orderBy(desc(botSubscriptions.subscribedAt));
      res.json(subs);
    } catch (error) {
      console.error("[Admin] Subscriptions error:", error);
      res.status(500).json({ error: "Failed to fetch subscriptions" });
    }
  });
  
  // Get all published bots
  app.get("/api/admin/published-bots", requireAdminAuth, async (req, res) => {
    try {
      const pubs = await db.select({
        publishedBot: publishedBots,
        sourceBot: tradingBots,
      })
        .from(publishedBots)
        .leftJoin(tradingBots, eq(publishedBots.tradingBotId, tradingBots.id))
        .orderBy(desc(publishedBots.publishedAt));
      res.json(pubs);
    } catch (error) {
      console.error("[Admin] Published bots error:", error);
      res.status(500).json({ error: "Failed to fetch published bots" });
    }
  });
  
  // Get pending profit shares
  app.get("/api/admin/pending-profit-shares", requireAdminAuth, async (req, res) => {
    try {
      const shares = await db.select().from(pendingProfitShares).orderBy(desc(pendingProfitShares.createdAt));
      res.json(shares);
    } catch (error) {
      console.error("[Admin] Pending profit shares error:", error);
      res.status(500).json({ error: "Failed to fetch pending profit shares" });
    }
  });
  
  // Get wallets summary (without sensitive keys)
  app.get("/api/admin/wallets", requireAdminAuth, async (req, res) => {
    try {
      const walletList = await db.select({
        address: wallets.address,
        agentPublicKey: wallets.agentPublicKey,
        slippageBps: wallets.slippageBps,
        createdAt: wallets.createdAt,
      }).from(wallets).orderBy(desc(wallets.createdAt));
      res.json(walletList);
    } catch (error) {
      console.error("[Admin] Wallets error:", error);
      res.status(500).json({ error: "Failed to fetch wallets" });
    }
  });

  // Enriched user/account view for the admin Users tab: who has actually
  // converted from signup → wallet → bots → on-chain account. Shows the
  // wallet pubkey (the "username" surrogate — no separate username system),
  // display name / X handle if set, the wallet-level Pacifica subaccount
  // pubkey (PDA), per-wallet bot count, and the key conversion flags
  // (builder approved / referral claimed / execution enabled / Telegram
  // connected). Counts are computed in a single grouped query to keep this
  // cheap as the wallet table grows.
  app.get("/api/admin/users", requireAdminAuth, async (_req, res) => {
    try {
      const rows = await db.select({
        address: wallets.address,
        displayName: wallets.displayName,
        xUsername: wallets.xUsername,
        protocolSubaccountId: wallets.protocolSubaccountId,
        referralCode: wallets.referralCode,
        referredBy: wallets.referredBy,
        telegramConnected: wallets.telegramConnected,
        executionEnabled: wallets.executionEnabled,
        createdAt: wallets.createdAt,
        lastSeen: wallets.lastSeen,
      }).from(wallets).orderBy(desc(wallets.createdAt));

      // Bot counts + per-wallet enrollment (Phase 4b truth). The wallet-level
      // pacifica_builder_approved/pacifica_referral_claimed flags are never
      // flipped under Phase 4b — enrollment happens on the trading_bots row
      // because each Pacifica bot is its own main account. Aggregate bot-level
      // flags up to the wallet so the admin "Users" tab shows accurate
      // enrollment status (any approved bot ⇒ wallet shows green).
      const botCountRows = await db.select({
        walletAddress: tradingBots.walletAddress,
        count: sql<number>`count(*)::int`,
        activeCount: sql<number>`count(*) filter (where ${tradingBots.isActive} = true)::int`,
        anyBuilderApproved: sql<boolean>`bool_or(${tradingBots.pacificaBuilderApproved})`,
        anyReferralClaimed: sql<boolean>`bool_or(${tradingBots.pacificaReferralClaimed})`,
      }).from(tradingBots).groupBy(tradingBots.walletAddress);
      const botCountByWallet = new Map<string, { count: number; activeCount: number; anyBuilderApproved: boolean; anyReferralClaimed: boolean }>();
      for (const r of botCountRows) {
        botCountByWallet.set(r.walletAddress, {
          count: r.count,
          activeCount: r.activeCount,
          anyBuilderApproved: !!r.anyBuilderApproved,
          anyReferralClaimed: !!r.anyReferralClaimed,
        });
      }

      const enriched = rows.map(r => {
        const counts = botCountByWallet.get(r.address);
        return {
          ...r,
          botCount: counts?.count ?? 0,
          activeBotCount: counts?.activeCount ?? 0,
          // Field names preserved for API compatibility; semantics are now
          // "any of this wallet's bots is enrolled" rather than wallet-level.
          pacificaBuilderApproved: counts?.anyBuilderApproved ?? false,
          pacificaReferralClaimed: counts?.anyReferralClaimed ?? false,
        };
      });
      res.json(enriched);
    } catch (error) {
      console.error("[Admin] Users error:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Revenue summary for the admin Revenue tab.
  //
  // Referral revenue: authoritative — sourced from the
  // `referral_reward_events` ledger (status = paid/pending/failed).
  //
  // Builder-code revenue: ESTIMATED. We do not store the per-trade builder
  // fee Pacifica grants us (no DB column for it, no `/builder_codes/earnings`
  // call wired up yet). The figure shown is an upper-bound ceiling:
  //   Σ(filled notional on Pacifica, for wallets with builder approval)
  //     × pacificaBuilderMaxFeeRate (0.002 = 0.2%).
  // Actual revenue is whatever Pacifica's allocator gives us per their
  // fee_rate config (base 0.001) and may be lower. The UI labels this
  // clearly as an estimate.
  app.get("/api/admin/revenue", requireAdminAuth, async (_req, res) => {
    try {
      const refByStatus = await db.select({
        status: referralRewardEvents.status,
        totalUsdc: sql<string>`coalesce(sum(${referralRewardEvents.amountUsdc}), 0)::text`,
        eventCount: sql<number>`count(*)::int`,
      }).from(referralRewardEvents).groupBy(referralRewardEvents.status);

      const refByEarner = await db.select({
        earnerWallet: referralRewardEvents.earnerWallet,
        totalUsdc: sql<string>`coalesce(sum(${referralRewardEvents.amountUsdc}) filter (where ${referralRewardEvents.status} = 'paid'), 0)::text`,
        pendingUsdc: sql<string>`coalesce(sum(${referralRewardEvents.amountUsdc}) filter (where ${referralRewardEvents.status} = 'pending'), 0)::text`,
        eventCount: sql<number>`count(*)::int`,
      })
        .from(referralRewardEvents)
        .groupBy(referralRewardEvents.earnerWallet)
        .orderBy(sql`sum(${referralRewardEvents.amountUsdc}) desc`)
        .limit(20);

      const referral = {
        paidUsdc: 0,
        pendingUsdc: 0,
        failedUsdc: 0,
        totalUsdc: 0,
        paidCount: 0,
        pendingCount: 0,
        failedCount: 0,
        topEarners: refByEarner.map(r => ({
          earnerWallet: r.earnerWallet,
          paidUsdc: parseFloat(r.totalUsdc) || 0,
          pendingUsdc: parseFloat(r.pendingUsdc) || 0,
          eventCount: r.eventCount,
        })),
      };
      for (const r of refByStatus) {
        const amt = parseFloat(r.totalUsdc) || 0;
        referral.totalUsdc += amt;
        if (r.status === 'paid') { referral.paidUsdc = amt; referral.paidCount = r.eventCount; }
        else if (r.status === 'pending') { referral.pendingUsdc = amt; referral.pendingCount = r.eventCount; }
        else if (r.status === 'failed') { referral.failedUsdc = amt; referral.failedCount = r.eventCount; }
      }

      // Builder-fee estimate (Pacifica only, wallets with builder approval).
      // Clamp fee rate to a sane finite positive bound so a misconfigured env
      // var can't NaN-poison the admin UI or produce absurd "revenue" numbers.
      const rawFeeRate = parseFloat(process.env.PACIFICA_BUILDER_MAX_FEE_RATE || '0.002');
      const BUILDER_MAX_FEE_RATE = Number.isFinite(rawFeeRate) && rawFeeRate > 0 && rawFeeRate <= 0.05
        ? rawFeeRate
        : 0.002;

      // Count both `executed` and `recovered` — `recovered` is a successful
      // fill that was originally marked failed and later reconciled on-chain.
      // Excluding it would materially undercount builder notional. Prefer
      // filledSizeBase × averageFillPrice when present (post-fill reconciled
      // truth), fall back to requested size × submitted price.
      // Enrollment lives on `trading_bots`, NOT `wallets`. Under Phase 4b each
      // Pacifica bot IS its own Pacifica main account (per-bot subaccount key
      // signs orders), so `ensurePacificaEnrollment` flips the flag on the
      // trading_bots row, not the wallet row. The previous query joined
      // wallets and filtered on wallets.pacificaBuilderApproved — which is
      // ALWAYS false in production (no wallet ever gets enrolled in Phase 4b),
      // so the dashboard always showed $0. Join through trading_bots instead.
      //
      // protocol filter uses coalesce(..., 'pacifica') because historical rows
      // (pre-2026-05-28) were inserted with protocol=NULL — no createBotTrade /
      // updateBotTrade site set the column. Schema default added 2026-05-28
      // so new rows are tagged correctly; old rows stay NULL until the next
      // Publish flow propagates the default. Treating NULL as Pacifica is
      // correct until a non-Pacifica adapter ships.
      const builderRows = await db.select({
        notional: sql<string>`coalesce(sum(coalesce(${botTrades.filledSizeBase}, ${botTrades.size})::numeric * coalesce(${botTrades.averageFillPrice}, ${botTrades.price})::numeric), 0)::text`,
        fillCount: sql<number>`count(*)::int`,
      })
        .from(botTrades)
        .innerJoin(tradingBots, eq(botTrades.tradingBotId, tradingBots.id))
        .where(and(
          eq(tradingBots.activeProtocol, 'pacifica'),
          eq(tradingBots.pacificaBuilderApproved, true),
          sql`coalesce(${botTrades.protocol}, 'pacifica') = 'pacifica'`,
          sql`${botTrades.status} in ('executed', 'recovered')`,
        ));
      const filledNotional = parseFloat(builderRows[0]?.notional ?? '0') || 0;
      const builderFillCount = builderRows[0]?.fillCount ?? 0;

      // Enrollment counts: report at the bot level (Phase 4b truth). Restrict
      // to Pacifica bots — counting Drift bots would muddy the denominator.
      const approvedRows = await db.select({
        approvedWallets: sql<number>`count(*) filter (where ${tradingBots.pacificaBuilderApproved} = true)::int`,
        claimedRefWallets: sql<number>`count(*) filter (where ${tradingBots.pacificaReferralClaimed} = true)::int`,
      }).from(tradingBots).where(eq(tradingBots.activeProtocol, 'pacifica'));

      const builder = {
        estimatedUsdc: filledNotional * BUILDER_MAX_FEE_RATE,
        filledNotional,
        feeRateCeiling: BUILDER_MAX_FEE_RATE,
        fillCount: builderFillCount,
        approvedWallets: approvedRows[0]?.approvedWallets ?? 0,
        note: "Estimated ceiling. Pacifica controls the actual fee allocation per their fee_rate; we don't yet poll /builder_codes/earnings, so this is the upper bound (filled notional × max_fee_rate).",
      };

      const enrollment = {
        builderApprovedWallets: approvedRows[0]?.approvedWallets ?? 0,
        referralClaimedWallets: approvedRows[0]?.claimedRefWallets ?? 0,
      };

      res.json({ referral, builder, enrollment });
    } catch (error) {
      console.error("[Admin] Revenue error:", error);
      res.status(500).json({ error: "Failed to fetch revenue" });
    }
  });
  
  // Subscription routing diagnostics - shows why signals might not be routing
  app.get("/api/admin/subscription-diagnostics", requireAdminAuth, async (req, res) => {
    try {
      // Get all active subscriptions with full details
      const subscriptions = await db.select()
        .from(botSubscriptions)
        .where(eq(botSubscriptions.status, 'active'));
      
      const diagnostics = await Promise.all(subscriptions.map(async (sub) => {
        // Get subscriber bot
        const [subscriberBot] = await db.select().from(tradingBots).where(eq(tradingBots.id, sub.subscriberBotId || ''));
        
        // Get published bot
        const [publishedBot] = await db.select().from(publishedBots).where(eq(publishedBots.id, sub.publishedBotId));
        
        // Get source trading bot
        const [sourceBot] = publishedBot 
          ? await db.select().from(tradingBots).where(eq(tradingBots.id, publishedBot.tradingBotId))
          : [null];
        
        // Get subscriber wallet if subscriber bot exists
        let subscriberWallet = null;
        if (subscriberBot) {
          [subscriberWallet] = await db.select({
            address: wallets.address,
            hasAgentPublicKey: sql<boolean>`agent_public_key IS NOT NULL`,
            hasAgentPrivateKey: sql<boolean>`agent_private_key_encrypted IS NOT NULL`,
          }).from(wallets).where(eq(wallets.address, subscriberBot.walletAddress));
        }
        
        // Check if subscriber would be found by the routing query
        let wouldBeRouted = false;
        if (publishedBot && subscriberBot) {
          const routingResult = await storage.getSubscriberBotsBySourceId(publishedBot.id);
          wouldBeRouted = routingResult.some(b => b.id === subscriberBot.id);
        }
        
        // Compute routing issues
        const issues: string[] = [];
        if (!subscriberBot) issues.push('Subscriber bot is NULL');
        if (!publishedBot) issues.push('Published bot not found');
        if (!sourceBot) issues.push('Source trading bot not found');
        if (subscriberBot && !subscriberBot.isActive) issues.push('Subscriber bot is inactive');
        if (publishedBot && !publishedBot.isActive) issues.push('Published bot is inactive');
        if (subscriberBot && !subscriberBot.sourcePublishedBotId) issues.push('Subscriber bot missing sourcePublishedBotId');
        if (subscriberBot && subscriberBot.sourcePublishedBotId !== sub.publishedBotId) issues.push('Subscriber sourcePublishedBotId mismatch');
        if (!subscriberWallet) issues.push('Subscriber wallet not found');
        if (subscriberWallet && !subscriberWallet.hasAgentPublicKey) issues.push('Subscriber wallet missing agentPublicKey');
        if (subscriberWallet && !subscriberWallet.hasAgentPrivateKey) issues.push('Subscriber wallet missing agentPrivateKeyEncrypted');
        if (!wouldBeRouted) issues.push('Would NOT be found by routing query');
        
        return {
          subscriptionId: sub.id,
          status: sub.status,
          subscribedAt: sub.subscribedAt,
          
          // Source bot info
          sourceBot: sourceBot ? {
            id: sourceBot.id,
            name: sourceBot.name,
            market: sourceBot.market,
            isActive: sourceBot.isActive,
          } : null,
          
          // Published bot info  
          publishedBot: publishedBot ? {
            id: publishedBot.id,
            name: publishedBot.name,
            isActive: publishedBot.isActive,
            totalTrades: publishedBot.totalTrades,
          } : null,
          
          // Subscriber bot info
          subscriberBot: subscriberBot ? {
            id: subscriberBot.id,
            name: subscriberBot.name,
            market: subscriberBot.market,
            isActive: subscriberBot.isActive,
            driftSubaccountId: subscriberBot.driftSubaccountId,
            sourcePublishedBotId: subscriberBot.sourcePublishedBotId,
            totalTrades: await storage.getCanonicalBotTradeCount(subscriberBot.id),
          } : null,
          
          // Wallet info
          subscriberWallet: subscriberWallet ? {
            address: subscriberWallet.address.slice(0, 8) + '...',
            hasAgentPublicKey: subscriberWallet.hasAgentPublicKey,
            hasAgentPrivateKey: subscriberWallet.hasAgentPrivateKey,
          } : null,
          
          // Routing status
          wouldBeRouted,
          issues,
          canRoute: issues.length === 0,
        };
      }));
      
      res.json({
        totalSubscriptions: subscriptions.length,
        routableCount: diagnostics.filter(d => d.canRoute).length,
        diagnostics,
      });
    } catch (error) {
      console.error("[Admin] Subscription diagnostics error:", error);
      res.status(500).json({ error: "Failed to fetch subscription diagnostics" });
    }
  });

  // Test routing endpoint - directly tests the routing function
  app.post("/api/admin/test-routing/:botId", requireAdminAuth, async (req, res) => {
    const { botId } = req.params;
    const { dryRun = true } = req.body;
    
    try {
      console.log(`[Admin] Test routing for bot ${botId}, dryRun=${dryRun}`);
      
      // Step 1: Find the published bot
      const publishedBot = await storage.getPublishedBotByTradingBotId(botId);
      if (!publishedBot) {
        return res.json({
          success: false,
          step: "getPublishedBot",
          error: "Bot is not published - cannot route signals",
          botId,
        });
      }
      
      // Step 2: Check if published bot is active
      if (!publishedBot.isActive) {
        return res.json({
          success: false,
          step: "checkActive",
          error: "Published bot is inactive",
          publishedBotId: publishedBot.id,
        });
      }
      
      // Step 3: Get subscriber bots
      const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
      if (!subscriberBots || subscriberBots.length === 0) {
        return res.json({
          success: false,
          step: "getSubscribers",
          error: "No subscriber bots found",
          publishedBotId: publishedBot.id,
        });
      }
      
      // Step 4: Check each subscriber
      const subscriberDetails = await Promise.all(subscriberBots.map(async (subBot) => {
        const subWallet = await storage.getWallet(subBot.walletAddress);
        return {
          botId: subBot.id,
          name: subBot.name,
          isActive: subBot.isActive,
          market: subBot.market,
          walletFound: !!subWallet,
          // V3 Phase 3b: routing readiness is determined by V3 envelope +
          // executionEnabled, not the legacy AGENT_ENCRYPTION_KEY blob.
          hasAgentPublicKey: !!subWallet?.agentPublicKey,
          executionEnabled: !!subWallet?.executionEnabled,
          emergencyStopTriggered: !!subWallet?.emergencyStopTriggered,
          hasV3KeyEnvelope: !!subWallet?.agentPrivateKeyEncryptedV3,
          wouldExecute:
            subBot.isActive &&
            !!subWallet?.agentPublicKey &&
            !!subWallet?.executionEnabled &&
            !subWallet?.emergencyStopTriggered &&
            !!subWallet?.agentPrivateKeyEncryptedV3,
        };
      }));
      
      const routableCount = subscriberDetails.filter(s => s.wouldExecute).length;
      
      res.json({
        success: true,
        step: "complete",
        sourceBotId: botId,
        publishedBotId: publishedBot.id,
        publishedBotActive: publishedBot.isActive,
        totalSubscribers: subscriberBots.length,
        routableSubscribers: routableCount,
        subscribers: subscriberDetails,
        message: dryRun 
          ? `Dry run complete. Found ${routableCount} routable subscribers.`
          : "Live routing not implemented in test endpoint",
      });
    } catch (error: any) {
      console.error("[Admin] Test routing error:", error);
      res.status(500).json({ 
        success: false,
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 5),
      });
    }
  });

  // Debug endpoint: Execute actual routing with full error capture
  app.post("/api/admin/debug-routing/:botId", requireAdminAuth, async (req, res) => {
    const { botId } = req.params;
    const logs: string[] = [];
    const log = (msg: string) => {
      console.log(msg);
      logs.push(msg);
    };
    
    try {
      log(`[Debug Routing] Starting for bot ${botId}`);
      
      // Step 1: Get published bot
      const publishedBot = await storage.getPublishedBotByTradingBotId(botId);
      if (!publishedBot) {
        return res.json({ success: false, error: "Bot not published", logs });
      }
      log(`[Debug Routing] Published bot: ${publishedBot.id}, active=${publishedBot.isActive}`);
      
      // Step 2: Get subscribers
      const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
      log(`[Debug Routing] Found ${subscriberBots?.length || 0} subscribers`);
      
      if (!subscriberBots || subscriberBots.length === 0) {
        return res.json({ success: false, error: "No subscribers", logs });
      }
      
      const results: any[] = [];
      
      for (const subBot of subscriberBots) {
        const subResult: any = {
          botId: subBot.id,
          name: subBot.name,
          isActive: subBot.isActive,
          market: subBot.market,
          maxPositionSize: subBot.maxPositionSize,
          leverage: subBot.leverage,
          driftSubaccountId: subBot.driftSubaccountId,
          profitReinvest: subBot.profitReinvest,
        };
        
        try {
          if (!subBot.isActive) {
            subResult.error = "Bot inactive";
            results.push(subResult);
            continue;
          }
          
          const subWallet = await storage.getWallet(subBot.walletAddress);
          subResult.walletFound = !!subWallet;
          subResult.hasAgentPublicKey = !!subWallet?.agentPublicKey;
          // V3 Phase 3b: surface the V3 readiness shape (executionEnabled +
          // wrapped UMK envelope) rather than the legacy encrypted blob, which
          // fan-out no longer consults.
          subResult.executionEnabled = !!subWallet?.executionEnabled;
          subResult.emergencyStopTriggered = !!subWallet?.emergencyStopTriggered;
          subResult.hasV3KeyEnvelope = !!subWallet?.agentPrivateKeyEncryptedV3;

          if (!subWallet?.agentPublicKey) {
            subResult.error = "Missing agent public key";
            results.push(subResult);
            continue;
          }
          if (!subWallet.executionEnabled || subWallet.emergencyStopTriggered || !subWallet.agentPrivateKeyEncryptedV3) {
            subResult.error = subWallet.emergencyStopTriggered
              ? "Subscriber is emergency-stopped"
              : !subWallet.executionEnabled
                ? "Subscriber has not enabled execution"
                : "Subscriber has no V3 agent key envelope";
            results.push(subResult);
            continue;
          }
          
          const subAccountId = subBot.driftSubaccountId ?? 0;
          const oraclePrice = await getMarketPrice(subBot.market, getAdapterForBot(subBot));
          subResult.oraclePrice = oraclePrice;
          
          if (!oraclePrice) {
            subResult.error = "Could not get oracle price";
            results.push(subResult);
            continue;
          }
          
          const maxPos = parseFloat(subBot.maxPositionSize || '0');
          const profitReinvestEnabled = subBot.profitReinvest === true;
          subResult.maxPositionParsed = maxPos;
          subResult.profitReinvestEnabled = profitReinvestEnabled;
          
          if (maxPos <= 0 && !profitReinvestEnabled) {
            subResult.error = "No maxPositionSize and profit reinvest disabled";
            results.push(subResult);
            continue;
          }
          
          // Use 50% signal for testing
          const signalPercent = 50;
          
          log(`[Debug Routing] Calling computeTradeSizingAndTopUp for ${subBot.id}`);

          // V3 Phase 3b: strict-decrypt the subscriber's agent key via UMK so
          // the debug path mirrors live fan-out and never touches the legacy
          // blob. Cleanup happens in the surrounding finally.
          const debugUmk = await getUmkForWebhook(subBot.walletAddress);
          if (!debugUmk) {
            subResult.error = "Subscriber UMK unavailable (execution disabled or emergency-stopped)";
            results.push(subResult);
            continue;
          }
          const debugAgentKey = await decryptAgentKeyStrict(
            subBot.walletAddress,
            debugUmk.umk,
            subWallet,
            subWallet.agentPublicKey,
          );
          if (!debugAgentKey) {
            debugUmk.cleanup();
            subResult.error = "V3 strict decrypt failed for subscriber agent key";
            results.push(subResult);
            continue;
          }

          try {
            const debugSubBotCtx = getBotSubaccountContext(subBot);
            const sizingResult = await computeTradeSizingAndTopUp({
              agentPublicKey: subWallet.agentPublicKey!,
              agentPrivateKeyEncrypted: debugAgentKey.secretKey,
              subAccountId: debugSubBotCtx ? 0 : subAccountId,
              botId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              baseCapital: maxPos,
              leverage: subBot.leverage || 1,
              autoTopUp: subBot.autoTopUp ?? false,
              profitReinvestEnabled,
              signalPercent,
              oraclePrice,
              logPrefix: `[Debug Routing] Bot ${subBot.id}`,
              botCtx: debugSubBotCtx,
              adapter: getAdapterForBot(subBot),
            });
            
            subResult.sizingSuccess = sizingResult.success;
            subResult.sizingError = sizingResult.error;
            subResult.finalContractSize = sizingResult.finalContractSize;
            subResult.tradeAmountUsd = sizingResult.tradeAmountUsd;
            subResult.freeCollateral = sizingResult.freeCollateral;
            
            if (!sizingResult.success) {
              subResult.error = `Trade sizing failed: ${sizingResult.error}`;
              results.push(subResult);
              continue;
            }
            
            if (sizingResult.finalContractSize < 0.001) {
              subResult.error = `Trade size too small: ${sizingResult.finalContractSize}`;
              results.push(subResult);
              continue;
            }
            
            subResult.wouldExecuteTrade = true;
            subResult.tradeDetails = {
              side: 'long',
              contractSize: sizingResult.finalContractSize,
              subAccountId,
              slippageBps: subWallet.slippageBps ?? 50,
            };
            
            // Don't actually execute the trade in debug mode
            subResult.status = "Ready to trade (dry run - no execution)";
            
          } catch (sizingError: any) {
            subResult.error = `Sizing exception: ${sizingError.message}`;
            subResult.sizingStack = sizingError.stack?.split('\n').slice(0, 3);
          } finally {
            // V3 Phase 3b: zero out the per-debug subscriber agent key + UMK.
            debugAgentKey.cleanup();
            debugUmk.cleanup();
          }
          
        } catch (subError: any) {
          subResult.error = `Exception: ${subError.message}`;
          subResult.stack = subError.stack?.split('\n').slice(0, 3);
        }
        
        results.push(subResult);
      }
      
      res.json({
        success: true,
        sourceBotId: botId,
        publishedBotId: publishedBot.id,
        subscriberCount: subscriberBots.length,
        results,
        logs,
      });
      
    } catch (error: any) {
      log(`[Debug Routing] Error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 5),
        logs,
      });
    }
  });

  // Live routing test - actually executes routeSignalToSubscribers
  app.post("/api/admin/live-routing-test/:botId", requireAdminAuth, async (req, res) => {
    const { botId } = req.params;
    const { action = 'buy', contracts = '0.5', positionSize = '1', price = '100' } = req.body;
    
    console.log(`[Admin] Live routing test for bot ${botId}: action=${action}, contracts=${contracts}`);
    
    try {
      // First verify the bot is published and has subscribers
      const publishedBot = await storage.getPublishedBotByTradingBotId(botId);
      if (!publishedBot) {
        return res.json({ success: false, error: "Bot is not published" });
      }
      
      const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
      if (!subscriberBots || subscriberBots.length === 0) {
        return res.json({ success: false, error: "No subscriber bots found", publishedBotId: publishedBot.id });
      }
      
      console.log(`[Admin] Calling routeSignalToSubscribers for ${subscriberBots.length} subscribers`);
      
      // Actually call the routing function
      const startTime = Date.now();
      await routeSignalToSubscribers(botId, {
        action: action as 'buy' | 'sell',
        contracts,
        positionSize,
        price,
        isCloseSignal: false,
        strategyPositionSize: null,
      });
      const elapsed = Date.now() - startTime;
      
      console.log(`[Admin] routeSignalToSubscribers completed in ${elapsed}ms`);
      
      // Check if any trades were created for subscribers
      const subscriberTradeChecks = await Promise.all(subscriberBots.map(async (subBot) => {
        const recentTrades = await storage.getBotTrades(subBot.id);
        const latestTrade = recentTrades[0];
        const isRecent = latestTrade && (Date.now() - new Date(latestTrade.createdAt).getTime()) < 60000; // Within last minute
        return {
          botId: subBot.id,
          name: subBot.name,
          totalTrades: recentTrades.length,
          latestTradeTime: latestTrade?.createdAt,
          likelyNewTrade: isRecent,
        };
      }));
      
      res.json({
        success: true,
        message: `Routing executed for ${subscriberBots.length} subscribers in ${elapsed}ms`,
        sourceBotId: botId,
        publishedBotId: publishedBot.id,
        subscriberCount: subscriberBots.length,
        subscriberTradeResults: subscriberTradeChecks,
      });
      
    } catch (error: any) {
      console.error("[Admin] Live routing test error:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 5),
      });
    }
  });

  // System stats summary
  app.get("/api/admin/stats", requireAdminAuth, async (req, res) => {
    try {
      const [totalBots] = await db.select({ count: sql<number>`count(*)::int` }).from(tradingBots);
      const [activeBots] = await db.select({ count: sql<number>`count(*)::int` }).from(tradingBots).where(eq(tradingBots.isActive, true));
      const [totalTrades] = await db.select({ count: sql<number>`count(*)::int` }).from(botTrades);
      const [totalWebhooks] = await db.select({ count: sql<number>`count(*)::int` }).from(webhookLogs);
      const [processedWebhooks] = await db.select({ count: sql<number>`count(*)::int` }).from(webhookLogs).where(eq(webhookLogs.processed, true));
      const [activeSubscriptions] = await db.select({ count: sql<number>`count(*)::int` }).from(botSubscriptions).where(eq(botSubscriptions.status, 'active'));
      const [totalUsers] = await db.select({ count: sql<number>`count(*)::int` }).from(wallets);
      const [pendingShares] = await db.select({ count: sql<number>`count(*)::int` }).from(pendingProfitShares).where(eq(pendingProfitShares.status, 'pending'));
      
      res.json({
        totalBots: totalBots?.count || 0,
        activeBots: activeBots?.count || 0,
        totalTrades: totalTrades?.count || 0,
        totalWebhooks: totalWebhooks?.count || 0,
        processedWebhooks: processedWebhooks?.count || 0,
        activeSubscriptions: activeSubscriptions?.count || 0,
        totalUsers: totalUsers?.count || 0,
        pendingProfitShares: pendingShares?.count || 0,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[Admin] Stats error:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ==================== SUPERTEAM AGENT ROUTES ====================
  const { superteamAgentService } = await import("./superteam-agent-service");

  app.post("/api/admin/superteam/register", requireAdminAuth, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: "Agent name is required" });
      const result = await superteamAgentService.registerAgent(name);
      res.json({ success: true, agent: { agentId: result.agentId, username: result.username, claimCode: result.claimCode } });
    } catch (error: any) {
      console.error("[Superteam] Registration error:", error);
      res.status(500).json({ error: "Agent registration failed. Check server logs for details." });
    }
  });

  app.get("/api/admin/superteam/agent", requireAdminAuth, async (_req, res) => {
    try {
      const agent = await superteamAgentService.getAgent();
      if (!agent) return res.json({ agent: null });
      res.json({ agent: { id: agent.id, agentName: agent.agentName, agentId: agent.agentId, claimCode: agent.claimCode, username: agent.username, status: agent.status, createdAt: agent.createdAt, hasApiKey: !!agent.apiKey } });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch agent status." });
    }
  });

  app.get("/api/admin/superteam/listings", requireAdminAuth, async (req, res) => {
    try {
      const take = parseInt(req.query.take as string) || 20;
      const deadline = req.query.deadline as string;
      const listings = await superteamAgentService.listLiveListings(take, deadline);
      res.json({ listings });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/superteam/listings/:slug", requireAdminAuth, async (req, res) => {
    try {
      const details = await superteamAgentService.getListingDetails(req.params.slug);
      res.json({ listing: details });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/superteam/submit", requireAdminAuth, async (req, res) => {
    try {
      const { listingId, listingSlug, listingTitle, link, otherInfo, tweet, telegram, eligibilityAnswers, ask } = req.body;
      if (!listingId || !link || !otherInfo) return res.status(400).json({ error: "listingId, link, and otherInfo are required" });
      const result = await superteamAgentService.submitToListing({ listingId, listingSlug, listingTitle, link, otherInfo, tweet, telegram, eligibilityAnswers, ask });
      res.json({ success: true, submission: result });
    } catch (error: any) {
      console.error("[Superteam] Submission error:", error);
      const safeMsg = error.message?.includes('(') ? error.message.split('):')[1]?.trim() || 'Submission failed' : error.message || 'Submission failed';
      res.status(500).json({ error: safeMsg });
    }
  });

  app.post("/api/admin/superteam/update-submission", requireAdminAuth, async (req, res) => {
    try {
      const { listingId, link, otherInfo, tweet, telegram, eligibilityAnswers, ask } = req.body;
      if (!listingId || !link || !otherInfo) return res.status(400).json({ error: "listingId, link, and otherInfo are required" });
      const result = await superteamAgentService.updateSubmission({ listingId, link, otherInfo, tweet, telegram, eligibilityAnswers, ask });
      res.json({ success: true, submission: result });
    } catch (error: any) {
      console.error("[Superteam] Update error:", error);
      res.status(500).json({ error: "Submission update failed. Check server logs." });
    }
  });

  app.get("/api/admin/superteam/comments/:listingId", requireAdminAuth, async (req, res) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const take = parseInt(req.query.take as string) || 20;
      const comments = await superteamAgentService.getComments(req.params.listingId, skip, take);
      res.json({ comments });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/superteam/comment", requireAdminAuth, async (req, res) => {
    try {
      const { listingId, message, pocId, replyToId, replyToUserId } = req.body;
      if (!listingId || !message) return res.status(400).json({ error: "listingId and message are required" });
      const result = await superteamAgentService.postComment({ listingId, message, pocId, replyToId, replyToUserId });
      res.json({ success: true, comment: result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/superteam/submissions", requireAdminAuth, async (_req, res) => {
    try {
      const submissions = await superteamAgentService.getSubmissions();
      res.json({ submissions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #136: Telegram Mini App read-only API surface.
  // Isolated auth — does NOT share middleware with requireWallet (session)
  // or the planned Bearer middleware. Every /api/tg/* request HMAC-verifies
  // initData against TELEGRAM_BOT_TOKEN. All endpoints are read-only.
  registerTelegramMiniAppRoutes(app);

  return httpServer;
}

// Format a wallet address as `abcd…wxyz` for user-facing display in Telegram.
function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// Helper function to send Telegram messages (for webhook responses)
async function sendTelegramResponse(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, any>,
): Promise<boolean> {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const body: Record<string, any> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`[Telegram] API error ${response.status}:`, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] Error sending message:', error);
    return false;
  }
}
