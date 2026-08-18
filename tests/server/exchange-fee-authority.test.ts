import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  placeMarketOrderWithFeeAuthority,
  type ProtocolAdapter,
} from '../../server/protocol/adapter';
import type { MarketOrderParams, OrderResult } from '../../server/protocol/protocol-types';

const now = Date.now();

function marketOrder(overrides: Partial<MarketOrderParams> = {}): MarketOrderParams {
  return {
    agentPublicKey: 'signal-bot-account',
    agentSecretKey: new Uint8Array(64),
    mainWalletAddress: 'owner-wallet',
    internalSymbol: 'BTC-PERP',
    side: 'long',
    sizeBase: 0.01,
    reduceOnly: false,
    subaccountId: 'signal-bot-subaccount',
    ...overrides,
  };
}

function adapterWith(
  overrides: Partial<ProtocolAdapter> = {},
): ProtocolAdapter & { placeMarketOrder: ReturnType<typeof vi.fn> } {
  const placeMarketOrder = vi.fn(async (): Promise<OrderResult> => ({
    success: true,
    status: 'filled',
    orderId: 'venue-order',
  }));
  return {
    protocolName: 'pacifica',
    placeMarketOrder,
    ...overrides,
  } as unknown as ProtocolAdapter & { placeMarketOrder: ReturnType<typeof vi.fn> };
}

describe('Signal Bot fee-rate admission authority', () => {
  it('refuses an entry before adapter send when the capability is unavailable', async () => {
    const adapter = adapterWith();

    await expect(placeMarketOrderWithFeeAuthority(adapter, marketOrder())).resolves.toEqual({
      success: false,
      status: 'rejected',
      error: 'FEE_RATE_UNAVAILABLE:capability_unavailable',
    });
    expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('uses the exact order identity for one fresh quote, then permits the entry send', async () => {
    const getFeeRateQuote = vi.fn(async () => ({
      availability: 'available' as const,
      protocol: 'pacifica',
      account: 'signal-bot-account',
      subaccountId: 'signal-bot-subaccount',
      liquidityRole: 'taker' as const,
      baseRate: 0.001,
      effectiveRate: 0.001,
      provenance: 'pacifica:/account:taker_fee',
      observedAt: now,
      builder: { status: 'absent' as const },
    }));
    const adapter = adapterWith({ getFeeRateQuote });
    const params = marketOrder();

    await expect(placeMarketOrderWithFeeAuthority(adapter, params)).resolves.toMatchObject({
      success: true,
      orderId: 'venue-order',
      admissionFeeQuote: {
        effectiveRate: 0.001,
        account: params.agentPublicKey,
        subaccountId: params.subaccountId,
      },
    });
    expect(getFeeRateQuote).toHaveBeenCalledTimes(1);
    expect(getFeeRateQuote).toHaveBeenCalledWith({
      account: params.agentPublicKey,
      subaccountId: params.subaccountId,
      liquidityRole: 'taker',
      builderCode: undefined,
    });
    expect(adapter.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.placeMarketOrder).toHaveBeenCalledWith(params);
  });

  it('bypasses the new admission read for a reduce-only close', async () => {
    const getFeeRateQuote = vi.fn(async () => {
      throw new Error('a close must never ask for admission fee authority');
    });
    const adapter = adapterWith({ getFeeRateQuote });
    const params = marketOrder({ reduceOnly: true, side: 'short' });

    await expect(placeMarketOrderWithFeeAuthority(adapter, params)).resolves.toMatchObject({
      success: true,
    });
    expect(getFeeRateQuote).not.toHaveBeenCalled();
    expect(adapter.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(adapter.placeMarketOrder).toHaveBeenCalledWith(params);
  });
});

describe('Signal Bot route choke point', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/routes.ts'), 'utf8');
  const start = source.indexOf('async function executePerpOrder(');
  const end = source.indexOf('\nasync function getPerpPositions(', start);
  const wrapper = source.slice(start, end);

  it('resolves signing identity before the fee-authorized risk-increasing send', () => {
    const signing = wrapper.indexOf('_resolveSigningContext');
    const feeGate = wrapper.indexOf('placeMarketOrderWithFeeAuthority');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(signing).toBeGreaterThanOrEqual(0);
    expect(feeGate).toBeGreaterThan(signing);
    expect(wrapper).toContain('? await adapter.placeMarketOrder(orderParams)');
    expect(wrapper).toContain(': await placeMarketOrderWithFeeAuthority(adapter, orderParams)');
  });

  it('requires explicit close-fee evidence and never restores the legacy numeric default', () => {
    expect(source).not.toContain('const DEFAULT_EXCHANGE_FEE_RATE = 0.0004;');
    expect(source).not.toContain('getExchangeFeeRate()');
    expect(source).toContain('const { fee: closeFee, pnl: closeTradePnl } = closeAccounting(');
    expect(source).toContain('fee: closeFee === null ? null : closeFee.toFixed(6)');
    expect(source).toContain('fee: pcFee === null ? null : String(pcFee)');
  });

  it('uses the admitted quote for every OPEN estimate without changing exact-fee precedence', () => {
    expect(source.match(/admissionFeeQuote!\.effectiveRate/g)).toHaveLength(8);
    expect(source).toMatch(
      /const tradeFee = orderResult\.actualFee\s+\?\? \(tradeNotional \* orderResult\.admissionFeeQuote!\.effectiveRate\);/,
    );
    expect(source).not.toContain('orderResult.actualFee ||');
    expect(source).toContain(
      'const userTradeFee = userTradeNotional * orderResult.admissionFeeQuote!.effectiveRate;',
    );
    expect(source).toContain(
      'const estimatedFee = notionalValue * result.admissionFeeQuote!.effectiveRate;',
    );
  });
});
