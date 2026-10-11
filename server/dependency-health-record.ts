/** Cached dependency-health-record projection for the incumbent /api/health.
 * Request handlers never probe dependencies or read journals. Missing production
 * custody/queue/aggregate bindings remain unknown, never healthy zeroes. */
import { PHOENIX_SDK_PIN } from './protocol/phoenix/sdk-boundary';
type Freshness = 'fresh' | 'stale' | 'unknown';
type Eligibility = 'eligible' | 'gated' | 'denied' | 'unknown';
type DebtHealth = 'healthy' | 'attention' | 'unknown';
const ttl = 120_000;
let apiAt: number | null = null, wsAt: number | null = null;
export interface PhoenixCustodyHealthSample {
  complete: true; observedAt: number; rpcObservedAt: number | null; eligibility: Eligibility;
  executionBindingsReady: boolean; custodyVerified: boolean;
  queueOldestAt: number | null; queueCount: number; queueDrops: number;
  unresolvedJournals: number; protectionGaps: number; debtHealth: DebtHealth;
}
let custody: PhoenixCustodyHealthSample | null = null;
const time = (v: unknown, now: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= now;
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
export function recordPhoenixPublicHealth(kind: 'api' | 'ws', observedAt: number | null, now = Date.now()) {
  const value = time(observedAt,now) ? observedAt : null;
  if (kind === 'api') apiAt = value; else wsAt = value;
}
/** Only a reviewed server-side complete cohort observer may supply this sample.
 * No client DTO or cached partial account observation is an aggregate source. */
export function recordPhoenixCustodyHealth(s: PhoenixCustodyHealthSample, now = Date.now()) {
  if (s.complete !== true || !time(s.observedAt,now) || (s.rpcObservedAt !== null && !time(s.rpcObservedAt,now))
    || typeof s.executionBindingsReady !== 'boolean' || typeof s.custodyVerified !== 'boolean'
    || !['eligible','gated','denied','unknown'].includes(s.eligibility)
    || !['healthy','attention','unknown'].includes(s.debtHealth)
    || ![s.queueCount,s.queueDrops,s.unresolvedJournals,s.protectionGaps].every(count)
    || (s.queueOldestAt !== null && !time(s.queueOldestAt,now))
    || (s.queueCount === 0 ? s.queueOldestAt !== null : s.queueOldestAt === null)) { custody = null; return; }
  // Pick fixed fields: never copy IDs, errors, endpoints or extra input properties.
  custody = {complete:true,observedAt:s.observedAt,rpcObservedAt:s.rpcObservedAt,eligibility:s.eligibility,
    executionBindingsReady:s.executionBindingsReady,custodyVerified:s.custodyVerified,
    queueOldestAt:s.queueOldestAt,queueCount:s.queueCount,queueDrops:s.queueDrops,
    unresolvedJournals:s.unresolvedJournals,protectionGaps:s.protectionGaps,debtHealth:s.debtHealth};
}
export function phoenixDependencyHealth(now = Date.now()) {
  const observation = (at: number | null): {state: Freshness; observedAt: number | null; ageMs: number | null} => ({
    state: at === null || now < at ? 'unknown' : now - at >= ttl ? 'stale' : 'fresh',
    observedAt: at, ageMs: at === null || now < at ? null : now - at,
  });
  const sample = observation(custody?.observedAt ?? null), fresh = sample.state === 'fresh';
  const api = observation(apiAt), ws = observation(wsAt), rpc = observation(custody?.rpcObservedAt ?? null);
  const custodyReady = fresh && rpc.state === 'fresh' && custody!.custodyVerified;
  const venueReady = custodyReady && custody!.executionBindingsReady && api.state === 'fresh' && custody!.eligibility === 'eligible'
    && custody!.protectionGaps === 0 && custody!.unresolvedJournals === 0 && custody!.queueDrops === 0 && custody!.debtHealth === 'healthy';
  return { adapterVersion:'phoenix-u16/1', sdk:{package:PHOENIX_SDK_PIN.package,version:PHOENIX_SDK_PIN.version,
    verification:'pin_only' as const}, venueReady, custodyReady,
    eligibility:fresh ? custody!.eligibility : 'unknown', rpc, api, ws, aggregate:sample,
    queue:{count:fresh ? custody!.queueCount : null,oldestAgeMs:fresh && custody!.queueOldestAt !== null ? now-custody!.queueOldestAt! : null,
      drops:fresh ? custody!.queueDrops : null},
    unresolvedJournals:fresh ? custody!.unresolvedJournals : null, protectionGaps:fresh ? custody!.protectionGaps : null,
    debtHealth:fresh ? custody!.debtHealth : 'unknown',
    reason:fresh ? (venueReady ? 'observed_ready' : 'attention_or_dependency_unavailable') : 'complete_custody_binding_unavailable_or_stale' };
}
