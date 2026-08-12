import nodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAAD, encryptToBase64, zeroizeBuffer } from "../../server/crypto-v3";

const storageMocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  getTradingBots: vi.fn(),
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getWallet: (...args: unknown[]) => storageMocks.getWallet(...args),
    getTradingBots: (...args: unknown[]) => storageMocks.getTradingBots(...args),
  },
}));

const WALLET = "11111111111111111111111111111111";
const RAW_SENTINEL = "RAW_DATABASE_TIMEOUT_42P01_STACK_SHOULD_NOT_APPEAR";
const STORAGE_SECRET = "11".repeat(32);

function joinedConsoleCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map((value) => String(value)).join("\n");
}

beforeEach(() => {
  vi.resetModules();
  storageMocks.getWallet.mockReset();
  storageMocks.getTradingBots.mockReset();
  storageMocks.getTradingBots.mockResolvedValue([]);
  vi.stubEnv("UMK_STORAGE_SECRET", STORAGE_SECRET);
  vi.stubEnv("AGENT_ENCRYPTION_KEY", "22".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("restoreWalletSecurityFromStorageOutcome", () => {
  it("classifies only an initial storage rejection as transient and keeps the compatibility wrapper null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { restoreWalletSecurityFromStorageOutcome, restoreWalletSecurityFromStorage } = await import("../../server/session-v3");
    storageMocks.getWallet.mockRejectedValueOnce(new Error(RAW_SENTINEL));

    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({
      status: "transient_read_failed",
    });

    storageMocks.getWallet.mockRejectedValueOnce(new Error(RAW_SENTINEL));
    await expect(restoreWalletSecurityFromStorage(WALLET)).resolves.toBeNull();

    const logged = joinedConsoleCalls(errorSpy);
    expect(logged).toContain("transient_read_failed");
    expect(logged).not.toContain(RAW_SENTINEL);
    expect(logged).not.toContain(WALLET);
  });

  it("classifies missing, unsupported, malformed, undecryptable, and unexpected post-read evidence as reauth_required", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { restoreWalletSecurityFromStorageOutcome, restoreWalletSecurityFromStorage } = await import("../../server/session-v3");

    storageMocks.getWallet.mockResolvedValueOnce(null);
    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({ status: "reauth_required" });

    storageMocks.getWallet.mockResolvedValueOnce({
      userSalt: "00".repeat(16),
      encryptedUserMasterKey: "ciphertext",
      umkVersion: 99,
    });
    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({ status: "reauth_required" });

    storageMocks.getWallet.mockResolvedValueOnce({
      userSalt: "not-hex",
      encryptedUserMasterKey: "ciphertext",
      umkVersion: 3,
    });
    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({ status: "reauth_required" });

    storageMocks.getWallet.mockResolvedValueOnce({
      userSalt: "00".repeat(16),
      encryptedUserMasterKey: RAW_SENTINEL,
      umkVersion: 3,
    });
    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({ status: "reauth_required" });

    const unexpectedShape = Object.defineProperty({}, "userSalt", {
      get() {
        throw new Error(RAW_SENTINEL);
      },
    });
    storageMocks.getWallet.mockResolvedValueOnce(unexpectedShape);
    await expect(restoreWalletSecurityFromStorageOutcome(WALLET)).resolves.toEqual({ status: "reauth_required" });

    storageMocks.getWallet.mockResolvedValueOnce(null);
    await expect(restoreWalletSecurityFromStorage(WALLET)).resolves.toBeNull();

    const logged = joinedConsoleCalls(errorSpy);
    expect(logged).toContain("reauth_required");
    expect(logged).not.toContain(RAW_SENTINEL);
    expect(logged).not.toContain(WALLET);
  });

  it("returns a typed restored result while preserving the wrapper's successful sessionId shape", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const userSalt = Buffer.from("33".repeat(16), "hex");
    const umk = Buffer.from("44".repeat(32), "hex");
    const storageKey = nodeCrypto.createHash("sha256").update(Buffer.concat([
      Buffer.from("UMK_V3", "utf8"),
      Buffer.from(WALLET, "utf8"),
      userSalt,
      Buffer.from(STORAGE_SECRET, "hex"),
    ])).digest();
    const encryptedUserMasterKey = encryptToBase64(umk, storageKey, buildAAD(WALLET, "UMK"));
    zeroizeBuffer(storageKey);
    zeroizeBuffer(umk);

    storageMocks.getWallet.mockResolvedValue({
      userSalt: userSalt.toString("hex"),
      encryptedUserMasterKey,
      umkVersion: 3,
      executionEnabled: false,
      agentPrivateKeyEncrypted: null,
      agentPrivateKeyEncryptedV3: null,
    });

    const session = await import("../../server/session-v3");
    const outcome = await session.restoreWalletSecurityFromStorageOutcome(WALLET);
    expect(outcome.status).toBe("restored");
    if (outcome.status !== "restored") throw new Error("expected restored outcome");
    expect(session.getSession(outcome.sessionId)?.walletAddress).toBe(WALLET);
    session.invalidateAllSessionsForWallet(WALLET);

    const compatibility = await session.restoreWalletSecurityFromStorage(WALLET);
    expect(compatibility).toEqual({ sessionId: expect.any(String) });
    expect(session.getSession(compatibility!.sessionId)?.walletAddress).toBe(WALLET);
    session.invalidateAllSessionsForWallet(WALLET);
  });
});