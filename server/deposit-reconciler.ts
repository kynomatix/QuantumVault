import { Connection, PublicKey } from '@solana/web3.js';
import { storage } from './storage';

const SOLANA_ENV = (process.env.DRIFT_ENV || process.env.SOLANA_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = SOLANA_ENV === 'mainnet-beta';

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const USDC_MINT = IS_MAINNET ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (IS_MAINNET && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
}

let connection: Connection | null = null;
function getConnection(): Connection {
  if (!connection) connection = new Connection(getRpcUrl(), 'confirmed');
  return connection;
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

const SCAN_LIMIT = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SCANNED_CACHE_MAX = 2000; // bounded LRU per wallet, prevents reparsing non-deposit txs

const lastRunAt = new Map<string, number>();
const inFlight = new Map<string, Promise<{ inserted: number }>>();
const scannedSignatures = new Map<string, Set<string>>(); // wallet -> set of sigs already inspected

function rememberScanned(wallet: string, sig: string): void {
  let set = scannedSignatures.get(wallet);
  if (!set) {
    set = new Set();
    scannedSignatures.set(wallet, set);
  }
  if (set.size >= SCANNED_CACHE_MAX) {
    // Drop oldest ~10% to keep bounded; Set preserves insertion order.
    const dropCount = Math.floor(SCANNED_CACHE_MAX / 10);
    const it = set.values();
    for (let i = 0; i < dropCount; i++) {
      const v = it.next().value;
      if (v === undefined) break;
      set.delete(v);
    }
  }
  set.add(sig);
}

/**
 * Scans the agent wallet's USDC ATA for incoming transfers from the user's main
 * wallet that are not yet recorded as `agent_deposit` equity events. Inserts the
 * missing events. Idempotent (matches by tx signature against the full table).
 *
 * This exists because the original deposit flow recorded the equity event from
 * the client AFTER the on-chain confirmation. Any failure of that POST (network
 * blip, page refresh, deposit made outside the app) left the deposit unrecorded,
 * which made the portfolio chart treat the new balance as profit.
 *
 * Safety properties:
 * - Per-wallet in-process mutex prevents concurrent runs from racing.
 * - Per-signature DB lookup (`getEquityEventByTxSignature`) catches duplicates
 *   regardless of how old the original event is.
 * - In-memory scanned-signature cache (bounded LRU per wallet) prevents
 *   re-parsing non-deposit transactions on every cache miss.
 */
export async function reconcileWalletDeposits(walletAddress: string): Promise<{ inserted: number }> {
  const last = lastRunAt.get(walletAddress);
  if (last && Date.now() - last < CACHE_TTL_MS) return { inserted: 0 };

  // Coalesce concurrent callers (snapshot job + portfolio endpoint) onto one run.
  const existing = inFlight.get(walletAddress);
  if (existing) return existing;

  const run = (async (): Promise<{ inserted: number }> => {
    let inserted = 0;
    try {
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet?.agentPublicKey) return { inserted: 0 };

      const userPubkey = new PublicKey(walletAddress);
      const agentPubkey = new PublicKey(wallet.agentPublicKey);
      const usdcMint = new PublicKey(USDC_MINT);
      const userUsdcAta = ata(usdcMint, userPubkey).toString();
      const agentUsdcAta = ata(usdcMint, agentPubkey);
      const agentAtaStr = agentUsdcAta.toString();

      const conn = getConnection();
      const sigs = await conn.getSignaturesForAddress(agentUsdcAta, { limit: SCAN_LIMIT }, 'confirmed');
      if (sigs.length === 0) return { inserted: 0 };

      const scanned = scannedSignatures.get(walletAddress) ?? new Set<string>();
      const candidates = sigs.filter(s => !s.err && !scanned.has(s.signature));
      if (candidates.length === 0) return { inserted: 0 };

      for (const s of candidates) {
        try {
          // DB-level dedupe: catches anything ever recorded for this signature.
          const existingEvent = await storage.getEquityEventByTxSignature(s.signature);
          if (existingEvent) {
            rememberScanned(walletAddress, s.signature);
            continue;
          }

          const tx = await conn.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (!tx?.meta) {
            // Don't remember — RPC may be temporarily unable to fetch this tx; retry later.
            continue;
          }

          const pre = tx.meta.preTokenBalances ?? [];
          const post = tx.meta.postTokenBalances ?? [];

          let agentDelta = 0;
          let userDelta = 0;
          const accountKeys = tx.transaction.message.accountKeys.map(k =>
            typeof k === 'string' ? k : k.pubkey.toString(),
          );

          for (let i = 0; i < accountKeys.length; i++) {
            const key = accountKeys[i];
            if (key !== agentAtaStr && key !== userUsdcAta) continue;
            const preBal = pre.find(b => b.accountIndex === i && b.mint === USDC_MINT);
            const postBal = post.find(b => b.accountIndex === i && b.mint === USDC_MINT);
            const preAmt = preBal ? Number(preBal.uiTokenAmount.uiAmount ?? 0) : 0;
            const postAmt = postBal ? Number(postBal.uiTokenAmount.uiAmount ?? 0) : 0;
            const delta = postAmt - preAmt;
            if (key === agentAtaStr) agentDelta = delta;
            else if (key === userUsdcAta) userDelta = delta;
          }

          // Mark as scanned regardless of outcome — the parsed tx is conclusive.
          rememberScanned(walletAddress, s.signature);

          // External deposit: agent ATA up, user main ATA down by the same amount.
          // Excludes Pacifica/exchange withdrawals (no user ATA involvement) and
          // any other internal movement.
          if (agentDelta <= 0) continue;
          if (userDelta >= 0) continue;
          if (Math.abs(agentDelta + userDelta) > 0.01) continue;

          // Task 119: persist the on-chain confirmation time so historical
          // snapshots can attribute this deposit to when it actually happened,
          // not to when we discovered it (which can be weeks later and would
          // otherwise show up as a phantom P&L drop on the chart).
          const blockTime = s.blockTime != null ? new Date(s.blockTime * 1000) : null;
          await storage.createEquityEvent({
            walletAddress,
            eventType: 'agent_deposit',
            amount: String(agentDelta),
            assetType: 'USDC',
            txSignature: s.signature,
            txBlockTime: blockTime,
            notes: 'Reconciled from on-chain history',
          });
          inserted++;
        } catch (err) {
          console.warn(`[DepositReconciler] Skipped signature ${s.signature.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
          // Don't remember — let it retry on the next run.
        }
      }

      if (inserted > 0) {
        console.log(`[DepositReconciler] Wallet ${walletAddress.slice(0, 8)}…: backfilled ${inserted} missing deposit(s)`);
        // Task 119: a late deposit insertion changes the flow history that
        // historical snapshots were computed against. Recompute this wallet's
        // snapshots so the chart's prior days reflect the corrected flow
        // timeline instead of showing a sudden "correction" at the next live
        // point. Fire-and-forget — failures only delay the recompute to the
        // next reconciler run.
        import('./portfolio-snapshot-backfill').then(({ recomputeWalletSnapshots }) => {
          recomputeWalletSnapshots(walletAddress).catch(err =>
            console.warn(`[DepositReconciler] Snapshot recompute failed for ${walletAddress.slice(0, 8)}…:`, err)
          );
        }).catch(() => { /* dynamic import errors are non-fatal */ });
      }
      lastRunAt.set(walletAddress, Date.now());
    } catch (err) {
      console.error(`[DepositReconciler] Failed for ${walletAddress.slice(0, 8)}…:`, err);
      // Don't update lastRunAt on failure so the next call retries.
    }
    return { inserted };
  })();

  inFlight.set(walletAddress, run);
  try {
    return await run;
  } finally {
    inFlight.delete(walletAddress);
  }
}
