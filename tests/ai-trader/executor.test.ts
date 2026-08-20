// WO-5 acceptance: unit tests for server/ai-trader/executor.ts — the execution
// layer. Storage, session-v3 crypto and notifications are mocked (decide.test.ts
// pattern); paper-math runs for real (pure). Covers: entry-shape refusals, G6
// cooldown/daily-cap enforcement on both paths, the paper fill (adverse
// slippage, no adapter/key access), the live happy path with binding step
// ordering (executing-status BEFORE order, bracket AFTER confirm, G10 verify),
// capability pre-flight, G15 pause, G11 funding abort, clean order rejection,
// unconfirmed-position emergency close, bracket-failure emergency close with
// honest executed+exit recording, and key/UMK cleanup on every exit path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import type { ClampedDecision } from "../../server/ai-trader/guardrails";
import { PAPER_SLIPPAGE_PER_LEG } from "../../server/ai-trader/paper-math";

const scannerCapabilitiesMock = {
  producerEnabled: true,
  consumersEnabled: true,
  liveExecutionEnabled: true,
};
vi.mock("../../server/ai-trader/scanner-capabilities", () => ({
  SCANNER_CAPABILITIES: scannerCapabilitiesMock,
}));

const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const updateBotMock = vi.fn();
const updateDecisionMock = vi.fn();
const getAiTraderBotMock = vi.fn();
const getAiTraderDecisionMock = vi.fn();
const claimExecutionMock = vi.fn();
const transitionStateMock = vi.fn();
const commitPaperEntryMock = vi.fn();
const commitDirectLiveEntryMock = vi.fn();
const commitRecoveryMock = vi.fn();
const isMarketAdmittedMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    updateAiTraderDecision: (...a: unknown[]) => updateDecisionMock(...a),
    getAiTraderBot: (...a: unknown[]) => getAiTraderBotMock(...a),
    getAiTraderDecision: (...a: unknown[]) => getAiTraderDecisionMock(...a),
    claimAiTraderExecution: (...a: unknown[]) => claimExecutionMock(...a),
    transitionAiTraderState: (...a: unknown[]) => transitionStateMock(...a),
    commitAiTraderPaperEntryTransition: (...a: unknown[]) => commitPaperEntryMock(...a),
    commitAiTraderDirectLiveEntryTransition: (...a: unknown[]) => commitDirectLiveEntryMock(...a),
    commitAiTraderRecoveryTransition: (...a: unknown[]) => commitRecoveryMock(...a),
  },
}));

vi.mock("../../server/ai-trader/market-admission", () => ({
  isAiTraderMarketAdmitted: (...a: unknown[]) => isMarketAdmittedMock(...a),
  SCANNER_MARKET_UNADMITTED_REASON: "scanner_market_unadmitted",
}));

const getUmkMock = vi.fn();
const decryptKeyMock = vi.fn();
const decryptSubKeyMock = vi.fn();
const verifyHmacMock = vi.fn();
const healUmkMock = vi.fn();
vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: (...a: unknown[]) => getUmkMock(...a),
  decryptAgentKeyStrict: (...a: unknown[]) => decryptKeyMock(...a),
  // WO-7.1: signing.ts resolves the bot's OWN subaccount key through this.
  decryptBotSubaccountKey: (...a: unknown[]) => decryptSubKeyMock(...a),
  verifyBotPolicyHmac: (...a: unknown[]) => verifyHmacMock(...a),
  healExecutionUmkFromStorage: (...a: unknown[]) => healUmkMock(...a),
}));

const notifyMock = vi.fn();
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: (...a: unknown[]) => notifyMock(...a),
}));

const appendRequiredJournalMock = vi.fn(async ({ decisionId }: { decisionId: string }) => `entry:${decisionId}`);
const appendJournalMock = vi.fn(async () => undefined);
const safeJournalMock = vi.fn();
vi.mock("../../server/ai-trader/execution-journal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-trader/execution-journal")>();
  return {
    ...actual,
    appendExecutionEvents: (...a: unknown[]) => appendJournalMock(...a),
    appendRequiredEntryPrebroadcast: (...a: unknown[]) => appendRequiredJournalMock(...a as [{ decisionId: string }]),
    safeAppendExecutionEvents: (...a: unknown[]) => safeJournalMock(...a),
  };
});

// --- Fixtures -----------------------------------------------------------------

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z — mid-day UTC

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1111-2222",
    walletAddress: "WALLET_X",
    protocol: "pacifica",
    // WO-7.1 live-funded bot: has its own venue subaccount + V3 sub-key material.
    // Live orders are signed AS this subaccount (adapter subaccountId stays undefined).
    protocolSubaccountId: "sub-1",
    botSubaccountKeyEncryptedV3: "v3-sub-ciphertext",
    derivationIndex: null,
    derivationPathVersion: null,
    market: "SOL-PERP",
    timeframe: "15m",
    mode: "auto",
    paperMode: true,
    stopPolicy: "static",
    allocatedUsdc: "1000",
    maxLeverage: 5,
    policyHmac: "hmac-abc",
    status: "analyzing",
    pauseReason: null,
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeClamped(overrides: Partial<ClampedDecision> = {}): ClampedDecision {
  return {
    action: "long",
    entryType: "market",
    leverage: 2,
    sizePct: 50,
    marginUsdc: 500,
    notionalUsdc: 1000,
    sizeBase: 6.66,
    stopLossPrice: 145,
    takeProfitPrice: 160,
    confidence: 7,
    invalidation: "loses 145 support",
    rationale: "uptrend continuation",
    ...overrides,
  };
}

function makePersistedDecision(overrides: Partial<AiTraderDecision> = {}): AiTraderDecision {
  return {
    id: "d-1",
    botId: "bot-1111-2222",
    contextDigest: {
      feeRateIdentity: {
        protocol: "pacifica",
        account: AGENT_PUBKEY,
        subaccountId: "sub-1",
        liquidityRole: "taker",
      },
      feeRateQuote: {
        availability: "available",
        protocol: "pacifica",
        account: AGENT_PUBKEY,
        subaccountId: "sub-1",
        liquidityRole: "taker",
        baseRate: 0.0012,
        effectiveRate: 0.0014,
        provenance: "pacifica:/account:taker_fee",
        observedAt: NOW,
        builder: { status: "included", code: "QuantumVault", rate: 0.0002, provenance: "pacifica:builder_actual" },
      },
    },
    decidedAt: new Date(NOW),
    ...overrides,
  } as unknown as AiTraderDecision;
}

/** Call-order recorder shared by the storage + adapter mocks in live tests. */
let callOrder: string[];

function makeAdapter(overrides: Record<string, unknown> = {}): ProtocolAdapter {
  return {
    getBalances: vi.fn(async () => {
      callOrder.push("getBalances");
      return { totalEquity: 1000, freeCollateral: 900, totalMarginUsed: 0, unrealizedPnl: 0 };
    }),
    setLeverage: vi.fn(async () => {
      callOrder.push("setLeverage");
    }),
    placeMarketOrder: vi.fn(async () => {
      callOrder.push("placeMarketOrder");
      return { success: true, status: "filled", fillPrice: 150.2, orderId: "o-1" };
    }),
    getPositions: vi.fn(async () => {
      callOrder.push("getPositions");
      return [
        { internalSymbol: "SOL-PERP", baseSize: 6.66, entryPrice: 150.21, markPrice: 150.2, unrealizedPnl: 0, leverage: 2 },
      ];
    }),
    setTpSl: vi.fn(async () => {
      callOrder.push("setTpSl");
      return { success: true, status: "acknowledged", appliedStopLossPrice: 145, appliedTakeProfitPrice: 160 };
    }),
    getOpenStopOrders: vi.fn(async () => {
      callOrder.push("getOpenStopOrders");
      return [{ order_id: "st-1", symbol: "SOL-PERP" }];
    }),
    closePosition: vi.fn(async () => {
      callOrder.push("closePosition");
      return { success: true, status: "filled", fillPrice: 150.0 };
    }),
    ...overrides,
  } as unknown as ProtocolAdapter;
}

const AGENT_PUBKEY = "AgEntPubKey1111111111111111111111111111111";
let cleanupUmk: ReturnType<typeof vi.fn>;
let cleanupKey: ReturnType<typeof vi.fn>;

function armLiveAuth() {
  getWalletMock.mockResolvedValue({
    address: "WALLET_X",
    agentPublicKey: AGENT_PUBKEY,
    agentPrivateKeyEncryptedV3: "v3-envelope",
    emergencyStopTriggered: false,
  });
  cleanupUmk = vi.fn();
  cleanupKey = vi.fn();
  getUmkMock.mockResolvedValue({ umk: Buffer.from("umk"), cleanup: cleanupUmk });
  verifyHmacMock.mockReturnValue(true);
  // Sub-key bot (default fixture) resolves its own subaccount signer; the legacy
  // main-agent-key path (protocolSubaccountId=null) resolves via decryptAgentKeyStrict.
  decryptSubKeyMock.mockResolvedValue({ secretKey: new Uint8Array([4, 5, 6]), cleanup: cleanupKey });
  decryptKeyMock.mockResolvedValue({ secretKey: new Uint8Array([1, 2, 3]), cleanup: cleanupKey });
}

async function importExecutor() {
  return await import("../../server/ai-trader/executor");
}

const closedAt = (msAgo: number): Pick<AiTraderDecision, "closedAt"> =>
  ({ closedAt: new Date(NOW - msAgo) }) as Pick<AiTraderDecision, "closedAt">;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  callOrder = [];
  scannerCapabilitiesMock.liveExecutionEnabled = true;
  for (const m of [getWalletMock, getRecentClosedMock, updateBotMock, updateDecisionMock, getAiTraderBotMock, getAiTraderDecisionMock, claimExecutionMock, transitionStateMock, commitPaperEntryMock, commitDirectLiveEntryMock, commitRecoveryMock, getUmkMock, decryptKeyMock, decryptSubKeyMock, verifyHmacMock, healUmkMock, notifyMock, appendRequiredJournalMock, safeJournalMock]) {
    m.mockReset();
  }
  appendRequiredJournalMock.mockImplementation(async ({ decisionId }: { decisionId: string }) => `entry:${decisionId}`);
  getRecentClosedMock.mockResolvedValue([]);
  getAiTraderDecisionMock.mockImplementation(async (id: string) => makePersistedDecision({ id }));
  getWalletMock.mockResolvedValue({
    address: "WALLET_X",
    agentPublicKey: AGENT_PUBKEY,
    agentPrivateKeyEncryptedV3: "v3-envelope",
    emergencyStopTriggered: false,
  });
  isMarketAdmittedMock.mockReturnValue(true);
  updateBotMock.mockResolvedValue({});
  updateDecisionMock.mockResolvedValue({});
  notifyMock.mockResolvedValue(true);
  healUmkMock.mockResolvedValue(undefined);
  // Fresh-read guard (executor.ts): default returns the bot fixture with idle/analyzing
  // status so all non-busy-guard tests proceed normally. Tests that exercise the
  // bot_busy or missing-row paths override this mock directly.
  getAiTraderBotMock.mockImplementation(async () => makeBot());
  claimExecutionMock.mockImplementation(async () => {
    callOrder.push("status:executing");
    return { bot: makeBot({ status: "executing" }), decision: { id: "d-1" } };
  });
  commitPaperEntryMock.mockResolvedValue({
    status: "applied",
    bot: makeBot({ status: "open" }),
    decision: makePersistedDecision({ outcome: "executed" }),
  });
  commitDirectLiveEntryMock.mockImplementation(async (params: any) => {
    const status = params.disposition === "open" ? "open"
      : params.disposition === "quarantined" ? "paused" : "idle";
    callOrder.push(`status:${status}`);
    return {
      status: "applied",
      bot: makeBot({ status, pauseReason: params.disposition === "quarantined" ? "position_unconfirmed" : null }),
      decision: makePersistedDecision({ outcome: params.disposition === "open" ? "executed"
        : params.disposition === "quarantined" ? "unconfirmed_landing" : "aborted_order" }),
    };
  });
  commitRecoveryMock.mockImplementation(async (params: any) => ({
    status: "applied",
    bot: makeBot({ status: "paused", pauseReason: params.pauseReason }),
    decisions: [makePersistedDecision({
      outcome: params.entryFillPrice === null ? "aborted_order" : "executed",
      entryPrice: params.entryFillPrice === null ? null : params.entryFillPrice.toFixed(8),
      exitPrice: params.closeSucceeded && params.closeFillPrice !== null ? params.closeFillPrice.toFixed(8) : null,
      exitReason: params.entryFillPrice === null ? null : params.pauseReason,
      realizedPnl: null,
      feesPaid: null,
      closedAt: params.closeSucceeded ? params.closedAt : null,
    })],
    journal: { status: "appended", failureCode: null },
  }));
  transitionStateMock.mockImplementation(async (params: any) => {
    callOrder.push(`status:${params.nextStatus}`);
    return makeBot({ status: params.nextStatus, pauseReason: params.nextPauseReason });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Entry-shape refusals -------------------------------------------------------

describe("executeDecision — entry-shape refusals", () => {
  it("refuses scanner-source live entry at the final executor seam while paper remains available", async () => {
    scannerCapabilitiesMock.liveExecutionEnabled = false;
    const { executeDecision } = await importExecutor();
    const adapter = makeAdapter();

    const live = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false, marketSource: "scanner" }),
      decisionId: "d-live",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(live).toMatchObject({ ok: false, reason: "scanner_live_execution_disabled" });
    expect(getAiTraderBotMock).not.toHaveBeenCalled();
    expect(getWalletMock).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();

    const paper = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: true, marketSource: "scanner" }),
      decisionId: "d-paper",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(paper).toMatchObject({ ok: true, mode: "paper" });
  });

  it("refuses non-entry actions (close/flat) without touching storage writes", async () => {
    const { executeDecision } = await importExecutor();
    for (const action of ["close", "flat"] as const) {
      const r = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot(),
        decisionId: "d-1",
        clamped: makeClamped({ action }),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "not_entry" });
    }
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("refuses to stack an entry on a bot that holds (or may hold) a position", async () => {
    const { executeDecision } = await importExecutor();
    for (const status of ["open", "executing", "proposed"] as const) {
      const adapter = makeAdapter();
      getAiTraderBotMock.mockResolvedValueOnce(makeBot({ status }));
      const r = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot({ status, paperMode: false }),
        decisionId: "d-1",
        clamped: makeClamped(),
        adapter,
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "bot_busy" });
      expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    }
    // idle/analyzing bots proceed past the guard (paper bot hits G6 next, which passes).
    const ok = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ status: "idle", paperMode: true }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(ok).toMatchObject({ ok: true, mode: "paper" });
  });

  it("fresh-read guard fires on busy FRESH DB row even when caller snapshot says 'analyzing'", async () => {
    // Pins the write-after-snapshot race: scanner legitimately forces status →
    // 'analyzing' on its snapshot before calling executeDecision, but a concurrent
    // or crashed pass may have already flipped the DB row to 'open'/'executing'/
    // 'proposed'. The fresh re-read at executor.ts:178 must catch this.
    const { executeDecision } = await importExecutor();
    for (const freshStatus of ["open", "executing", "proposed"] as const) {
      getAiTraderBotMock.mockResolvedValueOnce(makeBot({ status: freshStatus }));
      const r = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot({ status: "analyzing", paperMode: false }),
        decisionId: "d-fresh",
        clamped: makeClamped(),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "bot_busy" });
    }
  });

  it("legacy callers that omit authoritySource fail closed instead of inheriting an internal claim", async () => {
    const { executeDecision } = await importExecutor();
    getAiTraderBotMock.mockResolvedValueOnce(makeBot({ status: "analyzing", paperMode: true }));
    const result = await executeDecision({
      bot: makeBot({ status: "analyzing", paperMode: true }),
      decisionId: "d-legacy",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect(claimExecutionMock).not.toHaveBeenCalled();
  });

  it("refuses an unadmitted scanner-source market before G6, paper fill, or venue work", async () => {
    isMarketAdmittedMock.mockReturnValue(false);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ marketSource: "scanner", market: "UNKNOWN-PERP", paperMode: false }),
      decisionId: "d-scanner-unadmitted",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(r).toMatchObject({ ok: false, reason: "scanner_market_unadmitted" });
    expect(isMarketAdmittedMock).toHaveBeenCalledWith("UNKNOWN-PERP");
    expect(getRecentClosedMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect((adapter.setLeverage as any)).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222",
      expectedStatus: "analyzing",
      nextStatus: "idle",
      decisionId: "d-scanner-unadmitted",
      decisionOutcome: "aborted_guard",
    }));
  });

  it("refuses a ClampedDecision with missing/invalid numeric fields", async () => {
    const { executeDecision } = await importExecutor();
    const bad: Partial<ClampedDecision>[] = [
      { sizeBase: undefined },
      { sizeBase: 0 },
      { marginUsdc: NaN },
      { leverage: 0 },
      { stopLossPrice: undefined },
      { takeProfitPrice: -1 },
    ];
    for (const overrides of bad) {
      const r = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot(),
        decisionId: "d-1",
        clamped: makeClamped(overrides),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "invalid_clamp" });
    }
  });
});

describe("executeDecision — retained fee-rate admission authority", () => {
  it.each([
    ["missing decision", () => getAiTraderDecisionMock.mockResolvedValueOnce(undefined)],
    ["pre-change missing quote", () => getAiTraderDecisionMock.mockResolvedValueOnce(makePersistedDecision({ contextDigest: {} }))],
    ["stale quote", () => {
      const row = makePersistedDecision();
      (row.contextDigest as any).feeRateQuote.observedAt = NOW - 10 * 60_000 - 1;
      getAiTraderDecisionMock.mockResolvedValueOnce(row);
    }],
    ["protocol mismatch", () => {
      const row = makePersistedDecision();
      (row.contextDigest as any).feeRateIdentity.protocol = "drift";
      getAiTraderDecisionMock.mockResolvedValueOnce(row);
    }],
    ["account mismatch", () => {
      const row = makePersistedDecision();
      (row.contextDigest as any).feeRateIdentity.account = "OTHER_ACCOUNT";
      getAiTraderDecisionMock.mockResolvedValueOnce(row);
    }],
    ["subaccount mismatch", () => {
      const row = makePersistedDecision();
      (row.contextDigest as any).feeRateIdentity.subaccountId = "other-sub";
      getAiTraderDecisionMock.mockResolvedValueOnce(row);
    }],
  ])("refuses %s before paper claim or venue mutation", async (_label, arrange) => {
    arrange();
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();

    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot(),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: false, reason: "fee_rate_unavailable" });
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalledWith("d-1", expect.objectContaining({ outcome: "executed" }));
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("validates the durable quote without requiring a caller-supplied input field", async () => {
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot(),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: true, mode: "paper" });
    expect(getAiTraderDecisionMock).toHaveBeenCalledWith("d-1");
  });

  it("refuses live admission if the execution account changes after quote validation", async () => {
    getWalletMock
      .mockResolvedValueOnce({
        address: "WALLET_X",
        agentPublicKey: AGENT_PUBKEY,
        agentPrivateKeyEncryptedV3: "v3-envelope",
        emergencyStopTriggered: false,
      })
      .mockResolvedValueOnce({
        address: "WALLET_X",
        agentPublicKey: "DIFFERENT_ACCOUNT",
        agentPrivateKeyEncryptedV3: "v3-envelope",
        emergencyStopTriggered: false,
      });
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();

    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: false, reason: "fee_rate_unavailable" });
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("refuses a live decision with a non-finite decidedAt before claiming execution", async () => {
    getAiTraderDecisionMock.mockResolvedValueOnce(makePersistedDecision({ id: "d-invalid-time", decidedAt: new Date(Number.NaN) }));
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-invalid-time",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect((result as any).detail).toContain("decidedAt");
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
});

// --- G6 -------------------------------------------------------------------------

describe("G6 — cooldown and daily caps (checkCooldownAndCaps + executeDecision wiring)", () => {
  it("pure: cooldown fires when the last close is younger than one candle", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    // 15m candle = 900s. Closed 5 min ago → cooldown.
    expect(checkCooldownAndCaps("15m", [closedAt(5 * 60_000)], NOW)).toMatchObject({
      ok: false,
      reason: "cooldown_active",
    });
    // Closed exactly one candle ago → clear.
    expect(checkCooldownAndCaps("15m", [closedAt(900_000)], NOW)).toEqual({ ok: true });
  });

  it("pure: LTF cap 6/day, HTF cap 2/day, counted from UTC midnight", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    // 6 closes earlier today (oldest far enough back to clear cooldown).
    const sixToday = [3, 4, 5, 6, 7, 8].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("15m", sixToday, NOW)).toMatchObject({ ok: false, reason: "daily_cap_reached" });
    // 5 today → allowed.
    expect(checkCooldownAndCaps("15m", sixToday.slice(1), NOW)).toEqual({ ok: true });
    // HTF: 2 closes today trips the cap even on 4h…
    const twoToday = [5, 9].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("4h", twoToday, NOW)).toMatchObject({ ok: false, reason: "daily_cap_reached" });
    // …but the same 2 closes YESTERDAY don't count (NOW is 12:00 UTC; 13h+ ago is pre-midnight).
    const twoYesterday = [13, 20].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("4h", twoYesterday, NOW)).toEqual({ ok: true });
  });

  it("pure: unknown timeframe fails CLOSED", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    expect(checkCooldownAndCaps("3m", [], NOW)).toMatchObject({ ok: false, reason: "cooldown_active" });
  });

  it("G6 is enforced on the PAPER path too (paper feeds graduation stats)", async () => {
    getRecentClosedMock.mockResolvedValue([closedAt(60_000)]);
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: true }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "cooldown_active" });
    expect(getRecentClosedMock).toHaveBeenCalledWith("bot-1111-2222", 30);
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Paper path -------------------------------------------------------------------

describe("paper execution", () => {
  it("long paper entry atomically commits decision, bot, and exact journal tuple with NO adapter or key access", async () => {
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: true }),
      decisionId: "d-paper",
      clamped: makeClamped({ action: "long" }),
      adapter,
      markPrice: 150,
    });
    const expectedEntry = 150 * (1 + PAPER_SLIPPAGE_PER_LEG);
    expect(r).toEqual({ ok: true, mode: "paper", entryPrice: expectedEntry });
    expect(commitPaperEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222",
      decisionId: "d-paper",
      entryPrice: expectedEntry,
      sizeBase: 6.66,
      side: "long",
      observedAt: new Date(NOW),
    }));
    const committed = commitPaperEntryMock.mock.calls[0][0];
    expect(committed.journalEvents.map((event: any) => event.eventType)).toEqual([
      "attempt_claimed", "fill_observed", "entry_terminal_open",
    ]);
    expect(committed.journalEvents.every((event: any) =>
      event.attemptId === "entry:d-paper"
      && event.cause === "paper"
      && event.observedAt.getTime() === NOW)).toBe(true);
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(transitionStateMock).not.toHaveBeenCalled();
    expect(safeJournalMock).not.toHaveBeenCalled();
    // Paper reads the wallet identity only to bind the retained quote; it must
    // never touch the venue or unwrap key material.
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect((adapter.setTpSl as any)).not.toHaveBeenCalled();
    expect(getWalletMock).toHaveBeenCalledWith("WALLET_X");
    expect(getUmkMock).not.toHaveBeenCalled();
    expect(verifyHmacMock).not.toHaveBeenCalled();
  });

  it("short paper entry slips DOWN (adverse for a seller)", async () => {
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: true }),
      decisionId: "d-paper-s",
      clamped: makeClamped({ action: "short", stopLossPrice: 155, takeProfitPrice: 140 }),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "paper", entryPrice: 150 * (1 - PAPER_SLIPPAGE_PER_LEG) });
  });

  it("maps atomic paper-entry conflicts to the existing fail-closed executor results", async () => {
    const { executeDecision } = await importExecutor();
    for (const [reason, expected] of [
      ["decision_state_conflict", "bot_busy"],
      ["bot_state_conflict", "bot_busy"],
      ["journal_state_conflict", "journal_unavailable"],
    ] as const) {
      commitPaperEntryMock.mockResolvedValueOnce({ status: "conflict", reason });
      const result = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot({ paperMode: true }),
        decisionId: `d-paper-${reason}`,
        clamped: makeClamped({ action: "long" }),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(result).toMatchObject({ ok: false, reason: expected });
      expect(notifyMock).not.toHaveBeenCalled();
    }
  });

  it("refuses a paper entry without a usable mark price", async () => {
    const { executeDecision } = await importExecutor();
    for (const mark of [0, NaN, -1]) {
      const r = await executeDecision({
        authoritySource: "internal_cycle",
        bot: makeBot({ paperMode: true }),
        decisionId: "d-paper",
        clamped: makeClamped(),
        adapter: makeAdapter(),
        markPrice: mark,
      });
      expect(r).toMatchObject({ ok: false, reason: "invalid_mark" });
    }
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Live path: pre-flight refusals ------------------------------------------------

describe("live execution — pre-flight", () => {
  it("capability pre-flight: adapter without setTpSl/getOpenStopOrders refuses BEFORE any order or key access", async () => {
    const adapter = makeAdapter({ setTpSl: undefined });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false, protocol: "flash" }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "capability_missing" });
    expect(getWalletMock).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
  });

  it("fee authority fails closed when the wallet no longer exposes the bound venue account", async () => {
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: null, agentPrivateKeyEncryptedV3: null });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "fee_rate_unavailable" });
  });

  it("auth_unavailable when execution authorization (UMK) is off", async () => {
    getWalletMock.mockResolvedValue({
      address: "WALLET_X",
      agentPublicKey: AGENT_PUBKEY,
      agentPrivateKeyEncryptedV3: "v3-envelope",
      emergencyStopTriggered: false,
    });
    getUmkMock.mockResolvedValue(null);
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
  });

  it("G15: policy HMAC mismatch pauses the bot, records aborted_policy, notifies, sends NOTHING", async () => {
    armLiveAuth();
    verifyHmacMock.mockReturnValue(false);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "policy_hmac_mismatch" });
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222", expectedStatus: "analyzing", expectedPauseReason: null,
      nextStatus: "paused", nextPauseReason: "policy_hmac_mismatch",
      decisionId: "d-1", expectedDecisionOutcome: null, decisionOutcome: "aborted_policy",
    }));
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
    expect((adapter.setLeverage as any)).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    // Policy object single-sources from the bot row.
    expect(verifyHmacMock).toHaveBeenCalledWith(
      expect.anything(),
      { market: "SOL-PERP", leverage: 5, maxPositionSize: "1000" },
      "hmac-abc"
    );
    expect(cleanupUmk).toHaveBeenCalled();
  });

  it("G15: lost pre-claim decision/status predicate returns bot_busy without notification or venue mutation", async () => {
    armLiveAuth();
    verifyHmacMock.mockReturnValue(false);
    transitionStateMock.mockResolvedValue(undefined);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-g15-race",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect(notifyMock).not.toHaveBeenCalled();
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("G11: insufficient free collateral records aborted_funding and returns the bot to idle", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      getBalances: vi.fn(async () => ({ totalEquity: 100, freeCollateral: 499.99, totalMarginUsed: 0, unrealizedPnl: 0 })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped({ marginUsdc: 500 }),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_funding" });
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222", expectedStatus: "analyzing", expectedPauseReason: null,
      nextStatus: "idle", nextPauseReason: null,
      decisionId: "d-1", expectedDecisionOutcome: null, decisionOutcome: "aborted_funding",
    }));
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });
});

// --- Live path: happy path ---------------------------------------------------------

describe("live execution — happy path", () => {
  it("full flow in binding order; decision executed with venue fill price; bot open; keys cleaned up", async () => {
    armLiveAuth();
    updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
      callOrder.push(`updateBot:${updates.status}`);
      return {};
    });
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-live",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "live", entryPrice: 150.2 });

    // Binding WO-5 ordering: crash marker BEFORE leverage/order; bracket AFTER
    // position confirm; G10 verification last.
    expect(callOrder).toEqual([
      "getBalances",
      "status:executing",
      "setLeverage",
      "placeMarketOrder",
      "getPositions",
      "setTpSl",
      "getOpenStopOrders",
      "status:open",
    ]);

    // WO-7.1 signing model: the signed account IS the bot's own subaccount pubkey
    // (Phase 4b), and the unsigned adapter `subaccountId` param stays undefined.
    expect((adapter.placeMarketOrder as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPublicKey: "sub-1",
        mainWalletAddress: "WALLET_X",
        internalSymbol: "SOL-PERP",
        side: "long",
        sizeBase: 6.66,
        clientOrderId: "aitrader-d-live",
        subaccountId: undefined,
        maxSlippagePct: 0.5,
        leverage: 2,
        builderAttachment: { mode: "attach", code: "QuantumVault" },
      })
    );
    expect((adapter.setTpSl as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        stopLossPrice: 145,
        takeProfitPrice: 160,
        subaccountId: undefined,
        builderAttachment: { mode: "attach", code: "QuantumVault" },
      })
    );
    // The sub key signed — the main agent key was never decrypted.
    expect(decryptSubKeyMock).toHaveBeenCalled();
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(commitDirectLiveEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222", decisionId: "d-live", disposition: "open",
      entryPrice: 150.2, sizeBase: 6.66, observedAt: new Date(NOW),
    }));
    const committed = commitDirectLiveEntryMock.mock.calls[0][0];
    expect(committed.journalEvents.map((event: any) => event.eventType)).toEqual([
      "broadcast_result", "position_observed", "fill_observed", "bracket_verified", "entry_terminal_open",
    ]);
    expect(committed.journalEvents.every((event: any) => event.observedAt.getTime() === NOW)).toBe(true);
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_executed", side: "LONG" }));
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("falls back to the confirmed position's entryPrice when the order result has no fill price", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: true, status: "acknowledged" as const })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-live",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "live", entryPrice: 150.21 });
  });
});

// --- Live path: failure handling ----------------------------------------------------

describe("live execution — failure handling (fail closed)", () => {
  it("journal failure refuses live entry before placeMarketOrder", async () => {
    armLiveAuth();
    appendRequiredJournalMock.mockRejectedValueOnce(new Error("journal unavailable"));
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-journal-refuse",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: false, reason: "journal_unavailable" });
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect(transitionStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedStatus: "executing", nextStatus: "idle", decisionId: "d-journal-refuse",
      expectedDecisionOutcome: null, decisionOutcome: "aborted_order",
    }));
  });

  it("journal refusal with a lost executing predicate returns bot_busy and never sends the order", async () => {
    armLiveAuth();
    appendRequiredJournalMock.mockRejectedValueOnce(new Error("journal unavailable"));
    transitionStateMock.mockResolvedValue(undefined);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-journal-race",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("post-broadcast journal failure does not delay position confirmation or bracket protection", async () => {
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-journal-best-effort",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect((adapter.getPositions as any)).toHaveBeenCalled();
    expect((adapter.setTpSl as any)).toHaveBeenCalled();
    expect((adapter.getOpenStopOrders as any)).toHaveBeenCalled();
    expect(commitDirectLiveEntryMock).toHaveBeenLastCalledWith(expect.objectContaining({ disposition: "open" }));
  });

  it("post-broadcast open transition conflict leaves the executing marker and emits one protected-position alert", async () => {
    armLiveAuth();
    commitDirectLiveEntryMock.mockResolvedValueOnce({ status: "conflict", reason: "journal_state_conflict" });
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-open-conflict",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((result as any).detail).toContain("journal_state_conflict");
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({
      type: "trade_failed",
      error: expect.stringContaining("bracket-protected"),
    }));
  });

  it("emergency close reaches closePosition when every journal append fails", async () => {
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "wrong side" })),
    });
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-journal-emergency",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((adapter.closePosition as any)).toHaveBeenCalledTimes(1);
    const recovery = commitRecoveryMock.mock.calls.at(-1)![0];
    expect(recovery).toMatchObject({ disposition: "emergency_unwind", decisionId: "d-journal-emergency" });
    expect(recovery.journalBatches.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: "entry:d-journal-emergency", action: "entry",
        eventType: "entry_terminal_unwound", failureCode: "bracket_failed" }),
    ]));
  });

  it("persists completed emergency-close evidence outside a conflicted state transition", async () => {
    armLiveAuth();
    commitRecoveryMock.mockResolvedValueOnce({ status: "conflict", reason: "bot_state_conflict" });
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "wrong side" })),
    });
    const { executeDecision } = await importExecutor();

    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-conflicted-unwind",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(result).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect(adapter.closePosition).toHaveBeenCalledTimes(1);
    expect(appendJournalMock).toHaveBeenCalledTimes(2);
    expect(appendJournalMock.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "close", eventType: "close_terminal_confirmed" }),
    ]));
    expect(appendJournalMock.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ action: "entry", eventType: "entry_terminal_unwound" }),
    ]);
    expect(appendJournalMock.mock.invocationCallOrder[1]).toBeLessThan(notifyMock.mock.invocationCallOrder[0]);
  });

  it("clean order rejection (confirmed flat) → aborted_order, bot idle, NO pause, NO close", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "px band" })),
      getPositions: vi.fn(async () => []),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "order_failed" });
    expect(commitDirectLiveEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "no_land", observedAt: new Date(NOW),
    }));
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("confirmed-flat no-land transition conflict remains fail-closed with one alert", async () => {
    armLiveAuth();
    commitDirectLiveEntryMock.mockResolvedValueOnce({ status: "conflict", reason: "decision_state_conflict" });
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "px band" })),
      getPositions: vi.fn(async () => []),
    });
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-no-land-conflict",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect(adapter.closePosition).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("setLeverage throw → STRUCTURED clean abort (aborted_order, idle), never a raw throw stranding 'executing'", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setLeverage: vi.fn(async () => {
        throw new Error("venue 500");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "order_failed" });
    expect((r as any).detail).toContain("setLeverage failed before any order was sent");
    expect(transitionStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedStatus: "executing", nextStatus: "idle", decisionId: "d-1",
      expectedDecisionOutcome: null, decisionOutcome: "aborted_order",
    }));
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("UNCONFIRMED-LANDING verdict → QUARANTINE (no close, no probe): persist unconfirmed_landing + pause for reconciliation", async () => {
    // Flash landing-verification timeout: the tx was BROADCAST and may still
    // land inside the blockhash window (~60–90s). A flat probe at ~30s is NOT
    // proof of a clean abort, and an emergency close against a flat venue is a
    // NO-OP — if the entry lands right after it, the bot is paused with a
    // NAKED position nobody monitors. Correct behavior: touch NOTHING on the
    // venue, persist the honest 'unconfirmed_landing' state, pause, and let
    // the monitor's reconciler settle it against reality.
    armLiveAuth();
    const { UNCONFIRMED_LANDING_VERDICT_TOKEN } = await import("../../server/protocol/tx-verdicts");
    const getPositionsMock = vi.fn(async () => []); // flat — and must NOT be consulted
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({
        success: false,
        status: "rejected" as const,
        error: `open transaction did not confirm on-chain within the verification window (sig 5Kt429xyz). Not booked as filled. ${UNCONFIRMED_LANDING_VERDICT_TOKEN}`,
      })),
      getPositions: getPositionsMock,
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((r as any).detail).toContain("may still land");
    expect((r as any).detail).toContain("unconfirmed_landing");
    // The clean-abort flat probe must be SKIPPED — not run-and-ignored.
    expect(getPositionsMock).not.toHaveBeenCalled();
    // NO venue write of any kind: a close against a flat venue is a no-op that
    // manufactures the naked-position window.
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(commitDirectLiveEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-1111-2222", decisionId: "d-1", disposition: "quarantined",
      observedAt: new Date(NOW),
      journalEvents: [expect.objectContaining({ eventType: "broadcast_result", failureCode: "venue_unconfirmed" })],
    }));
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    // Exactly ONE notification.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("atomic quarantine conflict leaves executing, touches no venue, and emits exactly one failure alert", async () => {
    armLiveAuth();
    const { UNCONFIRMED_LANDING_VERDICT_TOKEN } = await import("../../server/protocol/tx-verdicts");
    const getPositionsMock = vi.fn(async () => []);
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({
        success: false,
        status: "rejected" as const,
        error: `open transaction did not confirm on-chain within the verification window (sig 5Kt429xyz). Not booked as filled. ${UNCONFIRMED_LANDING_VERDICT_TOKEN}`,
      })),
      getPositions: getPositionsMock,
    });
    commitDirectLiveEntryMock.mockResolvedValueOnce({ status: "conflict", reason: "bot_state_conflict" });
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((result as any).detail).toContain("bot_state_conflict");
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(getPositionsMock).not.toHaveBeenCalled();
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("setLeverage failure with a lost executing predicate returns bot_busy without sending an order", async () => {
    armLiveAuth();
    transitionStateMock.mockResolvedValue(undefined);
    const adapter = makeAdapter({ setLeverage: vi.fn(async () => { throw new Error("venue 500"); }) });
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-leverage-race",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("G11: lost pre-claim decision/status predicate returns bot_busy without venue mutation", async () => {
    armLiveAuth();
    transitionStateMock.mockResolvedValue(undefined);
    const adapter = makeAdapter({
      getBalances: vi.fn(async () => ({ totalEquity: 100, freeCollateral: 1, totalMarginUsed: 0, unrealizedPnl: 0 })),
    });
    const { executeDecision } = await importExecutor();
    const result = await executeDecision({
      authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-g11-race",
      clamped: makeClamped({ marginUsdc: 500 }),
      adapter,
      markPrice: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "bot_busy" });
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(adapter.setLeverage).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("atomic quarantine storage error leaves executing, touches no venue, and emits exactly one failure alert", async () => {
    armLiveAuth();
    const { UNCONFIRMED_LANDING_VERDICT_TOKEN } = await import("../../server/protocol/tx-verdicts");
    const getPositionsMock = vi.fn(async () => []);
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({
        success: false,
        status: "rejected" as const,
        error: `open transaction did not confirm on-chain within the verification window (sig 5Kt429xyz). Not booked as filled. ${UNCONFIRMED_LANDING_VERDICT_TOKEN}`,
      })),
      getPositions: getPositionsMock,
    });
    commitDirectLiveEntryMock.mockRejectedValueOnce(new Error("db blip"));
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((r as any).detail).toContain("db blip");
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(getPositionsMock).not.toHaveBeenCalled();
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("order rejection with UNPROVABLE flat state → emergency close + pause (fail closed)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "timeout" })),
      getPositions: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(commitRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "emergency_unwind", botId: "bot-1111-2222", pauseReason: "position_unconfirmed",
    }));
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
  });

  it("position never appears after a successful order → retries 3×/2s, then emergency close + pause", async () => {
    armLiveAuth();
    const getPositionsMock = vi.fn(async () => []);
    const adapter = makeAdapter({ getPositions: getPositionsMock });
    const { executeDecision } = await importExecutor();
    const promise = executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect(getPositionsMock).toHaveBeenCalledTimes(3);
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(commitRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "emergency_unwind", botId: "bot-1111-2222", decisionId: "d-1",
      pauseReason: "position_unconfirmed", entryFillPrice: 150.2,
    }));
  });

  it("setTpSl failure → position closed at market, bot paused bracket_failed, decision executed with exit", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "wrong side" })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    const recovery = commitRecoveryMock.mock.calls.at(-1)![0];
    expect(recovery).toMatchObject({
      disposition: "emergency_unwind", botId: "bot-1111-2222", decisionId: "d-1",
      pauseReason: "bracket_failed", entryFillPrice: 150.2, closeSucceeded: true,
      closeFillPrice: 150,
    });
    expect(recovery).not.toHaveProperty("realizedPnl");
    expect(recovery).not.toHaveProperty("feesPaid");
    expect(recovery.journalBatches[0].every((event: any) => event.attemptId === recovery.closeAttemptId)).toBe(true);
    expect(recovery.journalBatches[1]).toEqual([
      expect.objectContaining({ attemptId: "entry:d-1", eventType: "entry_terminal_unwound" }),
    ]);
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
    expect(commitRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(notifyMock.mock.invocationCallOrder[0]);
  });

  it("does not record an emergency close when the venue only acknowledges it", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "wrong side" })),
      closePosition: vi.fn(async () => ({
        success: true,
        status: "acknowledged" as const,
        fillPrice: 150,
      })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });

    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((r as any).detail).toContain("EMERGENCY CLOSE FAILED");
    const recovery = commitRecoveryMock.mock.calls.at(-1)![0];
    expect(recovery).toMatchObject({ disposition: "emergency_unwind", decisionId: "d-1",
      entryFillPrice: 150.2, pauseReason: "bracket_failed", closeSucceeded: false });
    expect(notifyMock).toHaveBeenCalledWith(
      "WALLET_X",
      expect.objectContaining({ error: expect.stringContaining("AUTOMATIC CLOSE FAILED") })
    );
  });

  it("setTpSl 'success' that DROPPED the SL leg is a bracket failure (naked-position guard)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({
        success: true,
        status: "acknowledged" as const,
        droppedLegs: [{ leg: "sl" as const, reason: "wrong side of mark" }],
      })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
  });

  it("a dropped TP leg alone is survivable (position stays stop-protected)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({
        success: true,
        status: "acknowledged" as const,
        droppedLegs: [{ leg: "tp" as const, reason: "wrong side of mark" }],
      })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
  });

  it("G10: bracket acknowledged but never visible on the venue → retries, then close + pause", async () => {
    armLiveAuth();
    const stopsMock = vi.fn(async () => []);
    const adapter = makeAdapter({ getOpenStopOrders: stopsMock });
    const { executeDecision } = await importExecutor();
    const promise = executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect(stopsMock).toHaveBeenCalledTimes(3);
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(commitRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "emergency_unwind", botId: "bot-1111-2222", pauseReason: "bracket_failed",
    }));
  });

  it("emergency close FAILURE never masks the original failure and screams in the notification", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "boom" })),
      closePosition: vi.fn(async () => {
        throw new Error("close also failed");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((r as any).detail).toContain("EMERGENCY CLOSE FAILED");
    const recovery = commitRecoveryMock.mock.calls.at(-1)![0];
    expect(recovery).toMatchObject({
      disposition: "emergency_unwind",
      botId: "bot-1111-2222",
      decisionId: "d-1",
      entryFillPrice: 150.2,
      closeSucceeded: false,
      pauseReason: "bracket_failed",
    });
    expect(notifyMock).toHaveBeenCalledWith(
      "WALLET_X",
      expect.objectContaining({ error: expect.stringContaining("AUTOMATIC CLOSE FAILED") })
    );
    // Entry recorded without a fabricated exit (close never filled).
    expect(recovery.closeFillPrice).toBeNull();
    expect(recovery).not.toHaveProperty("realizedPnl");
    expect(recovery).not.toHaveProperty("feesPaid");
  });

  it("sub-key decrypt failure heals the execution UMK once and retries; both cleanups still run", async () => {
    armLiveAuth();
    decryptSubKeyMock
      .mockResolvedValueOnce(null) // first attempt fails
      .mockResolvedValueOnce({ secretKey: new Uint8Array([9]), cleanup: cleanupKey });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
    expect(healUmkMock).toHaveBeenCalledWith("WALLET_X");
    expect(getUmkMock).toHaveBeenCalledTimes(2);
    expect(cleanupUmk).toHaveBeenCalled(); // first UMK cleaned before re-fetch
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("sub-key heal + retry both failing → auth_unavailable, NEVER downgrades to the main agent key", async () => {
    armLiveAuth();
    decryptSubKeyMock.mockResolvedValue(null);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    // Money-safety invariant: a subaccount bot must NEVER fall back to signing
    // with the main agent key (that would trade the user's main account).
    expect(decryptKeyMock).not.toHaveBeenCalled();
  });

  it("bot with a subaccount but NO key material refuses to sign (fail closed)", async () => {
    armLiveAuth();
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false, botSubaccountKeyEncryptedV3: null, derivationIndex: null, derivationPathVersion: null }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
  });

  it("legacy founder-canary bot (no subaccount) still signs with the main agent key", async () => {
    armLiveAuth();
    const legacyDecision = makePersistedDecision();
    (legacyDecision.contextDigest as any).feeRateIdentity.subaccountId = null;
    (legacyDecision.contextDigest as any).feeRateQuote.subaccountId = null;
    getAiTraderDecisionMock.mockResolvedValueOnce(legacyDecision);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
        authoritySource: "internal_cycle",
      bot: makeBot({ paperMode: false, protocolSubaccountId: null, botSubaccountKeyEncryptedV3: null }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
    expect(decryptKeyMock).toHaveBeenCalled();
    expect(decryptSubKeyMock).not.toHaveBeenCalled();
    // Legacy path signs for and reads the MAIN agent account.
    expect((adapter.placeMarketOrder as any)).toHaveBeenCalledWith(
      expect.objectContaining({ agentPublicKey: AGENT_PUBKEY, subaccountId: undefined })
    );
  });
});

// --- Policy-object helper ------------------------------------------------------------

describe("aiTraderPolicyObject (G15 single source for WO-7 creation + executor verify)", () => {
  it("maps market / maxLeverage / allocatedUsdc exactly", async () => {
    const { aiTraderPolicyObject } = await importExecutor();
    expect(aiTraderPolicyObject(makeBot())).toEqual({
      market: "SOL-PERP",
      leverage: 5,
      maxPositionSize: "1000",
    });
  });
});

// --- risk-based-sizing-spec Phase A: slippage-constant sync pin ------------------------

describe("risk-based sizing — slippage constant sync pin", () => {
  it("guardrails' MAX_ENTRY_SLIPPAGE_FRAC mirrors the executor's ENTRY_MAX_SLIPPAGE_PCT exactly", async () => {
    // guardrails.ts is a PURE module (no imports), so it carries a mirror of the
    // executor's entry-slippage bound. The risk_based stop floor is derived from
    // it (RISK_STOP_MIN_SLIPPAGE_MULT × slippage); if the executor bound ever
    // changes without the mirror, this pin fails the build.
    const { ENTRY_MAX_SLIPPAGE_PCT } = await importExecutor();
    const { MAX_ENTRY_SLIPPAGE_FRAC } = await import("../../server/ai-trader/guardrails");
    expect(MAX_ENTRY_SLIPPAGE_FRAC).toBe(ENTRY_MAX_SLIPPAGE_PCT / 100);
  });
});
