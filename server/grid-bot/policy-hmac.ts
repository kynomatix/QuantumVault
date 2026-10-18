import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import { gridPolicyExtension, stableGridExtension, type GridPolicyExtension } from './behaviour-policy';
import Decimal from 'decimal.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, zeroizeBuffer } from '../crypto-v3';
import { GRID_CYCLE_POLICY_VERSION, retainedGridCycles } from './cycle-policy';
import type { GridSizing } from './lean-sizing';

export const GRID_POLICY_HMAC_SUBKEY_PURPOSE = 'grid_policy_hmac';
export const GRID_POLICY_VERSION = '1.0.0';
export interface SignedGridLevel { ordinal: number; price: string; size: string; side: 'buy' | 'sell'; reduceOnly: boolean }
export interface GridPolicy extends GridSizing {
  gridPolicyExtension?: GridPolicyExtension;
  id: string; protocol: 'pacifica'; market: string; direction: 'long' | 'short';
  upperPrice: string; lowerPrice: string; startPrice: string; gridCount: number;
  totalInvestment: string; leverage: number; entryScaleType: 'flat' | 'ascending' | 'descending';
  profitScaleType: 'flat' | 'ascending' | 'descending'; policyVersion: string; feePolicyVersion: string;
  runtimePolicyVersion: string; stopLossPercent: string | null; stopLossPrice: string | null;
  seedAtCreation: boolean; levels: SignedGridLevel[];
}
type Failure = 'missing_secret' | 'invalid_secret' | 'unknown_version' | 'invalid_policy' | 'missing_digest' | 'malformed_digest' | 'mismatch';
type Result = { ok: true; digest: string } | { ok: false; reason: Failure };
const fixed = (raw: unknown, scale: number, positive = true) => typeof raw === 'string'
  && new RegExp(`^(?:0|[1-9]\\d*)\\.\\d{${scale}}$`).test(raw) && raw.length <= 80
  && (!positive || /[1-9]/.test(raw));
export function canonicalGridPolicy(p: GridPolicy): string | null {
  if (!p || ![GRID_POLICY_VERSION, GRID_CYCLE_POLICY_VERSION, '2.2.0'].includes(p.policyVersion) || p.feePolicyVersion !== '1.0.0' || p.runtimePolicyVersion !== p.policyVersion
    || typeof p.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.id) || p.protocol !== 'pacifica'
    || !/^[A-Z0-9]+-PERP$/.test(p.market) || !['long', 'short'].includes(p.direction)
    || ![p.upperPrice, p.lowerPrice, p.startPrice].every(v => fixed(v, 8)) || !fixed(p.totalInvestment, 2)
    || !Number.isSafeInteger(p.gridCount) || p.gridCount < 1 || p.gridCount > 100
    || !Number.isSafeInteger(p.leverage) || p.leverage < 1
    || ![p.entryScaleType, p.profitScaleType].every(v => ['flat', 'ascending', 'descending'].includes(v))
    || typeof p.seedAtCreation !== 'boolean' || (p.stopLossPercent === null) !== (p.stopLossPrice === null)
    || p.stopLossPercent !== null && (!fixed(p.stopLossPercent, 4) || !fixed(p.stopLossPrice, 8))
    || !Array.isArray(p.levels) || p.levels.length !== p.gridCount + 1
    || !p.levels.every((l, i) => l.ordinal === i + 1 && fixed(l.price, 8) && fixed(l.size, 8, false)
      && ['buy', 'sell'].includes(l.side) && typeof l.reduceOnly === 'boolean')) return null;
  if (!new Decimal(p.lowerPrice).lt(p.upperPrice) || new Decimal(p.startPrice).lt(p.lowerPrice) || new Decimal(p.startPrice).gt(p.upperPrice)
    || p.levels[0].price !== p.lowerPrice || p.levels.at(-1)!.price !== p.upperPrice
    || p.levels.some((l,i) => i > 0 && !new Decimal(l.price).gt(p.levels[i-1].price))) return null;
  const cycles = isGridCyclePolicyVersion(p.policyVersion) ? retainedGridCycles(p) : null;
  if (isGridCyclePolicyVersion(p.policyVersion) && (!cycles || !p.stopLossPrice)) return null;
  if (p.sizingVersion !== undefined || p.safetyEnvelopePrice !== undefined) {
    if (!isGridCyclePolicyVersion(p.policyVersion) || p.sizingVersion !== 'lean-1' || !fixed(p.safetyEnvelopePrice, 8)
      || new Decimal(p.safetyEnvelopePrice!).lt(p.upperPrice)
      || p.direction === 'short' && new Decimal(p.safetyEnvelopePrice!).lt(p.stopLossPrice!)) return null;
  }
  if (p.policyVersion === '2.2.0') {
    const extension = p.gridPolicyExtension, bounds = extension?.seedPriceBounds;
    if (p.sizingVersion !== 'lean-1' || !extension || !bounds || !cycles || ![bounds.low, bounds.high].every(v => fixed(v, 8))
      || new Decimal(bounds.low).gt(p.startPrice) || new Decimal(bounds.high).lt(p.startPrice)
      || p.seedAtCreation && new Decimal(bounds.high).gt(p.safetyEnvelopePrice!)
      || stableGridExtension(extension) !== stableGridExtension(gridPolicyExtension(cycles, extension.mode, p.safetyEnvelopePrice!, p.seedAtCreation, p.direction === 'long', bounds))) return null;
  } else if (p.gridPolicyExtension !== undefined) return null;
  return JSON.stringify([isGridCyclePolicyVersion(p.policyVersion) ? 'grid-policy-hmac-v2' : 'grid-policy-hmac-v1', p.id, p.protocol, p.market, p.direction, p.upperPrice, p.lowerPrice,
    p.startPrice, p.gridCount, p.totalInvestment, p.leverage, p.entryScaleType, p.profitScaleType,
    p.policyVersion, p.feePolicyVersion, p.runtimePolicyVersion, p.stopLossPercent, p.stopLossPrice, p.seedAtCreation,
    p.levels.map(l => [l.ordinal, l.price, l.size, l.side, l.reduceOnly]),
    ...(cycles ? [cycles.map(c => [c.ownerOrdinal, c.anchor, c.openingOrdinal, c.closingOrdinal,
      c.openingPrice, c.closingPrice, c.quantity, c.initialInventory, c.initialOpeningCredit])] : []),
    ...(p.sizingVersion ? [[p.sizingVersion, p.safetyEnvelopePrice]] : []),
    ...(p.gridPolicyExtension ? [stableGridExtension(p.gridPolicyExtension)] : [])]);
}
export function computeGridPolicyHmac(p: GridPolicy, umk: Buffer | null): Result {
  if (!umk) return { ok: false, reason: 'missing_secret' };
  if (!Buffer.isBuffer(umk) || umk.length !== 32) return { ok: false, reason: 'invalid_secret' };
  if (![GRID_POLICY_VERSION, GRID_CYCLE_POLICY_VERSION, '2.2.0'].includes(p?.policyVersion)) return { ok: false, reason: 'unknown_version' };
  const canonical = canonicalGridPolicy(p);
  if (!canonical) return { ok: false, reason: 'invalid_policy' };
  const subkey = deriveSubkey(umk, GRID_POLICY_HMAC_SUBKEY_PURPOSE);
  try { return { ok: true, digest: createHmac('sha256', subkey).update(canonical).digest('hex') }; }
  finally { zeroizeBuffer(subkey); }
}
export function verifyGridPolicyHmac(p: GridPolicy, umk: Buffer | null, digest: unknown): Result {
  if (digest === null || digest === undefined || digest === '') return { ok: false, reason: 'missing_digest' };
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: 'malformed_digest' };
  const computed = computeGridPolicyHmac(p, umk);
  if (!computed.ok) return computed;
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(computed.digest, 'hex'))
    ? computed : { ok: false, reason: 'mismatch' };
}
