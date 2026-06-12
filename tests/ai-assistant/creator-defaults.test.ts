import { describe, it, expect } from 'vitest';
import { enforceStandardDefaults, STANDARD_BACKTEST_DEFAULTS } from '../../server/ai-assistant/creator.js';
import { compilePine } from '../../server/lab/pine/index.js';
import { parsePineScript } from '../../server/lab/pine-parser.js';

// Task 187 — the standard backtest defaults must be enforced by CODE on the generated
// strategy() declaration, not merely requested in the prompt. parsePineScript reads
// initial_capital / commission_value / default_qty_value out of strategy() into the
// saved strategySettings, so a deviating declaration silently mis-configures the
// backtest. These tests assert deterministic enforcement + that the enforced settings
// are what the lab parser actually reads.

const BARE = `//@version=6
strategy("Bare Strat")
fast = ta.sma(close, 10)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")
`;

const DEVIATING = `//@version=6
strategy("Deviating", overlay=true, initial_capital=99999, commission_value=2.5, default_qty_type=strategy.percent_of_equity, default_qty_value=50, slippage=7, pyramiding=3)
if ta.crossover(ta.sma(close, 5), ta.sma(close, 50))
    strategy.entry("L", strategy.long)
`;

describe('Creator — standard backtest defaults are structurally enforced', () => {
  it('injects the standard defaults when the draft omits them', () => {
    const out = enforceStandardDefaults(BARE);
    expect(out).toContain(`initial_capital=${STANDARD_BACKTEST_DEFAULTS.initialCapital}`);
    expect(out).toContain('commission_type=strategy.commission.percent');
    expect(out).toContain(`commission_value=${STANDARD_BACKTEST_DEFAULTS.commissionPercent}`);
    expect(out).toContain('default_qty_type=strategy.cash');
    expect(out).toContain(`default_qty_value=${STANDARD_BACKTEST_DEFAULTS.defaultQtyValue}`);
    expect(out).toContain(`slippage=${STANDARD_BACKTEST_DEFAULTS.slippageTicks}`);
  });

  it('the enforced script still compiles in the lab Pine engine', () => {
    const out = enforceStandardDefaults(BARE);
    expect(() => compilePine(out)).not.toThrow();
  });

  it('the lab parser reads the enforced standard settings (not the model\'s deviations)', () => {
    const out = enforceStandardDefaults(DEVIATING);
    const parsed = parsePineScript(out);
    expect(parsed.strategySettings.initialCapital).toBe(STANDARD_BACKTEST_DEFAULTS.initialCapital);
    expect(parsed.strategySettings.commission).toBe(STANDARD_BACKTEST_DEFAULTS.commissionPercent);
    expect(parsed.strategySettings.defaultQtyValue).toBe(STANDARD_BACKTEST_DEFAULTS.defaultQtyValue);
  });

  it('overrides deviating defaults while preserving title and non-default args', () => {
    const out = enforceStandardDefaults(DEVIATING);
    expect(out).not.toContain('initial_capital=99999');
    expect(out).not.toContain('default_qty_type=strategy.percent_of_equity');
    expect(out).not.toContain('slippage=7');
    // Title and unrelated settings survive.
    expect(out).toContain('"Deviating"');
    expect(out).toContain('overlay=true');
    expect(out).toContain('pyramiding=3');
    // Exactly one of each enforced key remains.
    expect((out.match(/initial_capital=/g) || []).length).toBe(1);
    expect((out.match(/slippage=/g) || []).length).toBe(1);
  });

  it('is a no-op fail-safe when there is no strategy() declaration', () => {
    const indicator = '//@version=6\nindicator("Not a strategy")\nplot(close)\n';
    expect(enforceStandardDefaults(indicator)).toBe(indicator);
  });
});
