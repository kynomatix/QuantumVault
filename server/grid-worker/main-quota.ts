import type {QuotaPolicy, QuotaProvider} from './quota';
// Owner confirms published max machines <= this assumption before U7.
export const MAIN_AUTOSCALE_INSTANCE_CAP_ASSUMED = 4;
export function mainAllocation(total: number, worker: number): number {
  return Number.isSafeInteger(total) && Number.isSafeInteger(worker) && total > worker && worker > 0
    ? Math.floor((total-worker)/MAIN_AUTOSCALE_INSTANCE_CAP_ASSUMED) : 0;
}
interface LocalWindow {policy: QuotaPolicy; observedAt: number; used: number; start: number; backoff: number; debits:{at:number;units:number;until:number}[]}
export class MainQuota {
  private warmUntil=new Map<QuotaProvider,number>();
  constructor(private quarantineFirstWindow=false){}
  private windows = new Map<QuotaProvider,LocalWindow>();
  private enabled=new Set<QuotaProvider>();
  install(policies: readonly QuotaPolicy[], now = Date.now()) {
    const next = new Map<QuotaProvider,LocalWindow>();
    this.enabled.clear();
    for (const policy of policies) {
      if (policy.domain_id !== 'deployment' || next.has(policy.provider)) { return; }
      const old=this.windows.get(policy.provider);
      if(this.quarantineFirstWindow&&!this.warmUntil.has(policy.provider))this.warmUntil.set(policy.provider,now+policy.window_ms);
      // Policy edits cannot refund already spent units in the current window.
      next.set(policy.provider,{policy,observedAt:now,used:old?.used??0,start:old?.start??now,backoff:old?.backoff??0,debits:old?.debits??[]});
    }
    for(const [provider,window] of next){this.windows.set(provider,window);this.enabled.add(provider);}
  }
  debit(provider: QuotaProvider, units: number, now = Date.now()) {
    const w=this.windows.get(provider);
    if (now<(this.warmUntil.get(provider)??0) || !w || !this.enabled.has(provider) || now<w.observedAt || now-w.observedAt>=10000 || !(now<new Date(w.policy.valid_until).getTime())
      || now<w.backoff || !/^[a-f0-9]{64}$/.test(w.policy.policy_digest) || !Number.isSafeInteger(units) || units<1) throw Error('GRID_MAIN_QUOTA_UNAVAILABLE');
    const duration=w.policy.window_ms;
    if (!Number.isSafeInteger(duration)||duration<1||now<w.start) throw Error('GRID_MAIN_QUOTA_UNAVAILABLE');
    // A sliding window cannot overspend any fixed provider window.
    w.debits=w.debits.filter(d=>now<d.until);w.used=w.debits.reduce((sum,d)=>sum+d.units,0);
    const limit=mainAllocation(Number(w.policy.total_units),Number(w.policy.worker_limit_units));
    if(limit<1||w.used+units>limit)throw Error('GRID_MAIN_QUOTA_UNAVAILABLE');
    w.used+=units;w.debits.push({at:now,units,until:now+duration});
  }
  rateLimited(provider: QuotaProvider, now=Date.now()){const w=this.windows.get(provider);if(w)w.backoff=now+60000;}
}
export const mainQuota = new MainQuota(true);
export function debitMainQuota(provider: QuotaProvider, units = 1) {
  if(process.env.GRID_REMOTE_WORKER_ENABLED==='true' && process.env.QV_PROCESS_ROLE!=='grid-worker')mainQuota.debit(provider,units);
}
