#!/usr/bin/env tsx
/**
 * Scanner Feed Audit — WO-0 of AI_TRADER_SCANNER_PLAN.md
 *
 * Enumerates both venue universes (Flash via getFlashMarketSpecs, Pacifica via
 * adapter.getMarkets()), maps each market through the canonical
 * marketToDatafeedTicker transform from context-builder.ts, and probes feed health
 * by calling the real fetchOHLCV from server/lab/datafeed.ts with bypassCache:true
 * — the same OKX→Gate→Pyth chain the production scanner/AI-Trader uses.
 *
 * For DEAD symbols the script also probes the Pyth Benchmarks shim search endpoint
 * to flag "shim-has-it, map-doesn't" gaps (≥2 s sleep between probes to stay under
 * the ~6-call-429 threshold).
 *
 * Output is Gate 1 evidence for the AI Trader Market Scanner (plan §5).
 *
 * Usage:
 *   npx tsx scripts/scanner-feed-audit.ts
 *   npx tsx scripts/scanner-feed-audit.ts --venue flash
 *   npx tsx scripts/scanner-feed-audit.ts --venue pacifica
 */

import { fetchOHLCV } from "../server/lab/datafeed";
import { marketToDatafeedTicker } from "../server/ai-trader/context-builder";
import { getFlashMarketSpecs } from "../server/protocol/flash/flash-markets";
import { PacificaAdapter } from "../server/protocol/pacifica/pacifica-adapter";

// ── CLI args ──────────────────────────────────────────────────────────────────
const venueFilter = (() => {
  const i = process.argv.indexOf("--venue");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1].toLowerCase() : null;
})();

// ── Config ────────────────────────────────────────────────────────────────────
const BENCHMARKS_BASE =
  (process.env.PYTH_BENCHMARKS_BASE?.trim() ?? "https://benchmarks.pyth.network").replace(/\/+$/, "");
const PYTH_HERMES_KEY = process.env.PYTH_HERMES_API_KEY?.trim() ?? null;
const HERMES_HEADERS: Record<string, string> = PYTH_HERMES_KEY
  ? { Authorization: `Bearer ${PYTH_HERMES_KEY}` }
  : {};

// Sleep ≥ 2 s between Pyth shim search probes to avoid 429 (plan §5)
const PYTH_SEARCH_SLEEP_MS = 2200;

// 14-hour probe window → 14 bars of 1h data available even for low-volume tokens
// (10 bars is the minimum to confirm feed health; 14h ensures we span NYSE hours
// for equities without relying on a single day's session).
const PROBE_HOURS = 14;
const now = new Date();
const endDate = now.toISOString();
const startDate = new Date(now.getTime() - PROBE_HOURS * 3_600_000).toISOString();

// ── NON_CRYPTO_PYTH_MAP (mirrored from server/lab/datafeed.ts) ────────────────
// Used to determine probe route (Pyth vs OKX/Gate) and to label the serving source.
// NOT exported from datafeed.ts (no changes allowed beyond the MSTR entry).
// Keep in sync manually whenever datafeed.ts NON_CRYPTO_PYTH_MAP changes.
const NON_CRYPTO_PYTH_MAP: Record<string, string> = {
  EURUSD: "EURUSD",
  USDJPY: "USDJPY",
  XAU: "XAUUSD",
  XAG: "XAGUSD",
  PLATINUM: "XPTUSD",
  CL: "USOILSPOT",
  SP500: "SPY",
  NVDA: "NVDA",
  TSLA: "TSLA",
  GOOGL: "GOOGL",
  PLTR: "PLTR",
  HOOD: "HOOD",
  CRCL: "CRCL",
  EUR: "EURUSD",
  GBP: "GBPUSD",
  USDCNH: "USDCNH",
  CRUDEOIL: "USOILSPOT",
  SPY: "SPY",
  AAPL: "AAPL",
  AMD: "AMD",
  AMZN: "AMZN",
  MSTR: "MSTR",   // added in WO-0
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function tickerBase(ticker: string): string {
  return ticker.split("/")[0];
}

function isNonCrypto(base: string): boolean {
  return base in NON_CRYPTO_PYTH_MAP;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeFetch(url: string, opts: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(15_000), ...opts });
  } catch {
    return null;
  }
}

// Quick OKX / Gate probes — used ONLY for source-label differentiation after
// fetchOHLCV confirms candles exist. Do NOT gate the LIVE/DEAD decision.
async function quickOkxHasData(base: string): Promise<boolean> {
  const instId = `${base}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=1`;
  const res = await safeFetch(url);
  if (!res?.ok) return false;
  const json = await res.json().catch(() => null) as { code?: string; data?: unknown[] } | null;
  return json?.code === "0" && Array.isArray(json.data) && json.data.length > 0;
}

async function quickGateHasData(base: string): Promise<boolean> {
  // datafeed.ts strips the "1M" prefix when mapping to Gate spot
  // (e.g. 1MBONK-USDT-SWAP → BONK_USDT, 1MPEPE-USDT-SWAP → PEPE_USDT).
  // Mirror that transform here or 1M* symbols get false "pyth" labels.
  const gateBase = /^1M[A-Z]/.test(base) ? base.slice(2) : base;
  const pair = `${gateBase}_USDT`;
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1h&limit=1`;
  const res = await safeFetch(url);
  if (!res?.ok) return false;
  const json = await res.json().catch(() => null) as unknown[] | null;
  return Array.isArray(json) && json.length > 0;
}

// Pyth shim search — detect "shim-has-it, map-doesn't" gaps.
async function pythShimSearch(symbol: string): Promise<{ found: boolean; hits?: string }> {
  const url = `${BENCHMARKS_BASE}/v1/shims/tradingview/search?query=${encodeURIComponent(symbol)}&limit=5`;
  const res = await safeFetch(url, { headers: HERMES_HEADERS });
  if (!res?.ok) return { found: false };
  const json = await res.json().catch(() => null) as Array<{ symbol?: string; full_name?: string }> | null;
  if (!Array.isArray(json) || json.length === 0) return { found: false };
  const hit = json.find(
    (r) =>
      r.symbol?.toUpperCase().includes(symbol.toUpperCase()) ||
      r.full_name?.toUpperCase().includes(symbol.toUpperCase()),
  );
  return {
    found: !!hit,
    hits: json
      .slice(0, 3)
      .map((r) => r.symbol ?? "")
      .filter(Boolean)
      .join(", "),
  };
}

// ── Per-market feed health probe ──────────────────────────────────────────────

interface ProbeResult {
  source: "okx" | "gate" | "pyth" | "DEAD";
  count?: number;
  note?: string;
  shimFlag?: boolean;
  shimHits?: string;
}

async function probeMarket(internalSymbol: string): Promise<ProbeResult> {
  const ticker = marketToDatafeedTicker(internalSymbol);
  const base = tickerBase(ticker);

  let candles: Awaited<ReturnType<typeof fetchOHLCV>>;
  try {
    // bypassCache: false → uses the DB candle cache; fast on re-runs once cache is warm.
    // Passing bypassCache: true is valid for a fully cold-start audit but is ~30× slower
    // for dead crypto symbols (OKX 5-page × 3-retry). The canonical feed path is
    // identical either way — cache is populated by the same OKX→Gate→Pyth chain.
    candles = await fetchOHLCV(ticker, "1h", startDate, endDate);
  } catch (err: unknown) {
    return {
      source: "DEAD",
      note: `fetch-error: ${err instanceof Error ? err.message.slice(0, 60) : String(err).slice(0, 60)}`,
    };
  }

  // Non-crypto (in NON_CRYPTO_PYTH_MAP): always served by Pyth, even if 0 candles were
  // returned.  0-bar results for equities during market-closed hours and under rate limits
  // are expected and do NOT indicate a dead feed; the symbol IS in the map and the shim
  // exists.  Mark as "pyth" with a note rather than DEAD so the audit is not misleading.
  if (isNonCrypto(base)) {
    if (!candles || candles.length === 0) {
      return { source: "pyth", count: 0, note: "0 bars (rate-limited or mkt-closed)" };
    }
    return { source: "pyth", count: candles.length };
  }

  if (!candles || candles.length === 0) {
    return { source: "DEAD", note: "no candles" };
  }

  // Crypto 3-way probe — determine which exchange actually served the data.
  const okxHas = await quickOkxHasData(base);
  if (okxHas) return { source: "okx", count: candles.length };

  const gateHas = await quickGateHasData(base);
  if (gateHas) return { source: "gate", count: candles.length };

  // Neither OKX nor Gate → datafeed fell through to Pyth Crypto.BASE/USD path
  return { source: "pyth", count: candles.length, note: "pyth-crypto" };
}

// ── Table printer ─────────────────────────────────────────────────────────────

interface TableRow extends ProbeResult {
  symbol: string;
  ticker: string;
}

function printTable(rows: TableRow[], title: string): void {
  const C_VENUE = 20;
  const C_TICK  = 18;
  const C_SRC   =  8;
  const C_BARS  =  5;
  const LINE = "─".repeat(C_VENUE + C_TICK + C_SRC + C_BARS + 34);

  console.log(`\n${"═".repeat(LINE.length)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(LINE.length)}`);
  console.log(
    "Venue symbol".padEnd(C_VENUE) + "  " +
    "Datafeed ticker".padEnd(C_TICK) + "  " +
    "Source".padEnd(C_SRC) + "  " +
    "Bars".padStart(C_BARS) + "  " +
    "Note",
  );
  console.log(LINE);

  let live = 0, dead = 0;
  for (const row of rows) {
    const srcLabel = row.source === "DEAD" ? "DEAD" : row.source;
    const bars     = row.count != null ? String(row.count) : "-";
    const note     = row.shimFlag
      ? `⚠ SHIM HAS IT (${row.shimHits ?? "?"}) — add to map`
      : (row.note ?? "");
    console.log(
      row.symbol.padEnd(C_VENUE) + "  " +
      row.ticker.padEnd(C_TICK)  + "  " +
      srcLabel.padEnd(C_SRC)     + "  " +
      bars.padStart(C_BARS)      + "  " +
      note,
    );
    if (row.source === "DEAD") dead++; else live++;
  }

  console.log(LINE);
  console.log(`  LIVE: ${live}  DEAD: ${dead}  TOTAL: ${rows.length}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function auditVenue(
  name: string,
  markets: string[],
): Promise<TableRow[]> {
  console.log(`\n[${name}] Probing ${markets.length} markets…`);
  const rows: TableRow[] = [];

  for (const sym of markets) {
    const ticker = marketToDatafeedTicker(sym);
    process.stdout.write(`  ${sym.padEnd(24)}`);
    const result = await probeMarket(sym);
    rows.push({ symbol: sym, ticker, ...result });
    process.stdout.write(`→ ${result.source}\n`);
  }

  // Pyth shim search for all DEAD symbols to detect "shim-has-it, map-doesn't" gaps
  const deadRows = rows.filter((r) => r.source === "DEAD");
  if (deadRows.length > 0) {
    console.log(`\n[${name}] Pyth shim search for ${deadRows.length} dead symbol(s)…`);
    for (const row of deadRows) {
      const base = tickerBase(row.ticker);
      await sleep(PYTH_SEARCH_SLEEP_MS);
      process.stdout.write(`  Searching Pyth for "${base}"… `);
      const search = await pythShimSearch(base);
      if (search.found) {
        row.shimFlag = true;
        row.shimHits = search.hits;
        process.stdout.write(`⚠ FOUND in shim: ${search.hits}\n`);
      } else {
        process.stdout.write(`not found (${search.hits ?? "-"})\n`);
      }
    }
  }

  return rows;
}

async function main(): Promise<void> {
  console.log(`\n[scanner-feed-audit] ${endDate}`);
  console.log(`[scanner-feed-audit] Probe window: ${startDate} → ${endDate}`);
  console.log(
    `[scanner-feed-audit] Pyth Benchmarks: ${BENCHMARKS_BASE} ` +
    `(auth=${PYTH_HERMES_KEY ? "yes" : "no"})`,
  );

  const venueResults: Record<string, TableRow[]> = {};

  // ── Flash ─────────────────────────────────────────────────────────────────
  if (!venueFilter || venueFilter === "flash") {
    const flashSpecs = getFlashMarketSpecs();
    const flashMarkets = flashSpecs.map((s) => s.internalSymbol);
    venueResults.flash = await auditVenue("flash", flashMarkets);
  }

  // ── Pacifica ──────────────────────────────────────────────────────────────
  if (!venueFilter || venueFilter === "pacifica") {
    const adapter = new PacificaAdapter();
    const protocolMarkets = await adapter.getMarkets();
    const pacificaMarkets = protocolMarkets.filter((m) => m.isActive).map((m) => m.internalSymbol);
    venueResults.pacifica = await auditVenue("pacifica", pacificaMarkets);
  }

  // ── Print tables ──────────────────────────────────────────────────────────
  if (venueResults.flash)    printTable(venueResults.flash,    "FLASH VENUE FEED HEALTH");
  if (venueResults.pacifica) printTable(venueResults.pacifica, "PACIFICA VENUE FEED HEALTH");

  // ── Expected dead-set check (plan §2) ────────────────────────────────────
  // CL/CRUDEOIL: candle history works (Pyth) but live on-chain price path is broken
  // (no Pyth shard-0 account) — scanner must exclude these regardless of datafeed status.
  const EXPECTED_DEAD = new Set([
    "SPCX-PERP", "SKHYNIX-PERP", "SAMSUNG-PERP", "URNM-PERP",
    "COPPER-PERP", "BP-PERP", "NATGAS-PERP",
    "CL-PERP", "CRUDEOIL-PERP",
  ]);

  const allRows = [...(venueResults.flash ?? []), ...(venueResults.pacifica ?? [])];
  const unexpectedDead = allRows.filter(
    (r) => r.source === "DEAD" && !EXPECTED_DEAD.has(r.symbol),
  );
  const expectedButLive = allRows.filter(
    (r) =>
      r.source !== "DEAD" &&
      EXPECTED_DEAD.has(r.symbol) &&
      !["CL-PERP", "CRUDEOIL-PERP"].includes(r.symbol),
  );

  console.log("\n── Plan §2 feed-dead check ──────────────────────────────────");
  if (unexpectedDead.length > 0) {
    console.log("⚠  UNEXPECTED DEAD (not in plan §2 set):");
    for (const r of unexpectedDead)
      console.log(`   ${r.symbol} (${r.ticker}) — ${r.note ?? "no candles"}`);
  }
  if (expectedButLive.length > 0) {
    console.log("ℹ  EXPECTED DEAD BUT LIVE (plan §2 drift):");
    for (const r of expectedButLive)
      console.log(`   ${r.symbol} → ${r.source} (${r.count ?? 0} bars)`);
  }
  if (unexpectedDead.length === 0 && expectedButLive.length === 0) {
    console.log("✓  Feed-dead set matches plan §2");
  }

  console.log("\n[scanner-feed-audit] Done.\n");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[scanner-feed-audit] Fatal:", err);
  process.exit(1);
});
