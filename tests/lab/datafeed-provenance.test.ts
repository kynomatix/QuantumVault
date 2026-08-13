import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const { mockGetCached, mockSave } = vi.hoisted(() => ({
  mockGetCached: vi.fn<(...args: any[]) => Promise<any[] | null>>(),
  mockSave: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../server/lab/candle-store", () => ({
  getCachedCandles: (...args: any[]) => mockGetCached(...args),
  saveCandlesToDb: (...args: any[]) => mockSave(...args),
  CACHE_BUDGET_ABORT_REASON: "candle-cache-budget-exceeded",
}));

import {
  AI_CONTEXT_CANDLE_POLICY,
  CHART_CANDLE_POLICY,
  LIVE_MONITOR_CANDLE_POLICY,
  MONEY_CANDLE_POLICY,
  PAPER_MONITOR_CANDLE_POLICY,
  aggregateCandles,
  candleMatchesBasisPolicy,
  fetchOHLCV,
  isCandleBasisUnavailableError,
  type ProvenancedOHLCV,
} from "../../server/lab/datafeed";

const TF_MS = 15 * 60 * 1000;

function okxRow(time: number, confirm?: "0" | "1"): string[] {
  const row = [String(time), "100", "101", "99", "100", "10", "10", "1000"];
  if (confirm !== undefined) row.push(confirm);
  return row;
}

function installOkxRows(rows: string[][]) {
  let served = false;
  const spy = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (!url.includes("okx.com")) throw new Error(`unexpected non-OKX source: ${url}`);
    const data = served ? [] : rows;
    served = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "0", data }),
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function fetchPolicy(symbol: string, policy = MONEY_CANDLE_POLICY) {
  const end = Date.now();
  const start = end - 4 * TF_MS;
  return fetchOHLCV(symbol, "15m", start, end, undefined, {
    basisPolicy: policy,
    bypassCache: true,
    skipSpotFallback: false,
  });
}

beforeEach(() => {
  mockGetCached.mockReset();
  mockGetCached.mockResolvedValue(null);
  mockSave.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOHLCV provenance admission", () => {
  it("requires every production caller to pass an explicit basisPolicy", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(path.join(root, "server"));
    walk(path.join(root, "scripts"));

    const violations: string[] = [];
    for (const file of files) {
      const sourceText = fs.readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        let expression = ts.isCallExpression(node) ? node.expression : undefined;
        while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression))) {
          expression = expression.expression;
        }
        if (ts.isCallExpression(node) && expression && ts.isIdentifier(expression) && expression.text === "fetchOHLCV") {
          const last = node.arguments.at(-1);
          const relative = path.relative(root, file).replaceAll("\\", "/");
          const internalRecursiveCall = relative === "server/lab/datafeed.ts" && last?.getText(source) === "options";
          const explicitPolicy = !!last && ts.isObjectLiteralExpression(last)
            && last.properties.some((property) => property.name?.getText(source) === "basisPolicy");
          if (!internalRecursiveCall && !explicitPolicy) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            violations.push(`${relative}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("keeps the five corrected diagnostic callers on typed v2 provenance paths", () => {
    const root = path.resolve(__dirname, "../..");
    const corrected = [
      "scripts/scanner-feed-audit.ts",
      "scripts/sweep-depth-analysis.ts",
      "scripts/zec-pattern-analysis.ts",
      "server/lab/pine/debug-gates.ts",
      "server/lab/pine/parity-diff.ts",
    ];
    for (const relative of corrected) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/\blab_candle_cache\b(?!_v2)/);
      expect(source, relative).not.toMatch(/fetchOHLCV\s+as\s+any/);
      expect(source, relative).toContain("candle-provenance");
    }
  });

  it("maps exact OKX confirm=1 to finalized direct perpetual open-time provenance", async () => {
    const now = Date.now();
    installOkxRows([okxRow(now - TF_MS, "1")]);
    const candles = await fetchPolicy("SOL/USDT:USDT");
    expect(candles).toHaveLength(1);
    expect(candles[0].provenance).toEqual({
      source: "okx",
      venue: "okx",
      basis: "perp",
      proxy: "direct",
      finality: "finalized",
      timeSemantic: "open_time",
    });
  });

  it("classifies a forming-only OKX response as nonfinalized_only for money input", async () => {
    installOkxRows([okxRow(Date.now() - TF_MS, "0")]);
    let error: unknown;
    try { await fetchPolicy("ETH/USDT:USDT"); } catch (err) { error = err; }
    expect(isCandleBasisUnavailableError(error)).toBe(true);
    expect((error as any).reason).toBe("nonfinalized_only");
  });

  it("rejects missing OKX confirm as malformed_provenance", async () => {
    installOkxRows([okxRow(Date.now() - TF_MS)]);
    let error: unknown;
    try { await fetchPolicy("BTC/USDT:USDT"); } catch (err) { error = err; }
    expect(isCandleBasisUnavailableError(error)).toBe(true);
    expect((error as any).reason).toBe("malformed_provenance");
  });

  it("never calls Gate or Pyth under the money policy", async () => {
    const spy = installOkxRows([]);
    await expect(fetchPolicy("DOGE/USDT:USDT")).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "no_acceptable_source",
    });
    expect(spy.mock.calls.every(([url]) => String(url).includes("okx.com"))).toBe(true);
  });

  it("marks multiplier base transforms as proxy and rejects them under direct policy", async () => {
    installOkxRows([okxRow(Date.now() - TF_MS, "1")]);
    await expect(fetchPolicy("1MPEPE/USDT:USDT")).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "no_acceptable_source",
    });
  });

  it("synthetic aggregation preserves identity and propagates forming finality", () => {
    const base = Date.now() - 3 * TF_MS;
    const make = (i: number, finality: "forming" | "finalized"): ProvenancedOHLCV => ({
      time: base + i * TF_MS,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      provenance: {
        source: "okx", venue: "okx", basis: "perp", proxy: "direct",
        finality, timeSemantic: "open_time",
      },
    });
    const result = aggregateCandles(
      [make(0, "finalized"), make(1, "forming"), make(2, "finalized")],
      3,
    );
    expect(result).toHaveLength(1);
    expect(result[0].provenance.finality).toBe("forming");
    expect(result[0].provenance.source).toBe("okx");
  });

  it("drops an incomplete time-aligned synthetic bucket before money admission", () => {
    const targetMs = 3 * TF_MS;
    const base = Math.floor(Date.now() / targetMs) * targetMs;
    const make = (time: number): ProvenancedOHLCV => ({
      time, open: 100, high: 101, low: 99, close: 100, volume: 1,
      provenance: {
        source: "okx", venue: "okx", basis: "perp", proxy: "direct",
        finality: "finalized", timeSemantic: "open_time",
      },
    });
    expect(aggregateCandles([make(base), make(base + TF_MS)], 3, targetMs)).toEqual([]);
  });

  it("chart policy admits both finalized and forming direct OKX rows", async () => {
    const now = Date.now();
    installOkxRows([okxRow(now - TF_MS, "1"), okxRow(now - 2 * TF_MS, "0")]);
    const rows = await fetchPolicy("SOL/USDT:USDT", CHART_CANDLE_POLICY);
    expect(rows.map((r) => r.provenance.finality).sort()).toEqual(["finalized", "forming"]);
  });

  it("admits cross-venue direct finalized perp only for scanner/context money consumers", () => {
    const candle: ProvenancedOHLCV = {
      time: Date.now(), open: 100, high: 101, low: 99, close: 100, volume: 1,
      provenance: {
        source: "gate", venue: "gate", basis: "perp", proxy: "direct",
        finality: "finalized", timeSemantic: "open_time",
      },
    };
    expect(candleMatchesBasisPolicy(candle, MONEY_CANDLE_POLICY)).toBe(true);
    expect(candleMatchesBasisPolicy(candle, AI_CONTEXT_CANDLE_POLICY)).toBe(true);
    expect(candleMatchesBasisPolicy(candle, CHART_CANDLE_POLICY)).toBe(false);
    expect(candleMatchesBasisPolicy(candle, PAPER_MONITOR_CANDLE_POLICY)).toBe(false);
    expect(candleMatchesBasisPolicy(candle, LIVE_MONITOR_CANDLE_POLICY)).toBe(false);

    const inadmissible = [
      { basis: "spot" },
      { source: "pyth", venue: "none", basis: "index" },
      { proxy: "proxy" },
      { finality: "forming" },
      { source: "unknown" },
      { venue: "unknown" },
      { timeSemantic: "unknown" },
    ] as const;
    for (const override of inadmissible) {
      const changed = {
        ...candle,
        provenance: { ...candle.provenance, ...override },
      } as ProvenancedOHLCV;
      expect(candleMatchesBasisPolicy(changed, MONEY_CANDLE_POLICY), JSON.stringify(override)).toBe(false);
      expect(candleMatchesBasisPolicy(changed, AI_CONTEXT_CANDLE_POLICY), JSON.stringify(override)).toBe(false);
    }
  });

  it("admits forming direct OKX candles for paper/live monitor consumers only", () => {
    const candle: ProvenancedOHLCV = {
      time: Date.now(), open: 100, high: 101, low: 99, close: 100, volume: 1,
      provenance: {
        source: "okx", venue: "okx", basis: "perp", proxy: "direct",
        finality: "forming", timeSemantic: "open_time",
      },
    };
    expect(candleMatchesBasisPolicy(candle, PAPER_MONITOR_CANDLE_POLICY)).toBe(true);
    expect(candleMatchesBasisPolicy(candle, LIVE_MONITOR_CANDLE_POLICY)).toBe(true);
    expect(candleMatchesBasisPolicy(candle, MONEY_CANDLE_POLICY)).toBe(false);
  });
});
