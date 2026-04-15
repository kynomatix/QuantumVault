import { describe, it, expect } from 'vitest';
import type { ProtocolAdapter } from '../../server/protocol/adapter.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';

function getRequiredMethods(): string[] {
  return [
    'initialize',
    'shutdown',
    'healthCheck',
    'getCapabilities',
    'getMarkets',
    'getPrice',
    'getAllPrices',
    'getOrderbook',
    'getFundingRate',
    'getMaintenanceMarginWeight',
    'quantizeOrderSize',
    'quantizePrice',
    'getAccountInfo',
    'getPositions',
    'getBalances',
    'getEquityHistory',
    'getTradeHistory',
    'getBatchAccountInfo',
    'getBatchPositions',
    'placeMarketOrder',
    'placeLimitOrder',
    'cancelOrder',
    'cancelAllOrders',
    'closePosition',
    'setLeverage',
    'setMarginMode',
    'executeDeposit',
    'executeWithdraw',
    'transferBetweenSubaccounts',
    'createSubaccount',
    'listSubaccounts',
    'discoverSubaccounts',
    'settlePnl',
  ];
}

function getOptionalMethods(): string[] {
  return [
    'placeStopOrder',
    'setTpSl',
    'cancelStopOrder',
    'closeSubaccount',
    'subscribeToFills',
    'subscribeToPositionUpdates',
    'subscribeToOrderUpdates',
  ];
}

describe('PacificaAdapter contract compliance', () => {
  let adapter: ProtocolAdapter;

  function createAdapter(): ProtocolAdapter {
    return new PacificaAdapter({
      baseUrl: 'https://api.pacifica.fi/api/v1',
      wsUrl: 'wss://ws.pacifica.fi/ws',
    }) as unknown as ProtocolAdapter;
  }

  describe('interface shape', () => {
    it('implements all required ProtocolAdapter methods', () => {
      adapter = createAdapter();
      for (const method of getRequiredMethods()) {
        expect(typeof (adapter as any)[method]).toBe('function');
      }
    });

    it('optional methods are either functions or undefined', () => {
      adapter = createAdapter();
      for (const method of getOptionalMethods()) {
        const val = (adapter as any)[method];
        expect(val === undefined || typeof val === 'function').toBe(true);
      }
    });
  });

  describe('protocolName and protocolVersion', () => {
    it('has a non-empty protocolName', () => {
      adapter = createAdapter();
      expect(typeof adapter.protocolName).toBe('string');
      expect(adapter.protocolName.length).toBeGreaterThan(0);
      expect(adapter.protocolName).toBe('pacifica');
    });

    it('has a semver-like protocolVersion', () => {
      adapter = createAdapter();
      expect(typeof adapter.protocolVersion).toBe('string');
      expect(adapter.protocolVersion).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getCapabilities', () => {
    it('returns an object with all required capability flags', () => {
      adapter = createAdapter();
      const caps = adapter.getCapabilities();

      expect(typeof caps.supportsPartialFills).toBe('boolean');
      expect(typeof caps.supportsStopOrders).toBe('boolean');
      expect(typeof caps.supportsTpSl).toBe('boolean');
      expect(typeof caps.supportsBatchOrders).toBe('boolean');
      expect(typeof caps.supportsIsolatedMargin).toBe('boolean');
      expect(typeof caps.supportsWebSocket).toBe('boolean');
      expect(typeof caps.supportsSettlePnl).toBe('boolean');
      expect(typeof caps.supportsCloseSubaccount).toBe('boolean');
      expect(caps.maxSubaccounts === null || typeof caps.maxSubaccounts === 'number').toBe(true);
      expect(['on-chain', 'off-chain', 'hybrid']).toContain(caps.settlementType);
    });

    it('optional methods match capability flags', () => {
      adapter = createAdapter();
      const caps = adapter.getCapabilities();

      if (caps.supportsStopOrders) {
        expect(typeof adapter.placeStopOrder).toBe('function');
      }
      if (caps.supportsTpSl) {
        expect(typeof adapter.setTpSl).toBe('function');
      }
      if (caps.supportsCloseSubaccount) {
        expect(typeof adapter.closeSubaccount).toBe('function');
      }
    });
  });

  describe('quantization functions (require initialization)', () => {
    it('quantizeOrderSize throws before initialize', () => {
      adapter = createAdapter();
      expect(() => adapter.quantizeOrderSize('SOL-PERP', 1.0)).toThrow('not initialized');
    });

    it('quantizePrice throws before initialize', () => {
      adapter = createAdapter();
      expect(() => adapter.quantizePrice('SOL-PERP', 100.0)).toThrow('not initialized');
    });

    it('getMaintenanceMarginWeight throws before initialize', () => {
      adapter = createAdapter();
      expect(() => adapter.getMaintenanceMarginWeight('SOL-PERP')).toThrow('not initialized');
    });
  });

  describe('method return type contracts (type-level checks)', () => {
    it('initialize returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.initialize();
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });

    it('shutdown returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.shutdown();
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });

    it('healthCheck returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.healthCheck();
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });

    it('getMarkets returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.getMarkets();
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });

    it('getPrice returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.getPrice('SOL-PERP');
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });

    it('getPositions returns a Promise', () => {
      adapter = createAdapter();
      const result = adapter.getPositions('FakePublicKey123');
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    });
  });
});
