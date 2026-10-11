import type { FillEvent, OrderUpdate, ProtocolPosition } from '../protocol-types.js';
import { mapPacificaSide } from './pacifica-types.js';
import type { SymbolRegistry } from '../symbol-registry.js';

const MAX_RECONNECT_DELAY_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MAX_QUEUED_MESSAGES = 1000;
const MAX_CALLBACKS_PER_TYPE = 50;

type WsState = 'disconnected' | 'connecting' | 'connected' | 'closing';

interface PacificaWsConfig {
  wsUrl: string;
  account: string;
  agentWallet?: string;
  subaccountId?: string;
}

type FillCallback = (fill: FillEvent) => void;
type PositionCallback = (pos: ProtocolPosition) => void;
type OrderCallback = (order: OrderUpdate) => void;
type HealthCallback = (healthy: boolean) => void;

export class PacificaWsManager {
  private config: PacificaWsConfig;
  private registry: SymbolRegistry;
  private ws: WebSocket | null = null;
  private state: WsState = 'disconnected';
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat: number = 0;
  private shouldReconnect = false;
  private messageCount = 0;

  private fillCallbacks: Set<FillCallback> = new Set();
  private positionCallbacks: Set<PositionCallback> = new Set();
  private orderCallbacks: Set<OrderCallback> = new Set();
  private healthCallbacks: Set<HealthCallback> = new Set();
  private subscribedChannels: Set<string> = new Set();

  constructor(config: PacificaWsConfig, registry: SymbolRegistry) {
    this.config = config;
    this.registry = registry;
  }

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();

    if (this.ws) {
      this.state = 'closing';
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }

    this.state = 'disconnected';
    this.notifyHealth(false);
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  isHealthy(): boolean {
    if (this.state !== 'connected') return false;
    if (this.lastHeartbeat === 0) return true;
    return Date.now() - this.lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
  }

  onFill(callback: FillCallback): () => void {
    if (this.fillCallbacks.size >= MAX_CALLBACKS_PER_TYPE) {
      throw new Error(`PacificaWsManager: max fill callbacks (${MAX_CALLBACKS_PER_TYPE}) reached`);
    }
    this.fillCallbacks.add(callback);
    return () => this.fillCallbacks.delete(callback);
  }

  onPositionUpdate(callback: PositionCallback): () => void {
    if (this.positionCallbacks.size >= MAX_CALLBACKS_PER_TYPE) {
      throw new Error(`PacificaWsManager: max position callbacks (${MAX_CALLBACKS_PER_TYPE}) reached`);
    }
    this.positionCallbacks.add(callback);
    return () => this.positionCallbacks.delete(callback);
  }

  onOrderUpdate(callback: OrderCallback): () => void {
    if (this.orderCallbacks.size >= MAX_CALLBACKS_PER_TYPE) {
      throw new Error(`PacificaWsManager: max order callbacks (${MAX_CALLBACKS_PER_TYPE}) reached`);
    }
    this.orderCallbacks.add(callback);
    return () => this.orderCallbacks.delete(callback);
  }

  onHealthChange(callback: HealthCallback): () => void {
    if (this.healthCallbacks.size >= MAX_CALLBACKS_PER_TYPE) {
      throw new Error(`PacificaWsManager: max health callbacks (${MAX_CALLBACKS_PER_TYPE}) reached`);
    }
    this.healthCallbacks.add(callback);
    return () => this.healthCallbacks.delete(callback);
  }

  private doConnect(): void {
    this.state = 'connecting';

    try {
      this.ws = new WebSocket(this.config.wsUrl);
    } catch (err) {
      console.error('PacificaWsManager: WebSocket constructor failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.lastHeartbeat = Date.now();
      this.messageCount = 0;
      this.startHeartbeatMonitor();
      this.subscribePrivateChannels();
      this.notifyHealth(true);
    };

    this.ws.onmessage = (event) => {
      this.lastHeartbeat = Date.now();

      if (this.messageCount >= MAX_QUEUED_MESSAGES) {
        return;
      }
      this.messageCount++;

      try {
        const data = JSON.parse(String(event.data));
        this.handleMessage(data);
      } catch {
        // ignore unparseable
      }

      if (this.messageCount >= MAX_QUEUED_MESSAGES) {
        this.messageCount = 0;
      }
    };

    this.ws.onclose = (event) => {
      this.state = 'disconnected';
      this.clearHeartbeatTimer();
      this.notifyHealth(false);

      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private subscribePrivateChannels(): void {
    const channels = ['account_trades', 'account_orders', 'account_positions'];

    for (const channel of channels) {
      this.sendSubscription(channel);
      this.subscribedChannels.add(channel);
    }
  }

  private sendSubscription(channel: string): void {
    if (!this.ws || this.state !== 'connected') return;

    const msg: Record<string, unknown> = {
      type: 'subscribe',
      channel,
      account: this.config.account,
    };

    if (this.config.agentWallet) {
      msg.agent_wallet = this.config.agentWallet;
    }

    if (this.config.subaccountId) {
      msg.subaccount_id = this.config.subaccountId;
    }

    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(data: any): void {
    const channel = data.channel || data.type;

    switch (channel) {
      case 'account_trades':
        this.handleFill(data.data || data);
        break;
      case 'account_orders':
        this.handleOrderUpdate(data.data || data);
        break;
      case 'account_positions':
        this.handlePositionUpdate(data.data || data);
        break;
      case 'pong':
      case 'heartbeat':
        this.lastHeartbeat = Date.now();
        break;
    }
  }

  private handleFill(data: any): void {
    if (!data.fill_id && !data.trade_id) return;

    let internalSymbol: string;
    try {
      internalSymbol = this.registry.protocolToInternal(data.symbol);
    } catch {
      internalSymbol = `UNKNOWN-${data.symbol}`;
    }

    const fill: FillEvent = {
      fillId: data.fill_id || data.trade_id,
      orderId: data.order_id,
      clientOrderId: data.client_order_id,
      internalSymbol,
      side: mapPacificaSide(data.side === 'bid' ? 'bid' : 'ask'),
      price: parseFloat(data.price),
      size: parseFloat(data.size || data.amount),
      fee: parseFloat(data.fee || '0'),
      timestamp: data.timestamp || Date.now(),
      subaccountId: data.subaccount_id,
    };

    Array.from(this.fillCallbacks).forEach((cb) => {
      try {
        cb(fill);
      } catch (err) {
        console.error('PacificaWsManager: fill callback error:', err);
      }
    });
  }

  private handleOrderUpdate(data: any): void {
    if (!data.order_id) return;

    let internalSymbol: string;
    try {
      internalSymbol = this.registry.protocolToInternal(data.symbol);
    } catch {
      internalSymbol = `UNKNOWN-${data.symbol}`;
    }

    const update: OrderUpdate = {
      orderId: data.order_id,
      clientOrderId: data.client_order_id,
      internalSymbol,
      status: data.status || 'submitted',
      filledSize: data.filled_size ? parseFloat(data.filled_size) : undefined,
      remainingSize: data.remaining_size ? parseFloat(data.remaining_size) : undefined,
      averageFillPrice: data.average_fill_price
        ? parseFloat(data.average_fill_price)
        : undefined,
      timestamp: data.timestamp || Date.now(),
      subaccountId: data.subaccount_id,
    };

    Array.from(this.orderCallbacks).forEach((cb) => {
      try {
        cb(update);
      } catch (err) {
        console.error('PacificaWsManager: order callback error:', err);
      }
    });
  }

  private handlePositionUpdate(data: any): void {
    if (!data.symbol) return;

    let internalSymbol: string;
    try {
      internalSymbol = this.registry.protocolToInternal(data.symbol);
    } catch {
      internalSymbol = `UNKNOWN-${data.symbol}`;
    }

    const position: ProtocolPosition = {
      internalSymbol,
      baseSize: parseFloat(data.size || '0'),
      entryPrice: parseFloat(data.entry_price || '0'),
      markPrice: parseFloat(data.mark_price || '0'),
      unrealizedPnl: parseFloat(data.unrealized_pnl || '0'),
      leverage: parseFloat(data.leverage || '1'),
      liquidationPrice: data.liquidation_price
        ? parseFloat(data.liquidation_price)
        : null,
      marginMode: data.margin_mode || 'cross',
      subaccountId: data.subaccount_id,
    };

    Array.from(this.positionCallbacks).forEach((cb) => {
      try {
        cb(position);
      } catch (err) {
        console.error('PacificaWsManager: position callback error:', err);
      }
    });
  }

  private startHeartbeatMonitor(): void {
    this.clearHeartbeatTimer();

    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        console.warn('PacificaWsManager: heartbeat stale, reconnecting');
        this.notifyHealth(false);
        if (this.ws) {
          this.ws.close(4000, 'heartbeat timeout');
        }
        return;
      }

      if (this.ws && this.state === 'connected') {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // will trigger onclose
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    if (!this.shouldReconnect) return;

    const delay = Math.min(
      this.reconnectDelay + Math.random() * 1000,
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private notifyHealth(healthy: boolean): void {
    Array.from(this.healthCallbacks).forEach((cb) => {
      try {
        cb(healthy);
      } catch (err) {
        console.error('PacificaWsManager: health callback error:', err);
      }
    });
  }
}
