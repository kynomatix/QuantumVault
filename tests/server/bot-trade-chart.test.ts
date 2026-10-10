import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import type { ProvenancedOHLCV } from "../../server/lab/datafeed";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeNeutralBands } from "../../client/src/components/signalTradeHistoryWindow";
import { SIGNAL_CHART_TIMEFRAMES, SIGNAL_CHART_BAR_MS, isSignalChartTimeframe, signalChartTimeframe } from "../../shared/signal-trade-chart";
import type { BotTrade } from "@shared/schema";
import { marketToDatafeedTicker } from "../../server/ai-trader/context-builder";
import { isMultiplierMarketQuarantined } from "../../server/ai-trader/multiplier-market-quarantine";
import { chartDefaultTimeframe, pairChartTradeHistory, chartFirstTradeTime, chartOpenPosition, chartPriceSeries, alignChartExecutions, assertSingleChartMarket, chartPairingPlaceholders, chartScannedPage, toChartExecution } from "../../server/trading/bot-trade-chart";

const row = (overrides: Record<string, unknown> = {}): BotTrade => ({
  id: "EXAMPLE_ENTRY", market: "SOL", side: "LONG", status: "executed",
  executedAt: new Date("2026-08-04T12:30:00Z"), filledAt: null,
  price: "100", size: "2", averageFillPrice: null, filledSizeBase: null,
  pnl: null, fee: null, pnlConvention: null, feeTruthStatus: "legacy_unverified",
  webhookPayload: null, ...overrides,
} as unknown as BotTrade);

describe("Signal Bot trade chart proof", () => {
  it("uses a venue fill only when its time, price and quantity are complete", () => {
    const recorded = toChartExecution(row({ filledAt: new Date("2026-08-04T13:00:00Z"), averageFillPrice: "101", filledSizeBase: null }), "4h");
    expect(recorded).toMatchObject({ coordinateBasis: "recorded_execution", price: 100, size: 2, displayBarTime: null, pairingStatus: "unproven" });
    const filled = toChartExecution(row({ filledAt: new Date("2026-08-04T13:00:00Z"), averageFillPrice: "101", filledSizeBase: "2" }), "4h");
    expect(filled).toMatchObject({ coordinateBasis: "venue_fill", price: 101, exactTime: "2026-08-04T13:00:00.000Z" });
  });
  it("excludes non-executions and invalid coordinates", () => {
    expect(toChartExecution(row({ status: "pending" }), "1d")).toBeNull();
    expect(toChartExecution(row({ price: "0" }), "1d")).toBeNull();
  });
  it("pairs a full close in order and retains its canonical net gain", () => {
    const history = pairChartTradeHistory([row(), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05T12:30:00Z"), price: "106", pnl: "12", pnlConvention: "net_of_close_fee" })], "1d");
    const [entry, close] = history.executions;
    const aligned = alignChartExecutions([entry, close], [{time:Date.parse("2026-08-03T16:00:00Z")/1000},{time:Date.parse("2026-08-04T16:00:00Z")/1000},{time:Date.parse("2026-08-05T16:00:00Z")/1000}], 86_400_000);
    const actual = chartPairingPlaceholders(aligned);
    expect(actual.bands).toEqual([]);
    expect(actual.executions.every(x => x.pairingStatus === "sequential")).toBe(true);
    expect(history.pairs).toEqual([{ entryId: entry.id, exitId: close.id, direction: "Long", entryTime: entry.exactTime, exitTime: close.exactTime, entryPrice: 100, exitPrice: 106, size: 2, addCount: 0, liquidated: false, netPnl: 12, pnlPercent: 6, timeHeldMs: 86_400_000, pairingStatus: "sequential" }]);
    expect(close.netPnl).toBe(12);
  });
  it("labels ordered venue fills sequential, without claiming proven allocation", () => {
    const history = pairChartTradeHistory([
      row({ filledAt: new Date("2026-08-04T12:30:00Z"), averageFillPrice: "100", filledSizeBase: "2", protocolFillId: "EXAMPLE_FILL_ENTRY" }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05T12:30:00Z"), filledAt: new Date("2026-08-05T12:30:00Z"), averageFillPrice: "102", filledSizeBase: "2", pnl: "4", pnlConvention: "net_of_close_fee", protocolFillId: "EXAMPLE_FILL_CLOSE" }),
    ].reverse(), "1d");
    const [entry, close] = history.executions;
    const result = chartPairingPlaceholders(alignChartExecutions([entry, close], [{time:Date.parse("2026-08-03T16:00:00Z")/1000},{time:Date.parse("2026-08-04T16:00:00Z")/1000}], 86_400_000));
    expect(result.bands).toHaveLength(0);
    expect(history.pairs[0]).toMatchObject({ entryId: "EXAMPLE_ENTRY", exitId: "EXAMPLE_CLOSE", pnlPercent: 2 });
    expect(result.executions.map(x => x.pairingStatus)).toEqual(["sequential", "sequential"]);
    expect(history.pairs[0]).not.toHaveProperty("provenPairId");
  });
  it("classifies canonical close accounting before a free-text LONG side", () => {
    const close = toChartExecution(row({ side: "LONG", pnl: "0", pnlConvention: "net_of_close_fee" }), "1d");
    expect(close).toMatchObject({ kind: "close", netPnl: 0 });
    const unavailable = toChartExecution(row({ side: "LONG", webhookPayload: { closeAccounting: { kind: "unavailable" } } }), "1d");
    expect(unavailable).toMatchObject({ kind: "close", accountingStatus: "accounting unavailable" });
  });  it("fails a mixed market rather than showing a single-market chart", () => {
    expect(() => assertSingleChartMarket("SOL", ["SOL", "BTC"])).toThrow("Stored market differs");
  });

  it("pairs an entry and adds to the next close, regardless of close size", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 7, 4, hour));
    const result = pairChartTradeHistory([
      row({ executedAt: at(1) }),
      row({ id: "EXAMPLE_ADD", executedAt: at(2), size: "1", price: "130" }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: at(3), size: "1", pnl: "3", pnlConvention: "net_of_close_fee" }),
      row({ id: "EXAMPLE_NEXT", executedAt: at(4) }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: at(5), pnl: "2", pnlConvention: "net_of_close_fee" }),
    ], "4h");
    expect(result.pairs.map(pair => [pair.entryId, pair.exitId])).toEqual([["EXAMPLE_ENTRY", "EXAMPLE_CLOSE"], ["EXAMPLE_NEXT", "EXAMPLE_NEXT_CLOSE"]]);
    expect(result.pairs[0]).toMatchObject({ size: 3, entryPrice: 110, addCount: 1, netPnl: 3 });
    expect(result.executions.slice(0, 3).every(execution => execution.pair === result.pairs[0])).toBe(true);
  });

  it.each([{ pnlConvention: null }, { protocol: "EXAMPLE_OTHER_VENUE" }])("leaves an unpairable close neutral: %j", overrides => {
    const result = pairChartTradeHistory([row(), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee", ...overrides })], "1d");
    expect(result.pairs).toEqual([]);
    expect(result.executions.every(execution => execution.pairingStatus === "unproven")).toBe(true);
  });

  it.each(["LONG", "SHORT"])("pairs %s adds with the first reconciled liquidation", side => {
    const at = (hour: number) => new Date(Date.UTC(2026, 7, 4, hour));
    const result = pairChartTradeHistory([
      row({ side, executedAt: at(1) }),
      row({ id: "EXAMPLE_ADD", side, executedAt: at(3), size: "1", price: "130" }),
      row({ id: "EXAMPLE_ADD_TWO", side, executedAt: at(4), size: "1", price: "110" }),
      row({ id: "EXAMPLE_LIQUIDATION", side: "CLOSE", status: "liquidated", executedAt: at(5), size: "3", price: "90", pnl: "-7", fee: "2", pnlConvention: "gross_before_close_fee" }),
    ], "4h");
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ entryId: "EXAMPLE_ENTRY", exitId: "EXAMPLE_LIQUIDATION", direction: side === "LONG" ? "Long" : "Short", entryTime: at(1).toISOString(), exitTime: at(5).toISOString(), entryPrice: 110, exitPrice: 90, size: 4, addCount: 2, liquidated: true, netPnl: -4, timeHeldMs: 4 * 3_600_000 });
    expect(result.pairs[0].pnlPercent).toBeCloseTo(-4 / 440 * 100);
    expect(result.executions.every(execution => execution.pair === result.pairs[0])).toBe(true);
  });

  it.each(["liquidated", "recovered"])("pairs a reconciled %s close", status => {
    const result = pairChartTradeHistory([row(), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", status, executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee" })], "1d");
    expect(result.pairs[0]).toMatchObject({ liquidated: status === "liquidated", netPnl: 1 });
  });

  it("uses actual fills when an order still has an unfilled remainder", () => {
    const result = pairChartTradeHistory([
      row({ size: "3", filledAt: new Date("2026-08-04T12:30:00Z"), averageFillPrice: "100", filledSizeBase: "2", remainingSizeBase: "1" }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs[0]).toMatchObject({ size: 2, entryPrice: 100 });
  });

  it.each([{ pnlConvention: null }, { pnl: "NaN" }, { price: "0" }])("resets at flat after invalid close data: %j", overrides => {
    const result = pairChartTradeHistory([
      row(),
      row({ id: "EXAMPLE_BAD_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee", ...overrides }),
      row({ id: "EXAMPLE_NEXT", executedAt: new Date("2026-08-06") }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-07"), pnl: "2", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_NEXT"]);
    expect(result.executions[0].pairingStatus).toBe("unproven");
  });

  it("ends a position at its first close even when P&L is unavailable", () => {
    const result = pairChartTradeHistory([
      row(),
      row({ id: "EXAMPLE_PARTIAL", side: "CLOSE", executedAt: new Date("2026-08-05"), size: "1" }),
      row({ id: "EXAMPLE_REST", side: "CLOSE", executedAt: new Date("2026-08-06"), size: "1", pnl: "1", pnlConvention: "net_of_close_fee" }),
      row({ id: "EXAMPLE_NEXT", executedAt: new Date("2026-08-07") }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-08"), pnl: "2", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_NEXT"]);
    expect(result.executions[0].pairingStatus).toBe("unproven");
    expect(result.executions[1].pairingStatus).toBe("unproven");
  });

  it.each([{ size: "0" }, { size: "NaN" }, { executionMethod: "on-chain-detected" }])("lets later trades pair after an invalid or unknown row: %j", overrides => {
    const result = pairChartTradeHistory([
      row({ ...overrides }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee" }),
      row({ id: "EXAMPLE_NEXT", executedAt: new Date("2026-08-06") }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-07"), pnl: "2", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_NEXT"]);
  });

  it("starts a new position after an equal-or-larger opposite fill flips direction", () => {
    const result = pairChartTradeHistory([
      row(), row({ id: "EXAMPLE_FLIP", side: "SHORT", size: "3", executedAt: new Date("2026-08-05") }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", size: "1", executedAt: new Date("2026-08-06"), pnl: "1", pnlConvention: "net_of_close_fee" }),
      row({ id: "EXAMPLE_NEXT", executedAt: new Date("2026-08-07") }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-08"), pnl: "1", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => [pair.entryId, pair.direction])).toEqual([["EXAMPLE_FLIP", "Short"], ["EXAMPLE_NEXT", "Long"]]);
    expect(result.executions[0].pairingStatus).toBe("unproven");
  });

  it("pairs simultaneous entries before closes, then pairs later trades", () => {
    const result = pairChartTradeHistory([
      row(), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", pnl: "1", pnlConvention: "net_of_close_fee" }),
      row({ id: "EXAMPLE_NEXT", executedAt: new Date("2026-08-06") }),
      row({ id: "EXAMPLE_NEXT_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-07"), pnl: "1", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_ENTRY", "EXAMPLE_NEXT"]);
  });

  it("includes simultaneous same-direction adds because their weighted entry is unambiguous", () => {
    const result = pairChartTradeHistory([
      row(), row({ id: "EXAMPLE_ADD", price: "130", size: "1" }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", size: "3", executedAt: new Date("2026-08-05"), pnl: "3", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs[0]).toMatchObject({ size: 3, entryPrice: 110, addCount: 1, netPnl: 3 });
    expect(result.executions.every(execution => execution.pair === result.pairs[0])).toBe(true);
  });

  it("ignores an unclassified execution between an entry and close", () => {
    const result = pairChartTradeHistory([
      row(), row({ id: "EXAMPLE_UNKNOWN", executedAt: new Date("2026-08-04T13:00:00Z"), executionMethod: "on-chain-detected" }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_ENTRY"]);
    expect(result.executions[1].pairingStatus).toBe("unproven");
  });

  it("keeps an orphan close neutral while later trades still pair", () => {
    const result = pairChartTradeHistory([
      row({ id: "EXAMPLE_ORPHAN", side: "CLOSE", executedAt: new Date("2026-08-03"), pnl: "1", pnlConvention: "net_of_close_fee" }),
      row(), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "1", pnlConvention: "net_of_close_fee" }),
    ], "1d");
    expect(result.pairs.map(pair => pair.entryId)).toEqual(["EXAMPLE_ENTRY"]);
    expect(result.executions[0].pairingStatus).toBe("unproven");
  });

  it("marks a smaller opposite fill as a trim and keeps it in the paired execution list", async () => {
    const { tradeChartMarkers } = await import("../../client/src/components/signalTradeChartMarkers");
    const result = pairChartTradeHistory([
      row(),
      row({ id: "EXAMPLE_TRIM", side: "SHORT", size: "0.5", executedAt: new Date("2026-08-04T13:00:00Z") }),
      row({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "3", pnlConvention: "net_of_close_fee" }),
    ], "4h");
    expect(result.pairs).toHaveLength(1);
    expect(result.executions[1]).toMatchObject({ id: "EXAMPLE_TRIM", kind: "trim", pairingStatus: "sequential", pair: result.pairs[0] });
    const aligned = alignChartExecutions(result.executions, [{ time: Date.parse("2026-08-04T12:00:00Z") / 1000 }], 14_400_000);
    expect(tradeChartMarkers(aligned)[1]).toMatchObject({ id: "EXAMPLE_TRIM", shape: "circle", size: 0.5, color: "#64748b", text: "Trim" });
  });

  it.each(["-4", "0", "4"])("uses canonical short P&L %s and exact same-bar duration", pnl => {
    const result = pairChartTradeHistory([
      row({ side: "SHORT" }), row({ id: "EXAMPLE_CLOSE", side: "CLOSE", price: "98", executedAt: new Date("2026-08-04T12:31:00Z"), pnl, pnlConvention: "net_of_close_fee" }),
    ], "4h");
    expect(result.pairs[0]).toMatchObject({ direction: "Short", netPnl: Number(pnl), pnlPercent: Number(pnl) / 2, timeHeldMs: 60_000 });
  });
  it("uses each close's canonical net value for gain, loss and neutral markers", () => {
    const cases = [
      { id: "EXAMPLE_GAIN", pnl: "12", pnlConvention: "net_of_close_fee", expected: 12 },
      { id: "EXAMPLE_LOSS", pnl: "-7", pnlConvention: "net_of_close_fee", expected: -7 },
      { id: "EXAMPLE_ZERO", pnl: "0", pnlConvention: "net_of_close_fee", expected: 0 },
      { id: "EXAMPLE_UNAVAILABLE", pnl: "12", pnlConvention: null, expected: null },
    ];
    for (const item of cases) {
      const close = toChartExecution(row({ ...item, side: "CLOSE" }), "1d")!;
      expect(close).toMatchObject({ kind: "close", netPnl: item.expected, pairingStatus: "unproven" });
      expect(close).not.toHaveProperty("provenPairId");
    }
  });

  it("renders a neutral span with no estimate-style text", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/components/SignalTradeHistoryChart.tsx"), "utf8");
    expect(source).toContain("chart.addHistogramSeries({ priceScaleId: 'trade-lane', base: 0, color: NEUTRAL_SPAN");
    expect(source).toContain("scaleMargins: { top: 0.975, bottom: 0.01 }");
    expect(source).toContain("const NEUTRAL_SPAN = 'rgba(100,116,139,0.25)'");
    expect(source).toContain("attachTradeBoxes(chart, series, data.pairs");
    expect(source).toContain("'Entry (avg)'");
    expect(source).toContain("size-weighted average entry");
    expect(source).toContain("pair?.size ?? execution.size");
    expect(source).toContain("pair?.liquidated ? 'Liquidated'");
    expect(source).toContain("(hovered ?? pinned)");
    expect(source).not.toContain("(hovered ?? selected)");
    expect(source).not.toContain("estimated");
    expect(source).not.toContain("pairing unproven</span>");
    expect(source).not.toContain("{b.label}");
    expect(source).not.toContain("title={b.label}");
  });
  it("groups same-bar spans and merges a split page into one column", () => {
    const a = toChartExecution(row(), "4h")!;
    const b = toChartExecution(row({ id: "EXAMPLE_TWO", executedAt: new Date("2026-08-04T13:15:00Z") }), "4h")!;
    const c = toChartExecution(row({ id: "EXAMPLE_THREE", executedAt: new Date("2026-08-04T16:00:00Z") }), "4h")!;
    const [aa,bb,cc] = alignChartExecutions([a,b,c], [{time:Date.parse("2026-08-04T12:00:00Z")/1000},{time:Date.parse("2026-08-04T16:00:00Z")/1000}], 14_400_000);
    expect(chartPairingPlaceholders([aa,bb,cc]).bands).toEqual([
      { barTime: aa.displayBarTime, rowIds: [a.id,b.id], pairingStatus: "unproven" },
      { barTime: cc.displayBarTime, rowIds: [c.id], pairingStatus: "unproven" },
    ]);
    expect(mergeNeutralBands(chartPairingPlaceholders([aa]).bands, chartPairingPlaceholders([bb]).bands)[0].rowIds).toEqual([a.id,b.id]);
  });
  it("offers five timeframes and loads all chart trades without date-window controls", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/components/SignalTradeHistoryChart.tsx"), "utf8");
    expect(SIGNAL_CHART_TIMEFRAMES).toEqual(["1h", "2h", "4h", "12h", "1d"]);
    expect(source).toContain("allTrades: '1'");
    expect(source).toContain("setVisibleLogicalRange");
    expect(source).toContain("SIGNAL_CHART_BAR_MS[data.timeframe] / 1000");
    expect(source).not.toContain("Earlier 90 days");
    expect(source).not.toContain("Recent 90 days");
  });
  it("uses a half-open executedAt window and cursors from the last scanned row even when invalid", () => {
    const from = new Date("2026-08-01T00:00:00Z"), boundary = new Date("2026-09-01T00:00:00Z");
    expect(from < boundary && !(boundary < boundary)).toBe(true);
    const route = readFileSync(resolve(process.cwd(), "server/routes.ts"), "utf8");
    expect(route).toContain("gte(botTrades.executedAt, from), lt(botTrades.executedAt, to)");
    expect(route).toContain("lastScanned: tail");
    const rows = Array.from({length:251}, (_,i)=>row({id:"EXAMPLE_"+i, executedAt:new Date(boundary.getTime()-i*1000), price:i===249 ? "0" : "100"}));
    const page = chartScannedPage(rows);
    expect(page.complete).toBe(false);
    expect(page.lastScanned?.id).toBe("EXAMPLE_249");
    expect(toChartExecution(page.lastScanned!, "1d")).toBeNull();
    expect(page.scanned.map(x=>toChartExecution(x,"1d")).filter(Boolean)).toHaveLength(249);
    expect(rows[0].executedAt).toEqual(boundary);
  });
  it("leaves reconciler rows without a close signal unknown", () => {
    expect(toChartExecution(row({ executionMethod: "on-chain-detected" }), "1d")?.kind).toBe("unknown");
    expect(toChartExecution(row({ webhookPayload: { reconciled: true } }), "1d")?.kind).toBe("unknown");
    expect(toChartExecution(row({ executionMethod: "on-chain-detected", pnl: "2", pnlConvention: "net_of_close_fee" }), "1d")?.kind).toBe("close");
  });
  it("aligns markers and bands to 16:00 UTC daily candles", async () => {
    const { tradeChartMarkers } = await import("../../client/src/components/signalTradeChartMarkers");
    const a=toChartExecution(row({executedAt:new Date("2026-08-05T15:59:59Z")}),"1d")!;
    const b=toChartExecution(row({id:"EXAMPLE_B",executedAt:new Date("2026-08-05T16:00:00Z"),side:"CLOSE",pnl:"-2",pnlConvention:"net_of_close_fee"}),"1d")!;
    const candles=[{time:Date.parse("2026-08-04T16:00:00Z")/1000},{time:Date.parse("2026-08-05T16:00:00Z")/1000}];
    const aligned=alignChartExecutions([a,b],candles,86_400_000);
    expect(aligned.map(x=>x.displayBarTime)).toEqual(["2026-08-04T16:00:00.000Z","2026-08-05T16:00:00.000Z"]);
    expect(chartPairingPlaceholders(aligned).bands.map(x=>x.barTime)).toEqual(aligned.map(x=>x.displayBarTime));
    expect(tradeChartMarkers(aligned).map(x=>x.time)).toEqual(candles.map(x=>x.time));
    expect(tradeChartMarkers(aligned)[1].color).toBe("#dc2626");
  });
  it("stacks same-bar markers and omits all price geometry without candles", async () => {
    const { tradeChartMarkers } = await import("../../client/src/components/signalTradeChartMarkers");
    const a=toChartExecution(row(),"4h")!,b=toChartExecution(row({id:"EXAMPLE_B",executedAt:new Date("2026-08-04T13:15:00Z")}),"4h")!;
    const aligned=alignChartExecutions([a,b],[{time:Date.parse("2026-08-04T12:00:00Z")/1000}],14_400_000);
    expect(tradeChartMarkers(aligned).map(x=>x.time)).toEqual([Date.parse("2026-08-04T12:00:00Z")/1000,Date.parse("2026-08-04T12:00:00Z")/1000]);
    const absent=alignChartExecutions([a,b],[],14_400_000);
    expect(absent).toHaveLength(2);
    expect(chartPairingPlaceholders(absent).bands).toEqual([]);
    expect(tradeChartMarkers(absent)).toEqual([]);
  });
  it("passes mapped ZEC-PERP ticker to fetch and quarantines multiplier price", () => {
    const route=readFileSync(resolve(process.cwd(),"server/routes.ts"),"utf8");
    expect(marketToDatafeedTicker("ZEC-PERP")).toBe("ZEC/USDT");
    expect(isMultiplierMarketQuarantined("1KZEC-PERP")).toBe(true);
    expect(route).toContain("fetchOHLCV(marketToDatafeedTicker(bot.market), tf");
    expect(route).toContain("if (multiplierQuarantined) throw new Error");
    expect(route).toContain("reason: multiplierQuarantined ? \"multiplier_unqualified\"");
    expect(route).not.toContain("bypassCache: true, cacheWritePolicy");
  });
  it("uses shared-series markers and an accessible row list", () => {
    const source=readFileSync(resolve(process.cwd(),"client/src/components/SignalTradeHistoryChart.tsx"),"utf8");
    expect(source).toContain("series.setMarkers(tradeChartMarkers(data.executions)");
    expect(source).toContain("Trade execution rows");
    expect(source).not.toContain("className=\"relative h-28");
  });
});

const candle = (time = Date.parse("2026-08-04T00:00:00Z"), overrides: Record<string, unknown> = {}): ProvenancedOHLCV => ({
  time, open: 100, high: 102, low: 99, close: 101, volume: 10,
  provenance: { source: "okx", venue: "okx", basis: "perp", proxy: "direct", timeSemantic: "open_time", finality: "finalized" },
  ...overrides,
} as ProvenancedOHLCV);

describe("chart boundary normalization", () => {
  it.each(SIGNAL_CHART_TIMEFRAMES)("uses the %s bar length for admission and execution alignment", timeframe => {
    const barMs = SIGNAL_CHART_BAR_MS[timeframe], start = candle().time;
    const candles = [candle(start), candle(start + barMs)];
    const prices = chartPriceSeries(candles, timeframe);
    expect(prices.candles).toHaveLength(2);
    const execution = toChartExecution(row({ executedAt: new Date(start + barMs + 1) }), timeframe)!;
    expect(alignChartExecutions([execution], prices.candles, barMs)[0].displayBarTime).toBe(new Date(start + barMs).toISOString());
    expect(chartPriceSeries([candles[0], candle(start + 2 * barMs)], timeframe).candles).toEqual([]);
  });
  it("uses the newest recorded signal interval, normalizes TradingView minutes and falls back to 4H", () => {
    expect(chartDefaultTimeframe([row({ webhookPayload: { data: { interval: "120" } } })])).toBe("2h");
    expect(chartDefaultTimeframe([row({ webhookPayload: JSON.stringify({ timeframe: "12H" }) })])).toBe("12h");
    expect(chartDefaultTimeframe([row({ webhookPayload: { timeframe: "1h" } }), row({ id: "EXAMPLE_NEW", executedAt: new Date("2026-08-05"), webhookPayload: { interval: "15" } })])).toBe("4h");
    expect(chartDefaultTimeframe([row()])).toBe("4h");
    expect(chartDefaultTimeframe([])).toBe("4h");
    expect(signalChartTimeframe("D")).toBe("1d");
    expect(signalChartTimeframe(720)).toBe("12h");
  });

  it("normalizes aggregate timestamps and rejects invalid position prices", () => {
    expect(chartFirstTradeTime("2026-08-04 00:00:00+00")).toBe("2026-08-04T00:00:00.000Z");
    expect(chartFirstTradeTime("invalid")).toBeNull();
    for (const avgEntryPrice of ["0", "-1", "NaN", "Infinity", ""]) {
      expect(chartOpenPosition({ baseSize: "2", avgEntryPrice })).toMatchObject({ size: 2, entryPrice: null, unrealizedPnl: null });
    }
    expect(chartOpenPosition({ baseSize: "-2", avgEntryPrice: "100" })).toMatchObject({ size: -2, entryPrice: 100 });
    expect(chartOpenPosition({ baseSize: "0", avgEntryPrice: "100" })).toBeNull();
  });
  it("accepts one direct series including a forming last bar, but rejects gaps and bad OHLC", () => {
    const a = candle(), b = candle(a.time + 86_400_000);
    b.provenance.finality = "forming";
    expect(chartPriceSeries([a, b], "1d").candles).toHaveLength(2);
    expect(chartPriceSeries([a, candle(a.time + 2 * 86_400_000)], "1d").candles).toEqual([]);
    expect(chartPriceSeries([candle(a.time, { high: 98 })], "1d").candles).toEqual([]);
    expect(chartPriceSeries([a, {...b, provenance: {...b.provenance, basis: "spot"}}], "1d").candles).toEqual([]);
    expect(chartPriceSeries(Array.from({length:180}, (_, i) => candle(a.time + i * 86_400_000)), "1d").candles).toHaveLength(180);
  });
  it("survives non-string action payloads and retains marker row identity", async () => {
    expect(toChartExecution(row({ webhookPayload: { action: 123 } }), "1d")).not.toBeNull();
    const { tradeChartMarkers } = await import("../../client/src/components/signalTradeChartMarkers");
    const aligned = alignChartExecutions([toChartExecution(row(), "1d")!], [{time:candle().time/1000}], 86_400_000);
    expect(tradeChartMarkers(aligned)[0].id).toBe("EXAMPLE_ENTRY");
  });
});

// Execute the actual registered handler with a small query adapter. This proves
// handler authorization/filter/cursor behavior without a database or server boot.
// It does not replace PostgreSQL integration evidence or canonical P&L tests.
const routeSource = readFileSync(resolve(process.cwd(), "server/routes.ts"), "utf8");
const routeStart = routeSource.indexOf('app.get("/api/trading-bots/:id/trade-chart"');
const handlerJs = transpileModule(routeSource.slice(routeStart, routeSource.indexOf("// Bot trades routes", routeStart)), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText;
type TestRow = Record<string, any>;
type Predicate = (row: TestRow) => boolean;
const bot = { id: "EXAMPLE_BOT", walletAddress: "EXAMPLE_OWNER", market: "SOL", activeProtocol: "drift" };
const fixture = (values: Record<string, unknown> = {}) => row({ tradingBotId: bot.id, walletAddress: bot.walletAddress, ...values });
const windowQuery = { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z", tf: "1d" };
function routeHarness(trades: BotTrade[] = [fixture()], positions: TestRow[] = [], market = "SOL") {
  const fields = Object.fromEntries(["market", "tradingBotId", "walletAddress", "executedAt", "status", "id"].map(k => [k,k]));
  const tradeTable = {...fields}, positionTable = {...fields};
  const value = (v: any) => v instanceof Date ? v.getTime() : v;
  const compare = (op: (a:any,b:any)=>boolean) => (field:string, expected:any): Predicate => r => op(value(r[field]), value(expected));
  const eq = compare((a,b)=>a===b), lt = compare((a,b)=>a<b), gte = compare((a,b)=>a>=b);
  const and = (...predicates:(Predicate|undefined)[]): Predicate => r => predicates.every(p=>!p||p(r));
  const or = (...predicates:Predicate[]): Predicate => r => predicates.some(p=>p(r));
  const selects: Array<{ table: unknown; limit?:number }> = [];
  function select(shape?: Record<string, unknown>, distinct = false) {
    let source: TestRow[] = [], predicate: Predicate = () => true, order: string[] = [], limit = Infinity;
    const trace: {table:unknown;limit?:number} = {table:null}; selects.push(trace);
    const query = {
      from(table: unknown) { trace.table=table; source=table===tradeTable?trades:positions; return query; },
      where(p:Predicate) { predicate=p; return query; },
      orderBy(...keys:string[]) { order=keys; return query; },
      limit(n:number) { limit=n;trace.limit=n; return query; },
      then(resolveRows:(rows:TestRow[])=>unknown, reject:(err:unknown)=>unknown) {
        let rows=source.filter(predicate).sort((a,b)=>{for(const k of order){if(value(a[k])<value(b[k]))return 1;if(value(a[k])>value(b[k]))return -1;}return 0;}).slice(0,limit);
        if(shape && "first" in shape) rows=[{first:rows.length?new Date(Math.min(...rows.map(r=>+r.executedAt))).toISOString():null}];
        else if(distinct) rows=[...new Set(rows.map(r=>r.market))].map(market=>({market}));
        return Promise.resolve(rows).then(resolveRows,reject);
      },
    }; return query;
  }
  const totals={totalTrades: 17, winningTrades: 7, losingTrades: 8, accountingIncompleteTrades: 2};
  const storage={getTradingBotById:vi.fn(async()=>({...bot,market})),getCanonicalBotTradeStats:vi.fn(async()=>totals)};
  const fetchOHLCV=vi.fn(async()=>[candle()]);
  let handler: (req:any,res:any)=>Promise<unknown> = async()=>{};
  const dependencies={app:{get:(_path:string,_auth:unknown,fn:typeof handler)=>{handler=fn;}}, requireWallet:()=>{},storage,
    db:{select:(shape?:Record<string,unknown>)=>select(shape),selectDistinct:(shape:Record<string,unknown>)=>select(shape,true)},
    botTrades:tradeTable,botPositions:positionTable,eq,lt,gte,and,or,desc:(key:string)=>key,
    inArray:(key:string,values:string[]):Predicate=>r=>values.includes(r[key]),sql:()=>"min",
    notPhantomDupClose:():Predicate=>r=>!r.phantom,fetchOHLCV,CHART_CANDLE_POLICY:"EXAMPLE_POLICY",
    chartDefaultTimeframe,SIGNAL_CHART_BAR_MS,isSignalChartTimeframe,pairChartTradeHistory,chartFirstTradeTime,chartOpenPosition,chartPriceSeries,alignChartExecutions,assertSingleChartMarket,chartPairingPlaceholders,chartScannedPage,toChartExecution,
    marketToDatafeedTicker,isMultiplierMarketQuarantined,Buffer,console};
  new Function(...Object.keys(dependencies),handlerJs)(...Object.values(dependencies));
  async function request(query:Record<string,unknown>=windowQuery,walletAddress=bot.walletAddress) {
    let status=200,body:any;
    const res={status(code:number){status=code;return res;},json(value:unknown){body=value;return res;}};
    await handler({params:{id:bot.id},query,walletAddress},res); return {status,body};
  }
  return {request,storage,fetchOHLCV,selects,totals};
}

describe("registered chart route", () => {
  it("loads from the first trade with padding and includes more than 250 trades on the chart", async () => {
    const trades = Array.from({ length: 503 }, (_, i) => fixture({ id: `EXAMPLE_${i}`, executedAt: new Date(Date.parse("2026-04-01") + i * 7200000), webhookPayload: { interval: "120" } }));
    const h = routeHarness(trades);
    const { status, body } = await h.request({ allTrades: "1", to: "2026-10-01T00:00:00.000Z" });
    expect(status).toBe(200);
    expect(body.timeframe).toBe("2h");
    expect(body.range.from).toBe("2026-03-31T20:00:00.000Z");
    expect(body.executions).toHaveLength(503);
    expect(body.complete).toBe(true);
    expect(body.nextCursor).toBeNull();
    expect(h.fetchOHLCV).toHaveBeenCalledWith("SOL/USDT", "2h", Date.parse(body.range.from), Date.parse(body.range.to), undefined, expect.objectContaining({ deadlineMs: 60_000, cacheWritePolicy: "skip" }));
  });
  it.each(SIGNAL_CHART_TIMEFRAMES)("accepts native %s history beyond 120 days", async tf => {
    const h = routeHarness();
    expect((await h.request({ ...windowQuery, tf, from: "2026-01-01" })).status).toBe(200);
    expect(h.fetchOHLCV).toHaveBeenCalledWith("SOL/USDT", tf, expect.any(Number), expect.any(Number), undefined, expect.any(Object));
  });

  it("pairs across the window boundary and includes spans with neither endpoint in view", async () => {
    const entry = fixture({ executedAt: new Date("2026-07-01") });
    const close = fixture({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-05"), pnl: "4", pnlConvention: "net_of_close_fee" });
    const visibleClose = await routeHarness([entry, close]).request();
    expect(visibleClose.body.executions).toHaveLength(1);
    expect(visibleClose.body.executions[0]).toMatchObject({ pairingStatus: "sequential", pair: { entryId: entry.id, exitId: close.id } });
    expect(visibleClose.body.pairs).toHaveLength(1);
    const spanning = await routeHarness([entry, { ...close, executedAt: new Date("2026-09-02") }]).request();
    expect(spanning.body.executions).toEqual([]);
    expect(spanning.body.pairs).toHaveLength(1);
  });
  it("labels squares separately from boxes and matches the actual drawing colours", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/components/SignalTradeHistoryChart.tsx"), "utf8");
    const markers = readFileSync(resolve(process.cwd(), "client/src/components/signalTradeChartMarkers.ts"), "utf8");
    expect(source).toContain("■ Unclassified execution");
    expect(source).toContain("Boxes: flat-to-flat positions");
    expect(source).not.toContain("□ Box");
    for (const color of ["#38bdf8", "#a78bfa", "#059669", "#dc2626", "#64748b"]) {
      expect(source).toContain(`style={{ color: '${color}' }}`);
      expect(markers).toContain(color);
    }
    for (const rgb of ["5,150,105", "220,38,38", "100,116,139"]) {
      expect(markers).toContain(`'${rgb}'`);
      expect(source).toContain(`backgroundColor: 'rgba(${rgb},0.15)', borderColor: 'rgba(${rgb},0.7)'`);
    }
  });

  it("keeps the same pairing when entry and exit are on different pages", async () => {
    const trades = [
      fixture({ executedAt: new Date("2026-08-01T01:00:00Z") }),
      fixture({ id: "EXAMPLE_CLOSE", side: "CLOSE", executedAt: new Date("2026-08-01T02:00:00Z"), pnl: "4", pnlConvention: "net_of_close_fee" }),
      ...Array.from({ length: 249 }, (_, i) => fixture({ id: `EXAMPLE_LATER_${i}`, executedAt: new Date(Date.parse("2026-08-02") + i * 1000) })),
    ];
    const h = routeHarness(trades);
    const first = await h.request();
    const second = await h.request({ ...windowQuery, cursor: first.body.nextCursor });
    expect(first.body.executions.find((execution: any) => execution.id === "EXAMPLE_CLOSE").pair).toEqual(second.body.executions[0].pair);
    expect(first.body.pairs).toEqual(second.body.pairs);
    expect(second.body.executions[0].pairingStatus).toBe("sequential");
  });

  it("checks ownership before querying any history or price and on every cursor request", async () => {
    const h=routeHarness();
    expect((await h.request({...windowQuery,cursor:"EXAMPLE_CURSOR"},"EXAMPLE_OTHER")).status).toBe(403);
    expect(h.selects).toHaveLength(0); expect(h.fetchOHLCV).not.toHaveBeenCalled();
  });
  it("rejects bad ranges, unsupported timeframes and cursors bound to another bot", async () => {
    const h=routeHarness();
    for(const query of [{...windowQuery,tf:"8h"},{...windowQuery,from:"invalid"},{...windowQuery,from:windowQuery.to},{...windowQuery,cursor:Buffer.from(JSON.stringify({id:"EXAMPLE_ROW",at:windowQuery.from,botId:"EXAMPLE_OTHER",market:"SOL",from:windowQuery.from,to:windowQuery.to})).toString("base64url")}]) {
      expect((await h.request(query)).status).toBe(400);
    }
    expect(h.fetchOHLCV).not.toHaveBeenCalled();
  });
  it("rejects failed historical trades and zero-size positions on another market", async () => {
    const failed=routeHarness([fixture({status:"failed",market:"BTC"})]);
    const zero=routeHarness([],[{tradingBotId:bot.id,walletAddress:bot.walletAddress,market:"BTC",baseSize:"0"}]);
    for(const h of [failed,zero]) {
      expect(await h.request()).toMatchObject({status:409,body:{code:"MARKET_INVARIANT_VIOLATION"}});
      expect(h.fetchOHLCV).not.toHaveBeenCalled();
    }
  });
  it("paginates over 500 tied rows without omissions and advances over invalid coordinates", async () => {
    const trades=Array.from({length:503},(_,i)=>fixture({id:`EXAMPLE_${String(i).padStart(4,"0")}`,price:i===253?"0":"100"}));
    const h=routeHarness(trades), ids:string[]=[];
    let cursor:string|undefined;
    for(let page=0;page<3;page++) {
      const response=await h.request({...windowQuery,...(cursor?{cursor}:{})});
      expect(response.status).toBe(200);ids.push(...response.body.executions.map((e:any)=>e.id));cursor=response.body.nextCursor;
      if(page===0) expect(JSON.parse(Buffer.from(cursor!,"base64url").toString()).id).toBe("EXAMPLE_0253");
      expect(response.body.complete).toBe(page===2);
    }
    expect(cursor).toBeNull();expect(ids).toHaveLength(502);expect(new Set(ids).size).toBe(502);
    expect(h.selects.filter(q=>q.limit).every(q=>q.limit===251)).toBe(true);
  });
  it("enforces half-open windows and returns first eligibility outside the window", async () => {
    const h=routeHarness([fixture({id:"EXAMPLE_FIRST",executedAt:new Date("2026-01-01"),price:"0"}),fixture({id:"EXAMPLE_FROM",executedAt:new Date(windowQuery.from)}),fixture({id:"EXAMPLE_TO",executedAt:new Date(windowQuery.to)}),fixture({id:"EXAMPLE_PHANTOM",phantom:true}),fixture({id:"EXAMPLE_OTHER",walletAddress:"EXAMPLE_OTHER"})]);
    const {body}=await h.request();expect(body.executions.map((e:any)=>e.id)).toEqual(["EXAMPLE_FROM"]);
    expect(body.range.firstEligibleTradeAt).toBe("2026-01-01T00:00:00.000Z");
  });
  it("passes canonical totals through and requests only reference perpetual candles without cache writes", async () => {
    const h=routeHarness([fixture({market:"ZEC-PERP"})],[],"ZEC-PERP");const {body}=await h.request();
    expect(body.totals).toEqual(h.totals);expect(h.storage.getCanonicalBotTradeStats).toHaveBeenCalledWith(bot.id);
    expect(h.fetchOHLCV).toHaveBeenCalledWith("ZEC/USDT","1d",Date.parse(windowQuery.from),Date.parse(windowQuery.to),undefined,{basisPolicy:"EXAMPLE_POLICY",skipSpotFallback:true,cacheWritePolicy:"skip",deadlineMs:60_000});
    expect(body.price.basisLabel).toContain("not Drift execution price");
  });
  it("retains exact trade details when price fetch fails or the market is quarantined", async () => {
    const failed=routeHarness();failed.fetchOHLCV.mockRejectedValueOnce(new Error("EXAMPLE_UNAVAILABLE"));
    const quarantined=routeHarness([fixture({market:"1KZEC-PERP"})],[],"1KZEC-PERP");
    for(const h of [failed,quarantined]) {
      const {status,body}=await h.request();expect(status).toBe(200);expect(body.price.availability).toBe("unavailable");
      expect(body.executions).toHaveLength(1);expect(body.executions[0].displayBarTime).toBeNull();expect(body.bands).toEqual([]);
      expect(body.executions[0]).not.toHaveProperty("webhookPayload");
    }
    expect(quarantined.fetchOHLCV).not.toHaveBeenCalled();
  });
});
