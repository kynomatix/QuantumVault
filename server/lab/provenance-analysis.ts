import type { LabTradeRecord, BotTrade } from '../../shared/schema';

export interface LabSignal { time: number; action: 'buy' | 'sell'; price: number | null }
export interface SignalComparison {
  matched: number; signals: number; percent: number | null;
  range: { start: string; end: string }; toleranceSeconds: number;
}
export function timeframeMs(timeframe: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(timeframe);
  return match ? Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]] ?? 0) : 0;
}
export function webhookSignals(rows: { payload: unknown; receivedAt: Date }[]): LabSignal[] {
  return rows.flatMap(row => {
    const p = row.payload as Record<string, unknown> | null;
    if (!p || !['buy', 'sell'].includes(String(p.action).toLowerCase())) return [];
    const raw = p.time;
    const time = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
    const price = Number(p.price);
    return [{ time: Number.isFinite(time) ? time : row.receivedAt.getTime(), action: String(p.action).toLowerCase() as 'buy' | 'sell',
      price: p.price != null && Number.isFinite(price) && price > 0 ? price : null }];
  }).sort((a, b) => a.time - b.time).filter((s, i, all) => i === 0 || s.time !== all[i - 1].time || s.action !== all[i - 1].action);
}

/** One expected order can explain at most one actual signal. Exits reverse the entry action. */
export function compareLabSignals(signals: LabSignal[], trades: LabTradeRecord[], timeframe: string, start: number, end: number): SignalComparison {
  const tolerance = Math.min(5 * 60_000, Math.max(30_000, timeframeMs(timeframe) * 0.1));
  const orders = trades.flatMap(t => [
    { time: Date.parse(t.entryTime), action: t.direction === 'long' ? 'buy' : 'sell' },
    { time: Date.parse(t.exitTime), action: t.direction === 'long' ? 'sell' : 'buy' },
  ]).filter(t => Number.isFinite(t.time) && t.time >= start && t.time <= end).sort((a, b) => a.time - b.time);
  const window = signals.filter(s => s.time >= start && s.time <= end);
  const used = new Set<number>();
  let matched = 0;
  for (const s of window) {
    let best = -1, distance = Infinity;
    let lo = 0, hi = orders.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (orders[mid].time < s.time - tolerance) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < orders.length && orders[i].time <= s.time + tolerance; i++) {
      const o = orders[i], d = Math.abs(o.time - s.time);
      if (!used.has(i) && o.action === s.action && d < distance) { best = i; distance = d; }
    }
    if (best >= 0) { used.add(best); matched++; }
  }
  return { matched, signals: window.length, percent: window.length ? matched / window.length * 100 : null,
    range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, toleranceSeconds: tolerance / 1000 };
}

function number(v: unknown): number | null { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
export function liveTradeSummary(rows: BotTrade[]) {
  const live = rows.filter(t => ['drift', 'pacifica', 'phoenix'].includes(t.protocol ?? '') && t.status === 'executed');
  const omitted = rows.length - live.length;
  const feesKnown = live.length > 0 && live.every(t => ['current_pipeline', 'venue_exact_repaired'].includes(t.feeTruthStatus ?? '') && number(t.fee) !== null);
  const closes = live.filter(t => number(t.pnl) !== null);
  const pnlKnown = closes.length > 0 && closes.every(t => t.pnlConvention === 'net_of_close_fee');
  const slippages = live.flatMap(t => {
    const p = t.webhookPayload as Record<string, unknown> | null;
    const signalPrice = number(p?.price), fill = number(t.averageFillPrice ?? t.price);
    const action = String(p?.action).toLowerCase();
    return signalPrice !== null && signalPrice > 0 && fill !== null && ['buy', 'sell'].includes(action)
      ? [(fill - signalPrice) / signalPrice * 10_000 * (action === 'buy' ? 1 : -1)] : [];
  });
  return { liveFills: live.length, omitted, closedPnlRecords: closes.length,
    winRatePercent: pnlKnown ? closes.filter(t => Number(t.pnl) > 0).length / closes.length * 100 : null,
    pnlUsdc: pnlKnown ? closes.reduce((n, t) => n + Number(t.pnl), 0) : null,
    feesUsdc: feesKnown ? live.reduce((n, t) => n + Number(t.fee), 0) : null,
    slippageBps: slippages.length ? slippages.reduce((a, b) => a + b, 0) / slippages.length : null,
    slippageSamples: slippages.length, funding: 'unknown' as const };
}
