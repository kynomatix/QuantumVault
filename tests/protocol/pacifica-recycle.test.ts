import { describe, it, expect } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PACIFICA_RECYCLE_EMPTY_USDC } from '../../server/protocol/pacifica/pacifica-constants.js';
import { shouldBlockDeleteForSweep } from '../../server/routes.js';

function createAdapter(): PacificaAdapter {
  return new PacificaAdapter({
    baseUrl: 'https://api.pacifica.fi/api/v1',
    wsUrl: 'wss://ws.pacifica.fi/ws',
  });
}

const ACCT = 'SubAccountPubkey1111111111111111111111111111';

function stubEmptyAccount(a: any) {
  a.getAccountInfo = async () => ({
    equity: 0, balance: 0, unrealizedPnl: 0, availableMargin: 0,
    maintenanceMargin: 0, subaccountId: '0', exists: true,
  });
  a.getPositions = async () => [];
  a.getOpenStopOrders = async () => [];
  a.get = async () => []; // /orders/open
}

describe('PacificaAdapter — Recycling Plan §8 (Phase D)', () => {
  describe('getOpenOrders', () => {
    it('maps order_id/symbol from the /orders/open response', async () => {
      const a = createAdapter() as any;
      a.get = async (path: string) => {
        expect(path).toBe('/orders/open');
        return [{ order_id: 'o1', symbol: 'BTC' }, { id: 'o2', symbol: 'ETH' }];
      };
      const orders = await a.getOpenOrders(ACCT);
      expect(orders).toEqual([
        { orderId: 'o1', symbol: 'BTC' },
        { orderId: 'o2', symbol: 'ETH' },
      ]);
    });

    it('treats a 404 as an empty list (no account / no orders)', async () => {
      const a = createAdapter() as any;
      a.get = async () => { throw new Error('HTTP 404 Not Found'); };
      expect(await a.getOpenOrders(ACCT)).toEqual([]);
    });

    it('returns [] when the response is not an array', async () => {
      const a = createAdapter() as any;
      a.get = async () => ({ unexpected: true });
      expect(await a.getOpenOrders(ACCT)).toEqual([]);
    });

    it('rethrows non-404 errors (fails closed)', async () => {
      const a = createAdapter() as any;
      a.get = async () => { throw new Error('HTTP 500 server error'); };
      await expect(a.getOpenOrders(ACCT)).rejects.toThrow('500');
    });
  });

  describe('verifySubaccountEmpty', () => {
    it('returns true for a fully empty account', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(true);
    });

    it('returns true for a non-existent account', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getAccountInfo = async () => ({
        equity: 0, balance: 0, unrealizedPnl: 0, availableMargin: 0,
        maintenanceMargin: 0, subaccountId: '0', exists: false,
      });
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(true);
    });

    it('returns false when equity is above the dust threshold', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getAccountInfo = async () => ({
        equity: PACIFICA_RECYCLE_EMPTY_USDC + 1, balance: PACIFICA_RECYCLE_EMPTY_USDC + 1,
        unrealizedPnl: 0, availableMargin: 0, maintenanceMargin: 0, subaccountId: '0', exists: true,
      });
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(false);
    });

    it('returns true when equity is exactly at the dust threshold', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getAccountInfo = async () => ({
        equity: PACIFICA_RECYCLE_EMPTY_USDC, balance: PACIFICA_RECYCLE_EMPTY_USDC,
        unrealizedPnl: 0, availableMargin: 0, maintenanceMargin: 0, subaccountId: '0', exists: true,
      });
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(true);
    });

    it('returns false when an open position remains', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getPositions = async () => [{ internalSymbol: 'BTC', baseSize: 0.5 }];
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(false);
    });

    it('returns false when a resting order remains', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.get = async () => [{ order_id: 'o1', symbol: 'BTC' }];
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(false);
    });

    it('returns false when a stop order remains', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getOpenStopOrders = async () => [{ order_id: 's1', symbol: 'BTC' }];
      expect(await a.verifySubaccountEmpty({ agentPublicKey: ACCT })).toBe(false);
    });

    it('propagates read errors (fails closed, never returns true blind)', async () => {
      const a = createAdapter() as any;
      stubEmptyAccount(a);
      a.getPositions = async () => { throw new Error('network down'); };
      await expect(a.verifySubaccountEmpty({ agentPublicKey: ACCT })).rejects.toThrow('network down');
    });
  });

  describe('shouldBlockDeleteForSweep — delete must never proceed over stranded funds', () => {
    // Recycling OFF: must stay byte-identical to the legacy gate
    // (block only on a real transfer failure with a non-trivial balance).
    it('OFF: blocks on transfer failure with a real balance', () => {
      expect(shouldBlockDeleteForSweep(false, { error: 'transfer failed', amount: 25 })).toBe(true);
    });

    it('OFF: does NOT block on a thrown error with amount 0 (legacy behavior preserved)', () => {
      expect(shouldBlockDeleteForSweep(false, { error: 'getAccountInfo threw', amount: 0 })).toBe(false);
    });

    it('OFF: does NOT block when there is no error', () => {
      expect(shouldBlockDeleteForSweep(false, { amount: 25 })).toBe(false);
      expect(shouldBlockDeleteForSweep(false, { amount: 0 })).toBe(false);
    });

    // Recycling ON: fail CLOSED on ANY error — every error path leaves funds intact.
    it('ON: blocks on transfer failure with a real balance', () => {
      expect(shouldBlockDeleteForSweep(true, { error: 'transfer failed', amount: 25 })).toBe(true);
    });

    it('ON: blocks on a thrown error even when amount is 0 (the fund-safety fix)', () => {
      expect(shouldBlockDeleteForSweep(true, { error: 'transferBetweenSubaccounts threw', amount: 0 })).toBe(true);
      expect(shouldBlockDeleteForSweep(true, { error: 'getAccountInfo threw', amount: 0 })).toBe(true);
    });

    it('ON: does NOT block a clean sweep (no error) so pooling can run', () => {
      expect(shouldBlockDeleteForSweep(true, { amount: 25 })).toBe(false);
      expect(shouldBlockDeleteForSweep(true, { amount: 0 })).toBe(false);
    });
  });
});
