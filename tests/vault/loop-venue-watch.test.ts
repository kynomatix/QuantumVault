/**
 * WO UI-1 — venue-watch (display-only cross-venue SOL borrow comparison).
 *
 * Locks in the post-Loopscale-removal contract:
 *   1. Kamino and Save still map correctly from their pinned lendBorrow rows.
 *   2. The retired Loopscale identity is NEVER emitted — even if the upstream
 *      payload includes its old pool UUID with full, valid-looking SOL data.
 *   3. Pinned-UUID identity mismatch stays fail-soft: that venue reads
 *      all-null, other venues are unaffected, nothing throws.
 *   4. Upstream failure stays fail-soft: empty array when no cache exists,
 *      stale cached rows once a good sample exists, never throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const NOT_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KAMINO_POOL = "525b2dab-ea6a-4cbc-a07f-84ce561d1f83";
const SAVE_POOL = "1170b465-309b-4026-b10d-abdf7b1ac369";
/** The pool UUID Loopscale was pinned to before its removal (2026-07-26). */
const RETIRED_LOOPSCALE_POOL = "6b824912-fb93-469c-ab3c-8cdcf7bb13a8";

type LlamaRow = Record<string, unknown>;

function llamaRow(pool: string, over: LlamaRow = {}): LlamaRow {
  return {
    pool,
    underlyingTokens: [SOL_MINT],
    apyBaseBorrow: 5.2,
    totalSupplyUsd: 1_000_000,
    totalBorrowUsd: 250_000,
    ltv: 0.75,
    ...over,
  };
}

function okFetch(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function failFetch(message: string) {
  return vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** Fresh module per test — the 10-minute cache is module-level state. */
async function freshWatch() {
  vi.resetModules();
  return await import("../../server/vault/loop/venue-watch");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("venue-watch: display-only cross-venue SOL borrow readings", () => {
  it("returns Kamino and Save with correct numeric mapping, in registry order", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch([
        llamaRow(KAMINO_POOL, { apyBaseBorrow: 5.2, totalSupplyUsd: 2_000_000, totalBorrowUsd: 1_920_000, ltv: 0.74 }),
        llamaRow(SAVE_POOL, { apyBaseBorrow: 7.5, totalSupplyUsd: 800_000, totalBorrowUsd: 200_000, ltv: 0.65 }),
      ]),
    );
    const { getVenueSolBorrowRates } = await freshWatch();
    const rows = await getVenueSolBorrowRates();

    expect(rows.map((r) => r.venue)).toEqual(["Kamino", "Save"]);
    const [kamino, save] = rows;
    expect(kamino.borrowApy).toBeCloseTo(0.052, 10); // percent -> fraction
    expect(kamino.supplyUsd).toBe(2_000_000);
    expect(kamino.utilization).toBeCloseTo(0.96, 10); // borrowed / supplied
    expect(kamino.maxLtv).toBe(0.74);
    expect(typeof kamino.asOf).toBe("string");
    expect(save.borrowApy).toBeCloseTo(0.075, 10);
    expect(save.supplyUsd).toBe(800_000);
    expect(save.utilization).toBeCloseTo(0.25, 10);
    expect(save.maxLtv).toBe(0.65);
  });

  it("never emits the retired Loopscale identity, even when upstream includes its old pool with full data", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch([
        llamaRow(KAMINO_POOL),
        // Adversarial: upstream suddenly carries the retired pool WITH
        // valid-looking SOL borrow data. It must still never surface.
        llamaRow(RETIRED_LOOPSCALE_POOL, { apyBaseBorrow: 9.9 }),
        llamaRow(SAVE_POOL),
      ]),
    );
    const { getVenueSolBorrowRates } = await freshWatch();
    const rows = await getVenueSolBorrowRates();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.venue)).toEqual(["Kamino", "Save"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/loopscale/i);
    expect(serialized).not.toContain(RETIRED_LOOPSCALE_POOL);
    // The surviving venues still read numerically despite the extra row.
    expect(rows[0].borrowApy).not.toBeNull();
    expect(rows[1].borrowApy).not.toBeNull();
  });

  it("identity mismatch on one pinned pool fails soft: that venue reads all-null, others unaffected", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch([
        // Kamino's UUID now points at a non-SOL market -> refuse the reading.
        llamaRow(KAMINO_POOL, { underlyingTokens: [NOT_SOL_MINT] }),
        llamaRow(SAVE_POOL),
      ]),
    );
    const { getVenueSolBorrowRates } = await freshWatch();
    const rows = await getVenueSolBorrowRates();

    expect(rows.map((r) => r.venue)).toEqual(["Kamino", "Save"]);
    const kamino = rows[0];
    expect(kamino.borrowApy).toBeNull();
    expect(kamino.supplyUsd).toBeNull();
    expect(kamino.utilization).toBeNull();
    expect(kamino.maxLtv).toBeNull();
    expect(rows[1].borrowApy).toBeCloseTo(0.052, 10);
  });

  it("a pinned pool absent from the upstream payload reads all-null via the same refusal branch", async () => {
    vi.stubGlobal("fetch", okFetch([llamaRow(SAVE_POOL)]));
    const { getVenueSolBorrowRates } = await freshWatch();
    const rows = await getVenueSolBorrowRates();

    expect(rows.map((r) => r.venue)).toEqual(["Kamino", "Save"]);
    expect(rows[0].borrowApy).toBeNull();
    expect(rows[0].supplyUsd).toBeNull();
    expect(rows[1].borrowApy).not.toBeNull();
  });

  it("upstream failure with no cache fails soft to an empty array (never throws)", async () => {
    vi.stubGlobal("fetch", failFetch("network down"));
    const { getVenueSolBorrowRates } = await freshWatch();
    await expect(getVenueSolBorrowRates()).resolves.toEqual([]);
  });

  it("non-array upstream payload fails soft to an empty array (never throws)", async () => {
    vi.stubGlobal("fetch", okFetch({ unexpected: "shape" }));
    const { getVenueSolBorrowRates } = await freshWatch();
    await expect(getVenueSolBorrowRates()).resolves.toEqual([]);
  });

  it("upstream failure after a good sample serves the stale cached rows (fail-soft)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
    vi.stubGlobal("fetch", okFetch([llamaRow(KAMINO_POOL), llamaRow(SAVE_POOL)]));
    const { getVenueSolBorrowRates } = await freshWatch();
    const first = await getVenueSolBorrowRates();
    expect(first).toHaveLength(2);

    // Step past the 10-minute TTL with the upstream now failing: the stale
    // cache must be served instead of throwing or going empty.
    vi.setSystemTime(new Date("2026-07-26T00:11:00Z"));
    const failing = vi.fn(async () => {
      throw new Error("upstream 500");
    });
    vi.stubGlobal("fetch", failing as unknown as typeof fetch);
    const second = await getVenueSolBorrowRates();
    expect(second).toBe(first);
    // The TTL really expired: the upstream WAS re-attempted before falling
    // back to stale (guards against a cache-age regression that would serve
    // the cache forever without ever refreshing).
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
