import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerAdapter,
  unregisterAdapter,
  setDefaultAdapter,
  getDefaultAdapter,
  getAdapterForBot,
} from '../../server/protocol/adapter-registry.js';
import type { ProtocolAdapter } from '../../server/protocol/adapter.js';

// Phase 4 routing regression: the routes.ts/service threading migrated read +
// economic paths from getDefaultAdapter() to per-bot getAdapterForBot(bot). The
// helpers all use the trailing `adapter = getDefaultAdapter()` pattern, so a bot
// on a non-default protocol MUST resolve to its own adapter and a bot on an
// unregistered protocol MUST fail closed (throw) rather than silently fall back
// to the default. This pins those invariants down at the registry primitive that
// every threaded call site depends on.

interface StubAdapter extends ProtocolAdapter {
  __calls: string[];
}

function makeStubAdapter(name: string, opts: { supportsSettlePnl: boolean; minTransferAmount: number }): StubAdapter {
  const calls: string[] = [];
  const stub: any = {
    protocolName: name,
    protocolVersion: '0.0.1',
    minTransferAmount: opts.minTransferAmount,
    getCapabilities: () => ({
      supportsPartialFills: true,
      supportsStopOrders: true,
      supportsTpSl: true,
      supportsBatchOrders: true,
      supportsIsolatedMargin: true,
      supportsWebSocket: true,
      supportsSettlePnl: opts.supportsSettlePnl,
      supportsCloseSubaccount: true,
      maxSubaccounts: null,
      settlementType: 'off-chain',
    }),
    getAccountInfo: async () => {
      calls.push('getAccountInfo');
      return { balance: 0, equity: 0, freeCollateral: 0, totalCollateral: 0, marginUsed: 0, unrealizedPnl: 0, positions: [] };
    },
    getPositions: async () => {
      calls.push('getPositions');
      return [];
    },
    settlePnl: async () => {
      calls.push('settlePnl');
      return { success: true };
    },
    closeSubaccount: async () => {
      calls.push('closeSubaccount');
      return { success: true };
    },
    __calls: calls,
  };
  return stub as StubAdapter;
}

// Mirrors the exact signature contract introduced by the Phase 4 threading:
// an optional trailing `adapter` defaulting to getDefaultAdapter(). Callers that
// know the bot pass getAdapterForBot(bot); callers that don't fall to default.
async function readBalanceLikeHelper(adapter = getDefaultAdapter()): Promise<string> {
  await adapter.getAccountInfo('addr', '0');
  return adapter.protocolName;
}

describe('Phase 4 per-bot adapter routing', () => {
  let pacifica: StubAdapter;
  let flash: StubAdapter;

  beforeEach(() => {
    pacifica = makeStubAdapter('pacifica', { supportsSettlePnl: false, minTransferAmount: 10 });
    flash = makeStubAdapter('flash', { supportsSettlePnl: true, minTransferAmount: 0 });
    registerAdapter(pacifica);
    registerAdapter(flash);
    setDefaultAdapter('pacifica');
  });

  afterEach(() => {
    unregisterAdapter('pacifica');
    unregisterAdapter('flash');
  });

  it('default adapter is pacifica', () => {
    expect(getDefaultAdapter().protocolName).toBe('pacifica');
  });

  it('routes a flash bot to the flash adapter, distinct from the default', () => {
    const bot = { id: '1', activeProtocol: 'flash' as const };
    const adapter = getAdapterForBot(bot);
    expect(adapter.protocolName).toBe('flash');
    expect(adapter).not.toBe(getDefaultAdapter());
  });

  it('routes a pacifica bot to the default adapter (no-op for the live protocol)', () => {
    const bot = { id: '2', activeProtocol: 'pacifica' as const };
    expect(getAdapterForBot(bot)).toBe(getDefaultAdapter());
  });

  it('fails closed when a bot is on a protocol with no registered adapter', () => {
    unregisterAdapter('flash');
    const bot = { id: '3', activeProtocol: 'flash' as const };
    expect(() => getAdapterForBot(bot)).toThrow(/active_protocol="flash"/);
    // Must NOT silently return the default adapter.
    expect(() => getAdapterForBot(bot)).toThrow(/do not silently fall back/);
  });

  it('threaded helper resolves reads to the bot adapter, not the default', async () => {
    const flashBot = { id: '4', activeProtocol: 'flash' as const };
    const resolved = await readBalanceLikeHelper(getAdapterForBot(flashBot));
    expect(resolved).toBe('flash');
    expect(flash.__calls).toContain('getAccountInfo');
    expect(pacifica.__calls).not.toContain('getAccountInfo');
  });

  it('threaded helper falls back to default only when no adapter is passed', async () => {
    const resolved = await readBalanceLikeHelper();
    expect(resolved).toBe('pacifica');
    expect(pacifica.__calls).toContain('getAccountInfo');
    expect(flash.__calls).not.toContain('getAccountInfo');
  });

  it('economic capability + minTransfer gates read from the bot adapter', () => {
    const flashBot = { id: '5', activeProtocol: 'flash' as const };
    const pacificaBot = { id: '6', activeProtocol: 'pacifica' as const };
    expect(getAdapterForBot(flashBot).getCapabilities().supportsSettlePnl).toBe(true);
    expect(getAdapterForBot(pacificaBot).getCapabilities().supportsSettlePnl).toBe(false);
    expect(getAdapterForBot(flashBot).minTransferAmount).toBe(0);
    expect(getAdapterForBot(pacificaBot).minTransferAmount).toBe(10);
  });
});
