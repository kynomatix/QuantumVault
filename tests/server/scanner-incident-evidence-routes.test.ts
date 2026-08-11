import { readFileSync } from "node:fs";
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const storageTarget = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock("../../server/storage", () => {
  const storage = new Proxy(storageTarget, {
    get: (target, property: string | symbol) => {
      if (typeof property !== "string" || property === "then") return undefined;
      return (target[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return "test-close-fill"; }
  }
  return { storage, DatabaseStorage };
});

vi.mock("../../server/session", () => ({
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../server/db", () => ({ db: {}, isConnectionClassError: vi.fn(() => false) }));
vi.mock("../../server/analytics-indexer", () => ({
  startAnalyticsIndexer: vi.fn(),
  getMetrics: vi.fn(),
  calculateAndStoreMetrics: vi.fn(),
}));
vi.mock("../../server/session-v3", () => ({
  createSigningNonce: vi.fn(),
  verifySignatureAndConsumeNonce: vi.fn(),
  initializeWalletSecurity: vi.fn(),
  getSession: vi.fn(),
  getSessionByWalletAddress: vi.fn(),
  invalidateSession: vi.fn(),
  cleanupExpiredNonces: vi.fn(),
  revealMnemonic: vi.fn(),
  enableExecution: vi.fn(),
  revokeExecution: vi.fn(),
  emergencyStopWallet: vi.fn(),
  getUmkForWebhook: vi.fn(),
  healExecutionUmkFromStorage: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn(),
  computeBotPolicyHmac: vi.fn(),
  verifyBotPolicyHmac: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
  repairStaleV3AgentKeyFromLegacy: vi.fn(),
  generateAgentWalletWithMnemonic: vi.fn(),
  encryptAndStoreMnemonic: vi.fn(),
  encryptMnemonicForStorage: vi.fn(),
  encryptAgentKeyV3: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(),
  encryptPooledSubaccountKeyV3: vi.fn(),
  rebindRetainedKeyToBotUuidV3: vi.fn(),
  rebindSubaccountKeyToPooledV3: vi.fn(),
  decryptMnemonic: vi.fn(),
  deriveBotKeypairFromAgentSeed: vi.fn(),
  BOT_DERIVATION_PATH_VERSION: 1,
}));
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: vi.fn(() => ({})),
  getDefaultAdapter: vi.fn(() => ({})),
  getAdapterForBot: vi.fn(() => ({})),
}));

import { registerRoutes } from "../../server/routes";

let currentServer: Server | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (currentServer) {
    (currentServer as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;
  }
  delete process.env.ADMIN_PASSWORD;
});

async function startServer(adminPassword?: string): Promise<string> {
  if (adminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = adminPassword;
  const app = express();
  app.use(express.json());
  currentServer = await registerRoutes(createServer(app), app);
  await new Promise<void>((resolve) => currentServer!.listen(0, "127.0.0.1", resolve));
  const address = currentServer.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral test port");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("scanner incident evidence admin routes", () => {
  it("binds every control and export route directly to requireAdminAuth", () => {
    const source = readFileSync("server/routes.ts", "utf8");
    const registrations = source.match(
      /app\.post\("\/api\/admin\/scanner-incident-evidence\/holds[^\n]+/g,
    ) ?? [];
    expect(registrations).toHaveLength(4);
    expect(registrations.every((line) => line.includes("requireAdminAuth"))).toBe(true);
  });

  it("fails closed when admin auth is unconfigured or wrong", async () => {
    let base = await startServer();
    let response = await post(base, "/api/admin/scanner-incident-evidence/holds", { holdId: "test-hold" });
    expect(response.status).toBe(503);
    expect(storageTarget.activateScannerIncidentHold).toBeUndefined();
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;

    base = await startServer("correct-password");
    response = await post(base, "/api/admin/scanner-incident-evidence/holds", { holdId: "test-hold" }, "wrong-password");
    expect(response.status).toBe(401);
    expect(storageTarget.activateScannerIncidentHold).toBeUndefined();
  }, 60_000);

  it("activates a named hold only after successful admin authentication", async () => {
    const base = await startServer("correct-password");
    storageTarget.activateScannerIncidentHold = vi.fn(async (holdId: string) => ({
      outcome: "activated",
      hold: { id: holdId, state: "baseline" },
    }));
    const response = await post(
      base,
      "/api/admin/scanner-incident-evidence/holds",
      { holdId: "Scanner-Canary.2026_08_11" },
      "correct-password",
    );
    expect(response.status).toBe(201);
    expect(storageTarget.activateScannerIncidentHold).toHaveBeenCalledWith("scanner-canary.2026_08_11");
  }, 60_000);

  it("rejects malformed release proof before storage and passes a normalized proof when valid", async () => {
    const base = await startServer("correct-password");
    let response = await post(
      base,
      "/api/admin/scanner-incident-evidence/holds/test-hold/release",
      { rowCount: -1, digest: "bad" },
      "correct-password",
    );
    expect(response.status).toBe(400);
    expect(storageTarget.releaseScannerIncidentHold).toBeUndefined();

    storageTarget.releaseScannerIncidentHold = vi.fn(async () => ({
      outcome: "released",
      deletedRows: 3,
      alreadyReleased: false,
    }));
    response = await post(
      base,
      "/api/admin/scanner-incident-evidence/holds/test-hold/release",
      { rowCount: 3, digest: "a".repeat(64) },
      "correct-password",
    );
    expect(response.status).toBe(200);
    expect(storageTarget.releaseScannerIncidentHold).toHaveBeenCalledWith("test-hold", {
      rowCount: 3,
      digest: "A".repeat(64),
    });
  }, 60_000);
});
