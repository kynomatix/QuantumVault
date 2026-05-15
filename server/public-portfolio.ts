// Public, unauthenticated portfolio aggregation endpoint backing the
// SonarWatch QuantumVault plugin (jup.ag/portfolio integration).
//
// Design notes
// ------------
// - Surfaces only "portfolio safe" fields: no bot IDs, no secrets, no internal
//   identifiers. Subaccount keys are returned in truncated form for grouping.
// - Per-protocol failure isolation via Promise.allSettled so a Pacifica outage
//   degrades to a partial result instead of a 500.
// - Per-IP and per-wallet rate limiting (in-memory, sliding window) to keep
//   anonymous traffic from exhausting Pacifica's 300 credits/60s budget.
// - 30s server-side response cache keyed by lowercased wallet address.
// - Per-protocol circuit breaker fast-fails further calls when the upstream
//   adapter is repeatedly failing.

import { db } from './db';
import { wallets, tradingBots } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { listAdapters, getAdapter, getAdapterHealth } from './protocol/adapter-registry';
import { getAgentUsdcBalance, getAgentSolBalance } from './agent-wallet';
import type { Request, Response } from 'express';

// ---- Response contract -----------------------------------------------------

export type ProtocolStatus = 'ok' | 'partial' | 'error' | 'circuit_open' | 'unavailable';

export interface PortfolioPosition {
  symbol: string;            // e.g. "BTC"
  side: 'long' | 'short';
  size: number;              // base-asset size, always positive
  entryPrice: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
}

export interface PortfolioProtocolBlock {
  id: string;                // 'agent_wallet' | 'pacifica' | 'drift' | ...
  status: ProtocolStatus;
  error?: string;            // populated when status !== 'ok'
  balance: Record<string, number>;
  positions: PortfolioPosition[];
}

export interface PortfolioResponse {
  asOf: number;              // unix ms
  wallet: string;
  protocols: PortfolioProtocolBlock[];
}

// ---- In-memory infra (rate limit / cache / circuit breaker) ----------------

const CACHE_TTL_MS = 30_000;
const PER_IP_LIMIT = 30;            // requests
const PER_IP_WINDOW_MS = 60_000;
const PER_WALLET_LIMIT = 6;         // requests
const PER_WALLET_WINDOW_MS = 60_000;
const CIRCUIT_ERROR_THRESHOLD = 5;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 30_000;

const MAX_RATE_KEYS = 5000;         // hard cap so memory stays bounded

interface SlidingWindow { hits: number[] }
const ipBuckets = new Map<string, SlidingWindow>();
const walletBuckets = new Map<string, SlidingWindow>();

interface CacheEntry { at: number; payload: PortfolioResponse }
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_KEYS = 2000;

interface BreakerState { errors: number[]; openedAt: number }
const breakers = new Map<string, BreakerState>();

interface Telemetry {
  hits: number;
  misses: number;
  served: number;
  rateLimited: number;
  upstreamErrors: number;
}
const telemetry: Telemetry = { hits: 0, misses: 0, served: 0, rateLimited: 0, upstreamErrors: 0 };

let telemetryTimer: NodeJS.Timeout | null = null;
function startTelemetry() {
  if (telemetryTimer) return;
  telemetryTimer = setInterval(() => {
    if (telemetry.served + telemetry.rateLimited === 0) return;
    console.log(
      `[public-portfolio] served=${telemetry.served} rate_limited=${telemetry.rateLimited} ` +
      `cache_hits=${telemetry.hits} cache_misses=${telemetry.misses} upstream_errors=${telemetry.upstreamErrors}`,
    );
    telemetry.hits = telemetry.misses = telemetry.served = telemetry.rateLimited = telemetry.upstreamErrors = 0;
  }, 60_000);
  if (typeof telemetryTimer.unref === 'function') telemetryTimer.unref();
}

function evictIfNeeded<T>(map: Map<string, T>, max: number) {
  if (map.size <= max) return;
  // Drop the oldest ~10% (insertion order = oldest first in Map)
  const drop = Math.ceil(max * 0.1);
  let i = 0;
  const keys = Array.from(map.keys());
  for (const k of keys) {
    map.delete(k);
    if (++i >= drop) break;
  }
}

function checkAndRecord(map: Map<string, SlidingWindow>, key: string, limit: number, windowMs: number, max: number): boolean {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket) {
    evictIfNeeded(map, max);
    bucket = { hits: [] };
    map.set(key, bucket);
  }
  // Drop expired
  while (bucket.hits.length > 0 && bucket.hits[0] <= now - windowMs) bucket.hits.shift();
  if (bucket.hits.length >= limit) return false;
  bucket.hits.push(now);
  return true;
}

function getBreaker(protocol: string): BreakerState {
  let b = breakers.get(protocol);
  if (!b) {
    b = { errors: [], openedAt: 0 };
    breakers.set(protocol, b);
  }
  return b;
}

function isCircuitOpen(protocol: string): boolean {
  const b = getBreaker(protocol);
  const now = Date.now();
  if (b.openedAt && now - b.openedAt < CIRCUIT_OPEN_MS) return true;
  if (b.openedAt && now - b.openedAt >= CIRCUIT_OPEN_MS) {
    b.openedAt = 0;
    b.errors = [];
  }
  return false;
}

function recordProtocolError(protocol: string) {
  const b = getBreaker(protocol);
  const now = Date.now();
  while (b.errors.length > 0 && b.errors[0] <= now - CIRCUIT_WINDOW_MS) b.errors.shift();
  b.errors.push(now);
  if (b.errors.length >= CIRCUIT_ERROR_THRESHOLD) {
    b.openedAt = now;
    console.warn(`[public-portfolio] circuit OPEN for protocol="${protocol}" (${b.errors.length} errs in ${CIRCUIT_WINDOW_MS}ms)`);
  }
}

// ---- Wallet -> position aggregation ----------------------------------------

function isValidSolanaAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  if (addr.length < 32 || addr.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr); // base58 alphabet
}

interface SubaccountTarget {
  protocol: string;
  // What pubkey to query for in adapter calls. For Pacifica external_key bots
  // this is the bot's own pubkey; for Drift main_plus_id bots this is the
  // agent (main) pubkey, and `subaccountId` carries the index.
  queryAccount: string;
  subaccountId?: string;
  // Stable dedupe key.
  dedupeKey: string;
}

async function resolveTargetsForWallet(walletAddress: string): Promise<{
  agentPublicKey: string | null;
  targets: SubaccountTarget[];
  walletExists: boolean;
}> {
  const [w] = await db.select().from(wallets).where(eq(wallets.address, walletAddress)).limit(1);
  if (!w) return { agentPublicKey: null, targets: [], walletExists: false };

  const agentPublicKey = w.agentPublicKey ?? null;
  const bots = await db.select().from(tradingBots).where(
    and(eq(tradingBots.walletAddress, walletAddress), eq(tradingBots.isActive, true)),
  );

  const seen = new Set<string>();
  const targets: SubaccountTarget[] = [];
  for (const bot of bots) {
    const protocol = bot.activeProtocol;
    let queryAccount: string;
    let subaccountId: string | undefined;
    if (bot.subaccountAuthMode === 'external_key') {
      if (!bot.protocolSubaccountId || bot.subaccountStatus !== 'active') continue;
      queryAccount = bot.protocolSubaccountId;
      subaccountId = undefined;
    } else {
      // main_plus_id: query agent pubkey + numeric subaccount id
      if (!agentPublicKey) continue;
      queryAccount = agentPublicKey;
      subaccountId = bot.protocolSubaccountId ?? undefined;
    }
    const dedupeKey = `${protocol}::${queryAccount}::${subaccountId ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({ protocol, queryAccount, subaccountId, dedupeKey });
  }

  return { agentPublicKey, targets, walletExists: true };
}

function mapPosition(p: {
  internalSymbol: string;
  baseSize: number;
  entryPrice: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
}): PortfolioPosition | null {
  if (!p.baseSize || Math.abs(p.baseSize) < 1e-12) return null;
  return {
    symbol: p.internalSymbol,
    side: p.baseSize >= 0 ? 'long' : 'short',
    size: Math.abs(p.baseSize),
    entryPrice: p.entryPrice,
    leverage: p.leverage,
    marginMode: p.marginMode,
  };
}

async function fetchProtocolBlock(
  protocol: string,
  targets: SubaccountTarget[],
): Promise<PortfolioProtocolBlock> {
  if (isCircuitOpen(protocol)) {
    return {
      id: protocol,
      status: 'circuit_open',
      error: 'Upstream temporarily unavailable',
      balance: {},
      positions: [],
    };
  }

  const health = getAdapterHealth(protocol);
  if (health === 'unavailable') {
    return { id: protocol, status: 'unavailable', error: 'Adapter not registered', balance: {}, positions: [] };
  }

  let adapter;
  try {
    adapter = getAdapter(protocol);
  } catch (err: any) {
    return { id: protocol, status: 'unavailable', error: err.message, balance: {}, positions: [] };
  }

  const calls = await Promise.allSettled(
    targets.map(async (t) => {
      const [info, positions] = await Promise.all([
        adapter.getAccountInfo(t.queryAccount, t.subaccountId),
        adapter.getPositions(t.queryAccount, t.subaccountId),
      ]);
      return { info, positions };
    }),
  );

  let totalEquity = 0;
  let totalFree = 0;
  let totalMarginUsed = 0;
  const allPositions: PortfolioPosition[] = [];
  let hadAnyError = false;
  let firstError: string | undefined;

  for (const r of calls) {
    if (r.status === 'rejected') {
      hadAnyError = true;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (!firstError) firstError = msg;
      recordProtocolError(protocol);
      telemetry.upstreamErrors++;
      continue;
    }
    const { info, positions } = r.value;
    if (info?.exists !== false) {
      totalEquity += info.equity || 0;
      totalFree += info.availableMargin || 0;
      totalMarginUsed += info.maintenanceMargin || 0;
    }
    for (const p of positions) {
      const mapped = mapPosition(p);
      if (mapped) allPositions.push(mapped);
    }
  }

  const allFailed = targets.length > 0 && calls.every((c) => c.status === 'rejected');
  // Total failure -> protocol-level error. Mixed failure -> 'partial' with
  // an error message so downstream consumers can surface a per-protocol
  // notice while still showing the data we did get.
  const status: ProtocolStatus = allFailed ? 'error' : (hadAnyError ? 'partial' : 'ok');
  return {
    id: protocol,
    status,
    error: hadAnyError ? firstError ?? 'unknown' : undefined,
    balance: allFailed ? {} : {
      equity: round6(totalEquity),
      freeCollateral: round6(totalFree),
      marginUsed: round6(totalMarginUsed),
    },
    positions: allFailed ? [] : allPositions,
  };
}

async function fetchAgentWalletBlock(agentPublicKey: string | null): Promise<PortfolioProtocolBlock> {
  if (!agentPublicKey) {
    return { id: 'agent_wallet', status: 'ok', balance: { usdc: 0, sol: 0 }, positions: [] };
  }
  const [usdcRes, solRes] = await Promise.allSettled([
    getAgentUsdcBalance(agentPublicKey),
    getAgentSolBalance(agentPublicKey),
  ]);
  const usdc = usdcRes.status === 'fulfilled' ? usdcRes.value : 0;
  const sol = solRes.status === 'fulfilled' ? solRes.value : 0;
  const errored = usdcRes.status === 'rejected' || solRes.status === 'rejected';
  return {
    id: 'agent_wallet',
    status: errored ? 'error' : 'ok',
    error: errored ? 'Failed to read on-chain balances' : undefined,
    balance: { usdc: round6(usdc), sol: round6(sol) },
    positions: [],
  };
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

async function buildPortfolio(walletAddress: string): Promise<PortfolioResponse> {
  const { agentPublicKey, targets, walletExists } = await resolveTargetsForWallet(walletAddress);

  // Unknown wallet (no QuantumVault account): return 200 with an empty
  // protocols array per the public contract — never a 404.
  if (!walletExists) {
    return { asOf: Date.now(), wallet: walletAddress, protocols: [] };
  }

  const byProtocol = new Map<string, SubaccountTarget[]>();
  for (const t of targets) {
    let arr = byProtocol.get(t.protocol);
    if (!arr) { arr = []; byProtocol.set(t.protocol, arr); }
    arr.push(t);
  }

  const protocolEntries = Array.from(byProtocol.entries());
  const jobIds: string[] = ['agent_wallet', ...protocolEntries.map(([p]) => p)];
  const protocolJobs: Promise<PortfolioProtocolBlock>[] = [
    fetchAgentWalletBlock(agentPublicKey),
    ...protocolEntries.map(([protocol, ts]) => fetchProtocolBlock(protocol, ts)),
  ];

  // Promise.allSettled at this level too, just to be defensive — though the
  // inner functions already swallow upstream errors into status fields.
  const settled = await Promise.allSettled(protocolJobs);
  const blocks: PortfolioProtocolBlock[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { id: jobIds[i] ?? 'unknown', status: 'error', error: String(r.reason), balance: {}, positions: [] };
  });

  return {
    asOf: Date.now(),
    wallet: walletAddress,
    protocols: blocks,
  };
}

// ---- Express handler -------------------------------------------------------

export async function publicPortfolioHandler(req: Request, res: Response): Promise<void> {
  startTelemetry();

  const ip = (req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0] || 'unknown').trim();
  if (!checkAndRecord(ipBuckets, ip, PER_IP_LIMIT, PER_IP_WINDOW_MS, MAX_RATE_KEYS)) {
    telemetry.rateLimited++;
    res.status(429).json({ error: 'Too many requests (per IP). Try again shortly.' });
    return;
  }

  const wallet = String(req.query.wallet ?? '').trim();
  if (!wallet) {
    res.status(400).json({ error: 'Missing required query parameter: wallet' });
    return;
  }
  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ error: 'Invalid Solana wallet address' });
    return;
  }

  const cacheKey = wallet.toLowerCase();
  if (!checkAndRecord(walletBuckets, cacheKey, PER_WALLET_LIMIT, PER_WALLET_WINDOW_MS, MAX_RATE_KEYS)) {
    telemetry.rateLimited++;
    res.status(429).json({ error: 'Too many requests (per wallet). Try again shortly.' });
    return;
  }

  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    telemetry.hits++;
    telemetry.served++;
    res.set('Cache-Control', 'public, max-age=15');
    res.set('X-Cache', 'HIT');
    res.json(cached.payload);
    return;
  }
  telemetry.misses++;

  try {
    const payload = await buildPortfolio(wallet);
    evictIfNeeded(responseCache, MAX_CACHE_KEYS);
    responseCache.set(cacheKey, { at: Date.now(), payload });
    telemetry.served++;
    res.set('Cache-Control', 'public, max-age=15');
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (err: any) {
    console.error('[public-portfolio] aggregation failure:', err);
    res.status(500).json({ error: 'Internal aggregation error' });
  }
}

// Exposed for tests / diagnostics.
export const __internals = {
  resolveTargetsForWallet,
  buildPortfolio,
  responseCache,
  ipBuckets,
  walletBuckets,
};
