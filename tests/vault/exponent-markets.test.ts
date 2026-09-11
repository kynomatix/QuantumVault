import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bounded exponent flight", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  const fetchMock = vi.fn();
  const market = (price = 0.9) => ({
    marketStatus: "active",
    quoteAsset: { mint: "USD1111111111111111111111111111111111111111" },
    underlyingAsset: { mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5" },
    vaultAddress: "fixture-vault",
    ptMint: "fixture-pt",
    impliedApy: 0.1,
    maturityDateUnixTs: Date.now() / 1_000 + 30 * 86_400,
    legacyMarketAddresses: ["fixture-market"],
    decimals: 6,
    legacyLiquidity: 300_000 * 1e6,
    ptPriceInAsset: price,
  });
  const response = (body: unknown) => ({ ok: true, json: async () => body });
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("exponent", () => {
    async function api() {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      return {
        read: () => module.getEligibleFixedYieldMarkets(),
        success: () => response([market()]),
        budget: 10_000,
        ttl: 600_000,
      };
    }

    for (const boundary of ["fetch", "body"] as const) {
      it(`settles all waiters for abort-insensitive ${boundary} and admits a later read`, async () => {
        const source = await api();
        const pending = deferred<unknown>();
        const json = vi.fn(() => pending.promise);
        fetchMock.mockImplementation(() =>
          boundary === "fetch" ? pending.promise : { ok: true, json },
        );
        const settled: unknown[] = [];
        const receive = (value: unknown) => {
          settled.push(value);
        };
        const first = source.read().then(receive, receive);
        const joined = source.read().then(receive, receive);

        await vi.advanceTimersByTimeAsync(source.budget);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // This assertion fails promptly on the unmodified module; do not await a
        // deliberately unbounded baseline before observing settlement.
        try {
          expect(settled).toHaveLength(2);
          await Promise.all([first, joined]);
          expect(settled.every((value) => value instanceof Error)).toBe(true);
          fetchMock.mockResolvedValue(source.success());
          expect(await source.read()).not.toBeNull();
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          pending.resolve(boundary === "fetch" ? source.success() : [market()]);
          await Promise.resolve();
        }
      });
    }

    for (const cause of ["fetch", "body"] as const) {
      it(`synchronous ${cause} throw does not retain a settled failure`, async () => {
        const source = await api();
        fetchMock.mockImplementation(() => {
          if (cause === "fetch") throw new Error("synthetic synchronous failure");
          return {
            ok: true,
            json: () => {
              throw new Error("synthetic synchronous body failure");
            },
          };
        });

        expect(await source.read().catch((error) => error)).toBeInstanceOf(Error);
        fetchMock.mockResolvedValue(source.success());
        const next = await source.read();
        expect(next).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      });
    }

    it("late A headers cannot start JSON, clear pending B or force a third fetch", async () => {
      const source = await api();
      const firstResponse = deferred<unknown>();
      const secondResponse = deferred<unknown>();
      fetchMock
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(secondResponse.promise);
      const abandoned = source.read().catch((error) => error);

      await vi.advanceTimersByTimeAsync(source.budget);
      const oldJson = vi.fn(async () => [market(0.5)]);
      let completed = 0;
      const successor = source.read().then(
        (value) => {
          completed++;
          return value;
        },
        (error) => {
          completed++;
          return error;
        },
      );
      firstResponse.resolve({ ok: true, json: oldJson });
      await vi.advanceTimersByTimeAsync(0);
      expect(oldJson).not.toHaveBeenCalled();
      expect(completed).toBe(0);

      const joined = source.read().catch((error) => error);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      secondResponse.resolve(source.success());
      await Promise.all([abandoned, successor, joined]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("late body cannot overwrite a successful successor cache", async () => {
      const source = await api();
      const body = deferred<unknown>();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => body.promise });
      const abandoned = source.read().catch((error) => error);

      await vi.advanceTimersByTimeAsync(source.budget);
      fetchMock.mockResolvedValue(source.success());
      const accepted = await source.read();
      body.resolve([market(0.1)]);
      await vi.advanceTimersByTimeAsync(0);
      await abandoned;
      expect(await source.read()).toEqual(accepted);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("successful response cache expires at the existing TTL", async () => {
      const source = await api();
      fetchMock.mockResolvedValue(source.success());
      await source.read();
      await vi.advanceTimersByTimeAsync(source.ttl - 1);
      await source.read();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await source.read();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("retained exponent policy", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  const fetchMock = vi.fn();
  const response = (body: unknown) => ({ ok: true, json: async () => body });
  const market = (extra: Record<string, unknown> = {}) => ({
    marketStatus: "active",
    quoteAsset: { mint: "USD1111111111111111111111111111111111111111" },
    underlyingAsset: { mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5" },
    vaultAddress: "fixture-vault",
    ptMint: "fixture-pt",
    impliedApy: 0.1,
    maturityDateUnixTs: Date.now() / 1_000 + 30 * 86_400,
    legacyMarketAddresses: ["fixture-market"],
    decimals: 6,
    legacyLiquidity: 300_000 * 1e6,
    ptPriceInAsset: 0.9,
    ...extra,
  });

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("exponent additional lifetime controls", () => {
    async function api() {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      return {
        read: () => module.getEligibleFixedYieldMarkets(),
        body: () => [market()],
        budget: 10_000,
      };
    }

    for (const boundary of ["fetch", "body"] as const) {
      it(`late ${boundary} rejection leaves the pending successor owned`, async () => {
        const source = await api();
        const oldAttempt = deferred<unknown>();
        const currentAttempt = deferred<unknown>();
        fetchMock
          .mockReturnValueOnce(
            boundary === "fetch"
              ? oldAttempt.promise
              : { ok: true, json: () => oldAttempt.promise },
          )
          .mockReturnValueOnce(currentAttempt.promise);
        const abandoned = source.read().catch((error) => error);
        await vi.advanceTimersByTimeAsync(source.budget);
        await abandoned;

        let settled = false;
        const successor = source.read().then((value) => {
          settled = true;
          return value;
        });
        oldAttempt.reject(new Error("observed late failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        const joined = source.read();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        currentAttempt.resolve(response(source.body()));
        expect(await successor).toEqual(await joined);
        expect(vi.getTimerCount()).toBe(0);
      });
    }

    it("fetch plus body share one budget and a late join does not extend it", async () => {
      const source = await api();
      const headers = deferred<unknown>();
      const body = deferred<unknown>();
      fetchMock.mockReturnValue(headers.promise);
      const outcomes: unknown[] = [];
      const receive = (value: unknown) => {
        outcomes.push(value);
      };
      const first = source.read().then(receive, receive);

      await vi.advanceTimersByTimeAsync(source.budget - 1);
      headers.resolve({ ok: true, json: () => body.promise });
      await vi.advanceTimersByTimeAsync(0);
      const joined = source.read().then(receive, receive);
      expect(outcomes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toHaveLength(2);
      await Promise.all([first, joined]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      body.resolve(source.body());
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("Exponent retained selection and exit-quote semantics", () => {
    it("preserves highest-APY selection and unfiltered quotes for excluded markets", async () => {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      fetchMock.mockResolvedValue(
        response([
          market(),
          market({ impliedApy: 0.2, legacyMarketAddresses: ["best"] }),
          market({
            marketStatus: "matured",
            legacyMarketAddresses: ["exit-a", "exit-b"],
            ptPriceInAsset: 0.95,
          }),
        ]),
      );
      expect((await module.pickBestFixedYieldMarket())?.marketAddress).toBe("best");
      expect(
        (await module.getEligibleFixedYieldMarkets()).map((item) => item.marketAddress),
      ).toEqual(["fixture-market", "best"]);
      for (const name of ["exit-a", "exit-b"]) {
        expect(await module.getFixedYieldMarketQuote(name)).toMatchObject({
          marketAddress: name,
          ptMint: "fixture-pt",
          ptPriceInAsset: 0.95,
          marketStatus: "matured",
        });
      }
      expect(await module.getFixedYieldMarketQuote("absent")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["unapproved mint", { underlyingAsset: { mint: "synthetic-unapproved" } }],
      ["unapproved quote", { quoteAsset: { mint: "synthetic-quote" } }],
      ["inactive", { marketStatus: "inactive" }],
      ["zero APY", { impliedApy: 0 }],
      ["excessive APY", { impliedApy: 0.50001 }],
      ["low liquidity", { legacyLiquidity: 249_999 * 1e6 }],
      [
        "short maturity",
        { maturityDateUnixTs: Date.parse("2026-09-15T00:00:00Z") / 1_000 },
      ],
      [
        "long maturity",
        { maturityDateUnixTs: Date.parse("2027-05-08T00:00:00Z") / 1_000 },
      ],
      ["missing address", { legacyMarketAddresses: [] }],
      ["nonfinite APY", { impliedApy: Number.NaN }],
    ] as const)("retains eligibility rejection: %s", async (_name, overrides) => {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      fetchMock.mockResolvedValue(response([market(overrides)]));
      expect(await module.getEligibleFixedYieldMarkets()).toEqual([]);
      expect(await module.pickBestFixedYieldMarket()).toBeNull();
    });

    it("keeps nullable nonfinite quote fields and never fabricates a price", async () => {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      fetchMock.mockResolvedValue(
        response([
          market({
            ptPriceInAsset: Number.NaN,
            maturityDateUnixTs: Number.POSITIVE_INFINITY,
            ptMint: null,
          }),
        ]),
      );
      expect(await module.getFixedYieldMarketQuote("fixture-market")).toMatchObject({
        ptPriceInAsset: null,
        maturityTs: null,
        ptMint: null,
      });
    });

    for (const failure of ["hung", "HTTP", "shape"] as const) {
      it(`preserves expired market and quote cache on ${failure} failure without refreshing its age`, async () => {
        const module = await import("../../server/vault/fixed-yield/exponent-markets");
        fetchMock.mockResolvedValueOnce(response([market({ ptPriceInAsset: 0.81 })]));
        const prior = await module.getEligibleFixedYieldMarkets();
        await vi.advanceTimersByTimeAsync(600_000);
        const oldAttempt = deferred<unknown>();
        fetchMock.mockImplementation(() =>
          failure === "hung"
            ? oldAttempt.promise
            : failure === "HTTP"
              ? { ok: false, status: 503 }
              : response({ unexpected: true }),
        );
        const read = module.getEligibleFixedYieldMarkets();
        if (failure === "hung") await vi.advanceTimersByTimeAsync(10_000);
        expect(await read).toEqual(prior);

        fetchMock.mockRejectedValue(new Error("another failure"));
        expect(await module.getFixedYieldMarketQuote("fixture-market")).toMatchObject({
          ptPriceInAsset: 0.81,
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(await module.getEligibleFixedYieldMarkets()).toEqual(prior);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        oldAttempt.resolve(response([market({ ptPriceInAsset: 0.1 })]));
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
      });
    }

    it("abandoned payload cannot publish its quote map after a successor succeeded", async () => {
      const module = await import("../../server/vault/fixed-yield/exponent-markets");
      const oldAttempt = deferred<unknown>();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => oldAttempt.promise });
      const failed = module.getEligibleFixedYieldMarkets().catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await failed).toBeInstanceOf(Error);

      fetchMock.mockResolvedValue(
        response([market({ ptPriceInAsset: 0.88, legacyMarketAddresses: ["new"] })]),
      );
      expect((await module.getEligibleFixedYieldMarkets())[0].marketAddress).toBe("new");
      oldAttempt.resolve([
        market({ ptPriceInAsset: 0.12, legacyMarketAddresses: ["old"] }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(await module.getFixedYieldMarketQuote("old")).toBeNull();
      expect(await module.getFixedYieldMarketQuote("new")).toMatchObject({
        ptPriceInAsset: 0.88,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
