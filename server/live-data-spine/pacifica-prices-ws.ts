/**
 * Pacifica public `prices` WebSocket manager (Live-Data Spine, Phase 0).
 *
 * This is a NEW, dedicated PUBLIC market-data connection — deliberately separate
 * from the private/account `PacificaWsManager` (server/protocol/pacifica/pacifica-ws.ts),
 * which uses a different auth model, schema, and (stale) subscribe envelope.
 *
 * The `prices` channel streams `mark`, `mid`, `oracle`, `funding`, `next_funding`,
 * `open_interest`, `volume_24h`, `timestamp` for ALL symbols in one message:
 *   - URL:       wss://ws.pacifica.fi/ws
 *   - Subscribe: { method: 'subscribe', params: { source: 'prices' } }
 *   - Heartbeat: { method: 'ping' } -> { channel: 'pong' }; idle close after 60s.
 *
 * Phase 0 is read-only: we emit ticks to a handler and report health. No trading.
 * Parsing is intentionally defensive — part of the tracer bullet's job is to
 * surface the real on-wire shape via logs without crashing on surprises.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import type { PriceTick } from './types.js';

export const PACIFICA_PRICES_WS_URL = 'wss://ws.pacifica.fi/ws';

const MAX_RECONNECT_DELAY_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Hard cap on a single WS frame; a larger frame closes the conn (1009) -> reconnect. */
const MAX_WS_PAYLOAD = 4 * 1024 * 1024; // 4 MiB — prices frames are only a few KB.

export type TickHandler = (tick: PriceTick) => void;
export type HealthHandler = (healthy: boolean) => void;
export type ParseErrorHandler = (count: number) => void;
/** Maps a Pacifica protocol symbol (e.g. "SOL") to an internal symbol ("SOL-PERP"). */
export type SymbolMapper = (protocolSymbol: string) => string;

export interface PacificaPricesWsOptions {
  wsUrl?: string;
  mapSymbol?: SymbolMapper;
  onTick: TickHandler;
  onHealth?: HealthHandler;
  onParseError?: ParseErrorHandler;
  /**
   * Injectable for tests; defaults to the `ws` package WebSocket. Node v20 has
   * no stable global WebSocket (it landed in v21+), so we must NOT rely on it.
   */
  webSocketFactory?: (url: string) => WebSocket;
}

type WsState = 'disconnected' | 'connecting' | 'connected' | 'closing';

export interface PacificaPricesWsStatus {
  connected: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
}

/** Coerce string|number price fields to a number; NaN when unparseable. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return NaN;
    // Number() (unlike parseFloat) rejects partial strings like "123abc" -> NaN.
    return Number(t);
  }
  return NaN;
}

const defaultMapSymbol: SymbolMapper = (p) => `${p.toUpperCase()}-PERP`;

/**
 * Pure parser: raw `prices` message -> PriceTicks. Exported for unit testing.
 * Returns the successfully parsed ticks plus a count of entries it had to drop.
 */
export function parsePacificaPricesMessage(
  raw: any,
  receivedAt: number,
  mapSymbol: SymbolMapper = defaultMapSymbol,
): { ticks: PriceTick[]; parseErrors: number } {
  const ticks: PriceTick[] = [];
  let parseErrors = 0;

  const channel = raw?.channel ?? raw?.type;
  // Only handle prices payloads; ignore acks/pongs/other channels silently.
  if (channel !== undefined && channel !== 'prices') {
    return { ticks, parseErrors };
  }

  const entries: any[] = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.prices)
      ? raw.prices
      : Array.isArray(raw)
        ? raw
        : raw?.data && typeof raw.data === 'object'
          ? [raw.data]
          : [];

  for (const e of entries) {
    const symbol = e?.symbol;
    if (typeof symbol !== 'string' || symbol.length === 0) {
      parseErrors++;
      continue;
    }
    const mark = num(e.mark);
    if (!Number.isFinite(mark) || mark <= 0) {
      parseErrors++;
      continue;
    }
    const oracleRaw = num(e.oracle);
    const oracle = Number.isFinite(oracleRaw) ? oracleRaw : null;
    const fundingRaw = num(e.funding);
    const funding = Number.isFinite(fundingRaw) ? fundingRaw : null;
    const tsRaw = num(e.timestamp);
    const publishTime = Number.isFinite(tsRaw) ? tsRaw : receivedAt;

    let internalSymbol: string;
    try {
      internalSymbol = mapSymbol(symbol);
    } catch {
      internalSymbol = defaultMapSymbol(symbol);
    }

    ticks.push({
      venue: 'pacifica',
      internalSymbol,
      mark,
      oracle,
      funding,
      publishTime,
      receivedAt,
    });
  }

  return { ticks, parseErrors };
}

export class PacificaPricesWsManager {
  private readonly wsUrl: string;
  private readonly mapSymbol: SymbolMapper;
  private readonly onTick: TickHandler;
  private readonly onHealth?: HealthHandler;
  private readonly onParseError?: ParseErrorHandler;
  private readonly wsFactory: (url: string) => WebSocket;

  private ws: WebSocket | null = null;
  private state: WsState = 'disconnected';
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt: number | null = null;
  private shouldReconnect = false;
  private reconnectCount = 0;

  constructor(opts: PacificaPricesWsOptions) {
    this.wsUrl = opts.wsUrl ?? PACIFICA_PRICES_WS_URL;
    this.mapSymbol = opts.mapSymbol ?? defaultMapSymbol;
    this.onTick = opts.onTick;
    this.onHealth = opts.onHealth;
    this.onParseError = opts.onParseError;
    this.wsFactory =
      opts.webSocketFactory ??
      ((url) => new NodeWebSocket(url, { maxPayload: MAX_WS_PAYLOAD }) as unknown as WebSocket);
  }

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    if (this.ws) {
      this.state = 'closing';
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.state = 'disconnected';
    this.notifyHealth(false);
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  isHealthy(): boolean {
    if (this.state !== 'connected') return false;
    if (this.lastMessageAt === null) return true;
    return Date.now() - this.lastMessageAt < HEARTBEAT_TIMEOUT_MS;
  }

  getStatus(): PacificaPricesWsStatus {
    return {
      connected: this.state === 'connected',
      lastMessageAt: this.lastMessageAt,
      reconnectCount: this.reconnectCount,
    };
  }

  private doConnect(): void {
    this.state = 'connecting';
    try {
      this.ws = this.wsFactory(this.wsUrl);
    } catch (err) {
      console.error('[Spine][Pacifica] WebSocket constructor failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.lastMessageAt = Date.now();
      this.startHeartbeatMonitor();
      this.sendSubscribe();
      this.notifyHealth(true);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      let data: any;
      try {
        data = JSON.parse(String((event as any).data));
      } catch {
        this.onParseError?.(1);
        return;
      }
      const { ticks, parseErrors } = parsePacificaPricesMessage(
        data,
        this.lastMessageAt,
        this.mapSymbol,
      );
      if (parseErrors > 0) this.onParseError?.(parseErrors);
      for (const tick of ticks) {
        try {
          this.onTick(tick);
        } catch (err) {
          console.error('[Spine][Pacifica] tick handler error:', err);
        }
      }
    };

    this.ws.onclose = (_event: CloseEvent) => {
      this.state = 'disconnected';
      this.clearHeartbeatTimer();
      this.notifyHealth(false);
      // Reconnect on ANY close we did not initiate. disconnect() sets
      // shouldReconnect=false BEFORE closing, so a clean server-side 1000 close
      // while we still want data correctly reconnects (don't gate on close code).
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose fires after onerror; reconnect handled there.
    };
  }

  private sendSubscribe(): void {
    this.send({ method: 'subscribe', params: { source: 'prices' } });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.state !== 'connected') return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // a failed send will surface via onclose/onerror
    }
  }

  private startHeartbeatMonitor(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.lastMessageAt !== null && Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[Spine][Pacifica] feed stale, forcing reconnect');
        this.notifyHealth(false);
        if (this.ws) {
          try {
            this.ws.close(4000, 'heartbeat timeout');
          } catch {
            // ignore
          }
        }
        return;
      }
      this.send({ method: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (!this.shouldReconnect) return;
    const delay = Math.min(
      this.reconnectDelay + Math.random() * 1000,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectCount++;
      this.doConnect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private notifyHealth(healthy: boolean): void {
    try {
      this.onHealth?.(healthy);
    } catch (err) {
      console.error('[Spine][Pacifica] health handler error:', err);
    }
  }
}
