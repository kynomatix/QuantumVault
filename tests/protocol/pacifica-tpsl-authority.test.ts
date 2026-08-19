import { describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import type { TpSlParams } from '../../server/protocol/protocol-types.js';

const ACCOUNT = 'PositionAuthorityAccount11111111111111111111111';
const SECRET = new Uint8Array(64);

function position(baseSize: number, internalSymbol = 'SOL-PERP') {
  return {
    internalSymbol,
    baseSize,
    entryPrice: 100,
    markPrice: 100,
    unrealizedPnl: 0,
    leverage: 1,
    liquidationPrice: null,
    marginMode: 'cross' as const,
  };
}

function createAdapter(): any {
  const adapter = new PacificaAdapter({
    baseUrl: 'https://api.pacifica.fi/api/v1',
    wsUrl: 'wss://ws.pacifica.fi/ws',
  }) as any;
  adapter.getRegistry = () => ({
    internalToProtocol: (symbol: string) => {
      if (symbol !== 'SOL-PERP') throw new Error(`unexpected symbol ${symbol}`);
      return 'SOL';
    },
  });
  adapter.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
  adapter.getPrice = vi.fn(async () => 100);
  adapter.quantizePrice = vi.fn((_symbol: string, price: number) => price);
  adapter.mapOrderResponse = vi.fn(() => ({ success: true, orderId: 'tpsl-1', status: 'open' }));
  adapter.post = vi.fn(async () => ({ order_id: 'tpsl-1', status: 'open' }));
  return adapter;
}

function request(
  takeProfitPrice = 110,
  stopLossPrice = 90,
  overrides: Partial<TpSlParams> = {},
): TpSlParams {
  return {
    agentPublicKey: ACCOUNT,
    agentSecretKey: SECRET,
    internalSymbol: 'SOL-PERP',
    takeProfitPrice,
    stopLossPrice,
    ...overrides,
  };
}

async function expectPositionSideFailure(readPositions: () => Promise<any[]>) {
  const adapter = createAdapter();
  adapter.getPositions = vi.fn(readPositions);
  const build = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody');

  try {
    const result = await adapter.setTpSl(request());

    expect(result).toMatchObject({
      success: false,
      status: 'rejected',
      error: 'position_side_unavailable',
      appliedTakeProfitPrice: null,
      appliedStopLossPrice: null,
    });
    expect(adapter.ensurePacificaEnrollment).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(adapter.post).not.toHaveBeenCalled();
    expect(adapter.getPrice).not.toHaveBeenCalled();
  } finally {
    build.mockRestore();
  }
}

describe('PacificaAdapter.setTpSl position-side authority', () => {
  it('fails closed when the position read rejects', async () => {
    await expectPositionSideFailure(async () => {
      throw new Error('provider payload must not escape');
    });
  });

  it.each([
    ['empty inventory', []],
    ['missing symbol', [position(1, 'ETH-PERP')]],
    ['zero size', [position(0)]],
    ['NaN size', [position(Number.NaN)]],
    ['infinite size', [position(Number.POSITIVE_INFINITY)]],
    ['ambiguous duplicate', [position(1), position(-1)]],
  ])('fails closed for %s', async (_label, positions) => {
    await expectPositionSideFailure(async () => positions);
  });

  it.each([
    ['long', 1, 110, 90, 'ask'],
    ['short', -1, 90, 110, 'bid'],
  ])('uses the verified %s position to construct the correct closing bracket', async (
    _label,
    baseSize,
    takeProfitPrice,
    stopLossPrice,
    expectedClosingSide,
  ) => {
    const adapter = createAdapter();
    adapter.getPositions = vi.fn(async () => [position(baseSize)]);
    let operationData: Record<string, unknown> | undefined;
    const build = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => {
        operationData = data;
        return {
          ...data,
          account: ACCOUNT,
          signature: 'test-signature',
          timestamp: 0,
          expiry_window: 5000,
        } as any;
      },
    );

    try {
      const result = await adapter.setTpSl(request(takeProfitPrice, stopLossPrice));

      expect(result.success).toBe(true);
      expect(operationData?.side).toBe(expectedClosingSide);
      expect(adapter.post).toHaveBeenCalledWith('/positions/tpsl', expect.any(Object));
      expect(adapter.getPositions.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.ensurePacificaEnrollment.mock.invocationCallOrder[0],
      );
    } finally {
      build.mockRestore();
    }
  });
});

describe('PacificaAdapter.setTpSl builder policy precedence', () => {
  async function captureBuilderCode(input: {
    builderAttachment?: TpSlParams['builderAttachment'];
    builderApproved: boolean;
  }): Promise<unknown> {
    const adapter = createAdapter();
    adapter.config.builderCode = 'QuantumVault';
    adapter.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: input.builderApproved }));
    adapter.getPositions = vi.fn(async () => [position(1)]);
    let operationData: Record<string, unknown> | undefined;
    const build = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => {
        operationData = data;
        return {
          ...data,
          account: ACCOUNT,
          signature: 'test-signature',
          timestamp: 0,
          expiry_window: 5000,
        } as any;
      },
    );

    try {
      await adapter.setTpSl(request(110, 90, {
        builderAttachment: input.builderAttachment,
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
      builderAttachment: { mode: 'suppress' },
      builderApproved: true,
    })).resolves.toBeUndefined();
  });

  it('absent policy preserves legacy enrollment behavior', async () => {
    await expect(captureBuilderCode({ builderApproved: true })).resolves.toBe('QuantumVault');
  });
});
