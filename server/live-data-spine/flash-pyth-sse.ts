/**
 * Flash market-price feed via Pyth Hermes SSE (Live-Data Spine, Phase 0).
 *
 * Flash has no public mark/oracle price WebSocket; its on-chain mark IS the Pyth
 * oracle price (the Flash adapter already pulls Pyth Hermes over HTTP with a 30s
 * cache). For the real-time spine we instead subscribe to Hermes' streaming
 * endpoint so we get a push feed rather than polling:
 *   GET https://hermes.pyth.network/v2/updates/price/stream?ids[]=<id>&...&parsed=true
 *   -> text/event-stream; each `data:` line is { parsed: [ { id, price: {price,conf,expo,publish_time}, ... } ] }
 *
 * Because Pyth IS the price source on Flash, there is no independent mark-vs-oracle
 * basis to track here — `oracle` is left null. Phase 0 is read-only: emit ticks
 * and report health. No trading. The HTTP `/latest` snapshot stays the adapter's
 * concern; this manager never polls.
 */

import type { PriceTick } from './types.js';

export const PYTH_HERMES_BASE = 'https://hermes.pyth.network';

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** No data for this long on an OPEN stream => treat as stale: abort + reconnect. */
const DEFAULT_STALE_TIMEOUT_MS = 45_000;
/** Hard cap on an unterminated SSE buffer (no newline) before forcing a reconnect. */
const MAX_SSE_BUFFER_BYTES = 1_048_576; // 1 MiB

export type TickHandler = (tick: PriceTick) => void;
export type HealthHandler = (healthy: boolean) => void;
export type ParseErrorHandler = (count: number) => void;

export interface FlashPythSseOptions {
  /** internalSymbol -> Pyth hex feed id (no 0x). Blank ids must be excluded. */
  feedMap: Record<string, string>;
  hermesBase?: string;
  onTick: TickHandler;
  onHealth?: HealthHandler;
  onParseError?: ParseErrorHandler;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** No-data idle timeout (ms) before forcing a reconnect; default 45s. */
  staleTimeoutMs?: number;
}

export interface FlashPythSseStatus {
  connected: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
}

interface PythParsedEntry {
  id?: string;
  price?: { price?: string | number; expo?: number; publish_time?: number };
}

/**
 * Pure parser: a single Hermes SSE `data:` JSON payload -> PriceTicks.
 * Exported for unit testing. `idToSymbol` keys are lowercase hex ids.
 */
export function parseHermesSseData(
  json: string,
  idToSymbol: Map<string, string>,
  receivedAt: number,
): { ticks: PriceTick[]; parseErrors: number } {
  const ticks: PriceTick[] = [];
  let parseErrors = 0;

  let payload: { parsed?: PythParsedEntry[] };
  try {
    payload = JSON.parse(json);
  } catch {
    return { ticks, parseErrors: 1 };
  }

  const parsed = Array.isArray(payload?.parsed) ? payload.parsed : [];
  for (const entry of parsed) {
    const id = typeof entry?.id === 'string' ? entry.id.toLowerCase() : '';
    const internalSymbol = idToSymbol.get(id);
    if (!internalSymbol) {
      // Unknown id — not an error, just a feed we did not subscribe to.
      continue;
    }
    const p = entry.price;
    const rawPrice = p?.price;
    const expo = typeof p?.expo === 'number' ? p.expo : NaN;
    const base = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice));
    if (!Number.isFinite(base) || !Number.isFinite(expo)) {
      parseErrors++;
      continue;
    }
    const mark = base * Math.pow(10, expo);
    if (!Number.isFinite(mark) || mark <= 0) {
      parseErrors++;
      continue;
    }
    // Pyth publish_time is in SECONDS.
    const pubSec = p?.publish_time;
    const publishTime = typeof pubSec === 'number' && Number.isFinite(pubSec)
      ? pubSec * 1000
      : receivedAt;

    ticks.push({
      venue: 'flash',
      internalSymbol,
      mark,
      oracle: null,
      funding: null,
      publishTime,
      receivedAt,
    });
  }

  return { ticks, parseErrors };
}

export class FlashPythSseManager {
  private readonly feedMap: Record<string, string>;
  private readonly hermesBase: string;
  private readonly onTick: TickHandler;
  private readonly onHealth?: HealthHandler;
  private readonly onParseError?: ParseErrorHandler;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly staleTimeoutMs: number;
  private readonly idToSymbol: Map<string, string>;

  private shouldRun = false;
  private connected = false;
  private lastMessageAt: number | null = null;
  private reconnectCount = 0;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private abortController: AbortController | null = null;
  private backoffCancel: (() => void) | null = null;

  constructor(opts: FlashPythSseOptions) {
    this.feedMap = opts.feedMap;
    this.hermesBase = opts.hermesBase ?? PYTH_HERMES_BASE;
    this.onTick = opts.onTick;
    this.onHealth = opts.onHealth;
    this.onParseError = opts.onParseError;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.idToSymbol = new Map(
      Object.entries(this.feedMap)
        .filter(([, id]) => typeof id === 'string' && id.length > 0)
        .map(([sym, id]) => [id.toLowerCase(), sym]),
    );
  }

  connect(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    void this.runLoop();
  }

  disconnect(): void {
    this.shouldRun = false;
    this.connected = false;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // ignore
      }
      this.abortController = null;
    }
    if (this.backoffCancel) {
      this.backoffCancel();
      this.backoffCancel = null;
    }
    this.notifyHealth(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): FlashPythSseStatus {
    return {
      connected: this.connected,
      lastMessageAt: this.lastMessageAt,
      reconnectCount: this.reconnectCount,
    };
  }

  private buildUrl(): string {
    const ids = Array.from(this.idToSymbol.keys());
    const qs = ids.map((id) => `ids[]=${id}`).join('&');
    return `${this.hermesBase}/v2/updates/price/stream?${qs}&parsed=true`;
  }

  private async runLoop(): Promise<void> {
    if (this.idToSymbol.size === 0) {
      console.warn('[Spine][Flash] no Pyth feed ids configured; SSE not started');
      this.shouldRun = false;
      return;
    }
    while (this.shouldRun) {
      try {
        await this.streamOnce();
        this.reconnectDelay = RECONNECT_INITIAL_MS;
      } catch (err) {
        if (this.shouldRun) {
          console.warn('[Spine][Flash] SSE stream error:', (err as Error)?.message ?? err);
        }
      }
      this.connected = false;
      this.notifyHealth(false);
      if (!this.shouldRun) break;
      this.reconnectCount++;
      const delay = Math.min(
        this.reconnectDelay + Math.random() * 1000,
        RECONNECT_MAX_MS,
      );
      await this.delay(delay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  }

  private async streamOnce(): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    const res = await this.fetchImpl(this.buildUrl(), {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Hermes SSE HTTP ${res.status}`);
    }
    this.connected = true;
    this.lastMessageAt = this.now();
    this.notifyHealth(true);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    // Stale-feed watchdog: an OPEN-but-silent stream must not block reader.read()
    // forever. On idle we cancel the reader (unblocks read -> loop ends) and abort
    // the fetch; runLoop then reconnects because shouldRun stays true.
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        console.warn('[Spine][Flash] SSE idle/stale, forcing reconnect');
        this.connected = false;
        this.notifyHealth(false);
        void reader.cancel().catch(() => {});
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }, this.staleTimeoutMs);
    };
    armIdle();
    try {
      while (this.shouldRun) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle(); // fresh bytes -> reset the idle watchdog
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('data:')) {
            this.handleData(line.slice(5).trim());
          }
        }
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new Error('Hermes SSE line exceeded max buffer (no newline)');
        }
      }
    } finally {
      clearIdle();
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  private handleData(json: string): void {
    if (json.length === 0) return;
    this.lastMessageAt = this.now();
    const { ticks, parseErrors } = parseHermesSseData(json, this.idToSymbol, this.lastMessageAt);
    if (parseErrors > 0) this.onParseError?.(parseErrors);
    for (const tick of ticks) {
      try {
        this.onTick(tick);
      } catch (err) {
        console.error('[Spine][Flash] tick handler error:', err);
      }
    }
  }

  /** Cancellable delay so disconnect() interrupts a pending reconnect backoff. */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.backoffCancel = null;
        resolve();
      }, ms);
      this.backoffCancel = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private notifyHealth(healthy: boolean): void {
    try {
      this.onHealth?.(healthy);
    } catch (err) {
      console.error('[Spine][Flash] health handler error:', err);
    }
  }
}
