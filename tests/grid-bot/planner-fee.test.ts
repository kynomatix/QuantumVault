import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { plannerFeeDefault, PACIFICA_FEE_SOURCE } from '../../shared/planner-fee';
import { plannerFeePercent, plannerFeeLabel, readPlannerFee } from '../../client/src/lib/planner-fee-view';
import { feePercentToRate, plannerStatus, plannerVenueChecks } from '../../client/src/lib/grid-planner-view';
import { GridPlannerSheet } from '../../client/src/components/grid-planner/GridPlannerSheet';
import { previewGrid } from '../../server/grid-planner/preview';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import type { PlannerPreview, PlannerQuery } from '../../server/grid-planner/types';
import { readPlannerAccountFee } from '../../server/grid-planner/account-fee';

vi.mock('../../client/src/components/ui/dialog', () => {
  const container = ({ children }: { children: ReactNode }) => createElement('div', null, children);
  return { Dialog: container, DialogContent: container, DialogHeader: container, DialogTitle: container,
    DialogDescription: container, DialogFooter: container };
});
vi.mock('../../client/src/components/ui/settings-panel', () => ({
  DrawerSettingsPanel: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../client/src/components/grid-planner/GridPlannerChart', () => ({ GridPlannerChart: () => null }));

const now = 1_800_000_000_000;
const market = marketSnapshot({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin',
  maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10',
    max_leverage: '50', max_order_size: '5000000', min_tick: '0', max_tick: '1000000',
    isolated_only: false, instrument_type: 'perpetual', execution_modes: ['orderbook'] }, 'BTC-PERP', now),
} as ProtocolMarket, { now: () => now, getMarkets: async () => [], cachedReference: () => ({ price: 100, observedAt: now }), candles: async () => [] });
const query: PlannerQuery = { market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: 4,
  entryScale: 'flat', profitScale: 'flat', seed: true, investment: '1000', leverage: '1', stop: '70', fee: '0.00015' };
const preview = () => previewGrid(query, market, now);

describe('planner maker fee defaults', () => {
  it.each([['0.00012', '0.012'], ['0', '0']])('prefills the account rate %s as percent %s and retains the tier', (rate, percent) => {
    const fee = readPlannerFee({ fee: plannerFeeDefault({ makerFeeRate: rate, feeTier: '2', exists: true }) });
    expect(plannerFeePercent(fee)).toBe(percent);
    expect(feePercentToRate(percent)).toBe(rate);
    expect(plannerFeeLabel(fee)).toBe('Your Pacifica maker fee (tier 2)');
  });
  it.each([null, { makerFeeRate: 'EXAMPLE' }, { makerFeeRate: '0.00001', exists: false }, { makerFeeRate: '-0.1' }])(
    'uses the sourced published base fee when account data is unavailable: %j', account => {
      const fee = plannerFeeDefault(account);
      expect(fee).toEqual({ rate: '0.00015', source: 'published', tier: '1' });
      expect(plannerFeePercent(fee)).toBe('0.015');
      expect(plannerFeeLabel(fee)).toBe('Pacifica published base maker fee (tier 1)');
      expect(PACIFICA_FEE_SOURCE).toBe('https://docs.pacifica.fi/trading-on-pacifica/trading-fees');
    });
  it('leaves the input empty when neither source is usable, including an explicit unknown response', () => {
    const fee = plannerFeeDefault(null, null);
    expect(fee).toBeNull(); expect(readPlannerFee({ fee: null })).toBeNull();
    expect(plannerFeePercent(fee)).toBe('');
    expect(plannerFeeLabel(fee)).toBe('Fee unknown — enter your maker fee to check fees');
  });
  it('permits the user to replace the default without changing percentage conversion', () => {
    expect(feePercentToRate('0.02')).toBe('0.0002');
    expect(plannerFeeLabel(plannerFeeDefault({ makerFeeRate: '0', feeTier: undefined }))).toBe('Your Pacifica maker fee');
    expect(readPlannerFee({})).toEqual(plannerFeeDefault(null));
  });
  it('reads only the authenticated owner’s account and converts its fee for prefill', async () => {
    const wallet = vi.fn(async () => ({ agentPublicKey: 'EXAMPLE' }));
    const account = vi.fn(async () => ({ makerFeeRate: '0.00009', feeTier: '3', exists: true,
      equity: 0, balance: 0, unrealizedPnl: 0, availableMargin: 0, maintenanceMargin: 0 }));
    const fee = await readPlannerAccountFee('EXAMPLE owner', wallet, account);
    expect(wallet).toHaveBeenCalledExactlyOnceWith('EXAMPLE owner');
    expect(account).toHaveBeenCalledExactlyOnceWith('EXAMPLE');
    expect(plannerFeePercent(fee)).toBe('0.009');
    expect(plannerFeeLabel(fee)).toBe('Your Pacifica maker fee (tier 3)');
  });
  it('falls back on an account read failure and never reads an absent wallet’s account', async () => {
    const account = vi.fn(async () => { throw Error('EXAMPLE'); });
    expect(await readPlannerAccountFee('EXAMPLE', async () => null, account)).toEqual(plannerFeeDefault(null));
    expect(account).not.toHaveBeenCalled();
    expect(await readPlannerAccountFee('EXAMPLE', async () => ({ agentPublicKey: 'EXAMPLE' }), account)).toEqual(plannerFeeDefault(null));
    expect(account).toHaveBeenCalledTimes(1);
  });
});

describe('plain planner status with unchanged server checks', () => {
  it('names the scope of checks that passed', () => {
    expect(preview().state).toBe('hypothetical_checks_passed');
    expect(plannerStatus(preview())).toBe('Plan ready — price, size, maker fee and market checks passed');
  });
  it('keeps unknown fees unpassed and requests a fee', () => {
    const result = previewGrid({ ...query, fee: null }, market, now);
    expect(result.state).toBe('diagnostic');
    expect(plannerStatus(result)).toBe('Plan ready — fees not checked (enter your maker fee)');
  });
  it.each([['maxLeverage', 'leverage limit'], ['maximumQuote', 'maximum order value'],
    ['priceBounds', 'accepted price range'], ['restrictions', 'market requirements']] as const)(
    'names an unavailable %s without passing it', (key, label) => {
      if (market.constraints.state !== 'available') throw Error('EXAMPLE');
      const missing = { ...market, constraints: { state: 'available' as const, value: { ...market.constraints.value,
        [key]: { state: 'unavailable' as const, reason: 'EXAMPLE' } } } };
      const result = previewGrid(query, missing, now);
      expect(result.state).toBe('diagnostic');
      expect(plannerStatus(result)).toBe(`Plan ready — Pacifica’s ${label} couldn’t be loaded; refresh market data`);
      if (key !== 'maxLeverage') expect(plannerVenueChecks(missing).some(row => row.value === 'Not checked — refresh market data')).toBe(true);
    });
  it('lists all missing checks together', () => {
    const result = previewGrid({ ...query, fee: null }, market, now);
    if (result.market.constraints.state !== 'available') throw Error('EXAMPLE');
    result.market = { ...result.market, constraints: { state: 'available', value: { ...result.market.constraints.value,
      maxLeverage: { state: 'unavailable', reason: 'EXAMPLE' } } } };
    expect(plannerStatus(result)).toContain('fees not checked (enter your maker fee); Pacifica’s leverage limit');
  });
  it.each([['rejected', 'Plan needs changes — see the checks below'], ['unavailable', 'Plan unavailable — refresh market data']] as const)(
    'explains %s', (state, message) => expect(plannerStatus({ ...preview(), state })).toBe(message));
  it('explains expiry and prices without investment', () => {
    expect(plannerStatus(preview(), true)).toBe('Preview expired — refresh market data');
    expect(plannerStatus(previewGrid({ ...query, investment: '' }, market, now)))
      .toBe('Prices ready — enter an investment to check order sizes and fees');
  });
  it('does not claim success for an unexplained incomplete verdict', () => {
    expect(plannerStatus({ ...preview(), state: 'diagnostic' } as PlannerPreview)).toContain('checks incomplete');
  });
  it('renders the open panel without diagnostic or hypothetical jargon', () => {
    const html = renderToStaticMarkup(createElement(GridPlannerSheet, { open: true, identity: 'EXAMPLE', onOpenChange: vi.fn() }));
    expect(html).toContain('Your plan');
    expect(html).toContain('Maker fee per side');
    expect(html).not.toMatch(/diagnostic|hypothetical|geometry/i);
    expect(html).toContain('Fee unknown');
  });
});
