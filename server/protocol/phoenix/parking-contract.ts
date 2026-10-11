import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { units } from './funding-contract';
import { assertProtectionSnapshot, type ProtectionSnapshot } from './protection-contract';

export interface ParkingIntent {
  botId: string; ownerWallet: string; requestKey: string; identity: PhoenixTraderIdentity;
  action: 'idle' | 'post_borrow' | 'entry'; maxUsdc: string;
  destination: string | null; mode: 'shortfall' | 'all';
  executionOrderId?: string; borrowAuthorizationId?: string;
  requiredMarginUsdc?: string;
}
export type ParkingLegKind = 'withdraw' | 'unwrap' | 'park' | 'unpark' | 'deposit';
export interface ParkingLeg {
  key: string; kind: ParkingLegKind; amount: string; asset: string | null;
  parentKey?: string;
}
export interface ParkingReceipt {
  key: string; state: 'pending' | 'settled' | 'dropped';
  source: string; reference: string; finalized: true;
  signature?: string; // Vault observations bind to the persisted signed attempt.
  // Measured input/output, NOT a quote or total wallet balance.
  spent: string; received: string; slot: string;
}
export interface ParkingRecord {
  id: string; intent: ParkingIntent; intent_hash: string; revision: number;
  state: 'active' | 'completed' | 'cancelled' | 'attention';
  legs: { leg: ParkingLeg; receipt?: ParkingReceipt; attempt?: {
    signature: string; transactionHash: string; lastValidBlockHeight: string;
  } }[];
}
export interface ParkingSnapshot {
  botId: string; authority: string; trader: string; observedAt: number; slot: string;
  complete: true; source: string; reference: string;
  autoPark: boolean; entryAuthorized: boolean; lifecycleActive: boolean;
  destination: string | null; destinationEnabled: boolean;
  walletUsdc: string; withdrawableUsdc: string; pendingReturnUsdc: string; freeMarginUsdc: string;
  // Reader enumerates ALL active markets/positions, book and both protection surfaces.
  marketsComplete: true; protections: ProtectionSnapshot[];
  holdings: { asset: string; tokenUnits: string; valueUsdc: string; redeemable: boolean }[];
  borrow?: { authorizationId: string; creditedUsdc: string; parkAuthorized: boolean };
}
export function validateParkingIntent(i: ParkingIntent) {
  assertPhoenixIdentity(i.identity);
  if (!i.botId || !i.ownerWallet || !/^[\x21-\x7e]{1,120}$/.test(i.requestKey) || i.requestKey.includes('\n')
    || !['idle','post_borrow','entry'].includes(i.action) || !['shortfall','all'].includes(i.mode)
    || units(i.maxUsdc) === 0n || (i.action === 'entry') !== !!i.executionOrderId
    || (i.action === 'post_borrow') !== !!i.borrowAuthorizationId
    || (i.action !== 'entry' && !i.destination)) throw new Error('Invalid Phoenix parking intent');
  if (i.action === 'entry' && (!i.requiredMarginUsdc || units(i.requiredMarginUsdc) < units(i.maxUsdc))) throw new Error('Invalid entry margin target');
}
export function assertParkingSnapshot(s: ParkingSnapshot, i: ParkingIntent, now: number, minimumSlot = '0') {
  if (!s || s.botId !== i.botId || s.authority !== i.identity.authorityWalletAddress || s.trader !== i.identity.traderAccountAddress
    || s.complete !== true || s.marketsComplete !== true || !s.source || !s.reference
    || !Number.isSafeInteger(s.observedAt) || s.observedAt > now || now - s.observedAt >= 5000
    || units(s.slot) < units(minimumSlot) || !Array.isArray(s.protections) || !s.protections.length
    || !Array.isArray(s.holdings)) throw new Error('Phoenix parking authority unavailable');
  for (const k of ['walletUsdc','withdrawableUsdc','pendingReturnUsdc','freeMarginUsdc'] as const) units(s[k]);
  const assets = new Set<string>();
  for (const h of s.holdings) {
    if (!h.asset || assets.has(h.asset)) throw new Error('Duplicate parking asset');
    assets.add(h.asset); units(h.tokenUnits); units(h.valueUsdc);
  }
  const markets = new Set<number>();
  for (const p of s.protections) {
    assertProtectionSnapshot(p, { identity: i.identity, market: p.market, assetId: p.assetId }, now, minimumSlot);
    if (markets.has(p.assetId)) throw new Error('Duplicate parking market');
    markets.add(p.assetId);
    if (i.action !== 'entry' && (p.position.side !== 'flat' || p.orderbookOrderIds.length || p.legs.length)) {
      throw new Error('Phoenix parking requires flat and fully cancelled protection');
    }
  }
}
export function parkingAuthorized(i: ParkingIntent, s: ParkingSnapshot): boolean {
  if (!s.lifecycleActive) return false;
  if (i.action === 'entry') return s.entryAuthorized;
  if (s.destination !== i.destination || !s.destinationEnabled) return false;
  if (i.action === 'idle') return s.autoPark;
  return s.borrow?.authorizationId === i.borrowAuthorizationId && s.borrow.parkAuthorized === true
    && units(s.borrow.creditedUsdc) >= units(i.maxUsdc);
}
export const minUnits = (a: bigint, b: bigint) => a < b ? a : b;
