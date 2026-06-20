/**
 * Vault gas auto-funding.
 *
 * A vault park/unpark is signed and paid by the SCOPE wallet (the shared account
 * agent for an account vault, or a bot's own per-bot wallet for a per-bot vault).
 * That wallet needs a little SOL for the tx fee plus, the first time, the rent of
 * the destination token account. A freshly funded per-bot wallet often holds just
 * enough SOL to trade and not enough to also open a yield-token account, so the
 * old fixed 0.01 SOL floor blocked the park with a dead-end error toast.
 *
 * This module makes gas hands-off. Before the on-chain leg runs, `ensureVaultGas`:
 *   1. computes the EXACT required lamports (fee buffer + ATA rent only if missing),
 *   2. tops the paying wallet up to that bar by moving SOL from the account agent
 *      (the "funder"), and
 *   3. if the funder itself is short on SOL, acquires SOL by swapping the funder's
 *      OWN USDC -> SOL (never the bot's USDC).
 *
 * Money-safety:
 *  - On-chain balances are the source of truth. Every step re-reads the chain and
 *    fails closed if the paying wallet still falls short.
 *  - The only hard failure is the true chicken-and-egg boundary: the funder has
 *    neither enough SOL to pay a swap fee nor any USDC to sell. Then a human must
 *    add a little SOL or USDC to the account wallet.
 *  - The bot's trading capital (its USDC) is never touched to pay for gas.
 *  - A SOL transfer is confirmed within its blockhash lifetime; if a retry happens
 *    while one is still in flight, the retry waits on that transfer instead of
 *    sending a duplicate, so the funder can never double-fund the bot.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getServerConnection,
  computeRequiredGasLamports,
  resolveAgentKeypair,
  executeAgentSwap,
  getAgentTokenBalanceRaw,
  GAS_FEE_BUFFER_LAMPORTS,
  USDC_MINT,
  NATIVE_SOL_MINT,
} from "../agent-wallet";
import { VAULT_MAX_PRICE_IMPACT } from "./yield-routes";
import { getBestQuote } from "../swap/index.js";

/** Overshoot the SOL we buy by 20% so price/slippage drift can't leave us short. */
const SOL_REFILL_OVERBUY = 1.2;
/** Default slippage for the tiny USDC -> SOL gas refill swap. */
const REFILL_SLIPPAGE_BPS = 100;
/** Bounded retry: a single swap may be USDC- or price-clamped and fall short. */
const MAX_REFILL_ATTEMPTS = 2;
/** Cap the in-call confirm wait so the synchronous park/unpark route isn't reaped. */
const TRANSFER_CONFIRM_MAX_MS = 45_000;
const TRANSFER_POLL_INTERVAL_MS = 1500;

export interface EnsureVaultGasParams {
  /** Wallet that signs & pays the vault op (a bot wallet, or the account agent). */
  payingPublicKey: string;
  /** Wallet that backstops gas: the shared account agent. May equal the payer. */
  funderPublicKey: string;
  /** Funder's decrypted secret key — signs the SOL transfer and any USDC->SOL swap. */
  funderSecretKey: Uint8Array;
  /** Destination mint of the op (park: yield token; unpark: USDC). Drives ATA rent. */
  destMint: string | null;
  /** Short label for error messages, e.g. "Park" / "Unpark". */
  label: string;
}

export interface EnsureVaultGasResult {
  ok: boolean;
  requiredLamports: number;
  payerLamportsBefore: number;
  /** SOL moved into the paying wallet from the funder. */
  fundedLamports?: number;
  transferSignature?: string;
  /** SOL the funder acquired by selling USDC, when a refill was needed. */
  refilledLamports?: number;
  refillSignature?: string;
  error?: string;
}

type TransferOutcome = "confirmed" | "failed" | "pending";

/**
 * In-flight funder->payer SOL transfers, keyed by `${from}:${to}`. A retry for the
 * same pair waits on an existing transfer instead of sending a duplicate; because a
 * transfer's blockhash bounds how long it can ever land, this fully prevents
 * double-funding even under RPC delay.
 */
const pendingTransfers = new Map<string, { signature: string; lastValidBlockHeight: number }>();

/**
 * Make sure the paying wallet holds enough SOL for the upcoming vault op. Returns
 * `ok: true` only when the chain confirms the wallet now meets the required bar.
 */
export async function ensureVaultGas(p: EnsureVaultGasParams): Promise<EnsureVaultGasResult> {
  const connection = getServerConnection();
  const payer = new PublicKey(p.payingPublicKey);
  const sameWallet = p.payingPublicKey === p.funderPublicKey;

  const requiredLamports = await computeRequiredGasLamports(connection, payer, p.destMint);
  const payerLamportsBefore = await connection.getBalance(payer);
  if (payerLamportsBefore >= requiredLamports) {
    return { ok: true, requiredLamports, payerLamportsBefore };
  }

  const shortfall = requiredLamports - payerLamportsBefore;

  // CASE A: the payer IS the funder (account vault). There is no second wallet to
  // pull from, so the wallet must raise its OWN SOL by selling some of its USDC.
  if (sameWallet) {
    const refill = await refillFunderSol(connection, p, requiredLamports);
    if (!refill.ok) {
      return { ok: false, requiredLamports, payerLamportsBefore, error: refill.error };
    }
    const after = await connection.getBalance(payer);
    if (after < requiredLamports) {
      return {
        ok: false,
        requiredLamports,
        payerLamportsBefore,
        refilledLamports: refill.acquiredLamports,
        refillSignature: refill.signature,
        error: `${p.label}: gas top-up fell short (have ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL, need ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(4)}). Please retry.`,
      };
    }
    return {
      ok: true,
      requiredLamports,
      payerLamportsBefore,
      refilledLamports: refill.acquiredLamports,
      refillSignature: refill.signature,
    };
  }

  // CASE B: per-bot vault. The account agent (funder) transfers the EXACT SOL
  // shortfall to the bot wallet. The funder needs the shortfall plus its own tx
  // fee; if it is short on SOL for that, it first sells ITS OWN USDC for SOL.
  const funderNeed = shortfall + GAS_FEE_BUFFER_LAMPORTS;
  const pendKey = `${p.funderPublicKey}:${p.payingPublicKey}`;

  // Idempotent retry: if a prior attempt left a transfer in flight for this exact
  // funder->payer pair, wait on IT rather than sending another transfer.
  const pending = pendingTransfers.get(pendKey);
  if (pending) {
    const outcome = await awaitTransferOutcome(connection, pending.signature, pending.lastValidBlockHeight, TRANSFER_CONFIRM_MAX_MS);
    if (outcome !== "pending") pendingTransfers.delete(pendKey);
    const payerNow = await connection.getBalance(payer);
    if (payerNow >= requiredLamports) {
      return { ok: true, requiredLamports, payerLamportsBefore, fundedLamports: shortfall, transferSignature: pending.signature };
    }
    if (outcome === "pending") {
      return {
        ok: false,
        requiredLamports,
        payerLamportsBefore,
        transferSignature: pending.signature,
        error: `${p.label}: a previous gas top-up is still confirming. Please retry in a moment.`,
      };
    }
    // failed/expired: fall through and start fresh.
  }

  let funderLamports = await connection.getBalance(new PublicKey(p.funderPublicKey));
  let refilledLamports: number | undefined;
  let refillSignature: string | undefined;
  if (funderLamports < funderNeed) {
    const refill = await refillFunderSol(connection, p, funderNeed);
    if (!refill.ok) {
      return { ok: false, requiredLamports, payerLamportsBefore, error: refill.error };
    }
    refilledLamports = refill.acquiredLamports;
    refillSignature = refill.signature;
    funderLamports = await connection.getBalance(new PublicKey(p.funderPublicKey));
    if (funderLamports < funderNeed) {
      return {
        ok: false,
        requiredLamports,
        payerLamportsBefore,
        refilledLamports,
        refillSignature,
        error: `${p.label}: could not raise enough SOL on the account wallet to fund bot gas. Please retry.`,
      };
    }
  }

  const transfer = await transferSol(connection, p.funderSecretKey, p.funderPublicKey, p.payingPublicKey, shortfall);
  if (transfer.outcome === "failed") {
    return { ok: false, requiredLamports, payerLamportsBefore, refilledLamports, refillSignature, error: `${p.label}: ${transfer.error || "gas transfer failed"}` };
  }

  // On-chain truth: re-read the payer. If the transfer is still pending (rare), the
  // payer will read short here and we fail closed; the retry waits on the in-flight
  // transfer above instead of sending a second one.
  const payerAfter = await connection.getBalance(payer);
  if (payerAfter < requiredLamports) {
    return {
      ok: false,
      requiredLamports,
      payerLamportsBefore,
      fundedLamports: shortfall,
      transferSignature: transfer.signature,
      refilledLamports,
      refillSignature,
      error: `${p.label}: bot gas top-up did not confirm in time. Please retry.`,
    };
  }
  return {
    ok: true,
    requiredLamports,
    payerLamportsBefore,
    fundedLamports: shortfall,
    transferSignature: transfer.signature,
    refilledLamports,
    refillSignature,
  };
}

/**
 * Sell some of the FUNDER's USDC for native SOL until the funder's on-chain balance
 * reaches `goalLamports`. The realized native lamport delta (after the swap's own
 * fee) is the source of truth, so sizing targets gross output = (net needed + a fee
 * budget) * overbuy and a bounded retry covers any single-swap shortfall. Fails
 * closed at the true chicken-and-egg boundary: no SOL to pay the swap fee, or no
 * USDC to sell.
 */
async function refillFunderSol(
  connection: Connection,
  p: EnsureVaultGasParams,
  goalLamports: number,
): Promise<{ ok: true; signature?: string; acquiredLamports: number } | { ok: false; error: string }> {
  const funderPk = new PublicKey(p.funderPublicKey);
  let lastSignature: string | undefined;
  let acquired = 0;

  for (let attempt = 0; attempt < MAX_REFILL_ATTEMPTS; attempt++) {
    const funderSol = await connection.getBalance(funderPk);
    if (funderSol >= goalLamports) {
      return { ok: true, signature: lastSignature, acquiredLamports: acquired };
    }

    // The funder must hold enough SOL to pay the swap's OWN fee. If it has none,
    // nothing server-side can bootstrap it — a human must add a little SOL.
    if (funderSol < GAS_FEE_BUFFER_LAMPORTS) {
      return {
        ok: false,
        error: `${p.label}: the account wallet has no SOL to buy gas with. Please add a little SOL to your account wallet.`,
      };
    }

    const usdcBal = await getAgentTokenBalanceRaw(p.funderPublicKey, USDC_MINT);
    const usdcRawFull = BigInt(usdcBal.amountRaw);
    if (usdcRawFull <= BigInt(0)) {
      return {
        ok: false,
        error: `${p.label}: the account wallet is out of SOL and has no spare USDC to cover gas. Please add a little SOL or USDC to your account wallet.`,
      };
    }

    // Derive lamports-per-USDC-unit from a fresh quote on the full balance.
    const probe = await getBestQuote({
      inputMint: USDC_MINT,
      outputMint: NATIVE_SOL_MINT,
      amountRaw: usdcRawFull.toString(),
      slippageBps: REFILL_SLIPPAGE_BPS,
    });
    if (!probe || !probe.outAmountRaw) {
      return { ok: false, error: `${p.label}: no USDC -> SOL route available to buy gas.` };
    }
    const lamportsPerUsdcUnit = Number(probe.outAmountRaw) / Number(usdcRawFull);
    if (!(lamportsPerUsdcUnit > 0)) {
      return { ok: false, error: `${p.label}: could not price USDC -> SOL to buy gas.` };
    }

    // Gross SOL we must buy: the net still needed PLUS a fee budget (the swap fee is
    // paid out of the same native balance and shrinks the realized delta), * overbuy.
    const netNeeded = goalLamports - funderSol;
    const grossWanted = (netNeeded + GAS_FEE_BUFFER_LAMPORTS) * SOL_REFILL_OVERBUY;
    let usdcToSell = BigInt(Math.ceil(grossWanted / lamportsPerUsdcUnit));
    if (usdcToSell <= BigInt(0)) usdcToSell = BigInt(1);
    if (usdcToSell > usdcRawFull) usdcToSell = usdcRawFull; // never sell more than we hold

    const swap = await executeAgentSwap({
      agentPublicKey: p.funderPublicKey,
      agentSecretKey: p.funderSecretKey,
      inputMint: USDC_MINT,
      outputMint: NATIVE_SOL_MINT,
      amountRaw: usdcToSell.toString(),
      slippageBps: REFILL_SLIPPAGE_BPS,
      maxPriceImpactPct: VAULT_MAX_PRICE_IMPACT,
    });
    if (!swap.success || !swap.outputReceivedRaw) {
      return { ok: false, error: `${p.label}: ${swap.error || "USDC -> SOL gas swap failed"}` };
    }
    lastSignature = swap.signature;
    acquired += Number(swap.outputReceivedRaw);
    // Loop re-reads the live balance; if this swap was clamped to the USDC held, the
    // next pass simply has no USDC left and fails closed below.
  }

  const finalSol = await connection.getBalance(funderPk);
  if (finalSol >= goalLamports) {
    return { ok: true, signature: lastSignature, acquiredLamports: acquired };
  }
  return {
    ok: false,
    error: `${p.label}: could not raise enough SOL from the account wallet's USDC to cover gas. Please add a little SOL to your account wallet.`,
  };
}

/**
 * Transfer `lamports` of native SOL from the funder to the paying wallet, signed by
 * the funder, and resolve its fate within the blockhash lifetime. Records the
 * in-flight signature so a concurrent/sequential retry for the same pair can wait
 * on it rather than sending a duplicate.
 */
async function transferSol(
  connection: Connection,
  funderSecretKey: Uint8Array,
  fromPubkeyStr: string,
  toPubkeyStr: string,
  lamports: number,
): Promise<{ outcome: TransferOutcome; signature?: string; error?: string }> {
  try {
    if (lamports <= 0) return { outcome: "failed", error: "nothing to transfer" };
    const funder = resolveAgentKeypair(funderSecretKey);
    const fromPubkey = new PublicKey(fromPubkeyStr);
    const toPubkey = new PublicKey(toPubkeyStr);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
    );
    tx.sign(funder);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    const pendKey = `${fromPubkeyStr}:${toPubkeyStr}`;
    pendingTransfers.set(pendKey, { signature, lastValidBlockHeight });
    const outcome = await awaitTransferOutcome(connection, signature, lastValidBlockHeight, TRANSFER_CONFIRM_MAX_MS);
    if (outcome !== "pending") pendingTransfers.delete(pendKey);
    return { outcome, signature };
  } catch (e: any) {
    return { outcome: "failed", error: e?.message || "gas transfer failed" };
  }
}

/**
 * Poll a transfer to a terminal verdict. "confirmed"/"finalized" => confirmed; an
 * on-chain error or a blockhash that has expired without confirming => failed (the
 * tx can never land, so a retry is safe). If neither happens within `maxMs`, returns
 * "pending" and the caller fails closed (the signature stays registered for retry).
 */
async function awaitTransferOutcome(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  maxMs: number,
): Promise<TransferOutcome> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status) {
      if (status.err) return "failed";
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // Blockhash expired. Re-check once for a race, then declare failed.
      const final = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (final && !final.err && (final.confirmationStatus === "confirmed" || final.confirmationStatus === "finalized")) {
        return "confirmed";
      }
      return "failed";
    }
    await new Promise((r) => setTimeout(r, TRANSFER_POLL_INTERVAL_MS));
  }
  return "pending";
}
