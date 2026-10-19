import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { stableGridExtension } from './behaviour-policy';

/** Server-owned rollout switch. A deployment must explicitly enable the reviewed implementation. */
export const GRID_RANGE_MOVE_ENABLED = false;
export const GRID_EPOCH_POLICY_VERSION = '2.3.0';
export const GRID_MOVE_REVISION = 'manual-dow-1';
export interface EpochSource {
  kind: 'inventory' | 'recycle'; sourceEpochId: string; operationId: string; tradeId: string;
  sourceOwner: number; destinationOwner: number; time: number; price: string; fee: string;
  quantity: string; consumed: string; transferred: string; parked: string;
}
export interface EpochOwner {
  ownerOrdinal: number; lineage: string; initialIssued: string; initialConsumed: string;
  initialRemaining: string; remainingOneShot: string; sources: EpochSource[];
}
export interface EpochCarry { account: string; originEpochId: string; owners: EpochOwner[] }
export interface GridEpochAuthority {
  epochId: string; predecessorId: string; ordinal: number; revision: typeof GRID_MOVE_REVISION;
  account: string; originalPolicyHmac: string; carryDigest: string;
  originalInvestment: string; originalLeverage: number; originalSeedAtCreation: boolean;
  owners: { ownerOrdinal: number; lineage: string }[];
}
export const epochDigest = (value: unknown) => createHash('sha256').update(stableGridExtension(value as any)).digest('hex');
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
export function validEpochAuthority(a: GridEpochAuthority | undefined, p: {totalInvestment:string;leverage:number;seedAtCreation:boolean}) {
  return !!a && uuid(a.epochId) && uuid(a.predecessorId) && a.epochId !== a.predecessorId
    && Number.isSafeInteger(a.ordinal) && a.ordinal > 1 && a.revision === GRID_MOVE_REVISION
    && typeof a.account === 'string' && a.account.length > 0 && /^[0-9a-f]{64}$/.test(a.originalPolicyHmac)
    && /^[0-9a-f]{64}$/.test(a.carryDigest) && a.originalInvestment === p.totalInvestment
    && a.originalLeverage === p.leverage && a.originalSeedAtCreation === p.seedAtCreation
    && Array.isArray(a.owners) && new Set(a.owners.map(o=>o.ownerOrdinal)).size === a.owners.length
    && a.owners.every(o=>Number.isSafeInteger(o.ownerOrdinal) && o.ownerOrdinal >= 0 && typeof o.lineage === 'string' && o.lineage.length > 0);
}
/** Validate source conservation before importing anything into the active replay. */
export function validateEpochCarry(c: EpochCarry, a: GridEpochAuthority) {
  if (c.account !== a.account || c.originEpochId !== a.predecessorId || epochDigest(c) !== a.carryDigest
    || c.owners.length !== a.owners.length) throw Error('Epoch carry authority changed');
  const exact = (v:string) => { if(typeof v!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)||v.length>80)throw Error('Invalid carry quantity');return new Decimal(v); };
  const seen = new Set<string>();
  for(const o of c.owners) {
    const owner=a.owners.find(x=>x.ownerOrdinal===o.ownerOrdinal);
    if(!owner || owner.lineage!==o.lineage || seen.has(o.lineage))throw Error('Epoch owner lineage changed');
    seen.add(o.lineage);
    if(!exact(o.initialIssued).eq(exact(o.initialConsumed).plus(exact(o.initialRemaining))))throw Error('Initial credit was not conserved');
    exact(o.remainingOneShot);
    const sources=new Set<string>();
    for(const s of o.sources) {
      const key=JSON.stringify([s.kind,s.sourceEpochId,s.operationId,s.tradeId,s.sourceOwner]);
      if(!uuid(s.sourceEpochId)||!s.operationId||!s.tradeId||sources.has(key)||s.sourceOwner!==o.ownerOrdinal||s.destinationOwner!==o.ownerOrdinal
        ||!['inventory','recycle'].includes(s.kind)||!Number.isSafeInteger(s.time)||s.time<0||!exact(s.price).gt(0)
        ||!new Decimal(s.fee).isFinite()||!exact(s.quantity).eq(exact(s.consumed).plus(exact(s.transferred)).plus(exact(s.parked))))throw Error('Source carry was not conserved');
      sources.add(key);
    }
  }
}
