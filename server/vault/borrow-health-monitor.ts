/**
 * BORROW-HEALTH MONITOR (FC-2) — band-crossing Telegram alerts for BOTH
 * account-level (tradingBotId null) and per-bot (Flash) borrow positions.
 *
 * DESIGN CONTRACT (testable + money-safe + low-noise):
 *   - The TRANSITION decision is PURE (`decideHealthAlertTransition`): given the
 *     row's persisted alert state + the freshly-computed band + `now`, it returns
 *     {shouldAlert, next}. No I/O, fully unit-tested.
 *   - `runBorrowHealthScan` is the only part that touches storage / the chain /
 *     Telegram. It enumerates EVERY active borrow row (account + per-bot, all
 *     wallets) via getActiveBorrowPositionsAllWallets, reads each row's live
 *     health EXACTLY ONCE through the shared scope-agnostic `computeRowHealth`
 *     (one vault-config read per distinct mint via a shared cache), persists the
 *     refreshed snapshot + alert state, and sends at most one alert per row.
 *   - FAIL CLOSED. An unreadable position is band `unavailable` (severity 4, the
 *     worst) and MUST notify — never silently suppressed. The protocol's own
 *     `liquidatable` flag already dominates inside computePerBotPositionHealth.
 *   - NO SPAM. We alert only on crossing INTO a band worse than the last one we
 *     alerted on. The same band never re-alerts. Recovery is silent and only
 *     lowers the alert baseline after the better band has HELD for the hysteresis
 *     window (anti-flap), so a later re-worsening re-alerts.
 *   - BOUNDED. Sequential reads keep RPC pressure low (Replit-constrained env +
 *     Solana cost minimization); the active-borrow set is small.
 */

import { storage } from "../storage";
import {
  BAND_SEVERITY,
  computeRowHealth,
  defaultRowHealthDeps,
  type BorrowHealthBand,
  type PerBotPositionHealth,
} from "./borrow-health";
import type { BorrowVaultConfig } from "./jupiter-lend-borrow-route";
import {
  sendBorrowHealthNotification,
  type BorrowHealthAlertBand,
  type BorrowHealthNotification,
  type BorrowHealthNotifyResult,
} from "../notification-service";
import type { BorrowPosition } from "@shared/schema";

/**
 * Anti-flap: only LOWER the alert baseline (so a re-worsening can re-alert) once
 * a better band has been continuously observed for this long. Worsening alerts
 * are always immediate and never gated by this window.
 */
export const RECOVER_HYSTERESIS_MS = 10 * 60 * 1000;

const HEALTH_SOURCE = "borrow-health-monitor";

const KNOWN_BANDS: readonly BorrowHealthBand[] = [
  "unavailable",
  "liquidation",
  "urgent",
  "nudge",
  "healthy",
];

function parseBand(s: string | null | undefined): BorrowHealthBand | null {
  return s != null && (KNOWN_BANDS as readonly string[]).includes(s)
    ? (s as BorrowHealthBand)
    : null;
}

const isAlertableBand = (b: BorrowHealthBand): b is BorrowHealthAlertBand =>
  b === "nudge" || b === "urgent" || b === "liquidation" || b === "unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// PURE transition state machine
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthAlertPersistedState {
  /** The worst band we have already NOTIFIED on (null = never alerted). */
  lastHealthAlertBand: BorrowHealthBand | null;
  lastHealthAlertAt: Date | null;
  /** The band observed on the previous scan (any band, drives hysteresis). */
  lastObservedHealthBand: BorrowHealthBand | null;
  /** When lastObservedHealthBand last CHANGED (anti-flap clock). */
  healthBandChangedAt: Date | null;
}

export interface HealthAlertNextState {
  lastObservedHealthBand: BorrowHealthBand;
  healthBandChangedAt: Date;
  lastHealthAlertBand: BorrowHealthBand | null;
  lastHealthAlertAt: Date | null;
}

export interface HealthAlertDecision {
  shouldAlert: boolean;
  next: HealthAlertNextState;
}

/**
 * PURE. Decide whether this scan should fire an alert and what the row's next
 * persisted alert state is.
 *
 *   - Alert when the new band is WORSE (higher severity) than the last band we
 *     alerted on AND is not `healthy`. Includes `unavailable` (fail-closed).
 *   - The same band never re-alerts (no repeat).
 *   - Improvement is silent and only lowers the alert baseline once the better
 *     band has held for `hysteresisMs` (anti-flap), so a later re-worsening
 *     re-alerts.
 */
export function decideHealthAlertTransition(
  prev: HealthAlertPersistedState,
  newBand: BorrowHealthBand,
  now: Date,
  hysteresisMs: number = RECOVER_HYSTERESIS_MS,
): HealthAlertDecision {
  const observedChanged = prev.lastObservedHealthBand !== newBand;
  const healthBandChangedAt =
    observedChanged || prev.healthBandChangedAt == null
      ? now
      : prev.healthBandChangedAt;

  const baselineBand: BorrowHealthBand = prev.lastHealthAlertBand ?? "healthy";
  const sevNew = BAND_SEVERITY[newBand];
  const sevBaseline = BAND_SEVERITY[baselineBand];

  // Crossed into a band worse than the last one we ALERTED on (and not healthy)
  // → alert now.
  if (newBand !== "healthy" && sevNew > sevBaseline) {
    return {
      shouldAlert: true,
      next: {
        lastObservedHealthBand: newBand,
        healthBandChangedAt,
        lastHealthAlertBand: newBand,
        lastHealthAlertAt: now,
      },
    };
  }

  // Improved below the alert baseline → lower the baseline ONLY after the better
  // band has been stable for the hysteresis window. No "recovered" spam.
  let nextAlertBand = prev.lastHealthAlertBand;
  let nextAlertAt = prev.lastHealthAlertAt;
  if (sevNew < sevBaseline) {
    const stableForMs = now.getTime() - healthBandChangedAt.getTime();
    if (stableForMs >= hysteresisMs) {
      nextAlertBand = newBand === "healthy" ? null : newBand;
      nextAlertAt = newBand === "healthy" ? null : prev.lastHealthAlertAt;
    }
  }

  return {
    shouldAlert: false,
    next: {
      lastObservedHealthBand: newBand,
      healthBandChangedAt,
      lastHealthAlertBand: nextAlertBand,
      lastHealthAlertAt: nextAlertAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner orchestrator (I/O)
// ─────────────────────────────────────────────────────────────────────────────

export interface BorrowHealthScanDeps {
  getActiveBorrowPositions(): Promise<BorrowPosition[]>;
  computeRowHealth(
    row: BorrowPosition,
    cfgCache: Map<string, BorrowVaultConfig | null>,
  ): Promise<PerBotPositionHealth>;
  persistAlertState(
    id: string,
    next: HealthAlertNextState,
    health: PerBotPositionHealth,
    asOf: Date,
  ): Promise<void>;
  resolveScopeLabel(row: BorrowPosition): Promise<string>;
  notify(
    walletAddress: string,
    n: BorrowHealthNotification,
  ): Promise<BorrowHealthNotifyResult>;
  now(): Date;
}

function collateralLabelFor(
  row: BorrowPosition,
  health: PerBotPositionHealth,
): string {
  const key = (health.collateralAssetKey ?? row.collateralAssetKey ?? "").trim();
  return key ? key.toUpperCase() : "Collateral";
}

function defaultDeps(): BorrowHealthScanDeps {
  const rowDeps = defaultRowHealthDeps();
  return {
    getActiveBorrowPositions: () => storage.getActiveBorrowPositionsAllWallets(),
    computeRowHealth: (row, cfgCache) =>
      computeRowHealth(
        {
          id: row.id,
          venuePositionId: row.venuePositionId,
          collateralMint: row.collateralMint ?? null,
          collateralAssetKey: row.collateralAssetKey ?? null,
        },
        rowDeps,
        cfgCache,
      ),
    persistAlertState: async (id, next, health, asOf) => {
      await storage.updateBorrowPosition(id, {
        lastObservedHealthBand: next.lastObservedHealthBand,
        healthBandChangedAt: next.healthBandChangedAt,
        lastHealthAlertBand: next.lastHealthAlertBand,
        lastHealthAlertAt: next.lastHealthAlertAt,
        healthSnapshot: {
          healthFactor: health.healthFactor,
          ltv: health.ltv,
          collateralValueUsd: health.collateralValueUsd,
          debtUsd: health.debtUsd,
          source: HEALTH_SOURCE,
        },
        healthAsOf: asOf,
        healthSource: HEALTH_SOURCE,
      });
    },
    resolveScopeLabel: async (row) => {
      if (!row.tradingBotId) return "Account";
      try {
        const bot = await storage.getTradingBotById(row.tradingBotId);
        return bot?.name?.trim() || "Bot";
      } catch {
        return "Bot";
      }
    },
    notify: (walletAddress, n) => sendBorrowHealthNotification(walletAddress, n),
    now: () => new Date(),
  };
}

/**
 * One scan pass over every active borrow position. Never throws — a single
 * row's failure is isolated and counted. Returns scan counters for logging.
 */
export async function runBorrowHealthScan(
  overrides?: Partial<BorrowHealthScanDeps>,
): Promise<{ scanned: number; alerted: number; failed: number }> {
  const deps: BorrowHealthScanDeps = { ...defaultDeps(), ...overrides };

  let rows: BorrowPosition[];
  try {
    rows = await deps.getActiveBorrowPositions();
  } catch (err) {
    console.error("[BorrowHealthMonitor] could not list active positions:", err);
    return { scanned: 0, alerted: 0, failed: 0 };
  }

  const cfgCache = new Map<string, BorrowVaultConfig | null>();
  const now = deps.now();
  let alerted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const health = await deps.computeRowHealth(row, cfgCache);
      const prev: HealthAlertPersistedState = {
        lastHealthAlertBand: parseBand(row.lastHealthAlertBand),
        lastHealthAlertAt: row.lastHealthAlertAt ?? null,
        lastObservedHealthBand: parseBand(row.lastObservedHealthBand),
        healthBandChangedAt: row.healthBandChangedAt ?? null,
      };

      const decision = decideHealthAlertTransition(prev, health.band, now);

      // FAIL CLOSED on delivery: only ADVANCE the alert baseline after the
      // notification is actually sent (or permanently skipped — no recipient).
      // A transient delivery failure keeps the old baseline so the next scan
      // retries, never silently dropping a liquidation/urgent/unavailable alert.
      let persistNext = decision.next;
      if (decision.shouldAlert && isAlertableBand(health.band)) {
        const scopeLabel = await deps.resolveScopeLabel(row);
        const outcome = await deps.notify(row.walletAddress, {
          scopeLabel,
          collateralLabel: collateralLabelFor(row, health),
          band: health.band,
          healthFactor: health.healthFactor,
          ltv: health.ltv,
        });
        if (outcome === "sent") {
          alerted++;
        } else if (outcome === "failed") {
          // Keep the prior alert baseline → retry next scan. Still refresh the
          // observed band / clock / snapshot below.
          persistNext = {
            ...decision.next,
            lastHealthAlertBand: prev.lastHealthAlertBand,
            lastHealthAlertAt: prev.lastHealthAlertAt,
          };
        }
        // "skipped": advance the baseline (nothing to deliver, nothing to retry).
      }

      await deps.persistAlertState(row.id, persistNext, health, now);
    } catch (err) {
      failed++;
      console.error(`[BorrowHealthMonitor] row ${row.id} failed:`, err);
    }
  }

  if (alerted > 0 || failed > 0) {
    console.log(
      `[BorrowHealthMonitor] scan complete: scanned=${rows.length} alerted=${alerted} failed=${failed}`,
    );
  }
  return { scanned: rows.length, alerted, failed };
}
