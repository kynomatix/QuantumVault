import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLabApiTokenGate, LAB_TOKEN_RUNS_PER_DAY, matchLabTokenRoute } from "../../server/lab/api-token-gate";

const TOKEN = "qv_test_token_value";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function call(gate: ReturnType<typeof createLabApiTokenGate>, opts: { method?: string; url: string; auth?: string; session?: string }) {
  const req: any = { method: opts.method ?? "GET", originalUrl: opts.url, headers: opts.auth ? { authorization: opts.auth } : {}, session: opts.session ? { walletAddress: opts.session } : {} };
  const res: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  const next = vi.fn();
  return gate(req, res, next).then(() => ({ req, res, next }));
}

const lookup = vi.fn(async (hash: string) => hash === HASH ? { id: 7, walletAddress: "WalletA", scopes: ["lab:read", "lab:write"] } : undefined);

describe("Lab API token gate", () => {
  it("passes through untouched when a session wallet exists, even with a token", async () => {
    const gate = createLabApiTokenGate(lookup);
    const { req, next } = await call(gate, { method: "DELETE", url: "/api/lab/strategies/1", auth: `Bearer ${TOKEN}`, session: "SessionWallet" });
    expect(next).toHaveBeenCalledOnce();
    expect(req.labTokenWallet).toBeUndefined();
  });

  it("passes through untouched with no Authorization header (the proxy then answers 401 as before)", async () => {
    const gate = createLabApiTokenGate(lookup);
    const { req, next } = await call(gate, { url: "/api/lab/strategies" });
    expect(next).toHaveBeenCalledOnce();
    expect(req.labTokenWallet).toBeUndefined();
  });

  it("resolves a valid token to its wallet on an allowlisted route", async () => {
    const gate = createLabApiTokenGate(lookup);
    const { req, next } = await call(gate, { url: "/api/lab/strategies?x=1", auth: `Bearer ${TOKEN}` });
    expect(next).toHaveBeenCalledOnce();
    expect(req.labTokenWallet).toBe("WalletA");
    expect(req.apiTokenId).toBe(7);
  });

  it("rejects an unknown token with 401 Invalid API token", async () => {
    const gate = createLabApiTokenGate(lookup);
    const { res, next } = await call(gate, { url: "/api/lab/strategies", auth: "Bearer qv_bogus" });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid API token" });
  });

  it.each([
    ["DELETE", "/api/lab/strategies/1"],
    ["DELETE", "/api/lab/cache"],
    ["POST", "/api/lab/jobs/force-clear"],
    ["POST", "/api/lab/queue/reorder"],
    ["POST", "/api/lab/job/abc/cancel"],
    ["GET", "/api/lab/debug-compiler/1"],
    ["PATCH", "/api/lab/strategies/1"],
    ["GET", "/api/lab/strategies/1/"],
    ["GET", "/API/LAB/STRATEGIES"],
    ["HEAD", "/api/lab/strategies"],
  ])("refuses a token on %s %s without looking it up", async (method, url) => {
    const spy = vi.fn(lookup);
    const gate = createLabApiTokenGate(spy);
    const { res, next } = await call(gate, { method, url, auth: `Bearer ${TOKEN}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("enforces scopes: a read-only token cannot create or run", async () => {
    const gate = createLabApiTokenGate(async () => ({ id: 9, walletAddress: "WalletB", scopes: ["lab:read"] }));
    expect((await call(gate, { url: "/api/lab/runs", auth: `Bearer ${TOKEN}` })).next).toHaveBeenCalledOnce();
    const write = await call(gate, { method: "POST", url: "/api/lab/run-optimization", auth: `Bearer ${TOKEN}` });
    expect(write.res.statusCode).toBe(403);
    expect(write.next).not.toHaveBeenCalled();
  });

  it("caps new runs per token per rolling 24 hours", async () => {
    let t = 1_000_000;
    const gate = createLabApiTokenGate(lookup, () => t);
    for (let i = 0; i < LAB_TOKEN_RUNS_PER_DAY; i++) {
      expect((await call(gate, { method: "POST", url: "/api/lab/run-optimization", auth: `Bearer ${TOKEN}` })).next).toHaveBeenCalledOnce();
    }
    const over = await call(gate, { method: "POST", url: "/api/lab/run-optimization", auth: `Bearer ${TOKEN}` });
    expect(over.res.statusCode).toBe(429);
    t += 24 * 60 * 60 * 1000 + 1;
    expect((await call(gate, { method: "POST", url: "/api/lab/run-optimization", auth: `Bearer ${TOKEN}` })).next).toHaveBeenCalledOnce();
  });

  it("answers 500 without leaking details when the lookup throws", async () => {
    const gate = createLabApiTokenGate(async () => { throw new Error("db down with secret detail"); });
    const { res, next } = await call(gate, { url: "/api/lab/runs", auth: `Bearer ${TOKEN}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Auth lookup failed" });
  });

  it("allowlist matches only exact read and additive routes", () => {
    expect(matchLabTokenRoute("GET", "/api/lab/runs/12/results")?.scope).toBe("lab:read");
    expect(matchLabTokenRoute("POST", "/api/lab/strategies")?.scope).toBe("lab:write");
    expect(matchLabTokenRoute("GET", "/api/lab/runs/12/job")).toBeUndefined();
    expect(matchLabTokenRoute("POST", "/api/lab/runs/12/refine")).toBeUndefined();
  });
});
