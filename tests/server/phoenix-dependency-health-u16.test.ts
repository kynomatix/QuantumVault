import { beforeEach, describe, expect, it, vi } from 'vitest';
describe('U16 cached dependency health',()=>{
  beforeEach(()=>vi.resetModules());
  it('does not equate public API health or SDK pin with custody readiness',async()=>{
    const h = await import('../../server/dependency-health-record');
    h.recordPhoenixPublicHealth('api',1000,1000); h.recordPhoenixPublicHealth('ws',1000,1000);
    const s=h.phoenixDependencyHealth(1000);
    expect(s.api.state).toBe('fresh'); expect(s.ws.state).toBe('fresh'); expect(s.rpc.state).toBe('unknown');
    expect(s.venueReady).toBe(false); expect(s.custodyReady).toBe(false); expect(s.unresolvedJournals).toBeNull();
    expect(s.sdk.verification).toBe('pin_only');
  });
  it('sanitizes a complete cohort sample, expires counts, distinguishes zero queue from unknown',async()=>{
    const h=await import('../../server/dependency-health-record');
    h.recordPhoenixPublicHealth('api',1000,1000);
    h.recordPhoenixCustodyHealth({complete:true,observedAt:1000,rpcObservedAt:1000,eligibility:'eligible',queueCount:0,executionBindingsReady:true,custodyVerified:true,
      queueOldestAt:null,queueDrops:0,unresolvedJournals:0,protectionGaps:0,debtHealth:'healthy',
      ownerWallet:'EXAMPLE-private-owner',rawError:'EXAMPLE-private-error'} as any,1000);
    expect(h.phoenixDependencyHealth(1000).venueReady).toBe(true);
    expect(JSON.stringify(h.phoenixDependencyHealth(1000))).not.toContain('EXAMPLE-private');
    const stale=h.phoenixDependencyHealth(121000); expect(stale.aggregate.state).toBe('stale');
    expect(stale.venueReady).toBe(false); expect(stale.queue.count).toBeNull(); expect(stale.debtHealth).toBe('unknown');
  });
  it('reports queue age/drops and protection/debt attention without changing application liveness',async()=>{
    const h=await import('../../server/dependency-health-record');
    h.recordPhoenixCustodyHealth({complete:true,observedAt:1000,rpcObservedAt:1000,eligibility:'gated',queueCount:1,executionBindingsReady:false,custodyVerified:false,
      queueOldestAt:500,queueDrops:1,unresolvedJournals:2,protectionGaps:1,debtHealth:'attention'},1000);
    const s=h.phoenixDependencyHealth(1000); expect(s.queue.oldestAgeMs).toBe(500); expect(s.queue.drops).toBe(1);
    expect(s.venueReady).toBe(false); expect(s.protectionGaps).toBe(1);
  });
  it('refuses partial or impossible samples rather than inventing healthy zeroes',async()=>{
    const h=await import('../../server/dependency-health-record');
    h.recordPhoenixCustodyHealth({complete:false} as any,1000);
    expect(h.phoenixDependencyHealth(1000).queue.count).toBeNull();
    h.recordPhoenixPublicHealth('ws',2000,1000);expect(h.phoenixDependencyHealth(1000).ws.state).toBe('unknown');
  });
});
