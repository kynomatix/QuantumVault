import { authority, identity, intent } from './phoenix-orders';
import type { ProtectionLeg, ProtectionRequest, ProtectionSnapshot } from '../../server/protocol/phoenix/protection-contract';
export function snapshot(): ProtectionSnapshot {
  const s = authority().protection!;
  s.position = { side: 'long', baseLots: '200', sequence: 1, epoch: 'EXAMPLE-position-epoch' };
  return s;
}
export function request(patch: Partial<ProtectionRequest> = {}): ProtectionRequest {
  return { botId: intent().botId, ownerWallet: intent().ownerWallet, requestKey: 'EXAMPLE-protect', identity,
    market: 'SOL', assetId: 3, action: 'replace', prices: intent().protection, ...patch };
}
export function leg(patch: Partial<ProtectionLeg> = {}): ProtectionLeg {
  return { surface: 'conditional', index: 1, sequence: '1', assetId: 3, parentOrderId: null, positionSequence: 1,
    side: 'sell', direction: 'less', kind: 'IOC', triggerTicks: '14000', executionTicks: '13860',
    remainingLots: '200', sizePercent: null, rawMaxLots: '200', rawFillableLots: '200', rawFilledLots: '0', ...patch };
}
