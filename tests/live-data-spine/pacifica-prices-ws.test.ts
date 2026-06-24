import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePacificaPricesMessage,
  PacificaPricesWsManager,
} from "../../server/live-data-spine/pacifica-prices-ws";
import type { PriceTick } from "../../server/live-data-spine/types";

const RX = 1_700_000_000_000;

describe("parsePacificaPricesMessage", () => {
  it("parses a prices payload with array data", () => {
    const raw = {
      channel: "prices",
      data: [
        { symbol: "SOL", mark: "100.5", oracle: "100", funding: "0.0001", timestamp: 1234 },
        { symbol: "BTC", mark: 60000, oracle: 60010, funding: -0.0002, timestamp: 5678 },
      ],
    };
    const { ticks, parseErrors } = parsePacificaPricesMessage(raw, RX);
    expect(parseErrors).toBe(0);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({
      venue: "pacifica",
      internalSymbol: "SOL-PERP",
      mark: 100.5,
      oracle: 100,
      funding: 0.0001,
      publishTime: 1234,
      receivedAt: RX,
    });
    expect(ticks[1].internalSymbol).toBe("BTC-PERP");
    expect(ticks[1].mark).toBe(60000);
  });

  it("uses an injected symbol mapper", () => {
    const map = (p: string) => (p === "kBONK" ? "1MBONK-PERP" : `${p.toUpperCase()}-PERP`);
    const { ticks } = parsePacificaPricesMessage(
      { channel: "prices", data: [{ symbol: "kBONK", mark: "0.00001" }] },
      RX,
      map,
    );
    expect(ticks[0].internalSymbol).toBe("1MBONK-PERP");
  });

  it("ignores non-prices channels", () => {
    const { ticks } = parsePacificaPricesMessage({ channel: "pong" }, RX);
    expect(ticks).toHaveLength(0);
  });

  it("counts entries missing a symbol or mark as parse errors", () => {
    const raw = {
      channel: "prices",
      data: [
        { mark: "100" }, // no symbol
        { symbol: "SOL", mark: "not-a-number" }, // bad mark
        { symbol: "ETH", mark: "3000" }, // ok
      ],
    };
    const { ticks, parseErrors } = parsePacificaPricesMessage(raw, RX);
    expect(parseErrors).toBe(2);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].internalSymbol).toBe("ETH-PERP");
  });

  it("nulls oracle/funding when absent and falls back publishTime to receivedAt", () => {
    const { ticks } = parsePacificaPricesMessage(
      { channel: "prices", data: [{ symbol: "SOL", mark: "100" }] },
      RX,
    );
    expect(ticks[0].oracle).toBeNull();
    expect(ticks[0].funding).toBeNull();
    expect(ticks[0].publishTime).toBe(RX);
  });

  it("tolerates a payload with no channel field (raw array)", () => {
    const { ticks } = parsePacificaPricesMessage(
      [{ symbol: "SOL", mark: "100" }],
      RX,
    );
    expect(ticks).toHaveLength(1);
  });

  it("rejects a non-positive mark as a parse error", () => {
    const { ticks, parseErrors } = parsePacificaPricesMessage(
      {
        channel: "prices",
        data: [
          { symbol: "SOL", mark: "0" },
          { symbol: "BTC", mark: "-5" },
          { symbol: "ETH", mark: "3000" },
        ],
      },
      RX,
    );
    expect(parseErrors).toBe(2);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].internalSymbol).toBe("ETH-PERP");
  });

  it("rejects partial-number strings like '123abc' (strict parse)", () => {
    const { ticks, parseErrors } = parsePacificaPricesMessage(
      { channel: "prices", data: [{ symbol: "SOL", mark: "123abc" }] },
      RX,
    );
    expect(parseErrors).toBe(1);
    expect(ticks).toHaveLength(0);
  });
});

// ── Minimal fake WebSocket for manager tests ─────────────────────────────────
class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // test helpers
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("PacificaPricesWsManager", () => {
  let sockets: FakeWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    factory = (url: string) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the correct subscribe envelope on open and reports health", () => {
    const health: boolean[] = [];
    const mgr = new PacificaPricesWsManager({
      onTick: () => {},
      onHealth: (h) => health.push(h),
      webSocketFactory: factory,
    });
    mgr.connect();
    expect(sockets).toHaveLength(1);
    sockets[0].triggerOpen();

    expect(mgr.isConnected()).toBe(true);
    expect(health).toContain(true);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      method: "subscribe",
      params: { source: "prices" },
    });
  });

  it("emits parsed ticks from incoming messages", () => {
    const ticks: PriceTick[] = [];
    const mgr = new PacificaPricesWsManager({
      onTick: (t) => ticks.push(t),
      webSocketFactory: factory,
    });
    mgr.connect();
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({
      channel: "prices",
      data: [{ symbol: "SOL", mark: "150", oracle: "149.9" }],
    });
    expect(ticks).toHaveLength(1);
    expect(ticks[0].internalSymbol).toBe("SOL-PERP");
    expect(ticks[0].mark).toBe(150);
  });

  it("reconnects after a non-clean close", () => {
    const mgr = new PacificaPricesWsManager({
      onTick: () => {},
      webSocketFactory: factory,
    });
    mgr.connect();
    sockets[0].triggerOpen();
    // Server-side drop (code != 1000) should schedule a reconnect.
    sockets[0].close(1006);
    expect(mgr.isConnected()).toBe(false);

    vi.advanceTimersByTime(2_000); // past initial backoff + jitter
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(mgr.getStatus().reconnectCount).toBeGreaterThanOrEqual(1);
  });

  it("reconnects after a clean (1000) server-side close while still running", () => {
    const mgr = new PacificaPricesWsManager({
      onTick: () => {},
      webSocketFactory: factory,
    });
    mgr.connect();
    sockets[0].triggerOpen();
    // A clean server-initiated close (code 1000) must NOT strand the feed.
    sockets[0].close(1000);
    expect(mgr.isConnected()).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(mgr.getStatus().reconnectCount).toBeGreaterThanOrEqual(1);
  });

  it("does NOT reconnect after an explicit disconnect", () => {
    const mgr = new PacificaPricesWsManager({
      onTick: () => {},
      webSocketFactory: factory,
    });
    mgr.connect();
    sockets[0].triggerOpen();
    mgr.disconnect();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(mgr.isConnected()).toBe(false);
  });
});
