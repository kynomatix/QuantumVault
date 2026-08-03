import { describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import type { ClosePositionParams, OrderResult } from '../../server/protocol/protocol-types.js';

const ACCOUNT = 'TerminalCloseAccount1111111111111111111111111';
const SECRET = new Uint8Array(64);

function adapter(): PacificaAdapter {
  return new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
}

function request(): ClosePositionParams {
  return {
    agentPublicKey: ACCOUNT,
    agentSecretKey: SECRET,
    mainWalletAddress: 'MainWallet111111111111111111111111111111111',
    internalSymbol: 'SOL-PERP',
    clientOrderId: 'aitrader-close-decision-1',
  };
}

const position = {
  internalSymbol: 'SOL-PERP',
  baseSize: 2,
  entryPrice: 100,
  markPrice: 100,
  unrealizedPnl: 0,
  leverage: 1,
  liquidationPrice: null,
  marginMode: 'cross' as const,
};

describe('PacificaAdapter terminal close truth', () => {
  it('returns an uncertain result for one flat read and sends no close order', async () => {
    const subject = adapter() as any;
    subject.getPositions = vi.fn(async () => []);
    subject.placeMarketOrder = vi.fn();

    const result = await subject.closePosition(request());

    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      fillSize: 0,
      clientOrderId: 'aitrader-close-decision-1',
      error: 'close_position_flat_unconfirmed',
    });
    expect(subject.placeMarketOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['submitted', true, false],
    ['acknowledged', true, false],
    ['partial_fill', true, false],
    ['unknown', true, false],
    ['canceled', true, false],
    ['expired', true, false],
    ['rejected', false, false],
    ['filled', true, true],
  ] as const)('preserves %s while allowing close success only for a full fill', async (status, transportSuccess, terminalSuccess) => {
    const subject = adapter() as any;
    subject.getPositions = vi.fn(async () => [position]);
    subject.placeMarketOrder = vi.fn(async () => ({
      success: transportSuccess,
      status,
      fillPrice: status === 'filled' ? 99 : undefined,
      error: status === 'rejected' ? 'venue rejected' : undefined,
    } satisfies OrderResult));

    const result = await subject.closePosition(request());

    expect(result.status).toBe(status);
    expect(result.success).toBe(terminalSuccess);
    if (!terminalSuccess) expect(result.error).toBeTruthy();
  });

  it('preserves an unrecognized raw venue status as unknown', () => {
    const subject = adapter() as any;
    const result = subject.mapOrderResponse({ order_id: 'o-1', status: 'venue_future_state' });
    expect(result).toMatchObject({ success: true, status: 'unknown', orderId: 'o-1' });
  });
});
