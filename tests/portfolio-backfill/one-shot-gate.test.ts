import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WO-21 Fix A (persistent version-flag gate) + Fix B change detection.
 *
 * - runPortfolioBackfillOnce runs when the flag is absent, skips when the
 *   flag equals the current version, re-runs when the flag holds an OLDER
 *   version, and does NOT set the flag when a wallet fails.
 * - recomputeWalletSnapshots issues ZERO UPDATEs when the stored rows already
 *   carry the computed values (including PG-normalized "300.000000" vs
 *   String(number) "300" representation differences).
 */

const h = vi.hoisted(() => {
  const state = {
    flags: new Map<string, string>(),
    wallets: [] as string[],
    // Single-wallet tests: recomputeWalletSnapshots reads snapshots via
    // storage (per-wallet) and events via the mocked db.select below.
    snapshotsByWallet: new Map<string, any[]>(),
    eventsRows: [] as any[],
    failWallets: new Set<string>(),
    updates: [] as Array<Record<string, string>>,
  };
  return { state };
});

vi.mock("../../server/storage", () => ({
  storage: {
    getSystemFlag: vi.fn(async (key: string) => h.state.flags.get(key) ?? null),
    setSystemFlag: vi.fn(async (key: string, value: string) => {
      h.state.flags.set(key, value);
    }),
    getWalletsWithTradingBots: vi.fn(async () => h.state.wallets),
    getPortfolioDailySnapshots: vi.fn(async (wallet: string) => {
      if (h.state.failWallets.has(wallet)) throw new Error("simulated wallet failure");
      return h.state.snapshotsByWallet.get(wallet) ?? [];
    }),
  },
}));

vi.mock("../../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => h.state.eventsRows,
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
  runPortfolioBackfillOnce,
  recomputeWalletSnapshots,
} from "../../server/portfolio-snapshot-backfill";
import { storage } from "../../server/storage";

const FLAG_KEY = "portfolio_backfill_version";
const CURRENT_VERSION = "task119-v1";
const d = (iso: string) => new Date(iso);

beforeEach(() => {
  h.state.flags.clear();
  h.state.wallets = [];
  h.state.snapshotsByWallet.clear();
  h.state.eventsRows = [];
  h.state.failWallets.clear();
  h.state.updates = [];
  vi.clearAllMocks();
});

describe("runPortfolioBackfillOnce — persistent flag gating", () => {
  it("runs when the flag is absent and sets the flag on full success", async () => {
    h.state.wallets = ["WalletAAAA"];
    h.state.snapshotsByWallet.set("WalletAAAA", [
      { id: "s1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "150",
        cumulativeExternalDeposits: "0", cumulativeExternalWithdrawals: "0",
        cumulativeInternalTransfers: "0", cumulativeTradingPnl: "0",
        netExternalFlow: "0", pnlPercent: "0", netPnl: "0" },
    ]);
    h.state.eventsRows = [
      { eventType: "agent_deposit", assetType: null, amount: "100",
        txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
    ];

    await runPortfolioBackfillOnce();

    expect(storage.getWalletsWithTradingBots).toHaveBeenCalledTimes(1);
    expect(h.state.updates.length).toBe(1); // stale row rewritten
    expect(h.state.flags.get(FLAG_KEY)).toBe(CURRENT_VERSION);
  });

  it("skips entirely when the flag equals the current version", async () => {
    h.state.flags.set(FLAG_KEY, CURRENT_VERSION);
    h.state.wallets = ["WalletAAAA"];

    await runPortfolioBackfillOnce();

    expect(storage.getWalletsWithTradingBots).not.toHaveBeenCalled();
    expect(h.state.updates.length).toBe(0);
  });

  it("re-runs when the flag holds an older version, then upgrades it", async () => {
    h.state.flags.set(FLAG_KEY, "task118-v0");
    h.state.wallets = ["WalletAAAA"];
    h.state.snapshotsByWallet.set("WalletAAAA", []);

    await runPortfolioBackfillOnce();

    expect(storage.getWalletsWithTradingBots).toHaveBeenCalledTimes(1);
    expect(h.state.flags.get(FLAG_KEY)).toBe(CURRENT_VERSION);
  });

  it("does NOT set the flag when any wallet fails (retries next boot)", async () => {
    h.state.wallets = ["GoodWallet", "BadWallet"];
    h.state.snapshotsByWallet.set("GoodWallet", []);
    h.state.failWallets.add("BadWallet");

    await runPortfolioBackfillOnce();

    expect(h.state.flags.has(FLAG_KEY)).toBe(false);
    expect(storage.setSystemFlag).not.toHaveBeenCalled();
  });
});

describe("recomputeWalletSnapshots — change detection", () => {
  it("issues zero UPDATEs when stored rows already match (PG-normalized strings)", async () => {
    // Expected computation: deposits=100, withdrawals=0, internal=0,
    // tradingPnl = 150 - 100 = 50, netExtFlow = 100, pnlPercent = 50.
    h.state.snapshotsByWallet.set("WalletAAAA", [
      { id: "s1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "150.000000",
        // PG decimal(…,6) normalized forms — must compare EQUAL to String(number).
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

  it("writes only the rows whose values changed", async () => {
    h.state.snapshotsByWallet.set("WalletAAAA", [
      // Row 1: already correct (as above).
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
});
