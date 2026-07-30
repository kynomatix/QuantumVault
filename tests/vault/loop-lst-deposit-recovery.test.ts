import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/storage", () => ({
  storage: {
    getBorrowOperationByClientRequestId: vi.fn(),
    getBorrowOperationById: vi.fn(),
    getBorrowPositions: vi.fn(),
    createBorrowOperation: vi.fn(),
    updateBorrowOperation: vi.fn(),
    createEquityEvent: vi.fn(),
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

vi.mock("../../server/vault/gas-funding", () => ({ ensureVaultGas: vi.fn() }));

vi.mock("../../server/vault/jupiter-lend-borrow-executor", () => {
  const chains = new Map<string, Promise<unknown>>();
  return {
    withBorrowLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
      const prior = chains.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      chains.set(key, prior.then(() => gate));
      await prior;
      try { return await fn(); } finally { release(); }
    }),
    borrowLockKey: vi.fn((w: string, b: string | null, v: number) => `${w}:${b ?? ""}:${v}`),
  };
});

const routeMocks = vi.hoisted(() => ({
  getLoopVaultConfig: vi.fn(),
  readLoopLivePositionHealth: vi.fn(),
}));
vi.mock("../../server/vault/jupiter-lend-borrow-route", () => ({
  JupiterLendBorrowRoute: class {
    getLoopVaultConfig = routeMocks.getLoopVaultConfig;
    readLoopLivePositionHealth = routeMocks.readLoopLivePositionHealth;
  },
  WSOL_MINT: "So11111111111111111111111111111111111111112",
}));

vi.mock("../../server/vault/loop/loop-risk-policy", () => ({
  LOOP_VAULT_ALLOWLIST: { 47: { collateralSymbol: "JupSOL" } },
  LOOP_RATE_REGISTRY: [{ vaultId: 47, symbol: "JupSOL" }],
  LOOP_ALLOCATION_POLICY: { rateStalenessMs: 60_000 },
  LOOP_HOP_RECOVERY_POLICY: { maxAutomaticPostCloseAgeMs: 1, maxOpenBroadcastAttempts: 1 },
  LOOP_RISK_POLICY: { maxLeverage: 4, minNetCarryApy: 0 },
  computeLoopTargetLeverage: vi.fn(),
  evaluateLoopOpenRequest: vi.fn(),
  recoverHopSolReturned: vi.fn(),
}));

vi.mock("../../server/vault/loop/loop-rate-oracle", () => ({
  getFreshLoopRates: vi.fn(),
  sampleAndPersistLoopRates: vi.fn(),
  netCarryAt: vi.fn(),
  LOOP_RATE_REGISTRY: [{ vaultId: 47, symbol: "JupSOL" }],
}));

vi.mock("@jup-ag/lend/flashloan", () => ({ getFlashloanIx: vi.fn() }));
vi.mock("@jup-ag/lend/borrow", () => ({
  getOperateIx: vi.fn(),
  MAX_WITHDRAW_AMOUNT: "MAX_WITHDRAW",
  MAX_REPAY_AMOUNT: "MAX_REPAY",
}));

import {
  executeLoopLstDepositOpen,
  pickLoopLstSwapTxSig,
  verifyLoopLstSwapTx,
} from "../../server/vault/loop/loop-executor";
import { storage } from "../../server/storage";
import {
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
  getServerConnection,
} from "../../server/agent-wallet";

const WALLET = "wallet-lst-recovery";
const AGENT = "11111111111111111111111111111111";
const MINT = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const SIG = "lstSwapSignature111111111111111111111111111111111111";
const OTHER_SIG = "lstOtherSignature111111111111111111111111111111111";
const CRID = "lst-deposit-1";

const CFG = {
  vaultId: 47,
  collateralSymbol: "JupSOL",
  collateralMint: MINT,
  collateralDecimals: 9,
  debtMint: "So11111111111111111111111111111111111111112",
  liquidationThreshold: 0.9,
  borrowApr: 0.03,
  minimumBorrowingRaw: "0",
  oraclePriceOperateUsd: 1,
  withdrawUtilization: 0.5,
};

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "lst-op-1",
    walletAddress: WALLET,
    operationType: "loop_lst_deposit",
    status: "pending",
    step: "initialized",
    clientRequestId: CRID,
    borrowPositionId: null,
    txSignatures: [],
    metadata: {
      kind: "loop",
      mint: MINT,
      symbol: "JupSOL",
      requestedAmountRaw: "1000",
      vaultId: 47,
    },
    result: null,
    error: null,
    ...overrides,
  } as any;
}

function connection(statuses: unknown[] = [null], height = 0) {
  return {
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: statuses }),
    getBlockHeight: vi.fn().mockResolvedValue(height),
  } as any;
}

const params = {
  walletAddress: WALLET,
  agentPublicKey: AGENT,
  agentSecretKey: new Uint8Array(64),
  mint: MINT,
  amountRaw: "1000",
  clientRequestId: CRID,
  vaultId: 47,
};

let durable: any;
let updateCall = 0;
let missingUpdateAt: number | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  durable = null;
  updateCall = 0;
  missingUpdateAt = null;
  routeMocks.getLoopVaultConfig.mockResolvedValue(CFG);
  routeMocks.readLoopLivePositionHealth.mockResolvedValue(null);
  vi.mocked(getServerConnection as any).mockReturnValue(connection());
  vi.mocked(getAgentTokenBalanceRawStrict as any).mockImplementation(async (_agent: string, mint: string) =>
    mint === MINT
      ? { amountRaw: "1000", decimals: 9, uiAmount: 0.000001 }
      : { amountRaw: "5000000", decimals: 9, uiAmount: 0.005 },
  );
  vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(async () => durable);
  vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
    durable?.id === id ? durable : undefined,
  );
  vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (record: any) => {
    durable = makeOperation({ status: record.status, step: record.step, metadata: record.metadata });
    return durable;
  });
  vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (id: string, patch: any) => {
    updateCall++;
    if (missingUpdateAt === updateCall || !durable || durable.id !== id) return undefined;
    if (patch.status !== undefined) durable.status = patch.status;
    if (patch.step !== undefined) durable.step = patch.step;
    if (patch.appendTxSignature) durable.txSignatures = [...durable.txSignatures, patch.appendTxSignature];
    if (patch.mergeMetadata) durable.metadata = { ...durable.metadata, ...patch.mergeMetadata };
    if (patch.result !== undefined) durable.result = patch.result;
    return durable;
  });
  vi.mocked(storage.createEquityEvent as any).mockResolvedValue({});
});

describe("LST conversion exact signature selector and verdict", () => {
  it("requires swap_sent plus explicit signature equal to the final raw entry", () => {
    const coherent = makeOperation({ step: "swap_sent", txSignatures: [SIG], metadata: { swapSignature: SIG } });
    expect(pickLoopLstSwapTxSig(coherent)).toBe(SIG);
    expect(pickLoopLstSwapTxSig({ ...coherent, step: "initialized" })).toBeNull();
    expect(pickLoopLstSwapTxSig({ ...coherent, txSignatures: [OTHER_SIG] })).toBeNull();
    expect(pickLoopLstSwapTxSig({ ...coherent, txSignatures: [SIG, null] })).toBeNull();
  });

  it("malformed provenance performs zero RPC; expiry is strict past +30", async () => {
    const bad = makeOperation({ step: "swap_sent", txSignatures: [OTHER_SIG], metadata: { swapSignature: SIG } });
    const c1 = connection([{ confirmationStatus: "finalized", err: null }], 9999);
    expect(await verifyLoopLstSwapTx(bad, c1)).toBe("malformed");
    expect(c1.getSignatureStatuses).not.toHaveBeenCalled();

    const good = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: { swapSignature: SIG, swapLastValidBlockHeight: 1000 },
    });
    expect(await verifyLoopLstSwapTx(good, connection([null], 1030))).toBe("still_valid");
    expect(await verifyLoopLstSwapTx(good, connection([null], 1031))).toBe("expired");
  });

  it("distinguishes landed, authoritative on-chain failure, and RPC failure", async () => {
    const good = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: { swapSignature: SIG, swapLastValidBlockHeight: 1000 },
    });
    expect(await verifyLoopLstSwapTx(good, connection([{ confirmationStatus: "finalized", err: null }]))).toBe("landed");
    expect(await verifyLoopLstSwapTx(good, connection([{ confirmationStatus: "confirmed", err: "x" }]))).toBe("onchain_failed");
    const rpcDown = connection();
    rpcDown.getSignatureStatuses.mockRejectedValueOnce(new Error("rpc down"));
    expect(await verifyLoopLstSwapTx(good, rpcDown)).toBe("unverifiable");
  });
});

describe("executeLoopLstDepositOpen durable recovery", () => {
  it("missing baseline update aborts before the swap helper is called", async () => {
    missingUpdateAt = 1;
    const result = await executeLoopLstDepositOpen(params);
    expect(result.success).toBe(false);
    expect(result.resumable).toBe(true);
    expect(executeAgentSwap).not.toHaveBeenCalled();
  });

  it("missing signature write-ahead return prevents broadcast and clears the unspent baseline", async () => {
    vi.mocked(executeAgentSwap as any).mockImplementation(async (args: any) => {
      try {
        await args.onBeforeBroadcast({ signature: SIG, blockhash: "bh", lastValidBlockHeight: 1000 });
        return { success: true, signature: SIG, outputReceivedRaw: "100" };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });
    missingUpdateAt = 2;
    const result = await executeLoopLstDepositOpen(params);
    expect(result.success).toBe(false);
    expect(durable.step).toBe("initialized");
    expect(durable.metadata.solBeforeLamports).toBeNull();
    expect(durable.txSignatures).toEqual([]);
  });

  it("signatureless helper result after persisted hook reloads exact evidence and never clears or re-swaps", async () => {
    const c = connection([null], 500);
    vi.mocked(getServerConnection as any).mockReturnValue(c);
    vi.mocked(executeAgentSwap as any).mockImplementation(async (args: any) => {
      await args.onBeforeBroadcast({ signature: SIG, blockhash: "bh", lastValidBlockHeight: 1000 });
      return { success: false, signature: undefined, error: "legacy helper lost signature" };
    });

    const first = await executeLoopLstDepositOpen(params);
    const second = await executeLoopLstDepositOpen(params);

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(executeAgentSwap).toHaveBeenCalledTimes(1);
    expect(durable.step).toBe("swap_sent");
    expect(durable.metadata.swapSignature).toBe(SIG);
    expect(durable.metadata.solBeforeLamports).toBe("5000000");
    expect(durable.txSignatures).toEqual([SIG]);
  });

  it("reload failure after signatureless result leaves durable state untouched", async () => {
    vi.mocked(executeAgentSwap as any).mockImplementation(async (args: any) => {
      await args.onBeforeBroadcast({ signature: SIG, blockhash: "bh", lastValidBlockHeight: 1000 });
      return { success: false, signature: undefined, error: "lost" };
    });
    vi.mocked(storage.getBorrowOperationById as any).mockRejectedValueOnce(new Error("db read down"));
    const result = await executeLoopLstDepositOpen(params);
    expect(result.success).toBe(false);
    expect(durable.step).toBe("swap_sent");
    expect(durable.metadata.swapSignature).toBe(SIG);
    expect(durable.metadata.solBeforeLamports).toBe("5000000");
  });

  it("malformed durable signature blocks before RPC and before any fresh swap", async () => {
    durable = makeOperation({
      step: "swap_sent",
      txSignatures: [OTHER_SIG],
      metadata: { ...makeOperation().metadata, swapSignature: SIG, solBeforeLamports: "1" },
    });
    const c = connection([{ confirmationStatus: "finalized", err: null }]);
    vi.mocked(getServerConnection as any).mockReturnValue(c);
    const result = await executeLoopLstDepositOpen(params);
    expect(result.success).toBe(false);
    expect(c.getSignatureStatuses).not.toHaveBeenCalled();
    expect(executeAgentSwap).not.toHaveBeenCalled();
  });

  it("coherent landed signature records one positive strict delta and never re-swaps", async () => {
    durable = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: {
        ...makeOperation().metadata,
        swapSignature: SIG,
        swapLastValidBlockHeight: 1000,
        solBeforeLamports: "5000000",
      },
    });
    vi.mocked(getServerConnection as any).mockReturnValue(
      connection([{ confirmationStatus: "finalized", err: null }]),
    );
    vi.mocked(getAgentTokenBalanceRawStrict as any).mockImplementation(async (_agent: string, mint: string) =>
      mint === MINT
        ? { amountRaw: "1000", decimals: 9, uiAmount: 0.000001 }
        : { amountRaw: "5000100", decimals: 9, uiAmount: 0.0050001 },
    );

    const result = await executeLoopLstDepositOpen(params);

    expect(result.success).toBe(false); // open preflight fails closed on absent mocked rates
    expect(result.resumable).toBe(true);
    expect(durable.step).toBe("swapped");
    expect(durable.metadata.realizedLamports).toBe("100");
    expect(executeAgentSwap).not.toHaveBeenCalled();
    // The pre-existing recovery path advances the durable state but does not
    // retroactively emit the fresh-swap best-effort audit event.
    expect(storage.createEquityEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["unreadable", true, "5000100"],
    ["non-positive", false, "5000000"],
  ])("landed conversion with %s strict delta remains resumable with its breadcrumb intact", async (_label, unreadable, nowRaw) => {
    durable = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: {
        ...makeOperation().metadata,
        swapSignature: SIG,
        swapLastValidBlockHeight: 1000,
        solBeforeLamports: "5000000",
      },
    });
    vi.mocked(getServerConnection as any).mockReturnValue(
      connection([{ confirmationStatus: "finalized", err: null }]),
    );
    vi.mocked(getAgentTokenBalanceRawStrict as any).mockImplementation(async (_agent: string, mint: string) => {
      if (mint === MINT) return { amountRaw: "1000", decimals: 9, uiAmount: 0.000001 };
      if (unreadable) throw new Error("strict SOL read down");
      return { amountRaw: nowRaw, decimals: 9, uiAmount: Number(nowRaw) / 1e9 };
    });

    const result = await executeLoopLstDepositOpen(params);

    expect(result.success).toBe(false);
    expect(result.resumable).toBe(true);
    expect(durable.step).toBe("swap_sent");
    expect(durable.metadata.swapSignature).toBe(SIG);
    expect(durable.txSignatures).toEqual([SIG]);
    expect(executeAgentSwap).not.toHaveBeenCalled();
  });

  it("a dead signature followed by two pre-hook failures stays retry-ready instead of wedging malformed", async () => {
    durable = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: {
        ...makeOperation().metadata,
        swapSignature: SIG,
        swapLastValidBlockHeight: 1000,
        solBeforeLamports: "5000000",
      },
    });
    vi.mocked(getServerConnection as any).mockReturnValue(
      connection([{ confirmationStatus: "confirmed", err: "atomic failure" }]),
    );
    vi.mocked(executeAgentSwap as any).mockResolvedValue({ success: false, error: "fresh attempt stopped pre-hook" });

    const first = await executeLoopLstDepositOpen(params);
    const second = await executeLoopLstDepositOpen(params);

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(executeAgentSwap).toHaveBeenCalledTimes(2);
    expect(durable.step).toBe("swap_retry_ready");
    expect(durable.metadata.swapResolvedDeadSignature).toBe(SIG);
    expect(durable.metadata.swapSignature).toBeNull();
    expect(durable.txSignatures).toEqual([SIG]);
  });

  it("an expired exact signature is marked retry-ready before a fresh attempt", async () => {
    durable = makeOperation({
      step: "swap_sent",
      txSignatures: [SIG],
      metadata: {
        ...makeOperation().metadata,
        swapSignature: SIG,
        swapLastValidBlockHeight: 1000,
        solBeforeLamports: "5000000",
      },
    });
    vi.mocked(getServerConnection as any).mockReturnValue(connection([null], 1031));
    vi.mocked(executeAgentSwap as any).mockResolvedValue({ success: false, error: "fresh attempt stopped pre-hook" });

    const result = await executeLoopLstDepositOpen(params);

    expect(result.success).toBe(false);
    expect(durable.step).toBe("swap_retry_ready");
    expect(durable.metadata.swapResolvedDeadSignature).toBe(SIG);
    expect(durable.txSignatures).toEqual([SIG]);
  });

  it("parallel retries serialize: one writes ahead and the waiter only reconciles it", async () => {
    const c = connection([null], 500);
    vi.mocked(getServerConnection as any).mockReturnValue(c);
    vi.mocked(executeAgentSwap as any).mockImplementation(async (args: any) => {
      await args.onBeforeBroadcast({ signature: SIG, blockhash: "bh", lastValidBlockHeight: 1000 });
      return { success: false, signature: SIG, error: "unresolved" };
    });
    const [a, b] = await Promise.all([
      executeLoopLstDepositOpen(params),
      executeLoopLstDepositOpen(params),
    ]);
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    expect(executeAgentSwap).toHaveBeenCalledTimes(1);
    expect(durable.step).toBe("swap_sent");
  });
});
