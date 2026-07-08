// WO-3 acceptance test: golden-file coverage for server/ai-trader/context-builder.ts.
// fetchOHLCV is mocked (fixed synthetic candle fixtures below) so the test never
// touches the network/candle cache; the adapter is a minimal fake covering only
// the 3 ProtocolAdapter methods buildMarketContext actually calls. Time is frozen
// via vi.setSystemTime so "now"-relative staleness checks are deterministic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OHLCV } from "../../server/lab/engine";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";

const fetchOHLCVMock = vi.fn();
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: (...args: unknown[]) => fetchOHLCVMock(...args),
}));

const FIXED_NOW = Date.parse("2026-01-15T12:00:00.000Z");

function makeCandles(count: number, tfMs: number, lastCandleAgeMs: number, basePrice: number): OHLCV[] {
  const lastTime = FIXED_NOW - lastCandleAgeMs;
  const candles: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const time = lastTime - (count - 1 - i) * tfMs;
    const close = basePrice + i * 0.05 + Math.sin(i / 5) * 2;
    const open = i === 0 ? close - 0.1 : candles[i - 1].close;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const volume = 1000 + i * 3;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles;
}

// WO-3.1: the golden fixture now spans 400 bars — the module's INDICATOR_BARS
// window — so EMA200/EMA50 seed with real values. Only the most recent 100 bars
// are serialized into the CSV block (asserted below).
const SELECTED_CANDLES_15M = makeCandles(400, 900_000, 60_000, 140);
const PARENT_CANDLES_1H = makeCandles(30, 3_600_000, 5 * 60_000, 138);

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1",
    walletAddress: "WALLET_AGENT_PUBKEY_XYZ",
    protocol: "pacifica",
    protocolSubaccountId: "sub-1",
    market: "SOL-PERP",
    timeframe: "15m",
    mode: "auto",
    riskProfile: "guarded",
    paperMode: true,
    autoNext: false,
    model: "anthropic/claude-opus-4.8",
    allocatedUsdc: "500.00",
    maxLeverage: 5,
    stopPolicy: "static",
    parkWhenIdle: false,
    graduationState: "in_trial",
    graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
    trialStartedAt: new Date(FIXED_NOW - 86_400_000),
    graduatedAt: null,
    policyHmac: "test-hmac",
    status: "open",
    pauseReason: null,
    dailyRealizedPnl: "0",
    consecutiveLosses: 0,
    createdAt: new Date(FIXED_NOW - 86_400_000),
    updatedAt: new Date(FIXED_NOW - 3_600_000),
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeDecision(overrides: Partial<AiTraderDecision> = {}): AiTraderDecision {
  return {
    id: "decision-1",
    botId: "bot-1",
    contextDigest: null,
    rawDecision: { action: "long" },
    clampedDecision: { action: "long" },
    guardrailViolations: null,
    outcome: "executed",
    entryPrice: "140.00",
    exitPrice: "142.00",
    exitReason: "tp",
    realizedPnl: "20.00",
    feesPaid: "0.10",
    llmCostUsd: "0.02",
    llmLatencyMs: 1200,
    decidedAt: new Date(FIXED_NOW - 7_200_000),
    closedAt: new Date(FIXED_NOW - 3_600_000),
    ...overrides,
  } as unknown as AiTraderDecision;
}

const RECENT_DECISIONS: AiTraderDecision[] = [
  makeDecision({
    id: "d-1",
    clampedDecision: { action: "short" },
    entryPrice: "148.50",
    exitPrice: "146.00",
    exitReason: "tp",
    realizedPnl: "45.00",
    closedAt: new Date(FIXED_NOW - 3_600_000),
    contextDigest: { indicators: { adx14: { value: 30.2 } } },
  }),
  makeDecision({
    id: "d-2",
    clampedDecision: null,
    rawDecision: { action: "long" },
    entryPrice: "140.00",
    exitPrice: "142.50",
    exitReason: "sl",
    realizedPnl: "-20.00",
    closedAt: new Date(FIXED_NOW - 7_200_000),
    contextDigest: { indicators: { adx14: { value: 15.4 } } },
  }),
  makeDecision({
    id: "d-3",
    clampedDecision: { action: "long" },
    entryPrice: "135.00",
    exitPrice: "137.00",
    exitReason: "ai_close",
    realizedPnl: "30.00",
    closedAt: new Date(FIXED_NOW - 10_800_000),
    contextDigest: null,
  }),
];

// WO-5 corrective: positions are read with the agent SIGNING pubkey, resolved by
// the caller — the tests pin that the placeholder walletAddress is gone.
const AGENT_PUBKEY = "AgEntPubKey1111111111111111111111111111111";

function makeAdapter(overrides: Partial<ProtocolAdapter> = {}): ProtocolAdapter {
  return {
    getPrice: vi.fn().mockResolvedValue(150.1234),
    getFundingRate: vi.fn().mockResolvedValue({
      internalSymbol: "SOL-PERP",
      rate: 0.0001234,
      nextFundingTime: FIXED_NOW + 3_600_000,
      timestamp: FIXED_NOW,
    }),
    getPositions: vi.fn().mockResolvedValue([
      {
        internalSymbol: "SOL-PERP",
        baseSize: 2.5,
        entryPrice: 145.0,
        markPrice: 150.1234,
        unrealizedPnl: 12.5,
        leverage: 3,
        liquidationPrice: 120,
        marginMode: "isolated",
      },
    ]),
    ...overrides,
  } as unknown as ProtocolAdapter;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  fetchOHLCVMock.mockReset();
  fetchOHLCVMock.mockImplementation((_symbol: string, timeframe: string) => {
    if (timeframe === "15m") return Promise.resolve(SELECTED_CANDLES_15M);
    if (timeframe === "1h") return Promise.resolve(PARENT_CANDLES_1H);
    throw new Error(`unexpected timeframe requested in test: ${timeframe}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildMarketContext (WO-3)", () => {
  it("golden file: builds the full system+user prompt and contextDigest for an open-position bot", async () => {
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const adapter = makeAdapter();
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter,
      bot: makeBot(),
      recentDecisions: RECENT_DECISIONS,
      agentPublicKey: AGENT_PUBKEY,
    });

    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");

    expect(result.system).toMatchSnapshot("system-prompt");
    expect(result.user).toMatchSnapshot("user-prompt");
    expect(result.contextDigest).toMatchSnapshot("context-digest");

    // WO-5 corrective pin: positions must be read with the resolved agent
    // SIGNING pubkey, never bot.walletAddress (the old WO-3 placeholder).
    expect(adapter.getPositions).toHaveBeenCalledWith(AGENT_PUBKEY, "sub-1");

    // Targeted, human-readable assertions on top of the snapshot so intent survives
    // even if someone regenerates the snapshot without reading the diff closely.
    // WO-3.1: the 400-bar indicator window now seeds real EMA200/EMA50 values
    // (previously "n/a" — the WO-3 spec bug, since amended).
    expect(result.user).toMatch(/EMA\(200\): \d+\.\d{2} \(prev \d+\.\d{2}\)/);
    expect(result.user).toMatch(/EMA\(50\): \d+\.\d{2} \(prev \d+\.\d{2}\)/);
    expect(result.user).toContain("regime=trending (ADX 30.2)");
    expect(result.user).toContain("regime=ranging (ADX 15.4)");
    expect(result.user).toContain("regime=regime unknown (no ADX recorded)");
    expect(result.user).toContain("## Candles — 1h parent timeframe (oldest -> newest, CSV)");
    expect(result.user).toContain("Open position: long 2.5 @ entry 145.00");
    expect(fetchOHLCVMock).toHaveBeenCalledTimes(2);

    // WO-3.1 token-size guard: despite the 400-bar indicator window, the selected-
    // timeframe CSV block must still serialize exactly the 100 most recent bars.
    const selectedCsvBlock = result.user
      .split("## Candles — 15m (oldest -> newest, CSV)")[1]
      .split("## Candles — 1h parent timeframe")[0]
      .trim();
    const csvRows = selectedCsvBlock.split("\n");
    expect(csvRows[0]).toBe("time,open,high,low,close,volume");
    expect(csvRows.length - 1).toBe(100);
    // ...and those 100 rows are the NEWEST 100 of the 400-bar fixture.
    const fixtureNewest = SELECTED_CANDLES_15M[SELECTED_CANDLES_15M.length - 1];
    const fixtureOldestSerialized = SELECTED_CANDLES_15M[SELECTED_CANDLES_15M.length - 100];
    expect(csvRows[1]).toContain(new Date(fixtureOldestSerialized.time).toISOString().slice(0, 16));
    expect(csvRows[csvRows.length - 1]).toContain(new Date(fixtureNewest.time).toISOString().slice(0, 16));
  });

  it("EMA200 still renders 'n/a' as the fallback when history is genuinely insufficient (<200 bars)", async () => {
    fetchOHLCVMock.mockImplementation((_symbol: string, timeframe: string) => {
      // Venue/cache only has 120 bars of history — the module must degrade
      // honestly rather than fabricate an unseeded EMA200.
      if (timeframe === "15m") return Promise.resolve(makeCandles(120, 900_000, 60_000, 140));
      if (timeframe === "1h") return Promise.resolve(PARENT_CANDLES_1H);
      throw new Error(`unexpected timeframe requested in test: ${timeframe}`);
    });
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter(),
      bot: makeBot(),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");
    expect(result.user).toContain("EMA(200): n/a (prev n/a)");
    // 120 bars still seeds EMA50 — only the genuinely unseedable indicator degrades.
    expect(result.user).toMatch(/EMA\(50\): \d+\.\d{2} \(prev \d+\.\d{2}\)/);
  });

  it("returns stale:true when the newest candle exceeds 2x the timeframe in age", async () => {
    fetchOHLCVMock.mockImplementation((_symbol: string, timeframe: string) => {
      if (timeframe === "15m") return Promise.resolve(makeCandles(100, 900_000, 3_000_000, 140));
      if (timeframe === "1h") return Promise.resolve(PARENT_CANDLES_1H);
      throw new Error("unexpected timeframe");
    });
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter(),
      bot: makeBot(),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect(result).toEqual({ stale: true, reason: expect.stringContaining("candle is") });
  });

  it("returns stale:true when fetchOHLCV yields no candles", async () => {
    fetchOHLCVMock.mockImplementation(() => Promise.resolve([]));
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter(),
      bot: makeBot(),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect(result).toEqual({ stale: true, reason: expect.stringContaining("No 15m candle data") });
  });

  it("returns stale:true when the adapter has no live price", async () => {
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter({ getPrice: vi.fn().mockResolvedValue(null) }),
      bot: makeBot(),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect(result).toEqual({ stale: true, reason: expect.stringContaining("No live price available") });
  });

  it("1d timeframe has no parent block (no '1w' data source exists) and fetches candles only once", async () => {
    fetchOHLCVMock.mockImplementation((_symbol: string, timeframe: string) => {
      if (timeframe === "1d") return Promise.resolve(makeCandles(100, 86_400_000, 3_600_000, 140));
      throw new Error(`unexpected timeframe requested: ${timeframe}`);
    });
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "1d",
      adapter: makeAdapter(),
      bot: makeBot({ timeframe: "1d" }),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");
    expect(result.user).not.toContain("parent timeframe");
    expect(fetchOHLCVMock).toHaveBeenCalledTimes(1);
  });

  it("active cooldown: a very recently closed decision leaves minutes remaining before next entry", async () => {
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter(),
      bot: makeBot(),
      recentDecisions: [makeDecision({ closedAt: new Date(FIXED_NOW - 60_000) })],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");
    expect((result.contextDigest as any).guardrailEcho.cooldownRemainingMs).toBeGreaterThan(0);
    expect(result.user).toContain("m remaining before next entry");
  });

  it("smartLeverageCap binds below the hard ceiling under high realized volatility", async () => {
    fetchOHLCVMock.mockImplementation((_symbol: string, timeframe: string) => {
      if (timeframe === "15m") {
        // Wide, non-trending true range (open===close, +-15 wick) drives ATR14/price
        // well past the point where clamp(floor(0.5/ddProxy),1,5) stops floor-ing to 5.
        const candles: OHLCV[] = [];
        for (let i = 0; i < 100; i++) {
          const time = FIXED_NOW - 60_000 - (99 - i) * 900_000;
          const open = 140;
          const close = 140;
          candles.push({ time, open, high: open + 15, low: open - 15, close, volume: 1000 });
        }
        return Promise.resolve(candles);
      }
      if (timeframe === "1h") return Promise.resolve(PARENT_CANDLES_1H);
      throw new Error(`unexpected timeframe requested in test: ${timeframe}`);
    });
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter(),
      bot: makeBot({ maxLeverage: 5 }),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");
    const echo = (result.contextDigest as any).guardrailEcho;
    expect(echo.smartLeverageCap).toBeLessThan(5);
    expect(echo.maxLeverage).toBe(echo.smartLeverageCap);
    expect(result.user).toContain(`smart volatility cap ${echo.smartLeverageCap}x`);
  });

  it("flat bot (no matching open position) renders 'none (flat)' and $0.00 unrealized PnL", async () => {
    const { buildMarketContext } = await import("../../server/ai-trader/context-builder");
    const result = await buildMarketContext({
      market: "SOL-PERP",
      timeframe: "15m",
      adapter: makeAdapter({ getPositions: vi.fn().mockResolvedValue([]) }),
      bot: makeBot(),
      recentDecisions: [],
      agentPublicKey: AGENT_PUBKEY,
    });
    expect("stale" in result).toBe(false);
    if ("stale" in result) throw new Error("expected a built context, not stale");
    expect(result.user).toContain("Open position: none (flat)");
    expect(result.user).toContain("Unrealized PnL: $0.00");
    expect(result.user).toContain("No closed trades yet.");
    expect((result.contextDigest as any).account.hasPosition).toBe(false);
  });
});
