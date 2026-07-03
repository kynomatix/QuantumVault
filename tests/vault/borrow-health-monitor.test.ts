import { describe, it, expect } from "vitest";
import {
  decideHealthAlertTransition,
  runBorrowHealthScan,
  RECOVER_HYSTERESIS_MS,
  type HealthAlertPersistedState,
  type BorrowHealthScanDeps,
} from "../../server/vault/borrow-health-monitor";
import type {
  BorrowHealthBand,
  PerBotPositionHealth,
} from "../../server/vault/borrow-health";
import type { BorrowPosition } from "@shared/schema";

const T0 = new Date("2026-06-30T00:00:00.000Z");
const ms = (base: Date, deltaMs: number) => new Date(base.getTime() + deltaMs);

const FRESH: HealthAlertPersistedState = {
  lastHealthAlertBand: null,
  lastHealthAlertAt: null,
  lastObservedHealthBand: null,
  healthBandChangedAt: null,
};

// ───────────────────────────── pure transition machine ─────────────────────

describe("decideHealthAlertTransition (pure)", () => {
  it("alerts on the first crossing into a non-healthy band", () => {
    const d = decideHealthAlertTransition(FRESH, "urgent", T0);
    expect(d.shouldAlert).toBe(true);
    expect(d.next.lastHealthAlertBand).toBe("urgent");
    expect(d.next.lastHealthAlertAt).toEqual(T0);
    expect(d.next.lastObservedHealthBand).toBe("urgent");
    expect(d.next.healthBandChangedAt).toEqual(T0);
  });

  it("does NOT re-alert while the same band persists", () => {
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: T0,
      lastObservedHealthBand: "urgent",
      healthBandChangedAt: T0,
    };
    const d = decideHealthAlertTransition(prev, "urgent", ms(T0, 60_000));
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBe("urgent");
    // alert timestamp not refreshed for a non-alert
    expect(d.next.lastHealthAlertAt).toEqual(T0);
  });

  it("alerts when worsening urgent → liquidation", () => {
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: T0,
      lastObservedHealthBand: "urgent",
      healthBandChangedAt: T0,
    };
    const d = decideHealthAlertTransition(prev, "liquidation", ms(T0, 30_000));
    expect(d.shouldAlert).toBe(true);
    expect(d.next.lastHealthAlertBand).toBe("liquidation");
  });

  it("treats `unavailable` as the worst band → alerts from liquidation", () => {
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "liquidation",
      lastHealthAlertAt: T0,
      lastObservedHealthBand: "liquidation",
      healthBandChangedAt: T0,
    };
    const d = decideHealthAlertTransition(prev, "unavailable", ms(T0, 30_000));
    expect(d.shouldAlert).toBe(true);
    expect(d.next.lastHealthAlertBand).toBe("unavailable");
  });

  it("fail-closed: alerts on first-ever unavailable read", () => {
    const d = decideHealthAlertTransition(FRESH, "unavailable", T0);
    expect(d.shouldAlert).toBe(true);
    expect(d.next.lastHealthAlertBand).toBe("unavailable");
  });

  it("improvement BEFORE hysteresis does NOT lower the alert baseline", () => {
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: T0,
      lastObservedHealthBand: "urgent",
      healthBandChangedAt: T0,
    };
    // first scan at the better band → clock resets, baseline held
    const d = decideHealthAlertTransition(
      prev,
      "nudge",
      ms(T0, RECOVER_HYSTERESIS_MS - 1),
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBe("urgent");
    expect(d.next.lastObservedHealthBand).toBe("nudge");
    expect(d.next.healthBandChangedAt).toEqual(ms(T0, RECOVER_HYSTERESIS_MS - 1));
  });

  it("improvement AFTER hysteresis lowers the baseline (re-worsening can re-alert)", () => {
    // the better band has already been observed (changedAt set earlier)
    const changedAt = T0;
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: ms(T0, -60_000),
      lastObservedHealthBand: "nudge",
      healthBandChangedAt: changedAt,
    };
    const d = decideHealthAlertTransition(
      prev,
      "nudge",
      ms(changedAt, RECOVER_HYSTERESIS_MS),
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBe("nudge");
  });

  it("recovery to healthy after hysteresis clears the baseline to null", () => {
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: ms(T0, -60_000),
      lastObservedHealthBand: "healthy",
      healthBandChangedAt: T0,
    };
    const d = decideHealthAlertTransition(
      prev,
      "healthy",
      ms(T0, RECOVER_HYSTERESIS_MS),
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBeNull();
    expect(d.next.lastHealthAlertAt).toBeNull();
  });

  it("flap within the window does not re-alert (baseline never lowered)", () => {
    // baseline urgent, dipped to nudge briefly, back to urgent before hysteresis
    const prev: HealthAlertPersistedState = {
      lastHealthAlertBand: "urgent",
      lastHealthAlertAt: T0,
      lastObservedHealthBand: "nudge",
      healthBandChangedAt: ms(T0, 30_000),
    };
    const d = decideHealthAlertTransition(prev, "urgent", ms(T0, 60_000));
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBe("urgent");
  });

  it("never alerts on healthy and keeps the baseline null when never alerted", () => {
    const d = decideHealthAlertTransition(FRESH, "healthy", T0);
    expect(d.shouldAlert).toBe(false);
    expect(d.next.lastHealthAlertBand).toBeNull();
    expect(d.next.lastObservedHealthBand).toBe("healthy");
  });
});

// ───────────────────────────── orchestrator (fake deps) ────────────────────

function row(overrides: Partial<BorrowPosition> = {}): BorrowPosition {
  return {
    id: "row-1",
    walletAddress: "Wallet1",
    tradingBotId: null,
    collateralAssetKey: "inf",
    collateralMint: "InfMint",
    venuePositionId: 7,
    lastObservedHealthBand: null,
    healthBandChangedAt: null,
    lastHealthAlertBand: null,
    lastHealthAlertAt: null,
    ...overrides,
  } as unknown as BorrowPosition;
}

function health(
  band: BorrowHealthBand,
  healthFactor: number | null,
): PerBotPositionHealth {
  return {
    borrowPositionId: "x",
    venuePositionId: 7,
    collateralAssetKey: "inf",
    collateralMint: "InfMint",
    status: band === "unavailable" ? "unavailable" : "available",
    collateralValueUsd: band === "unavailable" ? null : 100,
    debtUsd: band === "unavailable" ? null : 64,
    ltv: band === "unavailable" ? null : 0.64,
    healthFactor,
    liquidatable: band === "liquidation" ? true : false,
    band,
    liveCollateralRaw: band === "unavailable" ? null : "1000000000",
    liveDebtRaw: band === "unavailable" ? null : "64000000",
  };
}

type NotifyResult = "sent" | "skipped" | "failed";

function statefulDeps(opts: {
  rows: BorrowPosition[];
  healthByRowId: Record<string, PerBotPositionHealth | "throw">;
  notify?: (n: BorrowHealthNotification) => NotifyResult;
  now?: Date;
}): {
  deps: Partial<BorrowHealthScanDeps>;
  persisted: Array<{ id: string; band: BorrowHealthBand | null }>;
  notifications: Array<{ wallet: string; band: BorrowHealthBand; scope: string }>;
  rowsById: Map<string, BorrowPosition>;
} {
  const persisted: Array<{ id: string; band: BorrowHealthBand | null }> = [];
  const notifications: Array<{
    wallet: string;
    band: BorrowHealthBand;
    scope: string;
  }> = [];
  const rowsById = new Map(opts.rows.map((r) => [r.id, r]));
  const deps: Partial<BorrowHealthScanDeps> = {
    getActiveBorrowPositions: async () => opts.rows,
    computeRowHealth: async (r) => {
      const h = opts.healthByRowId[r.id];
      if (h === "throw") throw new Error("read failed");
      return h;
    },
    // Mutate the shared row so a follow-up scan reads the persisted state.
    persistAlertState: async (id, next) => {
      persisted.push({ id, band: next.lastHealthAlertBand });
      const r = rowsById.get(id) as unknown as Record<string, unknown> | undefined;
      if (r) {
        r.lastObservedHealthBand = next.lastObservedHealthBand;
        r.healthBandChangedAt = next.healthBandChangedAt;
        r.lastHealthAlertBand = next.lastHealthAlertBand;
        r.lastHealthAlertAt = next.lastHealthAlertAt;
      }
    },
    resolveScopeLabel: async (r) => (r.tradingBotId ? "My Bot" : "Account"),
    notify: async (wallet, n) => {
      const res = opts.notify ? opts.notify(n) : "sent";
      if (res === "sent") {
        notifications.push({ wallet, band: n.band, scope: n.scopeLabel });
      }
      return res;
    },
    now: () => opts.now ?? T0,
  };
  return { deps, persisted, notifications, rowsById };
}

describe("runBorrowHealthScan (orchestrator)", () => {
  it("alerts only the worsened row, persists every row, never double-fires healthy", async () => {
    const rows = [
      row({ id: "acct", tradingBotId: null }),
      row({ id: "bot", tradingBotId: "bot-123" }),
    ];
    const { deps, persisted, notifications } = statefulDeps({
      rows,
      healthByRowId: {
        acct: health("urgent", 1.25),
        bot: health("healthy", null),
      },
    });

    const res = await runBorrowHealthScan(deps);

    expect(res).toEqual({ scanned: 2, alerted: 1, failed: 0, loopObservations: [] });
    expect(notifications).toEqual([
      { wallet: "Wallet1", band: "urgent", scope: "Account" },
    ]);
    expect(persisted.map((p) => p.id).sort()).toEqual(["acct", "bot"]);
  });

  it("isolates a single row's read failure (counts it, keeps scanning)", async () => {
    const rows = [
      row({ id: "good", tradingBotId: "bot-1" }),
      row({ id: "bad", tradingBotId: "bot-2" }),
    ];
    const { deps, notifications } = statefulDeps({
      rows,
      healthByRowId: {
        good: health("liquidation", 1.0),
        bad: "throw",
      },
    });

    const res = await runBorrowHealthScan(deps);

    expect(res).toEqual({ scanned: 2, alerted: 1, failed: 1, loopObservations: [] });
    expect(notifications).toEqual([
      { wallet: "Wallet1", band: "liquidation", scope: "My Bot" },
    ]);
  });

  it("returns zeroed counters when the position list itself is unreadable", async () => {
    const res = await runBorrowHealthScan({
      getActiveBorrowPositions: async () => {
        throw new Error("db down");
      },
    });
    expect(res).toEqual({ scanned: 0, alerted: 0, failed: 0, loopObservations: [] });
  });

  it("collects loop observations for open loop rows — even when alert persist fails (safety reflex must not starve)", async () => {
    const rows = [
      row({ id: "loop-open", kind: "loop", status: "open" } as Partial<BorrowPosition>),
      row({ id: "borrow-row", tradingBotId: "bot-1" }),
    ];
    const { deps } = statefulDeps({
      rows,
      healthByRowId: {
        "loop-open": health("urgent", 1.2),
        "borrow-row": health("healthy", 2.0),
      },
    });
    // Persist failure must NOT drop the loop observation (collected pre-persist).
    deps.persistAlertState = async () => {
      throw new Error("persist down");
    };

    const res = await runBorrowHealthScan(deps);

    expect(res.failed).toBe(2); // both rows failed persist…
    expect(res.loopObservations).toHaveLength(1); // …but the loop reading survived
    expect(res.loopObservations[0].row.id).toBe("loop-open");
    expect(res.loopObservations[0].health.band).toBe("urgent");
  });

  it("FAIL CLOSED: a transient send failure keeps the baseline so the NEXT scan retries", async () => {
    const rows = [row({ id: "acct", tradingBotId: null })];
    let attempt = 0;
    const { deps, rowsById } = statefulDeps({
      rows,
      healthByRowId: { acct: health("liquidation", 1.0) },
      notify: () => (++attempt === 1 ? "failed" : "sent"),
    });

    // Scan 1: delivery fails → baseline NOT advanced.
    const r1 = await runBorrowHealthScan(deps);
    expect(r1.alerted).toBe(0);
    expect(rowsById.get("acct")!.lastHealthAlertBand ?? null).toBeNull();

    // Scan 2: same band still alerts (retry), now delivers.
    const r2 = await runBorrowHealthScan(deps);
    expect(r2.alerted).toBe(1);
    expect(rowsById.get("acct")!.lastHealthAlertBand).toBe("liquidation");
  });

  it("a permanently-skipped send advances the baseline (no recipient → no retry storm)", async () => {
    const rows = [row({ id: "acct", tradingBotId: null })];
    const { deps, rowsById } = statefulDeps({
      rows,
      healthByRowId: { acct: health("urgent", 1.25) },
      notify: () => "skipped",
    });

    const r1 = await runBorrowHealthScan(deps);
    expect(r1.alerted).toBe(0);
    // Baseline advanced even though nothing was delivered (nothing to retry).
    expect(rowsById.get("acct")!.lastHealthAlertBand).toBe("urgent");

    // Next scan does NOT re-attempt the same band.
    let secondAttempt = false;
    const deps2 = statefulDeps({
      rows,
      healthByRowId: { acct: health("urgent", 1.25) },
      notify: () => {
        secondAttempt = true;
        return "skipped";
      },
    });
    await runBorrowHealthScan(deps2.deps);
    expect(secondAttempt).toBe(false);
  });
});
