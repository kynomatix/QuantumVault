import Decimal from 'decimal.js';
import type {
  OpenProtectiveOrderSnapshot,
  ProtocolAdapter,
} from '../protocol/adapter';

export type SemanticProtectiveStopObservation =
  | {
      status: 'verified';
      orderId: string;
      normalizedRowCount: number;
      incompleteRowCount: number;
    }
  | {
      status: 'off_spec';
      detail: string;
      normalizedRowCount: number;
      incompleteRowCount: number;
    }
  | {
      status: 'inconclusive';
      detail: string;
      normalizedRowCount: number;
      incompleteRowCount: number;
    }
  | {
      status: 'unavailable';
      detail: string;
      normalizedRowCount: number;
      incompleteRowCount: number;
    };

export interface LiveProtectiveStopProof {
  status: 'legacy_present' | 'legacy_missing' | 'legacy_unavailable';
  legacyRowCount: number | null;
  semantic: SemanticProtectiveStopObservation;
  detail: string;
}

function decimal(value: string | number): Decimal | null {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

export function verifyProtectiveStop(input: {
  snapshot: OpenProtectiveOrderSnapshot;
  internalSymbol: string;
  positionBaseSize: number;
  quantizedStopLossPrice: number;
}): SemanticProtectiveStopObservation {
  const normalizedRowCount = input.snapshot.orders.length;
  const incompleteRowCount = input.snapshot.incompleteProtectiveRowCount;
  const positionSize = decimal(Math.abs(input.positionBaseSize));
  const quantizedStop = decimal(input.quantizedStopLossPrice);
  if (!positionSize || !positionSize.gt(0) || !quantizedStop || !quantizedStop.gt(0)) {
    return {
      status: 'unavailable',
      detail: 'position size or venue-quantized stop price is invalid',
      normalizedRowCount,
      incompleteRowCount,
    };
  }

  const expectedSide = input.positionBaseSize > 0 ? 'sell' : 'buy';
  const expectedSymbol = input.internalSymbol.toUpperCase();
  for (const order of input.snapshot.orders) {
    if (order.internalSymbol.toUpperCase() !== expectedSymbol
        || order.orderType !== 'stop_loss'
        || order.side !== expectedSide
        || order.reduceOnly !== true) continue;

    const trigger = decimal(order.triggerPrice);
    const initial = decimal(order.initialSize);
    const filled = decimal(order.filledSize);
    const cancelled = decimal(order.cancelledSize);
    if (!trigger || !initial || !filled || !cancelled) continue;
    const remaining = initial.minus(filled).minus(cancelled);
    const triggerProtects = input.positionBaseSize > 0
      ? trigger.gte(quantizedStop)
      : trigger.lte(quantizedStop);
    if (trigger.gt(0) && triggerProtects && remaining.gte(positionSize)) {
      return {
        status: 'verified',
        orderId: order.orderId,
        normalizedRowCount,
        incompleteRowCount,
      };
    }
  }

  if (input.snapshot.matchingProtectiveRowCount === 0) {
    return {
      status: 'inconclusive',
      detail: 'documented endpoint returned no protective rows for this market',
      normalizedRowCount,
      incompleteRowCount,
    };
  }
  if (incompleteRowCount > 0) {
    return {
      status: 'inconclusive',
      detail: 'documented endpoint returned an incomplete protective row',
      normalizedRowCount,
      incompleteRowCount,
    };
  }
  return {
    status: 'off_spec',
    detail: `documented endpoint returned protective rows but none prove an equal-or-tighter reduce-only ${expectedSide} stop for ${input.internalSymbol}`,
    normalizedRowCount,
    incompleteRowCount,
  };
}

export async function verifyLiveProtectiveStop(input: {
  adapter: ProtocolAdapter;
  agentPublicKey: string;
  subaccountId?: string;
  internalSymbol: string;
  positionBaseSize: number;
  expectedStopLossPrice: number;
}): Promise<LiveProtectiveStopProof> {
  let semantic: SemanticProtectiveStopObservation;
  if (typeof input.adapter.getOpenProtectiveOrders !== 'function') {
    semantic = {
      status: 'unavailable',
      detail: 'adapter lacks semantic protective-order observation capability',
      normalizedRowCount: 0,
      incompleteRowCount: 0,
    };
  } else {
    try {
      const quantizedStopLossPrice = input.adapter.quantizePrice(
        input.internalSymbol,
        input.expectedStopLossPrice,
      );
      const snapshot = await input.adapter.getOpenProtectiveOrders(
        input.agentPublicKey,
        input.internalSymbol,
      );
      semantic = verifyProtectiveStop({
        snapshot,
        internalSymbol: input.internalSymbol,
        positionBaseSize: input.positionBaseSize,
        quantizedStopLossPrice,
      });
    } catch (error) {
      semantic = {
        status: 'unavailable',
        detail: `semantic protective-order observation failed: ${error instanceof Error ? error.message : String(error)}`,
        normalizedRowCount: 0,
        incompleteRowCount: 0,
      };
    }
  }

  if (typeof input.adapter.getOpenStopOrders !== 'function') {
    return {
      status: 'legacy_unavailable',
      legacyRowCount: null,
      semantic,
      detail: 'adapter lacks the legacy stop-order authority',
    };
  }
  try {
    const legacyRows = await input.adapter.getOpenStopOrders(
      input.agentPublicKey,
      input.subaccountId,
      input.internalSymbol,
    );
    return {
      status: legacyRows.length > 0 ? 'legacy_present' : 'legacy_missing',
      legacyRowCount: legacyRows.length,
      semantic,
      detail: legacyRows.length > 0
        ? 'legacy stop-order authority reports protection present'
        : 'legacy stop-order authority reports no protection',
    };
  } catch (error) {
    return {
      status: 'legacy_unavailable',
      legacyRowCount: null,
      semantic,
      detail: `legacy stop-order read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function protectiveReadNeedsTelemetry(proof: LiveProtectiveStopProof): boolean {
  return proof.semantic.status !== 'verified' || proof.status !== 'legacy_present';
}
