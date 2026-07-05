/**
 * BORROW ORACLE-FRESHNESS READER — Phase C (READ-ONLY; no money moves here, but
 * this is the LAST gate input that lets the enforced money gate authorize a
 * borrow). It produces the two freshness facts `borrow-risk-policy.ts` consumes:
 *
 *   BorrowOracleContext = { publishAgeSec: number | null, priceMove1hAbs: number | null }
 *
 * The gate treats `null` as a HARD DENY (oracle_unreadable / price_move_unreadable),
 * `publishAgeSec > 120s` as oracle_stale, and `priceMove1hAbs > 0.15` as a
 * volatility freeze. So this reader's ONLY job is to return honest numbers when
 * — and only when — every input is authoritative, and `null` on ANY uncertainty.
 *
 * SOURCE: Pyth Hermes over plain HTTP (no SDK dependency — mirrors the spine's
 * `flash-pyth-sse.ts`). Latest publish time comes from `/v2/updates/price/latest`;
 * the 1h price move from the benchmark endpoint `/v2/updates/price/{unixSec}`.
 * The collateral -> feed mapping is the HARD `borrow-oracle-registry.ts` (any
 * unmapped/mismatched vault returns {null,null}).
 *
 * MONEY-SAFETY guards (all fail closed -> {null,null}):
 *   - registry miss / mint mismatch / blank feed
 *   - HTTP non-2xx, timeout, network error, malformed JSON
 *   - missing/!finite/non-positive price, bad expo, missing/!finite publish_time
 *   - latest publish time in the future beyond a small clock-skew tolerance
 *   - benchmark publish time too far from the requested t-1h target
 *   - the Hermes price diverging materially from the vault's on-chain oracle
 *     price (a wrong-feed guard; the protocol's price stays the money authority)
 */

import type { BorrowOracleContext } from "./borrow-risk-policy";
import type { BorrowVaultConfig } from "./jupiter-lend-borrow-route";
import { getBorrowOracleSource, type BorrowOracleSource } from "./borrow-oracle-registry";

const HERMES_BASE = "https://hermes.pyth.network";
const DEFAULT_TIMEOUT_MS = 8000;
/** Tolerate the latest publish time up to this far in the "future" (clock skew). */
const CLOCK_SKEW_SEC = 30;
/** The t-1h benchmark must publish within this window of the requested target. */
const BENCHMARK_MAX_DRIFT_SEC = 600;
/** Max |Hermes price / vault liquidation price - 1| before we treat it as a wrong map. */
const VAULT_PRICE_MAX_DIVERGENCE = 0.1;

const UNREADABLE: BorrowOracleContext = { publishAgeSec: null, priceMove1hAbs: null };

export interface OraclePoint {
  priceUsd: number;
  publishTimeSec: number;
}

export interface BorrowOracleReaderDeps {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to Date.now (ms epoch). */
  now?: () => number;
  hermesBase?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the hard registry lookup. */
  getOracleSource?: (vaultId: number, collateralMint: string) => BorrowOracleSource | null;
}

function normFeedId(s: string): string {
  return s.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * PURE: parse a Hermes `{ binary, parsed: [...] }` payload into a feed-id ->
 * {priceUsd, publishTimeSec} map. Returns null (fail closed) if the payload is
 * malformed OR any expected feed id is missing/invalid. Every wanted id must be
 * present and valid or the whole read is rejected.
 */
export function parseHermesParsed(
  json: unknown,
  expectedFeedIds: string[],
): Map<string, OraclePoint> | null {
  if (!json || typeof json !== "object") return null;
  const parsed = (json as any).parsed;
  if (!Array.isArray(parsed)) return null;

  const wanted = new Set(expectedFeedIds.map(normFeedId));
  const out = new Map<string, OraclePoint>();

  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const id = typeof (e as any).id === "string" ? normFeedId((e as any).id) : null;
    if (!id || !wanted.has(id)) continue;

    const p = (e as any).price;
    if (!p || typeof p !== "object") return null; // malformed for a wanted id

    const rawPrice = Number(p.price);
    const expo = Number(p.expo);
    const pub = Number(p.publish_time);
    if (!Number.isFinite(rawPrice) || !Number.isFinite(expo) || !Number.isFinite(pub)) return null;
    if (!Number.isInteger(expo) || expo > 0 || expo < -20) return null; // sane Pyth expo
    if (pub <= 0) return null;

    const priceUsd = rawPrice * Math.pow(10, expo);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    out.set(id, { priceUsd, publishTimeSec: pub });
  }

  for (const w of wanted) if (!out.has(w)) return null;
  return out;
}

export interface OracleComputeOpts {
  nowSec: number;
  targetSec: number;
  clockSkewSec?: number;
  benchmarkMaxDriftSec?: number;
}

/**
 * PURE: turn a latest point + a t-1h point into the BorrowOracleContext for a
 * single-feed (direct) collateral. Each fact is independently null when its
 * inputs are unreadable; the gate denies on ANY null.
 */
export function computeDirectOracleContext(
  latest: OraclePoint,
  hourAgo: OraclePoint,
  opts: OracleComputeOpts,
): BorrowOracleContext {
  const skew = opts.clockSkewSec ?? CLOCK_SKEW_SEC;
  const drift = opts.benchmarkMaxDriftSec ?? BENCHMARK_MAX_DRIFT_SEC;

  let publishAgeSec: number | null = null;
  const age = opts.nowSec - latest.publishTimeSec;
  if (Number.isFinite(age) && age >= -skew) {
    publishAgeSec = age < 0 ? 0 : age; // clamp small clock-skew negatives to 0
  }

  let priceMove1hAbs: number | null = null;
  const benchDrift = Math.abs(hourAgo.publishTimeSec - opts.targetSec);
  if (
    Number.isFinite(benchDrift) &&
    benchDrift <= drift &&
    hourAgo.priceUsd > 0 &&
    latest.priceUsd > 0
  ) {
    const move = Math.abs(latest.priceUsd / hourAgo.priceUsd - 1);
    if (Number.isFinite(move) && move >= 0) priceMove1hAbs = move;
  }

  return { publishAgeSec, priceMove1hAbs };
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * I/O wrapper: resolve the vault's verified oracle source, read Hermes latest +
 * t-1h, cross-check against the vault's on-chain price, and compute the freshness
 * facts. Returns {null,null} on ANY uncertainty (fail closed).
 */
export async function readBorrowOracleContext(
  vault: BorrowVaultConfig,
  deps: BorrowOracleReaderDeps = {},
): Promise<BorrowOracleContext> {
  try {
    const getSource = deps.getOracleSource ?? getBorrowOracleSource;
    const source = getSource(vault.vaultId, vault.collateralMint);
    if (!source) return UNREADABLE;

    // Resolve the Pyth feed id for this oracle kind.
    //   pyth_direct    → source.feedId (direct USD price for this collateral)
    //   pyth_sol_proxy → source.solFeedId (Pyth SOL/USD used as a freshness/
    //                    volatility proxy for LSTs whose vault uses stakePool +
    //                    Chainlink with no direct Pyth feed)
    let feedId: string;
    if (source.kind === "pyth_direct") {
      feedId = source.feedId;
    } else if (source.kind === "pyth_sol_proxy") {
      feedId = source.solFeedId;
    } else {
      return UNREADABLE; // unknown kind → fail closed
    }
    if (!feedId || typeof feedId !== "string") return UNREADABLE;

    if (!(Number.isFinite(vault.oraclePriceLiquidateUsd) && vault.oraclePriceLiquidateUsd > 0)) {
      return UNREADABLE;
    }

    const fetchImpl = deps.fetchImpl ?? fetch;
    const nowMs = (deps.now ?? Date.now)();
    if (!Number.isFinite(nowMs)) return UNREADABLE;
    const nowSec = Math.floor(nowMs / 1000);
    const targetSec = nowSec - 3600;
    const base = (deps.hermesBase ?? HERMES_BASE).replace(/\/+$/, "");
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const latestUrl = `${base}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
    const benchUrl = `${base}/v2/updates/price/${targetSec}?ids[]=${feedId}&parsed=true`;

    const [latestJson, benchJson] = await Promise.all([
      fetchJson(latestUrl, fetchImpl, timeoutMs),
      fetchJson(benchUrl, fetchImpl, timeoutMs),
    ]);
    if (!latestJson || !benchJson) return UNREADABLE;

    const latestMap = parseHermesParsed(latestJson, [feedId]);
    const benchMap = parseHermesParsed(benchJson, [feedId]);
    if (!latestMap || !benchMap) return UNREADABLE;

    const id = normFeedId(feedId);
    const latest = latestMap.get(id);
    const hourAgo = benchMap.get(id);
    if (!latest || !hourAgo) return UNREADABLE;

    // Wrong-feed guard (pyth_direct only): the Hermes price must track the
    // vault's own on-chain oracle price. A gross divergence means the feed id is
    // mismapped (or an extreme desync) -> fail closed.
    // Skipped for pyth_sol_proxy: the SOL/USD price intentionally differs from
    // the LST vault price (e.g. SOL ~$101 vs JupSOL ~$97); the proxy relationship
    // is hardcoded and the guard's wrong-map purpose does not apply.
    if (source.kind === "pyth_direct") {
      const divergence = Math.abs(latest.priceUsd / vault.oraclePriceLiquidateUsd - 1);
      if (!Number.isFinite(divergence) || divergence > VAULT_PRICE_MAX_DIVERGENCE) {
        return UNREADABLE;
      }
    }

    return computeDirectOracleContext(latest, hourAgo, { nowSec, targetSec });
  } catch {
    return UNREADABLE;
  }
}
