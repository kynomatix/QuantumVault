import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Per-bot CARVE/OPEN + UNWIND/CLOSE orchestrator resume regression tests
 * (architect findings, 2026-06-29). Everything money-touching is mocked, so
 * these are pure orchestration tests of the resumable op-machine.
 *
 * UNWIND/CLOSE — the two BLOCKERs the architect found in `runPerbotUnwindClose`:
 *   1) An UNREADABLE account-position baseline must FAIL CLOSED — never default
 *      to 0n, which would make the re-supply idempotency check pass spuriously
 *      and finalize the unwind WITHOUT re-pledging (stranding the returned INF
 *      free in the account wallet + leaving the account under-collateralised).
 *   2) A crash AFTER the close tx landed but BEFORE the DB finalize (DB left at
 *      "closing") must RESUME FORWARD: detect the empty on-chain position, NOT
 *      re-close it, reconcile the row to "closed", then transfer + re-pledge.
 *
 * CARVE/OPEN — the open-leg resume property (the architect asked us to pin it):
 *   A crash after `executeBorrowOpen` lands must NOT re-open. The executor
 *   write-ahead's a `pending` position row (stamped with tradingBotId + the
 *   predicted nftId) BEFORE it broadcasts, and the orchestrator's resume guard
 *   keeps any non-closed/non-failed row, so the resume finalizes idempotently.
 *
 * Both runners also REFUSE to resume a same-clientRequestId op started with
 * different params (validateOpIdentity), with NO mutation of the existing op.
 */

const INF_MINT = "INFmintPlaceholder11111111111111111111111";
const WALLET = "OwnerWallet1111111111111111111111111111111";
const BOT_POS_ID = "bot-pos-1";
const ACCT_POS_ID = "acct-pos-1";
const BOT_VENUE_ID = 777;
const ACCT_VENUE_ID = 555;
const TRADING_BOT_ID = "83292021-8422-44e8-842f-1022c61eb256";

// All shared mocks + mutable state live in a hoisted block so the vi.mock
// factories (hoisted to the top of the file) can reference them safely.
const h = vi.hoisted(() => {
  const opStore = new Map<string, any>();
  const state = {
    opSeq: 0,
    positionRow: null as any, // single bot position (unwind getBorrowPosition)
    botPositions: [] as any[], // list for the carve/open getBorrowPositions guard
    liveBotHealth: undefined as any, // readLivePositionHealth(777)
    liveAcctHealth: undefined as any, // readLivePositionHealth(555)
    botCollBalance: 0n, // strict INF balance of the bot wallet
    botUsdcBalance: 0n, // strict USDC balance of the bot wallet
    acctUsdcBalance: 0n, // strict USDC balance of the ACCOUNT wallet (funds top-up)
  };
  const updatePositionMock = vi.fn(async (id: string, patch: any, ifStatus?: string) => {
    const row = state.positionRow;
    if (!row || row.id !== id) return undefined;
    if (ifStatus !== undefined && row.status !== ifStatus) return undefined; // CAS miss
    Object.assign(row, patch);
    return { ...row };
  });
  return {
    opStore,
    state,
    updatePositionMock,
    executeBorrowCloseMock: vi.fn(),
    executeSupplyCollateralMock: vi.fn(),
    executeBorrowOpenMock: vi.fn(),
    executeWithdrawCollateralMock: vi.fn(),
    transferExactMock: vi.fn(),
    supplyToExistingBotPositionMock: vi.fn(),
    borrowMoreOnExistingBotPositionMock: vi.fn(),
  };
});

vi.mock("../../server/storage", () => ({
  storage: {
    getBorrowOperationByClientRequestId: vi.fn(async (_w: string, reqId: string) => {
      for (const op of h.opStore.values()) if (op.clientRequestId === reqId) return { ...op };
      return undefined;
    }),
    createBorrowOperation: vi.fn(async (data: any) => {
      const id = `op-${++h.state.opSeq}`;
      const row = { id, txSignatures: [], metadata: {}, ...data };
      h.opStore.set(id, row);
      return { ...row };
    }),
    getBorrowOperationById: vi.fn(async (id: string) => {
      const op = h.opStore.get(id);
      return op ? { ...op } : undefined;
    }),
    updateBorrowOperation: vi.fn(async (id: string, patch: any) => {
      const op = h.opStore.get(id);
      if (!op) return undefined;
      const { mergeMetadata, appendTxSignature, ...rest } = patch;
      Object.assign(op, rest);
      if (mergeMetadata) op.metadata = { ...(op.metadata ?? {}), ...mergeMetadata };
      if (appendTxSignature) op.txSignatures = [...(op.txSignatures ?? []), appendTxSignature];
      return { ...op };
    }),
    getBorrowPosition: vi.fn(async (_w: string, id: string) =>
      h.state.positionRow && h.state.positionRow.id === id ? { ...h.state.positionRow } : undefined,
    ),
    getBorrowPositions: vi.fn(async (_w: string, _botId?: string | null) => h.state.botPositions.map((p) => ({ ...p }))),
    updateBorrowPosition: h.updatePositionMock,
  },
}));

vi.mock("../../server/agent-wallet", () => ({
  getServerConnection: () => ({}),
  // Real USDC mint literal (inlined: a hoisted vi.mock factory evaluates this
  // eagerly, so it cannot reference a top-level const — that would TDZ-throw).
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  getAgentTokenBalanceRawStrict: vi.fn(async (pk: string, mint: string) => {
    if (mint === INF_MINT) return { amountRaw: h.state.botCollBalance.toString() };
    // USDC: the top-up leg reads BOTH the bot wallet and the account wallet, so
    // distinguish them by pubkey (account pubkeys start with "Acct").
    const isAcct = pk.startsWith("Acct");
    return { amountRaw: (isAcct ? h.state.acctUsdcBalance : h.state.botUsdcBalance).toString() };
  }),
  transferTokenToWalletExact: h.transferExactMock,
}));

vi.mock("../../server/vault/jupiter-lend-borrow-executor", () => ({
  withBorrowLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  executeBorrowClose: h.executeBorrowCloseMock,
  executeSupplyCollateral: h.executeSupplyCollateralMock,
  executeWithdrawCollateral: h.executeWithdrawCollateralMock,
  executeBorrowOpen: h.executeBorrowOpenMock,
  supplyToExistingBotPosition: h.supplyToExistingBotPositionMock,
  borrowMoreOnExistingBotPosition: h.borrowMoreOnExistingBotPositionMock,
}));

vi.mock("../../server/vault/jupiter-lend-borrow-route", async (importOriginal) => {
  // Keep the REAL decodeVaultConfig (the grow path's pre-sign gate + post-withdraw
  // LTV assertion do real math against a decoded vault snapshot); only the live
  // position reads are faked.
  const actual: any = await importOriginal();
  return {
    ...actual,
    JupiterLendBorrowRoute: class {
      async readLivePositionHealth(_mint: string, posId: number) {
        if (posId === 555) return h.state.liveAcctHealth;
        if (posId === 777) return h.state.liveBotHealth;
        return null;
      }
    },
  };
});

vi.mock("../../server/vault/borrow-oracle-freshness", () => ({
  readBorrowOracleContext: vi.fn(async () => ({ publishAgeSec: 30, priceMove1hAbs: 0.02 })),
}));

import { runPerbotUnwindClose, runPerbotCarveOpen, runPerbotGrowLoan } from "../../server/vault/jupiter-lend-perbot-carve";
import { decodeVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";

const {
  opStore,
  state,
  updatePositionMock,
  executeBorrowCloseMock,
  executeSupplyCollateralMock,
  executeBorrowOpenMock,
  executeWithdrawCollateralMock,
  transferExactMock,
  supplyToExistingBotPositionMock,
  borrowMoreOnExistingBotPositionMock,
} = h;

// Live INF→USDC vault snapshot (id 43), same fixture as borrow-perbot-carve.test.ts:
// price ≈ $98.87/INF, maxLtv 0.75, liqThreshold 0.80. The grow path runs the REAL
// pre-sign withdraw gate + post-withdraw LTV assertion against this config.
const RAW_INF = {
  id: 43,
  address: "VaultAddrPlaceholder1111111111111111111111",
  oracle: "OracleAddrPlaceholder111111111111111111111",
  supplyToken: { address: INF_MINT, symbol: "INF", decimals: 9, price: "99.249552485649" },
  borrowToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "750",
  liquidationThreshold: "800",
  liquidationPenalty: "500",
  borrowRate: "466",
  supplyRate: "0",
  borrowFee: "0",
  borrowLimitUtilization: "405783379446790",
  minimumBorrowing: "1034775",
  borrowable: "5838249171951",
  withdrawable: "11610714005191",
  oraclePriceLiquidate: "98865597964440443",
  oraclePriceOperate: "98865597964440443",
};
const infVault = () => {
  const c = decodeVaultConfig(RAW_INF);
  if (!c) throw new Error("INF vault fixture failed to decode");
  return c;
};

const unwindParams = () => ({
  walletAddress: WALLET,
  vault: { collateralMint: INF_MINT } as any,
  accountPublicKey: "AcctPubkey11111111111111111111111111111111",
  accountSecretKey: new Uint8Array(64),
  botPublicKey: "BotPubkey111111111111111111111111111111111",
  botSecretKey: new Uint8Array(64),
  tradingBotId: TRADING_BOT_ID,
  botBorrowPositionId: BOT_POS_ID,
  accountBorrowPositionId: ACCT_POS_ID,
  accountVenuePositionId: ACCT_VENUE_ID,
  clientRequestId: "proof-1:unwind",
});

const carveParams = () => ({
  walletAddress: WALLET,
  vault: { collateralMint: INF_MINT } as any,
  accountPublicKey: "AcctPubkey11111111111111111111111111111111",
  accountSecretKey: new Uint8Array(64),
  botPublicKey: "BotPubkey111111111111111111111111111111111",
  botSecretKey: new Uint8Array(64),
  tradingBotId: TRADING_BOT_ID,
  accountBorrowPositionId: ACCT_POS_ID,
  accountVenuePositionId: ACCT_VENUE_ID,
  carveRaw: 200_000_000n,
  requestedDebtRaw: 5_000_000n,
  targetLtv: 0.5,
  clientRequestId: "proof-1:carve",
});

beforeEach(() => {
  opStore.clear();
  state.opSeq = 0;
  state.positionRow = null;
  state.botPositions = [];
  state.liveBotHealth = undefined;
  state.liveAcctHealth = undefined;
  state.botCollBalance = 0n;
  state.botUsdcBalance = 0n;
  state.acctUsdcBalance = 0n;
  executeBorrowCloseMock.mockReset();
  executeSupplyCollateralMock.mockReset();
  executeBorrowOpenMock.mockReset();
  executeWithdrawCollateralMock.mockReset();
  transferExactMock.mockReset();
  supplyToExistingBotPositionMock.mockReset();
  borrowMoreOnExistingBotPositionMock.mockReset();
  updatePositionMock.mockClear();
  transferExactMock.mockImplementation(async (args: any) => {
    if (args.onBeforeBroadcast) await args.onBeforeBroadcast({ signature: "sig-return", lastValidBlockHeight: 123 });
    return { success: true, signature: "sig-return" };
  });
  executeSupplyCollateralMock.mockResolvedValue({ success: true, signature: "sig-supply" });
});

describe("runPerbotUnwindClose — BLOCKER 1: unreadable account baseline fails closed", () => {
  it("stops at needs_attention and never re-supplies when the account position is unreadable", async () => {
    // Fresh op (no botCollBeforeRaw yet) -> the baseline block runs. Bot balance
    // reads fine, but the ACCOUNT position read flakes (null).
    state.positionRow = { id: BOT_POS_ID, status: "open", venuePositionId: String(BOT_VENUE_ID), collateralMint: INF_MINT };
    state.botCollBalance = 0n;
    state.liveAcctHealth = null; // <- unreadable account baseline

    const res = await runPerbotUnwindClose(unwindParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(res.step).toBe("initialized");
    // It must NOT have moved any money, and must NOT have finalized.
    expect(executeBorrowCloseMock).not.toHaveBeenCalled();
    expect(executeSupplyCollateralMock).not.toHaveBeenCalled();
    expect(transferExactMock).not.toHaveBeenCalled();
    const op = [...opStore.values()][0];
    expect(op.status).toBe("needs_attention");
    expect(op.status).not.toBe("succeeded");
    // No bogus 0n baseline was persisted.
    expect(op.metadata?.acctPosCollBeforeRaw).toBeUndefined();
  });
});

describe("runPerbotUnwindClose — BLOCKER 2: crash-after-close resumes forward", () => {
  it("detects the landed close (DB left 'closing'), does NOT re-close, re-pledges, and succeeds", async () => {
    // An op that crashed after the close tx LANDED but before the DB finalize:
    // baseline already persisted, step="closing", DB position still "closing",
    // and the on-chain bot position now reads EMPTY (debt 0 / collateral 0).
    opStore.set("op-resume", {
      id: "op-resume",
      clientRequestId: "proof-1:unwind",
      operationType: "perbot_unwind_close",
      status: "processing",
      step: "closing",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        botBorrowPositionId: BOT_POS_ID,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        botCollBeforeRaw: "0",
        acctPosCollBeforeRaw: "1000000000",
      },
    });
    state.positionRow = { id: BOT_POS_ID, status: "closing", venuePositionId: String(BOT_VENUE_ID), collateralMint: INF_MINT };
    state.liveBotHealth = { debtRaw: "0", collateralRaw: "0", oraclePriceUsd: 98.86 }; // close already landed
    // 0.2 INF was withdrawn back to the bot wallet by the (landed) close.
    state.botCollBalance = 200_000_000n;
    // The account position has NOT yet grown (re-pledge not done) -> re-supply must run.
    state.liveAcctHealth = { debtRaw: "20000000", collateralRaw: "1000000000", oraclePriceUsd: 98.86 };

    const res = await runPerbotUnwindClose(unwindParams());

    expect(res.success).toBe(true);
    expect(res.restoredRaw).toBe("200000000");
    // The close already landed -> the executor close must NOT be invoked again.
    expect(executeBorrowCloseMock).not.toHaveBeenCalled();
    // The DB row was reconciled forward to closed (CAS on the prior "closing").
    expect(updatePositionMock).toHaveBeenCalledWith(
      BOT_POS_ID,
      expect.objectContaining({ status: "closed" }),
      "closing",
    );
    expect(state.positionRow.status).toBe("closed");
    // The returned collateral was transferred back and RE-PLEDGED into the account.
    expect(transferExactMock).toHaveBeenCalledTimes(1);
    expect(executeSupplyCollateralMock).toHaveBeenCalledTimes(1);
    expect(executeSupplyCollateralMock).toHaveBeenCalledWith(
      expect.objectContaining({ collateralRaw: 200_000_000n, borrowPositionId: ACCT_POS_ID, tradingBotId: null }),
    );
    const op = opStore.get("op-resume");
    expect(op.status).toBe("succeeded");
  });

  it("re-pledge is idempotent: if the account already grew by the returned amount, it does NOT re-supply", async () => {
    // Same crash point, but the account position ALREADY shows the re-pledged
    // collateral (a prior run supplied it) -> finalize WITHOUT a second supply.
    opStore.set("op-resume", {
      id: "op-resume",
      clientRequestId: "proof-1:unwind",
      operationType: "perbot_unwind_close",
      status: "processing",
      step: "returned_to_account",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        botBorrowPositionId: BOT_POS_ID,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        botCollBeforeRaw: "0",
        acctPosCollBeforeRaw: "1000000000",
        returnedRaw: "200000000",
      },
    });
    state.positionRow = { id: BOT_POS_ID, status: "closed", venuePositionId: String(BOT_VENUE_ID), collateralMint: INF_MINT };
    // Account collateral already grew by the returned 0.2 INF -> supplied already.
    state.liveAcctHealth = { debtRaw: "20000000", collateralRaw: "1200000000", oraclePriceUsd: 98.86 };

    const res = await runPerbotUnwindClose(unwindParams());

    expect(res.success).toBe(true);
    expect(res.restoredRaw).toBe("200000000");
    expect(executeSupplyCollateralMock).not.toHaveBeenCalled();
    expect(executeBorrowCloseMock).not.toHaveBeenCalled();
  });
});

describe("runPerbotUnwindClose — TOP-UP/SWEEP fix (architect 2026-06-29): close 0x1", () => {
  // The MAX_REPAY close OVER-PULLS USDC slightly beyond the bot's borrowed
  // principal (accrued interest), so a razor-thin bot wallet SPL-0x1'd. The fix
  // lends a small CAPPED USDC headroom (account->bot) BEFORE the close and sweeps
  // back AT MOST that amount (account-owned) AFTER re-pledging.
  const ACCT_PK = "AcctPubkey11111111111111111111111111111111";
  const BOT_PK = "BotPubkey111111111111111111111111111111111";

  const seedCloseFailedOp = () => {
    // The REAL failed P0-4 op: started by the PRE-FIX code (no top-up leg) and
    // parked at "close_failed" (the close reverted via SPL 0x1 -> never landed)
    // with NO recorded top-up. A same-proofRunId re-POST must still top up first.
    opStore.set("op-cf", {
      id: "op-cf",
      clientRequestId: "proof-1:unwind",
      operationType: "perbot_unwind_close",
      status: "processing",
      step: "close_failed",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        botBorrowPositionId: BOT_POS_ID,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        botCollBeforeRaw: "0",
        acctPosCollBeforeRaw: "1000000000",
      },
    });
    // The reverted close left the bot loan recoverable/open on-chain.
    state.positionRow = { id: BOT_POS_ID, status: "open", venuePositionId: String(BOT_VENUE_ID), collateralMint: INF_MINT };
    state.liveBotHealth = { debtRaw: "11000000", collateralRaw: "200000000", oraclePriceUsd: 98.86 }; // still owes
    state.liveAcctHealth = { debtRaw: "20000000", collateralRaw: "1000000000", oraclePriceUsd: 98.86 }; // not regrown -> re-supply runs
    state.botCollBalance = 200_000_000n; // 0.2 INF returned to the bot by the (now-succeeding) close
    executeBorrowCloseMock.mockResolvedValue({ success: true, finalized: true, signature: "sig-close" });
  };

  it("legacy resume tops up account->bot BEFORE retrying the close, then sweeps back ONLY the top-up (never the bot's own USDC)", async () => {
    seedCloseFailedOp();
    state.botUsdcBalance = 11_000_000n; // ~borrowed principal: short the interest headroom + holds spare the sweep must NOT take
    state.acctUsdcBalance = 5_000_000n; // account funds the small top-up

    const res = await runPerbotUnwindClose({ ...unwindParams(), borrowedPrincipalRaw: 11_000_000n });

    expect(res.success).toBe(true);
    expect(res.restoredRaw).toBe("200000000");
    expect(res.sweptRaw).toBe("330000");
    // The top-up unblocked the close -> it ran exactly once (no repeat 0x1).
    expect(executeBorrowCloseMock).toHaveBeenCalledTimes(1);
    // 3 transfers: (1) top-up account->bot, (2) collateral return bot->account, (3) sweep bot->account.
    expect(transferExactMock).toHaveBeenCalledTimes(3);
    const topup = transferExactMock.mock.calls[0][0];
    expect(topup.agentPublicKey).toBe(ACCT_PK);
    expect(topup.toWalletAddress).toBe(BOT_PK);
    expect(topup.amountRaw).toBe(330_000n); // 3% of 11 USDC headroom
    const sweep = transferExactMock.mock.calls[2][0];
    expect(sweep.agentPublicKey).toBe(BOT_PK);
    expect(sweep.toWalletAddress).toBe(ACCT_PK);
    // MONEY-SAFETY CAP: returns ONLY the 0.33 USDC top-up, NEVER the bot's 11 USDC.
    expect(sweep.amountRaw).toBe(330_000n);
    const op = opStore.get("op-cf");
    expect(op.metadata.topupRaw).toBe("330000");
    expect(op.metadata.sweptRaw).toBe("330000");
    expect(op.status).toBe("succeeded");
  });

  it("computes a ZERO top-up (no account move) and skips the sweep when the bot is already flush", async () => {
    seedCloseFailedOp();
    state.botUsdcBalance = 50_000_000n; // far more than debt + headroom -> no top-up needed
    state.acctUsdcBalance = 5_000_000n;

    const res = await runPerbotUnwindClose({ ...unwindParams(), borrowedPrincipalRaw: 11_000_000n });

    expect(res.success).toBe(true);
    expect(res.restoredRaw).toBe("200000000");
    expect(res.sweptRaw).toBe("0");
    expect(executeBorrowCloseMock).toHaveBeenCalledTimes(1);
    // ONLY the collateral return ran: NO top-up, NO sweep.
    expect(transferExactMock).toHaveBeenCalledTimes(1);
    const ret = transferExactMock.mock.calls[0][0];
    expect(ret.agentPublicKey).toBe(BOT_PK);
    expect(ret.toWalletAddress).toBe(ACCT_PK);
    expect(ret.amountRaw).toBe(200_000_000n); // the collateral (INF), not a USDC top-up
    expect(opStore.get("op-cf").metadata.topupRaw).toBe("0");
  });

  it("FAILS CLOSED (no money moved, close not attempted) when the account cannot fund the required top-up", async () => {
    seedCloseFailedOp();
    state.botUsdcBalance = 11_000_000n; // short the headroom -> top-up required
    state.acctUsdcBalance = 100n; // account too thin to fund it

    const res = await runPerbotUnwindClose({ ...unwindParams(), borrowedPrincipalRaw: 11_000_000n });

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(res.step).toBe("topup_failed");
    expect(transferExactMock).not.toHaveBeenCalled();
    expect(executeBorrowCloseMock).not.toHaveBeenCalled();
    // No top-up was persisted (the gate fails BEFORE the write-ahead).
    expect(opStore.get("op-cf").metadata.topupRaw).toBeUndefined();
  });
});

describe("runPerbotUnwindClose — refuses to resume a same-reqId op under changed inputs", () => {
  it("rejects (no mutation) when the existing op was started with a different bot position", async () => {
    opStore.set("op-x", {
      id: "op-x",
      clientRequestId: "proof-1:unwind",
      operationType: "perbot_unwind_close",
      status: "processing",
      step: "closing",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        botBorrowPositionId: "a-different-bot-position",
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
      },
    });

    const res = await runPerbotUnwindClose(unwindParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(false);
    expect(executeBorrowCloseMock).not.toHaveBeenCalled();
    expect(executeSupplyCollateralMock).not.toHaveBeenCalled();
    // The existing op was NOT mutated to a failure state.
    expect(opStore.get("op-x").status).toBe("processing");
  });
});

describe("runPerbotCarveOpen — resume after a landed open does NOT re-open", () => {
  it("finalizes idempotently from the write-ahead position row, never calling executeBorrowOpen again", async () => {
    // Crash after executeBorrowOpen landed but before the orchestrator recorded
    // step "bot_opened". The executor write-aheads the new bot position id onto
    // the carve op (metadata.borrowPositionId) BEFORE broadcasting, so on resume
    // the open-leg matches that EXACT row and finalizes idempotently.
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "opening",
      txSignatures: ["sig-open"],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
        accountPostLtv: 0.4,
        borrowedUsdcRaw: "5000000",
        borrowPositionId: "bot-pos-new",
      },
    });
    // The executor's write-ahead row (status "open" after it finalized on-chain).
    state.botPositions = [
      { id: "bot-pos-new", status: "open", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID) },
    ];

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(true);
    expect(res.borrowPositionId).toBe("bot-pos-new");
    expect(res.carvedRaw).toBe("200000000");
    // Neither money leg ran again.
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(opStore.get("op-carve").status).toBe("succeeded");
  });

  it("finalizes a still-'pending' write-ahead row ONLY when the open is PROVEN on-chain (landed, DB lagged)", async () => {
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "opening",
      txSignatures: ["sig-open"],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
        borrowPositionId: "bot-pos-pending",
      },
    });
    // Pending (write-ahead before broadcast) — matched by EXACT id via the carve
    // op's write-ahead link. A bare 'pending' row does NOT prove the open landed,
    // so finalize requires an on-chain read showing a positive position. positionRow
    // and botPositions[0] share ONE object so the reconcile mutation is observable.
    const pendingRow = { id: "bot-pos-pending", status: "pending", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID) };
    state.positionRow = pendingRow;
    state.botPositions = [pendingRow];
    state.liveBotHealth = { debtRaw: "5000000", collateralRaw: "200000000", oraclePriceUsd: 98.86 }; // open DID land

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(true);
    expect(res.borrowPositionId).toBe("bot-pos-pending");
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
    // FINDING #4: the lagged row MUST be reconciled pending->open with the OBSERVED
    // on-chain amounts (CAS on the prior 'pending' status) BEFORE finalize, or the
    // downstream unwind (executeBorrowClose requires status 'open') cannot close it.
    expect(updatePositionMock).toHaveBeenCalledWith(
      "bot-pos-pending",
      { status: "open", collateralAmountRaw: "200000000", debtAmountRaw: "5000000" },
      "pending",
    );
    expect(pendingRow.status).toBe("open");
  });

  it("finalizes an 'open' row whose op-metadata is MISSING borrowedUsdcRaw by sourcing the row's debtAmountRaw (resume, delta 0)", async () => {
    // Crash window: the executor finalized the bot row to 'open' WITH the observed
    // debt, but the process died BEFORE the op recorded borrowedUsdcRaw in metadata.
    // On resume the route's "borrowed USDC landed" check sees a same-request delta of
    // 0, so the runner MUST surface the row's debtAmountRaw as borrowedUsdcRaw or the
    // route false-500s with the bot loan left OPEN.
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "opening",
      txSignatures: ["sig-open"],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
        accountPostLtv: 0.4,
        borrowPositionId: "bot-pos-new",
        // borrowedUsdcRaw intentionally ABSENT (crash before it was written).
      },
    });
    state.botPositions = [
      { id: "bot-pos-new", status: "open", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID), debtAmountRaw: "5000000", collateralAmountRaw: "200000000" },
    ];

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(true);
    expect(res.borrowPositionId).toBe("bot-pos-new");
    expect(res.borrowedUsdcRaw).toBe("5000000"); // sourced from the row, not metadata
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on a 'pending' write-ahead row whose open is UNCONFIRMED on-chain (no double-open)", async () => {
    // Crash in the send window: the row was write-ahead'd as 'pending' BEFORE the
    // broadcast. We do NOT hold the open's signature, so a bare on-chain ZERO can't
    // distinguish "no money moved" from an in-flight tx. Re-opening could
    // double-open, so the orchestrator must fail CLOSED (funds safe in the bot
    // wallet) rather than finalize or re-open.
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "opening",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
        borrowPositionId: "bot-pos-pending",
      },
    });
    state.botPositions = [
      { id: "bot-pos-pending", status: "pending", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID) },
    ];
    state.liveBotHealth = { debtRaw: "0", collateralRaw: "0", oraclePriceUsd: 98.86 }; // nothing on-chain

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (does NOT adopt) a FOREIGN live row when our write-ahead id points elsewhere", async () => {
    // Our carve op recorded its own bot position id, but that row is gone and a
    // DIFFERENT non-terminal row exists on the bot. The orchestrator must NOT
    // adopt the foreign row or open over it — it fails closed for reconcile.
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "opening",
      txSignatures: ["sig-open"],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
        borrowPositionId: "bot-pos-ours",
      },
    });
    state.botPositions = [
      { id: "bot-pos-foreign", status: "open", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID) },
    ];

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on a live row when NO write-ahead id was recorded yet (any row is foreign)", async () => {
    // No open of ours has begun (metadata has no borrowPositionId), yet a live bot
    // row exists. It cannot be ours, so refuse to adopt or open over it.
    opStore.set("op-carve", {
      id: "op-carve",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "carved_to_bot",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "200000000",
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        carvedRawObserved: "200000000",
      },
    });
    state.botPositions = [
      { id: "bot-pos-foreign", status: "pending", collateralMint: INF_MINT, tradingBotId: TRADING_BOT_ID, venuePositionId: String(BOT_VENUE_ID) },
    ];

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
  });
});

describe("runPerbotCarveOpen — carve_failed recovery uses metadata.carveRaw capped by held (NOT a stale remaining-collateral reading)", () => {
  // REGRESSION (the real stuck-loop bug, 2026-06-30): the AMOUNT-EXACT withdraw
  // un-pledges exactly the requested carve into the ACCOUNT agent wallet, but the
  // orchestrator was sizing the account->bot transfer from the withdraw's
  // observedCollateralRaw — which is the POST-withdraw REMAINING account-position
  // collateral, NOT the withdrawn delta. So a $5 carve persisted
  // carvedRawObserved = the whole remaining stake (0.3065 INF) and the transfer
  // leg then tried to move 0.3065 INF while the wallet only held the ~0.0935 INF
  // that was actually un-pledged -> permanent carve_failed loop.
  //
  // The fix: re-derive the transfer as min(metadata.carveRaw, strict live wallet
  // balance) and persist the TRUE carved amount BEFORE the broadcast. These tests
  // pin both directions of the min().
  const openSucceeds = () => {
    executeBorrowOpenMock.mockImplementation(async (args: any) => {
      if (args.onPositionCreated) await args.onPositionCreated("bot-pos-new");
      return { success: true, borrowPositionId: "bot-pos-new", observedDebtRaw: "5000000", signature: "sig-open" };
    });
  };

  const seedCarveFailedOp = (staleObservedRaw: string) => {
    // The REAL stuck op: the withdraw landed, then carve_failed at the transfer
    // leg with a stale carvedRawObserved (the remaining-collateral value).
    opStore.set("op-cf", {
      id: "op-cf",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "carve_failed",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "93503712", // the TRUE intended carve (immutable original)
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
        accountPostLtv: 0.29,
        carvedRawObserved: staleObservedRaw, // <- the bad value that wedged the loop
      },
    });
    // Resume sends the SAME carveRaw it was created with (validateOpIdentity).
    state.botPositions = [];
  };

  it("transfers the intended carve (held >= intended) and ignores the stale remaining-collateral value", async () => {
    seedCarveFailedOp("306496280"); // stale = whole remaining 0.3065 INF stake
    // The account wallet actually holds only the ~0.0935 INF that was un-pledged
    // (plus 2 dust units). INF strict-balance reads return botCollBalance.
    state.botCollBalance = 93_503_714n;
    openSucceeds();

    const res = await runPerbotCarveOpen({ ...carveParams(), carveRaw: 93_503_712n });

    expect(res.success).toBe(true);
    // The transfer moved min(intended 93503712, held 93503714) = 93503712 —
    // NEVER the stale 306496280 that caused the "holds X but Y required" loop.
    expect(transferExactMock).toHaveBeenCalledTimes(1);
    const xfer = transferExactMock.mock.calls[0][0];
    expect(xfer.agentPublicKey).toBe("AcctPubkey11111111111111111111111111111111");
    expect(xfer.toWalletAddress).toBe("BotPubkey111111111111111111111111111111111");
    expect(xfer.amountRaw).toBe(93_503_712n);
    // The corrected amount was persisted BEFORE the broadcast.
    expect(opStore.get("op-cf").metadata.carvedRawObserved).toBe("93503712");
    // The open leg supplies exactly the corrected carve.
    expect(executeBorrowOpenMock).toHaveBeenCalledTimes(1);
    expect(executeBorrowOpenMock.mock.calls[0][0].collateralRaw).toBe(93_503_712n);
    expect(res.carvedRaw).toBe("93503712");
  });

  it("caps the transfer at the live held balance when it is LESS than the intended carve (never moves more than is in the wallet)", async () => {
    seedCarveFailedOp("306496280");
    state.botCollBalance = 50_000_000n; // wallet holds LESS than the intended 93503712
    openSucceeds();

    const res = await runPerbotCarveOpen({ ...carveParams(), carveRaw: 93_503_712n });

    expect(res.success).toBe(true);
    expect(transferExactMock).toHaveBeenCalledTimes(1);
    expect(transferExactMock.mock.calls[0][0].amountRaw).toBe(50_000_000n); // capped at held
    expect(opStore.get("op-cf").metadata.carvedRawObserved).toBe("50000000");
    expect(executeBorrowOpenMock.mock.calls[0][0].collateralRaw).toBe(50_000_000n);
  });

  it("FAILS CLOSED (no transfer, no open) when the carved collateral cannot be read", async () => {
    seedCarveFailedOp("306496280");
    // Force the strict INF balance read to throw (unreadable) -> must fail closed,
    // never fall back to the stale value or a fail-open read.
    const { getAgentTokenBalanceRawStrict } = await import("../../server/agent-wallet");
    (getAgentTokenBalanceRawStrict as any).mockImplementationOnce(async () => {
      throw new Error("rpc unreadable");
    });
    openSucceeds();

    const res = await runPerbotCarveOpen({ ...carveParams(), carveRaw: 93_503_712n });

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(true);
    expect(transferExactMock).not.toHaveBeenCalled();
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
  });
});

describe("runPerbotCarveOpen — refuses to resume a same-reqId op under changed inputs", () => {
  it("rejects (no mutation) when the existing op was started with a different carve amount", async () => {
    opStore.set("op-carve-x", {
      id: "op-carve-x",
      clientRequestId: "proof-1:carve",
      operationType: "perbot_carve_open",
      status: "processing",
      step: "withdrawing",
      txSignatures: [],
      metadata: {
        tradingBotId: TRADING_BOT_ID,
        collateralMint: INF_MINT,
        accountBorrowPositionId: ACCT_POS_ID,
        accountVenuePositionId: ACCT_VENUE_ID,
        carveRaw: "999999999", // <- different from the resuming caller's 200000000
        requestedDebtRaw: "5000000",
        targetLtv: 0.5,
      },
    });

    const res = await runPerbotCarveOpen(carveParams());

    expect(res.success).toBe(false);
    expect(res.needsAttention).toBe(false);
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();
    expect(opStore.get("op-carve-x").status).toBe("processing");
  });
});

// ---------------------------------------------------------------------------
// ADD-COLLATERAL mode on runPerbotGrowLoan (manual "Add Collateral" on the
// Manage Loan dialog): same carve → transfer → supply legs as grow, but NO
// borrow leg, a DISTINCT operationType ("perbot_carve_topup"), and a hard
// requestedDebtRaw === 0 pin so a replay can never mutate between modes.
// ---------------------------------------------------------------------------

const addCollParams = () => ({
  walletAddress: WALLET,
  vault: infVault(),
  accountPublicKey: "AcctPubkey11111111111111111111111111111111",
  accountSecretKey: new Uint8Array(64),
  botPublicKey: "BotPubkey111111111111111111111111111111111",
  botSecretKey: new Uint8Array(64),
  tradingBotId: TRADING_BOT_ID,
  accountBorrowPositionId: ACCT_POS_ID,
  accountVenuePositionId: ACCT_VENUE_ID,
  botBorrowPositionId: BOT_POS_ID,
  botVenuePositionId: BOT_VENUE_ID,
  carveRaw: 200_000_000n, // 0.2 INF @ 9dp
  requestedDebtRaw: 0n,
  targetLtv: 0.5,
  clientRequestId: "proof-1:addcoll",
  mode: "add_collateral" as const,
});

/** Identity metadata matching addCollParams(), for pre-seeded resume ops. */
const addCollMeta = () => ({
  tradingBotId: TRADING_BOT_ID,
  collateralMint: INF_MINT,
  accountBorrowPositionId: ACCT_POS_ID,
  accountVenuePositionId: ACCT_VENUE_ID,
  botBorrowPositionId: BOT_POS_ID,
  botVenuePositionId: BOT_VENUE_ID,
  carveRaw: "200000000",
  requestedDebtRaw: "0",
  targetLtv: 0.5,
});

describe("runPerbotGrowLoan mode=add_collateral — happy path has NO borrow leg", () => {
  beforeEach(() => {
    // Account: 1 INF collateral, 20 USDC debt @ ~$98.87 → LTV ≈ 0.202. A 0.2 INF
    // carve leaves LTV ≈ 0.253 — both the pre-sign gate (target 0.5) and the
    // post-withdraw assertion pass on this same static reading.
    state.liveAcctHealth = { debtRaw: "20000000", collateralRaw: "1000000000", oraclePriceUsd: 98.8656 };
    state.botCollBalance = 200_000_000n; // carved INF sitting in the account wallet
    executeWithdrawCollateralMock.mockImplementation(async (args: any) => {
      if (args.onBeforeBroadcast) await args.onBeforeBroadcast({ signature: "sig-withdraw", lastValidBlockHeight: 100 });
      return { success: true, signature: "sig-withdraw" };
    });
    supplyToExistingBotPositionMock.mockImplementation(async (args: any) => {
      if (args.onBeforeBroadcast) await args.onBeforeBroadcast({ signature: "sig-supply-bot", lastValidBlockHeight: 101 });
      return { success: true, signature: "sig-supply-bot" };
    });
  });

  it("carves, transfers, supplies, finalizes — and NEVER borrows", async () => {
    const res = await runPerbotGrowLoan(addCollParams());

    expect(res.success).toBe(true);
    expect(res.step).toBe("final_read");
    expect(res.carvedRaw).toBe("200000000");
    expect(res.borrowPositionId).toBe(BOT_POS_ID);
    expect(res.borrowedUsdcRaw).toBeUndefined(); // no debt was created
    expect(res.accountPostLtv).not.toBeNull();
    expect(res.accountPostLtv!).toBeLessThanOrEqual(0.5 + 0.01);

    // The three money legs ran exactly once…
    expect(executeWithdrawCollateralMock).toHaveBeenCalledTimes(1);
    expect(transferExactMock).toHaveBeenCalledTimes(1);
    expect(supplyToExistingBotPositionMock).toHaveBeenCalledTimes(1);
    // …and NOTHING borrow-shaped ever ran.
    expect(borrowMoreOnExistingBotPositionMock).not.toHaveBeenCalled();
    expect(executeBorrowOpenMock).not.toHaveBeenCalled();

    // The op is the DISTINCT manual type (invisible to auto-topup's
    // selectResumableTopUpOp filter on "perbot_collateral_topup").
    const op = [...opStore.values()].find((o) => o.clientRequestId === "proof-1:addcoll");
    expect(op.operationType).toBe("perbot_carve_topup");
    expect(op.status).toBe("succeeded");
    expect(op.step).toBe("final_read");

    // Supply went into the bot's EXISTING position with the exact carved amount.
    const supplyArgs = supplyToExistingBotPositionMock.mock.calls[0][0];
    expect(supplyArgs.borrowPositionId).toBe(BOT_POS_ID);
    expect(supplyArgs.collateralRaw).toBe(200_000_000n);
  });

  it("a replay of a SUCCEEDED op returns the stored result without touching money again", async () => {
    const first = await runPerbotGrowLoan(addCollParams());
    expect(first.success).toBe(true);

    executeWithdrawCollateralMock.mockClear();
    transferExactMock.mockClear();
    supplyToExistingBotPositionMock.mockClear();

    const again = await runPerbotGrowLoan(addCollParams());
    expect(again.success).toBe(true);
    expect(again.carvedRaw).toBe("200000000");
    expect(again.borrowedUsdcRaw).toBeUndefined();
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(transferExactMock).not.toHaveBeenCalled();
    expect(supplyToExistingBotPositionMock).not.toHaveBeenCalled();
    expect(borrowMoreOnExistingBotPositionMock).not.toHaveBeenCalled();
  });
});

describe("runPerbotGrowLoan — mode guards (no op created, no money touched)", () => {
  it("REJECTS add_collateral with a non-zero requestedDebtRaw", async () => {
    const res = await runPerbotGrowLoan({ ...addCollParams(), requestedDebtRaw: 5_000_000n });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/must not borrow/i);
    expect(opStore.size).toBe(0);
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
  });

  it("REJECTS plain grow with a ZERO requestedDebtRaw (grow must borrow)", async () => {
    const res = await runPerbotGrowLoan({ ...addCollParams(), mode: "grow" as const });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/greater than zero/i);
    expect(opStore.size).toBe(0);
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
  });
});

describe("runPerbotGrowLoan — cross-MODE same-reqId replay is REFUSED (no mutation)", () => {
  it("an existing GROW op cannot be resumed as add_collateral", async () => {
    opStore.set("op-grow-x", {
      id: "op-grow-x",
      clientRequestId: "proof-1:addcoll",
      operationType: "perbot_grow_loan", // <- started as a GROW (borrowing) op
      status: "processing",
      step: "initialized",
      txSignatures: [],
      metadata: { ...addCollMeta(), requestedDebtRaw: "5000000" },
    });

    const res = await runPerbotGrowLoan(addCollParams());

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/different type|refusing to resume/i);
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(transferExactMock).not.toHaveBeenCalled();
    expect(supplyToExistingBotPositionMock).not.toHaveBeenCalled();
    expect(borrowMoreOnExistingBotPositionMock).not.toHaveBeenCalled();
    // The existing op was NOT mutated.
    const op = opStore.get("op-grow-x");
    expect(op.status).toBe("processing");
    expect(op.step).toBe("initialized");
  });

  it("an existing ADD-COLLATERAL op cannot be resumed as grow", async () => {
    opStore.set("op-addcoll-x", {
      id: "op-addcoll-x",
      clientRequestId: "proof-1:addcoll",
      operationType: "perbot_carve_topup",
      status: "processing",
      step: "initialized",
      txSignatures: [],
      metadata: addCollMeta(),
    });

    const res = await runPerbotGrowLoan({ ...addCollParams(), mode: "grow" as const, requestedDebtRaw: 5_000_000n });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/different type|refusing to resume/i);
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(opStore.get("op-addcoll-x").status).toBe("processing");
  });
});

describe("runPerbotGrowLoan mode=add_collateral — resume at supplied_to_bot finalizes idempotently", () => {
  it("skips every money leg and finalizes from the persisted carvedRawObserved", async () => {
    opStore.set("op-addcoll-r", {
      id: "op-addcoll-r",
      clientRequestId: "proof-1:addcoll",
      operationType: "perbot_carve_topup",
      status: "processing",
      step: "supplied_to_bot", // crashed AFTER the supply landed, BEFORE finalize
      txSignatures: ["sig-withdraw", "sig-return", "sig-supply-bot"],
      metadata: {
        ...addCollMeta(),
        carvedRawObserved: "200000000",
        accountPostLtv: 0.2529,
      },
    });

    const res = await runPerbotGrowLoan(addCollParams());

    expect(res.success).toBe(true);
    expect(res.step).toBe("final_read");
    expect(res.carvedRaw).toBe("200000000");
    expect(res.accountPostLtv).toBe(0.2529);
    expect(res.borrowedUsdcRaw).toBeUndefined();

    // NO leg re-ran: no withdraw, no transfer, no supply, no borrow.
    expect(executeWithdrawCollateralMock).not.toHaveBeenCalled();
    expect(transferExactMock).not.toHaveBeenCalled();
    expect(supplyToExistingBotPositionMock).not.toHaveBeenCalled();
    expect(borrowMoreOnExistingBotPositionMock).not.toHaveBeenCalled();

    const op = opStore.get("op-addcoll-r");
    expect(op.status).toBe("succeeded");
    expect(op.step).toBe("final_read");
  });
});
