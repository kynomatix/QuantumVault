import {describe,it,expect} from 'vitest';
import {gridAutoResumeBand,gridInsideAutoResumeBand,gridAutoResumeRetry} from '../../server/grid-bot/auto-resume-policy';
import {gridAutoResumeView,gridVisibleActions} from '../../client/src/lib/grid-live-view';
describe('buffered auto-resume policy',()=>{
  it('rounds both boundaries inward with decimal arithmetic and includes equality',()=>{
    const band=gridAutoResumeBand('90.01','110.03','0.05');
    expect(band).toEqual({lower:'91.85',upper:'107.8',tick:'0.05'});
    expect(gridInsideAutoResumeBand('91.85',band)).toBe(true);
    expect(gridInsideAutoResumeBand('107.8',band)).toBe(true);
    expect(gridInsideAutoResumeBand('91.849999999999999999999',band)).toBe(false);
    expect(gridInsideAutoResumeBand('107.800000000000000000001',band)).toBe(false);
  });
  it.each([['100','104','1'],['100','101','0.01'],['0','110','0.01'],['110','90','1'],['90','110','0'],['90','110','NaN'],['90','Infinity','1']])('fails closed for empty or invalid inner band %s/%s/%s',(l,u,t)=>expect(gridAutoResumeBand(l,u,t)).toBeNull());
  it('preserves tiny ticks without binary floating point rounding',()=>expect(gridAutoResumeBand('0.000000000000000001','0.000000000000000002','0.00000000000000000001')).toEqual({lower:'0.00000000000000000102',upper:'0.00000000000000000196',tick:'0.00000000000000000001'}));
  it('bounds the three durable evaluations at first, +15s, +60s and expires at +120s',()=>{
    expect(gridAutoResumeRetry(0,null,null,0)).toBe('ready');
    expect(gridAutoResumeRetry(1,0,15000,14999)).toBe('waiting');
    expect(gridAutoResumeRetry(1,0,15000,15000)).toBe('ready');
    expect(gridAutoResumeRetry(2,0,60000,59999)).toBe('waiting');
    expect(gridAutoResumeRetry(2,0,60000,60000)).toBe('ready');
    expect(gridAutoResumeRetry(3,0,null,60001)).toBe('exhausted');
    expect(gridAutoResumeRetry(1,0,15000,120000)).toBe('expired');
  });
});
describe('drawer auto-resume primary states',()=>{
  const surface=(reason:string|null='waiting_for_inner_band')=>({bot:{status:'range_exhausted',lowerPrice:'90',upperPrice:'110'},lifecycle:{action:'band'},mark:'111',observedAt:new Date(1000).toISOString(),workerRunning:true,startEnabled:true,autoResume:{enabled:true,generation:'1',cycle:'1',attempts:0,armed:true,heldReason:reason,available:true,band:{lower:'91.8',upper:'107.8',tick:'0.01'}}} as any);
  it('offers Pause while auto-resume is enabled so the owner can revoke waiting',()=>{const s=surface();s.authorities={resume:false};expect(gridVisibleActions(s)).toContain('pause');s.autoResume.enabled=false;expect(gridVisibleActions(s)).not.toContain('pause');});
  it('shows waiting only with affirmative current gates and facts',()=>{const s=surface();expect(gridAutoResumeView(s,1000)?.title).toBe('Waiting to auto-resume');expect(gridAutoResumeView(s,1000)?.badge).toBe('Above range');s.startEnabled=false;expect(gridAutoResumeView(s,1000)?.title).toBe('Safety check needs attention');});
  it.each([['reconciliation_required','Checking exchange state'],['operation_pending','Waiting for an operation to settle'],['retry_limit','Auto-resume held'],['execution_revoked','Auto-resume held'],['stop_clearance_unavailable','Safety check needs attention']])('shows one held reason %s',(reason,title)=>expect(gridAutoResumeView(surface(reason),1000)?.title).toBe(title));
  it('owner Pause wins and unavailable range differs from unknown market data',()=>{const s=surface();s.bot.status='paused';s.lifecycle.action='pause';s.autoResume.enabled=false;expect(gridAutoResumeView(s,1000)?.title).toBe('Paused by you');s.lifecycle.action='band';s.autoResume.available=false;s.autoResume.unavailableReason='range_unavailable';expect(gridAutoResumeView(s,1000)?.title).toBe('Auto-resume unavailable for this range');s.autoResume.enabled=true;s.autoResume.unavailableReason='market_data_unavailable';expect(gridAutoResumeView(s,1000)?.title).toBe('Safety check needs attention');});
});
