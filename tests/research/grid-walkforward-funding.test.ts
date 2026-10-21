import { describe, expect, it } from 'vitest';
import { assessFunding, HOUR } from '../../scripts/research/grid-walkforward/funding-coverage.mjs';

const begin = Date.UTC(2022, 2, 1);
const end = begin + 24 * HOUR;
const day = (delay = 0) => [0, 8, 16].map(h => ({ time: begin + h * HOUR + delay, rate: 0.0001 }));

describe('observed funding settlement coverage', () => {
  it('accepts measured second offsets without altering observed events', () => {
    const rows = day(3000), original = structuredClone(rows);
    const result = assessFunding(rows, begin, end);
    expect(result.passed).toBe(true);
    expect(result.delayedSettlements).toBe(3);
    expect(result.maxSettlementDelayMs).toBe(3000);
    expect(rows).toEqual(original);
  });
  it('accepts the documented one-minute edge but rejects later events', () => {
    expect(assessFunding(day(60000), begin, end).passed).toBe(true);
    expect(assessFunding(day(60001), begin, end).passed).toBe(false);
  });
  it('does not turn an absent event into zero funding', () => {
    const result = assessFunding(day().slice(1), begin, end);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([new Date(begin).toISOString()]);
    expect(assessFunding(day().map(r => ({ ...r, rate: 0 })), begin, end).passed).toBe(true);
  });
  it('excludes adjacent month observations from the requested month', () => {
    const rows = [{ time: begin - 8 * HOUR + 3000, rate: 0.0001 }, ...day(3000), { time: end + 3000, rate: 0.0001 }];
    expect(assessFunding(rows, begin, end).rows).toBe(3);
  });
  it('rejects ambiguous duplicate settlements while deduplicating identical evidence', () => {
    expect(assessFunding([...day(), day()[0]], begin, end).passed).toBe(true);
    expect(assessFunding([...day(), { time: begin + 1000, rate: 0.0001 }], begin, end).passed).toBe(false);
    expect(assessFunding([...day(), { time: begin, rate: 0.0002 }], begin, end).passed).toBe(false);
  });
  it('requires complete observed shorter cadence and rejects uncertain changes', () => {
    const hourly = Array.from({ length: 24 }, (_, h) => ({ time: begin + h * HOUR + 3000, rate: 0.0001 }));
    expect(assessFunding(hourly, begin, end).passed).toBe(true);
    expect(assessFunding(hourly.filter((_, i) => i !== 7), begin, end).ambiguousDays).toHaveLength(1);
  });
  it('rejects nonfinite rates instead of admitting unknown payments', () => {
    expect(assessFunding(day().map(r => ({ ...r, rate: Number.NaN })), begin, end).passed).toBe(false);
  });
});
