import { describe, it, expect } from "vitest";
import {
  parseHermesParsed,
  computeDirectOracleContext,
  readBorrowOracleContext,
  type OraclePoint,
} from "../../server/vault/borrow-oracle-freshness";
import { getBorrowOracleSource } from "../../server/vault/borrow-oracle-registry";
import type { BorrowVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INF_MINT = "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm";
const INF_FEED = "f51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f";

function vault(over: Partial<BorrowVaultConfig> = {}): BorrowVaultConfig {
  return {
    vaultId: 43,
    vaultAddress: "vault43",
    oracleAddress: "oracle43",
    collateralMint: INF_MINT,
    collateralSymbol: "INF",
    collateralDecimals: 9,
    debtMint: USDC,
    debtSymbol: "USDC",
    debtDecimals: 6,
    maxLtv: 0.75,
    liquidationThreshold: 0.8,
    liquidationPenalty: 0.05,
    borrowApr: 0.0466,
    supplyApr: 0.03,
    borrowFee: 0,
    utilization: 0.5,
    oraclePriceLiquidateUsd: 99.2,
    oraclePriceOperateUsd: 99.2,
    marketPriceUsd: 99.2,
    borrowableUsdcRaw: "1000000000000",
    withdrawableCollateralRaw: "1000000000",
    minimumBorrowingRaw: "1000000",
    ...over,
  };
}

/** Build a Hermes-shaped parsed payload for one feed. */
function hermesBody(feedId: string, priceUsd: number, publishTimeSec: number, expo = -8) {
  const rawPrice = Math.round(priceUsd / Math.pow(10, expo));
  return {
    binary: { encoding: "hex", data: ["deadbeef"] },
    parsed: [
      {
        id: feedId,
        price: { price: String(rawPrice), conf: "1", expo, publish_time: publishTimeSec },
        ema_price: { price: String(rawPrice), conf: "1", expo, publish_time: publishTimeSec },
      },
    ],
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** A fetch double that routes by URL (latest vs the numeric benchmark endpoint). */
function makeFetch(
  latestBody: unknown,
  benchBody: unknown,
  opts: { latestStatus?: number; benchStatus?: number } = {},
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/price/latest")) {
      if (opts.latestStatus && opts.latestStatus >= 300) {
        return { ok: false, status: opts.latestStatus, json: async () => ({}) } as unknown as Response;
      }
      return okResponse(latestBody);
    }
    if (opts.benchStatus && opts.benchStatus >= 300) {
      return { ok: false, status: opts.benchStatus, json: async () => ({}) } as unknown as Response;
    }
    return okResponse(benchBody);
  }) as unknown as typeof fetch;
}

const NOW_MS = 1_782_293_543_000; // matches the verified INF reading window
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("parseHermesParsed", () => {
  it("parses a valid single-feed payload", () => {
    const m = parseHermesParsed(hermesBody(INF_FEED, 99.2672, NOW_SEC - 2), [INF_FEED]);
    expect(m).not.toBeNull();
    const p = m!.get(INF_FEED)!;
    expect(p.priceUsd).toBeCloseTo(99.2672, 4);
    expect(p.publishTimeSec).toBe(NOW_SEC - 2);
  });

  it("matches feed ids case-insensitively and ignores a 0x prefix", () => {
    const body = hermesBody("0x" + INF_FEED.toUpperCase(), 99.2, NOW_SEC - 1);
    const m = parseHermesParsed(body, [INF_FEED]);
    expect(m).not.toBeNull();
    expect(m!.get(INF_FEED)!.priceUsd).toBeCloseTo(99.2, 4);
  });

  it("fails closed when a wanted feed id is absent", () => {
    expect(parseHermesParsed(hermesBody("aa".repeat(32), 99, NOW_SEC), [INF_FEED])).toBeNull();
  });

  it("fails closed on malformed price object", () => {
    const body: any = hermesBody(INF_FEED, 99, NOW_SEC);
    body.parsed[0].price = null;
    expect(parseHermesParsed(body, [INF_FEED])).toBeNull();
  });

  it("fails closed on non-finite / non-positive price", () => {
    const bad: any = hermesBody(INF_FEED, 99, NOW_SEC);
    bad.parsed[0].price.price = "not-a-number";
    expect(parseHermesParsed(bad, [INF_FEED])).toBeNull();

    const zero: any = hermesBody(INF_FEED, 99, NOW_SEC);
    zero.parsed[0].price.price = "0";
    expect(parseHermesParsed(zero, [INF_FEED])).toBeNull();
  });

  it("fails closed on a bad exponent or non-positive publish_time", () => {
    const expoBad: any = hermesBody(INF_FEED, 99, NOW_SEC);
    expoBad.parsed[0].price.expo = 3;
    expect(parseHermesParsed(expoBad, [INF_FEED])).toBeNull();

    const pubBad: any = hermesBody(INF_FEED, 99, 0);
    expect(parseHermesParsed(pubBad, [INF_FEED])).toBeNull();
  });

  it("fails closed on a non-array / missing parsed payload", () => {
    expect(parseHermesParsed({ parsed: "nope" }, [INF_FEED])).toBeNull();
    expect(parseHermesParsed(null, [INF_FEED])).toBeNull();
  });
});

describe("computeDirectOracleContext", () => {
  const targetSec = NOW_SEC - 3600;

  it("computes a fresh age and a small 1h move", () => {
    const latest: OraclePoint = { priceUsd: 99.2672, publishTimeSec: NOW_SEC - 2 };
    const hourAgo: OraclePoint = { priceUsd: 99.3204, publishTimeSec: targetSec };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.publishAgeSec).toBe(2);
    expect(ctx.priceMove1hAbs).toBeCloseTo(Math.abs(99.2672 / 99.3204 - 1), 8);
  });

  it("still reports a stale age number (the gate, not the reader, denies)", () => {
    const latest: OraclePoint = { priceUsd: 99, publishTimeSec: NOW_SEC - 500 };
    const hourAgo: OraclePoint = { priceUsd: 99, publishTimeSec: targetSec };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.publishAgeSec).toBe(500);
  });

  it("clamps a small clock-skew negative age to 0", () => {
    const latest: OraclePoint = { priceUsd: 99, publishTimeSec: NOW_SEC + 5 };
    const hourAgo: OraclePoint = { priceUsd: 99, publishTimeSec: targetSec };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.publishAgeSec).toBe(0);
  });

  it("nulls the age when publish time is in the future beyond clock skew", () => {
    const latest: OraclePoint = { priceUsd: 99, publishTimeSec: NOW_SEC + 120 };
    const hourAgo: OraclePoint = { priceUsd: 99, publishTimeSec: targetSec };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.publishAgeSec).toBeNull();
  });

  it("nulls the 1h move when the benchmark drifts too far from t-1h", () => {
    const latest: OraclePoint = { priceUsd: 99, publishTimeSec: NOW_SEC - 2 };
    const hourAgo: OraclePoint = { priceUsd: 99, publishTimeSec: targetSec - 5000 };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.priceMove1hAbs).toBeNull();
    expect(ctx.publishAgeSec).toBe(2);
  });

  it("reports a large 1h move (gate freezes; reader stays honest)", () => {
    const latest: OraclePoint = { priceUsd: 80, publishTimeSec: NOW_SEC - 2 };
    const hourAgo: OraclePoint = { priceUsd: 100, publishTimeSec: targetSec };
    const ctx = computeDirectOracleContext(latest, hourAgo, { nowSec: NOW_SEC, targetSec });
    expect(ctx.priceMove1hAbs).toBeCloseTo(0.2, 8);
  });
});

describe("readBorrowOracleContext (registry + Hermes I/O)", () => {
  const targetSec = NOW_SEC - 3600;
  const freshLatest = hermesBody(INF_FEED, 99.2672, NOW_SEC - 2);
  const benchOk = hermesBody(INF_FEED, 99.3204, targetSec);

  it("returns both facts on the happy path", async () => {
    const ctx = await readBorrowOracleContext(vault(), {
      fetchImpl: makeFetch(freshLatest, benchOk),
      now: () => NOW_MS,
    });
    expect(ctx.publishAgeSec).toBe(2);
    expect(ctx.priceMove1hAbs).toBeCloseTo(Math.abs(99.2672 / 99.3204 - 1), 8);
  });

  it("fails closed when the vault is not in the registry", async () => {
    const ctx = await readBorrowOracleContext(vault({ vaultId: 999 }), {
      fetchImpl: makeFetch(freshLatest, benchOk),
      now: () => NOW_MS,
    });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });

  it("fails closed when the collateral mint does not match the registry", async () => {
    const ctx = await readBorrowOracleContext(vault({ collateralMint: "WRONGmint1111111111111111111111111111111111" }), {
      fetchImpl: makeFetch(freshLatest, benchOk),
      now: () => NOW_MS,
    });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });

  it("fails closed on a non-2xx Hermes response", async () => {
    const ctx = await readBorrowOracleContext(vault(), {
      fetchImpl: makeFetch(freshLatest, benchOk, { latestStatus: 503 }),
      now: () => NOW_MS,
    });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });

  it("fails closed when the Hermes price diverges materially from the vault price", async () => {
    // Hermes says $200 but the vault's on-chain liquidation price is ~$99 -> wrong map.
    const ctx = await readBorrowOracleContext(vault(), {
      fetchImpl: makeFetch(hermesBody(INF_FEED, 200, NOW_SEC - 2), hermesBody(INF_FEED, 200, targetSec)),
      now: () => NOW_MS,
    });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });

  it("fails closed when the vault has no readable liquidation price", async () => {
    const ctx = await readBorrowOracleContext(vault({ oraclePriceLiquidateUsd: 0 }), {
      fetchImpl: makeFetch(freshLatest, benchOk),
      now: () => NOW_MS,
    });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });

  it("fails closed on a thrown fetch (network error)", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const ctx = await readBorrowOracleContext(vault(), { fetchImpl: throwing, now: () => NOW_MS });
    expect(ctx).toEqual({ publishAgeSec: null, priceMove1hAbs: null });
  });
});

describe("borrow oracle registry", () => {
  it("resolves the verified INF entry by vault id + mint", () => {
    const src = getBorrowOracleSource(43, INF_MINT);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe("pyth_direct");
    expect(src!.feedId).toBe(INF_FEED);
  });

  it("returns null for an unmapped vault or a mismatched mint", () => {
    expect(getBorrowOracleSource(1, INF_MINT)).toBeNull();
    expect(getBorrowOracleSource(43, USDC)).toBeNull();
  });
});
