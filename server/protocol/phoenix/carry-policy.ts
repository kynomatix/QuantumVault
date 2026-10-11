import { decideCarryTrade } from '../../vault/carry-trade-advisor';
import { rankMeasuredYieldDestinations } from '../../vault/carry-yield-ranker';
import type { CarryTradeInput } from '../../vault/carry-trade-advisor';
import type { YieldTable } from '../../vault/yield-oracle';
import type { YieldAsset } from '../../vault/yield-assets';
import { phoenixFundingDetail } from './funding-detail';
import type { StoredPhoenixOperation } from './operation-store';
import { raw } from './borrow-contract';

export interface CarryEconomics {
  yieldTable: YieldTable; assets: YieldAsset[];
  healthSummary: CarryTradeInput['healthSummary'];
  borrowApr: number | null; rateObservedAt: number | null;
  debtUsd: number; principalRaw: string;
  destination: string; parkedAsset: string | null;
  /** U04 history for this bot/authority, resolved by the server. */
  history: StoredPhoenixOperation[];
  /** Actual route quotes: gas converted using a measured SOL/USD quote, rent,
   * fees and swap/exit loss across withdrawal, unwrap, park AND redemption. */
  costs: null | { principalRaw: string; destination: string; roundTripUsd: number;
    observedAt: number; expiresAt: number; source: string; reference: string };
  horizonSeconds: number; pendingQueueAgeSeconds: number;
  maxQueueSeconds: number; maxQueueCostUsd: number;
  maxAgeMs: number; measurementMaxAgeMs: number;
}
export interface PhoenixCarryRecommendation {
  action: 'park' | 'repay' | 'hold' | 'unavailable'; reason: string;
  destination: string; parkedAsset: string | null;
  estimatedNetUsd: number | null; roundTripUsd: number | null;
  observedDelaySeconds: number | null; queueCostUsd: number | null;
  message: string;
}
const fresh = (at: number | null, now: number, ttl: number) => at !== null && Number.isSafeInteger(at)
  && at <= now && now - at < ttl && Number.isFinite(ttl) && ttl > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Phoenix-only overlay. The incumbent advisor and measured ranker keep their
 * original behavior for every other bot, including managed SOL loops. */
export function recommendPhoenixCarry(f: CarryEconomics, now: number): PhoenixCarryRecommendation {
  const base: PhoenixCarryRecommendation = {action:'unavailable',reason:'economics_unavailable',destination:f.destination,
    parkedAsset:f.parkedAsset,estimatedNetUsd:null,roundTripUsd:null,observedDelaySeconds:null,queueCostUsd:null,
    message:'Carry economics are unavailable.'};
  const health = decideCarryTrade({rankedYields:[],borrowApr:f.borrowApr,healthSummary:f.healthSummary,debtUsd:f.debtUsd});
  if (health.action === 'unavailable' && health.blockedBy === 'health') return {...base,reason:'health_unavailable'};
  if (health.action === 'repay') return {...base,action:'repay',reason:health.reason,
    message:'Loan health calls for repayment from available authorized bot cash.'};
  if (!finite(f.debtUsd) || f.debtUsd < 0) return base;
  if (f.debtUsd === 0) return {...base,action:'hold',reason:'no_debt',message:'No debt to carry. No new borrowing is authorized.'};
  const ranked = rankMeasuredYieldDestinations(f.yieldTable,f.assets.filter(a => a.enabled && a.mint)).ranked;
  const asset = ranked.find(a => a.assetKey === (f.parkedAsset ?? f.destination));
  const m = phoenixFundingDetail(f.history).measured;
  const c = f.costs;
  let principal: number;
  try { const n = raw(f.principalRaw); if (n > BigInt(Number.MAX_SAFE_INTEGER)) return base; principal = Number(n) / 1e6; }
  catch { return base; }
  if (!asset || !fresh(asset.asOf,now,f.maxAgeMs) || !finite(f.borrowApr) || f.borrowApr < 0
    || !fresh(f.rateObservedAt,now,f.maxAgeMs) || !c || !c.source || !c.reference
    || c.destination !== (f.parkedAsset ?? f.destination) || c.principalRaw !== f.principalRaw
    || !fresh(c.observedAt,now,f.maxAgeMs) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= now
    || !finite(c.roundTripUsd) || c.roundTripUsd < 0 || principal <= 0 || !m || m.samples < 1
    || !fresh(m.lastCompletedAt,now,f.measurementMaxAgeMs) || !finite(m.maxSeconds) || m.maxSeconds < 0
    || !finite(f.pendingQueueAgeSeconds) || f.pendingQueueAgeSeconds < 0
    || !finite(f.horizonSeconds) || f.horizonSeconds <= 0 || !finite(f.maxQueueSeconds) || f.maxQueueSeconds <= 0
    || !finite(f.maxQueueCostUsd) || f.maxQueueCostUsd < 0) return base;
  // Historical maximum is an observation, never a promised completion deadline.
  const delay = Math.max(m.maxSeconds,f.pendingQueueAgeSeconds);
  const year = 365 * 24 * 3600;
  // Charge both ongoing debt and foregone positive yield during the observed wait.
  const queueCost = principal * (f.borrowApr + Math.max(0,asset.apyPct / 100)) * delay / year;
  const incumbent = decideCarryTrade({rankedYields:[asset],borrowApr:f.borrowApr,healthSummary:f.healthSummary,
    debtUsd:f.debtUsd,currentParked:f.parkedAsset ? {assetKey:asset.assetKey,displayName:asset.displayName} : null});
  const net = principal * ((asset.apyPct / 100 - f.borrowApr - incumbent.haircutPct / 100) * f.horizonSeconds / year)
    - c.roundTripUsd - queueCost;
  if (!finite(net) || !finite(queueCost)) return base;
  const result = {...base,estimatedNetUsd:net,roundTripUsd:c.roundTripUsd,observedDelaySeconds:delay,queueCostUsd:queueCost};
  if (delay > f.maxQueueSeconds || queueCost > f.maxQueueCostUsd) return {...result,reason:'queue_limit',message:'Observed withdrawal delay exceeds the authorized carry limits.'};
  if (net <= 0) return {...result,action:'repay',reason:'negative_net_carry',message:'Measured costs outweigh estimated carry. Repay only from authorized liquid bot funds.'};
  if (incumbent.action !== 'park' && incumbent.reason !== 'hold_positive_carry') return {...result,action:'hold',reason:'thin_spread',message:'The measured spread is too thin for carry.'};
  return {...result,action:f.parkedAsset ? 'hold' : 'park',reason:f.parkedAsset ? 'preserve_parked' : 'positive_estimate',
    message:'Estimated floating carry after measured costs; returns and withdrawal timing are not guaranteed.'};
}
