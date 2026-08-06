import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    getPositions: vi.fn(),
    getStrictPositionForMarket: vi.fn(),
  },
  executeSwiftOrder: vi.fn(),
  getMarketPrice: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getTradingBotById: vi.fn(),
  },
}));

vi.mock('../../server/protocol/adapter-registry', () => ({
  getAdapter: vi.fn(() => mocks.adapter),
  getDefaultAdapter: vi.fn(() => mocks.adapter),
  getAdapterForBot: vi.fn(() => mocks.adapter),
}));

vi.mock('../../server/swift-config', () => ({
  shouldUseSwift: vi.fn(() => true),
}));

vi.mock('../../server/swift-executor', () => ({
  executeSwiftOrder: mocks.executeSwiftOrder,
}));

vi.mock('../../server/drift-price', () => ({
  getMarketPrice: mocks.getMarketPrice,
}));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

import type { ProtocolAdapter } from '../../server/protocol/adapter';
import { closePerpPosition } from '../../server/drift-service';
import { PositionService } from '../../server/position-service';

const adapter = mocks.adapter as unknown as ProtocolAdapter;
const legacyPrivateKey = '1'.repeat(88);
const openPosition = {
  internalSymbol: 'BTC-PERP',
  baseSize: 1,
  entryPrice: 100,
  markPrice: 101,
  unrealizedPnl: 1,
};

function installLegacyCloseResult() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('[Executor] KEY_RECEIVED\n'));
        child.stdout.emit('data', Buffer.from('{"success":true,"signature":"legacy-close"}'));
        child.emit('close', 0);
      });
    }),
  };
  mocks.spawn.mockReturnValue(child);
}

async function runSwiftClose() {
  const resultPromise = closePerpPosition(
    new Uint8Array(64),
    'BTC-PERP',
    0,
    1,
    50,
    legacyPrivateKey,
    'public-agent',
    'long',
  );
  // Cover the 8s Swift verification wait plus the module-level 2s
  // subprocess stagger that may carry across the two focused cases.
  await vi.advanceTimersByTimeAsync(10000);
  return resultPromise;
}

describe('PositionService strict execution reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates an adapter-backed bot-subaccount position read failure', async () => {
    mocks.adapter.getPositions.mockRejectedValueOnce(new Error('venue unavailable'));

    await expect(PositionService.getPositionForExecution(
      'bot-1',
      'agent-public-key',
      0,
      'BTC-PERP',
      'bot-subaccount-public-key',
      adapter,
    )).rejects.toThrow('authoritative venue position read failed for BTC-PERP');
  });

  it('propagates a byte-parsing/adapter position read failure', async () => {
    mocks.adapter.getPositions.mockRejectedValueOnce(new Error('venue unavailable'));

    await expect(PositionService.getPositionForExecution(
      'bot-1',
      'agent-public-key',
      3,
      'BTC-PERP',
      undefined,
      adapter,
    )).rejects.toThrow('authoritative venue position read failed for BTC-PERP');
  });

  it('keeps a successful authoritative empty read as FLAT', async () => {
    mocks.adapter.getPositions.mockResolvedValueOnce([]);

    await expect(PositionService.getPositionForExecution(
      'bot-1',
      'agent-public-key',
      0,
      'BTC-PERP',
      'bot-subaccount-public-key',
      adapter,
    )).resolves.toEqual({
      size: 0,
      side: 'FLAT',
      source: 'on-chain',
      entryPrice: 0,
    });
  });

  it('does not reach a skipped-close or signed-close continuation for either failed read form', async () => {
    const continueClose = vi.fn();
    mocks.adapter.getPositions.mockRejectedValue(new Error('venue unavailable'));

    const botSubaccountRead = PositionService.getPositionForExecution(
      'bot-1', 'agent-public-key', 0, 'BTC-PERP', 'bot-subaccount-public-key', adapter,
    ).then(continueClose);
    const byteParsingRead = PositionService.getPositionForExecution(
      'bot-1', 'agent-public-key', 3, 'BTC-PERP', undefined, adapter,
    ).then(continueClose);

    await expect(botSubaccountRead).rejects.toThrow('authoritative venue position read failed');
    await expect(byteParsingRead).rejects.toThrow('authoritative venue position read failed');
    expect(continueClose).not.toHaveBeenCalled();
  });
});

describe('PositionService close-authority reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the targeted adapter capability and preserves a proven flat result', async () => {
    mocks.adapter.getStrictPositionForMarket.mockResolvedValueOnce(null);

    await expect(PositionService.getPositionForCloseAuthority(
      'bot-1',
      'agent-public-key',
      4,
      'BTC-PERP',
      'bot-subaccount-public-key',
      adapter,
    )).resolves.toEqual({
      size: 0,
      side: 'FLAT',
      source: 'on-chain',
      entryPrice: 0,
    });
    expect(mocks.adapter.getStrictPositionForMarket).toHaveBeenCalledWith(
      'bot-subaccount-public-key',
      'BTC-PERP',
      undefined,
    );
    expect(mocks.adapter.getPositions).not.toHaveBeenCalled();
  });

  it('derives a risk-reducing cached fallback only from a valid nonzero requested-market row', () => {
    expect(PositionService.getRiskReducingCachedCloseFallback({
      market: 'BTC-PERP',
      baseSize: '-0.25',
      avgEntryPrice: '65000',
    }, 'BTC-PERP')).toEqual({
      size: -0.25,
      side: 'SHORT',
      source: 'database-cache-risk-reducing-fallback',
      entryPrice: 65000,
    });
  });

  it.each([
    ['missing', null],
    ['zero', { market: 'BTC-PERP', baseSize: '0', avgEntryPrice: '65000' }],
    ['non-finite', { market: 'BTC-PERP', baseSize: 'not-a-number', avgEntryPrice: '65000' }],
    ['wrong market', { market: 'ETH-PERP', baseSize: '1', avgEntryPrice: '3500' }],
  ])('never turns %s cached state into close authority', (_label, cachedPosition) => {
    expect(PositionService.getRiskReducingCachedCloseFallback(
      cachedPosition,
      'BTC-PERP',
    )).toBeNull();
  });

  it('fails closed when the targeted venue read fails', async () => {
    mocks.adapter.getStrictPositionForMarket.mockRejectedValueOnce(new Error('venue unavailable'));

    await expect(PositionService.getPositionForCloseAuthority(
      'bot-1',
      'agent-public-key',
      4,
      'BTC-PERP',
      undefined,
      adapter,
    )).rejects.toThrow('authoritative venue position read failed for BTC-PERP');
  });

  it('rejects a targeted response for the wrong market', async () => {
    mocks.adapter.getStrictPositionForMarket.mockResolvedValueOnce({
      ...openPosition,
      internalSymbol: 'ETH-PERP',
    });

    await expect(PositionService.getPositionForCloseAuthority(
      'bot-1',
      'agent-public-key',
      4,
      'BTC-PERP',
      undefined,
      adapter,
    )).rejects.toThrow('wrong market');
  });

  it('preserves existing adapter behavior when the optional capability is absent', async () => {
    const previous = mocks.adapter.getStrictPositionForMarket;
    (mocks.adapter as any).getStrictPositionForMarket = undefined;
    mocks.adapter.getPositions.mockResolvedValueOnce([openPosition]);
    try {
      await expect(PositionService.getPositionForCloseAuthority(
        'bot-1',
        'agent-public-key',
        4,
        'BTC-PERP',
        undefined,
        adapter,
      )).resolves.toMatchObject({
        size: 1,
        side: 'LONG',
        source: 'on-chain',
      });
      expect(mocks.adapter.getPositions).toHaveBeenCalledTimes(1);
    } finally {
      (mocks.adapter as any).getStrictPositionForMarket = previous;
    }
  });
});

describe('Swift close strict-read fallthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.getMarketPrice.mockResolvedValue(100);
    mocks.executeSwiftOrder.mockResolvedValue({
      success: true,
      executionMethod: 'swift',
      auctionDurationMs: 10,
    });
    installLegacyCloseResult();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cannot confirm Swift success when the initial close verification read fails', async () => {
    mocks.adapter.getPositions
      .mockRejectedValueOnce(new Error('initial verification unavailable'))
      .mockResolvedValueOnce([openPosition]);

    const result = await runSwiftClose();

    expect(mocks.adapter.getPositions).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, signature: 'legacy-close' });
    expect(result.signature).not.toBe('swift-auction-fill');
  });

  it('cannot confirm Swift success when the pre-legacy late-fill guard read fails', async () => {
    mocks.adapter.getPositions
      .mockResolvedValueOnce([openPosition])
      .mockRejectedValueOnce(new Error('late-fill guard unavailable'));

    const result = await runSwiftClose();

    expect(mocks.adapter.getPositions).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, signature: 'legacy-close' });
    expect(result.signature).not.toBe('swift-late-auction-fill');
  });
});
