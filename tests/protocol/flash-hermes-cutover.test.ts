import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlashAdapter } from '../../server/protocol/flash/flash-adapter.js';
import {
  invalidateAllCaches,
  setCachedPrice,
} from '../../server/protocol/flash/flash-cache.js';
import {
  getHermesAttemptCount,
  getHermesEgressCount,
  resetHermesCounters,
} from '../../server/pricing/hermes-config.js';

const ORIGINAL_MODE = process.env.PYTH_HERMES_MODE;

describe('FlashAdapter Hermes cutover behavior', () => {
  beforeEach(() => {
    process.env.PYTH_HERMES_MODE = 'unauthorized';
    resetHermesCounters();
    invalidateAllCaches();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
  });

  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.PYTH_HERMES_MODE;
    else process.env.PYTH_HERMES_MODE = ORIGINAL_MODE;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    invalidateAllCaches();
    resetHermesCounters();
  });

  it('retirement rejects a cold-cache price read without a Hermes attempt', async () => {
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);

    await expect(new FlashAdapter().getPrice('SOL-PERP')).rejects.toThrow(
      'Flash',
    );

    expect(getHermesAttemptCount()).toBe(0);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('retirement rejects warm and expired cached prices without Hermes attempts', async () => {
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);
    const adapter = new FlashAdapter();
    setCachedPrice('SOL-PERP', 147.25);

    await expect(adapter.getPrice('SOL-PERP')).rejects.toThrow('Flash');
    vi.advanceTimersByTime(29_999);
    await expect(adapter.getPrice('SOL-PERP')).rejects.toThrow('Flash');
    expect(getHermesAttemptCount()).toBe(0);

    vi.advanceTimersByTime(2);
    await expect(adapter.getPrice('SOL-PERP')).rejects.toThrow('Flash');
    expect(getHermesAttemptCount()).toBe(0);
    expect(getHermesEgressCount()).toBe(0);
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
