// SOL Loop Vault P3 (T106): observation-gate instrumentation — pure helpers.
// computeTickCoverage: expected-vs-actual heartbeat coverage + max silent gap.
// summarizeDecisionsForGate: decision-journal gate checks (anchors, forced deleverage).
import { describe, it, expect } from "vitest";
import {
  computeTickCoverage,
  summarizeDecisionsForGate,
  summarizeSafetyTickAccounting,
} from "../../server/vault/loop/loop-status";
import type { LoopPolicyDecision, LoopTickHeartbeat } from "../../shared/schema";

const NOW = new Date("2026-07-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function beatsEvery(intervalMs: number, windowMs: number, now: Date): Date[] {
  const start = now.getTime() - windowMs;
  const out: Date[] = [];
  for (let t = start + intervalMs; t <= now.getTime(); t += intervalMs) {
    out.push(new Date(t));
  }
  return out;
}

describe("computeTickCoverage", () => {
  it("perfect cadence → ~100% coverage, ok", () => {
    const cov = computeTickCoverage({
      beatsAsc: beatsEvery(MIN, 24 * HOUR, NOW),
      intervalMs: MIN,
      windowMs: 24 * HOUR,
      allowedGapMs: 5 * MIN,
      now: NOW,
    });
    expect(cov.expected).toBe(1440);
    expect(cov.count).toBe(1440);
    expect(cov.coveragePct).toBe(100);
    expect(cov.maxGapMs).toBeLessThanOrEqual(MIN);
    expect(cov.ok).toBe(true);
    expect(cov.lastBeatAt).toEqual(NOW);
  });

  it("empty window → full-window gap, 0%, NOT ok (dead scheduler never vacuously passes)", () => {
    const cov = computeTickCoverage({
      beatsAsc: [],
      intervalMs: MIN,
      windowMs: 24 * HOUR,
      allowedGapMs: 5 * MIN,
      now: NOW,
    });
    expect(cov.count).toBe(0);
    expect(cov.coveragePct).toBe(0);
    expect(cov.maxGapMs).toBe(24 * HOUR);
    expect(cov.lastBeatAt).toBeNull();
    expect(cov.ok).toBe(false);
  });

  it("restart blip within allowed gap stays ok; long dead stretch flips NOT ok", () => {
    // 2-minute restart hole (allowed at 5×interval)…
    const blip = beatsEvery(MIN, 24 * HOUR, NOW).filter(
      (d) => d.getTime() < NOW.getTime() - 10 * MIN || d.getTime() >= NOW.getTime() - 8 * MIN,
    );
    const covBlip = computeTickCoverage({
      beatsAsc: blip, intervalMs: MIN, windowMs: 24 * HOUR, allowedGapMs: 5 * MIN, now: NOW,
    });
    expect(covBlip.ok).toBe(true);

    // …but a 3-hour dead stretch mid-window fails.
    const dead = beatsEvery(MIN, 24 * HOUR, NOW).filter(
      (d) => d.getTime() < NOW.getTime() - 12 * HOUR || d.getTime() >= NOW.getTime() - 9 * HOUR,
    );
    const covDead = computeTickCoverage({
      beatsAsc: dead, intervalMs: MIN, windowMs: 24 * HOUR, allowedGapMs: 5 * MIN, now: NOW,
    });
    expect(covDead.maxGapMs).toBeGreaterThanOrEqual(3 * HOUR);
    expect(covDead.ok).toBe(false);
  });

  it("trailing silence counts: beats stopped 30 min ago → NOT ok", () => {
    const stopped = beatsEvery(MIN, 24 * HOUR, NOW).filter(
      (d) => d.getTime() <= NOW.getTime() - 30 * MIN,
    );
    const cov = computeTickCoverage({
      beatsAsc: stopped, intervalMs: MIN, windowMs: 24 * HOUR, allowedGapMs: 5 * MIN, now: NOW,
    });
    expect(cov.maxGapMs).toBeGreaterThanOrEqual(30 * MIN);
    expect(cov.ok).toBe(false);
  });

  it("leading silence counts: first beat only 10 hours into a 24h window", () => {
    const late = beatsEvery(MIN, 24 * HOUR, NOW).filter(
      (d) => d.getTime() >= NOW.getTime() - 14 * HOUR,
    );
    const cov = computeTickCoverage({
      beatsAsc: late, intervalMs: MIN, windowMs: 24 * HOUR, allowedGapMs: 5 * MIN, now: NOW,
    });
    expect(cov.maxGapMs).toBeGreaterThanOrEqual(10 * HOUR);
    expect(cov.ok).toBe(false);
  });

  it("beats outside the window are ignored; coverage caps at 100%", () => {
    const beats = [
      new Date(NOW.getTime() - 25 * HOUR), // outside — dropped
      ...beatsEvery(30 * 1000, 24 * HOUR, NOW), // double cadence
    ];
    const cov = computeTickCoverage({
      beatsAsc: beats, intervalMs: MIN, windowMs: 24 * HOUR, allowedGapMs: 5 * MIN, now: NOW,
    });
    expect(cov.coveragePct).toBe(100);
    expect(cov.count).toBe(2880);
    expect(cov.expected).toBe(1440);
  });
});

// ---------------------------------------------------------------------------

function heartbeat(over: Partial<LoopTickHeartbeat> = {}): LoopTickHeartbeat {
  return {
    id: "beat-1",
    tick: "safety",
    evaluated: 0,
    acted: 0,
    failed: 0,
    skipped: 0,
    skipReasonCounts: {},
    createdAt: NOW,
    ...over,
  };
}

describe("summarizeSafetyTickAccounting", () => {
  it("totals observed, assessed, skipped, acted, failed, and sanitized reasons", () => {
    const earlier = new Date(NOW.getTime() - MIN);
    const summary = summarizeSafetyTickAccounting([
      heartbeat({
        id: "a",
        evaluated: 3,
        skipped: 2,
        acted: 1,
        failed: 1,
        skipReasonCounts: {
          health_unavailable: 1,
          live_debt_unreadable: 1,
        },
        createdAt: earlier,
      }),
      heartbeat({ id: "b", createdAt: NOW }),
    ]);

    expect(summary).toEqual({
      totalBeats: 2,
      accountedBeats: 2,
      unknownBeats: 0,
      observed: 3,
      assessed: 1,
      skipped: 2,
      acted: 1,
      failed: 1,
      skipReasonCounts: {
        health_unavailable: 1,
        live_debt_unreadable: 1,
      },
      firstAccountedAt: earlier,
      lastAccountedAt: NOW,
      complete: true,
    });
  });

  it("keeps historical NULL accounting unknown and excludes it from every total", () => {
    const legacyAt = new Date(NOW.getTime() - MIN);
    const summary = summarizeSafetyTickAccounting([
      heartbeat({
        id: "legacy",
        evaluated: 7,
        acted: 6,
        failed: 5,
        skipped: null,
        skipReasonCounts: null,
        createdAt: legacyAt,
      }),
      heartbeat({
        id: "current",
        evaluated: 2,
        skipped: 1,
        acted: 1,
        skipReasonCounts: { vault_identity_unreadable: 1 },
      }),
    ]);

    expect(summary.totalBeats).toBe(2);
    expect(summary.accountedBeats).toBe(1);
    expect(summary.unknownBeats).toBe(1);
    expect(summary.observed).toBe(2);
    expect(summary.assessed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.acted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skipReasonCounts).toEqual({
      vault_identity_unreadable: 1,
    });
    expect(summary.firstAccountedAt).toEqual(NOW);
    expect(summary.lastAccountedAt).toEqual(NOW);
    expect(summary.complete).toBe(false);
  });

  it("fails closed on malformed counts, unknown reason keys, and reason mismatches", () => {
    const malformed = [
      heartbeat({
        id: "negative",
        evaluated: 1,
        skipped: -1,
        skipReasonCounts: {},
      }),
      heartbeat({
        id: "too-many-skips",
        evaluated: 0,
        skipped: 1,
        skipReasonCounts: { health_unavailable: 1 },
      }),
      heartbeat({
        id: "unknown-key",
        evaluated: 1,
        skipped: 1,
        skipReasonCounts: { dynamic_rpc_text: 1 },
      }),
      heartbeat({
        id: "mismatch",
        evaluated: 2,
        skipped: 2,
        skipReasonCounts: { health_unavailable: 1 },
      }),
      heartbeat({
        id: "fractional",
        evaluated: 1,
        skipped: 1,
        skipReasonCounts: { health_unavailable: 0.5 },
      }),
    ];

    const summary = summarizeSafetyTickAccounting(malformed);
    expect(summary.totalBeats).toBe(5);
    expect(summary.accountedBeats).toBe(0);
    expect(summary.unknownBeats).toBe(5);
    expect(summary.observed).toBe(0);
    expect(summary.assessed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.acted).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipReasonCounts).toEqual({});
    expect(summary.firstAccountedAt).toBeNull();
    expect(summary.lastAccountedAt).toBeNull();
    expect(summary.complete).toBe(false);
  });

  it("empty input is incomplete with known zero totals", () => {
    expect(summarizeSafetyTickAccounting([])).toEqual({
      totalBeats: 0,
      accountedBeats: 0,
      unknownBeats: 0,
      observed: 0,
      assessed: 0,
      skipped: 0,
      acted: 0,
      failed: 0,
      skipReasonCounts: {},
      firstAccountedAt: null,
      lastAccountedAt: null,
      complete: false,
    });
  });
});

// ---------------------------------------------------------------------------

function decision(over: Partial<LoopPolicyDecision>): LoopPolicyDecision {
  return {
    id: "d1",
    walletAddress: "W",
    borrowPositionId: "bp1",
    vaultId: 4,
    tick: "allocation",
    action: "none",
    fraction: null,
    reason: "test",
    details: null,
    createdAt: NOW,
    ...over,
  } as LoopPolicyDecision;
}

describe("summarizeDecisionsForGate", () => {
  it("counts by action, tracks newest decision", () => {
    const s = summarizeDecisionsForGate([
      decision({ action: "none", createdAt: new Date(NOW.getTime() - HOUR) }),
      decision({ action: "none", createdAt: NOW }),
      decision({ action: "relever", details: { executed: true, signature: "sig1" } }),
    ]);
    expect(s.byAction).toEqual({ none: 2, relever: 1 });
    expect(s.executedCount).toBe(1);
    expect(s.lastDecisionAt).toEqual(NOW);
  });

  it("executed money action WITH signature → anchored; forced deleverage seen", () => {
    const s = summarizeDecisionsForGate([
      decision({ action: "unwind_to_hold", reason: "carry inverted", details: { executed: true, signature: "sig2" } }),
    ]);
    expect(s.executedMissingAnchor).toBe(0);
    expect(s.forcedDeleverageSeen).toBe(true);
  });

  it("executed money action with NO signature and no self-heal marker → missing anchor", () => {
    const s = summarizeDecisionsForGate([
      decision({ action: "reduce", details: { executed: true } }),
    ]);
    expect(s.executedMissingAnchor).toBe(1);
    expect(s.forcedDeleverageSeen).toBe(true);
  });

  it("self-heal (no-tx verifyWarning) is NOT a missing anchor", () => {
    const s = summarizeDecisionsForGate([
      decision({
        action: "unwind_to_hold",
        details: { executed: true, verifyWarning: "Debt was already cleared on-chain — marked holding without a transaction." },
      }),
    ]);
    expect(s.executedMissingAnchor).toBe(0);
  });

  it("structured selfHeal flag is NOT a missing anchor (no signature, no warning text)", () => {
    const s = summarizeDecisionsForGate([
      decision({
        action: "relever",
        details: { executed: true, selfHeal: true },
      }),
    ]);
    expect(s.executedMissingAnchor).toBe(0);
  });

  it("failed attempts and 'none' rows never count as executed or missing anchors", () => {
    const s = summarizeDecisionsForGate([
      decision({ action: "reduce", details: { executed: false, error: "boom" } }),
      decision({ action: "none", details: null }),
    ]);
    expect(s.executedCount).toBe(0);
    expect(s.executedMissingAnchor).toBe(0);
    expect(s.forcedDeleverageSeen).toBe(false);
  });

  it("relever alone is not a forced deleverage", () => {
    const s = summarizeDecisionsForGate([
      decision({ action: "relever", details: { executed: true, signature: "s" } }),
    ]);
    expect(s.forcedDeleverageSeen).toBe(false);
  });

  it("empty input → clean zero state", () => {
    const s = summarizeDecisionsForGate([]);
    expect(s.byAction).toEqual({});
    expect(s.executedCount).toBe(0);
    expect(s.executedMissingAnchor).toBe(0);
    expect(s.forcedDeleverageSeen).toBe(false);
    expect(s.lastDecisionAt).toBeNull();
  });
});
