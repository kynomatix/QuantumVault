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

  // Native SOL.
  const native = result?.nativeBalance;
  if (native && Number(native.lamports) > 0) {
    const lamports = Number(native.lamports);
    out.push({
      mint: NATIVE_SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      logoURI: null,
      decimals: 9,
      amountRaw: String(native.lamports),
      amountUi: lamports / 1e9,
      usdValue: typeof native.total_price === 'number' ? native.total_price : null,
      isNativeSol: true,
      isUsdc: false,
    });
  }

  for (const item of result?.items ?? []) {
    const ti = item?.token_info;
    if (!ti || !ti.balance || Number(ti.balance) <= 0) continue;
    const decimals = ti.decimals ?? 0;
    const amountRaw = String(ti.balance);
    const amountUi = Number(ti.balance) / Math.pow(10, decimals);
    const mint = item.id;
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
  if (lamports > 0) {
    out.push({
      mint: NATIVE_SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      logoURI: null,
      decimals: 9,
      amountRaw: String(lamports),
      amountUi: lamports / 1e9,
      usdValue: null,
      isNativeSol: true,
      isUsdc: false,
    });
  }

  for (const { account } of parsed.value) {
    const info = account.data.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount || !tokenAmount.amount || Number(tokenAmount.amount) <= 0) continue;
    const mint = info.mint as string;
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
