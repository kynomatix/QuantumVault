/**
 * Flash account-stream manager (Helius `accountSubscribe` plane).
 *
 * Flash is on-chain, so the real-time channel is NOT a protocol WebSocket (as on
 * Pacifica) but Solana account subscriptions over Helius. This manager watches a
 * bounded set of on-chain accounts (position / order PDAs) and pushes raw
 * account-change buffers to subscribers; decoding into `ProtocolPosition` /
 * `OrderUpdate` is the adapter's job (it owns the flash-sdk decoders), keeping
 * this module decoupled from the SDK.
 *
 * The transport sits behind `FlashAccountStreamTransport` so the Flash V2
 * MagicBlock seam (§4.5, ER gRPC state streaming) can replace Helius WS without
 * touching this manager or the adapter. The default transport uses
 * `@solana/web3.js` `Connection.onAccountChange`.
 *
 * Mirrors `pacifica-ws.ts` operationally: exponential backoff + jitter on
 * reconnect, a heartbeat that proves the transport is live, bounded callback
 * sets (no unbounded listener growth), and idempotent unsubscribe.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import { getPrimaryRpcUrl } from '../../rpc-config.js';

const MAX_RECONNECT_DELAY_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_WATCHED_ACCOUNTS = 500;
const MAX_CALLBACKS_PER_ACCOUNT = 20;

export interface FlashAccountChange {
  pubkey: string;
  accountInfo: AccountInfo<Buffer>;
  slot: number;
}

export type AccountChangeHandler = (change: FlashAccountChange) => void;

/**
 * Pluggable transport. Default = Helius WS via web3 `Connection`. The V2 ER gRPC
 * streaming seam implements this same interface (§4.5).
 */
export interface FlashAccountStreamTransport {
  subscribe(pubkey: PublicKey, handler: AccountChangeHandler): number;
  unsubscribe(subscriptionId: number): Promise<void>;
  /** Liveness probe used by the heartbeat. Resolves false on failure. */
  ping(): Promise<boolean>;
}

class HeliusConnectionTransport implements FlashAccountStreamTransport {
  private connection: Connection;

  constructor(connection?: Connection) {
    this.connection = connection ?? new Connection(getPrimaryRpcUrl(), 'confirmed');
  }

  subscribe(pubkey: PublicKey, handler: AccountChangeHandler): number {
    return this.connection.onAccountChange(
      pubkey,
      (accountInfo, ctx) => {
        handler({
          pubkey: pubkey.toBase58(),
          accountInfo: accountInfo as AccountInfo<Buffer>,
          slot: ctx.slot,
        });
      },
      'confirmed',
    );
  }

  async unsubscribe(subscriptionId: number): Promise<void> {
    await this.connection.removeAccountChangeListener(subscriptionId);
  }

  async ping(): Promise<boolean> {
    try {
      await this.connection.getSlot('confirmed');
      return true;
    } catch {
      return false;
    }
  }
}

interface WatchedAccount {
  pubkey: PublicKey;
  subscriptionId: number | null;
  callbacks: Set<AccountChangeHandler>;
}

type HealthCallback = (healthy: boolean) => void;

export class FlashWsManager {
  private transport: FlashAccountStreamTransport;
  private watched = new Map<string, WatchedAccount>();
  private healthCallbacks = new Set<HealthCallback>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private healthy = false;
  private running = false;

  constructor(transport?: FlashAccountStreamTransport) {
    this.transport = transport ?? new HeliusConnectionTransport();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startHeartbeat();
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  watchedCount(): number {
    return this.watched.size;
  }

  /**
   * Subscribe to changes on `address`. Returns an idempotent unsubscribe: the
   * underlying account subscription is torn down only when its LAST callback is
   * removed. Calling the returned function more than once is safe.
   */
  watchAccount(address: string, callback: AccountChangeHandler): () => void {
    if (!this.running) this.start();

    let entry = this.watched.get(address);
    if (!entry) {
      if (this.watched.size >= MAX_WATCHED_ACCOUNTS) {
        throw new Error(
          `FlashWsManager: max watched accounts (${MAX_WATCHED_ACCOUNTS}) reached`,
        );
      }
      const pubkey = new PublicKey(address);
      entry = { pubkey, subscriptionId: null, callbacks: new Set() };
      this.watched.set(address, entry);
      this.subscribeEntry(entry);
    }

    if (entry.callbacks.size >= MAX_CALLBACKS_PER_ACCOUNT) {
      throw new Error(
        `FlashWsManager: max callbacks (${MAX_CALLBACKS_PER_ACCOUNT}) for ${address}`,
      );
    }
    entry.callbacks.add(callback);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const e = this.watched.get(address);
      if (!e) return;
      e.callbacks.delete(callback);
      if (e.callbacks.size === 0) {
        this.unsubscribeEntry(e);
        this.watched.delete(address);
      }
    };
  }

  onHealthChange(callback: HealthCallback): () => void {
    this.healthCallbacks.add(callback);
    return () => this.healthCallbacks.delete(callback);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearHeartbeat();
    this.clearReconnect();
    for (const entry of Array.from(this.watched.values())) {
      this.unsubscribeEntry(entry);
    }
    this.watched.clear();
    this.setHealth(false);
  }

  private subscribeEntry(entry: WatchedAccount): void {
    try {
      entry.subscriptionId = this.transport.subscribe(entry.pubkey, (change) => {
        for (const cb of Array.from(entry.callbacks)) {
          try {
            cb(change);
          } catch (err) {
            console.error('FlashWsManager: account callback error:', err);
          }
        }
      });
    } catch (err) {
      console.error('FlashWsManager: subscribe failed, scheduling reconnect:', err);
      entry.subscriptionId = null;
      this.scheduleReconnect();
    }
  }

  private unsubscribeEntry(entry: WatchedAccount): void {
    if (entry.subscriptionId === null) return;
    const id = entry.subscriptionId;
    entry.subscriptionId = null;
    this.transport.unsubscribe(id).catch((err) => {
      console.error('FlashWsManager: unsubscribe error:', err);
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeat(): Promise<void> {
    const alive = await this.transport.ping();
    this.setHealth(alive);
    if (!alive) {
      this.scheduleReconnect();
    } else {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectDelay + Math.random() * 1_000,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.resubscribeAll();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private resubscribeAll(): void {
    for (const entry of Array.from(this.watched.values())) {
      if (entry.subscriptionId !== null) {
        this.unsubscribeEntry(entry);
      }
      this.subscribeEntry(entry);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setHealth(healthy: boolean): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    for (const cb of Array.from(this.healthCallbacks)) {
      try {
        cb(healthy);
      } catch (err) {
        console.error('FlashWsManager: health callback error:', err);
      }
    }
  }
}
