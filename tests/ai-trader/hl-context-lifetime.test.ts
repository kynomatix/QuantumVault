import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bounded hl flight", () => {
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
  const hlBody = (openInterest = 100) => [
    { universe: [{ name: "SOL" }] },
    [
      {
        funding: "0.00001",
        openInterest: String(openInterest),
        dayNtlVlm: "1000",
        premium: "0",
        oraclePx: "100",
        markPx: "100",
      },
    ],
  ];
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

  describe("hl", () => {
    async function api() {
      const module = await import("../../server/ai-trader/hl-context");
      return {
        read: () => module.fetchHlSnapshot("SOL-PERP"),
        success: () => response(hlBody()),
        budget: 2_000,
        ttl: 5_000,
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
          expect(settled).toEqual([null, null]);
          await Promise.all([first, joined]);
          fetchMock.mockResolvedValue(source.success());
          expect(await source.read()).not.toBeNull();
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          pending.resolve(boundary === "fetch" ? source.success() : hlBody());
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

        expect(await source.read()).toBeNull();
        fetchMock.mockResolvedValue(source.success());
        expect(await source.read()).not.toBeNull();
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
      const abandoned = source.read();

      await vi.advanceTimersByTimeAsync(source.budget);
      const oldJson = vi.fn(async () => hlBody(200));
      let completed = 0;
      const successor = source.read().then((value) => {
        completed++;
        return value;
      });
      firstResponse.resolve({ ok: true, json: oldJson });
      await vi.advanceTimersByTimeAsync(0);
      expect(oldJson).not.toHaveBeenCalled();
      expect(completed).toBe(0);

      const joined = source.read();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      secondResponse.resolve(source.success());
      await Promise.all([abandoned, successor, joined]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("late body cannot overwrite a successful successor cache", async () => {
      const source = await api();
      const body = deferred<unknown>();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => body.promise });
      const abandoned = source.read();

      await vi.advanceTimersByTimeAsync(source.budget);
      fetchMock.mockResolvedValue(source.success());
      const accepted = await source.read();
      body.resolve(hlBody(999));
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

describe("retained hl policy", () => {
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
  const hlBody = (openInterest = 100, funding = 0.00001) => [
    { universe: [{ name: "SOL" }] },
    [
      {
        funding: String(funding),
        openInterest: String(openInterest),
        dayNtlVlm: "1000",
        premium: "0",
        oraclePx: "100",
        markPx: "100",
      },
    ],
  ];

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

  describe("hl additional lifetime controls", () => {
    async function api() {
      const module = await import("../../server/ai-trader/hl-context");
      return {
        read: () => module.fetchHlSnapshot("SOL-PERP"),
        body: () => hlBody(),
        budget: 2_000,
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
        const abandoned = source.read();
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

  describe("HL retained participation semantics", () => {
    it("failed and abandoned reads never enter participation history", async () => {
      const module = await import("../../server/ai-trader/hl-context");
      fetchMock.mockResolvedValueOnce(response(hlBody(100, 0.00001)));
      expect(
        (await module.getHlParticipationSnapshot("SOL-PERP"))?.openInterestDeltaPct,
      ).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      const oldAttempt = deferred<unknown>();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => oldAttempt.promise });
      const failed = module.getHlParticipationSnapshot("SOL-PERP");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await failed).toBeNull();

      fetchMock.mockResolvedValueOnce(response(hlBody(110, 0.00002)));
      const next = await module.getHlParticipationSnapshot("SOL-PERP");
      expect(next?.openInterestDeltaPct).toBeCloseTo(10);
      expect(next?.fundingTrajectory).toEqual([0.00001, 0.00002]);

      oldAttempt.resolve(hlBody(999, 0.9));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      fetchMock.mockResolvedValueOnce(response(hlBody(121, 0.00003)));
      const final = await module.getHlParticipationSnapshot("SOL-PERP");
      expect(final?.openInterestDeltaPct).toBeCloseTo(10);
      expect(final?.openInterestDeltaPctWindow).toBeCloseTo(21);
      expect(final?.fundingTrajectory).toEqual([0.00001, 0.00002, 0.00003]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
