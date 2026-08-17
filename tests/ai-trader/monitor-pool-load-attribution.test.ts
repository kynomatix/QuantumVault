import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getActiveBotsMock = vi.fn();
const getBotMock = vi.fn();
const compressDecisionsMock = vi.fn();

vi.mock("../../server/storage", () => ({
  storage: {
    getActiveAiTraderBots: (...args: unknown[]) => getActiveBotsMock(...args),
    getAiTraderBot: (...args: unknown[]) => getBotMock(...args),
    compressOldAiTraderDecisions: (...args: unknown[]) => compressDecisionsMock(...args),
  },
}));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));
vi.mock("../../server/protocol/adapter-registry", () => ({ getAdapter: vi.fn() }));
vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  healExecutionUmkFromStorage: vi.fn(),
  getSessionByWalletAddress: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn(),
  decryptLlmApiKeyV3: vi.fn(),
  computeBotPolicyHmac: vi.fn(),
}));
vi.mock("../../server/ai-trader/reflection-service", () => ({ fireReflection: vi.fn() }));
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: vi.fn(),
  getCloseReasonLabel: vi.fn(),
}));
vi.mock("../../server/ai-trader/signing", () => ({
  resolveAiTraderSubaccountSigner: vi.fn(),
  liveReadAccount: vi.fn(),
}));
vi.mock("../../server/ai-trader/paper-math", () => ({
  evaluatePaperBracket: vi.fn(),
  paperRealizedPnl: vi.fn(),
  paperExitPrice: vi.fn(),
}));
vi.mock("../../server/ai-trader/breakeven", () => ({
  BREAKEVEN_TRIGGER_PROGRESS: 0.5,
  BREAKEVEN_MAX_MOVE_ATTEMPTS: 1,
  parseBreakevenProtect: vi.fn(),
  favorableExtreme: vi.fn(),
  progressTowardTp: vi.fn(),
  breakevenStopPrice: vi.fn(),
  isFavorableSideOf: vi.fn(),
  isTighterStop: vi.fn(),
  evaluatePaperBracketWithMove: vi.fn(),
  countsAsSlLoss: vi.fn(),
}));
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: vi.fn(),
  isCacheDegradedError: vi.fn(() => false),
}));
vi.mock("../../server/ai-trader/context-builder", () => ({
  buildMarketContext: vi.fn(),
  marketToDatafeedTicker: vi.fn(),
}));
vi.mock("../../server/ai-trader/decide", () => ({ runDecision: vi.fn() }));
vi.mock("../../server/ai-assistant/models-catalog", () => ({ isSelectableModel: vi.fn() }));
vi.mock("../../server/ai-trader/executor", () => ({
  executeDecision: vi.fn(),
  checkCooldownAndCaps: vi.fn(),
  aiTraderPolicyObject: vi.fn(),
}));
vi.mock("../../server/ai-trader/scanner", () => ({
  getScannerShortlist: vi.fn(() => []),
  getScannerShortlistResult: vi.fn(() => ({ authority: "tradable", candidates: [] })),
  stopScanner: vi.fn(),
}));
vi.mock("../../server/ai-trader/graduation", () => ({ evaluateGraduation: vi.fn() }));
vi.mock("../../server/ai-trader/close-truth", () => ({ isTerminalCloseResult: vi.fn() }));
vi.mock("../../server/ai-trader/market-admission", () => ({
  isAiTraderMarketAdmitted: vi.fn(),
  SCANNER_MARKET_UNADMITTED_REASON: "scanner_market_unadmitted",
}));
vi.mock("../../server/ai-trader/multiplier-market-quarantine", () => ({
  isMultiplierMarketQuarantined: vi.fn(),
  MULTIPLIER_UNQUALIFIED_REASON: "multiplier_unqualified",
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadModules() {
  const monitor = await import("../../server/ai-trader/monitor");
  const { formatPoolLoadTags } = await import("../../server/pool-load");
  return { monitor, formatPoolLoadTags };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  getActiveBotsMock.mockReset();
  getBotMock.mockReset();
  compressDecisionsMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { stopAiTraderMonitor } = await import("../../server/ai-trader/monitor");
  stopAiTraderMonitor();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AI Trader pool-load attribution", () => {
  it("manifest publication preserves scanner pool-attribution reporting", async () => {
    const { formatPoolLoadTags } = await loadModules();
    expect(formatPoolLoadTags()).toBe("");
    const run = deferred<null>();
    getBotMock.mockReturnValueOnce(run.promise);
    const { monitor } = await loadModules();
    const cycle = monitor.runAutoCycle("scanner-manifest");
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c1/g0/d0");
    run.resolve(null);
    await cycle;
    expect(formatPoolLoadTags()).toBe("");
  });
  it("suppresses the fixed tag while every owner count is idle", async () => {
    const { formatPoolLoadTags } = await loadModules();
    expect(formatPoolLoadTags()).toBe("");
  });

  it("counts accepted, suppressed, and wedge-authorized overlapping ticks exactly", async () => {
    const first = deferred<never[]>();
    const replacement = deferred<never[]>();
    getActiveBotsMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(replacement.promise);
    const { monitor, formatPoolLoadTags } = await loadModules();

    const firstRun = monitor.runMonitorTickOnce();
    expect(formatPoolLoadTags()).toBe(" ai_trader=t1/c0/g0/d0");

    await monitor.runMonitorTickOnce();
    expect(getActiveBotsMock).toHaveBeenCalledTimes(1);
    expect(formatPoolLoadTags()).toBe(" ai_trader=t1/c0/g0/d0");

    vi.setSystemTime(121_001);
    const replacementRun = monitor.runMonitorTickOnce();
    expect(getActiveBotsMock).toHaveBeenCalledTimes(2);
    expect(formatPoolLoadTags()).toBe(" ai_trader=t2/c0/g0/d0");

    replacement.resolve([]);
    await replacementRun;
    expect(formatPoolLoadTags()).toBe(" ai_trader=t1/c0/g0/d0");

    first.resolve([]);
    await firstRun;
    expect(formatPoolLoadTags()).toBe("");
  });

  it("releases an accepted tick after its retry path rejects", async () => {
    getActiveBotsMock.mockRejectedValue(new Error("db unavailable"));
    const { monitor, formatPoolLoadTags } = await loadModules();

    const run = monitor.runMonitorTickOnce();
    expect(formatPoolLoadTags()).toBe(" ai_trader=t1/c0/g0/d0");
    await vi.advanceTimersByTimeAsync(9_000);
    await run;

    expect(getActiveBotsMock).toHaveBeenCalledTimes(3);
    expect(formatPoolLoadTags()).toBe("");
  });

  it("tracks auto-cycle early return, throw, overlap, and identity-safe stop cleanup", async () => {
    const early = deferred<null>();
    const thrown = deferred<null>();
    getBotMock
      .mockReturnValueOnce(early.promise)
      .mockReturnValueOnce(thrown.promise);
    const { monitor, formatPoolLoadTags } = await loadModules();

    const earlyRun = monitor.runAutoCycle("early");
    const thrownRun = monitor.runAutoCycle("thrown");
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c2/g0/d0");

    early.resolve(null);
    await earlyRun;
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c1/g0/d0");

    thrown.reject(new Error("read failed"));
    await expect(thrownRun).rejects.toThrow("read failed");
    expect(formatPoolLoadTags()).toBe("");

    const preStop = deferred<null>();
    const postStop = deferred<null>();
    getBotMock
      .mockReturnValueOnce(preStop.promise)
      .mockReturnValueOnce(postStop.promise);
    const oldRun = monitor.runAutoCycle("old");
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c1/g0/d0");
    monitor.stopAiTraderMonitor();
    expect(formatPoolLoadTags()).toBe("");

    const newRun = monitor.runAutoCycle("new");
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c1/g0/d0");
    preStop.resolve(null);
    await oldRun;
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c1/g0/d0");
    postStop.resolve(null);
    await newRun;
    expect(formatPoolLoadTags()).toBe("");
  });

  it("tracks overlapping graduation and compression owners through success and throw", async () => {
    const graduationOne = deferred<never[]>();
    const graduationTwo = deferred<never[]>();
    getActiveBotsMock
      .mockReturnValueOnce(graduationOne.promise)
      .mockReturnValueOnce(graduationTwo.promise);
    const compressionOne = deferred<number>();
    const compressionTwo = deferred<number>();
    compressDecisionsMock
      .mockReturnValueOnce(compressionOne.promise)
      .mockReturnValueOnce(compressionTwo.promise);
    const { monitor, formatPoolLoadTags } = await loadModules();

    const g1 = monitor.runGraduationSweep();
    const g2 = monitor.runGraduationSweep();
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c0/g2/d0");
    graduationOne.resolve([]);
    await g1;
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c0/g1/d0");
    graduationTwo.reject(new Error("graduation read failed"));
    await g2;
    expect(formatPoolLoadTags()).toBe("");

    const d1 = monitor.runDecisionCompressionSweep();
    const d2 = monitor.runDecisionCompressionSweep();
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c0/g0/d2");
    compressionOne.resolve(0);
    await d1;
    expect(formatPoolLoadTags()).toBe(" ai_trader=t0/c0/g0/d1");
    compressionTwo.reject(new Error("compression failed"));
    await expect(d2).rejects.toThrow("compression failed");
    expect(formatPoolLoadTags()).toBe("");
  });
});
