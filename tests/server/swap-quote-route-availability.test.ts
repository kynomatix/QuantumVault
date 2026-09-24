import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  quoteIdentity: vi.fn(() => "api.jup.ag:keyless"),
  getQuote: vi.fn(),
  buildSwapTransaction: vi.fn(),
}));

vi.mock("../../server/swap/jupiter.js", () => ({
  JupiterProvider: class {
    name = "jupiter";
    quoteIdentity = provider.quoteIdentity;
    getQuote = provider.getQuote;
    buildSwapTransaction = provider.buildSwapTransaction;
  },
}));

import { getBestQuote, selectBestQuoteResult } from "../../server/swap/index";

const params = { inputMint: "in", outputMint: "out", amountRaw: "10", slippageBps: 100 };

describe("best quote typed availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves authoritative no-route", async () => {
    provider.getQuote.mockResolvedValue({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await expect(getBestQuote(params)).resolves.toEqual({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
  });

  it("preserves provider unavailability", async () => {
    provider.getQuote.mockResolvedValue({ kind: "unavailable", failure: { provider: "jupiter", failureClass: "rate_limited", status: 429, retryAfterMs: 1000 } });
    await expect(getBestQuote(params)).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "rate_limited" } });
  });

  it("selects the highest valid quote and lets any concealed route outrank no-route", () => {
    const result = selectBestQuoteResult([
      { status: "fulfilled", value: { kind: "no_route", provider: "a", code: "NO_ROUTES_FOUND" } },
      { status: "fulfilled", value: { kind: "unavailable", failure: { provider: "b", failureClass: "timeout", status: null, retryAfterMs: null } } },
      { status: "fulfilled", value: { kind: "quote", quote: { provider: "c", inputMint: "in", outputMint: "out", inAmountRaw: "10", outAmountRaw: "20", priceImpactPct: 0, slippageBps: 100, raw: {} } } },
      { status: "fulfilled", value: { kind: "quote", quote: { provider: "d", inputMint: "in", outputMint: "out", inAmountRaw: "10", outAmountRaw: "21", priceImpactPct: 0, slippageBps: 100, raw: {} } } },
    ]);
    expect(result).toMatchObject({ kind: "quote", quote: { provider: "d", outAmountRaw: "21" } });
    expect(selectBestQuoteResult([
      { status: "fulfilled", value: { kind: "no_route", provider: "a", code: "NO_ROUTES_FOUND" } },
      { status: "fulfilled", value: { kind: "unavailable", failure: { provider: "b", failureClass: "timeout", status: null, retryAfterMs: null } } },
    ])).toMatchObject({ kind: "unavailable", failure: { provider: "b", failureClass: "timeout" } });
  });

  it("single-flights identical read quotes but never execution quotes", async () => {
    let release!: (value: unknown) => void;
    provider.getQuote.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const a = getBestQuote(params);
    const b = getBestQuote(params);
    expect(provider.getQuote).toHaveBeenCalledTimes(1);
    release({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await Promise.all([a, b]);
    provider.getQuote.mockResolvedValue({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await Promise.all([getBestQuote({ ...params, purpose: "execution" }), getBestQuote({ ...params, purpose: "execution" })]);
    expect(provider.getQuote).toHaveBeenCalledTimes(3);
  });

  it("separates different amount, direction, and purpose keys", async () => {
    provider.getQuote.mockResolvedValue({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await Promise.all([
      getBestQuote(params),
      getBestQuote({ ...params, amountRaw: "11" }),
      getBestQuote({ ...params, inputMint: "out", outputMint: "in" }),
      getBestQuote({ ...params, purpose: "execution" }),
    ]);
    expect(provider.getQuote).toHaveBeenCalledTimes(4);
  });

  it("clears the read single-flight entry after provider rejection", async () => {
    provider.getQuote.mockRejectedValueOnce(new Error("transport failed"));
    await expect(getBestQuote(params)).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "network" } });
    provider.getQuote.mockResolvedValueOnce({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await expect(getBestQuote(params)).resolves.toMatchObject({ kind: "no_route" });
    expect(provider.getQuote).toHaveBeenCalledTimes(2);
  });

  it("keeps the generic quote HTTP boundary distinct for no-route and temporary unavailability", () => {
    const source = readFileSync(join(process.cwd(), "server/routes.ts"), "utf8");
    const start = source.indexOf("const quoteResult = await getBestQuote({");
    const end = source.indexOf("res.json({", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const boundary = source.slice(start, end);
    expect(boundary).toContain('quoteResult.kind === "no_route"');
    expect(boundary).toContain('res.status(404).json({ error: "No swap route available for this token", reasonCode: "no_route" })');
    expect(boundary).toContain('quoteResult.kind === "unavailable"');
    expect(boundary).toContain('res.status(503).json({ error: "Swap pricing is temporarily unavailable", reasonCode: "quote_provider_unavailable" })');
  });
});
