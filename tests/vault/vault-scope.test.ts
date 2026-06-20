import { describe, it, expect } from "vitest";
import { vaultLockKey } from "../../server/vault/scope";

const WALLET = "WaLLet1111111111111111111111111111111111111";
const BOT_A = "bot-aaaa-1111";
const BOT_B = "bot-bbbb-2222";
const ASSET = "kamino-usdc";

describe("vaultLockKey coexistence (account vs per-bot rows never share a lock slot)", () => {
  it("is a 32-bit signed integer", () => {
    const k = vaultLockKey(WALLET, null, ASSET);
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(k).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it("is stable for identical inputs", () => {
    expect(vaultLockKey(WALLET, BOT_A, ASSET)).toBe(vaultLockKey(WALLET, BOT_A, ASSET));
    expect(vaultLockKey(WALLET, null, ASSET)).toBe(vaultLockKey(WALLET, null, ASSET));
  });

  it("treats null and undefined the same (both are account scope)", () => {
    expect(vaultLockKey(WALLET, null, ASSET)).toBe(vaultLockKey(WALLET, undefined, ASSET));
  });

  it("separates account scope from per-bot scope for the same wallet+asset", () => {
    expect(vaultLockKey(WALLET, null, ASSET)).not.toBe(vaultLockKey(WALLET, BOT_A, ASSET));
  });

  it("separates two different bots for the same wallet+asset", () => {
    expect(vaultLockKey(WALLET, BOT_A, ASSET)).not.toBe(vaultLockKey(WALLET, BOT_B, ASSET));
  });

  it("separates different assets within the same scope", () => {
    expect(vaultLockKey(WALLET, BOT_A, "kamino-usdc")).not.toBe(
      vaultLockKey(WALLET, BOT_A, "perena-usd-star"),
    );
  });

  it("separates different wallets within the same scope+asset", () => {
    const other = "OtherWaLLet22222222222222222222222222222222";
    expect(vaultLockKey(WALLET, null, ASSET)).not.toBe(vaultLockKey(other, null, ASSET));
  });

  it("does not confuse a bot id with an account scope whose asset embeds the id", () => {
    // JSON-array hashing keeps element boundaries unambiguous, so a bot-scoped
    // key can never collide with an account-scoped key that happens to share
    // concatenated characters.
    expect(vaultLockKey(WALLET, BOT_A, ASSET)).not.toBe(
      vaultLockKey(WALLET, null, `${BOT_A}${ASSET}`),
    );
  });
});
