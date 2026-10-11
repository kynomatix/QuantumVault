import type { PhoenixOrderService } from './order-service';
import { admitPhoenixOrder, type PhoenixOrderIntent, type PhoenixOrderAuthority } from './order-contract';
import type { PhoenixOrderRecord } from './order-store';
import type { PhoenixProtectionService } from './protection-service';
import type { ProtectionRequest, ProtectionProgress } from './protection-contract';

export interface PhoenixCloseProof {
  signature: string; finalized: true; source: string; reference: string; authority: PhoenixOrderAuthority;
}
/** Close observations are independent of conditional-account availability. */
export class PhoenixSafetyService {
  constructor(private readonly orders: Pick<PhoenixOrderService, 'execute'>,
    private readonly protection: Pick<PhoenixProtectionService, 'execute'>,
    private readonly reads: { before(i: PhoenixOrderIntent): Promise<PhoenixOrderAuthority>;
      after(record: PhoenixOrderRecord): Promise<PhoenixCloseProof | null> }, private readonly now = Date.now) {}

  async close(input: PhoenixOrderIntent) {
    const i = structuredClone(input);
    if (i.action !== 'close') throw new Error('Safety close requires reduce-only intent');
    const before = await this.reads.before(i);
    admitPhoenixOrder(i, before, this.now()); // No entry or protection requirement.
    const order = await this.orders.execute(i);
    let after: PhoenixOrderAuthority | null = null;
    try {
      const proof = await this.reads.after(order);
      const a = proof?.authority;
      if (proof && a && proof.finalized === true && proof.signature === order.data.attempt?.signature && proof.source && proof.reference
        && a.venue === 'phoenix' && a.trader === i.identity.traderAccountAddress && a.market === i.market
        && a.assetId === before.assetId && a.source && a.reference && !a.refreshFailed
        && a.observedAt >= before.observedAt && a.observedAt <= this.now() && this.now() - a.observedAt < 5000
        && a.position.observedAt >= before.position.observedAt && a.position.observedAt <= this.now()
        && this.now() - a.position.observedAt < 5000 && BigInt(a.slot) >= BigInt(before.slot)) after = a;
    } catch { /* Preserve unknown instead of claiming flat. */ }
    return { order, before, after, positionClosed: order.state === 'settled' && order.data.remainingPositionLots === '0'
      && after?.position.side === 'flat' && after.position.baseLots === '0' };
  }
  async pause(request: ProtectionRequest, closeIntent: PhoenixOrderIntent | null) {
    if (request.action !== 'pause') throw new Error('Pause request required');
    let cancellation: Awaited<ReturnType<PhoenixProtectionService['execute']>> | null = null;
    let close: Awaited<ReturnType<PhoenixSafetyService['close']>> | null = null;
    let cancellationError: string | null = null, closeError: string | null = null;
    try { cancellation = await this.protection.execute(request); } catch { cancellationError = 'Cancellation outcome unavailable'; }
    // A partial API result or unavailable conditional account must never suppress close.
    try { if (closeIntent) close = await this.close(closeIntent); } catch { closeError = 'Close outcome unavailable'; }
    const progress = cancellation?.observation?.protection as ProtectionProgress | undefined;
    return { cancellation, close, cancellationError, closeError,
      allOrdersCancelled: cancellation?.state === 'completed' && progress?.allOrdersCancelled === true,
      positionClosed: close?.positionClosed === true };
  }
  /** Manual, automatic and breakeven callers share the identical durable contract. */
  protect(request: ProtectionRequest) { return this.protection.execute(request); }
}
