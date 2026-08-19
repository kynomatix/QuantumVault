import { describe, expect, it, vi } from 'vitest';
import {
  placeMarketOrderWithFeeAuthority,
  resolveFeeRateQuote,
  validateFeeRateQuote,
  type AvailableFeeRateQuote,
  type FeeRateQuoteExpectedIdentity,
  type ProtocolAdapter,
} from '../../server/protocol/adapter.js';
import type { MarketOrderParams, OrderResult } from '../../server/protocol/protocol-types.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';

const NOW = 1_800_000_000_000;
const EXPECTED: FeeRateQuoteExpectedIdentity = {
  protocol: 'pacifica',
  account: 'main-account',
  subaccountId: 'sub-1',
  liquidityRole: 'taker',
};

function available(overrides: Partial<AvailableFeeRateQuote> = {}): AvailableFeeRateQuote {
  return {
    availability: 'available',
    protocol: EXPECTED.protocol,
    account: EXPECTED.account,
    subaccountId: EXPECTED.subaccountId ?? null,
    liquidityRole: 'taker',
    baseRate: 0.0004,
    effectiveRate: 0.0004,
    provenance: 'pacifica:/account.taker_fee:fresh-required',
    observedAt: NOW,
    builder: { status: 'absent' },
    ...overrides,
  };
}

function accountResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_equity: '100',
    balance: '100',
    available_to_spend: '100',
    available_to_withdraw: '100',
    total_margin_used: '0',
    pending_balance: '0',
    pending_interest: '0',
    cross_mmr: '0',
    spot_collateral: '0',
    fee_level: 1,
    maker_fee: '0.0002',
    taker_fee: '0.0007',
    positions_count: 0,
    orders_count: 0,
    stop_orders_count: 0,
    subaccount_id: 'sub-1',
    ...overrides,
  };
}

function marketOrder(overrides: Partial<MarketOrderParams> = {}): MarketOrderParams {
  return {
    agentPublicKey: 'main-account',
    agentSecretKey: new Uint8Array(64),
    mainWalletAddress: 'owner-wallet',
    internalSymbol: 'BTC-PERP',
    side: 'long',
    sizeBase: 0.01,
    subaccountId: 'sub-1',
    ...overrides,
  };
}

function adapterStub(input: {
  quote?: unknown;
  quoteError?: Error;
  omitCapability?: boolean;
  orderResult?: OrderResult;
}) {
  const getFeeRateQuote = vi.fn(async () => {
    if (input.quoteError) throw input.quoteError;
    return input.quote;
  });
  const placeMarketOrder = vi.fn(async () => input.orderResult ?? ({
    success: true,
    status: 'submitted',
    orderId: 'order-1',
  } satisfies OrderResult));
  const adapter = {
    protocolName: 'pacifica',
    ...(input.omitCapability ? {} : { getFeeRateQuote }),
    placeMarketOrder,
  } as unknown as ProtocolAdapter;
  return { adapter, getFeeRateQuote, placeMarketOrder };
}

describe('shared fee-rate authority validation', () => {
  it('normalizes a valid venue quote with exact account identity', () => {
    expect(validateFeeRateQuote(available(), EXPECTED, { now: NOW })).toEqual(available());
  });

  it.each([
    ['null', null],
    ['missing availability', { ...available(), availability: undefined }],
    ['nonfinite base', available({ baseRate: Number.NaN })],
    ['negative effective rate', available({ effectiveRate: -1 })],
    ['empty provenance', available({ provenance: '' })],
    ['invalid observation time', available({ observedAt: Number.POSITIVE_INFINITY })],
  ])('fails malformed quote closed: %s', (_label, candidate) => {
    expect(validateFeeRateQuote(candidate, EXPECTED, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'malformed_quote',
    });
  });

  it.each([
    ['protocol', available({ protocol: 'drift' })],
    ['account', available({ account: 'other-account' })],
    ['subaccount', available({ subaccountId: 'sub-2' })],
  ])('fails %s identity mismatch closed', (_label, candidate) => {
    expect(validateFeeRateQuote(candidate, EXPECTED, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'identity_mismatch',
    });
  });

  it('rejects future and stale retained quotes', () => {
    expect(validateFeeRateQuote(available({ observedAt: NOW + 1 }), EXPECTED, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'future_quote',
    });
    expect(validateFeeRateQuote(available({ observedAt: NOW - 600_001 }), EXPECTED, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'stale_quote',
    });
  });

  it.each([
    ['missing builder state', { ...available(), builder: undefined }],
    ['absent builder with a hidden rate', { ...available(), builder: { status: 'absent', rate: 0.001 } }],
    ['included builder without provenance', {
      ...available({ effectiveRate: 0.0014 }),
      builder: { status: 'included', code: 'builder-1', rate: 0.001 },
    }],
    ['component sum mismatch', available({
      effectiveRate: 0.001,
      builder: { status: 'included', code: 'builder-1', rate: 0.001, provenance: 'venue-builder-rate' },
    })],
  ])('rejects ambiguous builder economics: %s', (_label, candidate) => {
    expect(validateFeeRateQuote(candidate, EXPECTED, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'ambiguous_builder',
    });
  });

  it('accepts a venue-proven actual builder component only when the exact sum matches', () => {
    const quote = available({
      effectiveRate: 0.0014,
      builder: {
        status: 'included',
        code: 'builder-1',
        rate: 0.001,
        provenance: 'venue:/account.builder_fee',
      },
    });
    expect(validateFeeRateQuote(quote, EXPECTED, { now: NOW })).toEqual(quote);
  });

  it('requires a caller-supplied builder to have the same venue-proven included component', () => {
    const expectedWithBuilder = { ...EXPECTED, builderCode: 'builder-1' };
    expect(validateFeeRateQuote(available(), expectedWithBuilder, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'ambiguous_builder',
    });
    expect(validateFeeRateQuote(available({
      effectiveRate: 0.0014,
      builder: {
        status: 'included',
        code: 'other-builder',
        rate: 0.001,
        provenance: 'venue:/account.builder_fee',
      },
    }), expectedWithBuilder, { now: NOW })).toEqual({
      availability: 'unavailable',
      reason: 'ambiguous_builder',
    });
  });

  it('turns missing capability and thrown reads into nonnumeric unavailable results', async () => {
    const missing = adapterStub({ omitCapability: true });
    await expect(resolveFeeRateQuote(missing.adapter, {
      account: EXPECTED.account,
      subaccountId: EXPECTED.subaccountId,
      liquidityRole: 'taker',
    }, { now: NOW })).resolves.toEqual({
      availability: 'unavailable',
      reason: 'capability_unavailable',
    });

    const thrown = adapterStub({ quoteError: new Error('venue unavailable') });
    await expect(resolveFeeRateQuote(thrown.adapter, {
      account: EXPECTED.account,
      subaccountId: EXPECTED.subaccountId,
      liquidityRole: 'taker',
    }, { now: NOW })).resolves.toEqual({
      availability: 'unavailable',
      reason: 'read_failed',
    });
  });
});

describe('PacificaAdapter fee-rate authority', () => {
  it('maps a fresh-required /account taker rate with exact provenance and identity', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: undefined,
    });
    const get = vi.spyOn(adapter as any, 'get').mockResolvedValue(accountResponse());
    const before = Date.now();

    const result = await adapter.getFeeRateQuote({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
    });

    expect(get).toHaveBeenCalledWith('/account', {
      account: 'main-account',
      subaccount_id: 'sub-1',
    }, {
      priority: 'critical',
      cachePolicy: 'fresh-required',
    });
    expect(result).toMatchObject({
      availability: 'available',
      protocol: 'pacifica',
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
      baseRate: 0.0007,
      effectiveRate: 0.0007,
      provenance: 'pacifica:/account.taker_fee:fresh-required',
      builder: { status: 'absent' },
    });
    expect(result.availability === 'available' && result.observedAt).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['empty maker fee', { maker_fee: '' }],
    ['negative maker fee', { maker_fee: '-0.1' }],
    ['missing taker fee', { taker_fee: undefined }],
    ['nonfinite taker fee', { taker_fee: 'Infinity' }],
  ])('returns unavailable for malformed account rate fields: %s', async (_label, malformed) => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: undefined,
    });
    vi.spyOn(adapter as any, 'get').mockResolvedValue(accountResponse(malformed));
    await expect(adapter.getFeeRateQuote({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
    })).resolves.toEqual({ availability: 'unavailable', reason: 'malformed_quote' });
  });

  it('fails identity closed when /account does not attest the requested subaccount', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: undefined,
    });
    vi.spyOn(adapter as any, 'get').mockResolvedValue(accountResponse({ subaccount_id: 'sub-2' }));
    await expect(adapter.getFeeRateQuote({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
    })).resolves.toEqual({ availability: 'unavailable', reason: 'identity_mismatch' });
  });

  it('includes the fresh actual builder rate only when overview and approval prove it', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: 'QuantumVault',
      referralAddress: 'public-builder-owner',
      builderMaxFeeRate: '0.001',
    });
    const get = vi.spyOn(adapter as any, 'get').mockImplementation(async (path: string) => {
      if (path === '/account') return accountResponse();
      if (path === '/builder/overview') return [{ builder_code: 'QuantumVault', fee_rate: '0.001' }];
      if (path === '/account/builder_codes/approvals') {
        return [{ builder_code: 'QuantumVault', max_fee_rate: '0.002' }];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await adapter.getFeeRateQuote({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
    });

    expect(get).toHaveBeenNthCalledWith(2, '/builder/overview', {
      account: 'public-builder-owner',
    }, { priority: 'critical', cachePolicy: 'fresh-required' });
    expect(get).toHaveBeenNthCalledWith(3, '/account/builder_codes/approvals', {
      account: 'main-account',
    }, { priority: 'critical', cachePolicy: 'fresh-required' });
    expect(result).toMatchObject({
      availability: 'available',
      baseRate: 0.0007,
      builder: {
        status: 'included',
        code: 'QuantumVault',
        rate: 0.001,
        provenance: 'pacifica:/builder/overview.fee_rate:fresh-required',
      },
    });
    expect(result.availability === 'available' ? result.effectiveRate : Number.NaN).toBeCloseTo(0.0017, 12);
  });

  it('accepts numeric venue decimals without treating the configured approval max as the charge', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid', builderCode: 'QuantumVault',
      referralAddress: 'public-builder-owner', builderMaxFeeRate: '9.999',
    });
    vi.spyOn(adapter as any, 'get').mockImplementation(async (path: string) => {
      if (path === '/account') return accountResponse({ maker_fee: 0.0002, taker_fee: 0.0007 });
      if (path === '/builder/overview') return [{ builder_code: 'QuantumVault', fee_rate: 0.001 }];
      return [{ builder_code: 'QuantumVault', max_fee_rate: 0.002 }];
    });
    const result = await adapter.getFeeRateQuote({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
    });
    expect(result).toMatchObject({ builder: { rate: 0.001 } });
    expect(result.availability === 'available' ? result.effectiveRate : Number.NaN).toBeCloseTo(0.0017, 12);
  });

  it.each([
    ['builder_owner_unconfigured', 'owner-missing'],
    ['overview_read_failed', 'overview-throw'],
    ['overview_malformed', 'overview-malformed'],
    ['overview_code_mismatch', 'overview-mismatch'],
    ['approval_read_failed', 'approval-throw'],
    ['approval_malformed', 'approval-malformed'],
    ['approval_missing', 'approval-missing'],
    ['approval_below_rate', 'approval-low'],
  ])('suppresses builder attribution without blocking the base quote: %s', async (reason, mode) => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: 'QuantumVault',
      referralAddress: mode === 'owner-missing' ? undefined : 'public-builder-owner',
      builderMaxFeeRate: '9.999',
    });
    vi.spyOn(adapter as any, 'get').mockImplementation(async (path: string) => {
      if (path === '/account') return accountResponse();
      if (path === '/builder/overview') {
        if (mode === 'overview-throw') throw new Error('overview unavailable');
        if (mode === 'overview-malformed') return { builder_code: 'QuantumVault', fee_rate: '0.001' };
        if (mode === 'overview-mismatch') return [{ builder_code: 'Other', fee_rate: '0.001' }];
        return [{ builder_code: 'QuantumVault', fee_rate: '0.001' }];
      }
      if (mode === 'approval-throw') throw new Error('approval unavailable');
      if (mode === 'approval-malformed') return { builder_code: 'QuantumVault', max_fee_rate: '0.002' };
      if (mode === 'approval-missing') return [];
      if (mode === 'approval-low') return [{ builder_code: 'QuantumVault', max_fee_rate: '0.0005' }];
      throw new Error(`unexpected path ${path}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await adapter.getFeeRateQuote({
        account: 'main-account', subaccountId: 'sub-1', liquidityRole: 'taker',
      });
      expect(result).toMatchObject({
        availability: 'available', baseRate: 0.0007, effectiveRate: 0.0007,
        builder: { status: 'absent' },
      });
      expect(warn).toHaveBeenCalledWith(`[PacificaBuilderSuppression] reason=${reason} count=1`);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('main-account');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('0.0007');
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds immediate suppression alerts to the first occurrence per reason in a telemetry window', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: 'QuantumVault',
    });
    vi.spyOn(adapter as any, 'get').mockResolvedValue(accountResponse());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const request = { account: 'main-account', subaccountId: 'sub-1', liquidityRole: 'taker' as const };
      await adapter.getFeeRateQuote(request);
      await adapter.getFeeRateQuote(request);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[PacificaBuilderSuppression] reason=builder_owner_unconfigured count=1',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps explicit caller builder demand fail-closed when that requested code is unprovable', async () => {
    const adapter = new PacificaAdapter({
      baseUrl: 'http://test-pacifica.invalid',
      builderCode: 'QuantumVault',
      referralAddress: 'public-builder-owner',
    });
    vi.spyOn(adapter as any, 'get').mockImplementation(async (path: string) => {
      if (path === '/account') return accountResponse();
      if (path === '/builder/overview') return [{ builder_code: 'QuantumVault', fee_rate: '0.001' }];
      return [];
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(resolveFeeRateQuote(adapter, {
        account: 'main-account', subaccountId: 'sub-1', liquidityRole: 'taker',
        builderCode: 'some-builder',
      })).resolves.toEqual({ availability: 'unavailable', reason: 'ambiguous_builder' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('market-order admission choke point', () => {
  it('preserves reduce-only behavior without requiring a fee quote', async () => {
    const stub = adapterStub({ omitCapability: true });
    const params = marketOrder({ reduceOnly: true });

    await expect(placeMarketOrderWithFeeAuthority(stub.adapter, params)).resolves.toMatchObject({
      success: true,
      status: 'submitted',
    });
    expect(stub.getFeeRateQuote).not.toHaveBeenCalled();
    expect(stub.placeMarketOrder).toHaveBeenCalledWith(params);
  });

  it('refuses a risk-increasing order before send when authority is unavailable', async () => {
    const stub = adapterStub({ omitCapability: true });
    const params = marketOrder({ reduceOnly: false });

    await expect(placeMarketOrderWithFeeAuthority(stub.adapter, params)).resolves.toEqual({
      success: false,
      status: 'rejected',
      error: 'FEE_RATE_UNAVAILABLE:capability_unavailable',
    });
    expect(stub.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('sends exactly once after a fresh valid quote', async () => {
    const quote = available({ observedAt: Date.now() });
    const stub = adapterStub({ quote });
    const params = marketOrder({ reduceOnly: false });

    await expect(placeMarketOrderWithFeeAuthority(stub.adapter, params)).resolves.toMatchObject({
      success: true,
      status: 'submitted',
      admissionFeeQuote: quote,
    });
    expect(stub.getFeeRateQuote).toHaveBeenCalledWith({
      account: 'main-account',
      subaccountId: 'sub-1',
      liquidityRole: 'taker',
      builderCode: undefined,
    });
    expect(stub.placeMarketOrder).toHaveBeenCalledOnce();
    expect(stub.placeMarketOrder).toHaveBeenCalledWith({
      ...params,
      builderAttachment: { mode: 'suppress' },
    });
  });

  it('copies an included quote into an authoritative attach policy', async () => {
    const quote = available({
      observedAt: Date.now(),
      effectiveRate: 0.0014,
      builder: { status: 'included', code: 'QuantumVault', rate: 0.001, provenance: 'venue-builder' },
    });
    const stub = adapterStub({ quote });
    const params = marketOrder({ reduceOnly: false });

    await placeMarketOrderWithFeeAuthority(stub.adapter, params);

    expect(stub.placeMarketOrder).toHaveBeenCalledWith({
      ...params,
      builderAttachment: { mode: 'attach', code: 'QuantumVault' },
    });
  });
});

describe('PacificaAdapter market-order builder policy precedence', () => {
  async function captureBuilderCode(input: {
    builderAttachment?: MarketOrderParams['builderAttachment'];
    builderCode?: string;
    builderApproved: boolean;
  }): Promise<unknown> {
    const adapter = new PacificaAdapter({ builderCode: 'QuantumVault' }) as any;
    adapter.ensurePacificaEnrollment = vi.fn(async () => ({
      builderApproved: input.builderApproved,
      referralClaimed: false,
    }));
    adapter.getRegistry = () => ({ internalToProtocol: () => 'BTC' });
    adapter.quantizeOrderSize = (_symbol: string, size: number) => size;
    adapter.mapOrderResponse = () => ({ success: true, status: 'submitted', orderId: 'order-1' });
    adapter.post = vi.fn(async () => ({ order_id: 'order-1' }));
    let operationData: Record<string, unknown> | undefined;
    const build = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => {
        operationData = data;
        return { ...data, account: 'main-account', signature: 'sig', timestamp: 0 } as any;
      },
    );
    try {
      await adapter.placeMarketOrder(marketOrder({
        subaccountId: undefined,
        builderAttachment: input.builderAttachment,
        builderCode: input.builderCode,
      }));
      return operationData?.builder_code;
    } finally {
      build.mockRestore();
    }
  }

  it('attach overrides a stale false enrollment cache', async () => {
    await expect(captureBuilderCode({
      builderAttachment: { mode: 'attach', code: 'QuantumVault' },
      builderApproved: false,
    })).resolves.toBe('QuantumVault');
  });

  it('suppress overrides explicit passthrough and true enrollment', async () => {
    await expect(captureBuilderCode({
      builderAttachment: { mode: 'suppress' }, builderCode: 'Other', builderApproved: true,
    })).resolves.toBeUndefined();
  });

  it('absent policy preserves legacy explicit and enrollment behavior', async () => {
    await expect(captureBuilderCode({ builderCode: 'Explicit', builderApproved: true })).resolves.toBe('Explicit');
    await expect(captureBuilderCode({ builderApproved: true })).resolves.toBe('QuantumVault');
  });
});
