import { Connection, PublicKey } from "@solana/web3.js";
import { storage } from "./storage";
import { getDefaultAdapter, getAdapterForBot } from "./protocol/adapter-registry";
import type { ProtocolAdapter } from "./protocol/adapter";
import { reconcileWalletDeposits } from "./deposit-reconciler";
import { sumVaultPositionValueUsdc } from "./vault/vault-service";
import type { TradingBot, Wallet } from "@shared/schema";

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC_MINT = "8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const _IS_MAINNET = (process.env.DRIFT_ENV || process.env.SOLANA_ENV || "mainnet-beta") === "mainnet-beta";
const _USDC_MINT = new PublicKey(_IS_MAINNET ? MAINNET_USDC_MINT : DEVNET_USDC_MINT);

function _getSnapshotRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (_IS_MAINNET && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return _IS_MAINNET ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

let _snapshotConnection: Connection | null = null;
function _getSnapshotConnection(): Connection {
  if (!_snapshotConnection) _snapshotConnection = new Connection(_getSnapshotRpcUrl(), "confirmed");
  return _snapshotConnection;
}

function _getAgentUsdcAta(agentPublicKey: string): PublicKey {
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const owner = new PublicKey(agentPublicKey);
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), _USDC_MINT.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

/**
 * Resolves the correct (account, subaccountId) pair to query the perp adapter for a bot.
 * - Pacifica bots: protocolSubaccountId is a Solana keypair pubkey passed as `account`.
 * - Drift bots: wallet.agentPublicKey + numeric driftSubaccountId.
 * Returns null when neither path is viable (skip).
 */
function resolveBotAdapterArgs(bot: TradingBot, wallet: Wallet): { account: string; subaccountId?: string } | null {
  if (bot.subaccountAuthMode === 'external_key') {
    if (bot.subaccountStatus !== 'active' || !bot.protocolSubaccountId) return null;
    return { account: bot.protocolSubaccountId };
  }
  if (bot.subaccountAuthMode === 'main_plus_id') {
    if (!wallet.agentPublicKey || bot.driftSubaccountId == null) return null;
    return { account: wallet.agentPublicKey, subaccountId: _subIdStr(bot.driftSubaccountId) };
  }
  return null;
}

/**
 * Returns the bot's perp-account balance, or `null` if the read failed.
 *
 * Returning null (instead of swallowing the error as `0`) is critical for the
 * snapshot writer: a transient RPC/SDK failure that drops one bot's balance to
 * 0 used to get persisted as a real loss, producing phantom P&L drops on the
 * chart (e.g. AqTT 2026-05-15 00:00 totalBalance=$7.34 → $48.09 by 12:00).
 * The caller skips the snapshot when any read returns null and the next
 * scheduled run retries.
 */
async function getAccountBalance(account: string, subaccountId: string | undefined, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<number | null> {
  try {
    const info = await adapter.getAccountInfo(account, subaccountId);
    // Treat non-finite/NaN/undefined as failure — `|| 0` would hide a malformed
    // upstream response as a real zero balance and re-introduce phantom dips.
    if (typeof info.balance !== "number" || !Number.isFinite(info.balance)) return null;
    return info.balance;
  } catch {
    return null;
  }
}

/**
 * Strict variant of `getAgentUsdcBalance` for the snapshot writer.
 *
 * The shared helper in `agent-wallet.ts` swallows RPC errors and returns `0`
 * (many callers depend on that best-effort behavior). The snapshot writer
 * needs the opposite: distinguish "agent legitimately holds 0 USDC" from
 * "RPC failed". A 404 (no token account) is the only path that means real 0.
 */
async function getAgentSplBalance(agentPublicKey: string): Promise<number | null> {
  try {
    const ata = _getAgentUsdcAta(agentPublicKey);
    const conn = _getSnapshotConnection();
    // Deterministic existence check: if the ATA doesn't exist on chain the
    // agent legitimately holds 0 USDC. Only after we confirm the account
    // exists do we read the balance — that way provider-specific error
    // wording can never be misclassified as a "real zero".
    const acct = await conn.getAccountInfo(ata, "confirmed");
    if (acct === null) return 0;
    const result = await conn.getTokenAccountBalance(ata);
    const ui = result?.value?.uiAmount;
    if (typeof ui !== "number" || !Number.isFinite(ui)) return null;
    return ui;
  } catch {
    return null;
  }
}

const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000; // Every 12 hours (00:00 and 12:00 UTC)

export async function takePortfolioSnapshots(): Promise<void> {
  console.log("[Portfolio Snapshots] Starting 12-hour snapshot run...");
  
  try {
    const walletAddresses = await storage.getWalletsWithTradingBots();
    
    console.log(`[Portfolio Snapshots] Processing ${walletAddresses.length} wallets`);
    
    for (const walletAddress of walletAddresses) {
      try {
        await processWalletSnapshot(walletAddress);
      } catch (error) {
        console.error(`[Portfolio Snapshots] Error processing wallet ${walletAddress.slice(0, 8)}...`, error);
      }
    }
    
    console.log("[Portfolio Snapshots] Completed 12-hour snapshot run");
  } catch (error) {
    console.error("[Portfolio Snapshots] Fatal error during snapshot run:", error);
  }
}

/**
 * Task 119: shared balance aggregator. The portfolio endpoint and the snapshot
 * writer MUST sum across the same account universe (agent SPL + every bot's
 * own subaccount via the adapter) so the leaderboard (which reads from the
 * latest snapshot) agrees with the live portfolio number. Previously the
 * endpoint only queried agent subaccount 0 + external_key Pacifica bots and
 * missed main_plus_id Drift bots with subaccountId != 0, causing leaderboard
 * <-> portfolio drift.
 */
export async function computeWalletTotalBalance(
  walletAddress: string,
): Promise<{ totalBalance: number; activeBotCount: number; ok: boolean }> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return { totalBalance: 0, activeBotCount: 0, ok: true };

  const bots = await storage.getTradingBots(walletAddress);
  let totalBalance = 0;
  let activeBotCount = 0;
  let ok = true;

  if (wallet.agentPublicKey) {
    const spl = await getAgentSplBalance(wallet.agentPublicKey);
    if (spl == null) ok = false;
    else totalBalance += spl;

    // Parked ACCOUNT-vault funds are still the user's equity (idle USDC swapped
    // into a yield token off-exchange), just not on the agent wallet as USDC.
    // Count their live USD value or the totalBalance reads as a phantom loss.
    // Fail closed: an unreadable balance / unpriceable token skips the snapshot.
    const av = await sumVaultPositionValueUsdc(wallet.agentPublicKey);
    if (!av.ok) {
      ok = false;
      console.warn(`[computeWalletTotalBalance] account-vault valuation failed (wallet ${walletAddress.slice(0, 8)}…) — partial total only`);
    } else {
      totalBalance += av.valueUsdc;
    }
  }

  for (const bot of bots) {
    if (bot.isActive) activeBotCount++;
    const adapterArgs = resolveBotAdapterArgs(bot, wallet);
    if (!adapterArgs) continue;
    const adapter = getAdapterForBot(bot);
    const bal = await getAccountBalance(adapterArgs.account, adapterArgs.subaccountId, adapter);
    if (bal == null) {
      ok = false;
      console.warn(`[computeWalletTotalBalance] balance read failed for bot ${bot.id} (wallet ${walletAddress.slice(0, 8)}…) — partial total only`);
    } else {
      totalBalance += bal;
    }

    // Per-bot Vault: only independent_trader venues (Flash) park into the bot's
    // OWN wallet. Account-model venues (Pacifica/Drift) share the account vault
    // counted above, so don't re-read them here.
    if (adapter.subaccountCaps?.accountModel === 'independent_trader') {
      const bv = await sumVaultPositionValueUsdc(adapterArgs.account);
      if (!bv.ok) {
        ok = false;
        console.warn(`[computeWalletTotalBalance] per-bot vault valuation failed for bot ${bot.id} (wallet ${walletAddress.slice(0, 8)}…) — partial total only`);
      } else {
        totalBalance += bv.valueUsdc;
      }
    }
  }

  // Borrowed USDC is a LIABILITY, never equity. Subtract the wallet's open borrow
  // debt (our authoritative DB ledger, recorded conservatively at open) from the
  // total. Fail closed: if the debt is unreadable, mark the snapshot partial
  // rather than silently over-reporting equity by omitting a real liability.
  try {
    const borrowDebtUsd = await storage.sumOpenBorrowDebtUsdc(walletAddress);
    totalBalance -= borrowDebtUsd;
  } catch {
    ok = false;
    console.warn(`[computeWalletTotalBalance] borrow-debt read failed (wallet ${walletAddress.slice(0, 8)}…) — partial total only`);
  }

  return { totalBalance, activeBotCount, ok };
}

async function processWalletSnapshot(walletAddress: string): Promise<void> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return;

  const bots = await storage.getTradingBots(walletAddress);
  if (bots.length === 0) return;

  const { totalBalance, activeBotCount, ok } = await computeWalletTotalBalance(walletAddress);

  // Refuse to persist a snapshot built on a failed balance read. A single
  // bot returning 0 due to an RPC/SDK timeout used to write a phantom loss
  // (e.g. AqTT 2026-05-15 00:00 dropped to $7.34, recovered to $48.09 at the
  // next bucket). The next scheduled snapshot retries on fresh reads.
  if (!ok) {
    console.warn(`[Portfolio Snapshots] Skipping ${walletAddress.slice(0, 8)}… — at least one balance read failed; retry next cycle`);
    return;
  }

  // Backfill any deposits the client-side confirmation missed before reading totals.
  await reconcileWalletDeposits(walletAddress);
  const { totalTrades, totalVolume } = await storage.getWalletTradeStats(walletAddress);
  const creatorEarnings = await storage.getWalletCreatorEarnings(walletAddress);

  // Round to nearest 12-hour mark (00:00 or 12:00 UTC)
  const now = new Date();
  const snapshotTime = new Date(now);
  snapshotTime.setMinutes(0, 0, 0);
  const hour = snapshotTime.getUTCHours();
  if (hour < 12) {
    snapshotTime.setUTCHours(0);
  } else {
    snapshotTime.setUTCHours(12);
  }

  // Use as-of-snapshot cumulative flows (block-time aware) so a late-backfilled
  // deposit gets attributed to the snapshot when it actually happened.
  const { deposits, withdrawals, internalTransfers } =
    await storage.getWalletCumulativeDepositsWithdrawals(walletAddress, snapshotTime);

  const netExternalFlowCum = deposits - withdrawals;
  const tradingPnl = totalBalance - netExternalFlowCum;

  // Compute day's net external flow against the previous snapshot.
  const prev = await storage.getLatestPortfolioDailySnapshot(walletAddress);
  let prevCumExtDeposits = 0;
  let prevCumExtWithdrawals = 0;
  if (prev) {
    prevCumExtDeposits = parseFloat(prev.cumulativeExternalDeposits ?? prev.cumulativeDeposits);
    prevCumExtWithdrawals = parseFloat(prev.cumulativeExternalWithdrawals ?? prev.cumulativeWithdrawals);
  }
  const netExternalFlow = (deposits - prevCumExtDeposits) - (withdrawals - prevCumExtWithdrawals);

  // Task 119: simple lifetime ratio — trading PnL / cumulative external
  // deposits. Flow-neutral and matches the backfill + live endpoint.
  let pnlPercent = (tradingPnl / Math.max(deposits, 1)) * 100;
  if (pnlPercent > 1000) pnlPercent = 1000;
  if (pnlPercent < -100) pnlPercent = -100;

  // Keep legacy `netPnl` writing the same value as trading P&L for read-compat,
  // so any pre-Task-119 consumer still sees a coherent number.
  await storage.upsertPortfolioDailySnapshot({
    walletAddress,
    snapshotDate: snapshotTime,
    totalBalance: String(totalBalance),
    cumulativeDeposits: String(deposits),
    cumulativeWithdrawals: String(withdrawals),
    netPnl: String(tradingPnl),
    activeBotCount,
    totalTrades,
    totalVolume: String(totalVolume),
    creatorEarnings: String(creatorEarnings),
    cumulativeExternalDeposits: String(deposits),
    cumulativeExternalWithdrawals: String(withdrawals),
    cumulativeInternalTransfers: String(internalTransfers),
    cumulativeTradingPnl: String(tradingPnl),
    netExternalFlow: String(netExternalFlow),
    pnlPercent: String(pnlPercent),
  });

  console.log(`[Portfolio Snapshots] Saved snapshot for ${walletAddress.slice(0, 8)}...: balance=${totalBalance.toFixed(2)}, tradingPnl=${tradingPnl.toFixed(2)}, pnlPct=${pnlPercent.toFixed(2)}%, netFlow=${netExternalFlow.toFixed(2)}`);
}

export function startPortfolioSnapshotJob(): void {
  console.log("[Portfolio Snapshots] Starting snapshot job (12h interval, 00:00 and 12:00 UTC)");
  
  // Calculate time until next 00:00 or 12:00 UTC
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinutes = now.getUTCMinutes();
  
  let hoursUntilNext: number;
  if (currentHour < 12) {
    hoursUntilNext = 12 - currentHour;
  } else {
    hoursUntilNext = 24 - currentHour;
  }
  // Subtract current minutes to get exact time
  const msUntilNext = (hoursUntilNext * 60 - currentMinutes) * 60 * 1000;
  
  console.log(`[Portfolio Snapshots] Next snapshot in ${(msUntilNext / 3600000).toFixed(1)} hours`);
  
  // Take an initial snapshot after 5 seconds, then schedule at 00:00/12:00 UTC
  setTimeout(async () => {
    await takePortfolioSnapshots();
    
    // Schedule to run at next 00:00 or 12:00 UTC, then every 12 hours
    setTimeout(() => {
      takePortfolioSnapshots();
      setInterval(takePortfolioSnapshots, SNAPSHOT_INTERVAL_MS);
    }, msUntilNext);
  }, 5000);
}
