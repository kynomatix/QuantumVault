import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

describe('retired FlashPythSseManager',()=>{
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
 it.each([{'SOL-PERP':SOL_ID},{'SOL-PERP':''}])('never connects or schedules reconnects for %j',async feedMap=>{
  vi.useFakeTimers();const fetchImpl=vi.fn(),onTick=vi.fn();vi.stubGlobal('fetch',fetchImpl);
  const mgr=new FlashPythSseManager({feedMap,onTick,staleTimeoutMs:20});
  mgr.connect();mgr.connect();await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchImpl).not.toHaveBeenCalled();expect(onTick).not.toHaveBeenCalled();expect(mgr.isConnected()).toBe(false);expect(mgr.getStatus().reconnectCount).toBe(0);
  mgr.disconnect();expect(vi.getTimerCount()).toBe(0);
 });
});
