import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';

function createAdapter(): PacificaAdapter {
  return new PacificaAdapter({
    baseUrl: 'https://api.pacifica.invalid/api/v1',
    wsUrl: 'wss://ws.pacifica.invalid/ws',
  });
}

function cleanSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    account_equity: '0',
    balance: '0',
    available_to_spend: '0',
    available_to_withdraw: '0',
    total_margin_used: '0',
    pending_balance: '0',
    pending_interest: '0',
    cross_mmr: '0',
    spot_collateral: '0',
    fee_level: 0,
    maker_fee: '0',
    taker_fee: '0',
    positions_count: 0,
    orders_count: 0,
    stop_orders_count: 0,
    ...overrides,
  };
}

function identity() {
  const keypair = Keypair.generate();
  return {
    agentPublicKey: keypair.publicKey.toBase58(),
    agentSecretKey: keypair.secretKey,
  };
}

describe('Pacifica Reset Agent Wallet strict venue assessment', () => {
  it('reads main plus every authenticated child and accepts only complete clean snapshots', async () => {
    const a = createAdapter() as any;
    const input = identity();
    a.listSubaccountsWithKey = vi.fn(async () => [
      { subaccountId: 'child-1', equity: 0, status: 'confirmed' },
    ]);
    a.getFreshResetAccountSnapshot = vi.fn(async () => cleanSnapshot());

    await expect(a.assessAgentWalletResetStateStrict(input)).resolves.toEqual({
      hasOpenPositions: false,
      hasExchangeFunds: false,
    });
    expect(a.getFreshResetAccountSnapshot).toHaveBeenNthCalledWith(1, { account: input.agentPublicKey });
    expect(a.getFreshResetAccountSnapshot).toHaveBeenNthCalledWith(2, {
      account: input.agentPublicKey,
      subaccount_id: 'child-1',
    });
  });

  it.each([
    ['position', { positions_count: 1 }],
    ['resting order', { orders_count: 1 }],
    ['stop order', { stop_orders_count: 1 }],
    ['margin', { total_margin_used: '1' }],
  ])('blocks %s state', async (_label, snapshot) => {
    const a = createAdapter() as any;
    const input = identity();
    a.listSubaccountsWithKey = vi.fn(async () => []);
    a.getFreshResetAccountSnapshot = vi.fn(async () => cleanSnapshot(snapshot));
    await expect(a.assessAgentWalletResetStateStrict(input)).resolves.toEqual({
      hasOpenPositions: true,
      hasExchangeFunds: false,
    });
  });

  it.each(['balance', 'account_equity', 'spot_collateral', 'pending_balance', 'pending_interest'])
    ('blocks positive or negative custody in %s', async (field) => {
      for (const value of ['1', '-1']) {
        const a = createAdapter() as any;
        const input = identity();
        a.listSubaccountsWithKey = vi.fn(async () => []);
        a.getFreshResetAccountSnapshot = vi.fn(async () => cleanSnapshot({ [field]: value }));
        await expect(a.assessAgentWalletResetStateStrict(input)).resolves.toEqual({
          hasOpenPositions: false,
          hasExchangeFunds: true,
        });
      }
    });

  it('allows an absent main account but rejects a listed child that disappears', async () => {
    const a = createAdapter() as any;
    const input = identity();
    a.listSubaccountsWithKey = vi.fn(async () => []);
    a.getFreshResetAccountSnapshot = vi.fn(async () => null);
    await expect(a.assessAgentWalletResetStateStrict(input)).resolves.toEqual({
      hasOpenPositions: false,
      hasExchangeFunds: false,
    });

    a.listSubaccountsWithKey = vi.fn(async () => [
      { subaccountId: 'child-1', equity: 0, status: 'confirmed' },
    ]);
    a.getFreshResetAccountSnapshot = vi.fn(async (params: Record<string, string>) =>
      params.subaccount_id ? null : cleanSnapshot(),
    );
    await expect(a.assessAgentWalletResetStateStrict(input)).rejects.toThrow();
  });

  it('throws on transport, malformed fields, duplicate children, or signer mismatch', async () => {
    const input = identity();
    const transport = createAdapter() as any;
    transport.listSubaccountsWithKey = vi.fn(async () => { throw new Error('upstream'); });
    await expect(transport.assessAgentWalletResetStateStrict(input)).rejects.toThrow('upstream');

    const malformed = createAdapter() as any;
    malformed.listSubaccountsWithKey = vi.fn(async () => []);
    malformed.getFreshResetAccountSnapshot = vi.fn(async () => cleanSnapshot({ balance: 'NaN' }));
    await expect(malformed.assessAgentWalletResetStateStrict(input)).rejects.toThrow();

    const duplicate = createAdapter() as any;
    duplicate.listSubaccountsWithKey = vi.fn(async () => [
      { subaccountId: 'same', equity: 0, status: 'confirmed' },
      { subaccountId: 'same', equity: 0, status: 'confirmed' },
    ]);
    await expect(duplicate.assessAgentWalletResetStateStrict(input)).rejects.toThrow();

    const wrongKey = createAdapter();
    await expect(wrongKey.assessAgentWalletResetStateStrict({
      agentPublicKey: identity().agentPublicKey,
      agentSecretKey: input.agentSecretKey,
    })).rejects.toThrow();
  });

  it('makes authenticated inventory shape failures observable', async () => {
    const input = identity();
    const missingArray = createAdapter() as any;
    missingArray.post = vi.fn(async () => ({}));
    await expect(missingArray.listSubaccountsWithKey(input.agentSecretKey)).rejects.toThrow();

    const malformedChild = createAdapter() as any;
    malformedChild.post = vi.fn(async () => ({ subaccounts: [{ address: '', balance: '0' }] }));
    await expect(malformedChild.listSubaccountsWithKey(input.agentSecretKey)).rejects.toThrow();

    const malformedBalance = createAdapter() as any;
    malformedBalance.post = vi.fn(async () => ({ subaccounts: [{ address: 'child', balance: 'nope' }] }));
    await expect(malformedBalance.listSubaccountsWithKey(input.agentSecretKey)).rejects.toThrow();
  });
});
