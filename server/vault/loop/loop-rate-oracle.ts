/**
 * SOL Loop Vault P3 — rate oracle (allocation-tick input).
 *
 * Samples, per registry pair, the two rates the LEVERED-vs-HOLD decision needs:
 *   - LST staking APY (DeFiLlama yields index; also carries the 30d mean), and
 *   - vault WSOL borrow APR + withdraw-side utilization (Jupiter Lend vaults API,
 *     decoded through the SAME `decodeLoopVaultConfig` the money paths use).
 *
 * Persists one row per vault per sample into `loop_rate_samples` so the hourly
 * allocation tick and the 60s carry-degrade check read a DB row (with a
 * staleness gate) instead of hammering upstreams. TELEMETRY + POLICY INPUT
 * ONLY: no money path reads this table for execution — opens/unwinds re-read
 * live config through the borrow route and the loop risk policy.
 *
 * Unit convention: ALL rates here are FRACTIONS (0.08 = 8%), matching
 * BorrowVaultConfig. DeFiLlama reports percent; converted at the boundary.
 *
 * Failure model: FAIL-SOFT per field (a partial outage records what WAS
 * readable; nulls persist as nulls), FAIL-CLOSED at read time (the policy
 * treats a null/stale rate as unreadable and holds, never guesses).
 */

import { storage } from "../../storage";
import type { InsertLoopRateSample, LoopRateSample } from "@shared/schema";
import { decodeLoopVaultConfig } from "../jupiter-lend-borrow-route";
import { fetchDefiLlamaApy } from "../defillama-apy";
import { LOOP_VAULT_ALLOWLIST } from "./loop-risk-policy";

/** One registry pair: a Jupiter Lend Multiply vault and its DeFiLlama staking-APY pool. */
export interface LoopRatePair {
  /** Jupiter Lend Multiply vault id — the AUTHORITY (never resolve by symbol). */
  vaultId: number;
  /** Expected collateral symbol; asserted against the live API (refuse on mismatch). */
  symbol: string;
  /** Pinned DeFiLlama pool id for the LST's staking APY. */
  llamaPool: string;
}

/**
 * Registry pinned by vault id, mirroring scripts/rank-loop-pairs.mjs. Includes
 * NON-allowlisted pairs (JitoSOL, INF) on purpose: sampling is read-only and
 * the extra series is the telemetry base for the P4 HOP decision. The brain
 * only ever ACTS on `LOOP_VAULT_ALLOWLIST` vaults.
 */
export const LOOP_RATE_REGISTRY: readonly LoopRatePair[] = [
  { vaultId: 4, symbol: "JupSOL", llamaPool: "52bd72a7-9e81-4112-abb4-71673e8de9bf" },
  { vaultId: 5, symbol: "JitoSOL", llamaPool: "0e7d0722-9054-4907-8593-567b353c0900" },
  { vaultId: 42, symbol: "INF", llamaPool: "3075a746-bdd1-4aac-bcd5-b035abee2622" },
  { vaultId: 47, symbol: "mSOL", llamaPool: "b3f93865-5ec8-4662-90a0-11808e0aa2bd" },
] as const;

/** Reference leverage for the materialized carry column (matches launch cap). */
export const LOOP_CARRY_REFERENCE_LEVERAGE = 2;

/** Keep ~30 days of hourly samples (~4 vaults × 24 × 30 ≈ 2.9k rows — tiny). */
const RETENTION_DAYS = 30;

/**
 * Net carry of a levered loop at leverage L (fractions in, fraction out):
 * stake yield accrues on L× exposure, borrow cost on (L−1)× debt.
 * Null-safe: unreadable inputs → null (fail closed at the caller).
 */
export function netCarryAt(
  stakingApy: number | null,
  borrowApr: number | null,
  leverage: number,
): number | null {
  if (
    typeof stakingApy !== "number" || !Number.isFinite(stakingApy) ||
    typeof borrowApr !== "number" || !Number.isFinite(borrowApr) ||
    !Number.isFinite(leverage) || leverage < 1
  ) {
    return null;
  }
  return stakingApy * leverage - borrowApr * (leverage - 1);
}

/** One sampled pair, rates as fractions; null = unreadable this sample. */
export interface LoopRateReading {
  vaultId: number;
  symbol: string;
  allowlisted: boolean;
  stakingApy: number | null;
  stakingApyMean30d: number | null;
  borrowApr: number | null;
  withdrawUtilization: number | null;
  /** Net carry at the reference 2x leverage. */
  netCarry2x: number | null;
  /** Structural refusal (vault missing / symbol mismatch) — row NOT persisted. */
  refusedReason?: string;
}

const asFraction = (pct: number | null): number | null =>
  typeof pct === "number" && Number.isFinite(pct) ? pct / 100 : null;

/**
 * Fetch a fresh reading for every registry pair. ONE Jupiter Lend getVaults()
 * call + ONE DeFiLlama pass, both fail-soft. Never throws. Does NOT persist.
 */
export async function sampleLoopRates(): Promise<LoopRateReading[]> {
  // Both upstreams in parallel; each degrades to "unreadable" independently.
  const [vaults, llama] = await Promise.all([
    (async () => {
      try {
        const { Client } = await import("@jup-ag/lend/api");
        const client = new Client();
        return (await client.borrow.getVaults()) as any[];
      } catch {
        return null; // borrow-side fields will be null for every pair
      }
    })(),
    fetchDefiLlamaApy(LOOP_RATE_REGISTRY.map((r) => r.llamaPool)).catch(
      () => new Map<string, { apy: number | null; apyMean30d: number | null }>(),
    ),
  ]);

  const readings: LoopRateReading[] = [];
  for (const reg of LOOP_RATE_REGISTRY) {
    const apy = llama.get(reg.llamaPool);
    const stakingApy = asFraction(apy?.apy ?? null);
    const stakingApyMean30d = asFraction(apy?.apyMean30d ?? null);

    let borrowApr: number | null = null;
    let withdrawUtilization: number | null = null;
    let refusedReason: string | undefined;

    if (Array.isArray(vaults)) {
      const v = vaults.find((x: any) => Number(x?.id) === reg.vaultId);
      if (!v) {
        // Vault id gone from the API — structural, refuse the whole row so a
        // registry-vs-venue drift is loud (coverage % drops) instead of being
        // recorded as a plausible-looking all-null sample.
        refusedReason = `vaultId ${reg.vaultId} missing from vaults API`;
      } else {
        const liveSymbol = String(v?.supplyToken?.symbol ?? "");
        if (liveSymbol.toUpperCase() !== reg.symbol.toUpperCase()) {
          // Registry stale / vault repurposed — refusing beats mislabeling a series.
          refusedReason = `vaultId ${reg.vaultId} now serves ${liveSymbol || "?"} (registry says ${reg.symbol})`;
        } else {
          // Same decoder + fail-closed validation the money paths use.
          const cfg = decodeLoopVaultConfig(v);
          if (cfg) {
            borrowApr = cfg.borrowApr;
            withdrawUtilization = cfg.withdrawUtilization;
          }
        }
      }
    }

    readings.push({
      vaultId: reg.vaultId,
      symbol: reg.symbol,
      allowlisted: Boolean(LOOP_VAULT_ALLOWLIST[reg.vaultId]),
      stakingApy,
      stakingApyMean30d,
      borrowApr,
      withdrawUtilization,
      netCarry2x: netCarryAt(stakingApy, borrowApr, LOOP_CARRY_REFERENCE_LEVERAGE),
      ...(refusedReason ? { refusedReason } : {}),
    });
  }
  return readings;
}

/**
 * Fetch + persist one sample per non-refused pair, then prune retention.
 * Fail-soft end to end (a DB hiccup logs and returns the readings unpersisted —
 * the next tick simply samples again). Returns the readings for the caller
 * (allocation tick) so it never re-fetches what it just sampled.
 */
export async function sampleAndPersistLoopRates(): Promise<LoopRateReading[]> {
  const readings = await sampleLoopRates();

  const rows: InsertLoopRateSample[] = [];
  for (const r of readings) {
    if (r.refusedReason) {
      console.warn(`[loop-rate-oracle] refusing sample for ${r.symbol}: ${r.refusedReason}`);
      continue;
    }
    // Persist partial rows too (one upstream down ≠ zero information); a row
    // with NOTHING readable is skipped — it would only fake coverage.
    if (r.stakingApy === null && r.borrowApr === null) {
      console.warn(`[loop-rate-oracle] no readable fields for ${r.symbol} (vault ${r.vaultId}); skipping row`);
      continue;
    }
    rows.push({
      vaultId: r.vaultId,
      symbol: r.symbol,
      stakingApy: r.stakingApy !== null ? r.stakingApy.toFixed(8) : null,
      stakingApyMean30d: r.stakingApyMean30d !== null ? r.stakingApyMean30d.toFixed(8) : null,
      borrowApr: r.borrowApr !== null ? r.borrowApr.toFixed(8) : null,
      withdrawUtilization: r.withdrawUtilization !== null ? r.withdrawUtilization.toFixed(6) : null,
      netCarry2x: r.netCarry2x !== null ? r.netCarry2x.toFixed(8) : null,
    });
  }

  try {
    await storage.insertLoopRateSamples(rows);
    await storage.pruneLoopRateSamples(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000));
  } catch (e) {
    console.error(`[loop-rate-oracle] persist failed (will retry next tick): ${e instanceof Error ? e.message : String(e)}`);
  }
  return readings;
}

/** A persisted sample decoded back to numbers, with its age attached. */
export interface FreshLoopRate {
  vaultId: number;
  symbol: string;
  stakingApy: number | null;
  stakingApyMean30d: number | null;
  borrowApr: number | null;
  withdrawUtilization: number | null;
  netCarry2x: number | null;
  asOf: Date;
}

const num = (s: string | null): number | null => {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function decodeSample(row: LoopRateSample): FreshLoopRate {
  return {
    vaultId: row.vaultId,
    symbol: row.symbol,
    stakingApy: num(row.stakingApy),
    stakingApyMean30d: num(row.stakingApyMean30d),
    borrowApr: num(row.borrowApr),
    withdrawUtilization: num(row.withdrawUtilization),
    netCarry2x: num(row.netCarry2x),
    asOf: row.asOf,
  };
}

/**
 * Pick the best loop vault for a user-initiated OPEN: highest fresh 2x net
 * carry among the allowlisted vaults (deterministic tie-break: lower vaultId).
 * The USER never chooses the LST — defaults over choices (plan §4.5); this is
 * the same rate table the allocation brain reads, not a second objective.
 * Returns null when no allowlisted vault has a readable fresh carry → callers
 * must fail closed (never fall back to a hardcoded vault).
 */
export function pickBestLoopVault(
  rates: Map<number, FreshLoopRate>,
  allowedVaultIds: number[],
): { vaultId: number; symbol: string; netCarry2x: number } | null {
  let best: { vaultId: number; symbol: string; netCarry2x: number } | null = null;
  for (const id of allowedVaultIds) {
    const r = rates.get(id);
    if (!r || r.netCarry2x === null) continue;
    if (
      best === null ||
      r.netCarry2x > best.netCarry2x ||
      (r.netCarry2x === best.netCarry2x && id < best.vaultId)
    ) {
      best = { vaultId: id, symbol: r.symbol, netCarry2x: r.netCarry2x };
    }
  }
  return best;
}

/**
 * Latest persisted sample per vault, STALENESS-GATED: anything older than
 * `maxAgeMs` is simply absent from the map, so a consumer that finds no entry
 * MUST treat the rate as unreadable and fail closed (hold / skip), never
 * fall back to an older row. This is what the 60s carry check reads — it must
 * NEVER trigger an upstream fetch on the safety tick.
 */
export async function getFreshLoopRates(maxAgeMs: number): Promise<Map<number, FreshLoopRate>> {
  const out = new Map<number, FreshLoopRate>();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return out;
  try {
    const rows = await storage.getLatestLoopRateSamples(new Date(Date.now() - maxAgeMs));
    for (const row of rows) out.set(row.vaultId, decodeSample(row));
  } catch (e) {
    console.error(`[loop-rate-oracle] read failed (fail closed, empty map): ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
