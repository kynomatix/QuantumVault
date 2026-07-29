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
import { Keypair } from "@solana/web3.js";

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
    req.session = { walletAddress: "AcGW3t57JSQ8VZAq81cEirfDjvtAvtA9r2jtumAjCRaP" };
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
    encryptMnemonicForStorage: vi.fn(),
    getUmkForWebhook: vi.fn(),
  };
});

// agent-wallet: real module with the balance reads + transfer executors stubbed.
vi.mock("../../server/agent-wallet", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentUsdcBalanceRawStrict: vi.fn(),
    getAgentSolBalanceLamportsStrict: vi.fn(),
    executeAgentWithdraw: vi.fn(),
    executeAgentSolWithdraw: vi.fn(),
  };
});

vi.mock("../../server/vault/reset-agent-onchain", () => ({
  assessResetAgentOnChainStrict: vi.fn(),
}));

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
import { provisionExternalKeyBotSubaccount, registerRoutes } from "../../server/routes";
import { storage } from "../../server/storage";
import {
  getSession,
  decryptAgentKeyStrict,
  generateAgentWalletWithMnemonic,
  encryptAgentKeyV3,
  encryptMnemonicForStorage,
  getUmkForWebhook,
} from "../../server/session-v3";
import {
  getAgentUsdcBalanceRawStrict,
  getAgentSolBalanceLamportsStrict,
  executeAgentWithdraw,
  executeAgentSolWithdraw,
} from "../../server/agent-wallet";
import { assessResetAgentOnChainStrict } from "../../server/vault/reset-agent-onchain";
import { discoverOnChainSubaccounts } from "../../server/drift-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A real 32-byte Solana public key is required because the provisioning cells
// exercise the production pooled-key AAD builder rather than mocking it.
const WALLET = "AcGW3t57JSQ8VZAq81cEirfDjvtAvtA9r2jtumAjCRaP"; // must match the session stub literal
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
  vi.mocked(assessResetAgentOnChainStrict as any).mockResolvedValue({ blocked: false });
  vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(0n);
  vi.mocked(getAgentSolBalanceLamportsStrict as any).mockResolvedValue(0n);
  vi.mocked(executeAgentWithdraw as any).mockResolvedValue({ success: true, signature: "sig-usdc" });
  vi.mocked(executeAgentSolWithdraw as any).mockResolvedValue({ success: true, signature: "sig-sol" });
  vi.mocked(generateAgentWalletWithMnemonic as any).mockReturnValue({
    keypair: { publicKey: { toString: () => NEW_AGENT_PK } },
    secretKeyBuffer: Buffer.alloc(64),
    mnemonicBuffer: Buffer.from("test-mnemonic-bytes"),
  });
  vi.mocked(encryptAgentKeyV3 as any).mockReturnValue("encrypted-v3-new");
  vi.mocked(encryptMnemonicForStorage as any).mockReturnValue("encrypted-mnemonic-new");
  vi.mocked(getUmkForWebhook as any).mockResolvedValue({ umk: Buffer.alloc(32, 7), cleanup: vi.fn() });
  vi.mocked(storage.getBorrowPositionsAllScopes as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);
  vi.mocked(storage.getTradingBots as any).mockResolvedValue([]);
  vi.mocked(storage.getAiTraderBotsByWallet as any).mockResolvedValue([]);
  vi.mocked(storage.getProtocolSubaccountsByWallet as any).mockResolvedValue([]);
  vi.mocked(storage.getOrphanedSubaccountsByWallet as any).mockResolvedValue([]);
  vi.mocked(storage.finalizeAgentWalletReset as any).mockResolvedValue({ outcome: "committed", clearedBotCount: 0 });
  vi.mocked(storage.updateWallet as any).mockResolvedValue(undefined);
  vi.mocked(storage.updateWalletAgentKeyV3 as any).mockResolvedValue(undefined);
  vi.mocked(storage.clearTradingBotSubaccount as any).mockResolvedValue(undefined);
}

/** No persistent key/mnemonic mutation of ANY kind happened. */
function expectNoKeyEffects() {
  expect(generateAgentWalletWithMnemonic).not.toHaveBeenCalled();
  expect(encryptMnemonicForStorage).not.toHaveBeenCalled();
  expect(storage.finalizeAgentWalletReset).not.toHaveBeenCalled();
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
  describe("all durable custody tables", () => {
    const custodyCases = [
      {
        label: "linked main-plus-id trading bot",
        method: "getTradingBots",
        row: {
          driftSubaccountId: 0,
          protocolSubaccountId: null,
          subaccountAuthMode: "main_plus_id",
          subaccountStatus: "active",
          botSubaccountKeyEncrypted: null,
          botSubaccountKeyEncryptedV3: "stale-ciphertext",
        },
      },
      {
        label: "linked active independently-keyed trading bot",
        method: "getTradingBots",
        row: {
          driftSubaccountId: null,
          protocolSubaccountId: "active-external-account",
          subaccountAuthMode: "external_key",
          subaccountStatus: "active",
          botSubaccountKeyEncrypted: null,
          botSubaccountKeyEncryptedV3: "bot-v3-key",
        },
      },
      {
        label: "linked keyless AI bot",
        method: "getAiTraderBotsByWallet",
        row: { protocolSubaccountId: "ai-subaccount", botSubaccountKeyEncryptedV3: null },
      },
      {
        label: "linked independently-keyed AI bot",
        method: "getAiTraderBotsByWallet",
        row: { protocolSubaccountId: "ai-keyed-subaccount", botSubaccountKeyEncryptedV3: "ai-v3-key" },
      },
      {
        label: "in-flight protocol reservation",
        method: "getProtocolSubaccountsByWallet",
        row: {
          protocolSubaccountId: "venue-subaccount",
          agentPublicKey: AGENT_PK,
          status: "reserving",
          subaccountKeyEncryptedV3: "pooled-key",
          lastVerifiedEmptyAt: null,
        },
      },
      {
        label: "active protocol registry account",
        method: "getProtocolSubaccountsByWallet",
        row: {
          protocolSubaccountId: "active-registry-account",
          agentPublicKey: AGENT_PK,
          status: "active",
          subaccountKeyEncryptedV3: "pooled-key",
          lastVerifiedEmptyAt: null,
        },
      },
      {
        label: "retry-exhausted matching orphaned subaccount",
        method: "getOrphanedSubaccountsByWallet",
        row: { agentPublicKey: AGENT_PK, retryCount: 500 },
      },
    ] as const;

    it.each(custodyCases)("checkpoint 1 blocks $label before transfers", async ({ method, row }) => {
      vi.mocked((storage as any)[method]).mockResolvedValue([row]);
      const { status, body } = await postReset();
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-transfer" });
      expectNoTransfersAndNoKeyEffects();
      expect(keyCleanup).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain("venue-subaccount");
    });

    it.each(custodyCases)("checkpoint 2 blocks $label after transfers", async ({ method, row }) => {
      vi.mocked((storage as any)[method])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row]);
      vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(10_000_000n);
      const { status, body } = await postReset();
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-key-rotation" });
      expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
      expectNoKeyEffects();
      expect(keyCleanup).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain("venue-subaccount");
    });
  });

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
    {
      label: "trading-bot custody read fails",
      arrange: () => vi.mocked(storage.getTradingBots as any).mockRejectedValue(new Error("pg trading dead")),
    },
    {
      label: "AI custody read fails",
      arrange: () => vi.mocked(storage.getAiTraderBotsByWallet as any).mockRejectedValue(new Error("pg ai dead")),
    },
    {
      label: "protocol registry read fails",
      arrange: () => vi.mocked(storage.getProtocolSubaccountsByWallet as any).mockRejectedValue(new Error("pg registry dead")),
    },
    {
      label: "orphan custody read fails",
      arrange: () => vi.mocked(storage.getOrphanedSubaccountsByWallet as any).mockRejectedValue(new Error("pg orphan dead")),
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
      vi.mocked(getAgentUsdcBalanceRawStrict as any)
        .mockResolvedValueOnce(25_500_000n)
        .mockResolvedValueOnce(0n);
      vi.mocked(getAgentSolBalanceLamportsStrict as any)
        .mockResolvedValueOnce(50_000_000n)
        .mockResolvedValueOnce(2_000_000n);
      vi.mocked(storage.finalizeAgentWalletReset as any).mockResolvedValue({ outcome: "committed", clearedBotCount: 1 });

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
      expect(encryptMnemonicForStorage).toHaveBeenCalledTimes(1);
      expect(storage.finalizeAgentWalletReset).toHaveBeenCalledWith({
        walletAddress: WALLET,
        observedAgentPublicKey: AGENT_PK,
        encryptedMnemonicWords: "encrypted-mnemonic-new",
        newAgentPublicKey: NEW_AGENT_PK,
        newAgentPrivateKeyEncryptedV3: "encrypted-v3-new",
      });
      expect(storage.updateWallet).not.toHaveBeenCalled();
      expect(storage.updateWalletAgentKeyV3).not.toHaveBeenCalled();
      expect(storage.clearTradingBotSubaccount).not.toHaveBeenCalled();
      expect(keyCleanup).toHaveBeenCalledTimes(1);

      // Guard COVERAGE: both kinds read at BOTH checkpoints, wallet-scoped ops both times.
      const posCalls = vi.mocked(storage.getBorrowPositionsAllScopes as any).mock.calls;
      expect(posCalls.filter((c: any[]) => c[0] === WALLET && c[1] === "borrow")).toHaveLength(2);
      expect(posCalls.filter((c: any[]) => c[0] === WALLET && c[1] === "loop")).toHaveLength(2);
      const opCalls = vi.mocked(storage.getBorrowOperations as any).mock.calls;
      expect(opCalls.filter((c: any[]) => c[0] === WALLET)).toHaveLength(2);
      for (const method of [
        "getTradingBots",
        "getAiTraderBotsByWallet",
        "getProtocolSubaccountsByWallet",
        "getOrphanedSubaccountsByWallet",
      ]) {
        expect(vi.mocked((storage as any)[method]).mock.calls).toEqual([[WALLET], [WALLET]]);
      }

      // PLACEMENT: checkpoint 1 precedes the first transfer; checkpoint 2 runs
      // after the last transfer and before the first persistent mutation.
      const posOrders = vi.mocked(storage.getBorrowPositionsAllScopes as any).mock.invocationCallOrder;
      const usdcOrder = vi.mocked(executeAgentWithdraw as any).mock.invocationCallOrder[0];
      const solOrder = vi.mocked(executeAgentSolWithdraw as any).mock.invocationCallOrder[0];
      const finalizeOrder = vi.mocked(storage.finalizeAgentWalletReset as any).mock.invocationCallOrder[0];
      expect(posOrders[0]).toBeLessThan(usdcOrder);
      expect(posOrders[1]).toBeLessThan(usdcOrder);
      expect(posOrders[2]).toBeGreaterThan(solOrder);
      expect(posOrders[3]).toBeLessThan(finalizeOrder);
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
    expect(encryptMnemonicForStorage).toHaveBeenCalledTimes(1);
    expect(storage.finalizeAgentWalletReset).toHaveBeenCalledTimes(1);
    expect(storage.updateWallet).not.toHaveBeenCalled();
    expect(storage.updateWalletAgentKeyV3).not.toHaveBeenCalled();
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
      vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(10_000_000n);
      vi.mocked(getAgentSolBalanceLamportsStrict as any).mockResolvedValue(50_000_000n);

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
      vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(10_000_000n);
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
      vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(10_000_000n);

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

// WO-R1: strict on-chain/balance boundaries and transfer symmetry.
describe("WO-R1 strict reset reads fail closed", () => {
  it("an unreadable adapter assessment at checkpoint 1 performs no transfer or key effect", async () => {
    vi.mocked(assessResetAgentOnChainStrict as any).mockRejectedValueOnce(new Error("rpc private detail"));

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-transfer" });
    expectNoTransfersAndNoKeyEffects();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("private detail");
  });

  it.each([
    {
      label: "USDC balance RPC",
      arrange: () => vi.mocked(getAgentUsdcBalanceRawStrict as any).mockRejectedValueOnce(new Error("usdc rpc raw")),
    },
    {
      label: "SOL balance RPC",
      arrange: () => vi.mocked(getAgentSolBalanceLamportsStrict as any).mockRejectedValueOnce(new Error("sol rpc raw")),
    },
  ])("$label failure at checkpoint 1 is not treated as zero", async ({ arrange }) => {
    arrange();
    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-transfer" });
    expectNoTransfersAndNoKeyEffects();
    expect(JSON.stringify(body)).not.toContain("rpc raw");
  });

  it("checkpoint-2 adapter failure occurs after transfers but before key preparation", async () => {
    vi.mocked(assessResetAgentOnChainStrict as any)
      .mockResolvedValueOnce({ blocked: false })
      .mockRejectedValueOnce(new Error("second rpc raw"));
    vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValueOnce(10_000_000n);

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.phase).toBe("pre-key-rotation");
    expect(body.message).toMatch(/not rolled back/i);
    expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
    expectNoKeyEffects();
    expect(JSON.stringify(body)).not.toContain("second rpc raw");
  });

  it("a post-transfer USDC residue above the skip threshold blocks rotation", async () => {
    vi.mocked(getAgentUsdcBalanceRawStrict as any)
      .mockResolvedValueOnce(10_000_000n)
      .mockResolvedValueOnce(500_000n);

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.phase).toBe("pre-key-rotation");
    expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
    expectNoKeyEffects();
  });
});

describe("WO-R1 checkpoint-2 expanded custody and strict-balance reads", () => {
  it.each([
    "getTradingBots",
    "getAiTraderBotsByWallet",
    "getProtocolSubaccountsByWallet",
    "getOrphanedSubaccountsByWallet",
  ])("%s failure at checkpoint 2 fails closed after transfers", async (method) => {
    vi.mocked((storage as any)[method])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(`private ${method} failure`));
    vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValue(10_000_000n);

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-key-rotation" });
    expect(executeAgentWithdraw).toHaveBeenCalledTimes(1);
    expectNoKeyEffects();
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it.each([
    {
      label: "USDC strict re-read throws",
      arrange: () => vi.mocked(getAgentUsdcBalanceRawStrict as any)
        .mockResolvedValueOnce(10_000_000n)
        .mockRejectedValueOnce(new Error("private post-usdc read")),
    },
    {
      label: "SOL strict re-read throws",
      arrange: () => vi.mocked(getAgentSolBalanceLamportsStrict as any)
        .mockResolvedValueOnce(50_000_000n)
        .mockRejectedValueOnce(new Error("private post-sol read")),
    },
    {
      label: "SOL residue exceeds documented bound",
      arrange: () => vi.mocked(getAgentSolBalanceLamportsStrict as any)
        .mockResolvedValueOnce(50_000_000n)
        .mockResolvedValueOnce(3_000_001n),
    },
  ])("$label blocks before key preparation", async ({ arrange }) => {
    arrange();
    const { status, body } = await postReset();
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "reset-blocked", phase: "pre-key-rotation" });
    expectNoKeyEffects();
    expect(JSON.stringify(body)).not.toContain("private post");
  });
});

describe("WO-R1 attempted transfers are both fail-closed", () => {
  it.each([
    {
      label: "USDC false result",
      arrange: () => {
        vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValueOnce(10_000_000n);
        vi.mocked(executeAgentWithdraw as any).mockResolvedValueOnce({ success: false, error: "raw usdc failure" });
      },
      step: "usdc_withdrawal",
    },
    {
      label: "USDC throw",
      arrange: () => {
        vi.mocked(getAgentUsdcBalanceRawStrict as any).mockResolvedValueOnce(10_000_000n);
        vi.mocked(executeAgentWithdraw as any).mockRejectedValueOnce(new Error("raw usdc throw"));
      },
      step: "usdc_withdrawal",
    },
    {
      label: "SOL false result",
      arrange: () => {
        vi.mocked(getAgentSolBalanceLamportsStrict as any).mockResolvedValueOnce(50_000_000n);
        vi.mocked(executeAgentSolWithdraw as any).mockResolvedValueOnce({ success: false, error: "raw sol failure" });
      },
      step: "sol_withdrawal",
    },
    {
      label: "SOL throw",
      arrange: () => {
        vi.mocked(getAgentSolBalanceLamportsStrict as any).mockResolvedValueOnce(50_000_000n);
        vi.mocked(executeAgentSolWithdraw as any).mockRejectedValueOnce(new Error("raw sol throw"));
      },
      step: "sol_withdrawal",
    },
  ])("$label retains the old key and names the operator path", async ({ arrange, step }) => {
    arrange();
    const { status, body } = await postReset();

    expect(status).toBe(400);
    expect(body.step).toBe(step);
    expect(body.error).toMatch(/Wallet Management/i);
    if (step === "sol_withdrawal") {
      expect(body.error).toMatch(/USDC transfer already completed was not rolled back/i);
    } else {
      expect(body.error).not.toMatch(/USDC transfer already completed/i);
    }
    expect(JSON.stringify(body)).not.toMatch(/raw (usdc|sol)/i);
    expectNoKeyEffects();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("WO-R1 atomic finalizer outcomes are truthful", () => {
  it.each([
    { outcome: { outcome: "busy" }, error: "reset-in-progress", text: /another reset.*completing/i },
    { outcome: { outcome: "blocked", reason: "active_vault_state" }, error: "reset-blocked", text: /existing agent key remains authoritative/i },
    { outcome: { outcome: "lost_race", keyChanged: true }, error: "reset-race-lost", text: /agent key has changed/i },
  ])("returns $error without legacy split writes", async ({ outcome, error, text }) => {
    vi.mocked(storage.finalizeAgentWalletReset as any).mockResolvedValueOnce(outcome);

    const { status, body } = await postReset();

    expect(status).toBe(409);
    expect(body.error).toBe(error);
    expect(body.message).toMatch(text);
    expect(body.message).toMatch(/not rolled back/i);
    expect(storage.updateWallet).not.toHaveBeenCalled();
    expect(storage.updateWalletAgentKeyV3).not.toHaveBeenCalled();
    expect(storage.clearTradingBotSubaccount).not.toHaveBeenCalled();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
  });

  it("a finalizer infrastructure failure is sanitized and retains the old key", async () => {
    vi.mocked(storage.finalizeAgentWalletReset as any).mockRejectedValueOnce(new Error("pg secret detail"));

    const { status, body } = await postReset();

    expect(status).toBe(503);
    expect(body.error).toBe("reset-finalize-unavailable");
    expect(body.message).toMatch(/existing agent key remains authoritative/i);
    expect(body.message).toMatch(/unless Wallet Management shows that the reset completed/i);
    expect(JSON.stringify(body)).not.toContain("pg secret detail");
    expect(keyCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("WO-R1-C1 external-key provisioning write-ahead", () => {
  function adapter(overrides: Record<string, unknown> = {}) {
    return {
      protocolName: "pacifica",
      getCapabilities: () => ({ requiresExternalSubaccountKey: true, walletDerivation: "random" }),
      provisionFundedSubaccount: vi.fn(async (p: any) => ({
        subaccountId: Keypair.fromSecretKey(p.subSecretKey).publicKey.toString(),
        transferSucceeded: true,
        wasNewAccount: false,
        fundedAmount: 10,
      })),
      approveBuilderCodeForUser: vi.fn(async () => {}),
      claimReferralCodeForUser: vi.fn(async () => {}),
      ...overrides,
    } as any;
  }

  it("persists a pooled-key reservation before the first funding call", async () => {
    const venue = adapter();
    vi.mocked(storage.prepareExternalSubaccountReservation as any).mockResolvedValue({ outcome: "prepared" });

    const result = await provisionExternalKeyBotSubaccount({
      walletAddress: WALLET,
      agentKeypair: Keypair.generate(),
      agentMnemonic: null,
      adapter: venue,
      fundingAmount: 10,
      umk: Buffer.alloc(32, 9),
    });

    expect(storage.prepareExternalSubaccountReservation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.prepareExternalSubaccountReservation as any).mock.invocationCallOrder[0])
      .toBeLessThan(venue.provisionFundedSubaccount.mock.invocationCallOrder[0]);
    expect(vi.mocked(storage.prepareExternalSubaccountReservation as any).mock.calls[0][0]).toMatchObject({
      walletAddress: WALLET,
      protocol: "pacifica",
      observedAgentPublicKey: expect.any(String),
      subaccountKeyEncryptedV3: expect.any(String),
      claimToken: expect.any(String),
    });
    expect(result.reservationClaimToken).toEqual(expect.any(String));
    const fundedTargetKey = venue.provisionFundedSubaccount.mock.calls[0][0].subSecretKey as Uint8Array;
    expect(result.pendingBotSecretKeyForV3).toBe(fundedTargetKey);
    result.pendingBotSecretKeyForV3.fill(0);
    expect(Array.from(fundedTargetKey).every((b) => b === 0)).toBe(true);
  });

  it.each(["stale_generation", "conflict"])("%s prepare result prevents every venue call", async (outcome) => {
    const venue = adapter();
    vi.mocked(storage.prepareExternalSubaccountReservation as any).mockResolvedValue({ outcome });

    await expect(provisionExternalKeyBotSubaccount({
      walletAddress: WALLET,
      agentKeypair: Keypair.generate(),
      agentMnemonic: null,
      adapter: venue,
      fundingAmount: 10,
      umk: Buffer.alloc(32, 9),
    })).rejects.toThrow();

    expect(venue.provisionFundedSubaccount).not.toHaveBeenCalled();
  });

  it("a crash/failure after funding starts leaves the durable pooled-key marker and zeroizes the raw target key", async () => {
    let capturedTargetKey: Uint8Array | null = null;
    const venue = adapter({
      provisionFundedSubaccount: vi.fn(async (p: any) => {
        capturedTargetKey = p.subSecretKey;
        throw new Error("simulated process-boundary failure");
      }),
    });
    vi.mocked(storage.prepareExternalSubaccountReservation as any).mockResolvedValue({ outcome: "prepared" });

    await expect(provisionExternalKeyBotSubaccount({
      walletAddress: WALLET,
      agentKeypair: Keypair.generate(),
      agentMnemonic: null,
      adapter: venue,
      fundingAmount: 10,
      umk: Buffer.alloc(32, 9),
    })).rejects.toThrow(/process-boundary/);

    expect(storage.prepareExternalSubaccountReservation).toHaveBeenCalledTimes(1);
    expect(capturedTargetKey).not.toBeNull();
    expect(Array.from(capturedTargetKey!).every((b) => b === 0)).toBe(true);
  });
});
