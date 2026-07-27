/**
 * tests/vault/loop-hold-rotation.test.ts — Work Order 3
 *
 * HOLD → best-LST rotation: ONE shared pure brain (decideHoldAllocationTarget)
 * consumed by both the allocation tick and the hop executor's in-lock guard.
 *
 *  A. decideHoldAllocationTarget — pure decision matrix (spec items 1–6)
 *     benchmark selection, strict thresholds (policy-seam boundary pins),
 *     fail-closed unreadables, deterministic tie-break.
 *  B. hasIntentStreak with rotation rows (spec item 7).
 *  C. recoverHopSolReturned input contract (addendum pin 5): exact/floor only,
 *     no baseline or wallet-balance input can influence attribution.
 *  D. executeLoopHop WO3 guard (spec items 10–19 + addendum pins 1–4):
 *     preflight → checkpoint A (in-lock, pre-close-op) → checkpoint B (ONE
 *     atomic parent authorization write) → assembly; every decline is clean
 *     (zero broadcast), retries re-gate until checkpoint B lands, resumes
 *     with a landed authorization never re-gate and never widen destinations.
 *
 * The executor preamble mirrors loop-hop-recovery.test.ts (REAL keyed mutex,
 * mocked storage/RPC/SDK) with ONE deliberate difference: the rate oracle is
 * partially mocked — getFreshLoopRates/sampleAndPersistLoopRates are fakes,
 * while netCarryAt/pickBestLoopVault stay REAL so the guard runs the same
 * arithmetic production runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// ---------------------------------------------------------------------------

vi.mock("../../server/storage", () => ({
  AGENT_SOL_WITHDRAW_OP_TYPE: "agent_sol_withdraw",
  storage: {
    getBorrowOperationByClientRequestId: vi.fn(),
    getBorrowOperationById: vi.fn(),
    getBorrowOperations: vi.fn(),
    getBorrowPosition: vi.fn(),
    getBorrowPositions: vi.fn(),
    createBorrowOperation: vi.fn(),
    updateBorrowOperation: vi.fn(),
    createBorrowPosition: vi.fn(),
    updateBorrowPosition: vi.fn(),
    createEquityEvent: vi.fn(),
    claimLoopHopOpenAttempt: vi.fn(),
    clearLoopHopActiveChild: vi.fn(),
    finalizeLoopHopParent: vi.fn(),
  },
}));

vi.mock("../../server/agent-wallet", () => ({
  getServerConnection: vi.fn(),
  executeAgentInstructions: vi.fn(),
  executeAgentInstructionsConfirmOnly: vi.fn(),
  executeAgentSwap: vi.fn(),
  getAgentTokenBalanceRawStrict: vi.fn(),
  NATIVE_SOL_MINT: "So11111111111111111111111111111111111111112",
}));

vi.mock("../../server/vault/gas-funding", () => ({
  ensureVaultGas: vi.fn(),
}));

// REAL keyed-mutex semantics: serialization is real, and a nested same-key
// acquisition would surface as a visible vitest timeout (spec item 15).
vi.mock("../../server/vault/jupiter-lend-borrow-executor", () => {
  const chains = new Map<string, Promise<unknown>>();
  const withBorrowLock = vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    const prev = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    chains.set(
      key,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  });
  return {
    withBorrowLock,
    borrowLockKey: vi.fn((w: string, b: string | null, v: number | null) => `${w}:${b ?? ""}:${v ?? ""}`),
  };
});

vi.mock("../../server/vault/jupiter-lend-borrow-route", () => {
  const getLoopVaultConfig = vi.fn();
  const readLoopLivePositionHealth = vi.fn();
  class JupiterLendBorrowRoute {
    getLoopVaultConfig = getLoopVaultConfig;
    readLoopLivePositionHealth = readLoopLivePositionHealth;
  }
  return {
    JupiterLendBorrowRoute,
    WSOL_MINT: "So11111111111111111111111111111111111111112",
    __routeMocks: { getLoopVaultConfig, readLoopLivePositionHealth },
  };
});

// PARTIAL rate-oracle mock: table reads are fakes; the arithmetic the shared
// brain and the guard run (netCarryAt, pickBestLoopVault) stays REAL.
vi.mock("../../server/vault/loop/loop-rate-oracle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getFreshLoopRates: vi.fn(),
    sampleAndPersistLoopRates: vi.fn(),
  };
});

vi.mock("@jup-ag/lend/flashloan", () => ({
  getFlashloanIx: vi.fn(),
}));

vi.mock("@jup-ag/lend/borrow", () => ({
  getOperateIx: vi.fn(),
  MAX_WITHDRAW_AMOUNT: "MAX_WITHDRAW_SENTINEL",
  MAX_REPAY_AMOUNT: "MAX_REPAY_SENTINEL",
}));

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import { decideHoldAllocationTarget } from "../../server/vault/loop/loop-hold-allocation";
import {
  LOOP_ALLOCATION_POLICY,
  recoverHopSolReturned,
} from "../../server/vault/loop/loop-risk-policy";
import { hasIntentStreak } from "../../server/vault/loop/loop-allocation-tick";
import { computeCloseAttributableFloor, executeLoopDeleverToHold, executeLoopHop } from "../../server/vault/loop/loop-executor";
import { storage } from "../../server/storage";
import {
  getServerConnection,
  executeAgentInstructions,
  executeAgentInstructionsConfirmOnly,
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
} from "../../server/agent-wallet";
import { withBorrowLock } from "../../server/vault/jupiter-lend-borrow-executor";
import { ensureVaultGas } from "../../server/vault/gas-funding";
import { getFreshLoopRates, sampleAndPersistLoopRates, type FreshLoopRate } from "../../server/vault/loop/loop-rate-oracle";
import * as jlbr from "../../server/vault/jupiter-lend-borrow-route";
import { getFlashloanIx } from "@jup-ag/lend/flashloan";
import { getOperateIx } from "@jup-ag/lend/borrow";

const routeMocks = (jlbr as unknown as {
  __routeMocks: { getLoopVaultConfig: ReturnType<typeof vi.fn>; readLoopLivePositionHealth: ReturnType<typeof vi.fn> };
}).__routeMocks;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "wallet-hold-rotation";
const AGENT_PK = "11111111111111111111111111111111"; // valid base58 (system program)
const SRC_POS = "src-hold-1";
const CRID = "rot-crid-1";
const PARENT_ID = "rot-parent-1";

/** rateRow — a FreshLoopRate the REAL brain arithmetic can consume. */
function rateRow(vaultId: number, symbol: string, stakingApy: number, borrowApr: number, lt: number | null = 0.95) {
  return {
    vaultId,
    symbol,
    stakingApy,
    stakingApyMean30d: stakingApy,
    borrowApr,
    liquidationThreshold: lt,
    withdrawUtilization: 0.5,
    netCarry2x: 2 * stakingApy - borrowApr,
    asOf: new Date(),
  } as unknown as FreshLoopRate;
}

// LT 0.95 → dynamic target min(cap, 1.3/(1.3−0.95)≈3.714 quantized ↓) = 3.7x.
// netCarryAt(s, b, 3.7) = 3.7·s − 2.7·b.
const L37 = 3.7;
const carry37 = (s: number, b: number) => L37 * s - (L37 - 1) * b;

/** Source vault 4 (JupSOL) cannot loop (negative carry) — pure HOLD source. */
function rotationRates() {
  return new Map<number, FreshLoopRate>([
    [4, rateRow(4, "JupSOL", 0.03, 0.05)], // carry at 3.7x < 0 → no source target
    [5, rateRow(5, "JitoSOL", 0.03, 0.011)], // 0.111 − 0.0297 = 0.0813
  ]);
}

/** Source CAN re-lever attractively; alternative still wins by > 2pp. */
function eligibleRates() {
  return new Map<number, FreshLoopRate>([
    [4, rateRow(4, "JupSOL", 0.05, 0.011)], // 0.185 − 0.0297 = 0.1553 (eligible)
    [5, rateRow(5, "JitoSOL", 0.06, 0.011)], // 0.222 − 0.0297 = 0.1923 (+3.7pp)
  ]);
}

const CFG4 = {
  vaultId: 4,
  collateralSymbol: "JupSOL",
  collateralMint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  debtMint: WSOL,
  liquidationThreshold: 0.95,
  borrowApr: 0.011,
  minimumBorrowingRaw: "0",
  oraclePriceOperateUsd: 0.9,
  withdrawUtilization: 0.5,
};
const CFG5 = { ...CFG4, vaultId: 5, collateralSymbol: "JitoSOL", collateralMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" };

function srcPos(over?: Record<string, unknown>) {
  return {
    id: SRC_POS,
    walletAddress: WALLET,
    kind: "loop",
    status: "open",
    venueVaultId: 4,
    venuePositionId: 91,
    debtAmountRaw: "0",
    collateralAmountRaw: "5000000000",
    policyState: "hold",
    ...(over ?? {}),
  } as any;
}

function liveHealth(debtRaw: string, collateralRaw: string) {
  return { collateralRaw, debtRaw, oraclePriceUsd: 0.9, liquidationThreshold: 0.95, healthFactor: 99 } as any;
}

const hopParamsHold = {
  walletAddress: WALLET,
  agentPublicKey: AGENT_PK,
  agentSecretKey: new Uint8Array(64),
  borrowPositionId: SRC_POS,
  targetVaultId: 5,
  clientRequestId: CRID,
  expectedSourceMode: "holding" as const,
};

function mockConn() {
  return {
    getMultipleAccountsInfo: vi.fn(async () => [{ owner: "x" }, { owner: "x" }]),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    getBlockHeight: vi.fn(async () => 100),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 })),
    getAccountInfo: vi.fn(async () => null),
    getBalance: vi.fn(async () => 9_000_000_000),
  } as any;
}

function dummyIx() {
  return new TransactionInstruction({
    programId: new PublicKey("11111111111111111111111111111111"),
    keys: [],
    data: Buffer.alloc(0),
  });
}

/**
 * Stub global fetch for jupQuote (GET, no body) and jupSwapIxs (POST, body).
 * quoteMinOuts feed successive QUOTE calls (last value repeats).
 */
function stubHopFetch(opts?: { quoteMinOuts?: string[]; swapBody?: Record<string, unknown> }) {
  let quoteN = 0;
  const outs = opts?.quoteMinOuts ?? ["4900000000"];
  const swapBody = opts?.swapBody ?? { setupInstructions: [], swapInstruction: null, addressLookupTableAddresses: [] };
  const fetchSpy = vi.fn(async (url: any, init?: any) => {
    // NB: QUOTE_URL is /swap/v1/quote — "swap" appears in BOTH endpoints.
    const isSwap = (init && init.body != null) || String(url).includes("swap-instructions");
    const body = isSwap
      ? swapBody
      : (() => {
          const v = outs[Math.min(quoteN, outs.length - 1)];
          quoteN++;
          return { outAmount: v, otherAmountThreshold: v };
        })();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const quoteCalls = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c: any[]) => !(c[1] && c[1].body != null) && !String(c[0]).includes("swap-instructions"));
const swapCalls = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c: any[]) => (c[1] && c[1].body != null) || String(c[0]).includes("swap-instructions"));

/** A valid-enough swapInstruction for deserializeJupIx. */
const VALID_SWAP_BODY = {
  setupInstructions: [],
  swapInstruction: { programId: "11111111111111111111111111111111", accounts: [], data: "" },
  addressLookupTableAddresses: [],
};

/** Prime a FRESH rotation hop: open HOLD source, echoing op-create, both cfgs. */
function primeRotation(opts?: { rates?: Map<number, FreshLoopRate>; liveDebt?: string; liveCol?: string }) {
  vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos());
  vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => ({
    id: p.operationType === "loop_hop" ? PARENT_ID : `child-${p.operationType}-1`,
    txSignatures: [],
    result: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  }));
  routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 4 ? CFG4 : v === 5 ? CFG5 : null));
  routeMocks.readLoopLivePositionHealth.mockResolvedValue(liveHealth(opts?.liveDebt ?? "0", opts?.liveCol ?? "5000000000"));
  vi.mocked(getFreshLoopRates as any).mockResolvedValue(opts?.rates ?? rotationRates());
}

const preGatedWrites = () =>
  vi.mocked(storage.updateBorrowOperation as any).mock.calls.filter((c: any[]) => c[1]?.step === "pre_gated");
const attemptWrites = () =>
  vi
    .mocked(storage.updateBorrowOperation as any)
    .mock.calls.filter((c: any[]) => c[1]?.mergeMetadata && "closeAttempts" in c[1].mergeMetadata);
const failedWritesFor = (id: string) =>
  vi
    .mocked(storage.updateBorrowOperation as any)
    .mock.calls.filter((c: any[]) => c[0] === id && c[1]?.status === "failed");
const createsOfType = (t: string) =>
  vi.mocked(storage.createBorrowOperation as any).mock.calls.filter((c: any[]) => c[0]?.operationType === t);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storage.updateBorrowOperation as any).mockResolvedValue({ id: "op" });
  vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue({ id: "row" });
  vi.mocked(storage.createEquityEvent as any).mockResolvedValue({});
  vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(null);
  vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(undefined);
  vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(null);
  vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue(undefined);
  vi.mocked(storage.clearLoopHopActiveChild as any).mockResolvedValue(true);
  vi.mocked(storage.finalizeLoopHopParent as any).mockImplementation(
    async (_id: string, _guard: any, patch: any) => ({ id: PARENT_ID, status: patch.status }),
  );
  vi.mocked(getFreshLoopRates as any).mockResolvedValue(new Map());
  vi.mocked(sampleAndPersistLoopRates as any).mockResolvedValue([]);
  vi.mocked(getServerConnection as any).mockReturnValue(mockConn());
  vi.mocked(getAgentTokenBalanceRawStrict as any).mockResolvedValue({ amountRaw: "9000000000" });
  vi.mocked(executeAgentInstructionsConfirmOnly as any).mockResolvedValue({ success: false, error: "not in this test" });
  vi.mocked(executeAgentSwap as any).mockResolvedValue({ success: false, error: "not in this test" });
  vi.mocked(ensureVaultGas as any).mockResolvedValue({
    ok: true,
    requiredLamports: 2_340_000_000,
    payerLamportsBefore: 10_000_000_000,
    refilledLamports: 0,
    fundedLamports: 0,
  });
  vi.mocked(getFlashloanIx as any).mockResolvedValue({ borrowIx: dummyIx(), paybackIx: dummyIx() });
  vi.mocked(getOperateIx as any).mockResolvedValue({ ixs: [], addressLookupTableAccounts: [] });
  routeMocks.getLoopVaultConfig.mockResolvedValue(null);
  routeMocks.readLoopLivePositionHealth.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// A. decideHoldAllocationTarget — pure decision matrix
// ============================================================================

describe("decideHoldAllocationTarget — pure matrix", () => {
  const ALLOWED = [4, 5, 42];

  it("1. HOLD-only source (no loopable target): benchmark = hold APY; a >2pp alternative rotates", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.04, null)], // LT unreadable → no source target
      [5, rateRow(5, "JitoSOL", 0.03, 0.0146)], // 0.111 − 0.03942 = 0.07158
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.intent).toBe("hop");
    expect(d.reason).toBe("hold_rotation_favorable");
    expect(d.currentHoldApy).toBeCloseTo(0.0473, 10);
    expect(d.sourceTargetLeverage).toBeNull();
    expect(d.sourceLoopApy).toBeNull();
    expect(d.sourceReleverEligible).toBe(false);
    expect(d.defaultIntent).toBe("stay_hold");
    expect(d.noSwitchBenchmarkApy).toBeCloseTo(0.0473, 10);
    expect(d.altVaultId).toBe(5);
    expect(d.altSymbol).toBe("JitoSOL");
    expect(d.altTargetLeverage).toBeCloseTo(3.7, 10);
    expect(d.altLoopApy!).toBeCloseTo(carry37(0.03, 0.0146), 10);
    expect(d.marginalSwitchGainApy!).toBeCloseTo(carry37(0.03, 0.0146) - 0.0473, 10);
    expect(d.marginalSwitchGainApy!).toBeGreaterThan(0.02);
    expect(d.thresholdName).toBe("holdRotationMinGainApy");
    expect(d.thresholdApy).toBe(LOOP_ALLOCATION_POLICY.holdRotationMinGainApy);
  });

  it("2. relever-eligible source RAISES the benchmark: an alternative that only beats HOLDING does not rotate", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.0389)], // loop ≈ 0.06998 → eligible (gap 2.27pp)
      [5, rateRow(5, "JitoSOL", 0.0295, 0.01413)], // ≈ 0.071 → +0.10pp vs benchmark only
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.sourceReleverEligible).toBe(true);
    expect(d.defaultIntent).toBe("relever");
    expect(d.noSwitchBenchmarkApy!).toBeCloseTo(carry37(0.0473, 0.0389), 10);
    expect(d.altVaultId).toBe(5);
    expect(d.marginalSwitchGainApy!).toBeLessThan(LOOP_ALLOCATION_POLICY.holdRotationMinGainApy);
    expect(d.intent).toBe("relever");
    expect(d.reason).toBe("ev_gap_favorable");
    // The alternative beat plain holding by ~2.4pp — proof the benchmark was
    // the RELEVER side, not the hold side.
    expect(d.altLoopApy! - d.currentHoldApy!).toBeGreaterThan(0.02);
  });

  it("3. alternative beating the RELEVER benchmark by >2pp rotates", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.0389)],
      [5, rateRow(5, "JitoSOL", 0.0335, 0.012389)], // ≈ 0.0905 → +2.05pp over 0.06998
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.sourceReleverEligible).toBe(true);
    expect(d.intent).toBe("hop");
    expect(d.altVaultId).toBe(5);
    expect(d.marginalSwitchGainApy!).toBeGreaterThan(0.02);
  });

  it("4. a HIGH-absolute alternative below the marginal bar never rotates (relever wins)", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.0389)], // benchmark ≈ 7.0%
      [5, rateRow(5, "JitoSOL", 0.033, 0.0122)], // ≈ 8.9% absolute, +1.9pp marginal
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.altLoopApy!).toBeGreaterThan(0.085); // absolutely attractive…
    expect(d.marginalSwitchGainApy!).toBeLessThan(0.02); // …but marginally thin
    expect(d.intent).toBe("relever");
  });

  it("5a. rotation threshold is STRICT: marginal exactly at the bar does not hop", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.0389)],
      [5, rateRow(5, "JitoSOL", 0.0335, 0.012389)],
    ]);
    const base = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(base.intent).toBe("hop");
    const atBar = decideHoldAllocationTarget({
      currentVaultId: 4,
      rates,
      allowedVaultIds: ALLOWED,
      policy: { ...LOOP_ALLOCATION_POLICY, holdRotationMinGainApy: base.marginalSwitchGainApy! },
    });
    expect(atBar.intent).toBe("relever"); // exactly-at threshold → no switch
    const justUnder = decideHoldAllocationTarget({
      currentVaultId: 4,
      rates,
      allowedVaultIds: ALLOWED,
      policy: { ...LOOP_ALLOCATION_POLICY, holdRotationMinGainApy: base.marginalSwitchGainApy! - 1e-9 },
    });
    expect(justUnder.intent).toBe("hop");
  });

  it("5b. relever eligibility is STRICT: gap exactly at minEvGapApy stays hold-benchmarked", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.0473, 0.0389)],
      [5, rateRow(5, "JitoSOL", 0.0295, 0.01413)],
    ]);
    const base = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    const gap = base.sourceLoopApy! - base.currentHoldApy!;
    const atBar = decideHoldAllocationTarget({
      currentVaultId: 4,
      rates,
      allowedVaultIds: ALLOWED,
      policy: { ...LOOP_ALLOCATION_POLICY, minEvGapApy: gap },
    });
    expect(atBar.sourceReleverEligible).toBe(false);
    expect(atBar.defaultIntent).toBe("stay_hold");
    expect(atBar.noSwitchBenchmarkApy!).toBeCloseTo(base.currentHoldApy!, 12);
    const justUnder = decideHoldAllocationTarget({
      currentVaultId: 4,
      rates,
      allowedVaultIds: ALLOWED,
      policy: { ...LOOP_ALLOCATION_POLICY, minEvGapApy: gap - 1e-9 },
    });
    expect(justUnder.sourceReleverEligible).toBe(true);
    expect(justUnder.defaultIntent).toBe("relever");
  });

  it("6a. unreadable current vault fails CLOSED (none / rates_unreadable, all facts null)", () => {
    const onlyAlt = new Map([[5, rateRow(5, "JitoSOL", 0.06, 0.011)]]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates: onlyAlt, allowedVaultIds: ALLOWED });
    expect(d.intent).toBe("none");
    expect(d.reason).toBe("rates_unreadable");
    expect(d.currentHoldApy).toBeNull();
    expect(d.altVaultId).toBeNull();
    expect(d.marginalSwitchGainApy).toBeNull();

    const nanRow = new Map([
      [4, rateRow(4, "JupSOL", Number.NaN, 0.02)],
      [5, rateRow(5, "JitoSOL", 0.06, 0.011)],
    ]);
    const d2 = decideHoldAllocationTarget({ currentVaultId: 4, rates: nanRow, allowedVaultIds: ALLOWED });
    expect(d2.intent).toBe("none");
    expect(d2.reason).toBe("rates_unreadable");
  });

  it("6b. no eligible alternative → valid no-switch default, never a forced move", () => {
    const rates = new Map([[4, rateRow(4, "JupSOL", 0.03, 0.05)]]); // current only
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.intent).toBe("none");
    expect(d.reason).toBe("stay_hold");
    expect(d.altVaultId).toBeNull();
    expect(d.marginalSwitchGainApy).toBeNull();
    expect(d.currentHoldApy).toBeCloseTo(0.03, 12);
  });

  it("6c. identical alternatives tie-break DETERMINISTICALLY to the lower vault id", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.03, 0.05)],
      [5, rateRow(5, "JitoSOL", 0.05, 0.011)],
      [42, rateRow(42, "INF", 0.05, 0.011)], // identical row → identical carry at 3.7x
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.intent).toBe("hop");
    expect(d.altVaultId).toBe(5);
  });

  it("never proposes rotating onto the CURRENT vault, even when it is the table's best row", () => {
    const rates = new Map([
      [4, rateRow(4, "JupSOL", 0.06, 0.011)], // current is the best pair on the table
      [5, rateRow(5, "JitoSOL", 0.04, 0.02)], // loopable (positive spread) but weaker
    ]);
    const d = decideHoldAllocationTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(d.altVaultId).toBe(5); // best ALTERNATIVE, never the current vault
    expect(d.marginalSwitchGainApy!).toBeLessThan(0); // …and it loses to re-levering 4
    expect(d.intent).toBe("relever");
    expect(d.reason).toBe("ev_gap_favorable");
  });
});

// ============================================================================
// B. Rotation hysteresis rows (spec item 7)
// ============================================================================

describe("hasIntentStreak — rotation rows", () => {
  const now = new Date("2026-07-25T12:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const hopRow = (target: number, ageMs: number) =>
    ({ details: { intent: "hop", hopTargetVaultId: target }, createdAt: new Date(now.getTime() - ageMs) }) as any;
  const releverRow = (ageMs: number) =>
    ({ details: { intent: "relever" }, createdAt: new Date(now.getTime() - ageMs) }) as any;

  it("three consecutive same-target rotation intents fire once", () => {
    const r = hasIntentStreak({
      currentIntent: "hop",
      priorDecisions: [hopRow(5, 1 * HOUR), hopRow(5, 2 * HOUR)],
      now,
      matchTargetVaultId: 5,
    });
    expect(r.fires).toBe(true);
    expect(r.streak).toBe(LOOP_ALLOCATION_POLICY.hysteresisTicks);
  });

  it("yield-leader flapping (different prior target) breaks the rotation streak", () => {
    const r = hasIntentStreak({
      currentIntent: "hop",
      priorDecisions: [hopRow(42, 1 * HOUR), hopRow(5, 2 * HOUR)],
      now,
      matchTargetVaultId: 5,
    });
    expect(r.fires).toBe(false);
    expect(r.streak).toBe(1);
  });

  it("an interleaved relever intent breaks the rotation streak", () => {
    const r = hasIntentStreak({
      currentIntent: "hop",
      priorDecisions: [releverRow(1 * HOUR), hopRow(5, 2 * HOUR)],
      now,
      matchTargetVaultId: 5,
    });
    expect(r.fires).toBe(false);
  });
});

// ============================================================================
// C. recoverHopSolReturned — attribution input contract (addendum pin 5)
// ============================================================================

describe("recoverHopSolReturned — exact/floor only, never balances", () => {
  it("exact close output wins over the floor", () => {
    const r = recoverHopSolReturned({ exactCloseOutputRaw: "123", attributableFloorRaw: "99" } as any);
    expect(r).toMatchObject({ ok: true, solReturnedRaw: 123n, source: "exact" });
  });

  it("floor is the only fallback", () => {
    const r = recoverHopSolReturned({ attributableFloorRaw: "99" } as any);
    expect(r).toMatchObject({ ok: true, solReturnedRaw: 99n, source: "conservative_floor" });
  });

  it("malformed exact output fails closed — never downgrades to the floor", () => {
    const r = recoverHopSolReturned({ exactCloseOutputRaw: "not-a-number", attributableFloorRaw: "99" } as any);
    expect(r.ok).toBe(false);
  });

  it("baseline/wallet-balance-shaped inputs are INERT — attribution cannot read them", () => {
    // The WO3 contract: the pre-close baseline is crash-coordination evidence
    // only. Even smuggled in, it must not influence attribution.
    const r = recoverHopSolReturned({
      attributableFloorRaw: "55",
      preCloseAgentLamports: "999999999",
      walletBalanceRaw: "888888888",
      baseline: "777777777",
    } as any);
    expect(r).toMatchObject({ ok: true, solReturnedRaw: 55n, source: "conservative_floor" });
    const none = recoverHopSolReturned({ preCloseAgentLamports: "999999999", walletBalanceRaw: "888888888" } as any);
    expect(none.ok).toBe(false); // balances alone attribute NOTHING
  });
});

// ============================================================================
// D. executeLoopHop — WO3 rotation guard (spec 10–19 + addendum pins 1–4)
// ============================================================================

describe("executeLoopHop — WO3 HOLD rotation guard", () => {
  it("10. FULL GATE PATH: preflight → checkpoint A → close op → floor → ONE atomic checkpoint-B write; nothing broadcasts here", async () => {
    primeRotation();
    const fetchSpy = stubHopFetch(); // swap ixs unavailable → stops AFTER checkpoint B

    const res = await executeLoopHop(hopParamsHold as any);

    // Stopped at swap-ix assembly (post-B), never broadcast, still resumable.
    expect(res.success).toBe(false);
    expect((res as any).policyDenied).toBeUndefined();
    expect((res as any).resumable).toBe(true);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(getFlashloanIx).not.toHaveBeenCalled(); // debt-0 source: hold exit, no flash leg

    // Preflight proved the rotation first: source unwind quote + the close's own quote.
    expect(quoteCalls(fetchSpy).length).toBe(2);
    expect(swapCalls(fetchSpy).length).toBe(1);

    // Checkpoint A ran BEFORE the close op row was created (A-declines spend no crid).
    const closeCreates = createsOfType("loop_close");
    expect(closeCreates).toHaveLength(1);
    expect(closeCreates[0][0].metadata.holdExit).toBe(true);

    // Checkpoint B: exactly ONE atomic parent authorization write.
    const gates = preGatedWrites();
    expect(gates).toHaveLength(1);
    expect(gates[0][0]).toBe(PARENT_ID);
    const mm = gates[0][1].mergeMetadata;
    const expectedFloor = computeCloseAttributableFloor(4900000000n, 0n);
    expect(mm).toMatchObject({
      preCloseAgentLamports: "9000000000",
      expectedSourceMode: "holding",
      liveSourceMode: "holding",
      holdDefaultIntent: "stay_hold",
      holdSourceReleverEligible: false,
      holdRotationThresholdApy: LOOP_ALLOCATION_POLICY.holdRotationMinGainApy,
      holdPreflightProvisionalFloorRaw: expectedFloor.toString(),
      holdFinalFloorRaw: expectedFloor.toString(),
      authorizedRecoveryVaultIds: [5],
    });
    expect(mm.targetLeverage).toBeCloseTo(3.7, 10);
    expect(mm.holdCurrentHoldApy).toBeCloseTo(0.03, 12);
    expect(mm.holdMarginalSwitchGainApy).toBeGreaterThan(0.02);
  });

  it("19. the pre-gate phase is READ-ONLY: first durable write is the close-attempt marker; baseline read happens exactly once (checkpoint B)", async () => {
    primeRotation();
    stubHopFetch();

    await executeLoopHop(hopParamsHold as any);

    const updates = vi.mocked(storage.updateBorrowOperation as any).mock.calls;
    expect(updates.length).toBeGreaterThan(0);
    // Nothing before the close-attempt write-ahead — the preflight wrote NOTHING.
    expect(updates[0][0]).toBe(PARENT_ID);
    expect(updates[0][1]).toEqual({ mergeMetadata: { closeAttempts: 1 } });
    // Only the parent and the close child were ever created.
    const created = vi.mocked(storage.createBorrowOperation as any).mock.calls.map((c: any[]) => c[0].operationType);
    expect(created).toEqual(["loop_hop", "loop_close"]);
    // The STRICT baseline is read once, at checkpoint B — never during preflight.
    expect(getAgentTokenBalanceRawStrict).toHaveBeenCalledTimes(1);
  });

  it("11. dust-debt source (0 < debt ≤ dust): HOLD classification for gating, but the close still flash-repays (isHoldExit pins debt ≤ 0)", async () => {
    primeRotation({ liveDebt: "50000" }); // dust band: ≤ 100000
    stubHopFetch({ swapBody: VALID_SWAP_BODY });

    const res = await executeLoopHop(hopParamsHold as any);

    // Guard classified HOLD (checkpoint B landed with holding facts)…
    const gates = preGatedWrites();
    expect(gates).toHaveLength(1);
    expect(gates[0][1].mergeMetadata.liveSourceMode).toBe("holding");
    // …but the close itself sized a flash leg: dust debt is NOT a hold-exit.
    const closeCreates = createsOfType("loop_close");
    expect(closeCreates[0][0].metadata.holdExit).toBeUndefined();
    expect(getFlashloanIx).toHaveBeenCalledTimes(1);
    const flashArg = vi.mocked(getFlashloanIx as any).mock.calls[0][0];
    expect(flashArg.amount.toString()).toBe("51000"); // 1.02 × 50000
    // The money path engaged past the guard (flash leg sized, gate landed);
    // the harness stops at venue-leg assembly — post-gate the result is
    // RESUMABLE, never a policy denial.
    expect((res as any).policyDenied).toBeUndefined();
    expect((res as any).resumable).toBe(true);
  });

  it("12a. expected-HOLD hop against a LIVE-levered source cannot bypass the levered carry gate", async () => {
    // Preflight passes (quote covers the debt), but the live read shows real
    // leverage → checkpoint A applies the LEVERED gate, which fails on these
    // rates (source carry unreadable) → clean decline, close op never created.
    primeRotation({ liveDebt: "5000000000", liveCol: "10000000000" });
    stubHopFetch({ quoteMinOuts: ["9000000000"] });

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("Hop declined");
    expect(createsOfType("loop_close")).toHaveLength(0); // A-decline spends no close crid
    expect(preGatedWrites()).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(failedWritesFor(PARENT_ID).length).toBeGreaterThan(0);
  });

  it("12b. LIVE-HOLD source without a rotation preflight (legacy levered expectation) declines: hold_preflight_missing", async () => {
    primeRotation();
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos({ debtAmountRaw: "5000000000" })); // recorded levered
    const fetchSpy = stubHopFetch();
    const { expectedSourceMode: _omit, ...legacyParams } = hopParamsHold;

    const res = await executeLoopHop(legacyParams as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("no rotation preflight proof");
    expect(fetchSpy).not.toHaveBeenCalled(); // no preflight ran, and A declined before the close's quote
    expect(createsOfType("loop_close")).toHaveLength(0);
    expect(preGatedWrites()).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("13a. preflight decline (source config unreadable): terminal policy decline, zero locks, zero writes beyond the fail", async () => {
    primeRotation();
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 5 ? CFG5 : null)); // source cfg gone
    stubHopFetch();

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("could not read source vault 4");
    expect(res.error).toContain("Your position is unchanged.");
    expect(withBorrowLock).not.toHaveBeenCalled(); // read-only preflight never locks
    expect(createsOfType("loop_close")).toHaveLength(0);
    expect(attemptWrites()).toHaveLength(0); // declined before any close attempt
    expect(failedWritesFor(PARENT_ID).length).toBeGreaterThan(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("13b + pin 1. checkpoint-A re-verification declines when the shared brain now prefers a DIFFERENT target; retries never resurrect it", async () => {
    const betterElsewhere = rotationRates();
    betterElsewhere.set(42, rateRow(42, "INF", 0.04, 0.011)); // 0.148 − 0.0297 = 0.1183 ≫ vault 5
    primeRotation({ rates: betterElsewhere });
    stubHopFetch();

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("best rotation target is now vault 42");
    expect(createsOfType("loop_close")).toHaveLength(0);
    expect(preGatedWrites()).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();

    // SAME-crid retry: the parent is now failed with NO close evidence → clean
    // terminal, no re-gate, still nothing broadcast.
    const parent = await vi.mocked(storage.createBorrowOperation as any).mock.results[0].value;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? { ...parent, status: "failed" } : null),
    );
    const ratesCallsAfterFirst = vi.mocked(getFreshLoopRates as any).mock.calls.length;
    const second = await executeLoopHop(hopParamsHold as any);
    expect((second as any).terminal).toBe(true);
    expect(second.error).toContain("before any funds moved");
    expect(vi.mocked(getFreshLoopRates as any).mock.calls.length).toBe(ratesCallsAfterFirst);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();

    // A NEW decision (new crid) runs the COMPLETE gate again from scratch.
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(null);
    const third = await executeLoopHop({ ...hopParamsHold, clientRequestId: "rot-crid-2" } as any);
    expect((third as any).policyDenied).toBe(true);
    expect(vi.mocked(getFreshLoopRates as any).mock.calls.length).toBeGreaterThan(ratesCallsAfterFirst);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("13c. rates unreadable AT EXECUTION TIME (pre-lock resolution) fail closed — clean decline before any lock, preflight or close", async () => {
    primeRotation();
    const fetchSpy = stubHopFetch();
    vi.mocked(getFreshLoopRates as any).mockRejectedValue(new Error("rates table temporarily gone"));

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("unreadable at execution time");
    expect(createsOfType("loop_close")).toHaveLength(0);
    expect(preGatedWrites()).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    // Reviewer pin: the decline lands strictly BEFORE the rotation preflight
    // (no quotes) and BEFORE any lock — a broken rate table can never park the
    // hop inside the source lock the safety delever shares.
    expect(quoteCalls(fetchSpy)).toHaveLength(0);
    expect(withBorrowLock).not.toHaveBeenCalled();
  });

  it("13d + pin 2. checkpoint-B floor regression declines BEFORE assembly; the spent close attempt is failed; same-crid retry is terminal", async () => {
    primeRotation();
    const fetchSpy = stubHopFetch({ quoteMinOuts: ["4900000000", "3000000000"] }); // close floor < preflighted floor

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("slipped below");
    expect(swapCalls(fetchSpy)).toHaveLength(0); // declined before swap-ix assembly
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(failedWritesFor("child-loop_close-1").length).toBeGreaterThan(0); // close attempt spent
    expect(failedWritesFor(PARENT_ID).length).toBeGreaterThan(0);
    expect(preGatedWrites()).toHaveLength(0); // authorization never landed

    const parent = await vi.mocked(storage.createBorrowOperation as any).mock.results[0].value;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? { ...parent, status: "failed" } : null),
    );
    const second = await executeLoopHop(hopParamsHold as any);
    expect((second as any).terminal).toBe(true);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("pin 3. checkpoint-B authorization write failure keeps the hop RESUMABLE and every retry re-runs the COMPLETE gate", async () => {
    primeRotation();
    const fetchSpy = stubHopFetch();
    vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (_id: string, patch: any) =>
      patch?.step === "pre_gated" ? null : { id: "op" },
    );

    const first = await executeLoopHop(hopParamsHold as any);
    expect((first as any).policyDenied).toBeUndefined();
    expect((first as any).terminal).toBeUndefined();
    expect((first as any).resumable).toBe(true);
    expect(failedWritesFor(PARENT_ID)).toHaveLength(0); // parent never terminaled
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    const quotesAfterFirst = quoteCalls(fetchSpy).length;
    expect(quotesAfterFirst).toBe(2);

    // Same-crid retry adopts the still-pending parent — the baseline never
    // landed, so the FULL preflight + gate run again.
    const parent = await vi.mocked(storage.createBorrowOperation as any).mock.results[0].value;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? parent : null),
    );
    const second = await executeLoopHop(hopParamsHold as any);
    expect((second as any).resumable).toBe(true);
    expect(quoteCalls(fetchSpy).length).toBe(quotesAfterFirst + 2); // preflight quote + close quote again
    expect(preGatedWrites().length).toBeGreaterThanOrEqual(2); // attempted each time, landed never
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("14. recovery authorization narrows with the decision: relever-eligible source authorizes [target, source]", async () => {
    primeRotation({ rates: eligibleRates() });
    stubHopFetch();

    await executeLoopHop(hopParamsHold as any);

    const gates = preGatedWrites();
    expect(gates).toHaveLength(1);
    const mm = gates[0][1].mergeMetadata;
    expect(mm.holdSourceReleverEligible).toBe(true);
    expect(mm.authorizedRecoveryVaultIds).toEqual([5, 4]);
  });

  it("14b. post-close recovery with a NARROW authorization ([target] only) never re-levers the source, even when it looks attractive", async () => {
    // Resume at close_done: the rotation authorized ONLY vault 5, the target
    // is now unopenable, and vault 4 (the old source) is openable + attractive
    // — recovery must still refuse to touch it.
    const parent = {
      id: PARENT_ID,
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: "pending",
      step: "close_done",
      borrowPositionId: SRC_POS,
      clientRequestId: CRID,
      txSignatures: [],
      result: null,
      error: null,
      metadata: {
        kind: "loop",
        fromVaultId: 4,
        toVaultId: 5,
        slippageBps: 50,
        sourceBorrowPositionId: SRC_POS,
        expectedSourceMode: "holding",
        liveSourceMode: "holding",
        closeAttempts: 1,
        preCloseAgentLamports: "9000000000",
        solReturnedLamports: "2000000000",
        principalSource: "exact",
        closeSignature: "rotCloseSig1111111111111111111111111111111111111111111",
        closeDoneAt: new Date(Date.now() - 60_000).toISOString(),
        openAttempts: 0,
        authorizedRecoveryVaultIds: [5],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? parent : null),
    );
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === PARENT_ID ? parent : undefined,
    );
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos({ status: "closed" }));
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue({
      adopted: true,
      activeOpenClientRequestId: `${CRID}:open:1`,
      activeOpenVaultId: 5,
      openAttempts: 1,
    });
    // Vault 5 preflights CLEAN (the claim fires) but its real open fails
    // post-claim at the unmocked venue build; vault 4 is fully available and
    // MORE attractive — the narrow authorization must still never touch it.
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) =>
      v === 4 ? CFG4 : v === 5 ? CFG5 : null,
    );
    vi.mocked(getFreshLoopRates as any).mockResolvedValue(eligibleRates());
    stubHopFetch();
    // The recorded close signature LANDED (finalized) — the resume must get
    // past close-verification and genuinely engage the open leg.
    const conn = mockConn();
    conn.getSignatureStatuses = vi.fn(async () => ({
      value: [{ confirmationStatus: "finalized", err: null, slot: 123 }],
    }));
    vi.mocked(getServerConnection as any).mockReturnValue(conn);

    const res = await executeLoopHop(hopParamsHold as any);

    expect(res.success).toBe(false);
    expect(storage.claimLoopHopOpenAttempt).toHaveBeenCalled(); // the open leg genuinely engaged
    // The old source pair was NEVER touched: no config read, no open attempt.
    const cfgCalls = routeMocks.getLoopVaultConfig.mock.calls.map((c: any[]) => c[0]);
    expect(cfgCalls).not.toContain(4);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("15. lock hygiene: preflight and guard take NO nested locks — the close's single source-vault lock is the only source-key acquisition (REAL mutex)", async () => {
    primeRotation();
    stubHopFetch();

    await executeLoopHop(hopParamsHold as any); // completing at all proves no self-deadlock

    const keys = vi.mocked(withBorrowLock as any).mock.calls.map((c: any[]) => c[0]);
    const sourceKey = `${WALLET}::4`;
    const targetKey = `${WALLET}::5`;
    expect(keys.filter((k: string) => k === sourceKey)).toHaveLength(1);
    expect(keys.every((k: string) => k === sourceKey || k === targetKey)).toBe(true);
    // The close's source lock comes LAST — preflight (any target-key work)
    // strictly precedes it, so no source→target nesting can exist.
    expect(keys[keys.length - 1]).toBe(sourceKey);
  });

  it("15b (reviewer). REAL safety delever executor: completes while hop guard I/O is stalled PRE-lock, queues only while the guarded close OWNS the source lock, completes after controlled release", async () => {
    primeRotation();
    stubHopFetch();
    const sourceKey = `${WALLET}::4`;
    const waitFor = async (cond: () => boolean) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > 4000) throw new Error("waitFor timeout");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const sourceLockCalls = () =>
      vi.mocked(withBorrowLock as any).mock.calls.filter((c: any[]) => c[0] === sourceKey).length;

    // Stall the hop's PRE-lock rate resolution.
    let releaseRates!: () => void;
    const ratesGate = new Promise<void>((r) => (releaseRates = r));
    const rows = rotationRates();
    vi.mocked(getFreshLoopRates as any).mockImplementation(async () => {
      await ratesGate;
      return rows;
    });
    // Live-read schedule: call 1 = delever #1 (self-heal), call 2 = hop
    // preflight, call 3 = the close's IN-LOCK read (stalls until released),
    // later calls (delever #2) fall back to primeRotation's default.
    let releaseCloseRead!: () => void;
    const closeReadGate = new Promise<void>((r) => (releaseCloseRead = r));
    routeMocks.readLoopLivePositionHealth
      .mockImplementationOnce(async () => liveHealth("0", "5000000000"))
      .mockImplementationOnce(async () => liveHealth("0", "5000000000"))
      .mockImplementationOnce(async () => {
        await closeReadGate;
        return liveHealth("0", "5000000000");
      });

    const deleverParams = {
      walletAddress: WALLET,
      agentPublicKey: AGENT_PK,
      agentSecretKey: new Uint8Array(64),
      borrowPositionId: SRC_POS,
      policyReason: "test_safety",
    } as any;

    const hop = executeLoopHop(hopParamsHold as any);
    await new Promise((r) => setTimeout(r, 25)); // hop parked on the stalled rate read
    expect(sourceLockCalls()).toBe(0); // hop holds NOTHING while its guard I/O hangs

    // Phase 1: the REAL delever executor acquires the REAL source mutex and
    // COMPLETES (zero-debt self-heal, no transaction) while the hop stalls.
    const d1 = await executeLoopDeleverToHold(deleverParams);
    expect(d1.success).toBe(true);
    expect((d1 as any).selfHeal).toBe(true);

    // Phase 2: release rates; the hop runs its preflight and enters the close,
    // which now OWNS the source lock (stalled on its in-lock live read).
    releaseRates();
    await waitFor(() => sourceLockCalls() >= 2); // d1 + the hop's close
    let d2Done = false;
    const d2 = executeLoopDeleverToHold(deleverParams).then((res) => {
      d2Done = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 75));
    expect(d2Done).toBe(false); // QUEUED behind the close's held source lock

    releaseCloseRead(); // controlled release — the close finishes its attempt
    const hopRes = await hop;
    const d2Res = await d2;
    expect(d2Done).toBe(true); // delever completed only after the lock freed
    expect(d2Res.success).toBe(true);
    expect((d2Res as any).selfHeal).toBe(true);
    expect((hopRes as any).success).toBe(false); // harness stops at venue legs
    expect((hopRes as any).policyDenied).toBeUndefined();
  });

  it("15c (reviewer). two genuinely PARALLEL fresh calls for one parent: exactly ONE durable parent, exactly ONE contested close child, exactly ONE position-moving broadcast, no rival authorization", async () => {
    primeRotation(); // full valid HOLD fixture — the winner MUST reach assembly+broadcast
    // VALID swap instructions: the winner must get all the way to a real
    // assembly + broadcast attempt, not die at "swap instructions unavailable".
    stubHopFetch({ swapBody: VALID_SWAP_BODY });
    // The close leg broadcasts through executeAgentInstructions (write-ahead +
    // realized-delta primitive). Refuse pre-signature so the attempt is a
    // clean, countable broadcast entry with no landing.
    vi.mocked(executeAgentInstructions as any).mockResolvedValue({
      success: false,
      onChainFailed: false,
      signature: undefined,
      error: "broadcast refused (test)",
    });
    // Two-caller barrier at the shared PRE-lock rate read: neither caller may
    // proceed to the attempt write / close until BOTH have loaded the parent
    // and captured priorCloseAttempts=0 — guaranteeing the close children
    // genuinely CONTEST the same attempt slot (same per-attempt crid).
    let arrived = 0;
    let releaseBoth!: () => void;
    const barrier = new Promise<void>((r) => (releaseBoth = r));
    const rows = rotationRates();
    vi.mocked(getFreshLoopRates as any).mockImplementation(async () => {
      arrived++;
      if (arrived >= 2) releaseBoth();
      await barrier;
      return rows;
    });
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos());
    // Stateful storage emulation of the UNIQUE index on clientRequestId —
    // parent AND children — plus metadata merge on updates.
    const rowsByCrid = new Map<string, any>();
    let parentCreates = 0;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => rowsByCrid.get(crid) ?? null,
    );
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => {
      const crid = p.clientRequestId;
      if (crid && rowsByCrid.has(crid)) {
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      if (p.operationType === "loop_hop") parentCreates++;
      const row = {
        id: p.operationType === "loop_hop" ? PARENT_ID : `child-${crid}`,
        txSignatures: [],
        result: null,
        error: null,
        ...p,
      };
      if (crid) rowsByCrid.set(crid, row);
      return row;
    });
    vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (id: string, patch: any) => {
      for (const row of rowsByCrid.values()) {
        if (row.id === id) {
          if (patch.status) row.status = patch.status;
          if (patch.step) row.step = patch.step;
          if (patch.mergeMetadata) row.metadata = { ...(row.metadata ?? {}), ...patch.mergeMetadata };
          if (patch.metadata) row.metadata = patch.metadata;
          return row;
        }
      }
      return { id };
    });

    const [a, b] = await Promise.all([
      executeLoopHop(hopParamsHold as any),
      executeLoopHop(hopParamsHold as any),
    ]);

    // ONE durable parent truth: exactly one loop_hop insert ever landed; the
    // loser adopted it via the unique-violation path.
    expect(parentCreates).toBe(1);
    // Exactly ONE contested close child: both callers computed the SAME
    // per-attempt crid (barrier pinned priorCloseAttempts=0 for both), so the
    // unique index admitted exactly one loop_close row.
    const closeRows = [...rowsByCrid.values()].filter((r) => r.operationType === "loop_close");
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0].clientRequestId).toBe(`${CRID}:close:1`);
    // Exactly ONE position-moving broadcast: the winner drove valid close
    // assembly through to the (harness-refused) broadcast entry; the rival
    // never reached assembly.
    expect(vi.mocked(executeAgentInstructions as any).mock.calls).toHaveLength(1);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    // Exactly ONE authorization (checkpoint B) — the rival wrote none.
    expect(preGatedWrites()).toHaveLength(1);
    // Coherent durable results: neither threw, neither claims success (the
    // winner's broadcast is refused by the harness → resumable; the rival is
    // refused by the duplicate close crid), and exactly one of the two is the
    // duplicate-submission refusal.
    for (const r of [a, b]) {
      expect(r).toBeTruthy();
      expect((r as any).success).toBe(false);
    }
    const dupRefusals = [a, b].filter((r) => String((r as any).error ?? "").includes("already submitted"));
    expect(dupRefusals).toHaveLength(1);
    const winner = [a, b].find((r) => !String((r as any).error ?? "").includes("already submitted"))!;
    expect((winner as any).resumable).toBe(true);
  });

  it("19b (reviewer). preflight against a target with UNRESOLVED pending open state fails CLOSED with ZERO reconciliation writes", async () => {
    primeRotation();
    stubHopFetch();
    // A crash-orphaned PENDING open row on the TARGET vault (5). The preflight
    // must NOT run recovery reconciliation (which can mutate ops/positions/
    // equity) — it declines via runOpen's pure active-row check instead.
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([
      { id: "orphan-1", status: "pending", venueVaultId: "5", venuePositionId: "0" },
    ]);

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).policyDenied).toBe(true);
    expect(res.error).toContain("unresolved");
    // Zero mutation attributable to the preflight: the ONLY create is the hop
    // parent, the ONLY updates are its own terminal decline; positions and
    // equity untouched; nothing broadcast.
    const created = vi.mocked(storage.createBorrowOperation as any).mock.calls.map((c: any[]) => c[0].operationType);
    expect(created).toEqual(["loop_hop"]);
    const updatedIds = vi.mocked(storage.updateBorrowOperation as any).mock.calls.map((c: any[]) => c[0]);
    expect(updatedIds.every((id: string) => id === PARENT_ID)).toBe(true);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(storage.createBorrowPosition).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(failedWritesFor(PARENT_ID).length).toBeGreaterThan(0); // clean terminal decline
  });

  it("16 + pin 4. crash AFTER checkpoint B: resume carries the landed facts — NO re-gate, NO re-read baseline, NO destination expansion", async () => {
    const parent = {
      id: PARENT_ID,
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: "pending",
      step: "pre_gated",
      borrowPositionId: SRC_POS,
      clientRequestId: CRID,
      txSignatures: [],
      result: null,
      error: null,
      metadata: {
        kind: "loop",
        fromVaultId: 4,
        toVaultId: 5,
        slippageBps: 50,
        sourceBorrowPositionId: SRC_POS,
        expectedSourceMode: "holding",
        liveSourceMode: "holding",
        targetLeverage: 3.7,
        closeAttempts: 1,
        preCloseAgentLamports: "9000000000",
        holdPreflightProvisionalFloorRaw: "4890000000",
        holdFinalFloorRaw: "4890000000",
        authorizedRecoveryVaultIds: [5],
        openAttempts: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? parent : null),
    );
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === PARENT_ID ? parent : undefined,
    );
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos()); // source still open
    const fetchSpy = stubHopFetch();
    // Close dies at the (null) vault config — the pin is everything BEFORE it.

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).resumable).toBe(true);
    expect(getFreshLoopRates).not.toHaveBeenCalled(); // landed authorization ⇒ no re-gate
    expect(fetchSpy).not.toHaveBeenCalled(); // no rotation preflight re-run
    expect(getAgentTokenBalanceRawStrict).not.toHaveBeenCalled(); // baseline never re-read
    expect(preGatedWrites()).toHaveLength(0); // authorization written once, ever
    const destinationWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1]?.mergeMetadata && "authorizedRecoveryVaultIds" in c[1].mergeMetadata);
    expect(destinationWrites).toHaveLength(0); // destinations never expand on resume
    const attempts = attemptWrites();
    expect(attempts).toHaveLength(1);
    expect(attempts[0][1].mergeMetadata.closeAttempts).toBe(2); // the retry itself proceeds
  });

  it("18. legacy LEVERED parent with a pre-WO3 baseline: resumes without re-gating and without inventing gate facts or destinations", async () => {
    const parent = {
      id: PARENT_ID,
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: "pending",
      step: "initialized",
      borrowPositionId: SRC_POS,
      clientRequestId: CRID,
      txSignatures: [],
      result: null,
      error: null,
      metadata: {
        kind: "loop",
        fromVaultId: 4,
        toVaultId: 5,
        slippageBps: 50,
        sourceBorrowPositionId: SRC_POS,
        closeAttempts: 1,
        preCloseAgentLamports: "5000000000", // legacy outer-gate baseline
        openAttempts: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === CRID ? parent : null),
    );
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === PARENT_ID ? parent : undefined,
    );
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(srcPos({ debtAmountRaw: "3000000000" }));
    const fetchSpy = stubHopFetch();

    const res = await executeLoopHop(hopParamsHold as any);

    expect((res as any).resumable).toBe(true);
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(preGatedWrites()).toHaveLength(0);
    const destinationWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1]?.mergeMetadata && "authorizedRecoveryVaultIds" in c[1].mergeMetadata);
    expect(destinationWrites).toHaveLength(0);
    expect(attemptWrites()[0][1].mergeMetadata.closeAttempts).toBe(2);
  });

  // ==========================================================================
  // Corrective pass — retry identity binding + authorization audit facts
  // ==========================================================================

  const mismatchParent = (over?: { status?: string; toVaultId?: number; source?: string }) =>
    ({
      id: PARENT_ID,
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: over?.status ?? "pending",
      step: "initialized",
      borrowPositionId: over?.source ?? SRC_POS,
      clientRequestId: CRID,
      txSignatures: [],
      result: null,
      error: null,
      metadata: {
        kind: "loop",
        fromVaultId: 4,
        toVaultId: over?.toVaultId ?? 5,
        slippageBps: 300,
        sourceBorrowPositionId: over?.source ?? SRC_POS,
        expectedSourceMode: "holding",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as any;

  it("20a (corrective). retry with a MISMATCHED SOURCE fails closed BEFORE any read/lock/write — fixed sanitized terminal result, zero side effects", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(
      mismatchParent({ source: "other-pos-9" }),
    );
    const fetchSpy = stubHopFetch();

    const res = await executeLoopHop(hopParamsHold as any);

    expect(res.success).toBe(false);
    expect((res as any).terminal).toBe(true);
    expect(res.error).toContain("bound to a different hop");
    // Sanitized: no identifiers echoed back.
    expect(res.error).not.toContain("other-pos-9");
    // ZERO side effects of ANY kind — not even the source-position read.
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.getBorrowPosition).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("20b (corrective). retry with a MISMATCHED TARGET fails closed identically — even against a SUCCEEDED parent (identity outranks completion adoption)", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(
      mismatchParent({ toVaultId: 42, status: "succeeded" }),
    );
    const fetchSpy = stubHopFetch();

    const res = await executeLoopHop(hopParamsHold as any);

    expect(res.success).toBe(false);
    expect((res as any).terminal).toBe(true);
    expect((res as any).alreadyCompleted).toBeUndefined(); // NOT adopted as complete
    expect(res.error).toContain("bound to a different hop");
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.getBorrowPosition).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("20c (corrective). unique-insert-race ADOPTION applies the same identity binding: a rival parent with a different target is refused with zero further side effects", async () => {
    primeRotation();
    stubHopFetch();
    const rival = mismatchParent({ toVaultId: 42 });
    rival.id = "rival-parent-1";
    let rivalLanded = false;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(async () =>
      rivalLanded ? rival : null,
    );
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => {
      if (p.operationType === "loop_hop") {
        rivalLanded = true; // the rival's insert won the unique race
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      return { id: "child-x", txSignatures: [], result: null, error: null, ...p };
    });

    const res = await executeLoopHop(hopParamsHold as any);

    expect(res.success).toBe(false);
    expect((res as any).terminal).toBe(true);
    expect(res.error).toContain("bound to a different hop");
    // After the refused adoption: no writes, no locks, no guard I/O, nothing.
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(preGatedWrites()).toHaveLength(0);
  });

  it("20d (corrective). MATCHING retry identity is unchanged: an existing pending parent with the same source+target proceeds normally", async () => {
    primeRotation();
    stubHopFetch();
    const parent = mismatchParent(); // source SRC_POS, target 5 — matches params
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parent);
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === PARENT_ID ? parent : undefined,
    );

    const res = await executeLoopHop(hopParamsHold as any);

    // Proceeds past the binding gate into the normal pipeline (guard I/O ran).
    expect((res as any).terminal).not.toBe(true);
    expect(getFreshLoopRates).toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationType: "loop_hop" }),
    );
  });

  const expectIdentityRejection = (res: any) => {
    expect(res.success).toBe(false);
    expect(res.terminal).toBe(true);
    expect(res.error).toContain("bound to a different hop");
    expect(res.alreadyCompleted).toBeUndefined();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.getBorrowPosition).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  };

  it("20e (corrective). MALFORMED TERMINAL parents fail closed BEFORE adoption: a succeeded parent with NO readable identity is rejected, never adopted as complete", async () => {
    const parent = mismatchParent({ status: "succeeded" });
    parent.metadata = { kind: "loop" }; // no sourceBorrowPositionId, no toVaultId
    parent.borrowPositionId = null; // legacy fallback also absent
    parent.result = { borrowPositionId: "new-pos-x", closeSignature: "sig" };
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parent);
    const fetchSpy = stubHopFetch();
    const res = await executeLoopHop(hopParamsHold as any);
    expectIdentityRejection(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("20f (corrective). malformed FAILED and PARKED parents are equally rejected pre-adoption (empty-string source / null metadata)", async () => {
    for (const shape of [
      { status: "failed", mutate: (p: any) => ((p.metadata.sourceBorrowPositionId = ""), (p.borrowPositionId = "")) },
      { status: "parked", mutate: (p: any) => ((p.metadata = null), (p.borrowPositionId = undefined)) },
    ]) {
      vi.clearAllMocks();
      const parent = mismatchParent({ status: shape.status });
      shape.mutate(parent);
      vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parent);
      const res = await executeLoopHop(hopParamsHold as any);
      expectIdentityRejection(res);
    }
  });

  it("20g (corrective). EVERY malformed durable-target shape is rejected: absent, coercible string, non-integer, zero, negative", async () => {
    for (const tv of [undefined, "5", 5.5, 0, -3] as any[]) {
      vi.clearAllMocks();
      const parent = mismatchParent();
      if (tv === undefined) delete parent.metadata.toVaultId;
      else parent.metadata.toVaultId = tv;
      vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parent);
      const res = await executeLoopHop(hopParamsHold as any);
      expectIdentityRejection(res);
    }
  });

  it("20h (corrective). unique-race ADOPTION of a rival with a MALFORMED identity is refused with zero further side effects", async () => {
    primeRotation();
    stubHopFetch();
    const rival = mismatchParent();
    rival.id = "rival-parent-2";
    delete rival.metadata.toVaultId; // malformed, not merely different
    let rivalLanded = false;
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(async () =>
      rivalLanded ? rival : null,
    );
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => {
      if (p.operationType === "loop_hop") {
        rivalLanded = true;
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      return { id: "child-x", txSignatures: [], result: null, error: null, ...p };
    });
    const res = await executeLoopHop(hopParamsHold as any);
    expect(res.success).toBe(false);
    expect((res as any).terminal).toBe(true);
    expect(res.error).toContain("bound to a different hop");
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(preGatedWrites()).toHaveLength(0);
  });

  it("20i (corrective). VALID LEGACY fallback: a parent missing the metadata source but carrying a valid non-empty row source (and a real integer target) proceeds normally", async () => {
    primeRotation();
    stubHopFetch();
    const parent = mismatchParent(); // borrowPositionId column = SRC_POS, toVaultId = 5
    delete parent.metadata.sourceBorrowPositionId; // legacy row shape
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parent);
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === PARENT_ID ? parent : undefined,
    );
    const res = await executeLoopHop(hopParamsHold as any);
    expect((res as any).terminal).not.toBe(true);
    expect(res.error ?? "").not.toContain("bound to a different hop");
    expect(getFreshLoopRates).toHaveBeenCalled(); // passed the gate into the pipeline
  });

  it("21 (corrective). HOLD authorization write carries the COMPLETE shared-brain audit facts: alt identity, alt leverage, threshold name + value", async () => {
    primeRotation();
    stubHopFetch();

    await executeLoopHop(hopParamsHold as any);

    const pg = preGatedWrites();
    expect(pg.length).toBe(1);
    const flat = JSON.stringify(pg[0][1]);
    expect(flat).toContain('"holdAltVaultId":5');
    expect(flat).toContain('"holdAltSymbol":"JitoSOL"');
    expect(flat).toContain('"holdAltTargetLeverage":3.7');
    expect(flat).toContain('"holdRotationThresholdName":"holdRotationMinGainApy"');
    expect(flat).toContain(`"holdRotationThresholdApy":${LOOP_ALLOCATION_POLICY.holdRotationMinGainApy}`);
  });

  it("22 (corrective). LEVERED authorization write records the hop threshold name + value alongside the measured edge", async () => {
    primeRotation({ rates: eligibleRates(), liveDebt: "5000000000" });
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(
      srcPos({ debtAmountRaw: "5000000000", policyState: "levered" }),
    );
    // Worst-case swap output must cover the flash repay (debt + buffer) so the
    // close reaches checkpoint B (the write under test) before assembly.
    stubHopFetch({ quoteMinOuts: ["6000000000"] });

    await executeLoopHop({ ...hopParamsHold, expectedSourceMode: "levered" } as any);

    const pg = preGatedWrites();
    expect(pg.length).toBe(1);
    const flat = JSON.stringify(pg[0][1]);
    expect(flat).toContain('"gateGainApy":');
    expect(flat).toContain('"gateThresholdName":"hopMinCarryGainApy"');
    expect(flat).toContain(`"gateThresholdApy":${LOOP_ALLOCATION_POLICY.hopMinCarryGainApy}`);
  });
});
