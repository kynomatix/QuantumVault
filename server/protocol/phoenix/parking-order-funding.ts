import type { PhoenixOrderRecord } from './order-store';
import type { PhoenixParkingService } from './parking-service';
import type { ParkingIntent } from './parking-contract';

/** Install as U05 IO.fund only with the reviewed parking runtime. On pending
 * settlement U05 retains its funding intent and must not submit a new entry.
 * The original order's snapshot/signing pipeline still refreshes margin. */
export function parkingIntentForOrder(r: PhoenixOrderRecord, mode: 'shortfall' | 'all'): ParkingIntent {
  if (r.intent.action !== 'entry' || r.state !== 'funding') throw new Error('Entry funding claim required');
  return { botId: r.intent.botId, ownerWallet: r.intent.ownerWallet, identity: r.intent.identity,
    requestKey: `entry:${r.id}`, action: 'entry', executionOrderId: r.id,
    maxUsdc: r.data.admission.fundingShortfallMicros, requiredMarginUsdc: r.data.admission.requiredMarginMicros,
    destination: null, mode };
}
export async function fundPhoenixOrderFromVault(service: PhoenixParkingService, r: PhoenixOrderRecord, mode: 'shortfall' | 'all') {
  const result = await service.start(parkingIntentForOrder(r, mode));
  if (result.state !== 'completed') throw new Error('Phoenix unpark/deposit pending; retain original entry intent');
}
