import type { BotTrade, BotPosition } from "@shared/schema";
import type { ProvenancedOHLCV } from "../lab/datafeed";
import { resolveBotTradeNetPnl } from "./bot-trade-pnl-convention";
export type ChartTradePair = { entryId: string; exitId: string; direction: "Long" | "Short"; entryTime: string; exitTime: string; entryPrice: number; exitPrice: number; size: number; addCount: number; liquidated: boolean; netPnl: number; pnlPercent: number; timeHeldMs: number; pairingStatus: "sequential" };
export type ChartExecution = { id: string; market: string; side: string; status: string; protocol: string | null; protocolMismatch: boolean; kind: "entry" | "close" | "unknown"; exactTime: string; displayBarTime: string | null; price: number; size: number; coordinateBasis: "venue_fill" | "recorded_execution"; netPnl: number | null; accountingStatus: "resolved" | "accounting unavailable"; feeTruthStatus: string; pairingStatus: "unproven" | "sequential"; pair?: ChartTradePair };
export type ChartBand = { barTime: string; rowIds: string[]; pairingStatus: "unproven" };
const positive = (v: string | number | null | undefined) => v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v);
const validTime = (v: Date | string | null | undefined) => { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d : null; };
function chartExecutionKind(row: BotTrade): ChartExecution["kind"] {
  const payload = row.webhookPayload as { data?: { action?: string }; action?: string; closeReason?: string; reconciled?: boolean; closeAccounting?: { kind?: string } } | null;
  const actionValue = payload?.data?.action ?? payload?.action;
  const side = row.side.toUpperCase(), action = typeof actionValue === "string" ? actionValue.toLowerCase() : "";
  const canonicalClose = row.pnl != null || payload?.closeAccounting?.kind === "unavailable";
  return canonicalClose || side === "CLOSE" || action === "close" || !!payload?.closeReason || row.status === "liquidated" ? "close" : row.executionMethod === "on-chain-detected" || payload?.reconciled === true ? "unknown" : ["LONG", "SHORT", "BUY", "SELL"].includes(side) ? "entry" : "unknown";
}
export function toChartExecution(row: BotTrade, timeframe: "1d" | "4h", activeProtocol?: string | null): ChartExecution | null {
  if (!["executed", "liquidated", "recovered"].includes(row.status)) return null;
  const filled = validTime(row.filledAt), recorded = validTime(row.executedAt);
  const fillPrice = positive(row.averageFillPrice), fillSize = positive(row.filledSizeBase);
  const useFill = filled !== null && fillPrice !== null && fillSize !== null;
  const exact = useFill ? filled : recorded, price = useFill ? fillPrice : positive(row.price), size = useFill ? fillSize : positive(row.size);
  if (!exact || price === null || size === null) return null;
  const kind = chartExecutionKind(row);
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
/** Display-only flat-to-flat sequencing over ALL retained rows, before paging.
 * Invalid coordinates/accounting taint only the current position. Keep counting
 * known quantities so a flat boundary can restore pairing for the next trade.
 */
export function pairChartTradeHistory(rows: BotTrade[], timeframe: "1d" | "4h", activeProtocol?: string | null) {
  const history = rows.filter(row => ["executed", "liquidated", "recovered"].includes(row.status))
    .map(row => ({ row, execution: toChartExecution(row, timeframe, activeProtocol) }));
  const executions = history.flatMap(item => item.execution ? [item.execution] : []);
  const pairs: ChartTradePair[] = [];
  const time = (item: typeof history[number]) => item.execution ? Date.parse(item.execution.exactTime) : validTime(item.row.executedAt)?.getTime();
  if (history.some(item => time(item) === undefined)) return { executions, pairs };
  // Ambiguous tied events remain neutral; count opens before closes to recover their net
  // flat boundary without treating the arbitrary ID order as trade evidence.
  history.sort((a, b) => time(a)! - time(b)! || Number(chartExecutionKind(b.row) === "entry") - Number(chartExecutionKind(a.row) === "entry") || a.row.id.localeCompare(b.row.id));
  type Position = { entry: ChartExecution | null; balance: number | null; size: number; notional: number; netPnl: number; addCount: number; tainted: boolean; members: ChartExecution[] };
  const positions = new Map<string, Position>();
  const streamKey = (row: BotTrade) => JSON.stringify([row.market, row.protocol ?? null]);
  const direction = (row: BotTrade) => ["LONG", "BUY"].includes(row.side.toUpperCase()) ? 1 : -1;
  const tied = new Map<string, { count: number; entryDirection: number | null }>();
  for (const item of history) {
    const key = `${streamKey(item.row)}:${time(item)}`;
    const entryDirection = chartExecutionKind(item.row) === "entry" ? direction(item.row) : null;
    const group = tied.get(key);
    if (!group) tied.set(key, { count: 1, entryDirection });
    else { group.count++; if (entryDirection !== group.entryDirection) group.entryDirection = null; }
  }
  const sameSize = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(Math.abs(a), Math.abs(b));
  for (let i = 0; i < history.length; i++) {
    const { row, execution } = history[i];
    const kind = chartExecutionKind(row);
    const key = streamKey(row);
    const prior = positions.get(key);
    const position: Position = prior ?? { entry: execution, balance: 0, size: 0, notional: 0, netPnl: 0, addCount: 0, tainted: false, members: [] };
    positions.set(key, position);
    const group = tied.get(`${key}:${time(history[i])}`)!;
    // Same-direction simultaneous adds have the same weighted entry and time
    // in either order. Mixed events or closes do not establish a final exit.
    const simultaneous = group.count > 1 && group.entryDirection === null;
    // Size remains useful even when a bad price prevents a drawable execution.
    const size = execution?.size ?? positive(row.filledSizeBase ?? row.size);
    if (execution) position.members.push(execution);
    position.tainted ||= !execution || simultaneous;
    // A partially filled order without usable fill coordinates does not tell us
    // how much of its requested size actually changed the position.
    if (positive(row.remainingSizeBase) !== null && execution?.coordinateBasis !== "venue_fill") {
      position.tainted = true;
      position.balance = null;
    }
    if (kind === "unknown" || size === null) {
      position.tainted = true;
      position.balance = null;
    } else if (kind === "entry") {
      const sign = direction(row);
      if (prior) position.addCount++;
      if (position.balance !== null) {
        if (position.balance !== 0 && Math.sign(position.balance) !== sign) position.tainted = true;
        const delta = sign * size;
        position.balance = sameSize(-position.balance, delta) ? 0 : position.balance + delta;
      }
      position.size += size;
      position.notional += size * (execution?.price ?? NaN);
    } else {
      if (!prior) position.balance = null; // An orphan may be only a partial close.
      if (position.balance !== null) {
        const remaining = Math.abs(position.balance);
        position.balance = sameSize(size, remaining) ? 0 : size < remaining ? Math.sign(position.balance) * (remaining - size) : null;
      }
      if (execution?.netPnl == null) position.tainted = true;
      else position.netPnl += execution.netPnl;
    }
    if (position.balance !== null && !Number.isFinite(position.balance)) position.balance = null;
    if (position.balance === null) position.tainted = true;
    // These reconciler reasons are written only for a confirmed full close.
    // remainingSizeBase is an ORDER remainder, never a position-flat signal.
    const payload = row.webhookPayload as { reconciled?: boolean; closeReason?: string; partialCloseAccounting?: unknown } | null;
    const reconciledFlat = kind === "close" && payload?.reconciled === true && !payload.partialCloseAccounting
      && ["external_close", "tpsl", "liquidation"].includes(payload.closeReason ?? "");
    if (position.balance !== 0 && !reconciledFlat) continue;
    const { entry, notional, netPnl } = position;
    const pnlPercent = netPnl / notional * 100;
    if (position.balance === 0 && !position.tainted && entry && execution && kind === "close" && notional > 0 && Number.isFinite(notional) && Number.isFinite(pnlPercent)) {
      const pair: ChartTradePair = {
        entryId: entry.id, exitId: execution.id, direction: ["LONG", "BUY"].includes(entry.side.toUpperCase()) ? "Long" : "Short",
        entryTime: entry.exactTime, exitTime: execution.exactTime, entryPrice: notional / position.size, exitPrice: execution.price,
        size: position.size, addCount: position.addCount, liquidated: execution.status === "liquidated", netPnl, pnlPercent, timeHeldMs: Date.parse(execution.exactTime) - Date.parse(entry.exactTime), pairingStatus: "sequential",
      };
      for (const member of position.members) { member.pairingStatus = "sequential"; member.pair = pair; }
      pairs.push(pair);
    }
    positions.delete(key);
  }
  return { executions, pairs };
}

/** One neutral histogram column per occupied candle bar for unpaired executions. */
export function chartPairingPlaceholders(executions: ChartExecution[]): { executions: ChartExecution[]; bands: ChartBand[] } {
  const byBar = new Map<string, ChartBand>();
  for (const row of executions) {
    if (row.displayBarTime === null || row.pairingStatus === "sequential") continue;
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
