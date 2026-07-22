import { describe, it, expect, vi } from "vitest";
import Decimal from "decimal.js";

/**
 * WO-21 Fix B equivalence proof: the new pure `computeSnapshotRollups`
 * (single sorted pointer walk) must produce byte-identical output to the OLD
 * per-row logic (re-fetch + re-filter the full event list for every snapshot,
 * with the `eventTime > asOf → skip` filter and prev-snapshot chaining).
 *
 * The oracle below mirrors the old `_recomputeForSnapshots` +
 * `getWalletCumulativeDepositsWithdrawals` pair verbatim.
 */

// Keep the module import light: the backfill module pulls in storage + db,
// neither of which these pure tests touch.
vi.mock("../../server/db", () => ({ db: {} }));
vi.mock("../../server/storage", () => ({ storage: {} }));

import {
  computeSnapshotRollups,
  type ClassifiedFlowEvent,
  type RollupSnapshotInput,
} from "../../server/portfolio-snapshot-backfill";
import { classifyEquityEvent } from "../../server/equity-event-classifier";

interface RawEvent {
  eventType: string;
  assetType?: string | null;
  amount: string;
  txBlockTime: Date | null;
  createdAt: Date;
}

function toClassified(raw: RawEvent[]): ClassifiedFlowEvent[] {
  const out: ClassifiedFlowEvent[] = [];
  for (const event of raw) {
    const category = classifyEquityEvent(event);
    if (category === "ignore") continue;
    out.push({
      time: event.txBlockTime ?? event.createdAt,
      category,
      amount: Math.abs(parseFloat(event.amount)),
    });
  }
  return out;
}

/** Verbatim mirror of the OLD per-snapshot cumulative computation. */
function oracleCumulative(raw: RawEvent[], asOf: Date) {
  let deposits = 0;
  let withdrawals = 0;
  let internalTransfers = 0;
  for (const event of raw) {
    const eventTime = event.txBlockTime ?? event.createdAt;
    if (eventTime > asOf) continue; // old filter: > asOf skipped, <= included
    const amount = parseFloat(event.amount);
    const category = classifyEquityEvent(event);
    if (category === "external_deposit") deposits += Math.abs(amount);
    else if (category === "external_withdraw") withdrawals += Math.abs(amount);
    else if (category === "internal_transfer") internalTransfers += Math.abs(amount);
  }
  return { deposits, withdrawals, internalTransfers };
}

/** Verbatim mirror of the OLD `_recomputeForSnapshots` loop (ascending order). */
function oracleRollups(snapshots: RollupSnapshotInput[], raw: RawEvent[]) {
  const sorted = [...snapshots].sort(
    (a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime(),
  );
  let prevExtDeposits = 0;
  let prevExtWithdrawals = 0;
  const out: Array<{ id: string; set: Record<string, string> }> = [];
  for (const s of sorted) {
    const balance = parseFloat(s.totalBalance);
    const { deposits, withdrawals, internalTransfers } = oracleCumulative(raw, s.snapshotDate);
    const netExtFlow = (deposits - prevExtDeposits) - (withdrawals - prevExtWithdrawals);
    const tradingPnl = balance - (deposits - withdrawals);
    const denom = Math.max(deposits, 1);
    let pnlPercent = (tradingPnl / denom) * 100;
    if (pnlPercent > 1000) pnlPercent = 1000;
    if (pnlPercent < -100) pnlPercent = -100;
    out.push({
      id: s.id,
      set: {
        cumulativeExternalDeposits: String(deposits),
        cumulativeExternalWithdrawals: String(withdrawals),
        cumulativeInternalTransfers: String(internalTransfers),
        cumulativeTradingPnl: String(tradingPnl),
        netExternalFlow: String(netExtFlow),
        pnlPercent: String(pnlPercent),
        netPnl: String(tradingPnl),
      },
    });
    prevExtDeposits = deposits;
    prevExtWithdrawals = withdrawals;
  }
  return out;
}

const d = (iso: string) => new Date(iso);

/**
 * WO-21 addendum: old and new results must be compared after normalization
 * to the database column scale (decimal(…,6)) — the DB rounds both to six
 * decimals on write, so equivalence at that scale is the real invariant.
 */
function normalizeAtDbScale(
  rollups: Array<{ id: string; set: Record<string, string> }>,
) {
  return rollups.map((r) => ({
    id: r.id,
    set: Object.fromEntries(
      Object.entries(r.set).map(([k, v]) => [k, new Decimal(v).toDecimalPlaces(6).toString()]),
    ),
  }));
}

describe("computeSnapshotRollups — equivalence with old per-row logic", () => {
  it("matches the oracle on a mixed fixture (categories, null txBlockTime, tie case, unsorted input)", () => {
    const raw: RawEvent[] = [
      // external deposit with on-chain block time
      { eventType: "agent_deposit", amount: "100", txBlockTime: d("2026-06-01T10:00:00Z"), createdAt: d("2026-06-05T00:00:00Z") },
      // external deposit with NULL block time → falls back to createdAt
      { eventType: "agent_deposit", amount: "50", txBlockTime: null, createdAt: d("2026-06-02T12:00:00Z") },
      // negative-amount withdraw → Math.abs
      { eventType: "agent_withdraw", amount: "-30", txBlockTime: d("2026-06-03T08:00:00Z"), createdAt: d("2026-06-03T08:01:00Z") },
      // internal transfers
      { eventType: "drift_deposit", amount: "40", txBlockTime: null, createdAt: d("2026-06-02T15:00:00Z") },
      { eventType: "auto_topup", amount: "5", txBlockTime: d("2026-06-04T09:00:00Z"), createdAt: d("2026-06-04T09:00:01Z") },
      // unknown event type → internal_transfer (classifier safe default)
      { eventType: "some_future_type", amount: "7", txBlockTime: null, createdAt: d("2026-06-03T20:00:00Z") },
      // SOL asset → ignore entirely
      { eventType: "agent_deposit", assetType: "SOL", amount: "2", txBlockTime: null, createdAt: d("2026-06-01T00:00:00Z") },
      // TIE CASE: eventTime exactly equals snapshot 06-04 date → must be INCLUDED there
      { eventType: "agent_deposit", amount: "25", txBlockTime: d("2026-06-04T00:00:00Z"), createdAt: d("2026-06-10T00:00:00Z") },
      // event after all snapshots → never counted
      { eventType: "agent_deposit", amount: "999", txBlockTime: d("2026-07-01T00:00:00Z"), createdAt: d("2026-07-01T00:00:00Z") },
    ];

    // Deliberately unsorted snapshot input order.
    const snapshots: RollupSnapshotInput[] = [
      { id: "s3", snapshotDate: d("2026-06-04T00:00:00Z"), totalBalance: "160.5" },
      { id: "s1", snapshotDate: d("2026-06-01T23:59:59Z"), totalBalance: "101.25" },
      { id: "s4", snapshotDate: d("2026-06-05T00:00:00Z"), totalBalance: "120" },
      { id: "s2", snapshotDate: d("2026-06-03T00:00:00Z"), totalBalance: "148" },
    ];

    const actual = computeSnapshotRollups(snapshots, toClassified(raw));
    const expected = oracleRollups(snapshots, raw);

    expect(actual).toEqual(expected);
    expect(normalizeAtDbScale(actual)).toEqual(normalizeAtDbScale(expected));
    // Sanity: output is ascending by snapshot date (s1, s2, s3, s4).
    expect(actual.map((r) => r.id)).toEqual(["s1", "s2", "s3", "s4"]);
    // Tie event (25 at exactly s3's date) included in s3's cumulative deposits:
    // 100 + 50 + 25 = 175.
    expect(actual[2].set.cumulativeExternalDeposits).toBe("175");
    // But not in s2's (100 + 50 = 150).
    expect(actual[1].set.cumulativeExternalDeposits).toBe("150");
  });

  it("also matches the oracle when events arrive unsorted", () => {
    const raw: RawEvent[] = [
      { eventType: "agent_withdraw", amount: "10", txBlockTime: d("2026-06-03T00:00:00Z"), createdAt: d("2026-06-03T00:00:00Z") },
      { eventType: "agent_deposit", amount: "200", txBlockTime: d("2026-06-01T00:00:00Z"), createdAt: d("2026-06-01T00:00:00Z") },
      { eventType: "agent_deposit", amount: "20", txBlockTime: d("2026-06-02T00:00:00Z"), createdAt: d("2026-06-02T00:00:00Z") },
    ];
    const snapshots: RollupSnapshotInput[] = [
      { id: "a", snapshotDate: d("2026-06-02T12:00:00Z"), totalBalance: "230" },
      { id: "b", snapshotDate: d("2026-06-04T00:00:00Z"), totalBalance: "215" },
    ];
    // Pass events reversed relative to time order.
    const actual = computeSnapshotRollups(snapshots, toClassified(raw));
    expect(actual).toEqual(oracleRollups(snapshots, raw));
  });

  it("matches the oracle at DB scale under fractional accumulation (float artifacts)", () => {
    // Repeated small fractional deposits/withdrawals produce float sums like
    // 0.30000000000000004. Old code re-summed from scratch per snapshot; new
    // code accumulates incrementally — both must agree once normalized to the
    // column's six-decimal scale.
    const raw: RawEvent[] = [];
    for (let i = 0; i < 30; i++) {
      raw.push({
        eventType: i % 3 === 2 ? "agent_withdraw" : "agent_deposit",
        amount: i % 2 === 0 ? "0.1" : "0.2",
        txBlockTime: null,
        createdAt: new Date(Date.UTC(2026, 5, 1, i)), // hourly on 2026-06-01
      });
    }
    const snapshots: RollupSnapshotInput[] = [
      { id: "n1", snapshotDate: d("2026-06-01T05:30:00Z"), totalBalance: "0.55" },
      { id: "n2", snapshotDate: d("2026-06-01T14:30:00Z"), totalBalance: "1.15" },
      { id: "n3", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "2.05" },
    ];

    const actual = computeSnapshotRollups(snapshots, toClassified(raw));
    const expected = oracleRollups(snapshots, raw);

    expect(normalizeAtDbScale(actual)).toEqual(normalizeAtDbScale(expected));
  });

  it("is deterministic for equal event timestamps regardless of input order", () => {
    // Three events share the EXACT same timestamp. Stable sort keeps caller
    // order for ties, but the resulting cumulatives must be identical (at DB
    // scale) no matter how the tied group is permuted — ties can only
    // reorder additions within one snapshot cutoff group.
    const t = d("2026-06-01T12:00:00Z");
    const tied: RawEvent[] = [
      { eventType: "agent_deposit", amount: "0.1", txBlockTime: t, createdAt: t },
      { eventType: "agent_withdraw", amount: "0.2", txBlockTime: t, createdAt: t },
      { eventType: "drift_deposit", amount: "0.3", txBlockTime: t, createdAt: t },
    ];
    const snapshots: RollupSnapshotInput[] = [
      // Snapshot date EXACTLY equals the tied timestamp → all included (tie rule).
      { id: "t1", snapshotDate: t, totalBalance: "0.05" },
      { id: "t2", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "0.05" },
    ];

    const orderings = [
      [tied[0], tied[1], tied[2]],
      [tied[2], tied[0], tied[1]],
      [tied[1], tied[2], tied[0]],
    ];
    const results = orderings.map((o) =>
      normalizeAtDbScale(computeSnapshotRollups(snapshots, toClassified(o))),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual(normalizeAtDbScale(oracleRollups(snapshots, tied)));
    // Tie-included on t1: deposits=0.1, withdrawals=0.2, internal=0.3.
    expect(results[0][0].set.cumulativeExternalDeposits).toBe("0.1");
    expect(results[0][0].set.cumulativeExternalWithdrawals).toBe("0.2");
    expect(results[0][0].set.cumulativeInternalTransfers).toBe("0.3");
  });
});

describe("computeSnapshotRollups — clamps and denominators", () => {
  it("uses denom=1 when deposits are 0 (no division blow-up)", () => {
    const snapshots: RollupSnapshotInput[] = [
      { id: "s", snapshotDate: d("2026-06-01T00:00:00Z"), totalBalance: "5" },
    ];
    const [r] = computeSnapshotRollups(snapshots, []);
    // tradingPnl = 5 - (0 - 0) = 5; denom = max(0,1) = 1 → 500%
    expect(r.set.cumulativeTradingPnl).toBe("5");
    expect(r.set.pnlPercent).toBe("500");
  });

  it("clamps pnlPercent at +1000", () => {
    const events = toClassified([
      { eventType: "agent_deposit", amount: "1", txBlockTime: null, createdAt: d("2026-06-01T00:00:00Z") },
    ]);
    const snapshots: RollupSnapshotInput[] = [
      { id: "s", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "1000" },
    ];
    const [r] = computeSnapshotRollups(snapshots, events);
    // tradingPnl = 999, denom 1 → 99900% → clamped 1000
    expect(r.set.pnlPercent).toBe("1000");
  });

  it("clamps pnlPercent at -100", () => {
    const events = toClassified([
      { eventType: "agent_deposit", amount: "100", txBlockTime: null, createdAt: d("2026-06-01T00:00:00Z") },
      { eventType: "agent_withdraw", amount: "150", txBlockTime: null, createdAt: d("2026-06-01T01:00:00Z") },
    ]);
    const snapshots: RollupSnapshotInput[] = [
      { id: "s", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "0" },
    ];
    const [r] = computeSnapshotRollups(snapshots, events);
    // tradingPnl = 0 - (100 - 150) = 50 … not negative enough; force it:
    // Use a second fixture inline instead.
    const events2 = toClassified([
      { eventType: "agent_deposit", amount: "100", txBlockTime: null, createdAt: d("2026-06-01T00:00:00Z") },
    ]);
    const [r2] = computeSnapshotRollups(
      [{ id: "s2", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "-250" }],
      events2,
    );
    // tradingPnl = -250 - 100 = -350; denom 100 → -350% → clamped -100
    expect(r2.set.pnlPercent).toBe("-100");
    // and the first fixture stays unclamped
    expect(r.set.pnlPercent).toBe("50");
  });
});

describe("computeSnapshotRollups — netExternalFlow chaining", () => {
  it("chains prev-snapshot deltas across ≥3 snapshots with interleaved flows", () => {
    const events = toClassified([
      { eventType: "agent_deposit", amount: "100", txBlockTime: null, createdAt: d("2026-06-01T00:00:00Z") },
      { eventType: "agent_withdraw", amount: "20", txBlockTime: null, createdAt: d("2026-06-03T00:00:00Z") },
      { eventType: "agent_deposit", amount: "50", txBlockTime: null, createdAt: d("2026-06-05T00:00:00Z") },
      { eventType: "agent_withdraw", amount: "10", txBlockTime: null, createdAt: d("2026-06-05T06:00:00Z") },
    ]);
    const snapshots: RollupSnapshotInput[] = [
      { id: "d1", snapshotDate: d("2026-06-02T00:00:00Z"), totalBalance: "100" },
      { id: "d2", snapshotDate: d("2026-06-04T00:00:00Z"), totalBalance: "85" },
      { id: "d3", snapshotDate: d("2026-06-06T00:00:00Z"), totalBalance: "130" },
    ];
    const rollups = computeSnapshotRollups(snapshots, events);
    // d1: flow = (100-0) - (0-0) = 100
    expect(rollups[0].set.netExternalFlow).toBe("100");
    // d2: flow = (100-100) - (20-0) = -20
    expect(rollups[1].set.netExternalFlow).toBe("-20");
    // d3: flow = (150-100) - (30-20) = 40
    expect(rollups[2].set.netExternalFlow).toBe("40");
    // cumulative fields on d3
    expect(rollups[2].set.cumulativeExternalDeposits).toBe("150");
    expect(rollups[2].set.cumulativeExternalWithdrawals).toBe("30");
    // tradingPnl d3 = 130 - (150-30) = 10
    expect(rollups[2].set.cumulativeTradingPnl).toBe("10");
    expect(rollups[2].set.netPnl).toBe("10");
  });
});
