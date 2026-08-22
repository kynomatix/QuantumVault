import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/storage", () => ({
  storage: new Proxy({}, {
    get: (target: Record<string, unknown>, property: string | symbol) => {
      if (typeof property !== "string" || property === "then") return undefined;
      return (target[property] ??= vi.fn(async () => undefined));
    },
  }),
  DatabaseStorage: class DatabaseStorage {},
}));

vi.mock("../../server/db", () => ({
  db: {},
  isConnectionClassError: vi.fn(() => false),
}));

vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: vi.fn(() => ({})),
  getDefaultAdapter: vi.fn(() => ({})),
  getAdapterForBot: vi.fn(() => ({})),
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

import { toPublicWalletResponse } from "../../server/routes";

const ORIGINAL_SESSION_SECRET = process.env.SESSION_SECRET;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("express-session");
  vi.doUnmock("connect-pg-simple");
  vi.doUnmock("pg");
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

async function loadSessionModule(secret: string | undefined) {
  vi.resetModules();
  if (secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;

  const sessionFactory = vi.fn((options: Record<string, unknown>) => options);
  class Pool {
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    on = vi.fn();
  }
  const connectPgSimple = vi.fn(() => class PgStore {
    constructor(public readonly options: Record<string, unknown>) {}
  });

  vi.doMock("express-session", () => ({ default: sessionFactory }));
  vi.doMock("connect-pg-simple", () => ({ default: connectPgSimple }));
  vi.doMock("pg", () => ({ default: { Pool } }));

  const module = await import("../../server/session");
  return { module, sessionFactory };
}

describe("wallet credential response boundary", () => {
  it("returns exactly the established five-field public wallet identity", () => {
    const wallet = {
      address: "wallet-address",
      displayName: "Alice",
      driftSubaccount: 7,
      agentPublicKey: "agent-public-key",
      referralCode: "REFCODE",
      agentPrivateKeyEncrypted: "legacy-ciphertext",
      agentPrivateKeyEncryptedV3: "v3-ciphertext",
      encryptedUserMasterKey: "encrypted-umk",
      encryptedMnemonicWords: "encrypted-mnemonic",
      umkEncryptedForExecution: "execution-umk",
      userSalt: "salt",
      userWebhookSecret: "webhook-secret",
      policyHmac: "policy-hmac",
      telegramChatId: "telegram-id",
      executionEnabled: true,
      emergencyStopTriggered: false,
    };

    expect(toPublicWalletResponse(wallet as never)).toEqual({
      address: "wallet-address",
      displayName: "Alice",
      driftSubaccount: 7,
      agentPublicKey: "agent-public-key",
      referralCode: "REFCODE",
    });
    expect(Object.keys(toPublicWalletResponse(wallet as never))).toEqual([
      "address",
      "displayName",
      "driftSubaccount",
      "agentPublicKey",
      "referralCode",
    ]);
  });

  it("keeps both wallet identity routes on the serializer and forbids a raw wallet response", () => {
    const source = readFileSync("server/routes.ts", "utf8");
    expect(source.match(/res\.json\(toPublicWalletResponse\(wallet\)\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/res\.json\(wallet\)/);
  });
});

describe("SESSION_SECRET startup authority", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", "  \t  "],
  ])("fails closed when SESSION_SECRET is %s", async (_label, secret) => {
    await expect(loadSessionModule(secret)).rejects.toThrow(
      "SESSION_SECRET environment variable is required",
    );
  });

  it("passes the configured secret through exactly without exposing a fallback", async () => {
    const configured = "  deliberately-untrimmed-session-secret  ";
    const { sessionFactory } = await loadSessionModule(configured);

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(sessionFactory.mock.calls[0]?.[0]).toMatchObject({ secret: configured });

    const source = readFileSync("server/session.ts", "utf8");
    expect(source).not.toContain("quantum-vault-secret-change-in-production");
    expect(source).not.toMatch(/SESSION_SECRET\s*\|\|/);
  });
});
