/**
 * READ-ONLY parity diff CLI.
 *
 * Loads a fixture under server/lab/pine/fixtures/<name>/, fetches candles via
 * the existing datafeed, runs the Pine engine, and prints a diff against the
 * captured TradingView export.
 *
 * Does NOT modify runtime.ts / compiler.ts / indicators.ts / engine.ts.
 * Does NOT write fixtures. Does NOT touch the DB beyond candle cache reads.
 *
 * Usage:
 *   tsx server/lab/pine/parity-diff.ts <fixture-name> [--bars N] [--trades N]
 *
 * Example:
 *   tsx server/lab/pine/parity-diff.ts golden-001 --trades 20
 */

import fs from "node:fs";
import path from "node:path";
import { compilePine, runPineBacktest } from "./index.js";
import type { OHLCV, PineEngineConfig } from "./runtime.js";
import { fetchOHLCV } from "../datafeed.js";
import { getCachedCandles, saveCandlesToDb } from "../candle-store.js";

interface TvTradeRow {
  num: number;
  kind: "Entry long" | "Exit long" | "Entry short" | "Exit short" | string;
  time: number;
  signal: string;
  price: number;
  qty: number;
  netPnlUsdt: number;
  netPnlPct: number;
}

interface FixtureSummary {
  symbol: string;
  timeframe: string;
  trading_range: string;
  backtesting_range: string;
  initial_capital: number;
  net_profit_usdt: number;
  net_profit_pct: number;
  profit_factor: number;
  percent_profitable: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  avg_bars_in_trades: number;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else positional.push(a);
  }
  return {
    fixture: positional[0],
    showTrades: parseInt(flags.trades ?? "10", 10),
    forceBars: flags.bars ? parseInt(flags.bars, 10) : undefined,
  };
}

function tvSymbolToCcxt(tvSym: string): string {
  // OKX:ETHUSDT.P -> ETH/USDT:USDT
  const stripped = tvSym.replace(/^[A-Z]+:/, "").replace(/\.P$/, "");
  const m = stripped.match(/^([A-Z0-9]+?)(USDT|USDC|USD|BUSD)$/);
  if (!m) return stripped;
  const [, base, quote] = m;
  return `${base}/${quote}:${quote}`;
}

function tvTimeframeToCcxt(tf: string): string {
  const s = tf.toLowerCase().trim();
  if (s.includes("hour")) return s.startsWith("1") ? "1h" : `${parseInt(s, 10)}h`;
  if (s.includes("minute")) return `${parseInt(s, 10)}m`;
  if (s.includes("day")) return `${parseInt(s, 10) || 1}d`;
  return s;
}

function readCsv(filePath: string): string[][] {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQ) {
      if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { cur.push(field); field = ""; }
      else if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (ch === "\r") { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function loadTvTrades(csvPath: string): TvTradeRow[] {
  const rows = readCsv(csvPath);
  const header = rows.shift();
  if (!header) return [];
  const idx = (name: string) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const iNum = idx("Trade #");
  const iType = idx("Type");
  const iTime = idx("Date and time");
  const iSig = idx("Signal");
  const iPrice = idx("Price USDT");
  const iQty = idx("Size (qty)");
  const iPnlU = idx("Net P&L USDT");
  const iPnlP = idx("Net P&L %");
  const out: TvTradeRow[] = [];
  for (const r of rows) {
    if (!r[iNum]) continue;
    const num = parseInt(r[iNum], 10);
    if (!Number.isFinite(num)) continue;
    const t = new Date(r[iTime]).getTime();
    out.push({
      num,
      kind: r[iType],
      time: t,
      signal: r[iSig] ?? "",
      price: parseFloat(r[iPrice]),
      qty: parseFloat(r[iQty]),
      netPnlUsdt: parseFloat(r[iPnlU]),
      netPnlPct: parseFloat(r[iPnlP]),
    });
  }
  return out;
}

/** Collapse TV's per-fill rows into one row per position (entry → final exit). */
interface TvPosition {
  num: number;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number; // weighted by qty
  totalQty: number;
  netPnlPct: number;
  reasons: string[];
}
function collapseTvPositions(rows: TvTradeRow[]): TvPosition[] {
  // Group by trade num; TV gives entry + exit per fill, multiple fills share num within one position-event
  // but actually each fill has its own num. We group by (entryTime, direction).
  const byKey = new Map<string, TvTradeRow[]>();
  for (const r of rows) {
    // Find paired entry for each exit by looking at the same #
    // Actually rows come paired by trade# already: pairs of (exit, entry) per #.
    // We instead group by entryTime so partial closes of one position merge.
    if (r.kind.startsWith("Entry")) {
      const dir = r.kind.endsWith("long") ? "long" : "short";
      const k = `${r.entryTime ?? r.time}|${dir}|${r.num}`;
      const arr = byKey.get(k) ?? [];
      arr.push(r);
      byKey.set(k, arr);
    }
  }
  // Simpler: collapse by (direction, entryTime) using entry rows; pair to exit by num.
  const entries = rows.filter(r => r.kind.startsWith("Entry"));
  const exits = rows.filter(r => r.kind.startsWith("Exit"));
  const exitByNum = new Map<number, TvTradeRow>();
  for (const e of exits) exitByNum.set(e.num, e);

  const positions = new Map<string, TvPosition>();
  for (const en of entries) {
    const dir: "long" | "short" = en.kind.endsWith("long") ? "long" : "short";
    const k = `${en.time}|${en.price}|${dir}`;
    const ex = exitByNum.get(en.num);
    const exTime = ex?.time ?? en.time;
    const exPrice = ex?.price ?? en.price;
    const qty = en.qty;
    const pos = positions.get(k);
    if (!pos) {
      positions.set(k, {
        num: en.num, direction: dir,
        entryTime: en.time, entryPrice: en.price,
        exitTime: exTime, exitPrice: exPrice * qty,
        totalQty: qty,
        netPnlPct: en.netPnlPct,
        reasons: [ex?.signal ?? "?"],
      });
    } else {
      pos.exitTime = Math.max(pos.exitTime, exTime);
      pos.exitPrice += exPrice * qty;
      pos.totalQty += qty;
      pos.netPnlPct += en.netPnlPct;
      pos.reasons.push(ex?.signal ?? "?");
    }
  }
  const out = [...positions.values()].sort((a, b) => a.entryTime - b.entryTime);
  for (const p of out) p.exitPrice = p.exitPrice / Math.max(p.totalQty, 1e-9);
  return out;
}

async function getCandles(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<OHLCV[]> {
  const cached = await getCachedCandles(symbol, timeframe, startMs, endMs);
  if (cached && cached.length > 50) {
    console.log(`[candles] cache hit ${cached.length} bars ${symbol} ${timeframe}`);
    return cached as OHLCV[];
  }
  console.log(`[candles] cache miss — fetching from exchange...`);
  const fresh: any = await (fetchOHLCV as any)(symbol, timeframe, startMs, endMs);
  if (fresh && fresh.length) await saveCandlesToDb(symbol, timeframe, fresh);
  return (fresh ?? []) as OHLCV[];
}

function pad(s: any, w: number, right = false): string {
  const x = String(s);
  return right ? x.padStart(w) : x.padEnd(w);
}

function pctDiff(a: number, b: number): string {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "n/a";
  if (b === 0) return a === 0 ? "0.00%" : "inf";
  return `${(((a - b) / Math.abs(b)) * 100).toFixed(2)}%`;
}

async function main() {
  const { fixture, showTrades } = parseArgs();
  if (!fixture) {
    console.error("Usage: tsx server/lab/pine/parity-diff.ts <fixture-name> [--trades N]");
    process.exit(2);
  }
  const root = path.resolve(__dirname, "fixtures", fixture);
  if (!fs.existsSync(root)) { console.error(`Fixture not found: ${root}`); process.exit(2); }

  const summary: FixtureSummary = JSON.parse(fs.readFileSync(path.join(root, "tv-summary.json"), "utf8"));
  const params = JSON.parse(fs.readFileSync(path.join(root, "params.json"), "utf8"));
  const script = fs.readFileSync(path.join(root, "script.pine"), "utf8");
  const tvRowsRaw = loadTvTrades(path.join(root, "tv-trades.csv"));
  const tvPositions = collapseTvPositions(tvRowsRaw);

  const symbol = tvSymbolToCcxt(summary.symbol);
  const timeframe = tvTimeframeToCcxt(summary.timeframe);
  console.log(`\n=== Parity diff: fixture '${fixture}' ===`);
  console.log(`Symbol:    ${summary.symbol}  →  ${symbol}`);
  console.log(`Timeframe: ${summary.timeframe}  →  ${timeframe}`);
  console.log(`TV trading range: ${summary.trading_range}`);
  console.log(`TV position events (collapsed from ${tvRowsRaw.length} fill-rows): ${tvPositions.length}`);

  // Derive candle window from backtesting range.
  // Format: "Dec 31, 2022, 11:00 — May 20, 2026, 10:00"
  const [startStr, endStr] = (summary.backtesting_range || "").split("—").map(s => s.trim());
  const startMs = startStr ? Date.parse(startStr.replace(",", "")) : Date.UTC(2022, 11, 31);
  const endMs = endStr ? Date.parse(endStr.replace(",", "")) : Date.now();
  console.log(`Candle window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);

  const candles = await getCandles(symbol, timeframe, startMs, endMs);
  if (!candles.length) { console.error("No candles available"); process.exit(3); }
  console.log(`Loaded ${candles.length} candles (first ${new Date(candles[0].time).toISOString()}, last ${new Date(candles[candles.length - 1].time).toISOString()})`);

  const config: PineEngineConfig = {
    initialCapital: Number(summary.initial_capital) || 100,
    commission: 0.001, // 0.10% per Properties
    positionSize: 100, // $100 cash per entry per TV `default_qty_value=100`
    processOrdersOnClose: false,
  };

  const plan = compilePine(script);
  const t0 = Date.now();
  const result = runPineBacktest(plan, candles, params, symbol, timeframe, config);
  const ms = Date.now() - t0;

  // -- Headline metrics
  const ours = {
    totalTrades: result.totalTrades,
    netPct: result.netProfitPercent,
    winRate: result.winRatePercent,
    pf: result.profitFactor,
    dd: result.maxDrawdownPercent,
  };
  const tv = {
    totalTrades: tvPositions.length,
    netPct: Number(summary.net_profit_pct),
    winRate: Number(summary.percent_profitable),
    pf: Number(summary.profit_factor),
  };

  console.log(`\n--- Headline metrics (collapsed by position event) ---`);
  console.log(`Path used: ${result.compiledPath ?? "?"}  |  Engine time: ${ms} ms`);
  console.log(`${pad("Metric", 18)} ${pad("TV", 14, true)} ${pad("Ours", 14, true)} ${pad("Δ", 14, true)}`);
  console.log("-".repeat(64));
  const fmtRow = (name: string, t: number, o: number) =>
    console.log(`${pad(name, 18)} ${pad(t.toFixed(2), 14, true)} ${pad(o.toFixed(2), 14, true)} ${pad(pctDiff(o, t), 14, true)}`);
  fmtRow("Total trades", tv.totalTrades, ours.totalTrades);
  fmtRow("Net %",        tv.netPct,      ours.netPct);
  fmtRow("Win rate %",   tv.winRate,     ours.winRate);
  fmtRow("Profit factor",tv.pf,          ours.pf);
  console.log(`${pad("Max DD %", 18)} ${pad("(not in TV export)", 14, true)} ${pad(ours.dd.toFixed(2), 14, true)} ${pad("—", 14, true)}`);

  // -- First-N trade-by-trade diff
  const ourTrades = result.trades;
  const k = Math.min(showTrades, Math.max(ourTrades.length, tvPositions.length));
  console.log(`\n--- First ${k} position events (entry-time order) ---`);
  console.log(`${pad("#",3)} ${pad("dir",5)} ${pad("TV entry",10,true)} ${pad("our entry",10,true)} ${pad("TV exit",10,true)} ${pad("our exit",10,true)} ${pad("TV %",8,true)} ${pad("our %",8,true)} ${pad("match",5,true)}`);
  console.log("-".repeat(78));
  for (let i = 0; i < k; i++) {
    const t = tvPositions[i];
    const o = ourTrades[i];
    if (t && o) {
      const enClose = Math.abs(t.entryPrice - o.entryPrice) < t.entryPrice * 0.005;
      const exClose = Math.abs(t.exitPrice - o.exitPrice) < t.exitPrice * 0.005;
      const pnlClose = Math.abs(t.netPnlPct - o.pnlPercent) < 1;
      const m = enClose && exClose && pnlClose ? "OK" : "DIFF";
      console.log(`${pad(i+1,3)} ${pad(o.direction,5)} ${pad(t.entryPrice.toFixed(2),10,true)} ${pad(o.entryPrice.toFixed(2),10,true)} ${pad(t.exitPrice.toFixed(2),10,true)} ${pad(o.exitPrice.toFixed(2),10,true)} ${pad(t.netPnlPct.toFixed(2),8,true)} ${pad(o.pnlPercent.toFixed(2),8,true)} ${pad(m,5,true)}`);
    } else if (t) {
      console.log(`${pad(i+1,3)} ${pad(t.direction,5)} ${pad(t.entryPrice.toFixed(2),10,true)} ${pad("MISSING",10,true)} ${pad(t.exitPrice.toFixed(2),10,true)} ${pad("MISSING",10,true)} ${pad(t.netPnlPct.toFixed(2),8,true)} ${pad("—",8,true)} ${pad("MISS",5,true)}`);
    } else if (o) {
      console.log(`${pad(i+1,3)} ${pad(o.direction,5)} ${pad("EXTRA",10,true)} ${pad(o.entryPrice.toFixed(2),10,true)} ${pad("EXTRA",10,true)} ${pad(o.exitPrice.toFixed(2),10,true)} ${pad("—",8,true)} ${pad(o.pnlPercent.toFixed(2),8,true)} ${pad("EXTRA",5,true)}`);
    }
  }

  console.log(`\nDone.`);
}

main().catch(e => { console.error(e); process.exit(1); });
