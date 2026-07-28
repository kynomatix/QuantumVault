/**
 * Subaccount Recycling Plan §5.1.4 (Phase E) — lease-expiry recovery.
 *
 * The reuse-on-create flow (§5.1, §8) hands a swept-empty spare to an in-flight
 * create by flipping it `spare → reserving` under a claim token + lease. The
 * Pacifica work (verify-empty + re-fund) and the CAS finalize happen AFTER the
 * row lock is released, so a create can crash mid-flight and leave a row stuck in
 * `reserving`. A lease-based lock CANNOT ship without its unlock, so this job
 * ships in the SAME phase as reuse-on-create.
 *
 * Recovery rule (§5.1.4 — "must never blindly revert", Gemini HIGH): a create can
 * crash AFTER Pacifica funded the subaccount but BEFORE the CAS finalize. Blindly
 * flipping `reserving → spare` would later fail verify-empty and permanently
 * quarantine a funded slot. So for each expired reservation we:
 *   (a) verifySubaccountEmpty;
 *   (b) empty            → release back to `spare`;
 *   (c) funded           → sweep funds subaccount→main (with the §7.1 indexing
 *                          wait), re-verify empty, THEN release to `spare`;
 *   (d) sweep itself fails → quarantine `stuck_funds` (funds genuinely stranded).
 *
 * This job runs on a fixed cadence REGARDLESS of the REUSE_ON_CREATE flag: even
 * with reuse off, a previously-claimed row must still be unlocked. It is a safe
 * no-op when there are no expired reservations.
 */

import { storage } from './storage';
import { getDefaultAdapter, getAdapter } from './protocol/adapter-registry';
import {
  getUmkForWebhook,
  decryptRetainedSubaccountKeyV3,
} from './session-v3';
import type { ProtocolSubaccount } from '@shared/schema';

// Owner-approved (2026-05-30): lease TTL = 10 min. A create's verify + re-fund +
// CAS finalize completes in seconds, so 10 min is comfortably longer than any
// honest in-flight create — only genuinely crashed/abandoned claims expire.
const LEASE_TTL_MS = 10 * 60 * 1000;
// Recovery cadence. Independent of the lease TTL; just bounds how long a crashed
// claim stays locked before it is reclaimed.
const RUN_INTERVAL_MS = 5 * 60 * 1000;
// First run is staggered well after boot so it never competes with startup work.
const INITIAL_DELAY_MS = 90_000;
// §7.1 indexing wait: after the subaccount→main transfer, Pacifica needs time to
// index it before the subaccount reads empty. Mirrors the create path's bounded
// ~90s poll (provisionFundedSubaccount). We poll verify-empty on this backoff
// schedule; if it never settles within the budget we DEFER (leave reserving) and
// let the next cycle pool it — we never quarantine a successfully-swept slot.
const SWEEP_INDEX_POLL_SCHEDULE_MS = [5_000, 10_000, 15_000, 20_000, 20_000, 20_000];

const LOG = '[LeaseRecovery]';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SweepOutcome = 'swept' | 'stuck' | 'defer';

/**
 * A crashed creator may have inserted/keyed its durable bot row before the
 * reservation finalizer ran. Such a lease is not an unowned pool slot: never
 * sweep/recycle it into a second bot. Trading rows with a durable V3 key can
 * safely finish the registry handoff; keyed AI rows stay reserving so the
 * idempotent go-live route can re-check funding and atomically finish. Every
 * malformed or multiply-linked case is quarantined under the exact claim token.
 */
async function reconcileLinkedReservation(
  row: ProtocolSubaccount,
): Promise<'unlinked' | 'handled'> {
  const subId = row.protocolSubaccountId;
  const claimToken = row.claimToken;
  if (!subId || !claimToken) {
    console.warn(`${LOG} reservation id=${row.id} has no exact claim identity â€” leaving fail-closed`);
    return 'handled';
  }

  let tradingLinks: Awaited<ReturnType<typeof storage.getTradingBots>>;
  let aiLinks: Awaited<ReturnType<typeof storage.getAiTraderBotsByWallet>>;
  try {
    [tradingLinks, aiLinks] = await Promise.all([
      storage.getTradingBots(row.walletAddress),
      storage.getAiTraderBotsByWallet(row.walletAddress),
    ]);
  } catch (err: any) {
    console.warn(`${LOG} could not inspect durable links for ${subId} â€” deferring: ${err?.message || err}`);
    return 'handled';
  }

  const matchingTrading = tradingLinks.filter((bot) => bot.protocolSubaccountId === subId);
  const matchingAi = aiLinks.filter((bot) => bot.protocolSubaccountId === subId);
  const linkCount = matchingTrading.length + matchingAi.length;
  if (linkCount === 0) return 'unlinked';

  const quarantine = async (reason: string) => {
    await storage.markSubaccountStuckFunds({
      walletAddress: row.walletAddress,
      protocol: row.protocol,
      protocolSubaccountId: subId,
      botId: matchingTrading.length === 1 ? matchingTrading[0].id : null,
      agentPublicKey: row.agentPublicKey,
      lastError: reason,
      claimToken,
    });
  };

  if (linkCount !== 1) {
    await quarantine('lease-recovery: reservation has multiple durable owners');
    return 'handled';
  }

  if (matchingTrading.length === 1) {
    const bot = matchingTrading[0];
    if (
      bot.activeProtocol === row.protocol &&
      bot.subaccountAuthMode === 'external_key' &&
      bot.botSubaccountKeyEncryptedV3
    ) {
      const finalized = await storage.finalizeReusedSubaccount({
        protocol: row.protocol,
        protocolSubaccountId: subId,
        claimToken,
        botId: bot.id,
        // Recovery cannot promote a non-terminal/unknown owner to executable.
        // The original creator can later adopt the same-owner finalization and
        // atomically promote it after re-verifying its funding verdict.
        terminalSubaccountStatus: bot.subaccountStatus === 'active' ? 'active' : 'error',
      });
      console.log(`${LOG} reconciled keyed trading-bot reservation ${subId}${finalized ? ' â†’ active' : ' (CAS no-op)'}`);
      return 'handled';
    }
    await quarantine('lease-recovery: trading-bot linkage is not durably keyed');
    return 'handled';
  }

  const aiBot = matchingAi[0];
  if (
    aiBot.protocol === row.protocol &&
    aiBot.paperMode === true &&
    aiBot.botSubaccountKeyEncryptedV3
  ) {
    console.warn(`${LOG} keyed AI go-live reservation ${subId} awaits idempotent route resume`);
    return 'handled';
  }
  await quarantine('lease-recovery: AI linkage is not a resumable keyed paper bot');
  return 'handled';
}

/**
 * Attempt to move all funds out of a funded reserved subaccount back to the agent
 * main account so the slot can be re-pooled. Returns:
 *   'swept' — transfer succeeded AND the subaccount now reads verified-empty.
 *   'stuck' — the sweep itself could not complete (no key, sub-min dust, transfer
 *             failed/threw) — funds genuinely still in the subaccount ⇒ quarantine.
 *   'defer' — transfer succeeded but indexing hasn't settled (or the UMK wasn't
 *             available to attempt the sweep) — leave the row reserving and retry
 *             next cycle; never quarantine a transient state.
 */
async function sweepReservedSubaccountToMain(
  adapter: ReturnType<typeof getDefaultAdapter>,
  row: ProtocolSubaccount,
  subId: string,
  agentPub: string,
): Promise<SweepOutcome> {
  if (!row.subaccountKeyEncryptedV3 || row.aadVersion == null) {
    console.error(`${LOG} reserved ${subId} is funded but has no retained key — cannot sweep, quarantining`);
    return 'stuck';
  }

  // The sweep needs the user's UMK to decrypt both the agent key (for the
  // wallet/pubkey check) and the retained subaccount key (to sign the transfer).
  // Reuse only ever claims execution-enabled wallets, so getUmkForWebhook should
  // resolve the execution envelope without a live session. If it can't (rare,
  // transient), DEFER rather than quarantine — funds stay safe in the subaccount.
  const umkRes = await getUmkForWebhook(row.walletAddress);
  if (!umkRes) {
    console.warn(`${LOG} no UMK available for ${row.walletAddress.slice(0, 8)}… — deferring sweep of ${subId} to next cycle`);
    return 'defer';
  }

  let transferSucceeded = false;
  try {
    const wallet = await storage.getWallet(row.walletAddress);
    if (!wallet) {
      console.error(`${LOG} wallet ${row.walletAddress.slice(0, 8)}… not found — cannot sweep ${subId}`);
      return 'defer';
    }

    const subKey = decryptRetainedSubaccountKeyV3({
      umk: umkRes.umk,
      encryptedV3: row.subaccountKeyEncryptedV3,
      aadVersion: row.aadVersion,
      protocol: row.protocol,
      walletAddress: row.walletAddress,
      protocolSubaccountId: subId,
      legacyBotId: row.botId,
    });
    if (!subKey) {
      // Pubkey-verify failed or decrypt failed — never sign with a mismatched key.
      console.error(`${LOG} retained key decrypt/verify failed for ${subId} — quarantining`);
      return 'stuck';
    }

    try {
      const info = await adapter.getAccountInfo(agentPub, subId);
      const balance = info?.equity;
      if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
        console.warn(`${LOG} ${subId} returned an unreadable recovery balance â€” deferring`);
        return 'defer';
      }
      if (balance < adapter.minTransferAmount) {
        // Above the verify-empty dust threshold but below the exchange minimum
        // transfer — genuinely un-sweepable residual. Quarantine for follow-up.
        console.warn(`${LOG} ${subId} holds $${balance.toFixed(6)} (< $${adapter.minTransferAmount} min transfer) — cannot sweep, quarantining`);
        return 'stuck';
      }

      console.log(`${LOG} sweeping $${balance.toFixed(4)} from reserved subaccount ${subId} → main`);
      const transfer = await adapter.transferBetweenSubaccounts({
        agentSecretKey: subKey.secretKey,
        mainWalletAddress: agentPub,
        fromSubaccountId: subId,
        toSubaccountId: agentPub,
        amount: balance,
      });
      if (!transfer.success) {
        console.error(`${LOG} subaccount→main transfer failed for ${subId}: ${transfer.error} — quarantining`);
        return 'stuck';
      }
      transferSucceeded = true;
    } finally {
      subKey.cleanup();
    }
  } catch (err: any) {
    console.error(`${LOG} sweep threw for ${subId}: ${err?.message || err} — quarantining`);
    return 'stuck';
  } finally {
    try { umkRes.cleanup(); } catch { /* best-effort */ }
  }

  if (!transferSucceeded) return 'stuck';

  // §7.1 indexing wait: poll verify-empty until the transfer is reflected. If it
  // settles, the slot is poolable; if not within budget, DEFER (the transfer
  // already succeeded — funds are safe in main and the next cycle will pool it).
  for (const waitMs of SWEEP_INDEX_POLL_SCHEDULE_MS) {
    await sleep(waitMs);
    try {
      if (await adapter.verifySubaccountEmpty!({ agentPublicKey: agentPub, subaccountId: subId })) {
        return 'swept';
      }
    } catch (err: any) {
      console.warn(`${LOG} verify-empty poll failed for ${subId} (will keep polling): ${err?.message || err}`);
    }
  }
  console.warn(`${LOG} ${subId} swept to main but not yet verified-empty within ~90s — deferring pool to next cycle`);
  return 'defer';
}

// Exported for unit tests (decision-matrix coverage). Not part of the public job API.
export async function processExpiredReservation(
  adapter: ReturnType<typeof getDefaultAdapter>,
  row: ProtocolSubaccount,
): Promise<void> {
  const subId = row.protocolSubaccountId;
  const agentPub = row.agentPublicKey;
  const claimToken = row.claimToken;
  if (!subId || !agentPub || !claimToken) {
    console.warn(`${LOG} reserving row id=${row.id} missing exact lease identity — leaving fail-closed`);
    return;
  }
  const currentWallet = await storage.getWallet(row.walletAddress);
  if (!currentWallet || currentWallet.agentPublicKey !== agentPub) {
    await storage.markSubaccountStuckFunds({
      walletAddress: row.walletAddress,
      protocol: row.protocol,
      protocolSubaccountId: subId,
      botId: null,
      agentPublicKey: agentPub,
      lastError: 'lease-recovery: reservation belongs to a retired agent generation',
      claimToken: row.claimToken ?? undefined,
    });
    console.error(`${LOG} reservation ${subId} belongs to a retired agent generation — quarantined without transfer`);
    return;
  }
  // Only the active default adapter can verify/sweep its own protocol's slots.
  if (row.protocol !== adapter.protocolName) {
    return;
  }
  if (await reconcileLinkedReservation(row) === 'handled') return;

  // (a) Is the subaccount already empty? (create crashed before/without funding,
  // or after a transfer-fail that left funds in main — read-only, no key needed.)
  let isEmpty: boolean;
  try {
    isEmpty = await adapter.verifySubaccountEmpty!({ agentPublicKey: agentPub, subaccountId: subId });
  } catch (err: any) {
    // Read failure ⇒ unknown. Leave reserving and retry next cycle — never
    // quarantine or pool on an inconclusive read.
    console.warn(`${LOG} verify-empty failed for ${subId} (leaving reserving, retry next cycle): ${err?.message || err}`);
    return;
  }

  if (isEmpty) {
    // (b) Empty ⇒ return to the pool.
    await storage.markSubaccountVerifiedEmpty(row.protocol, subId);
    const released = await storage.releaseReservationToSpare({
      protocol: row.protocol,
      protocolSubaccountId: subId,
      claimToken,
    });
    console.log(`${LOG} reclaimed expired reservation ${subId} → spare${released ? '' : ' (CAS no-op — row changed concurrently)'}`);
    return;
  }

  // (c)/(d) Funded ⇒ sweep first, re-verify, then pool; quarantine only if the
  // sweep itself fails.
  console.log(`${LOG} expired reservation ${subId} is funded — sweeping before reclaim`);
  const outcome = await sweepReservedSubaccountToMain(adapter, row, subId, agentPub);
  if (outcome === 'swept') {
    await storage.markSubaccountVerifiedEmpty(row.protocol, subId);
    const released = await storage.releaseReservationToSpare({
      protocol: row.protocol,
      protocolSubaccountId: subId,
      claimToken,
    });
    console.log(`${LOG} swept + reclaimed expired reservation ${subId} → spare${released ? '' : ' (CAS no-op — row changed concurrently)'}`);
  } else if (outcome === 'stuck') {
    await storage.markSubaccountStuckFunds({
      walletAddress: row.walletAddress,
      protocol: row.protocol,
      protocolSubaccountId: subId,
      botId: null,
      agentPublicKey: agentPub,
      lastError: 'lease-recovery: funded reservation could not be swept back to main',
      // CAS-guard on our claim token: if the original create finalized this slot
      // mid-flight (active by another owner), do NOT clobber it (§5.1.4).
      claimToken,
    });
    console.error(`${LOG} quarantined ${subId} as stuck_funds (sweep failed)`);
  } else {
    // 'defer' — leave the row reserving; the next cycle re-evaluates it.
    console.warn(`${LOG} deferring ${subId} (sweep transient) — will retry next cycle`);
  }
}

async function processExpiredFlashReservation(
  adapter: import('./protocol/flash/flash-adapter').FlashAdapter,
  row: ProtocolSubaccount,
): Promise<void> {
  const subId = row.protocolSubaccountId;
  const agentPub = row.agentPublicKey;
  const claimToken = row.claimToken;
  if (!subId || !agentPub || !claimToken) {
    console.warn(`${LOG} malformed Flash reservation id=${row.id} — leaving fail-closed for operator review`);
    return;
  }
  const quarantine = async (reason: string) => {
    await storage.markSubaccountStuckFunds({
      walletAddress: row.walletAddress,
      protocol: row.protocol,
      protocolSubaccountId: subId,
      botId: null,
      agentPublicKey: agentPub,
      lastError: reason,
      claimToken,
    });
  };

  const wallet = await storage.getWallet(row.walletAddress);
  if (!wallet || wallet.agentPublicKey !== agentPub) {
    await quarantine('lease-recovery: Flash reservation belongs to a retired agent generation');
    return;
  }
  if (await reconcileLinkedReservation(row) === 'handled') return;

  let beforeUsdc: number;
  let beforeSol: number;
  try {
    [beforeUsdc, beforeSol] = await Promise.all([
      adapter.getWalletCollateralBalanceStrict(subId),
      adapter.getWalletSolBalance(subId),
    ]);
  } catch (err: any) {
    console.warn(`${LOG} Flash reservation ${subId} unreadable — deferring: ${err?.message || err}`);
    return;
  }
  if (
    !Number.isFinite(beforeUsdc) || beforeUsdc < 0 ||
    !Number.isFinite(beforeSol) || beforeSol < 0
  ) {
    console.warn(`${LOG} Flash reservation ${subId} returned malformed balances — deferring`);
    return;
  }
  if (beforeUsdc === 0 && beforeSol <= 0.001) {
    await storage.deleteReservedSubaccount({ protocol: row.protocol, protocolSubaccountId: subId, claimToken });
    return;
  }

  if (!row.subaccountKeyEncryptedV3 || row.aadVersion == null) {
    await quarantine('lease-recovery: funded Flash reservation has no retained key');
    return;
  }
  const umkRes = await getUmkForWebhook(row.walletAddress);
  if (!umkRes) {
    console.warn(`${LOG} no UMK available for Flash reservation ${subId} — deferring`);
    return;
  }
  try {
    const subKey = decryptRetainedSubaccountKeyV3({
      umk: umkRes.umk,
      encryptedV3: row.subaccountKeyEncryptedV3,
      aadVersion: row.aadVersion,
      protocol: row.protocol,
      walletAddress: row.walletAddress,
      protocolSubaccountId: subId,
      legacyBotId: row.botId,
    });
    if (!subKey) {
      await quarantine('lease-recovery: Flash retained key decrypt/verify failed');
      return;
    }
    try {
      const swept = await adapter.sweepBotWallet({
        subSecretKey: subKey.secretKey,
        destWalletAddress: agentPub,
      });
      if (swept.error) {
        await quarantine('lease-recovery: Flash sweep failed');
        return;
      }
    } finally {
      subKey.cleanup();
    }
  } catch (err: any) {
    console.error(`${LOG} Flash reservation sweep threw for ${subId}: ${err?.message || err}`);
    await quarantine('lease-recovery: Flash sweep threw');
    return;
  } finally {
    try { umkRes.cleanup(); } catch { /* noop */ }
  }

  try {
    const [afterUsdc, afterSol] = await Promise.all([
      adapter.getWalletCollateralBalanceStrict(subId),
      adapter.getWalletSolBalance(subId),
    ]);
    if (
      !Number.isFinite(afterUsdc) || afterUsdc < 0 ||
      !Number.isFinite(afterSol) || afterSol < 0
    ) {
      console.warn(`${LOG} Flash post-sweep balances malformed for ${subId} — deferring`);
      return;
    }
    if (afterUsdc === 0 && afterSol <= 0.001) {
      await storage.deleteReservedSubaccount({ protocol: row.protocol, protocolSubaccountId: subId, claimToken });
      return;
    }
    await quarantine('lease-recovery: Flash residual remained after sweep');
  } catch (err: any) {
    console.warn(`${LOG} Flash post-sweep verification unreadable for ${subId} — deferring: ${err?.message || err}`);
  }
}

// Exported for unit tests. Not part of the public job API.
export async function runLeaseRecoveryOnce(): Promise<void> {
  const expired = await storage.findExpiredReservations(LEASE_TTL_MS);
  if (expired.length === 0) return;

  console.log(`${LOG} processing ${expired.length} expired reservation(s)`);
  // Sequential on purpose: each row does on-chain reads/transfers and the funded
  // path sleeps for the indexing wait. Throughput is irrelevant (rare event); we
  // care about not hammering the RPC / Pacifica rate budget.
  for (const row of expired) {
    try {
      // Resolve the adapter for THIS row's own protocol, not the global default.
      // A reservation can only be verified/swept/pooled by its own protocol's
      // adapter; routing it through whatever happens to be the default would read
      // the wrong venue. Today only Pacifica is recyclable, but this keeps the job
      // correct if the default changes or a second recyclable protocol is added.
      let adapter;
      try {
        adapter = getAdapter(row.protocol);
      } catch {
        console.warn(`${LOG} no adapter registered for protocol "${row.protocol}" (reservation ${row.protocolSubaccountId}) — skipping`);
        continue;
      }
      if (adapter.protocolName === 'flash') {
        await processExpiredFlashReservation(
          adapter as import('./protocol/flash/flash-adapter').FlashAdapter,
          row,
        );
        continue;
      }
      // Recycling only applies to adapters that implement the full lifecycle. If
      // this row's adapter can't verify/sweep, there's nothing safe to do for it.
      if (adapter.subaccountCaps?.recyclable !== true || typeof adapter.verifySubaccountEmpty !== 'function') {
        console.warn(`${LOG} adapter "${row.protocol}" is not recyclable — skipping reservation ${row.protocolSubaccountId}`);
        continue;
      }
      await processExpiredReservation(adapter, row);
    } catch (err: any) {
      console.error(`${LOG} failed processing reservation id=${row.id} (${row.protocolSubaccountId}): ${err?.message || err}`);
    }
  }
}

let started = false;

export function startSubaccountLeaseRecoveryJob(): void {
  if (started) return;
  started = true;
  console.log(`${LOG} starting lease-recovery job (TTL=${LEASE_TTL_MS / 60000}m, every ${RUN_INTERVAL_MS / 60000}m)`);

  const safeRun = async (label: string) => {
    try {
      await runLeaseRecoveryOnce();
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('Authentication timed out') || msg.includes('connection timeout') || msg.includes('timeout exceeded') || msg.includes('too many clients') || msg.includes('Connection terminated')) {
        console.warn(`${LOG} DB timeout on ${label} run — will retry next cycle`);
      } else {
        console.error(`${LOG} ${label} run failed: ${msg}`);
      }
    }
  };

  setTimeout(() => { void safeRun('initial'); }, INITIAL_DELAY_MS);
  setInterval(() => { void safeRun('periodic'); }, RUN_INTERVAL_MS);
}
