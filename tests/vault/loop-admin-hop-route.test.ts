/**
 * tests/vault/loop-admin-hop-route.test.ts — WO2A-C1 cell 11
 *
 * Exercises the REAL registered POST /api/admin/loop/hop route end-to-end
 * (express app via registerRoutes + ephemeral listener), proving the admin
 * resume path is CALLABLE: position lookup is admin-by-id (cross-wallet),
 * every validation door still holds, the signer resolves through the real
 * routes-local resolveLoopSafetySigner (fed by mocked storage/session-v3),
 * and cleanup runs on success AND on executor throw.
 *
 * executeLoopHop itself is stubbed (its behavior is pinned by the recovery/
 * provenance suites); this file pins the ROUTE contract around it.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// ---------------------------------------------------------------------------

// Storage: lazy Proxy — every method becomes an auto-registered vi.fn that
// resolves undefined until a test overrides it. Keeps the 24k-line route
// registration import-safe without enumerating the full storage surface.
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

// Session middleware: the real module creates a pg.Pool + pg-backed store at
// import time (wants a live DATABASE_URL). The admin route authenticates by
// Bearer token, so a pass-through stub is sufficient and side-effect free.
vi.mock("../../server/session", () => ({
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// session-v3: real module, with ONLY the two signer seams overridden — the
// routes-local resolveLoopSafetySigner calls getUmkForWebhook then (account
// scope) decryptAgentKeyStrict.
vi.mock("../../server/session-v3", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getUmkForWebhook: vi.fn(),
    decryptAgentKeyStrict: vi.fn(),
  };
});

// Loop executor: real module with executeLoopHop stubbed (behavior pinned in
// the dedicated executor suites; here only the route contract matters).
vi.mock("../../server/vault/loop/loop-executor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    executeLoopHop: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import express from "express";
import { createServer, type Server } from "http";
import { registerRoutes } from "../../server/routes";
import { storage } from "../../server/storage";
import { getUmkForWebhook, decryptAgentKeyStrict } from "../../server/session-v3";
import { executeLoopHop } from "../../server/vault/loop/loop-executor";
import { LOOP_VAULT_ALLOWLIST } from "../../server/vault/loop/loop-risk-policy";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET = "wallet-admin-hop-test";
const POS_ID = "pos-admin-1";
const RESUME_CRID = "hop-crid-admin-9";
// A REAL allowlisted vault id (the route validates against the live allowlist).
const TV = Number(Object.keys(LOOP_VAULT_ALLOWLIST)[0]);

const closedLoopPosition = {
  id: POS_ID,
  walletAddress: WALLET,
  kind: "loop",
  status: "closed",
  venueVaultId: "4",
};

const openLoopPosition = { ...closedLoopPosition, status: "open" };

const parkedHopRow = {
  id: "hop-op-admin-1",
  operationType: "loop_hop",
  status: "parked",
  step: "parked",
  walletAddress: WALLET,
  borrowPositionId: POS_ID,
  clientRequestId: RESUME_CRID,
  metadata: { kind: "loop", sourceBorrowPositionId: POS_ID, toVaultId: TV, fromVaultId: 4 },
  result: null,
  error: null,
};

let server: Server;
let base: string;
let signerCleanup: ReturnType<typeof vi.fn>;
let umkCleanup: ReturnType<typeof vi.fn>;

function adminHeaders(token?: string) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token ?? process.env.ADMIN_PASSWORD ?? ""}`,
  };
}

async function postHop(body: Record<string, unknown>, token?: string) {
  const r = await fetch(`${base}/api/admin/loop/hop`, {
    method: "POST",
    headers: adminHeaders(token),
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

/** Prime the signer path: wallet row → umk → decrypted account-scope key. */
function primeSigner() {
  vi.mocked(storage.getWallet as any).mockResolvedValue({
    walletAddress: WALLET,
    agentPublicKey: "AgentPk1111111111111111111111111111111111111",
    executionEnabled: true,
  });
  umkCleanup = vi.fn();
  vi.mocked(getUmkForWebhook as any).mockResolvedValue({ umk: Buffer.alloc(32), cleanup: umkCleanup });
  signerCleanup = vi.fn();
  vi.mocked(decryptAgentKeyStrict as any).mockResolvedValue({
    secretKey: new Uint8Array(64),
    cleanup: signerCleanup,
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json()); // mirrors server/index.ts — registerRoutes assumes body parsing
  const httpServer = createServer(app);
  server = await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!server) return;
  // Kill keep-alive sockets from fetch, or close() waits on them forever.
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  primeSigner();
  vi.mocked(executeLoopHop as any).mockResolvedValue({
    success: false,
    resumable: true,
    error: "stub: retry shortly",
  });
});

// ---------------------------------------------------------------------------
// Auth + input doors
// ---------------------------------------------------------------------------

describe("POST /api/admin/loop/hop — auth and input validation", () => {
  it("rejects a wrong admin token (401), touching nothing", async () => {
    const { status } = await postHop({ borrowPositionId: POS_ID, targetVaultId: TV }, "wrong-token");
    expect(status).toBe(401);
    expect(storage.getBorrowPositionByIdAdmin).not.toHaveBeenCalled();
    expect(executeLoopHop).not.toHaveBeenCalled();
  });

  it("400 when borrowPositionId is missing", async () => {
    const { status, body } = await postHop({ targetVaultId: TV });
    expect(status).toBe(400);
    expect(body.error).toMatch(/borrowPositionId required/);
  });

  it("fresh trigger: 400 for a non-allowlisted target vault", async () => {
    const { status, body } = await postHop({ borrowPositionId: POS_ID, targetVaultId: 999999 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not on the loop allowlist/);
  });
});

// ---------------------------------------------------------------------------
// Position lookup — the WO2A-C1 callability fix
// ---------------------------------------------------------------------------

describe("POST /api/admin/loop/hop — admin-by-id position lookup", () => {
  it("looks the position up by ADMIN-BY-ID (no wallet in hand) and 404s when absent", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(undefined);

    const { status, body } = await postHop({ borrowPositionId: "missing-pos", targetVaultId: TV });

    expect(status).toBe(404);
    expect(body.error).toMatch(/Position not found/);
    // The C1 fix: the unscoped admin lookup — NOT the wallet-scoped reader.
    expect(storage.getBorrowPositionByIdAdmin).toHaveBeenCalledWith("missing-pos");
    expect(storage.getBorrowPosition).not.toHaveBeenCalled();
  });

  it("400 when the position is not a loop position", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue({
      ...openLoopPosition,
      kind: "borrow",
    });
    const { status, body } = await postHop({ borrowPositionId: POS_ID, targetVaultId: TV });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a loop position/);
  });

  it("fresh trigger: 400 when the source position is CLOSED (no resume crid → open required)", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(closedLoopPosition);
    const { status, body } = await postHop({ borrowPositionId: POS_ID, targetVaultId: TV });
    expect(status).toBe(400);
    expect(body.error).toMatch(/closed, not open/);
    expect(executeLoopHop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resume doors
// ---------------------------------------------------------------------------

describe("POST /api/admin/loop/hop — resume validation doors", () => {
  beforeEach(() => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(closedLoopPosition);
  });

  it("404 when the crid resolves to a non-hop operation", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue({
      ...parkedHopRow,
      operationType: "loop_open",
    });
    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });
    expect(status).toBe(404);
    expect(body.error).toMatch(/No loop_hop operation/);
    // Looked up WALLET-SCOPED from the row's own wallet.
    expect(storage.getBorrowOperationByClientRequestId).toHaveBeenCalledWith(WALLET, RESUME_CRID);
  });

  it("400 when the hop op belongs to a different position", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue({
      ...parkedHopRow,
      borrowPositionId: "other-pos",
      metadata: { ...parkedHopRow.metadata, sourceBorrowPositionId: "other-pos" },
    });
    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });
    expect(status).toBe(400);
    expect(body.error).toMatch(/different position/);
  });

  it("400 when the hop record has no persisted target vault", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue({
      ...parkedHopRow,
      metadata: { ...parkedHopRow.metadata, toVaultId: undefined },
    });
    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no persisted target vault/);
  });

  it("400 when an explicit targetVaultId disagrees with the persisted target (persisted wins)", async () => {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parkedHopRow);
    const { status, body } = await postHop({
      borrowPositionId: POS_ID,
      clientRequestId: RESUME_CRID,
      targetVaultId: TV + 1,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/does not match the hop record/);
    expect(executeLoopHop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Callable happy paths + signer lifecycle
// ---------------------------------------------------------------------------

describe("POST /api/admin/loop/hop — execution and signer lifecycle", () => {
  it("RESUME on a CLOSED source works via the SAME crid: manual mode, persisted target, no new sizing inputs", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(closedLoopPosition);
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parkedHopRow);
    vi.mocked(executeLoopHop as any).mockResolvedValue({
      success: false,
      parked: true,
      parkReason: "open_broadcast_budget_exhausted",
      error: "still parked",
    });

    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });

    expect(status).toBe(200);
    expect(body.parked).toBe(true);
    expect(executeLoopHop).toHaveBeenCalledTimes(1);
    const params = vi.mocked(executeLoopHop as any).mock.calls[0][0];
    expect(params).toMatchObject({
      walletAddress: WALLET,
      borrowPositionId: POS_ID,
      targetVaultId: TV, // persisted target, not caller-supplied
      clientRequestId: RESUME_CRID, // SAME crid → executor resumes, never forks
      mode: "manual",
      policyReason: "admin manual resume",
    });
    expect(params.agentSecretKey).toBeInstanceOf(Uint8Array);
    // Signer lifecycle: scope key + umk cleaned up exactly once each.
    expect(signerCleanup).toHaveBeenCalledTimes(1);
    expect(umkCleanup).toHaveBeenCalledTimes(1);
  });

  it("FRESH trigger on an OPEN source mints an admin crid and passes manual mode", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(openLoopPosition);
    vi.mocked(executeLoopHop as any).mockResolvedValue({ success: true, borrowPositionId: "new-row" });

    const { status, body } = await postHop({ borrowPositionId: POS_ID, targetVaultId: TV });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const params = vi.mocked(executeLoopHop as any).mock.calls[0][0];
    expect(params.mode).toBe("manual");
    expect(params.targetVaultId).toBe(TV);
    expect(String(params.clientRequestId)).toMatch(new RegExp(`^admin-hop-${POS_ID}-${TV}-`));
    expect(params.policyReason).toBe("admin manual trigger");
    expect(signerCleanup).toHaveBeenCalledTimes(1);
  });

  it("403 when the signer cannot resolve (execution disabled), executor never invoked", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(closedLoopPosition);
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parkedHopRow);
    vi.mocked(getUmkForWebhook as any).mockResolvedValue(null); // execution disabled / e-stop

    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });

    expect(status).toBe(403);
    expect(body.error).toMatch(/Cannot resolve signer/);
    expect(executeLoopHop).not.toHaveBeenCalled();
  });

  it("signer cleanup STILL runs when the executor throws (500), never leaking the key", async () => {
    vi.mocked(storage.getBorrowPositionByIdAdmin as any).mockResolvedValue(closedLoopPosition);
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(parkedHopRow);
    vi.mocked(executeLoopHop as any).mockRejectedValue(new Error("executor blew up"));

    const { status, body } = await postHop({ borrowPositionId: POS_ID, clientRequestId: RESUME_CRID });

    expect(status).toBe(500);
    expect(body.error).toMatch(/executor blew up/);
    expect(signerCleanup).toHaveBeenCalledTimes(1);
  });
});
