import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WO-21 (addendum) change detection: recomputeWalletSnapshots must issue
 * ZERO UPDATEs when the stored rows are mathematically unchanged — even when
 * PG returns padded decimal strings ("100.000000") while the computation
 * produces String(number) ("100"). Comparison is normalized at the
 * destination columns' six-decimal scale via decimal.js, not literal string
 * equality and not a float tolerance.
 */

const h = vi.hoisted(() => {
  const state = {
    snapshotsByWallet: new Map<string, any[]>(),
    eventsRows: [] as any[],
    updates: [] as Array<Record<string, string>>,
  };
  return { state };
});

vi.mock("../../server/storage", () => ({
  storage: {
    getPortfolioDailySnapshots: vi.fn(
      async (wallet: string) => h.state.snapshotsByWallet.get(wallet) ?? [],
    ),
  },
}));

vi.mock("../../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => h.state.eventsRows,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, string>) => ({
        where: async () => {
          h.state.updates.push(values);
        },
      }),
    }),
  },
}));

import {
  recomputeWalletSnapshots,
  sameAtDbScale,
} from "../../server/portfolio-snapshot-backfill";

const d = (iso: string) => new Date(iso);

beforeEach(() => {
  h.state.snapshotsByWallet.clear();
  h.state.eventsRows = [];
  h.state.updates = [];
  vi.clearAllMocks();
});

describe("sameAtDbScale — scale-6 decimal normalization", () => {
  it("treats padded PG strings as equal to String(number) forms", () => {
    expect(sameAtDbScale("100.000000", "100")).toBe(true);
    expect(sameAtDbScale("100.100000", "100.1")).toBe(true);
    expect(sameAtDbScale("0.000000", "0")).toBe(true);
    expect(sameAtDbScale("-30.500000", "-30.5")).toBe(true);
  });

  it("equates values that differ only BELOW the six-decimal column scale", () => {
    // PG would store both as the same decimal(…,6) value.
    expect(sameAtDbScale("100.000000", "100.0000004")).toBe(true);
    expect(sameAtDbScale("0.300000", "0.30000000000000004")).toBe(true); // 0.1+0.2 float artifact
  });

  it("distinguishes values that differ AT the six-decimal scale", () => {
    expect(sameAtDbScale("100.000001", "100")).toBe(false);
    expect(sameAtDbScale("100.000000", "100.000001")).toBe(false);
    expect(sameAtDbScale("0.5", "-0.5")).toBe(false);
  });

  it("handles scientific notation from String(number) on tiny values", () => {
    // String(1e-7) === "1e-7" — decimal.js parses it; rounds to 0 at scale 6.
    expect(sameAtDbScale("0.000000", "1e-7")).toBe(true);
    expect(sameAtDbScale("0.000010", "1e-5")).toBe(true);
  });

  it("falls back toward writing (not equal) on non-numeric input", () => {
    expect(sameAtDbScale("abc", "100")).toBe(false);
    expect(sameAtDbScale("abc", "abc")).toBe(true); // literal fallback
  });
});

describe("recomputeWalletSnapshots — change detection", () => {
  it("issues zero UPDATEs when stored rows already match (padded PG strings)", async () => {
    // Expected computation: deposits=100, withdrawals=0, internal=0,
    // tradingPnl = 150 - 100 = 50, netExtFlow = 100, pnlPercent = 50.
    h.state.snapshotsByWallet.set("WalletAAAA", [
      { id: "s1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "150.000000",
        cumulativeExternalDeposits: "100.000000",
        cumulativeExternalWithdrawals: "0.000000",
        cumulativeInternalTransfers: "0.000000",
        cumulativeTradingPnl: "50.000000",
        netExternalFlow: "100.000000",
        pnlPercent: "50.000000",
        netPnl: "50.000000" },
    ]);
    h.state.eventsRows = [
      { eventType: "agent_deposit", assetType: null, amount: "100",
        txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
    ];

    const written = await recomputeWalletSnapshots("WalletAAAA");

    expect(written).toBe(0);
    expect(h.state.updates.length).toBe(0);
  });

  it("issues zero UPDATEs when float accumulation differs only below scale 6", async () => {
    // Three deposits of 0.1 + 0.2 + 0.3: float sum = 0.6000000000000001.
    // Stored PG value "0.600000" must be recognized as unchanged.
    // tradingPnl = 1.0 - 0.6000000000000001 = 0.3999999999999999 vs stored "0.400000".
    h.state.snapshotsByWallet.set("WalletFRAC", [
      { id: "f1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "1.000000",
        cumulativeExternalDeposits: "0.600000",
        cumulativeExternalWithdrawals: "0.000000",
        cumulativeInternalTransfers: "0.000000",
        cumulativeTradingPnl: "0.400000",
        netExternalFlow: "0.600000",
        pnlPercent: "40.000000",
        netPnl: "0.400000" },
    ]);
    h.state.eventsRows = [
      { eventType: "agent_deposit", assetType: null, amount: "0.1",
        txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
      { eventType: "agent_deposit", assetType: null, amount: "0.2",
        txBlockTime: d("2026-06-01T01:00:00Z"), createdAt: d("2026-06-01T01:00:00Z") },
      { eventType: "agent_deposit", assetType: null, amount: "0.3",
        txBlockTime: d("2026-06-01T02:00:00Z"), createdAt: d("2026-06-01T02:00:00Z") },
    ];

    const written = await recomputeWalletSnapshots("WalletFRAC");

    expect(written).toBe(0);
    expect(h.state.updates.length).toBe(0);
  });

  it("writes only the rows whose values changed", async () => {
    h.state.snapshotsByWallet.set("WalletAAAA", [
      // Row 1: already correct.
      { id: "s1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "150.000000",
        cumulativeExternalDeposits: "100.000000",
        cumulativeExternalWithdrawals: "0.000000",
        cumulativeInternalTransfers: "0.000000",
        cumulativeTradingPnl: "50.000000",
        netExternalFlow: "100.000000",
        pnlPercent: "50.000000",
        netPnl: "50.000000" },
      // Row 2: stale values → must be rewritten.
      { id: "s2", snapshotDate: d("2026-06-03T00:00:00Z"), totalBalance: "160.000000",
        cumulativeExternalDeposits: "0",
        cumulativeExternalWithdrawals: "0",
        cumulativeInternalTransfers: "0",
        cumulativeTradingPnl: "0",
        netExternalFlow: "0",
        pnlPercent: "0",
        netPnl: "0" },
    ]);
    h.state.eventsRows = [
      { eventType: "agent_deposit", assetType: null, amount: "100",
        txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
    ];

    const written = await recomputeWalletSnapshots("WalletAAAA");

    expect(written).toBe(1);
    expect(h.state.updates.length).toBe(1);
    // s2 expected: deposits=100, tradingPnl = 160-100 = 60, netExtFlow = 0
    // (no new flow between s1 and s2), pnlPercent = 60.
    expect(h.state.updates[0]).toEqual({
      cumulativeExternalDeposits: "100",
      cumulativeExternalWithdrawals: "0",
      cumulativeInternalTransfers: "0",
      cumulativeTradingPnl: "60",
      netExternalFlow: "0",
      pnlPercent: "60",
      netPnl: "60",
    });
  });

  it("detects a change at exactly the six-decimal scale and rewrites the row", async () => {
    // Stored deposits off by 0.000001 (one ULP of the column) → must rewrite.
    h.state.snapshotsByWallet.set("WalletULP", [
      { id: "u1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "150.000000",
        cumulativeExternalDeposits: "100.000001",
        cumulativeExternalWithdrawals: "0.000000",
        cumulativeInternalTransfers: "0.000000",
        cumulativeTradingPnl: "50.000000",
        netExternalFlow: "100.000000",
        pnlPercent: "50.000000",
        netPnl: "50.000000" },
    ]);
    h.state.eventsRows = [
      { eventType: "agent_deposit", assetType: null, amount: "100",
        txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
    ];

    const written = await recomputeWalletSnapshots("WalletULP");

    expect(written).toBe(1);
    expect(h.state.updates.length).toBe(1);
  });
});
