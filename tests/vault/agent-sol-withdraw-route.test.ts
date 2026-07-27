/**
 * tests/vault/agent-sol-withdraw-route.test.ts — WO2B2B
 *
 * Exercises the REAL registered routes (express app via registerRoutes +
 * ephemeral listener) for the durable SOL withdrawal surface, with the
 * orchestrator handlers mocked — the route layer's own obligations are:
 *
 *  - POST /api/agent/withdraw-sol: requireWallet auth (401 no session,
 *    403 wallet mismatch), session wallet — never a client-supplied one —
 *    bound as the handler's wallet, req.body passed through verbatim,
 *    {http, body} mapped verbatim to the wire, handler throw → sanitized 500.
 *  - POST /api/agent/confirm-sol-withdraw: same wrapper contract for the
 *    neutralized legacy endpoint (410/404/stored-state passthrough).
 *
 * Deep state-machine behavior is covered by agent-sol-withdraw-state.test.ts;
 * storage semantics by agent-sol-withdraw-storage.test.ts.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// ---------------------------------------------------------------------------

// Storage: lazy Proxy — every method becomes an auto-registered vi.fn (boot-time
// calls from registerRoutes resolve to undefined, which is fine).
vi.mock("../../server/storage", () => {
  const target: Record<string, any> = {};
  const storage = new Proxy(target, {
    get: (t, prop: string | symbol) => {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined; // never thenable
      return (t[prop] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {}
  return { storage, DatabaseStorage };
});

// Session middleware: the real module creates a pg.Pool at import time. The
// stub plants a MUTABLE session wallet so auth-rejection paths are testable.
const sessionState = vi.hoisted(() => ({ wallet: "wallet-sol-route-test" as string | null }));
vi.mock("../../server/session", () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = sessionState.wallet ? { walletAddress: sessionState.wallet } : {};
    next();
  },
}));

// Orchestrator handlers: mocked — this file pins the thin route wrapper only.
vi.mock("../../server/vault/agent-sol-withdraw", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    handleAgentSolWithdraw: vi.fn(),
    handleConfirmSolWithdraw: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import express from "express";
import { createServer, type Server } from "http";
import { registerRoutes } from "../../server/routes";
import {
  handleAgentSolWithdraw,
  handleConfirmSolWithdraw,
} from "../../server/vault/agent-sol-withdraw";

const WALLET = "wallet-sol-route-test"; // must match the session stub literal
const SIG = "SigRouteBase58Withdraw1111111111111111111111";

let server: Server;
let base: string;

async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body → keep {} */
  }
  return { status: r.status, body: json, text };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json()); // mirrors server/index.ts
  const httpServer = createServer(app);
  server = await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!server) return;
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

beforeEach(() => {
  vi.resetAllMocks();
  sessionState.wallet = WALLET;
});

// ---------------------------------------------------------------------------
// POST /api/agent/withdraw-sol — wrapper contract
// ---------------------------------------------------------------------------

describe("POST /api/agent/withdraw-sol — durable route wrapper", () => {
  it("binds the SESSION wallet, passes the body verbatim, and maps {http,body} to the wire", async () => {
    const handlerBody = {
      success: true,
      state: "succeeded",
      signature: SIG,
      withdrawnLamports: "47500000",
      withdrawnSol: "0.047500",
      message: "Withdrawal confirmed on-chain.",
    };
    vi.mocked(handleAgentSolWithdraw).mockResolvedValue({ http: 200, body: handlerBody } as any);

    const { status, body, text } = await post("/api/agent/withdraw-sol", {
      clientRequestId: "crid-route-1",
      amount: 0.0475,
    });

    expect(status).toBe(200);
    expect(body).toEqual(handlerBody);
    expect(handleAgentSolWithdraw).toHaveBeenCalledTimes(1);
    expect(handleAgentSolWithdraw).toHaveBeenCalledWith(WALLET, {
      clientRequestId: "crid-route-1",
      amount: 0.0475,
    });
    expect(handleConfirmSolWithdraw).not.toHaveBeenCalled();

    // Legacy browser-broadcast shape is GONE at the wire level: no tx bytes.
    expect(text).not.toContain('"transaction"');
    expect(text).not.toContain("serializedTransaction");
  });

  it.each([
    {
      label: "202 pending",
      http: 202,
      body: {
        success: false,
        state: "pending",
        pending: true,
        clientRequestId: "crid-route-2",
        message: "Withdrawal is being reconciled. Retry with the SAME clientRequestId.",
        signature: SIG,
      },
    },
    {
      label: "400 terminal pre-broadcast failure",
      http: 400,
      body: {
        success: false,
        state: "failed",
        terminal: true,
        step: "withdraw_prebroadcast_failed",
        error: "The withdrawal was not broadcast: insufficient SOL balance.",
      },
    },
    {
      label: "409 terminal conflict",
      http: 409,
      body: {
        success: false,
        state: "failed",
        terminal: true,
        step: "withdraw_conflict",
        error: "Another agent-wallet operation is still in flight.",
      },
    },
    {
      label: "409 manual review",
      http: 409,
      body: {
        success: false,
        state: "pending",
        pending: true,
        manualReview: true,
        clientRequestId: "crid-route-2",
        message: "This withdrawal requires manual review.",
      },
    },
  ])("passes through the handler verdict verbatim: $label", async ({ http, body: hb }) => {
    vi.mocked(handleAgentSolWithdraw).mockResolvedValue({ http, body: hb } as any);
    const { status, body } = await post("/api/agent/withdraw-sol", {
      clientRequestId: "crid-route-2",
      amount: 0.01,
    });
    expect(status).toBe(http);
    expect(body).toEqual(hb);
  });

  it("handler throw → sanitized 500 (no internal message on the wire)", async () => {
    vi.mocked(handleAgentSolWithdraw).mockRejectedValue(new Error("secret internal boom"));
    const { status, body, text } = await post("/api/agent/withdraw-sol", {
      clientRequestId: "crid-route-3",
      amount: 0.01,
    });
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal server error" });
    expect(text).not.toContain("secret internal boom");
  });

  it("no session wallet → 401, handler never invoked", async () => {
    sessionState.wallet = null;
    const { status } = await post("/api/agent/withdraw-sol", {
      clientRequestId: "crid-route-4",
      amount: 0.01,
    });
    expect(status).toBe(401);
    expect(handleAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("client-supplied walletAddress differing from the session → 403, handler never invoked", async () => {
    const { status } = await post("/api/agent/withdraw-sol", {
      walletAddress: "attacker-wallet-999",
      clientRequestId: "crid-route-5",
      amount: 0.01,
    });
    expect(status).toBe(403);
    expect(handleAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("matching client-supplied walletAddress passes, but the handler wallet is STILL the session's", async () => {
    vi.mocked(handleAgentSolWithdraw).mockResolvedValue({
      http: 202,
      body: { pending: true, state: "pending" },
    } as any);
    const { status } = await post("/api/agent/withdraw-sol", {
      walletAddress: WALLET,
      clientRequestId: "crid-route-6",
      amount: 0.01,
    });
    expect(status).toBe(202);
    expect(handleAgentSolWithdraw).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ clientRequestId: "crid-route-6" })
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/confirm-sol-withdraw — neutralized legacy endpoint wrapper
// ---------------------------------------------------------------------------

describe("POST /api/agent/confirm-sol-withdraw — neutralized wrapper", () => {
  it("passes the 410 migrated verdict through and binds the session wallet", async () => {
    const hb = {
      migrated: true,
      error:
        "This endpoint no longer records withdrawals. Use POST /api/agent/withdraw-sol with a clientRequestId.",
    };
    vi.mocked(handleConfirmSolWithdraw).mockResolvedValue({ http: 410, body: hb } as any);

    const { status, body } = await post("/api/agent/confirm-sol-withdraw", {
      amount: 0.5,
      txSignature: "ClientClaimedSig111",
    });

    expect(status).toBe(410);
    expect(body).toEqual(hb);
    expect(handleConfirmSolWithdraw).toHaveBeenCalledTimes(1);
    expect(handleConfirmSolWithdraw).toHaveBeenCalledWith(WALLET, {
      amount: 0.5,
      txSignature: "ClientClaimedSig111",
    });
    expect(handleAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "404 unknown clientRequestId",
      http: 404,
      body: { error: "No withdrawal found for this clientRequestId." },
    },
    {
      label: "200 stored succeeded state",
      http: 200,
      body: {
        success: true,
        state: "succeeded",
        signature: SIG,
        withdrawnLamports: "47500000",
        withdrawnSol: "0.047500",
        message: "Withdrawal already confirmed.",
      },
    },
  ])("passes through the stored-state verdict verbatim: $label", async ({ http, body: hb }) => {
    vi.mocked(handleConfirmSolWithdraw).mockResolvedValue({ http, body: hb } as any);
    const { status, body } = await post("/api/agent/confirm-sol-withdraw", {
      clientRequestId: "crid-route-7",
    });
    expect(status).toBe(http);
    expect(body).toEqual(hb);
  });

  it("handler throw → sanitized 500", async () => {
    vi.mocked(handleConfirmSolWithdraw).mockRejectedValue(new Error("confirm boom"));
    const { status, body, text } = await post("/api/agent/confirm-sol-withdraw", {
      clientRequestId: "crid-route-8",
    });
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Internal server error" });
    expect(text).not.toContain("confirm boom");
  });

  it("no session wallet → 401, handler never invoked", async () => {
    sessionState.wallet = null;
    const { status } = await post("/api/agent/confirm-sol-withdraw", {
      clientRequestId: "crid-route-9",
    });
    expect(status).toBe(401);
    expect(handleConfirmSolWithdraw).not.toHaveBeenCalled();
  });
});
