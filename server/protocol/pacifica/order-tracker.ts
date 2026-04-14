import type { OrderResult, OrderStatus } from '../protocol-types.js';

const ACK_TIMEOUT_MS = 30_000;
const REST_POLL_INTERVAL_MS = 5_000;
const MAX_TRACKED_ORDERS = 500;
const ORDER_EXPIRY_MS = 5 * 60 * 1000;

interface TrackedOrder {
  clientOrderId: string;
  protocolOrderId?: string;
  status: OrderStatus;
  submittedAt: number;
  lastUpdatedAt: number;
  fillPrice?: number;
  fillSize?: number;
  fee?: number;
  error?: string;
  resolve?: (result: OrderResult) => void;
  reject?: (error: Error) => void;
}

type RestPollFn = (orderId: string) => Promise<OrderResult | null>;

export class OrderTracker {
  private orders: Map<string, TrackedOrder> = new Map();
  private byProtocolId: Map<string, string> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private restPollFn: RestPollFn | null = null;
  private wsConnected = false;

  setRestPollFn(fn: RestPollFn): void {
    this.restPollFn = fn;
  }

  setWsConnected(connected: boolean): void {
    this.wsConnected = connected;

    if (!connected && !this.pollTimer && this.restPollFn) {
      this.startRestPolling();
    } else if (connected && this.pollTimer) {
      this.stopRestPolling();
    }
  }

  trackOrder(clientOrderId: string, protocolOrderId?: string): Promise<OrderResult> {
    this.evictExpired();

    if (this.orders.size >= MAX_TRACKED_ORDERS) {
      const oldest = this.findOldestOrder();
      if (oldest) {
        this.removeOrder(oldest);
      }
    }

    return new Promise<OrderResult>((resolve, reject) => {
      const order: TrackedOrder = {
        clientOrderId,
        protocolOrderId,
        status: 'submitted',
        submittedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        resolve,
        reject,
      };

      this.orders.set(clientOrderId, order);
      if (protocolOrderId) {
        this.byProtocolId.set(protocolOrderId, clientOrderId);
      }

      setTimeout(() => {
        const tracked = this.orders.get(clientOrderId);
        if (tracked && tracked.status === 'submitted') {
          this.resolveOrder(clientOrderId, {
            success: false,
            clientOrderId,
            orderId: protocolOrderId,
            status: 'rejected',
            error: 'Order acknowledgment timeout (30s)',
          });
        }
      }, ACK_TIMEOUT_MS);
    });
  }

  updateFromWs(
    protocolOrderId: string,
    clientOrderId: string | undefined,
    status: OrderStatus,
    fillPrice?: number,
    fillSize?: number,
    fee?: number,
  ): void {
    const cid =
      clientOrderId ||
      this.byProtocolId.get(protocolOrderId);

    if (!cid) return;

    const order = this.orders.get(cid);
    if (!order) return;

    order.status = status;
    order.lastUpdatedAt = Date.now();
    if (protocolOrderId && !order.protocolOrderId) {
      order.protocolOrderId = protocolOrderId;
      this.byProtocolId.set(protocolOrderId, cid);
    }
    if (fillPrice !== undefined) order.fillPrice = fillPrice;
    if (fillSize !== undefined) order.fillSize = fillSize;
    if (fee !== undefined) order.fee = fee;

    if (this.isTerminal(status)) {
      this.resolveOrder(cid, {
        success: status === 'filled' || status === 'partial_fill',
        orderId: order.protocolOrderId,
        clientOrderId: cid,
        status,
        fillPrice: order.fillPrice,
        fillSize: order.fillSize,
        fee: order.fee,
      });
    }
  }

  updateFromRest(result: OrderResult): void {
    const cid = result.clientOrderId;
    if (!cid) return;

    const order = this.orders.get(cid);
    if (!order) return;

    order.status = result.status;
    order.lastUpdatedAt = Date.now();
    if (result.orderId) {
      order.protocolOrderId = result.orderId;
      this.byProtocolId.set(result.orderId, cid);
    }
    if (result.fillPrice !== undefined) order.fillPrice = result.fillPrice;
    if (result.fillSize !== undefined) order.fillSize = result.fillSize;
    if (result.fee !== undefined) order.fee = result.fee;
    if (result.error) order.error = result.error;

    if (this.isTerminal(result.status)) {
      this.resolveOrder(cid, result);
    }
  }

  getPendingOrderIds(): string[] {
    const pending: string[] = [];
    this.orders.forEach((order) => {
      if (!this.isTerminal(order.status) && order.protocolOrderId) {
        pending.push(order.protocolOrderId);
      }
    });
    return pending;
  }

  getTrackedCount(): number {
    return this.orders.size;
  }

  shutdown(): void {
    this.stopRestPolling();

    this.orders.forEach((order, cid) => {
      if (order.reject) {
        order.reject(new Error('OrderTracker shutting down'));
      }
    });

    this.orders.clear();
    this.byProtocolId.clear();
  }

  private resolveOrder(clientOrderId: string, result: OrderResult): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;

    if (order.resolve) {
      order.resolve(result);
      order.resolve = undefined;
      order.reject = undefined;
    }

    this.removeOrder(clientOrderId);
  }

  private removeOrder(clientOrderId: string): void {
    const order = this.orders.get(clientOrderId);
    if (order?.protocolOrderId) {
      this.byProtocolId.delete(order.protocolOrderId);
    }
    this.orders.delete(clientOrderId);
  }

  private isTerminal(status: OrderStatus): boolean {
    return (
      status === 'filled' ||
      status === 'canceled' ||
      status === 'expired' ||
      status === 'rejected'
    );
  }

  private findOldestOrder(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    this.orders.forEach((order, key) => {
      if (order.submittedAt < oldestTime) {
        oldestTime = order.submittedAt;
        oldestKey = key;
      }
    });

    return oldestKey;
  }

  private evictExpired(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    this.orders.forEach((order, key) => {
      if (now - order.submittedAt > ORDER_EXPIRY_MS && this.isTerminal(order.status)) {
        toRemove.push(key);
      }
    });

    for (const key of toRemove) {
      this.removeOrder(key);
    }
  }

  private startRestPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      if (this.wsConnected || !this.restPollFn) return;

      const pendingIds = this.getPendingOrderIds();
      for (const orderId of pendingIds) {
        try {
          const result = await this.restPollFn(orderId);
          if (result) {
            this.updateFromRest(result);
          }
        } catch (err) {
          console.error(`OrderTracker: REST poll failed for ${orderId}:`, err);
        }
      }
    }, REST_POLL_INTERVAL_MS);
  }

  private stopRestPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
