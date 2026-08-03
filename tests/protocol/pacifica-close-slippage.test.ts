import { describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import type { ClosePositionParams, MarketOrderParams } from '../../server/protocol/protocol-types.js';

const ACCOUNT = 'CloseSlippageAccount111111111111111111111111';
const SECRET = new Uint8Array(64);

function position(baseSize: number) {
  return {
    internalSymbol: 'SOL-PERP',
    baseSize,
    entryPrice: 100,
    markPrice: 100,
    unrealizedPnl: 0,
    leverage: 1,
    liquidationPrice: null,
    marginMode: 'cross' as const,
  };
}

function request(): ClosePositionParams {
  return {
    agentPublicKey: ACCOUNT,
    agentSecretKey: SECRET,
    mainWalletAddress: 'MainWallet111111111111111111111111111111111',
    internalSymbol: 'SOL-PERP',
    subaccountId: 'subaccount-1',
    clientOrderId: 'close-order-1',
    builderCode: 'builder-1',
  };
}

function createAdapter(): PacificaAdapter {
  return new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
}

describe('PacificaAdapter.closePosition slippage propagation', () => {
  it.each([
    ['long', 2.25, 'short', 2.25, 1],
    ['short', -3.5, 'long', 3.5, undefined],
  ] as const)(
    'forwards the %s close fields unchanged, including the caller slippage value',
    async (_label, baseSize, expectedSide, expectedSize, maxSlippagePct) => {
      const adapter = createAdapter() as any;
      adapter.getPositions = vi.fn(async () => [position(baseSize)]);
      const placeMarketOrder = vi.fn(async () => ({
        success: true,
        status: 'filled',
      }));
      adapter.placeMarketOrder = placeMarketOrder;
      const params = request();
      if (maxSlippagePct !== undefined) params.maxSlippagePct = maxSlippagePct;

      await adapter.closePosition(params);

      expect(placeMarketOrder).toHaveBeenCalledTimes(1);
      expect(placeMarketOrder).toHaveBeenCalledWith({
        agentPublicKey: params.agentPublicKey,
        agentSecretKey: params.agentSecretKey,
        mainWalletAddress: params.mainWalletAddress,
        internalSymbol: params.internalSymbol,
        side: expectedSide,
        sizeBase: expectedSize,
        reduceOnly: true,
        clientOrderId: params.clientOrderId,
        subaccountId: params.subaccountId,
        builderCode: params.builderCode,
        maxSlippagePct,
      } satisfies MarketOrderParams);
    },
  );

  it('selects the existing default only inside placeMarketOrder when the caller omits slippage', async () => {
    const adapter = createAdapter() as any;
    adapter.getRegistry = () => ({ internalToProtocol: () => 'SOL' });
    adapter.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    adapter.quantizeOrderSizeCeil = vi.fn((_symbol: string, size: number) => size);
    adapter.post = vi.fn(async () => ({ order_id: 'close-1', status: 'filled' }));
    adapter.mapOrderResponse = vi.fn(() => ({ success: true, status: 'filled' }));
    let operationData: Record<string, unknown> | undefined;
    const build = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => {
        operationData = data;
        return { ...data, account: ACCOUNT, signature: 'test-signature' } as any;
      },
    );

    try {
      await adapter.placeMarketOrder({
        ...request(),
        side: 'short',
        sizeBase: 2.25,
        reduceOnly: true,
      });

      expect(operationData?.slippage_percent).toBe('0.5');
      expect(operationData?.side).toBe('ask');
      expect(operationData?.amount).toBe('2.25');
      expect(operationData?.reduce_only).toBe(true);
    } finally {
      build.mockRestore();
    }
  });
});
