import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const destroySession = vi.hoisted(() => vi.fn((done: (error?: Error) => void) => done()));
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
  sessionMiddleware: (req: { session?: unknown }, _res: unknown, next: () => void) => {
    req.session = { walletAddress: "readiness-wallet", destroy: destroySession };
    next();
  },
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
import { serveStatic } from "../../server/static";
import { createRuntimeHealthHandler, createRuntimeReadinessMiddleware } from "../../server/runtime-deployment-identity";
import { recordDatabaseCheck } from "../../server/database-readiness";
import { createSigningNonce, verifySignatureAndConsumeNonce, invalidateSession } from "../../server/session-v3";

let server: Server;
let origin: string;
let assetRoot: string;
let bootReady: boolean;
beforeEach(async () => {
  vi.clearAllMocks();
  recordDatabaseCheck(true);
  bootReady = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const app = express();
  app.get("/health", createRuntimeHealthHandler(() => bootReady));
  app.get("/api/health", createRuntimeHealthHandler(() => bootReady));
  app.use(createRuntimeReadinessMiddleware(() => bootReady, "starting"));
  app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  assetRoot = mkdtempSync(join(tmpdir(), "qv-readiness-"));
  mkdirSync(join(assetRoot, "dist", "public", "assets"), { recursive: true });
  writeFileSync(join(assetRoot, "dist", "public", "index.html"), "<html>application</html>");
  writeFileSync(join(assetRoot, "dist", "public", "assets", "readiness.js"), "window.readinessAsset = true;");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(assetRoot);
  try { serveStatic(app); } finally { cwd.mockRestore(); }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (assetRoot) rmSync(assetRoot, { recursive: true, force: true });
  recordDatabaseCheck(true);
  vi.restoreAllMocks();
});
function outage() { recordDatabaseCheck(false); recordDatabaseCheck(false); }
async function post(path: string, body: unknown) {
  return fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("post-boot outage through real route and static modules", () => {
  it("serves a JavaScript asset while both health endpoints report degradation", async () => {
    outage();
    for (const path of ["/health", "/api/health"]) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: false, reason: expect.stringContaining("Database") });
    }
    const asset = await fetch(origin + "/assets/readiness.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("window.readinessAsset = true;");
  });
  it("reaches the nonce and verify handlers and preserves their own failure responses", async () => {
    outage();
    vi.mocked(createSigningNonce).mockRejectedValueOnce(new Error("database unavailable"));
    const nonce = await post("/api/auth/nonce", { walletAddress: "readiness-wallet", purpose: "unlock_umk" });
    expect(nonce.status).toBe(500);
    expect(await nonce.json()).toEqual({ error: "Failed to create nonce" });
    expect(createSigningNonce).toHaveBeenCalledWith("readiness-wallet", "unlock_umk");
    vi.mocked(verifySignatureAndConsumeNonce).mockRejectedValueOnce(new Error("database unavailable"));
    const verify = await post("/api/auth/verify", { walletAddress: "readiness-wallet", nonce: "test-nonce", signature: [1], purpose: "unlock_umk" });
    expect(verify.status).toBe(500);
    expect(await verify.json()).toEqual({ error: "Verification failed" });
    expect(verifySignatureAndConsumeNonce).toHaveBeenCalledTimes(1);
  });
  it("reaches logout invalidation and session destruction during the outage", async () => {
    outage();
    const logout = await post("/api/auth/logout", {});
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ success: true });
    expect(invalidateSession).toHaveBeenCalledWith("readiness-wallet");
    expect(destroySession).toHaveBeenCalledTimes(1);
  });
  it("keeps real routes and static behind the original boot gate until first readiness", async () => {
    bootReady = false;
    outage();
    for (const path of ["/api/auth/nonce", "/api/auth/verify", "/api/auth/logout"]) {
      const response = await post(path, {});
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ message: "Server is starting up — please retry shortly" });
    }
    expect(createSigningNonce).not.toHaveBeenCalled();
    expect(verifySignatureAndConsumeNonce).not.toHaveBeenCalled();
    expect(invalidateSession).not.toHaveBeenCalled();
    const asset = await fetch(origin + "/assets/readiness.js");
    expect(await asset.text()).toBe("starting");
    expect(asset.headers.get("cache-control")).toBe("no-store");
  });
});
