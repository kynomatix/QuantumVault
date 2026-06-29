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
  getAgentTokenBalanceRawStrict: vi.fn(async (_pk: string, mint: string) => ({
    amountRaw: (mint === INF_MINT ? h.state.botCollBalance : h.state.botUsdcBalance).toString(),
  })),
  transferTokenToWalletExact: h.transferExactMock,
}));

vi.mock("../../server/vault/jupiter-lend-borrow-executor", () => ({
  withBorrowLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  executeBorrowClose: h.executeBorrowCloseMock,
  executeSupplyCollateral: h.executeSupplyCollateralMock,
  executeWithdrawCollateral: h.executeWithdrawCollateralMock,
  executeBorrowOpen: h.executeBorrowOpenMock,
}));

vi.mock("../../server/vault/jupiter-lend-borrow-route", () => ({
  JupiterLendBorrowRoute: class {
    async readLivePositionHealth(_mint: string, posId: number) {
      if (posId === 555) return h.state.liveAcctHealth;
      if (posId === 777) return h.state.liveBotHealth;
      return null;
    }
  },
}));

vi.mock("../../server/vault/borrow-oracle-freshness", () => ({
  readBorrowOracleContext: vi.fn(async () => ({ publishAgeSec: 30, priceMove1hAbs: 0.02 })),
}));

import { runPerbotUnwindClose, runPerbotCarveOpen } from "../../server/vault/jupiter-lend-perbot-carve";

const {
  opStore,
  state,
  updatePositionMock,
  executeBorrowCloseMock,
  executeSupplyCollateralMock,
  executeBorrowOpenMock,
  executeWithdrawCollateralMock,
  transferExactMock,
} = h;

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
  executeBorrowCloseMock.mockReset();
  executeSupplyCollateralMock.mockReset();
  executeBorrowOpenMock.mockReset();
  executeWithdrawCollateralMock.mockReset();
  transferExactMock.mockReset();
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
