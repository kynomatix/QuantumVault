import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseHermesSseData,
  FlashPythSseManager,
} from "../../server/live-data-spine/flash-pyth-sse";
import type { PriceTick } from "../../server/live-data-spine/types";

const SOL_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const BTC_ID = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const RX = 1_700_000_000_000;

function idMap() {
  return new Map<string, string>([
    [SOL_ID, "SOL-PERP"],
    [BTC_ID, "BTC-PERP"],
  ]);
}

describe("parseHermesSseData", () => {
  it("parses parsed[] entries with expo scaling and ms publish time", () => {
    const json = JSON.stringify({
      parsed: [
        { id: SOL_ID, price: { price: "15012345678", expo: -8, publish_time: 1_700_000_000 } },
      ],
    });
    const { ticks, parseErrors } = parseHermesSseData(json, idMap(), RX);
    expect(parseErrors).toBe(0);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      venue: "flash",
      internalSymbol: "SOL-PERP",
      oracle: null,
      funding: null,
      publishTime: 1_700_000_000_000,
      receivedAt: RX,
    });
    expect(ticks[0].mark).toBeCloseTo(150.12345678, 6);
  });

  it("matches feed ids case-insensitively", () => {
    const json = JSON.stringify({
      parsed: [{ id: SOL_ID.toUpperCase(), price: { price: "100", expo: 0, publish_time: 1 } }],
    });
    const { ticks } = parseHermesSseData(json, idMap(), RX);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].mark).toBe(100);
  });

  it("skips unknown feed ids without counting an error", () => {
    const json = JSON.stringify({
      parsed: [{ id: "deadbeef", price: { price: "100", expo: 0, publish_time: 1 } }],
    });
    const { ticks, parseErrors } = parseHermesSseData(json, idMap(), RX);
    expect(ticks).toHaveLength(0);
    expect(parseErrors).toBe(0);
  });

  it("counts non-finite / non-positive prices as parse errors", () => {
    const json = JSON.stringify({
      parsed: [
        { id: SOL_ID, price: { price: "abc", expo: -8, publish_time: 1 } },
        { id: BTC_ID, price: { price: "0", expo: -8, publish_time: 1 } },
      ],
    });
    const { ticks, parseErrors } = parseHermesSseData(json, idMap(), RX);
    expect(ticks).toHaveLength(0);
    expect(parseErrors).toBe(2);
  });

  it("returns a parse error on malformed JSON", () => {
    const { ticks, parseErrors } = parseHermesSseData("{not json", idMap(), RX);
    expect(ticks).toHaveLength(0);
    expect(parseErrors).toBe(1);
  });

  it("falls back publishTime to receivedAt when publish_time is missing", () => {
    const json = JSON.stringify({ parsed: [{ id: SOL_ID, price: { price: "100", expo: 0 } }] });
    const { ticks } = parseHermesSseData(json, idMap(), RX);
    expect(ticks[0].publishTime).toBe(RX);
  });
});

// Build a Response-like object whose body streams the given SSE chunks.
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

// A Response whose body opens but never sends data and never closes (stalls).
function pendingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {
      /* never enqueue, never close -> reader.read() pends until cancelled */
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

describe("FlashPythSseManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams ticks from an SSE body and reports health", async () => {
    const ticks: PriceTick[] = [];
    const health: boolean[] = [];
    const event =
      "data: " +
      JSON.stringify({
        parsed: [{ id: SOL_ID, price: { price: "15000000000", expo: -8, publish_time: 1 } }],
      }) +
      "\n\n";

    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([event]));
    const mgr = new FlashPythSseManager({
      feedMap: { "SOL-PERP": SOL_ID },
      onTick: (t) => ticks.push(t),
      onHealth: (h) => health.push(h),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    mgr.connect();
    // Allow the async stream loop to consume the body.
    await vi.waitFor(() => expect(ticks.length).toBe(1));
    mgr.disconnect();

    expect(ticks[0].internalSymbol).toBe("SOL-PERP");
    expect(ticks[0].mark).toBeCloseTo(150, 6);
    expect(health).toContain(true);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain(`ids[]=${SOL_ID}`);
    expect(url).toContain("/v2/updates/price/stream");
    expect(url).toContain("parsed=true");
  });

  it("does not start when no feed ids are configured", async () => {
    const fetchImpl = vi.fn();
    const mgr = new FlashPythSseManager({
      feedMap: { "SOL-PERP": "" },
      onTick: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    mgr.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
    mgr.disconnect();
  });

  it("reports an HTTP error and can be stopped cleanly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, body: null } as unknown as Response);
    const mgr = new FlashPythSseManager({
      feedMap: { "SOL-PERP": SOL_ID },
      onTick: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    mgr.connect();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    mgr.disconnect();
    expect(mgr.isConnected()).toBe(false);
  });

  it("reconnects when the stream goes idle (stale watchdog)", async () => {
    const health: boolean[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(pendingSseResponse()));
    const mgr = new FlashPythSseManager({
      feedMap: { "SOL-PERP": SOL_ID },
      onTick: () => {},
      onHealth: (h) => health.push(h),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      staleTimeoutMs: 20,
    });
    mgr.connect();
    // First stream connects (health true) then stalls; the watchdog fires after
    // ~20ms, cancels the reader, and forces a reconnect.
    await vi.waitFor(
      () => expect(mgr.getStatus().reconnectCount).toBeGreaterThanOrEqual(1),
      { timeout: 2_000 },
    );
    mgr.disconnect();
    expect(health).toContain(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
