import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type {
  FlashAccountStreamTransport,
  AccountChangeHandler,
  FlashAccountChange,
} from '../../server/protocol/flash/flash-ws.js';

const { FlashWsManager } = await import('../../server/protocol/flash/flash-ws.js');

/**
 * In-memory stand-in for the Helius `Connection.onAccountChange` transport.
 * Lets us drive subscribe/unsubscribe/ping deterministically and inject
 * failures (constructor-style throws, dead transport) without real RPC.
 */
class MockTransport implements FlashAccountStreamTransport {
  private subs = new Map<number, { pubkey: string; handler: AccountChangeHandler }>();
  private nextId = 1;

  pingResult = true;
  subscribeShouldThrow = false;

  subscribeCalls = 0;
  unsubscribeCalls = 0;
  pingCalls = 0;

  subscribe(pubkey: PublicKey, handler: AccountChangeHandler): number {
    this.subscribeCalls++;
    if (this.subscribeShouldThrow) throw new Error('subscribe failed (transport down)');
    const id = this.nextId++;
    this.subs.set(id, { pubkey: pubkey.toBase58(), handler });
    return id;
  }

  async unsubscribe(subscriptionId: number): Promise<void> {
    this.unsubscribeCalls++;
    this.subs.delete(subscriptionId);
  }

  async ping(): Promise<boolean> {
    this.pingCalls++;
    return this.pingResult;
  }

  /** Push an account change to every live subscription on `address`. */
  emit(address: string, change: FlashAccountChange): void {
    for (const sub of Array.from(this.subs.values())) {
      if (sub.pubkey === address) sub.handler(change);
    }
  }

  liveSubscriptions(): number {
    return this.subs.size;
  }
}

/** Cheap, unique, valid base58 address from an index (no keypair cost). */
function addr(i: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = i & 0xff;
  bytes[1] = (i >> 8) & 0xff;
  return new PublicKey(bytes).toBase58();
}

const ADDR_A = addr(1);
const ADDR_B = addr(2);

function fakeChange(address: string, slot = 1): FlashAccountChange {
  return {
    pubkey: address,
    accountInfo: {
      data: Buffer.from([]),
      executable: false,
      lamports: 0,
      owner: new PublicKey(addr(999)),
      rentEpoch: 0,
    } as any,
    slot,
  };
}

const HEARTBEAT_MS = 20_000;

describe('FlashWsManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start / stop lifecycle', () => {
    it('is not healthy before the first heartbeat', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.start();
      expect(mgr.isHealthy()).toBe(false);
      expect(mgr.watchedCount()).toBe(0);
    });

    it('start is idempotent (no duplicate heartbeat loops)', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.start();
      mgr.start();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(t.pingCalls).toBe(1);
      await mgr.stop();
    });

    it('stop tears down all subscriptions and marks unhealthy', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.watchAccount(ADDR_A, () => {});
      mgr.watchAccount(ADDR_B, () => {});
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(mgr.isHealthy()).toBe(true);
      expect(t.liveSubscriptions()).toBe(2);

      await mgr.stop();
      expect(mgr.watchedCount()).toBe(0);
      expect(t.liveSubscriptions()).toBe(0);
      expect(mgr.isHealthy()).toBe(false);
    });
  });

  describe('account watching', () => {
    it('subscribes once per address and delivers changes to all callbacks', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const a: FlashAccountChange[] = [];
      const b: FlashAccountChange[] = [];
      mgr.watchAccount(ADDR_A, (c) => a.push(c));
      mgr.watchAccount(ADDR_A, (c) => b.push(c));

      expect(t.subscribeCalls).toBe(1);
      expect(mgr.watchedCount()).toBe(1);

      t.emit(ADDR_A, fakeChange(ADDR_A, 42));
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      expect(a[0].slot).toBe(42);
    });

    it('routes changes only to the matching address', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const a: FlashAccountChange[] = [];
      const b: FlashAccountChange[] = [];
      mgr.watchAccount(ADDR_A, (c) => a.push(c));
      mgr.watchAccount(ADDR_B, (c) => b.push(c));

      t.emit(ADDR_A, fakeChange(ADDR_A));
      expect(a.length).toBe(1);
      expect(b.length).toBe(0);
    });

    it('unsubscribe tears down only after the LAST callback is removed', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const unsub1 = mgr.watchAccount(ADDR_A, () => {});
      const unsub2 = mgr.watchAccount(ADDR_A, () => {});
      expect(t.subscribeCalls).toBe(1);

      unsub1();
      expect(mgr.watchedCount()).toBe(1);
      expect(t.unsubscribeCalls).toBe(0);

      unsub2();
      expect(mgr.watchedCount()).toBe(0);
      expect(t.unsubscribeCalls).toBe(1);
    });

    it('unsubscribe is idempotent', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const unsub = mgr.watchAccount(ADDR_A, () => {});
      unsub();
      unsub();
      unsub();
      expect(t.unsubscribeCalls).toBe(1);
      expect(mgr.watchedCount()).toBe(0);
    });

    it('enforces the per-account callback cap', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      for (let i = 0; i < 20; i++) mgr.watchAccount(ADDR_A, () => {});
      expect(() => mgr.watchAccount(ADDR_A, () => {})).toThrow(/max callbacks/);
    });

    it('enforces the max watched-accounts cap', () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      for (let i = 0; i < 500; i++) mgr.watchAccount(addr(1000 + i), () => {});
      expect(() => mgr.watchAccount(addr(9999), () => {})).toThrow(/max watched accounts/);
    });

    it('a throwing callback does not crash delivery to siblings', () => {
      const t = new MockTransport();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mgr = new FlashWsManager(t);
      const good: FlashAccountChange[] = [];
      mgr.watchAccount(ADDR_A, () => { throw new Error('callback boom'); });
      mgr.watchAccount(ADDR_A, (c) => good.push(c));

      expect(() => t.emit(ADDR_A, fakeChange(ADDR_A))).not.toThrow();
      expect(good.length).toBe(1);
      consoleSpy.mockRestore();
    });
  });

  describe('heartbeat health', () => {
    it('reports healthy after a successful ping and notifies subscribers', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const states: boolean[] = [];
      mgr.onHealthChange((h) => states.push(h));
      mgr.start();

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(mgr.isHealthy()).toBe(true);
      expect(states).toContain(true);
      await mgr.stop();
    });

    it('flips to unhealthy when a ping fails', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const states: boolean[] = [];
      mgr.onHealthChange((h) => states.push(h));
      mgr.start();

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(mgr.isHealthy()).toBe(true);

      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(mgr.isHealthy()).toBe(false);
      expect(states).toContain(false);
      await mgr.stop();
    });
  });

  describe('reconnection with exponential backoff', () => {
    it('resubscribes every watched account after a transport failure', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.watchAccount(ADDR_A, () => {});
      mgr.watchAccount(ADDR_B, () => {});
      expect(t.subscribeCalls).toBe(2);

      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); // ping fails -> schedule reconnect
      await vi.advanceTimersByTimeAsync(2_000); // reconnect fires -> resubscribeAll
      // both accounts torn down + re-subscribed
      expect(t.subscribeCalls).toBe(4);
      expect(t.unsubscribeCalls).toBe(2);
      await mgr.stop();
    });

    it('backoff doubles each consecutive failed attempt', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // strip jitter -> deterministic delays
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const t = new MockTransport();
      t.subscribeShouldThrow = true; // every (re)subscribe fails -> pure backoff loop
      const mgr = new FlashWsManager(t);

      mgr.watchAccount(ADDR_A, () => {}); // attempt #1 throws -> schedule @1000ms
      expect(t.subscribeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000); // @1000 -> attempt #2 -> schedule @2000
      expect(t.subscribeCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(t.subscribeCalls).toBe(2); // not yet (needs 2000)
      await vi.advanceTimersByTimeAsync(1); // @2000 -> attempt #3 -> schedule @4000
      expect(t.subscribeCalls).toBe(3);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(t.subscribeCalls).toBe(3); // not yet (needs 4000)
      await vi.advanceTimersByTimeAsync(1); // @4000 -> attempt #4
      expect(t.subscribeCalls).toBe(4);

      consoleSpy.mockRestore();
      await mgr.stop();
    });

    it('backoff stays capped near 60s under sustained failure', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const t = new MockTransport();
      t.subscribeShouldThrow = true;
      t.pingResult = false; // heartbeat also fails -> no backoff reset
      const mgr = new FlashWsManager(t);
      mgr.watchAccount(ADDR_A, () => {});

      // saturate the backoff to its ceiling
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      const before = t.subscribeCalls;
      // one capped window must still produce at least one more reconnect attempt
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.subscribeCalls).toBeGreaterThan(before);

      consoleSpy.mockRestore();
      await mgr.stop();
    });

    it('resets backoff to the floor after a successful heartbeat', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.watchAccount(ADDR_A, () => {});

      // grow backoff with two failed heartbeats
      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

      // recover -> heartbeat success resets the backoff floor
      t.pingResult = true;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(mgr.isHealthy()).toBe(true);

      // fail again -> reconnect should fire at the floor (~1000ms), not a grown delay
      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      const before = t.subscribeCalls;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(t.subscribeCalls).toBeGreaterThan(before);
      await mgr.stop();
    });

    it('still delivers account changes to callbacks after a reconnect', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      const received: FlashAccountChange[] = [];
      mgr.watchAccount(ADDR_A, (c) => received.push(c));

      // delivery works before any reconnect
      t.emit(ADDR_A, fakeChange(ADDR_A, 1));
      expect(received.length).toBe(1);

      // force a full reconnect cycle (ping fails -> schedule -> recover -> resubscribeAll)
      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      t.pingResult = true;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.subscribeCalls).toBe(2); // re-subscribed on the fresh transport sub
      expect(t.liveSubscriptions()).toBe(1);

      // the ORIGINAL callback must still receive changes on the new subscription
      t.emit(ADDR_A, fakeChange(ADDR_A, 2));
      expect(received.length).toBe(2);
      expect(received[1].slot).toBe(2);
      await mgr.stop();
    });
  });

  describe('chaos scenarios', () => {
    it('watchAccount does not throw when the initial subscribe fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const t = new MockTransport();
      t.subscribeShouldThrow = true;
      const mgr = new FlashWsManager(t);

      expect(() => mgr.watchAccount(ADDR_A, () => {})).not.toThrow();
      expect(mgr.watchedCount()).toBe(1);

      // transport recovers -> a scheduled reconnect re-subscribes successfully
      t.subscribeShouldThrow = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.subscribeCalls).toBeGreaterThanOrEqual(2);
      expect(t.liveSubscriptions()).toBe(1);

      consoleSpy.mockRestore();
      await mgr.stop();
    });

    it('stop cancels a pending reconnect timer', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      mgr.watchAccount(ADDR_A, () => {});

      t.pingResult = false;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); // schedules a reconnect
      await mgr.stop();

      const callsAfterStop = t.subscribeCalls;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.subscribeCalls).toBe(callsAfterStop); // no reconnect fired post-stop
      expect(mgr.isHealthy()).toBe(false);
    });

    it('rapid start/stop cycles do not leak timers', async () => {
      const t = new MockTransport();
      const mgr = new FlashWsManager(t);
      for (let i = 0; i < 10; i++) {
        mgr.start();
        await mgr.stop();
      }
      expect(mgr.isHealthy()).toBe(false);

      const pingsBefore = t.pingCalls;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.pingCalls).toBe(pingsBefore); // no orphaned heartbeat intervals
    });
  });
});
