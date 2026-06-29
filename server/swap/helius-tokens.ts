/**
 * Lists the fungible tokens (with metadata + balances) held by a Solana wallet,
 * used to populate the "deposit any asset" picker.
 *
 * Primary source is the Helius DAS `getAssetsByOwner` RPC, which returns
 * balances, decimals, symbol, logo, and USD price in a SINGLE call — far cheaper
 * than per-mint metadata lookups. When HELIUS_API_KEY is unavailable we fall
 * back to the plain RPC token-account scan (no metadata: symbol = short mint).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getPrimaryRpcUrl } from './../rpc-config.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const FETCH_TIMEOUT_MS = 12_000;

export interface UserToken {
  mint: string;
  symbol: string;
  name: string;
  logoURI: string | null;
  decimals: number;
  amountRaw: string;
  amountUi: number;
  usdValue: number | null;
  /** True for native SOL (deposited via system transfer, not an SPL ATA move). */
  isNativeSol: boolean;
  /** USDC needs no swap — surfaced so the UI can route it to the plain deposit. */
  isUsdc: boolean;
}

function heliusUrl(): string | null {
  if (process.env.DRIFT_ENV !== 'devnet' && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return null;
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

async function fetchDasAssets(url: string, ownerAddress: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'qv-tokens',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress,
          page: 1,
          limit: 1000,
          displayOptions: { showFungible: true, showNativeBalance: true },
        },
      }),
    });
    if (!res.ok) throw new Error(`Helius DAS HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function mapDasResult(result: any): UserToken[] {
  const out: UserToken[] = [];

  // Accumulate SOL from BOTH native lamports AND any held wrapped-SOL (wSOL)
  // token account into ONE unified "SOL" row. wSOL is the same asset (1:1, 9
  // decimals) and the deposit path unwraps it transparently, so the user never
  // sees or manages "wSOL" — to them it is all just SOL.
  const native = result?.nativeBalance;
  const nativeLamports = native && Number(native.lamports) > 0 ? BigInt(native.lamports) : 0n;
  let solRaw = nativeLamports;
  // Sum USD across every contributing balance (native lamports + folded wSOL).
  // If ANY contributor lacks a numeric USD value, the combined total is unknown
  // (null) rather than a misleading partial sum that understates the row.
  let solUsd = 0;
  let solUsdKnown = true;
  if (nativeLamports > 0n) {
    if (typeof native.total_price === 'number') solUsd += native.total_price;
    else solUsdKnown = false;
  }

  for (const item of result?.items ?? []) {
    const ti = item?.token_info;
    if (!ti || !ti.balance || Number(ti.balance) <= 0) continue;
    const mint = item.id;
    if (mint === NATIVE_SOL_MINT) {
      // Fold wSOL into the unified SOL row instead of listing it separately.
      solRaw += BigInt(ti.balance);
      const wUsd = ti.price_info?.total_price;
      if (typeof wUsd === 'number') solUsd += wUsd;
      else solUsdKnown = false;
      continue;
    }
    const decimals = ti.decimals ?? 0;
    const amountRaw = String(ti.balance);
    const amountUi = Number(ti.balance) / Math.pow(10, decimals);
    out.push({
      mint,
      symbol: ti.symbol || item?.content?.metadata?.symbol || shortMint(mint),
      name: item?.content?.metadata?.name || ti.symbol || shortMint(mint),
      logoURI: item?.content?.links?.image || item?.content?.files?.[0]?.uri || null,
      decimals,
      amountRaw,
      amountUi,
      usdValue: ti.price_info?.total_price ?? null,
      isNativeSol: false,
      isUsdc: mint === USDC_MINT,
    });
  }

  if (solRaw > 0n) {
    out.push({
      mint: NATIVE_SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      logoURI: null,
      decimals: 9,
      amountRaw: solRaw.toString(),
      amountUi: Number(solRaw) / 1e9,
      usdValue: solUsdKnown ? solUsd : null,
      isNativeSol: true,
      isUsdc: false,
    });
  }

  // Highest USD value first; unknown values sink to the bottom.
  out.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
  return out;
}

async function fallbackRpcTokens(ownerAddress: string): Promise<UserToken[]> {
  const connection = new Connection(getPrimaryRpcUrl(), 'confirmed');
  const owner = new PublicKey(ownerAddress);

  const [lamports, parsed] = await Promise.all([
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
  ]);

  const out: UserToken[] = [];
  // Fold native lamports + any held wSOL into one unified "SOL" row (see
  // mapDasResult) so the wrapped nature stays abstracted from the user.
  let solRaw = lamports > 0 ? BigInt(lamports) : 0n;

  for (const { account } of parsed.value) {
    const info = account.data.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount || !tokenAmount.amount || Number(tokenAmount.amount) <= 0) continue;
    const mint = info.mint as string;
    if (mint === NATIVE_SOL_MINT) {
      solRaw += BigInt(tokenAmount.amount);
      continue;
    }
    out.push({
      mint,
      symbol: shortMint(mint),
      name: shortMint(mint),
      logoURI: null,
      decimals: tokenAmount.decimals ?? 0,
      amountRaw: String(tokenAmount.amount),
      amountUi: tokenAmount.uiAmount ?? 0,
      usdValue: null,
      isNativeSol: false,
      isUsdc: mint === USDC_MINT,
    });
  }

  if (solRaw > 0n) {
    out.unshift({
      mint: NATIVE_SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      logoURI: null,
      decimals: 9,
      amountRaw: solRaw.toString(),
      amountUi: Number(solRaw) / 1e9,
      usdValue: null,
      isNativeSol: true,
      isUsdc: false,
    });
  }
  return out;
}

export async function getUserFungibleTokens(ownerAddress: string): Promise<UserToken[]> {
  const url = heliusUrl();
  if (url) {
    try {
      const json = await fetchDasAssets(url, ownerAddress);
      if (json?.result) return mapDasResult(json.result);
    } catch (err) {
      console.warn('[swap/tokens] Helius DAS failed, falling back to RPC scan:', (err as Error).message);
    }
  }
  return fallbackRpcTokens(ownerAddress);
}

// ---------------------------------------------------------------------------
// Per-mint token icon resolver. Gives curated lists that AREN'T sourced from a
// held wallet token — e.g. the eligible borrow-collateral set and already-
// supplied positions — the SAME on-chain-metadata icon the wallet picker uses,
// instead of a text/colour placeholder. Resolves by the EXACT canonical mint
// via Helius DAS getAssetBatch (NEVER by symbol — matches the yield-asset mint
// rule), then caches it. Icons are cosmetic, so every path FAILS OPEN (returns
// null): an icon outage can never break a money-adjacent read.
// ---------------------------------------------------------------------------
const ICON_TTL_MS = 6 * 60 * 60 * 1000; // token icons effectively never change
const ICON_CACHE_MAX = 500; // bounded; the curated collateral set is tiny
const iconCache = new Map<string, { logo: string | null; ts: number }>();

function readIconCache(mint: string): string | null | undefined {
  const hit = iconCache.get(mint);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > ICON_TTL_MS) {
    iconCache.delete(mint);
    return undefined;
  }
  return hit.logo;
}

function writeIconCache(mint: string, logo: string | null): void {
  if (iconCache.size >= ICON_CACHE_MAX && !iconCache.has(mint)) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) iconCache.delete(oldest);
  }
  iconCache.set(mint, { logo, ts: Date.now() });
}

function imageFromAsset(item: any): string | null {
  return item?.content?.links?.image || item?.content?.files?.[0]?.uri || null;
}

async function fetchDasAssetBatch(url: string, ids: string[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'qv-icons',
        method: 'getAssetBatch',
        params: { ids, displayOptions: { showFungible: true } },
      }),
    });
    if (!res.ok) throw new Error(`Helius DAS HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a logo URI for each mint from its on-chain token metadata (Metaplex /
 * Token-2022), via Helius DAS. Cached + bounded. FAILS OPEN: any mint that can't
 * be resolved (no Helius key, network error, no image in metadata) maps to null
 * so the caller renders its own placeholder. Native SOL has no metadata account
 * and is intentionally null.
 */
export async function resolveTokenLogos(mints: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const need: string[] = [];
  for (const mint of mints) {
    if (!mint || mint === NATIVE_SOL_MINT) {
      out.set(mint, null);
      continue;
    }
    const cached = readIconCache(mint);
    if (cached !== undefined) {
      out.set(mint, cached);
    } else if (!need.includes(mint)) {
      need.push(mint);
    }
  }

  if (need.length === 0) return out;

  const url = heliusUrl();
  if (!url) {
    // No metadata source — fail open, don't cache (a key may appear later).
    for (const mint of need) out.set(mint, null);
    return out;
  }

  try {
    const json = await fetchDasAssetBatch(url, need);
    // A JSON-RPC error or a malformed payload arrives with HTTP 200. Treat it as
    // a failure and THROW so the catch path returns uncached nulls — otherwise
    // we'd cache "no icon" for every mint for the full TTL on a transient blip.
    if (json?.error || !Array.isArray(json?.result)) {
      throw new Error(`Helius DAS getAssetBatch: ${json?.error?.message ?? 'no result array'}`);
    }
    const items: any[] = json.result;
    const byId = new Map<string, any>();
    for (const it of items) if (it?.id) byId.set(it.id, it);
    for (const mint of need) {
      const logo = imageFromAsset(byId.get(mint));
      writeIconCache(mint, logo);
      out.set(mint, logo);
    }
  } catch (err) {
    console.warn('[swap/tokens] icon resolve failed (fail-open):', (err as Error).message);
    for (const mint of need) if (!out.has(mint)) out.set(mint, null);
  }

  return out;
}
