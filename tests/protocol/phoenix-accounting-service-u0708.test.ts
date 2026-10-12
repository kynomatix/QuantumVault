import { describe, expect, it, vi } from 'vitest';
import { PhoenixAccountingService } from '../../server/protocol/phoenix/accounting-service';
import { event, snapshot, page, target, now, MemoryAccountingStore } from '../helpers/phoenix-accounting';
const fills=[event(1,'0','2'),event(2,'2','0',{grossPnlMicros:'100'})];
function setup() {
  const store=new MemoryAccountingStore(); const io={snapshot:vi.fn(async()=>snapshot()),history:vi.fn(async()=>page(fills))};
  return {store,io,service:new PhoenixAccountingService(store,io,()=>now)};
}
describe('Phoenix authoritative replay and restart',()=>{
  it('deduplicates overlapping pages and restarts with one closed epoch',async()=>{
    const {store,io,service}=setup();
    io.history.mockResolvedValueOnce(page([fills[1]],{hasMore:true,nextCursor:'EXAMPLE-next'}))
      .mockResolvedValueOnce(page(fills,{cursor:'EXAMPLE-next'}));
    expect((await service.reconcile(target)).synced).toBe(true);
    const first=structuredClone(store.state.epochs);
    expect((await new PhoenixAccountingService(store,io,()=>now).reconcile(target)).synced).toBe(true);
    expect(store.state.events).toHaveLength(2); expect(store.state.epochs).toEqual(first);
  });
  it.each([
    {indexedThroughSlot:'99'}, {complete:false as never}, {hasMore:true,nextCursor:null},
    {trader:'EXAMPLE-other'}, {cursor:'EXAMPLE-wrong'}, {throughSlot:'99'},
  ])('does not publish incomplete page %#',async patch=>{
    const {io,service,store}=setup(); io.history.mockResolvedValue(page(fills,patch));
    expect((await service.reconcile(target)).synced).toBe(false); expect(store.state.status).toBe('unknown');
  });
  it('rejects missing second page and repeated cursors',async()=>{
    const {io,service}=setup(); io.history.mockResolvedValueOnce(page([fills[0]],{hasMore:true,nextCursor:'EXAMPLE-next'})).mockRejectedValueOnce(new Error('404'));
    expect((await service.reconcile(target)).synced).toBe(false);
    io.history.mockResolvedValueOnce(page([fills[0]],{hasMore:true,nextCursor:'EXAMPLE-next'}))
      .mockResolvedValueOnce(page([fills[1]],{cursor:'EXAMPLE-next',hasMore:true,nextCursor:'EXAMPLE-next'}));
    expect((await service.reconcile(target)).synced).toBe(false);
  });
  it('marks retained evidence unknown after unavailable snapshot without erasing history',async()=>{
    const {io,service,store}=setup(); await service.reconcile(target); io.snapshot.mockRejectedValue(new Error('timeout'));
    expect((await service.reconcile(target)).synced).toBe(false); expect(store.state.status).toBe('unknown'); expect(store.state.epochs).toHaveLength(1);
  });
  it('rejects missing historical round trip even when snapshot is flat',async()=>{
    const {io,service,store}=setup(); await service.reconcile(target); io.history.mockResolvedValue(page([]));
    expect((await service.reconcile(target)).synced).toBe(false); expect(store.state.events).toHaveLength(2);
  });
  it('does not infer flat from delayed fills or stale snapshots',async()=>{
    const {io,service}=setup(); io.history.mockResolvedValue(page([fills[0]]));
    expect((await service.reconcile(target)).synced).toBe(false);
    io.snapshot.mockResolvedValue(snapshot({}, {observedAt:now-30000})); expect((await service.reconcile(target)).synced).toBe(false);
  });
  it('allows late numeric enrichment but rejects rewriting settled money',async()=>{
    const {io,service,store}=setup(); io.history.mockResolvedValueOnce(page([fills[0],{...fills[1],feeMicros:null}]));
    await service.reconcile(target); expect(store.state.epochs[0].netPnlMicros).toBeNull();
    await service.reconcile(target); expect(store.state.epochs[0].netPnlMicros).toBe('80');
    io.history.mockResolvedValue(page([fills[0],{...fills[1],feeMicros:'11'}])); expect((await service.reconcile(target)).synced).toBe(false);
  });
  it('a losing concurrent replay cannot invalidate a winning checkpoint',async()=>{
    const {service,store}=setup(); const results=await Promise.all([service.reconcile(target),service.reconcile(target)]);
    expect(results.filter(r=>r.synced)).toHaveLength(1); expect(store.state.status).toBe('complete');
  });
});
