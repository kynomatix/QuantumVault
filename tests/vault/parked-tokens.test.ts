import { describe, it, expect, vi } from "vitest";
import { detectParkedYieldTokens } from "../../server/vault/parked-tokens";
import { getDetectableYieldAssets, getAllYieldAssets } from "../../server/vault/yield-assets";

/**
 * Money-safety unit tests for the Flash teardown guard. detectParkedYieldTokens
 * is what stops a recover/delete sweep from stranding parked Vault funds: the
 * Flash sweep only moves USDC + reclaimable SOL, so a parked yield token must be
 * detected first. Two invariants:
 *   1. FAIL CLOSED: an unreadable balance must propagate (reject) so the caller
 *      treats it as "cannot confirm empty" and never sweeps.
 *   2. Only VERIFIED-mint rows are probed: blank-mint placeholder rows must be
 *      skipped, else `new PublicKey("")` would throw and block every teardown.
 */

const WALLET = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";

describe("detectParkedYieldTokens (Flash teardown guard, fail closed)", () => {
  it("reports the display name of every verified-mint asset with a non-zero balance", async () => {
    const assets = getDetectableYieldAssets();
    expect(assets.length).toBeGreaterThan(0);
    const reader = vi.fn().mockResolvedValue({ amountRaw: "1000" });
    const parked = await detectParkedYieldTokens(WALLET, reader);
    expect(parked).toEqual(assets.map((a) => a.displayName));
    // Every verified-mint asset (enabled OR disabled) must be probed.
    expect(reader).toHaveBeenCalledTimes(assets.length);
  });

  it("never probes a blank-mint placeholder row (no new PublicKey('') throw)", async () => {
    // Sanity: the registry really does carry at least one disabled blank-mint row
    // and at least one disabled-but-verified row (e.g. Kamino), so this test is
    // meaningful rather than vacuous.
    const all = getAllYieldAssets();
    const detectable = getDetectableYieldAssets();
    expect(all.length).toBeGreaterThan(detectable.length); // a blank-mint row exists
    expect(detectable.every((a) => a.mint.length > 0)).toBe(true);
    expect(detectable.some((a) => !a.enabled)).toBe(true); // disabled-but-verified kept

    const reader = vi.fn().mockResolvedValue({ amountRaw: "0" });
    await detectParkedYieldTokens(WALLET, reader);
    // No call may carry an empty mint.
    for (const call of reader.mock.calls) {
      expect(call[1]).not.toBe("");
      expect((call[1] as string).length).toBeGreaterThan(0);
    }
  });

  it("reports nothing when every balance is a genuine zero", async () => {
    const reader = vi.fn().mockResolvedValue({ amountRaw: "0" });
    const parked = await detectParkedYieldTokens(WALLET, reader);
    expect(parked).toEqual([]);
  });

  it("reports only the assets that are actually parked", async () => {
    const assets = getDetectableYieldAssets();
    const reader = vi
      .fn()
      .mockImplementation(async (_w: string, mint: string) =>
        mint === assets[0].mint ? { amountRaw: "5" } : { amountRaw: "0" },
      );
    const parked = await detectParkedYieldTokens(WALLET, reader);
    expect(parked).toEqual([assets[0].displayName]);
  });

  it("FAILS CLOSED: rejects when the balance reader throws (unreadable balance)", async () => {
    const reader = vi.fn().mockRejectedValue(new Error("rpc parse error"));
    await expect(detectParkedYieldTokens(WALLET, reader)).rejects.toThrow();
  });

  it("FAILS CLOSED: a throw on a LATER asset still aborts (no partial 'all clear')", async () => {
    const assets = getDetectableYieldAssets();
    // First asset reads clean, a later one is unreadable -> must still reject,
    // never return a partial list that a caller could read as "empty enough".
    const reader = vi
      .fn()
      .mockImplementation(async (_w: string, mint: string) => {
        if (mint === assets[0].mint) return { amountRaw: "0" };
        throw new Error("rpc down");
      });
    await expect(detectParkedYieldTokens(WALLET, reader)).rejects.toThrow();
  });
});
