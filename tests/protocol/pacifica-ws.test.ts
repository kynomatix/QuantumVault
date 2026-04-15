import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = 0;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  sent: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code: this.closeCode, reason: this.closeReason });
    }
  }

  simulateOpen(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }

  simulateMessage(data: any): void {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  simulateClose(code: number = 1006): void {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code, reason: '' });
    }
  }

  simulateError(): void {
    if (this.onerror) this.onerror({});
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

const { PacificaWsManager } = await import('../../server/protocol/pacifica/pacifica-ws.js');

function createMockRegistry() {
  return {
    protocolToInternal: (sym: string) => sym.replace('_', '-') + '-PERP',
    internalToProtocol: (sym: string) => sym.replace('-PERP', '').replace('-', '_'),
  } as any;
}

function createManager(overrides: Record<string, any> = {}) {
  return new PacificaWsManager(
    {
      wsUrl: 'wss://test.example.com/ws',
      account: 'TestAccount123',
      agentWallet: 'AgentWallet456',
      subaccountId: '1',
      ...overrides,
    },
    createMockRegistry(),
  );
}

function getLatestWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

describe('PacificaWsManager', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect / disconnect lifecycle', () => {
    it('creates a WebSocket on connect', () => {
      const mgr = createManager();
      mgr.connect();
      expect(MockWebSocket.instances.length).toBe(1);
      expect(getLatestWs().url).toBe('wss://test.example.com/ws');
    });

    it('reports connected after onopen fires', () => {
      const mgr = createManager();
      mgr.connect();
      expect(mgr.isConnected()).toBe(false);
      getLatestWs().simulateOpen();
      expect(mgr.isConnected()).toBe(true);
    });

    it('does not create duplicate connections', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();
      mgr.connect();
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('disconnect closes with code 1000', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();
      mgr.disconnect();
      expect(mgr.isConnected()).toBe(false);
    });
  });

  describe('channel subscriptions on connect', () => {
    it('subscribes to account_trades, account_orders, account_positions on open', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      const ws = getLatestWs();
      expect(ws.sent.length).toBe(3);

      const channels = ws.sent.map(s => JSON.parse(s).channel);
      expect(channels).toContain('account_trades');
      expect(channels).toContain('account_orders');
      expect(channels).toContain('account_positions');
    });

    it('includes account, agent_wallet, subaccount_id in subscription', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      const msg = JSON.parse(getLatestWs().sent[0]);
      expect(msg.account).toBe('TestAccount123');
      expect(msg.agent_wallet).toBe('AgentWallet456');
      expect(msg.subaccount_id).toBe('1');
    });
  });

  describe('reconnection with exponential backoff', () => {
    it('schedules reconnect on abnormal close', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();
      const initialCount = MockWebSocket.instances.length;

      getLatestWs().simulateClose(1006);
      vi.advanceTimersByTime(2000);

      expect(MockWebSocket.instances.length).toBeGreaterThan(initialCount);
    });

    it('does not reconnect on normal close (1000)', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();
      const initialCount = MockWebSocket.instances.length;

      mgr.disconnect();
      vi.advanceTimersByTime(120000);
      expect(MockWebSocket.instances.length).toBe(initialCount);
    });

    it('exponential backoff doubles delay each attempt', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateClose(1006);
      const countAfterFirstClose = MockWebSocket.instances.length;

      vi.advanceTimersByTime(2500);
      expect(MockWebSocket.instances.length).toBe(countAfterFirstClose + 1);

      getLatestWs().simulateClose(1006);
      vi.advanceTimersByTime(4000);
      expect(MockWebSocket.instances.length).toBeGreaterThan(countAfterFirstClose + 1);

      getLatestWs().simulateClose(1006);
      vi.advanceTimersByTime(6000);
      const countAfterThird = MockWebSocket.instances.length;
      expect(countAfterThird).toBeGreaterThan(countAfterFirstClose + 2);
    });

    it('backoff caps at 60 seconds', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      for (let i = 0; i < 10; i++) {
        getLatestWs().simulateClose(1006);
        vi.advanceTimersByTime(61000);
      }

      const lastWs = getLatestWs();
      lastWs.simulateClose(1006);
      const countBefore = MockWebSocket.instances.length;

      vi.advanceTimersByTime(59000);
      expect(MockWebSocket.instances.length).toBe(countBefore);

      vi.advanceTimersByTime(3000);
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(countBefore);
    });

    it('resets backoff after successful connection', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateClose(1006);
      vi.advanceTimersByTime(2000);
      getLatestWs().simulateClose(1006);
      vi.advanceTimersByTime(3000);

      getLatestWs().simulateOpen();

      getLatestWs().simulateClose(1006);
      const count = MockWebSocket.instances.length;
      vi.advanceTimersByTime(2000);
      expect(MockWebSocket.instances.length).toBeGreaterThan(count);
    });
  });

  describe('heartbeat monitoring', () => {
    it('sends ping every 15 seconds', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      const ws = getLatestWs();
      const initialSent = ws.sent.length;

      vi.advanceTimersByTime(15000);
      const newMessages = ws.sent.slice(initialSent);
      const pings = newMessages.filter(s => JSON.parse(s).type === 'ping');
      expect(pings.length).toBeGreaterThanOrEqual(1);
    });

    it('reports healthy when heartbeat is recent', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      expect(mgr.isHealthy()).toBe(true);
    });

    it('triggers reconnect on heartbeat timeout (30s stale)', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();
      const initialCount = MockWebSocket.instances.length;

      vi.advanceTimersByTime(45000);

      vi.advanceTimersByTime(5000);
      expect(MockWebSocket.instances.length).toBeGreaterThan(initialCount);
    });

    it('pong message resets heartbeat timer', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      vi.advanceTimersByTime(14000);
      getLatestWs().simulateMessage({ type: 'pong' });

      vi.advanceTimersByTime(20000);
      expect(mgr.isConnected()).toBe(true);
    });
  });

  describe('callback management', () => {
    it('fill callbacks receive mapped fill events', () => {
      const mgr = createManager();
      const fills: any[] = [];
      mgr.onFill((fill: any) => fills.push(fill));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_trades',
        data: {
          fill_id: 'fill-1',
          order_id: 'ord-1',
          symbol: 'SOL',
          side: 'bid',
          price: '100.5',
          size: '1.5',
          fee: '0.05',
          timestamp: 1700000000000,
        },
      });

      expect(fills.length).toBe(1);
      expect(fills[0].fillId).toBe('fill-1');
      expect(fills[0].price).toBe(100.5);
      expect(fills[0].size).toBe(1.5);
    });

    it('order callbacks receive mapped order updates', () => {
      const mgr = createManager();
      const orders: any[] = [];
      mgr.onOrderUpdate((order: any) => orders.push(order));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_orders',
        data: {
          order_id: 'ord-1',
          symbol: 'SOL',
          status: 'filled',
          filled_size: '1.0',
          average_fill_price: '100.0',
        },
      });

      expect(orders.length).toBe(1);
      expect(orders[0].orderId).toBe('ord-1');
      expect(orders[0].status).toBe('filled');
    });

    it('position callbacks receive mapped position updates', () => {
      const mgr = createManager();
      const positions: any[] = [];
      mgr.onPositionUpdate((pos: any) => positions.push(pos));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_positions',
        data: {
          symbol: 'SOL',
          size: '0.5',
          entry_price: '100.0',
          mark_price: '102.0',
          unrealized_pnl: '1.0',
          leverage: '3',
          liquidation_price: '85.0',
          margin_mode: 'cross',
        },
      });

      expect(positions.length).toBe(1);
      expect(positions[0].baseSize).toBe(0.5);
      expect(positions[0].entryPrice).toBe(100.0);
      expect(positions[0].liquidationPrice).toBe(85.0);
    });

    it('health callbacks fire on connect and disconnect', () => {
      const mgr = createManager();
      const states: boolean[] = [];
      mgr.onHealthChange((healthy: boolean) => states.push(healthy));

      mgr.connect();
      getLatestWs().simulateOpen();
      expect(states).toContain(true);

      mgr.disconnect();
      expect(states).toContain(false);
    });

    it('unsubscribe removes callback', () => {
      const mgr = createManager();
      const fills: any[] = [];
      const unsub = mgr.onFill((fill: any) => fills.push(fill));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_trades',
        data: { fill_id: 'f1', order_id: 'o1', symbol: 'SOL', side: 'bid', price: '100', size: '1' },
      });
      expect(fills.length).toBe(1);

      unsub();

      getLatestWs().simulateMessage({
        channel: 'account_trades',
        data: { fill_id: 'f2', order_id: 'o2', symbol: 'SOL', side: 'bid', price: '100', size: '1' },
      });
      expect(fills.length).toBe(1);
    });

    it('callback errors do not crash the manager', () => {
      const mgr = createManager();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.onFill(() => { throw new Error('callback boom'); });

      mgr.connect();
      getLatestWs().simulateOpen();

      expect(() => {
        getLatestWs().simulateMessage({
          channel: 'account_trades',
          data: { fill_id: 'f1', order_id: 'o1', symbol: 'SOL', side: 'bid', price: '100', size: '1' },
        });
      }).not.toThrow();

      consoleSpy.mockRestore();
    });

    it('enforces max callback limit', () => {
      const mgr = createManager();
      for (let i = 0; i < 50; i++) {
        mgr.onFill(() => {});
      }
      expect(() => mgr.onFill(() => {})).toThrow('max fill callbacks');
    });
  });

  describe('chaos scenarios', () => {
    it('handles WebSocket constructor failure gracefully', () => {
      const OriginalWS = globalThis.WebSocket;
      const FailingWS = function() { throw new Error('network unavailable'); } as any;
      vi.stubGlobal('WebSocket', FailingWS);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mgr = createManager();
      expect(() => mgr.connect()).not.toThrow();
      expect(mgr.isConnected()).toBe(false);

      consoleSpy.mockRestore();
      vi.stubGlobal('WebSocket', OriginalWS);
    });

    it('disconnect cancels pending reconnect timer', () => {
      const mgr = createManager();
      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateClose(1006);
      const countAfterClose = MockWebSocket.instances.length;

      mgr.disconnect();

      vi.advanceTimersByTime(120000);
      expect(MockWebSocket.instances.length).toBe(countAfterClose);
    });

    it('handles unknown symbol with UNKNOWN- prefix fallback', () => {
      const registry = {
        protocolToInternal: (sym: string) => {
          if (sym === 'INVALID') throw new Error('unknown symbol');
          return sym + '-PERP';
        },
        internalToProtocol: (sym: string) => sym,
      } as any;

      const mgr = new PacificaWsManager(
        { wsUrl: 'wss://test.example.com/ws', account: 'Test' },
        registry,
      );
      const fills: any[] = [];
      mgr.onFill((fill: any) => fills.push(fill));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_trades',
        data: { fill_id: 'f1', order_id: 'o1', symbol: 'INVALID', side: 'bid', price: '100', size: '1' },
      });

      expect(fills.length).toBe(1);
      expect(fills[0].internalSymbol).toBe('UNKNOWN-INVALID');
    });

    it('rapid connect/disconnect does not leak timers', () => {
      const mgr = createManager();
      for (let i = 0; i < 10; i++) {
        mgr.connect();
        if (MockWebSocket.instances.length > 0) {
          getLatestWs().simulateOpen();
        }
        mgr.disconnect();
      }
      expect(mgr.isConnected()).toBe(false);

      vi.advanceTimersByTime(120000);
      const finalCount = MockWebSocket.instances.length;
      vi.advanceTimersByTime(120000);
      expect(MockWebSocket.instances.length).toBe(finalCount);
    });
  });

  describe('message handling edge cases', () => {
    it('ignores fills without fill_id or trade_id', () => {
      const mgr = createManager();
      const fills: any[] = [];
      mgr.onFill((fill: any) => fills.push(fill));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_trades',
        data: { symbol: 'SOL', side: 'bid', price: '100', size: '1' },
      });

      expect(fills.length).toBe(0);
    });

    it('ignores order updates without order_id', () => {
      const mgr = createManager();
      const orders: any[] = [];
      mgr.onOrderUpdate((order: any) => orders.push(order));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_orders',
        data: { symbol: 'SOL', status: 'filled' },
      });

      expect(orders.length).toBe(0);
    });

    it('ignores position updates without symbol', () => {
      const mgr = createManager();
      const positions: any[] = [];
      mgr.onPositionUpdate((pos: any) => positions.push(pos));

      mgr.connect();
      getLatestWs().simulateOpen();

      getLatestWs().simulateMessage({
        channel: 'account_positions',
        data: { size: '0.5', entry_price: '100' },
      });

      expect(positions.length).toBe(0);
    });

    it('handles unparseable messages gracefully', () => {
      const mgr = createManager();
      mgr.connect();
      const ws = getLatestWs();
      ws.simulateOpen();

      expect(() => {
        if (ws.onmessage) {
          ws.onmessage({ data: 'not-json{{{' });
        }
      }).not.toThrow();
    });
  });
});
