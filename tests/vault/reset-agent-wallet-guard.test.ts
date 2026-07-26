/**
 * tests/vault/reset-agent-wallet-guard.test.ts — WO2B1
 *
 * Exercises the REAL registered POST /api/wallet/reset-agent-wallet route
 * (express app via registerRoutes + ephemeral listener) and pins the
 * fail-closed vault ownership guard:
 *
 *  - checkpoint 1 (pre-transfer): every blocker class — non-terminal classic
 *    and loop positions across account and per-bot scopes, non-terminal
 *    operations of any type (linked, unlinked, closed-source loop hop, the
 *    future agent_sol_withdraw), unknown/future statuses, and DB read
 *    failures — returns 409 {error:"reset-blocked", phase:"pre-transfer"}
 *    with ZERO transfers, ZERO key/mnemonic effects, no private details.
 *  - terminal-only rows (positions closed|failed; ops succeeded|completed|
 *    failed) leave the reset behavior unchanged end-to-end.
 *  - checkpoint 2 (pre-key-rotation): a blocker or read failure surfacing
 *    only AFTER the transfer phase blocks before the first persistent
 *    mnemonic/key mutation; completed transfers stand, the existing key
 *    stays authoritative, decrypted-key cleanup still runs exactly once.
 *
 * The transfer/rotation seams are mocked; the route body, ordering, and the
 * guard itself are real.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// ---------------------------------------------------------------------------

// Storage: lazy Proxy — every method becomes an auto-registered vi.fn.
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
// reset route authenticates via requireWallet (session wallet REQUIRED), so
// the stub plants the session wallet on every request.
vi.mock("../../server/session", () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: "wallet-reset-guard-test" };
    next();
  },
}));

// session-v3: real module with ONLY the reset seams overridden.
vi.mock("../../server/session-v3", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(),
    decryptAgentKeyStrict: vi.fn(),
    generateAgentWalletWithMnemonic: vi.fn(),
    encryptAgentKeyV3: vi.fn(),
    encryptAndStoreMnemonic: vi.fn(),
  };
});

// agent-wallet: real module with the balance reads + transfer executors stubbed.
vi.mock("../../server/agent-wallet", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentUsdcBalance: vi.fn(),
    getAgentSolBalance: vi.fn(),
    executeAgentWithdraw: vi.fn(),
    executeAgentSolWithdraw: vi.fn(),
  };
});

// drift-service: subaccount discovery returns [] so the (out-of-scope) Drift
// pre-checks pass without touching any adapter.
vi.mock("../../server/drift-service", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discoverOnChainSubaccounts: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import express from "express";
import { createServer, type Server } from "http";
import { registerRoutes } from "../../server/routes";
import { storage } from "../../server/storage";
import {
  getSession,
  decryptAgentKeyStrict,
  generateAgentWalletWithMnemonic,
  encryptAgentKeyV3,
  encryptAndStoreMnemonic,
} from "../../server/session-v3";
import {
  getAgentUsdcBalance,
  getAgentSolBalance,
  executeAgentWithdraw,
  executeAgentSolWithdraw,
} from "../../server/agent-wallet";
import { discoverOnChainSubaccounts } from "../../server/drift-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET = "wallet-reset-guard-test"; // must match the session stub literal
const SESSION_ID = "sess-reset-1";
const AGENT_PK = "AgentPkOld1111111111111111111111111111111111";
const NEW_AGENT_PK = "AgentPkNew2222222222222222222222222222222222";

const posRow = (over: Record<string, unknown> = {}) => ({
  id: "pos-77",
  walletAddress: WALLET,
  tradingBotId: null,
  kind: "borrow",
  status: "open",
  ...over,
});

const opRow = (over: Record<string, unknown> = {}) => ({
  id: "op-88",
  walletAddress: WALLET,
  borrowPositionId: "pos-77",
  operationType: "borrow_open",
  status: "pending",
  ...over,
});

let server: Server;
let base: string;
let keyCleanup: ReturnType<typeof vi.fn>;

async function postReset() {
  const r = await fetch(`${base}/api/wallet/reset-agent-wallet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

/** Prime a fully CLEAN, zero-balance reset: guard reads empty, dust balances. */
function primeClean() {
  keyCleanup = vi.fn();
  vi.mocked(storage.getWallet as any).mockResolvedValue({
    walletAddress: WALLET,
    agentPublicKey: AGENT_PK,
    agentPrivateKeyEncryptedV3: "v3-ciphertext-old",
  });
  vi.mocked(getSession as any).mockReturnValue({ walletAddress: WALLET, umk: Buffer.alloc(32) });
  vi.mocked(decryptAgentKeyStrict as any).mockResolvedValue({
    secretKey: new Uint8Array(64),
    cleanup: keyCleanup,
  });
  vi.mocked(discoverOnChainSubaccounts as any).mockResolvedValue([]);
  vi.mocked(getAgentUsdcBalance as any).mockResolvedValue(0);
  vi.mocked(getAgentSolBalance as any).mockResolvedValue(0);
  vi.mocked(executeAgentWithdraw as any).mockResolvedValue({ success: true, signature: "sig-usdc" });
  vi.mocked(executeAgentSolWithdraw as any).mockResolvedValue({ success: true, signature: "sig-sol" });
  vi.mocked(generateAgentWalletWithMnemonic as any).mockReturnValue({
    keypair: { publicKey: { toString: () => NEW_AGENT_PK } },
    secretKeyBuffer: Buffer.alloc(64),
    mnemonicBuffer: Buffer.from("test-mnemonic-bytes"),
  });
  vi.mocked(encryptAgentKeyV3 as any).mockReturnValue("encrypted-v3-new");
  vi.mocked(encryptAndStoreMnemonic as any).mockResolvedValue(undefined);
  vi.mocked(storage.getBorrowPositionsAllScopes as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);
  vi.mocked(storage.getTradingBots as any).mockResolvedValue([]);
  vi.mocked(storage.updateWallet as any).mockResolvedValue(undefined);
  vi.mocked(storage.updateWalletAgentKeyV3 as any).mockResolvedValue(undefined);
  vi.mocked(storage.clearTradingBotSubaccount as any).mockResolvedValue(undefined);
}

/** No persistent key/mnemonic mutation of ANY kind happened. */
function expectNoKeyEffects() {
  expect(generateAgentWalletWithMnemonic).not.toHaveBeenCalled();
  expect(encryptAndStoreMnemonic).not.toHaveBeenCalled();
  expect(storage.updateWallet).not.toHaveBeenCalled();
  expect(storage.updateWalletAgentKeyV3).not.toHaveBeenCalled();
  expect(storage.clearTradingBotSubaccount).not.toHaveBeenCalled();
}

function expectNoTransfersAndNoKeyEffects() {
  expect(executeAgentWithdraw).not.toHaveBeenCalled();
  expect(executeAgentSolWithdraw).not.toHaveBeenCalled();
  expectNoKeyEffects();
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
  primeClean();
});

// ---------------------------------------------------------------------------
// Checkpoint 1 — position blocker classes (both kinds, both scopes)
// ---------------------------------------------------------------------------

describe("reset guard checkpoint 1 — non-terminal POSITIONS block pre-transfer", () => {
  const positionBlockerCases = [
    { label: "classic OPEN at account scope", kind: "borrow", row: posRow({ status: "open", tradingBotId: null }) },
    { label: "classic PENDING at per-bot scope", kind: "borrow", row: posRow({ status: "pending", tradingBotId: "bot-7" }) },
    { label: "classic CLOSING at account scope", kind: "borrow", row: posRow({ status: "closing" }) },
    { label: "loop OPEN at per-bot scope", kind: "loop", row: posRow({ kind: "loop", status: "open", tradingBotId: "bot-7" }) },
    { label: "loop HOLD at account scope", kind: "loop", row: posRow({ kind: "loop", status: "hold" }) },
    { label: "FUTURE/unknown position status", kind: "borrow", row: posRow({ status: "quarantined_v9" }) },
    { label: "NULL position status (malformed row)", kind: "loop", row: posRow({ kind: "loop", status: null }) },
  ];

  it.each(positionBlockerCases)("blocks: $label", async ({ kind, row }) => {
    vi.mocked(storage.getBorrowPositionsAllScopes as any).mockImplementation(
      async (_w: string, k: string) => (k === kind ? [row] : []),
    );

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.error).toBe("reset-blocked");
    expect(body.phase).toBe("pre-transfer");
    expectNoTransfersAndNoKeyEffects();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("pos-77");
    expect(raw).not.toContain("bot-7");
    expect(raw).not.toContain("quarantined_v9");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 1 — operation blocker classes
// ---------------------------------------------------------------------------

describe("reset guard checkpoint 1 — non-terminal OPERATIONS block pre-transfer", () => {
  const operationBlockerCases: Array<{
    label: string;
    ops: Array<Record<string, unknown>>;
    loopPositions?: Array<Record<string, unknown>>;
  }> = [
    { label: "classic op PENDING (position-linked)", ops: [opRow()] },
    {
      label: "loop hop PARKED whose SOURCE position is already CLOSED",
      ops: [opRow({ id: "op-hop-1", operationType: "loop_hop", status: "parked", borrowPositionId: "pos-closed-1" })],
      loopPositions: [posRow({ id: "pos-closed-1", kind: "loop", status: "closed" })], // terminal — op alone must block
    },
    { label: "op RECOVERING with NO position link", ops: [opRow({ status: "recovering", borrowPositionId: null })] },
    {
      label: "FUTURE op type agent_sol_withdraw PENDING with no link",
      ops: [opRow({ id: "op-sol-9", operationType: "agent_sol_withdraw", status: "pending", borrowPositionId: null })],
    },
    { label: "op PROCESSING (fixed-yield executor state)", ops: [opRow({ operationType: "fy_deposit", status: "processing" })] },
    { label: "op NEEDS_ATTENTION (repay recovery state)", ops: [opRow({ operationType: "repay_wallet_usdc", status: "needs_attention" })] },
    { label: "NULL op status (malformed row)", ops: [opRow({ status: null })] },
  ];

  it.each(operationBlockerCases)("blocks: $label", async ({ ops, loopPositions }) => {
    if (loopPositions) {
      vi.mocked(storage.getBorrowPositionsAllScopes as any).mockImplementation(
        async (_w: string, k: string) => (k === "loop" ? loopPositions : []),
      );
    }
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue(ops);

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.error).toBe("reset-blocked");
    expect(body.phase).toBe("pre-transfer");
    expectNoTransfersAndNoKeyEffects();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("op-");
    expect(raw).not.toContain("agent_sol_withdraw");
    expect(raw).not.toContain("loop_hop");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 1 — fail-closed on DB read errors
// ---------------------------------------------------------------------------

describe("reset guard checkpoint 1 — DB read failures fail CLOSED", () => {
  const readErrorCases = [
    {
      label: "classic positions read fails",
      arrange: () =>
        vi.mocked(storage.getBorrowPositionsAllScopes as any).mockImplementation(async (_w: string, k: string) => {
          if (k === "borrow") throw new Error("pg classic dead");
          return [];
        }),
    },
    {
      label: "loop positions read fails",
      arrange: () =>
        vi.mocked(storage.getBorrowPositionsAllScopes as any).mockImplementation(async (_w: string, k: string) => {
          if (k === "loop") throw new Error("pg loop dead");
          return [];
        }),
    },
    {
      label: "operations read fails",
      arrange: () => vi.mocked(storage.getBorrowOperations as any).mockRejectedValue(new Error("pg ops dead")),
    },
  ];

  it.each(readErrorCases)("blocks: $label", async ({ arrange }) => {
    arrange();

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.error).toBe("reset-blocked");
    expect(body.phase).toBe("pre-transfer");
    expectNoTransfersAndNoKeyEffects();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("pg ");
  });
});

// ---------------------------------------------------------------------------
// Terminal-only rows — clean reset behavior UNCHANGED
// ---------------------------------------------------------------------------

describe("reset proceeds over terminal-only vault rows", () => {
  it(
    "closed/failed positions (both kinds, both scopes) + succeeded/completed/failed ops → full reset with transfers, rotation, clearing",
    async () => {
      vi.mocked(storage.getBorrowPositionsAllScopes as any).mockImplementation(async (_w: string, k: string) =>
        k === "borrow"
          ? [posRow({ status: "closed" }), posRow({ id: "pos-78", status: "failed", tradingBotId: "bot-7" })]
          : [
              posRow({ id: "pos-79", kind: "loop", status: "closed", tradingBotId: "bot-7" }),
              posRow({ id: "pos-80", kind: "loop", status: "failed" }),
            ],
      );
      vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
        opRow({ status: "succeeded" }),
        opRow({ id: "op-89", operationType: "loop_hop", status: "completed" }),
        opRow({ id: "op-90", operationType: "agent_sol_withdraw", status: "failed", borrowPositionId: null }),
      ]);
      vi.mocked(getAgentUsdcBalance as any).mockResolvedValue(25.5);
      vi.mocked(getAgentSolBalance as any).mockResolvedValue(0.05);
      vi.mocked(storage.getTradingBots as any).mockResolvedValue([
        { id: "bot-1", driftSubaccountId: 2 },
        { id: "bot-2", driftSubaccountId: null },
      ]);

      const { status, body } = await postReset();

      expect(status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        oldAgentWallet: AGENT_PK,
        newAgentWallet: NEW_AGENT_PK,
        withdrawnUsdc: 25.5,
      });
      expect(body.withdrawnSol).toBeCloseTo(0.048, 6);
      expect(Array.isArray(body.progress)).toBe(true);

      expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
      expect(executeAgentSolWithdraw).toHaveBeenCalledTimes(1);
      expect(encryptAndStoreMnemonic).toHaveBeenCalledTimes(1);
      expect(storage.updateWallet).toHaveBeenCalledWith(WALLET, { agentPublicKey: NEW_AGENT_PK });
      expect(storage.updateWalletAgentKeyV3).toHaveBeenCalledTimes(1);
      expect(storage.clearTradingBotSubaccount).toHaveBeenCalledTimes(1);
      expect(storage.clearTradingBotSubaccount).toHaveBeenCalledWith("bot-1");
      expect(keyCleanup).toHaveBeenCalledTimes(1);

      // Guard COVERAGE: both kinds read at BOTH checkpoints, wallet-scoped ops both times.
      const posCalls = vi.mocked(storage.getBorrowPositionsAllScopes as any).mock.calls;
      expect(posCalls.filter((c: any[]) => c[0] === WALLET && c[1] === "borrow")).toHaveLength(2);
      expect(posCalls.filter((c: any[]) => c[0] === WALLET && c[1] === "loop")).toHaveLength(2);
      const opCalls = vi.mocked(storage.getBorrowOperations as any).mock.calls;
      expect(opCalls.filter((c: any[]) => c[0] === WALLET)).toHaveLength(2);

      // PLACEMENT: checkpoint 1 precedes the first transfer; checkpoint 2 runs
      // after the last transfer and before the first persistent mutation.
      const posOrders = vi.mocked(storage.getBorrowPositionsAllScopes as any).mock.invocationCallOrder;
      const usdcOrder = vi.mocked(executeAgentWithdraw as any).mock.invocationCallOrder[0];
      const solOrder = vi.mocked(executeAgentSolWithdraw as any).mock.invocationCallOrder[0];
      const mnemonicOrder = vi.mocked(encryptAndStoreMnemonic as any).mock.invocationCallOrder[0];
      expect(posOrders[0]).toBeLessThan(usdcOrder);
      expect(posOrders[1]).toBeLessThan(usdcOrder);
      expect(posOrders[2]).toBeGreaterThan(solOrder);
      expect(posOrders[3]).toBeLessThan(mnemonicOrder);
    },
    20_000,
  );

  it("dust balances skip transfers entirely but the reset still rotates the key", async () => {
    // primeClean defaults: usdc 0, sol 0 → both transfer branches skipped.
    const { status, body } = await postReset();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.withdrawnUsdc).toBe(0);
    expect(body.withdrawnSol).toBe(0);
    expect(executeAgentWithdraw).not.toHaveBeenCalled();
    expect(executeAgentSolWithdraw).not.toHaveBeenCalled();
    expect(encryptAndStoreMnemonic).toHaveBeenCalledTimes(1);
    expect(storage.updateWallet).toHaveBeenCalledTimes(1);
    expect(storage.updateWalletAgentKeyV3).toHaveBeenCalledTimes(1);
    expect(keyCleanup).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 2 — blocker appears ONLY after the transfer phase
// ---------------------------------------------------------------------------

describe("reset guard checkpoint 2 — pre-key-rotation, transfers stand, key untouched", () => {
  it(
    "loop position OPEN surfacing only at checkpoint 2 → 409 pre-key-rotation AFTER real transfers, zero persistent key effects",
    async () => {
      vi.mocked(storage.getBorrowPositionsAllScopes as any)
        .mockResolvedValueOnce([]) // checkpoint 1, kind=borrow
        .mockResolvedValueOnce([]) // checkpoint 1, kind=loop
        .mockResolvedValueOnce([]) // checkpoint 2, kind=borrow
        .mockResolvedValueOnce([posRow({ id: "pos-9", kind: "loop", status: "open", tradingBotId: "bot-3" })]);
      vi.mocked(getAgentUsdcBalance as any).mockResolvedValue(10);
      vi.mocked(getAgentSolBalance as any).mockResolvedValue(0.05);

      const { status, body } = await postReset();

      expect(status).toBe(409);
      expect(body.error).toBe("reset-blocked");
      expect(body.phase).toBe("pre-key-rotation");
      expect(body.message).toMatch(/not rolled back/i);
      expect(body.message).toMatch(/existing agent key remains authoritative/i);

      // Transfers genuinely ran BEFORE the block…
      expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
      expect(executeAgentSolWithdraw).toHaveBeenCalledTimes(1);
      // …and nothing persistent about key/mnemonic/subaccounts happened.
      expectNoKeyEffects();
      expect(keyCleanup).toHaveBeenCalledTimes(1);

      const raw = JSON.stringify(body);
      expect(raw).not.toContain("pos-9");
      expect(raw).not.toContain("bot-3");
    },
    20_000,
  );

  it(
    "pending op (agent_sol_withdraw, no link) surfacing only at checkpoint 2 → 409 pre-key-rotation, zero persistent key effects",
    async () => {
      vi.mocked(storage.getBorrowOperations as any)
        .mockResolvedValueOnce([]) // checkpoint 1
        .mockResolvedValueOnce([opRow({ id: "op-sol-2", operationType: "agent_sol_withdraw", status: "pending", borrowPositionId: null })]);
      vi.mocked(getAgentUsdcBalance as any).mockResolvedValue(10);
      // sol stays 0 → SOL branch skipped; USDC transfer still proves phase ordering.

      const { status, body } = await postReset();

      expect(status).toBe(409);
      expect(body.phase).toBe("pre-key-rotation");
      expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
      expectNoKeyEffects();
      expect(keyCleanup).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain("agent_sol_withdraw");
    },
    20_000,
  );

  it(
    "DB read failure at checkpoint 2 fails CLOSED pre-key-rotation without leaking the error",
    async () => {
      vi.mocked(storage.getBorrowOperations as any)
        .mockResolvedValueOnce([]) // checkpoint 1
        .mockRejectedValueOnce(new Error("pg ops dead midway"));
      vi.mocked(getAgentUsdcBalance as any).mockResolvedValue(10);

      const { status, body } = await postReset();

      expect(status).toBe(409);
      expect(body.error).toBe("reset-blocked");
      expect(body.phase).toBe("pre-key-rotation");
      expect(body.message).toMatch(/not rolled back/i);
      expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
      expectNoKeyEffects();
      expect(keyCleanup).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain("pg ops dead");
    },
    20_000,
  );
});
