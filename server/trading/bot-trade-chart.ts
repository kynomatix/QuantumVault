import type { BotTrade, BotPosition } from "@shared/schema";
import type { ProvenancedOHLCV } from "../lab/datafeed";
import { resolveBotTradeNetPnl } from "./bot-trade-pnl-convention";
export type ChartExecution = { id: string; market: string; side: string; status: string; protocol: string | null; protocolMismatch: boolean; kind: "entry" | "close" | "unknown"; exactTime: string; displayBarTime: string | null; price: number; size: number; coordinateBasis: "venue_fill" | "recorded_execution"; netPnl: number | null; accountingStatus: "resolved" | "accounting unavailable"; feeTruthStatus: string; pairingStatus: "unproven" };
export type ChartBand = { barTime: string; rowIds: string[]; pairingStatus: "unproven" };
const positive = (v: string | number | null | undefined) => v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v);
const validTime = (v: Date | string | null | undefined) => { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d : null; };
export function toChartExecution(row: BotTrade, timeframe: "1d" | "4h", activeProtocol?: string | null): ChartExecution | null {
  if (!["executed", "liquidated", "recovered"].includes(row.status)) return null;
  const filled = validTime(row.filledAt), recorded = validTime(row.executedAt);
  const fillPrice = positive(row.averageFillPrice), fillSize = positive(row.filledSizeBase);
  const useFill = filled !== null && fillPrice !== null && fillSize !== null;
  const exact = useFill ? filled : recorded, price = useFill ? fillPrice : positive(row.price), size = useFill ? fillSize : positive(row.size);
  if (!exact || price === null || size === null) return null;
  const payload = row.webhookPayload as { data?: { action?: string }; action?: string; closeReason?: string; reconciled?: boolean; closeAccounting?: { kind?: string } } | null;
  const actionValue = payload?.data?.action ?? payload?.action;
  const side = row.side.toUpperCase(), action = typeof actionValue === "string" ? actionValue.toLowerCase() : "";
  const canonicalClose = row.pnl !== null || payload?.closeAccounting?.kind === "unavailable";
  const kind = canonicalClose || side === "CLOSE" || action === "close" || !!payload?.closeReason || row.status === "liquidated" ? "close" : row.executionMethod === "on-chain-detected" || payload?.reconciled === true ? "unknown" : ["LONG", "SHORT", "BUY", "SELL"].includes(side) ? "entry" : "unknown";
  const netPnl = resolveBotTradeNetPnl(row);
  return { id: row.id, market: row.market, side: row.side, status: row.status, protocol: row.protocol, protocolMismatch: row.protocol !== null && activeProtocol != null && row.protocol !== activeProtocol, kind, exactTime: exact.toISOString(), displayBarTime: null, price, size, coordinateBasis: useFill ? "venue_fill" : "recorded_execution", netPnl, accountingStatus: netPnl === null ? "accounting unavailable" : "resolved", feeTruthStatus: row.feeTruthStatus, pairingStatus: "unproven" };
}
/** Align to actual returned candle opens, including venue-offset daily bars. */
export function alignChartExecutions(executions: ChartExecution[], candles: readonly {time:number}[], barMs: number): ChartExecution[] {
  const opens = candles.map(c => c.time * 1000);
  return executions.map(row => {
    const exact = Date.parse(row.exactTime);
    let low = 0, high = opens.length;
    while (low < high) { const mid = (low + high) >>> 1; if (opens[mid] <= exact) low = mid + 1; else high = mid; }
    const open = opens[low - 1];
    return { ...row, displayBarTime: open !== undefined && exact < open + barMs ? new Date(open).toISOString() : null };
  });
}
/** One neutral histogram column per occupied candle bar; no holding duration is inferred. */
export function chartPairingPlaceholders(executions: ChartExecution[]): { executions: ChartExecution[]; bands: ChartBand[] } {
  const byBar = new Map<string, ChartBand>();
  for (const row of executions) {
    if (row.displayBarTime === null) continue;
    const band = byBar.get(row.displayBarTime);
    if (band) band.rowIds.push(row.id);
    else byBar.set(row.displayBarTime, { barTime: row.displayBarTime, rowIds: [row.id], pairingStatus: "unproven" });
  }
  return { executions, bands: [...byBar.values()].sort((a, b) => a.barTime.localeCompare(b.barTime)) };
}
export function assertSingleChartMarket(expected: string, markets: readonly string[]): void {
  if (markets.some(m => m !== expected)) throw Object.assign(new Error("Stored market differs from bot market"), { code: "MARKET_INVARIANT_VIOLATION" });
}

/** The 251st SQL row is lookahead; the cursor is the last of 250 scanned rows. */
export function chartScannedPage<T extends { id: string; executedAt: Date }>(rows: T[]) {
  const scanned = rows.slice(0, 250);
  return { scanned, complete: rows.length <= 250, lastScanned: scanned.at(-1) ?? null };
}

/** Postgres aggregates have no column decoder and may arrive as strings. */
export function chartFirstTradeTime(value: Date | string | null | undefined): string | null {
  return validTime(value)?.toISOString() ?? null;
}

export function chartOpenPosition(position: Pick<BotPosition, "baseSize" | "avgEntryPrice"> | undefined) {
  if (!position) return null;
  const parsedSize = position.baseSize == null || position.baseSize === "" ? NaN : Number(position.baseSize);
  if (parsedSize === 0) return null;
  return {
    size: Number.isFinite(parsedSize) ? parsedSize : null,
    entryPrice: positive(position.avgEntryPrice),
    attribution: "entry attribution unproven",
    unrealizedPnl: null,
  };
}

/** Admit one known direct perpetual series; never bridge an internal candle gap. */
export function chartPriceSeries(fetched: readonly ProvenancedOHLCV[], timeframe: "1d" | "4h") {
  const barMs = timeframe === "1d" ? 86_400_000 : 14_400_000;
  const budget = timeframe === "1d" ? 120 : 720;
  const empty = { candles: [] as Array<{ time: number; open: number; high: number; low: number; close: number }>, provenance: null };
  if (!fetched.length || fetched.length > budget) return empty;
  const first = fetched[0].provenance;
  if (!first || !["okx", "gate", "hyperliquid"].includes(first.source) || !["okx", "gate", "hyperliquid"].includes(first.venue) || first.basis !== "perp" || first.proxy !== "direct" || first.timeSemantic !== "open_time") return empty;
  const usable = fetched.every((c, i) => {
    const p = c.provenance;
    return p && p.source === first.source && p.venue === first.venue && p.basis === first.basis && p.proxy === first.proxy && p.timeSemantic === "open_time" && ["finalized", "forming"].includes(p.finality)
      && Number.isFinite(c.time) && c.time % 1000 === 0
      && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0)
      && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close)
      && (i === 0 || c.time - fetched[i - 1].time === barMs);
  });
  if (!usable) return empty;
  return {
    candles: fetched.map(c => ({ time: c.time / 1000, open: c.open, high: c.high, low: c.low, close: c.close })),
    provenance: { source: first.source, venue: first.venue, basis: first.basis, proxy: first.proxy, timeSemantic: first.timeSemantic },
  };
}
