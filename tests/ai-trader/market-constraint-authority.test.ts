import { describe, expect, it , vi, afterEach} from 'vitest';
import { evaluateOpeningMinimum, observePacificaConstraints, checkEntryConstraints }
  from '../../server/protocol/market-constraints.js';

describe('AI Trader risk-budgeted entry authority', () => {
  it('rejects a small risk-budgeted entry without increasing its size', () => {
    const intendedSize = 0.05;
    const admission = evaluateOpeningMinimum({
      kind: 'market', quantityBase: intendedSize, mark: 100,
    }, 10);
    expect(admission).toMatchObject({ ok: false, code: 'below_opening_minimum', floorUsd: 10 });
    expect(intendedSize).toBe(0.05);
  });

  it('rejects entry after failed refresh even when cached values remain present', () => {
    const observation = observePacificaConstraints({ tick_size: '0.1', lot_size: '0.001',
      min_order_size: '10' }, 'SOL-PERP', 1_000);
    observation.refreshFailed = true;
    expect(checkEntryConstraints(observation, 'SOL-PERP', 1_001))
      .toMatchObject({ ok: false, code: 'constraint_unavailable' });
  });
});


// Install before module evaluation; restored spies return to a denying transport.
const deniedHttp = vi.hoisted(() => {
  const attempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(String(input));
    throw new Error('Unmocked HTTP denied by test network boundary');
  }) as typeof fetch;
  return attempts;
});
afterEach(() => {
  const unexpected = deniedHttp.splice(0);
  expect(unexpected, 'Every HTTP read must be explicitly mocked').toEqual([]);
});
