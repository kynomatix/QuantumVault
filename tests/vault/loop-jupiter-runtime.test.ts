import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJupiterRuntime } from "../../server/swap/jupiter-runtime";

describe("managed-loop Jupiter runtime sharing", () => {
  it("paces provider quote, direct loop quote, and instruction build on one start ledger", async () => {
    let clock = 0;
    const starts: Array<{ at: number; path: string; method: string }> = [];
    const runtime = createJupiterRuntime({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl: vi.fn(async (input, init) => {
        const url = new URL(String(input));
        starts.push({ at: clock, path: url.pathname, method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ inAmount: "1", outAmount: "2" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    await Promise.all([
      runtime.requestJson({ operation: "quote", query: { inputMint: "a", outputMint: "b", amount: "1" } }),
      runtime.requestJson({ operation: "quote", query: { inputMint: "b", outputMint: "a", amount: "2", onlyDirectRoutes: "true", maxAccounts: "28" } }),
      runtime.requestJson({ operation: "swap-instructions", body: { quoteResponse: {}, userPublicKey: "wallet", wrapAndUnwrapSol: false } }),
    ]);
    expect(starts.map((row) => row.at)).toEqual([0, 2000, 4000]);
    expect(starts.map((row) => row.path)).toEqual(["/swap/v1/quote", "/swap/v1/quote", "/swap/v1/swap-instructions"]);
    expect(starts[2].method).toBe("POST");
  });

  it("makes the direct loop consumer reject mismatched input and non-positive output quotes", () => {
    const source = readFileSync(join(process.cwd(), "server/vault/loop/loop-executor.ts"), "utf8");
    expect(source).toContain("body.inAmount !== expectedInAmount");
    expect(source).toContain("BigInt(body.outAmount) <= BigInt(0)");
    expect(source).toContain("!/^\\d+$/.test(body.inAmount)");
    expect(source).toContain("!/^\\d+$/.test(body.outAmount)");
  });

  it("marks direct exits as risk reducing while keeping voluntary hop work at execution/read priority", () => {
    const source = readFileSync(join(process.cwd(), "server/vault/loop/loop-executor.ts"), "utf8");
    expect(source).toContain('const closePurpose: QuotePurpose = hopGuard ? "execution" : "risk_reducing"');
    expect(source).toContain('jupQuote(cfg.collateralMint, WSOL_MINT, liveCol, slippageBps, closePurpose)');
    expect(source).toContain('jupSwapIxs(quote, agentPublicKey, closePurpose)');
    expect(source).toContain('jupQuote(cfg.collateralMint, WSOL_MINT, liveCol, args.slippageBps, "read")');
    expect(source).toContain('jupQuote(cfg.collateralMint, WSOL_MINT, withdrawRaw, slippageBps, "risk_reducing")');
    expect(source).toContain('jupSwapIxs(quote, agentPublicKey, "risk_reducing")');
    expect(source).toContain('jupQuote(WSOL_MINT, cfg.collateralMint, totalSwapLamports, slippageBps, "execution")');
    expect(source).toContain('purpose: closePurpose');
  });
});
