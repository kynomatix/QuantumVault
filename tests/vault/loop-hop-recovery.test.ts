/**
 * tests/vault/loop-hop-recovery.test.ts — Power Work Order 2A
 *
 * Durable-parent hop recovery: bounded, serialized, close-attributable,
 * manually resumable.
 *  A. computeCloseAttributableFloor — pre-broadcast floor arithmetic
 *  B. verifyRawSigLanded            — raw-sig landing verdicts
 *  C. countHopBroadcastAttempts     — budget basis (write-ahead evidence only)
 *  D. recoverFromOlderProvenClose   — close-output attribution scan
 *  E. executeLoopHop budget gate    — age/attempt parks (automatic only) + CAS
 *  F. parked door                   — automatic refusal vs manual resume
 *  G. single-flight slot            — orphan reuse, release-before-retarget,
 *                                     claim adoption (rival / pinned vault)
 *  H. resume attribution            — proven-own-close vs closed_outside_hop
 *
 * Helper tests are pure / controlled; executeLoopHop tests drive the REAL
 * executor with mocked storage, RPC, SDK and lock machinery — the same
 * preamble that proved sufficient in loop-open-recovery.test.ts (WO1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// REAL keyed-mutex semantics (same as WO1): serialization is real, and a
// nested same-key acquisition would surface as a visible vitest timeout.
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

// Risk policy: REAL module (recoverHopSolReturned + LOOP_HOP_RECOVERY_POLICY
// are the WO2A contract under test) with ONLY the allowlist pinned so the
// authorized-recovery filter is deterministic.
vi.mock("../../server/vault/loop/loop-risk-policy", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    LOOP_VAULT_ALLOWLIST: {
      47: { collateralSymbol: "JupSOL", maxLeverage: 3 },
      4: { collateralSymbol: "JitoSOL", maxLeverage: 3 },
    },
  };
});

vi.mock("../../server/vault/loop/loop-rate-oracle", () => ({
  getFreshLoopRates: vi.fn(),
  sampleAndPersistLoopRates: vi.fn(),
  netCarryAt: vi.fn(),
  pickBestLoopVault: vi.fn(),
  LOOP_RATE_REGISTRY: {},
}));

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

import {
  computeCloseAttributableFloor,
  verifyRawSigLanded,
  countHopBroadcastAttempts,
  recoverFromOlderProvenClose,
  executeLoopHop,
} from "../../server/vault/loop/loop-executor";
import { storage } from "../../server/storage";
import {
  getServerConnection,
  executeAgentInstructionsConfirmOnly,
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
} from "../../server/agent-wallet";
import { withBorrowLock } from "../../server/vault/jupiter-lend-borrow-executor";
import { ensureVaultGas } from "../../server/vault/gas-funding";
import { LOOP_HOP_RECOVERY_POLICY } from "../../server/vault/loop/loop-risk-policy";
import { getFreshLoopRates, pickBestLoopVault } from "../../server/vault/loop/loop-rate-oracle";
import * as jlbr from "../../server/vault/jupiter-lend-borrow-route";

const routeMocks = (jlbr as unknown as {
  __routeMocks: { getLoopVaultConfig: ReturnType<typeof vi.fn>; readLoopLivePositionHealth: ReturnType<typeof vi.fn> };
}).__routeMocks;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "wallet-hop-recovery";
const AGENT_PK = "11111111111111111111111111111111"; // valid base58 (system program)
const CLOSE_SIG = "hopCloseSig11111111111111111111111111111111111111111111";
const OLD_CLOSE_SIG = "hopOldCloseSig111111111111111111111111111111111111111";
const OPEN_SIG_1 = "hopOpenSig1111111111111111111111111111111111111111111111";

const HOP_CRID = "hoprec-crid-1";
const SRC_POS = "src-pos-1";

const CFG_47 = {
  vaultId: 47,
  collateralSymbol: "JupSOL",
  collateralMint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  debtMint: WSOL,
  liquidationThreshold: 0.9,
  borrowApr: 0.03,
  minimumBorrowingRaw: "0",
  oraclePriceOperateUsd: 0.9,
  withdrawUtilization: 0.5,
};

const AGE_BUDGET_MS = LOOP_HOP_RECOVERY_POLICY.maxAutomaticPostCloseAgeMs;
const ATTEMPT_BUDGET = LOOP_HOP_RECOVERY_POLICY.maxOpenBroadcastAttempts;

/** Fresh-rate rows that let the REAL computeLoopTargetLeverage size vault 47/4. */
function profitableRates() {
  const row = (vaultId: number, symbol: string) => ({
    vaultId,
    symbol,
    stakingApy: 0.08,
    stakingApyMean30d: 0.08,
    borrowApr: 0.03,
    withdrawUtilization: 0.5,
    liquidationThreshold: 0.9,
    netCarry2x: 0.05,
    asOf: new Date(),
  });
  return new Map([
    [47, row(47, "JupSOL")],
    [4, row(4, "JitoSOL")],
  ]);
}

/** Parent hop op resumed at close_done with a durably-attributed solReturned. */
function hopOp(metaExtra?: Record<string, unknown>, over?: Record<string, unknown>) {
  return {
    id: "hop-1",
    walletAddress: WALLET,
    operationType: "loop_hop",
    status: "pending",
    step: "close_done",
    borrowPositionId: SRC_POS,
    clientRequestId: HOP_CRID,
    txSignatures: [],
    result: null,
    error: null,
    metadata: {
      kind: "loop",
      fromVaultId: 4,
      toVaultId: 47,
      slippageBps: 50,
      sourceBorrowPositionId: SRC_POS,
      closeAttempts: 1,
      preCloseAgentLamports: "5000000000",
      solReturnedLamports: "2000000000",
      closeSignature: CLOSE_SIG,
      closeDoneAt: new Date(Date.now() - 60_000).toISOString(),
      openAttempts: 0,
      ...(metaExtra ?? {}),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(over ?? {}),
  } as any;
}

const hopParams = {
  walletAddress: WALLET,
  agentPublicKey: AGENT_PK,
  agentSecretKey: new Uint8Array(64),
  borrowPositionId: SRC_POS,
  targetVaultId: 47,
  clientRequestId: HOP_CRID,
};

/** Wire byCrid from a map and byId to the given parent row. */
function wire(map: Record<string, any>, parent: any) {
  vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
    async (_w: string, crid: string) => map[crid] ?? null,
  );
  vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
    id === parent.id ? parent : undefined,
  );
}

function connWith({
  statuses,
  height,
}: {
  statuses?: Array<{ confirmationStatus?: string; err?: unknown } | null> | Error;
  height?: number | Error;
} = {}) {
  return {
    getSignatureStatuses: vi.fn(async () => {
      if (statuses instanceof Error) throw statuses;
      return { value: statuses ?? [null] };
    }),
    getBlockHeight: vi.fn(async () => {
      if (height instanceof Error) throw height;
      return height ?? 0;
    }),
    // executeLoopOpen preflight reads ATA presence; "present" keeps prep empty.
    getMultipleAccountsInfo: vi.fn(async () => [{}, {}]),
  } as any;
}

/** Close child fixture for the attribution scan. */
function closeChild({
  id = "close-child-1",
  status = "succeeded",
  step = "closed",
  meta = {} as Record<string, unknown>,
  result = null as Record<string, unknown> | null,
  sigs = [] as unknown[],
  updatedAt = new Date(),
}: {
  id?: string;
  status?: string;
  step?: string;
  meta?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  sigs?: unknown[];
  updatedAt?: Date;
} = {}) {
  return {
    id,
    walletAddress: WALLET,
    operationType: "loop_close",
    status,
    step,
    borrowPositionId: SRC_POS,
    clientRequestId: null,
    txSignatures: sigs,
    metadata: meta,
    result,
    error: null,
    createdAt: updatedAt,
    updatedAt,
  } as any;
}

/** Dead open child that DID broadcast (write-ahead evidence survives). */
function deadOpenChild(n: number) {
  return {
    id: `open-child-${n}`,
    walletAddress: WALLET,
    operationType: "loop_open",
    status: "failed",
    step: "tx_failed_onchain",
    borrowPositionId: null,
    clientRequestId: `${HOP_CRID}:open:${n}`,
    txSignatures: [OPEN_SIG_1],
    metadata: { kind: "loop", vaultId: 47, openTxSignature: OPEN_SIG_1 },
    result: null,
    error: "on-chain failure",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

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
    async (_id: string, _guard: any, patch: any) => ({ id: "hop-1", status: patch.status }),
  );
  vi.mocked(getFreshLoopRates as any).mockResolvedValue(new Map());
  vi.mocked(pickBestLoopVault as any).mockReturnValue(null);
  vi.mocked(getServerConnection as any).mockReturnValue(connWith());
  vi.mocked(ensureVaultGas as any).mockResolvedValue({
    ok: true,
    requiredLamports: 2_340_000_000,
    payerLamportsBefore: 10_000_000_000,
    refilledLamports: 0,
    fundedLamports: 0,
  });
  routeMocks.getLoopVaultConfig.mockResolvedValue(null);
  routeMocks.readLoopLivePositionHealth.mockResolvedValue(null);
});

// ============================================================================
// A. computeCloseAttributableFloor — pure
// ============================================================================

describe("computeCloseAttributableFloor", () => {
  it("minOut − flashRepay − fee headroom", () => {
    expect(computeCloseAttributableFloor(2_000_000_000n, 1_500_000_000n)).toBe(499_700_000n);
  });

  it("clamps to 0 when repay + headroom exceed minOut (never negative)", () => {
    expect(computeCloseAttributableFloor(1_000_000n, 900_000n)).toBe(0n);
    expect(computeCloseAttributableFloor(0n, 0n)).toBe(0n);
  });

  it("no flash repay: still reserves the fee headroom", () => {
    expect(computeCloseAttributableFloor(1_000_000_000n, 0n)).toBe(999_700_000n);
  });
});

// ============================================================================
// B. verifyRawSigLanded
// ============================================================================

describe("verifyRawSigLanded", () => {
  it("confirmed/finalized without error → landed", async () => {
    expect(await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: [{ confirmationStatus: "finalized" }] }))).toBe(
      "landed",
    );
    expect(await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: [{ confirmationStatus: "confirmed" }] }))).toBe(
      "landed",
    );
  });

  it("null status → unverifiable (WO2A-C1: index lag can hide a landed tx — uncertainty, never absence)", async () => {
    expect(await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: [null] }))).toBe("unverifiable");
  });

  it("errored status → not_landed (atomic tx landed with an error: provably nothing moved)", async () => {
    expect(
      await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: [{ confirmationStatus: "finalized", err: { x: 1 } }] })),
    ).toBe("not_landed");
  });

  it("merely processed status → unverifiable (WO2A-C1: nonterminal is not yet a verdict either way)", async () => {
    expect(await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: [{ confirmationStatus: "processed" }] }))).toBe(
      "unverifiable",
    );
  });

  it("RPC failure → unverifiable (never a landing verdict)", async () => {
    expect(await verifyRawSigLanded(CLOSE_SIG, connWith({ statuses: new Error("rpc down") }))).toBe("unverifiable");
  });

  it("missing/empty signature → not_landed without touching RPC", async () => {
    const conn = connWith();
    expect(await verifyRawSigLanded(null, conn)).toBe("not_landed");
    expect(await verifyRawSigLanded("", conn)).toBe("not_landed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });
});

// ============================================================================
// C. countHopBroadcastAttempts — budget basis
// ============================================================================

describe("countHopBroadcastAttempts", () => {
  it("counts ONLY loop_open children with write-ahead evidence; missing rows and evidence-free children are budget-free", async () => {
    const map: Record<string, any> = {
      [`${HOP_CRID}:open:1`]: deadOpenChild(1), // meta.openTxSignature → counts
      [`${HOP_CRID}:open:2`]: {
        ...deadOpenChild(2),
        step: "exec_failed",
        metadata: { kind: "loop", vaultId: 47 }, // no write-ahead keys → free
      },
      // :open:3 missing entirely (crash in the claim→create gap) → free
    };
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => map[crid] ?? null,
    );
    expect(await countHopBroadcastAttempts(WALLET, HOP_CRID, 3)).toBe(1);
  });

  it("step-based evidence (loop_sig_writeahead / open_ambiguous) counts even without meta keys", async () => {
    const map: Record<string, any> = {
      [`${HOP_CRID}:open:1`]: { ...deadOpenChild(1), status: "pending", step: "loop_sig_writeahead", metadata: {} },
      [`${HOP_CRID}:open:2`]: { ...deadOpenChild(2), step: "open_ambiguous", metadata: {} },
    };
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => map[crid] ?? null,
    );
    expect(await countHopBroadcastAttempts(WALLET, HOP_CRID, 2)).toBe(2);
  });

  it("a non-loop_open op under an :open: crid never counts", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(
      closeChild({ meta: { openTxSignature: OPEN_SIG_1 } }),
    );
    expect(await countHopBroadcastAttempts(WALLET, HOP_CRID, 1)).toBe(0);
  });

  it("zero attempts → zero, no storage reads", async () => {
    expect(await countHopBroadcastAttempts(WALLET, HOP_CRID, 0)).toBe(0);
    expect(storage.getBorrowOperationByClientRequestId).not.toHaveBeenCalled();
  });
});

// ============================================================================
// D. recoverFromOlderProvenClose — attribution scan
// ============================================================================

describe("recoverFromOlderProvenClose", () => {
  const cridFor = (n: number) => `${HOP_CRID}:close:${n}`;

  function wireCloses(map: Record<string, any>) {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => map[crid] ?? null,
    );
  }

  it("selfHeal successes are SKIPPED as proof; an older exact-figure success wins", async () => {
    const provenAt = new Date(Date.now() - 5 * 60_000);
    wireCloses({
      [cridFor(2)]: closeChild({ id: "c2", meta: { selfHeal: true } }),
      [cridFor(1)]: closeChild({
        id: "c1",
        result: { solReturnedLamports: "1900000000", signature: OLD_CLOSE_SIG },
        updatedAt: provenAt,
      }),
    });
    const out = await recoverFromOlderProvenClose(WALLET, cridFor, 2, connWith());
    expect(out).toMatchObject({ kind: "recovered", raw: 1_900_000_000n, source: "exact", signature: OLD_CLOSE_SIG });
    expect((out as any).provenOp.id).toBe("c1");
  });

  it("malformed exact figure → proven_unattributable — NEVER downgrades to a present floor", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        meta: { attributableFloorRaw: "1500000000" },
        result: { solReturnedLamports: "banana", signature: OLD_CLOSE_SIG },
      }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith())).toMatchObject({
      kind: "proven_unattributable",
    });
  });

  it("figureless success + signature LANDED → its own persisted floor (conservative_floor)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        meta: { attributableFloorRaw: "1500000000" },
        result: { signature: OLD_CLOSE_SIG },
      }),
    });
    const out = await recoverFromOlderProvenClose(
      WALLET,
      cridFor,
      1,
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    expect(out).toMatchObject({
      kind: "recovered",
      raw: 1_500_000_000n,
      source: "conservative_floor",
      signature: OLD_CLOSE_SIG,
    });
  });

  it("figureless success whose sig landed WITH an on-chain error is skipped (provably nothing moved) → none", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        meta: { attributableFloorRaw: "1500000000" },
        result: { signature: OLD_CLOSE_SIG },
      }),
    });
    expect(
      await recoverFromOlderProvenClose(
        WALLET,
        cridFor,
        1,
        connWith({ statuses: [{ confirmationStatus: "finalized", err: { x: 1 } }] }),
      ),
    ).toEqual({
      kind: "none",
    });
  });

  it("figureless success with a NULL status is uncertainty, not absence → unverifiable (WO2A-C1)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        meta: { attributableFloorRaw: "1500000000" },
        result: { signature: OLD_CLOSE_SIG },
      }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: [null] }))).toEqual({
      kind: "unverifiable",
    });
  });

  it("a non-loop_close op under a close crid is corrupt linkage → skipped without RPC (WO2A-C1)", async () => {
    // Even a figure-bearing foreign op must never prove a close.
    wireCloses({
      [cridFor(1)]: {
        ...deadOpenChild(1),
        result: { solReturnedLamports: "1700000000", signature: OLD_CLOSE_SIG },
      },
    });
    const conn = connWith();
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, conn)).toEqual({ kind: "none" });
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("failed child at close_ambiguous_not_landed whose surviving explicit sig LANDED → its floor sizes the recovery (WO2A-C1)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "close_ambiguous_not_landed",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1300000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const out = await recoverFromOlderProvenClose(
      WALLET,
      cridFor,
      1,
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    expect(out).toMatchObject({ kind: "recovered", raw: 1_300_000_000n, source: "conservative_floor" });
  });

  it("failed child at close_ambiguous_unreadable whose surviving explicit sig LANDED → floor recovery (WO2A-C1)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "close_ambiguous_unreadable",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1200000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const out = await recoverFromOlderProvenClose(
      WALLET,
      cridFor,
      1,
      connWith({ statuses: [{ confirmationStatus: "confirmed" }] }),
    );
    expect(out).toMatchObject({ kind: "recovered", raw: 1_200_000_000n, source: "conservative_floor" });
  });

  it("ambiguous-step child WITHOUT the explicit key is unselectable (no legacy fallback) → none, no RPC (WO2A-C1)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "close_ambiguous_not_landed",
        meta: { attributableFloorRaw: "1300000000" }, // key missing → corrupt, fail closed
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const conn = connWith();
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, conn)).toEqual({ kind: "none" });
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("ambiguous-step child with NULL status stays uncertainty → unverifiable, hop resumable (WO2A-C1)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "close_ambiguous_not_landed",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1300000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: [null] }))).toEqual({
      kind: "unverifiable",
    });
  });

  it("landed but NO floor recorded → proven_unattributable (fail closed, never guess)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({ id: "c1", result: { signature: OLD_CLOSE_SIG } }),
    });
    expect(
      await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: [{ confirmationStatus: "confirmed" }] })),
    ).toMatchObject({ kind: "proven_unattributable" });
  });

  it("crash-window child (loop_sig_writeahead) landed → its floor sizes the recovery", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "pending",
        step: "loop_sig_writeahead",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1400000000", lastValidBlockHeight: 999999 },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const out = await recoverFromOlderProvenClose(
      WALLET,
      cridFor,
      1,
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    expect(out).toMatchObject({ kind: "recovered", raw: 1_400_000_000n, source: "conservative_floor" });
  });

  it("any RPC-unverifiable candidate keeps the hop resumable → unverifiable", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({ id: "c1", result: { signature: OLD_CLOSE_SIG } }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: new Error("rpc") }))).toEqual({
      kind: "unverifiable",
    });
  });

  it("figureless AND signatureless success cannot prove money moved; empty history → none", async () => {
    wireCloses({ [cridFor(2)]: closeChild({ id: "c2" }) }); // no figure, no sig anywhere
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 2, connWith())).toEqual({ kind: "none" });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 0, connWith())).toEqual({ kind: "none" });
  });

  // --- WO2A-C2: explicit identity proves a close at ANY step ------------------

  it("failed child at 'unexpected_error' whose surviving explicit sig LANDED (finalized) → ONLY its own persisted floor (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(2)]: closeChild({
        id: "c2",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1100000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
      // An OLDER attempt with a DIFFERENT floor must never contribute — the
      // first proven child decides with ITS OWN floor, nothing else.
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "9900000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized" }] });
    const out = await recoverFromOlderProvenClose(WALLET, cridFor, 2, conn);
    expect(out).toMatchObject({ kind: "recovered", raw: 1_100_000_000n, source: "conservative_floor" });
    expect((out as any).provenOp.id).toBe("c2");
    expect(conn.getSignatureStatuses).toHaveBeenCalledTimes(1); // scan stops at the first proven child
  });

  it("'unexpected_error' child with matching explicit key, CONFIRMED status → floor recovery (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1050000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const out = await recoverFromOlderProvenClose(
      WALLET,
      cridFor,
      1,
      connWith({ statuses: [{ confirmationStatus: "confirmed" }] }),
    );
    expect(out).toMatchObject({ kind: "recovered", raw: 1_050_000_000n, source: "conservative_floor" });
  });

  it("'unexpected_error' child, NULL status → unverifiable: stays resumable, can never become closed_outside_hop (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1100000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: [null] }))).toEqual({
      kind: "unverifiable",
    });
  });

  it("'unexpected_error' child, merely 'processed' status → unverifiable (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1100000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    expect(
      await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: [{ confirmationStatus: "processed" }] })),
    ).toEqual({ kind: "unverifiable" });
  });

  it("'unexpected_error' child, RPC failure → unverifiable (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: OLD_CLOSE_SIG, attributableFloorRaw: "1100000000" },
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, connWith({ statuses: new Error("rpc") }))).toEqual({
      kind: "unverifiable",
    });
  });

  it("'unexpected_error' child with MISMATCHED explicit key → none, ZERO RPC; the earlier prep signature is never promoted (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { closeTxSignature: CLOSE_SIG, attributableFloorRaw: "1100000000" }, // disagrees with the array
        sigs: [OPEN_SIG_1, OLD_CLOSE_SIG],
      }),
    });
    const conn = connWith();
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, conn)).toEqual({ kind: "none" });
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("KEYLESS 'unexpected_error' child stays malformed → none, no RPC (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "failed",
        step: "unexpected_error",
        meta: { attributableFloorRaw: "1100000000" }, // no explicit key
        sigs: [OLD_CLOSE_SIG],
      }),
    });
    const conn = connWith();
    expect(await recoverFromOlderProvenClose(WALLET, cridFor, 1, conn)).toEqual({ kind: "none" });
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("KEYLESS crash-window child keeps the legacy last-entry rule: probes the LAST sig, landed → its floor (WO2A-C2)", async () => {
    wireCloses({
      [cridFor(1)]: closeChild({
        id: "c1",
        status: "pending",
        step: "loop_sig_writeahead",
        meta: { attributableFloorRaw: "1250000000" }, // legacy: no explicit key
        sigs: [OPEN_SIG_1, OLD_CLOSE_SIG],
      }),
    });
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized" }] });
    const out = await recoverFromOlderProvenClose(WALLET, cridFor, 1, conn);
    expect(out).toMatchObject({ kind: "recovered", raw: 1_250_000_000n, source: "conservative_floor" });
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith([OLD_CLOSE_SIG], expect.anything());
  });
});

// ============================================================================
// E. executeLoopHop — automatic budget gate parks (WO2A)
// ============================================================================

describe("executeLoopHop — budget gate", () => {
  it("post-close age exceeded → PARKED via CAS from pending; nothing sized or broadcast", async () => {
    const parent = hopOp({ closeDoneAt: new Date(Date.now() - AGE_BUDGET_MS - 60 * 60_000).toISOString() });
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).parked).toBe(true);
    expect((res as any).parkReason).toBe("post_close_age_exceeded");
    // WO2A-C1: this invocation WON the pending→parked CAS — it alone carries
    // the journal/notify authorization flag.
    expect((res as any).parkedByThisInvocation).toBe(true);
    expect(res.solReturnedLamports).toBe("2000000000");
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-1",
      { expectedStatus: "pending" },
      expect.objectContaining({
        status: "parked",
        step: "parked",
        mergeMetadata: expect.objectContaining({
          parkReason: "post_close_age_exceeded",
          parkPrincipalLamports: "2000000000",
        }),
      }),
    );
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
    expect(routeMocks.getLoopVaultConfig).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("broadcast budget exhausted (every prior child carries write-ahead evidence) → PARKED", async () => {
    const parent = hopOp({ openAttempts: ATTEMPT_BUDGET });
    const map: Record<string, any> = { [HOP_CRID]: parent };
    for (let n = 1; n <= ATTEMPT_BUDGET; n++) map[`${HOP_CRID}:open:${n}`] = deadOpenChild(n);
    wire(map, parent);

    const res = await executeLoopHop(hopParams);

    expect((res as any).parked).toBe(true);
    expect((res as any).parkReason).toBe("open_broadcast_budget_exhausted");
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-1",
      { expectedStatus: "pending" },
      expect.objectContaining({
        status: "parked",
        mergeMetadata: expect.objectContaining({
          parkReason: "open_broadcast_budget_exhausted",
          parkBroadcastAttempts: ATTEMPT_BUDGET,
          parkOpenAttempts: ATTEMPT_BUDGET,
        }),
      }),
    );
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("closeDoneAt missing and unrecoverable → PARKED as close_done_time_unknown (never a free retry loop)", async () => {
    const parent = hopOp({ closeDoneAt: undefined });
    delete parent.metadata.closeDoneAt;
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop(hopParams);

    expect((res as any).parked).toBe(true);
    expect((res as any).parkReason).toBe("close_done_time_unknown");
  });

  it("manual mode SKIPS the gate: an over-age hop proceeds to sizing (operator owns the decision)", async () => {
    const parent = hopOp({ closeDoneAt: new Date(Date.now() - AGE_BUDGET_MS - 60 * 60_000).toISOString() });
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop({ ...hopParams, mode: "manual" } as any);

    expect((res as any).parked).toBeUndefined();
    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not size a re-loop|config/i);
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();
  });

  it("park CAS loss where a rival PARKED first → reports the durable parked truth", async () => {
    const parent = hopOp({ closeDoneAt: new Date(Date.now() - AGE_BUDGET_MS - 60 * 60_000).toISOString() });
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.finalizeLoopHopParent as any).mockResolvedValue(undefined);
    vi.mocked(storage.getBorrowOperationById as any)
      .mockResolvedValueOnce(parent) // Phase 2 head re-read
      .mockResolvedValueOnce({ ...parent, status: "parked", metadata: { ...parent.metadata, parkReason: "post_close_age_exceeded" } });

    const res = await executeLoopHop(hopParams);

    expect((res as any).parked).toBe(true);
    expect(res.error).toMatch(/parked by a concurrent attempt/);
    // WO2A-C1: the rival won the CAS — this invocation must NOT carry the
    // journal/notify flag (it is reporting the SAME park a second time).
    expect((res as any).parkedByThisInvocation).toBeUndefined();
  });

  it("park CAS loss where a rival SUCCEEDED first → reports alreadyCompleted with the rival's records", async () => {
    const parent = hopOp({ closeDoneAt: new Date(Date.now() - AGE_BUDGET_MS - 60 * 60_000).toISOString() });
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.finalizeLoopHopParent as any).mockResolvedValue(undefined);
    vi.mocked(storage.getBorrowOperationById as any)
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce({
        ...parent,
        status: "succeeded",
        result: { borrowPositionId: "row-9", openSignature: OPEN_SIG_1, solReturnedLamports: "2000000000" },
      });

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(true);
    expect((res as any).alreadyCompleted).toBe(true);
    expect(res.borrowPositionId).toBe("row-9");
    expect(res.openSignature).toBe(OPEN_SIG_1);
  });

  it("Phase 2a adoption of a SUCCEEDED slot child pre-empts exhausted budgets (landed money is never parked away from)", async () => {
    const slotCrid = `${HOP_CRID}:open:${ATTEMPT_BUDGET}`;
    const parent = hopOp({
      openAttempts: ATTEMPT_BUDGET, // broadcast budget exhausted
      activeOpenClientRequestId: slotCrid,
      activeOpenVaultId: 47,
      closeDoneAt: new Date(Date.now() - AGE_BUDGET_MS - 60 * 60_000).toISOString(), // age budget exhausted
    });
    const succeededChild = {
      ...deadOpenChild(ATTEMPT_BUDGET),
      status: "succeeded",
      step: "opened",
      borrowPositionId: "adopted-row-1",
      metadata: {
        kind: "loop",
        vaultId: 47,
        principalLamports: "1900000000",
        leverage: 2,
        slippageBps: 50,
        openTxSignature: OPEN_SIG_1,
      },
      result: { signature: OPEN_SIG_1, borrowPositionId: "adopted-row-1" },
    };
    wire({ [HOP_CRID]: parent, [slotCrid]: succeededChild }, parent);

    const res = await executeLoopHop(hopParams);

    // Phase 2a runs BEFORE the budget gate: the landed child is adopted as
    // success — never parked away from, nothing new broadcast.
    expect(res.success).toBe(true);
    expect(res.borrowPositionId).toBe("adopted-row-1");
    expect(res.openSignature).toBe(OPEN_SIG_1);
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-1",
      { expectedActiveOpenClientRequestId: slotCrid },
      expect.objectContaining({ status: "succeeded", borrowPositionId: "adopted-row-1" }),
    );
    const parkWrites = vi
      .mocked(storage.finalizeLoopHopParent as any)
      .mock.calls.filter((c: any[]) => c[2]?.status === "parked");
    expect(parkWrites).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("an already-attributed resume NEVER rewrites closeDoneAt (the budget anchor is immutable)", async () => {
    const parent = hopOp(); // closeDoneAt + solReturned + closeSignature already persisted
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true); // benign preflight failure (null config)
    const closeDoneAtWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1]?.mergeMetadata && "closeDoneAt" in c[1].mergeMetadata);
    expect(closeDoneAtWrites).toHaveLength(0);
  });
});

// ============================================================================
// F. Parked door — automatic refusal vs manual resume
// ============================================================================

describe("executeLoopHop — parked door", () => {
  it("automatic recovery NEVER re-drives a parked hop (no reads past the door, no writes)", async () => {
    const parent = hopOp(
      { parkReason: "open_broadcast_budget_exhausted", parkedAt: new Date().toISOString() },
      { status: "parked", step: "parked" },
    );
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).parked).toBe(true);
    expect((res as any).parkReason).toBe("open_broadcast_budget_exhausted");
    // WO2A-C1: the parked-door refusal reports an EXISTING park — never the
    // journal/notify authorization.
    expect((res as any).parkedByThisInvocation).toBeUndefined();
    expect(res.error).toMatch(/parked for manual resume/i);
    expect(storage.getBorrowOperationById).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();
  });

  it("manual mode passes the door: the parked hop re-enters the normal resume flow", async () => {
    const parent = hopOp(
      { parkReason: "post_close_age_exceeded", parkedAt: new Date().toISOString() },
      { status: "parked", step: "parked" },
    );
    wire({ [HOP_CRID]: parent }, parent);

    const res = await executeLoopHop({ ...hopParams, mode: "manual" } as any);

    // Step re-anchored to close_done, then the fresh flow ran (and failed
    // benignly on the mocked null vault config) — NOT a parked refusal.
    expect((res as any).parked).toBeUndefined();
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not size a re-loop|config/i);
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith("hop-1", expect.objectContaining({ step: "close_done" }));
    // WO2A-C1: a FAILED manual resume must leave the op PARKED — the step
    // re-anchor is metadata only; no write may flip `status` (else the
    // automatic sweep would resume a hop the operator parked).
    const statusWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1] && "status" in c[1]);
    expect(statusWrites).toHaveLength(0);
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();
  });

  it("a FAILED manual resume that STARTED parked leaves the durable parent parked — and still outside automatic eligibility (WO2A-C2)", async () => {
    const parent = hopOp(
      { parkReason: "open_broadcast_budget_exhausted", parkedAt: new Date().toISOString() },
      { status: "parked", step: "parked" },
    );
    wire({ [HOP_CRID]: parent }, parent);

    // Phase 1: manual resume passes the door, then fails benignly downstream.
    const manual = await executeLoopHop({ ...hopParams, mode: "manual" } as any);
    expect((manual as any).parked).toBeUndefined();
    expect((manual as any).resumable).toBe(true);
    expect(manual.success).toBe(false);
    // The failed manual attempt must never flip `status` — the park is durable.
    const statusWritesManual = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1] && "status" in c[1]);
    expect(statusWritesManual).toHaveLength(0);
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();

    // Phase 2: with the durable row still parked, an AUTOMATIC pass must
    // refuse at the door — the failed manual attempt re-opened nothing.
    vi.mocked(storage.updateBorrowOperation as any).mockClear();
    vi.mocked(storage.getBorrowOperationById as any).mockClear();
    const parkedTruth = hopOp(
      { parkReason: "open_broadcast_budget_exhausted", parkedAt: new Date().toISOString() },
      { status: "parked", step: "parked" },
    );
    wire({ [HOP_CRID]: parkedTruth }, parkedTruth);

    const auto = await executeLoopHop(hopParams);
    expect(auto.success).toBe(false);
    expect((auto as any).parked).toBe(true);
    expect((auto as any).parkReason).toBe("open_broadcast_budget_exhausted");
    expect((auto as any).parkedByThisInvocation).toBeUndefined();
    expect(storage.getBorrowOperationById).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();
  });
});

// ============================================================================
// G. Single-flight slot machinery
// ============================================================================

describe("executeLoopHop — single-flight slot", () => {
  it("crash-orphan slot (claimed, child op never created) is REUSED, then RELEASED via CAS before the one fallback", async () => {
    const orphanCrid = `${HOP_CRID}:open:2`;
    const parent = hopOp({ openAttempts: 2, activeOpenClientRequestId: orphanCrid, activeOpenVaultId: 47 });
    wire({ [HOP_CRID]: parent }, parent); // slot crid resolves to nothing

    const res = await executeLoopHop(hopParams);

    // Preflight failed on the orphan's pinned vault (null config) → the slot
    // was released with the EXACT crid guard, then the single fallback also
    // failed → resumable. No claim was ever minted beside the orphan.
    expect(storage.clearLoopHopActiveChild).toHaveBeenCalledTimes(1);
    expect(storage.clearLoopHopActiveChild).toHaveBeenCalledWith("hop-1", orphanCrid);
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not size a re-loop|config/i);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("orphan-slot release CAS loss → durable-truth re-read, never a rival attempt", async () => {
    const orphanCrid = `${HOP_CRID}:open:2`;
    const parent = hopOp({ openAttempts: 2, activeOpenClientRequestId: orphanCrid, activeOpenVaultId: 47 });
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.clearLoopHopActiveChild as any).mockResolvedValue(false);

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/recovery slot changed/);
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
  });

  it("slot crid resolving to a NON-open op is corrupt linkage → resumable, human look", async () => {
    const slotCrid = `${HOP_CRID}:open:2`;
    const parent = hopOp({ openAttempts: 2, activeOpenClientRequestId: slotCrid, activeOpenVaultId: 47 });
    wire({ [HOP_CRID]: parent, [slotCrid]: closeChild({ id: "weird" }) }, parent);

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/unexpected record/);
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
    expect(storage.clearLoopHopActiveChild).not.toHaveBeenCalled();
  });

  it("claim refused (record changed) → durable-truth resumable, nothing broadcast", async () => {
    const parent = hopOp();
    wire({ [HOP_CRID]: parent }, parent);
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 47 ? CFG_47 : null));
    vi.mocked(getFreshLoopRates as any).mockResolvedValue(profitableRates());
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue(undefined);

    const res = await executeLoopHop(hopParams);

    expect(storage.claimLoopHopOpenAttempt).toHaveBeenCalledWith("hop-1", 47);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/changed underneath this attempt/);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("claim ADOPTED an existing slot whose child op EXISTS → blocked; reconciliation belongs to Phase 2a, never a rival broadcast", async () => {
    const parent = hopOp();
    const rivalCrid = `${HOP_CRID}:open:7`;
    wire(
      {
        [HOP_CRID]: parent,
        [rivalCrid]: { ...deadOpenChild(7), status: "pending", step: "loop_sig_writeahead" },
      },
      parent,
    );
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 47 ? CFG_47 : null));
    vi.mocked(getFreshLoopRates as any).mockResolvedValue(profitableRates());
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue({
      adopted: true,
      activeOpenClientRequestId: rivalCrid,
      activeOpenVaultId: 47,
      openAttempts: 7,
    });

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/already re-opening/);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });

  it("claim ADOPTED a crash-orphan pinned to a DIFFERENT vault → honors the pinned vault (re-preflights it)", async () => {
    const parent = hopOp();
    wire({ [HOP_CRID]: parent }, parent); // adopted crid has no child op
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 47 ? CFG_47 : null));
    vi.mocked(getFreshLoopRates as any).mockResolvedValue(profitableRates());
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue({
      adopted: true,
      activeOpenClientRequestId: `${HOP_CRID}:open:7`,
      activeOpenVaultId: 4, // pinned elsewhere
      openAttempts: 7,
    });

    const res = await executeLoopHop(hopParams);

    // Pinned vault 4 was re-preflighted (and failed on null config) — the
    // durable intent wins over this retry's target, and the block is FINAL
    // for this pass (no fallback rival attempt; the retry resumes the pin).
    expect(routeMocks.getLoopVaultConfig).toHaveBeenCalledWith(4);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/loop vault 4 config|pinned recovery vault/i);
    expect(storage.claimLoopHopOpenAttempt).toHaveBeenCalledTimes(1);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });
});

// ============================================================================
// H. Resume attribution — proven own close vs closed_outside_hop
// ============================================================================

describe("executeLoopHop — resume attribution (no solReturned crumb)", () => {
  /** Parent that crashed after close broadcast, before any attribution crumb. */
  function unattributedParent(closeAttempts: number) {
    const p = hopOp({ closeAttempts, openAttempts: 0 }, { step: "pre_gated" });
    delete p.metadata.solReturnedLamports;
    delete p.metadata.closeSignature;
    delete p.metadata.closeDoneAt;
    return p;
  }

  it("an older proven exact close attributes the resume; the crumb is persisted before the open leg", async () => {
    const parent = unattributedParent(2);
    const provenAt = new Date(Date.now() - 10 * 60_000);
    wire(
      {
        [HOP_CRID]: parent,
        [`${HOP_CRID}:close:2`]: closeChild({ id: "c2", meta: { selfHeal: true } }),
        [`${HOP_CRID}:close:1`]: closeChild({
          id: "c1",
          result: { solReturnedLamports: "1900000000", signature: OLD_CLOSE_SIG },
          updatedAt: provenAt,
        }),
      },
      parent,
    );

    const res = await executeLoopHop(hopParams);

    // Attribution crumb persisted (return-checked) with the exact figure and
    // its source BEFORE any sizing.
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "hop-1",
      expect.objectContaining({
        step: "close_done",
        mergeMetadata: expect.objectContaining({
          solReturnedLamports: "1900000000",
          principalSource: "exact",
          closeSignature: OLD_CLOSE_SIG,
          closeDoneAt: provenAt.toISOString(),
        }),
      }),
    );
    // Flow then reached the fresh-attempt sizing (benign preflight failure).
    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.solReturnedLamports).toBe("1900000000");
    expect(res.closeSignature).toBe(OLD_CLOSE_SIG);
  });

  it("NO own close proves money moved → terminal closed_outside_hop (never re-levers out-of-band funds)", async () => {
    const parent = unattributedParent(2);
    wire({ [HOP_CRID]: parent }, parent); // both close crids → null

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).resumable).toBeUndefined();
    expect(res.error).toMatch(/closed outside this hop/);
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "hop-1",
      expect.objectContaining({ status: "failed", step: "closed_outside_hop" }),
    );
  });

  it("own close proven but unattributable (corrupt exact) → resumable manual-look, NO terminal write", async () => {
    const parent = unattributedParent(1);
    wire(
      {
        [HOP_CRID]: parent,
        [`${HOP_CRID}:close:1`]: closeChild({
          id: "c1",
          result: { solReturnedLamports: "banana", signature: OLD_CLOSE_SIG },
        }),
      },
      parent,
    );

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/cannot be attributed/);
    const terminalWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: unknown[]) => (c[1] as any)?.status === "failed");
    expect(terminalWrites).toHaveLength(0);
  });

  it("candidate close unverifiable over RPC → resumable retry-later (never terminal, never sized)", async () => {
    const parent = unattributedParent(1);
    wire(
      {
        [HOP_CRID]: parent,
        [`${HOP_CRID}:close:1`]: closeChild({ id: "c1", result: { signature: OLD_CLOSE_SIG } }),
      },
      parent,
    );
    vi.mocked(getServerConnection as any).mockReturnValue(connWith({ statuses: new Error("rpc down") }));

    const res = await executeLoopHop(hopParams);

    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not yet confirm/);
    expect(routeMocks.getLoopVaultConfig).not.toHaveBeenCalled();
  });
});

// ============================================================================
// I. Policy-deny fallback boundary (WO2A-C1 cell 8)
//
// Drives the REAL executeLoopOpen deep enough to hit its policy gate: the
// preflight (which returns BEFORE the gate) passes, then the real attempt is
// denied pre-broadcast by the depeg check — jupQuote is served by a stubbed
// global fetch whose outAmount makes the market rate deviate wildly from the
// stake-pool rate. Deny ⇒ no signature ⇒ child provably never broadcast.
// ============================================================================

describe("executeLoopHop — policy-deny fallback boundary (WO2A-C1)", () => {
  const SLOT_CRID_1 = `${HOP_CRID}:open:1`;

  /** Stub global fetch for jupQuote; deny = depeg (outAmount enormous). */
  function stubQuoteFetch({ otherAmountThreshold = "999999999999999", outAmount = "999999999999999" } = {}) {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ outAmount, otherAmountThreshold }),
      text: async () => JSON.stringify({ outAmount, otherAmountThreshold }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  function primeOpenableTarget() {
    routeMocks.getLoopVaultConfig.mockImplementation(async (v: number) => (v === 47 ? CFG_47 : null));
    vi.mocked(getFreshLoopRates as any).mockResolvedValue(profitableRates());
    vi.mocked(storage.createBorrowOperation as any).mockResolvedValue({ id: "deny-child-1" });
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockResolvedValue({
      adopted: false,
      activeOpenClientRequestId: SLOT_CRID_1,
      activeOpenVaultId: 47,
      openAttempts: 1,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pre-broadcast policy deny (no signature, no child record) → slot cleared via CAS, exactly ONE authorized fallback", async () => {
    const parent = hopOp();
    wire({ [HOP_CRID]: parent }, parent); // slot crid resolves to nothing → provably never broadcast
    primeOpenableTarget();
    stubQuoteFetch(); // depeg → deny

    const res = await executeLoopHop(hopParams);

    // Denied child's slot was released with the EXACT crid guard…
    expect(storage.clearLoopHopActiveChild).toHaveBeenCalledTimes(1);
    expect(storage.clearLoopHopActiveChild).toHaveBeenCalledWith("hop-1", SLOT_CRID_1);
    // …then exactly ONE fallback ran (vault 4 preflight → null config → fail),
    // and fallbackUsed prevents any third attempt.
    expect(routeMocks.getLoopVaultConfig).toHaveBeenCalledWith(47);
    expect(routeMocks.getLoopVaultConfig).toHaveBeenCalledWith(4);
    expect(storage.claimLoopHopOpenAttempt).toHaveBeenCalledTimes(1); // fallback died at preflight, before any claim
    expect(storage.createBorrowOperation).toHaveBeenCalledTimes(1); // only the denied child was ever created
    expect((res as any).resumable).toBe(true);
    expect(res.success).toBe(false);
    expect((res as any).parked).toBeUndefined();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled(); // nothing broadcast anywhere
  });

  it("deny but the child carries write-ahead evidence → NO slot clear, NO fallback (Phase 2a owns it next pass)", async () => {
    const parent = hopOp();
    // The slot crid resolves to a failed child WITH openTxSignature: the deny
    // verdict cannot prove it never broadcast — must stay on its crid.
    wire({ [HOP_CRID]: parent, [SLOT_CRID_1]: deadOpenChild(1) }, parent);
    primeOpenableTarget();
    stubQuoteFetch(); // depeg → deny

    const res = await executeLoopHop(hopParams);

    expect(storage.clearLoopHopActiveChild).not.toHaveBeenCalled();
    expect(routeMocks.getLoopVaultConfig).not.toHaveBeenCalledWith(4); // no fallback attempt
    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("non-deny open failure (unusable quote, no policyReasons) → NO fallback, NO slot clear (resumable)", async () => {
    const parent = hopOp();
    wire({ [HOP_CRID]: parent }, parent);
    primeOpenableTarget();
    stubQuoteFetch({ otherAmountThreshold: "0" }); // minOut 0 → quote_failed, not a policy deny

    const res = await executeLoopHop(hopParams);

    expect(storage.clearLoopHopActiveChild).not.toHaveBeenCalled();
    expect(routeMocks.getLoopVaultConfig).not.toHaveBeenCalledWith(4);
    expect(storage.claimLoopHopOpenAttempt).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });
});

// ============================================================================
// I. WO2B2C — reciprocal SOL-withdraw gate (fresh hops defer; recovery bypasses)
// ============================================================================

describe("executeLoopHop — WO2B2C reciprocal SOL-withdraw gate", () => {
  /** Open source loop position (vault 4) so the FRESH path reaches the gate. */
  function openLoopPos(over?: Record<string, unknown>) {
    return {
      id: SRC_POS,
      walletAddress: WALLET,
      kind: "loop",
      status: "open",
      venueVaultId: 4,
      venuePositionId: 77,
      ...(over ?? {}),
    } as any;
  }

  /** Prime a GENUINELY FRESH hop: no existing op row, open source position. */
  function primeFreshHop() {
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(openLoopPos());
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => ({
      id: "fresh-hop-1",
      txSignatures: [],
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...p,
    }));
  }

  /** Durable SOL-withdraw op row in the wallet-wide scan. */
  let wdSeq = 0;
  function wdOp(status: string, over?: Record<string, unknown>) {
    return {
      id: `wd-${status}-${++wdSeq}`,
      walletAddress: WALLET,
      operationType: "agent_sol_withdraw",
      status,
      step: "requested",
      borrowPositionId: null,
      clientRequestId: `wd-crid-${wdSeq}`,
      txSignatures: [],
      metadata: {},
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(over ?? {}),
    } as any;
  }

  /** Only the ONE-ARG wallet-wide scans (":1577"-style linked-child reads pass a positionId). */
  const walletWideScans = () =>
    vi.mocked(storage.getBorrowOperations as any).mock.calls.filter((c: any[]) => c.length === 1 || c[1] == null);

  it("ORDERING + ZERO MONEY WORK: parent persisted BEFORE the scan; a pending withdrawal defers writelessly", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).deferredForSolWithdraw).toBe(true);
    expect((res as any).resumable).toBe(true);
    expect((res as any).policyDenied).toBeUndefined();
    expect((res as any).parked).toBeUndefined();
    expect((res as any).terminal).toBeUndefined();
    expect(res.error).toMatch(/SOL withdrawal .* still settling/i);
    // Durable parent FIRST (our half of the create-then-scan Dekker property)…
    expect(storage.createBorrowOperation).toHaveBeenCalledTimes(1);
    expect(storage.createBorrowOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "loop_hop",
        status: "pending",
        step: "initialized",
        clientRequestId: HOP_CRID,
      }),
    );
    const createOrder = vi.mocked(storage.createBorrowOperation as any).mock.invocationCallOrder[0];
    const scanOrder = vi.mocked(storage.getBorrowOperations as any).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(scanOrder);
    // …then a WRITELESS defer: no carry gate, no strict balance read, no op
    // writes (parent left pending/'initialized', never terminaled), no lock,
    // no children, no gas, no broadcast.
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(getAgentTokenBalanceRawStrict).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled();
    expect(storage.claimLoopHopOpenAttempt).not.toHaveBeenCalled();
    expect(withBorrowLock).not.toHaveBeenCalled();
    expect(ensureVaultGas).not.toHaveBeenCalled();
    expect(executeAgentSwap).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("terminal withdraw statuses (succeeded/completed/failed) NEVER block — the hop reaches the carry gate", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      wdOp("succeeded"),
      wdOp("completed"),
      wdOp("failed"),
    ]);

    const res = await executeLoopHop(hopParams);

    expect((res as any).deferredForSolWithdraw).toBeUndefined();
    expect(getFreshLoopRates).toHaveBeenCalled(); // past the gate, into the carry re-gate
    expect((res as any).policyDenied).toBe(true); // clean decline (rates unreadable here)
  });

  it("an UNKNOWN withdraw status blocks — allowlist semantics, only proven-terminal passes", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("reconciling_v9")]);

    const res = await executeLoopHop(hopParams);

    expect((res as any).deferredForSolWithdraw).toBe(true);
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
  });

  it("a terminal row PLUS a pending row still defers (any live withdrawal wins)", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("succeeded"), wdOp("pending")]);

    const res = await executeLoopHop(hopParams);

    expect((res as any).deferredForSolWithdraw).toBe(true);
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
  });

  it("non-withdraw op types NEVER trigger this gate (type-scoped scan)", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      wdOp("pending", { operationType: "loop_close" }),
      wdOp("pending", { operationType: "loop_open" }),
      wdOp("pending", { operationType: "loop_hop" }),
      wdOp("pending", { operationType: "vault_park" }),
    ]);

    const res = await executeLoopHop(hopParams);

    expect((res as any).deferredForSolWithdraw).toBeUndefined();
    expect(getFreshLoopRates).toHaveBeenCalled();
  });

  it("READ FAILURE: an unreadable scan defers FAIL-CLOSED — resumable, zero writes, parent stays pending", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockRejectedValue(new Error("pg pool drained"));

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).deferredForSolWithdraw).toBe(true);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not verify/i);
    expect(res.error).toMatch(/pg pool drained/);
    expect(getFreshLoopRates).not.toHaveBeenCalled();
    expect(getAgentTokenBalanceRawStrict).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).toHaveBeenCalledTimes(1); // parent only — no children
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("a MALFORMED scan result (non-array) defers fail-closed rather than passing", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue(undefined);

    const res = await executeLoopHop(hopParams);

    expect((res as any).deferredForSolWithdraw).toBe(true);
    expect((res as any).resumable).toBe(true);
    expect(storage.updateBorrowOperation).not.toHaveBeenCalled();
  });

  it("RETRY: the SAME clientRequestId adopts the parent (no duplicate) and proceeds once the withdrawal terminals", async () => {
    primeFreshHop();
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);

    const first = await executeLoopHop(hopParams);
    expect((first as any).deferredForSolWithdraw).toBe(true);
    expect(storage.createBorrowOperation).toHaveBeenCalledTimes(1);
    const createdParent = await vi.mocked(storage.createBorrowOperation as any).mock.results[0].value;

    // Withdrawal finishes; the retry finds the durable parent by crid.
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (crid === HOP_CRID ? createdParent : null),
    );
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("succeeded")]);

    const second = await executeLoopHop(hopParams);

    expect((second as any).deferredForSolWithdraw).toBeUndefined();
    expect(storage.createBorrowOperation).toHaveBeenCalledTimes(1); // adopted, never duplicated
    expect(getFreshLoopRates).toHaveBeenCalled(); // past the gate on retry
    expect((second as any).policyDenied).toBe(true); // clean downstream decline (rates unreadable here)
  });

  it("BYPASS solReturned crumb: PHASE 1 (and the gate) skipped — recovery continues despite a pending withdrawal", async () => {
    const parent = hopOp(); // solReturned + closeSignature + baseline persisted
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);

    const res = await executeLoopHop(hopParams);

    expect(walletWideScans()).toHaveLength(0); // the withdraw scan NEVER ran
    expect((res as any).deferredForSolWithdraw).toBeUndefined();
    expect((res as any).resumable).toBe(true); // benign preflight failure (null config) — recovery path owns it
  });

  it("BYPASS persisted baseline (pre_gated, close not yet attempted): close is in play — no scan, close leg advances", async () => {
    const parent = hopOp({ closeAttempts: 0, preCloseAgentLamports: "5000000000" }, { step: "pre_gated" });
    delete parent.metadata.solReturnedLamports;
    delete parent.metadata.closeSignature;
    delete parent.metadata.closeDoneAt;
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(openLoopPos()); // source still open
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (p: any) => ({
      id: "close-child-x",
      metadata: {},
      ...p,
    }));

    const res = await executeLoopHop(hopParams);

    expect(walletWideScans()).toHaveLength(0); // gate bypassed outright
    expect((res as any).deferredForSolWithdraw).toBeUndefined();
    // Proof it advanced INTO the close leg past the gate: the per-attempt
    // write-ahead landed (closeAttempts 0 → 1).
    const attemptWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: any[]) => c[1]?.mergeMetadata && "closeAttempts" in c[1].mergeMetadata);
    expect(attemptWrites.length).toBeGreaterThan(0);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled(); // dies at null vault config, pre-broadcast
  });

  it("BYPASS close-attempt write-ahead WITHOUT baseline (anomalous crumb): no scan; existing re-gate behavior unchanged", async () => {
    const parent = hopOp({ closeAttempts: 1 }, { step: "initialized" });
    delete parent.metadata.solReturnedLamports;
    delete parent.metadata.closeSignature;
    delete parent.metadata.preCloseAgentLamports;
    delete parent.metadata.closeDoneAt;
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(openLoopPos());
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);

    const res = await executeLoopHop(hopParams);

    expect(walletWideScans()).toHaveLength(0); // a close may be in flight — never defer
    expect((res as any).deferredForSolWithdraw).toBeUndefined();
    expect(getFreshLoopRates).toHaveBeenCalled(); // fell through to the EXISTING carry re-gate
  });

  it("BYPASS source no longer open: the closed-source recovery path owns it — no scan, no defer", async () => {
    const parent = hopOp(); // close crumbs present…
    delete parent.metadata.solReturnedLamports; // …but output not yet attributed
    wire({ [HOP_CRID]: parent }, parent);
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(openLoopPos({ status: "closed" }));
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([wdOp("pending")]);

    const res = await executeLoopHop(hopParams);

    expect(walletWideScans()).toHaveLength(0);
    expect((res as any).deferredForSolWithdraw).toBeUndefined();
  });
});
