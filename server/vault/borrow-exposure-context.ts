/**
 * BORROW EXPOSURE CONTEXT BUILDER — Phase C, brick #3 (NON-money, read-only).
 *
 * Assembles the platform-wide `BorrowExposureContext` that the enforced gate
 * (`borrow-risk-policy.ts`) needs for its aggregate-exposure and per-collateral
 * concentration circuit breakers.
 *
 * SOURCE OF TRUTH (deliberate): the `borrow_positions` DB rows are the platform
 * exposure CACHE. There is no cheap way to read every wallet's on-chain debt, so
 * the aggregate breaker is computed from the cache. This is acceptable ONLY
 * because:
 *   - the cache is the authority for OUR OWN debt writes (debt only moves when a
 *     borrow/repay operation we ran updates the row), and
 *   - the health that gates an INDIVIDUAL borrow is still read on-chain at
 *     preview/sign time (jupiter-lend-borrow-route), never from this cache, and
 *   - the monitor (brick #5) refreshes the per-position health snapshot.
 *
 * DESIGN CONTRACT (mirrors borrow-risk-policy.ts so it is testable + reusable):
 *   - PURE. Rows in → result out. No DB, no network, no SDK. The caller does I/O.
 *   - FAIL CLOSED. Any active row whose debt is unparseable/negative, whose debt
 *     asset is not the verified USDC mint, whose collateral identity is missing,
 *     or (when a staleness budget is supplied) whose open snapshot is too old,
 *     returns `ok:false`. The caller must then DENY the borrow — never guess and
 *     never silently undercount the platform book.
 *   - CONSERVATIVE only for VALID raw USDC debt. Invalid/unreadable rows block;
 *     they are never treated as zero.
 */

import type { BorrowExposureContext } from "./borrow-risk-policy";

/** USDC debt is always 6dp; 1 USDC ≈ $1 for this coarse platform breaker. */
const USDC_DEBT_DECIMALS = 6;

/** Terminal rows carry no live platform debt. Excluded by the reader too. */
const TERMINAL_STATUSES = new Set(["closed", "failed"]);

/** The subset of a borrow_positions row this builder reads. */
export interface BorrowExposureRow {
  status: string;
  collateralMint: string;
  collateralAssetKey: string;
  debtAssetKey: string;
  debtMint: string;
  debtAmountRaw: string;
  updatedAt?: Date | string | null;
  healthAsOf?: Date | string | null;
  /**
   * Position-family discriminator. `'loop'` rows (SOL Loop Vault: WSOL debt,
   * leverage-denominated) are DELIBERATELY excluded from this USD book — their
   * exposure is governed by the loop risk policy in SOL terms. Without this
   * exemption a single loop row would trip `exposure_non_usdc_debt` and deny
   * every borrow platform-wide. Absent/undefined kind counts as 'borrow'.
   */
  kind?: string | null;
}

export interface BuildExposureOptions {
  /** Epoch ms used for the staleness check. Defaults to Date.now(). */
  now?: number;
  /**
   * If set (> 0), an OPEN row (debt > 0) whose freshest timestamp is older than
   * this many ms fails closed (`exposure_cache_stale`). Leave undefined while no
   * monitor refreshes the cache (no live positions yet) — then staleness cannot
   * be judged and is not enforced.
   */
  maxStalenessMs?: number;
}

export interface BorrowExposureReason {
  code: string;
  message: string;
  facts?: Record<string, unknown>;
}

export interface BorrowExposureResult {
  /** True only when every counted active row was fully readable + valid. */
  ok: boolean;
  /** Present only when ok === true. */
  exposure?: BorrowExposureContext;
  reasons: BorrowExposureReason[];
  stats: {
    totalRows: number;
    skippedTerminal: number;
    countedRows: number;
    aggregateDebtUsd: number;
    collateralDebtUsd: number;
  };
}

function safeBigInt(s: unknown): bigint | null {
  try {
    if (typeof s !== "string" || s.trim() === "") return null;
    const v = BigInt(s);
    return v >= BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

function toEpochMs(t: Date | string | null | undefined): number | null {
  if (t == null) return null;
  const ms = t instanceof Date ? t.getTime() : Date.parse(String(t));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build the platform exposure context for a borrow against `targetCollateralMint`.
 * `expectedUsdcMint` is the verified USDC mint the caller resolves from its own
 * registry — passed in to keep this module pure.
 */
export function buildBorrowExposureContext(
  rows: BorrowExposureRow[],
  targetCollateralMint: string,
  expectedUsdcMint: string,
  opts: BuildExposureOptions = {},
): BorrowExposureResult {
  const now = Number.isFinite(opts.now as number) ? (opts.now as number) : Date.now();
  const maxStalenessMs =
    typeof opts.maxStalenessMs === "number" && opts.maxStalenessMs > 0 ? opts.maxStalenessMs : null;

  const reasons: BorrowExposureReason[] = [];
  const deny = (code: string, message: string, facts?: Record<string, unknown>) =>
    reasons.push({ code, message, facts });

  let skippedTerminal = 0;
  let countedRows = 0;
  let aggregateDebtUsd = 0;
  let collateralDebtUsd = 0;

  // Fail closed if the caller could not resolve the verified USDC mint: without
  // it we cannot prove a row's debt is denominated in USDC, so we cannot trust
  // the $-aggregate at all.
  if (typeof expectedUsdcMint !== "string" || expectedUsdcMint.trim() === "") {
    deny("exposure_usdc_mint_unresolved", "Could not resolve the verified USDC mint; refusing to size exposure.");
  }

  for (const row of rows) {
    // SOL-loop rows are a different product with SOL-denominated debt; they are
    // not part of the USDC borrow book (see BorrowExposureRow.kind docs). This
    // is an explicit EXEMPTION, not a fail-open: only the exact 'loop' tag is
    // skipped — any other unexpected debt denomination still fails closed below.
    if (row.kind === "loop") {
      continue;
    }
    if (TERMINAL_STATUSES.has(String(row.status))) {
      skippedTerminal++;
      continue;
    }
    countedRows++;

    const debtRaw = safeBigInt(row.debtAmountRaw);
    if (debtRaw === null) {
      deny("exposure_row_unreadable_debt", "A borrow position has an unreadable debt amount; refusing to size exposure.", {
        collateralMint: row.collateralMint,
        debtAmountRaw: row.debtAmountRaw,
      });
      continue;
    }

    // Debt MUST be USDC by both key and verified mint, or the $-sum is a lie.
    if (String(row.debtAssetKey).toLowerCase() !== "usdc" || row.debtMint !== expectedUsdcMint) {
      deny("exposure_non_usdc_debt", "A borrow position is not denominated in the verified USDC mint; refusing to size exposure.", {
        debtAssetKey: row.debtAssetKey,
        debtMint: row.debtMint,
      });
      continue;
    }

    if (typeof row.collateralMint !== "string" || row.collateralMint.trim() === "" ||
        typeof row.collateralAssetKey !== "string" || row.collateralAssetKey.trim() === "") {
      deny("exposure_row_missing_collateral", "A borrow position is missing its collateral identity; refusing to size exposure.");
      continue;
    }

    const debtUsd = Number(debtRaw) / 10 ** USDC_DEBT_DECIMALS;
    if (!Number.isFinite(debtUsd) || debtUsd < 0) {
      deny("exposure_row_bad_debt_value", "A borrow position produced a non-finite debt value; refusing to size exposure.", {
        debtAmountRaw: row.debtAmountRaw,
      });
      continue;
    }

    // Staleness only matters for OPEN rows once a monitor maintains the cache.
    if (maxStalenessMs !== null && debtUsd > 0) {
      const asOf = toEpochMs(row.healthAsOf) ?? toEpochMs(row.updatedAt);
      if (asOf === null || now - asOf > maxStalenessMs) {
        deny("exposure_cache_stale", "Platform borrow exposure cache is stale; refusing to size a new borrow until it refreshes.", {
          ageMs: asOf === null ? null : now - asOf,
          maxStalenessMs,
        });
        continue;
      }
    }

    aggregateDebtUsd += debtUsd;
    if (row.collateralMint === targetCollateralMint) collateralDebtUsd += debtUsd;
  }

  const stats = {
    totalRows: rows.length,
    skippedTerminal,
    countedRows,
    aggregateDebtUsd,
    collateralDebtUsd,
  };

  if (reasons.length > 0) {
    return { ok: false, reasons, stats };
  }

  // Invariant the policy also asserts: a single collateral cannot exceed the
  // aggregate. By construction it never does here, but clamp defensively so a
  // float rounding artifact can never trip the policy's impossible-book guard.
  const safeCollateralDebtUsd = Math.min(collateralDebtUsd, aggregateDebtUsd);

  return {
    ok: true,
    exposure: { aggregateDebtUsd, collateralDebtUsd: safeCollateralDebtUsd },
    reasons,
    stats,
  };
}
