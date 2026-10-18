import {describe,it,expect} from 'vitest';
import {gridAutoResumeBand,gridInsideAutoResumeBand,gridAutoResumeRetry,GRID_AUTO_RESUME_REASONS} from '../../server/grid-bot/auto-resume-policy';
import {gridAutoResumeView,gridVisibleActions,GRID_AUTO_RESUME_ATTENTION_MS} from '../../client/src/lib/grid-live-view';
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
  const surface=(reason:string|null='waiting_for_inner_band')=>({bot:{status:'range_exhausted',lowerPrice:'90',upperPrice:'110'},lifecycle:{action:'band'},authorities:{resume:true},mark:'111',observedAt:new Date(1000).toISOString(),workerRunning:true,startEnabled:true,autoResume:{enabled:true,generation:'1',cycle:'1',attempts:0,armed:true,heldReason:reason,heldSince:new Date(1000).toISOString(),available:true,band:{lower:'91.8',upper:'107.8',tick:'0.01'}}} as any);
  it('offers Pause while auto-resume is enabled so the owner can revoke waiting',()=>{const s=surface();s.authorities={resume:false};expect(gridVisibleActions(s)).toContain('pause');s.autoResume.enabled=false;expect(gridVisibleActions(s)).not.toContain('pause');});
  it('shows waiting only with affirmative current gates and facts',()=>{const s=surface();expect(gridAutoResumeView(s,1000)?.state).toBe('waiting');s.startEnabled=false;expect(gridAutoResumeView(s,1000)?.title).toBe('Resuming — checking safety');});
  it.each(GRID_AUTO_RESUME_REASONS)('maps internal reason %s without exposing it',(reason)=>{const result=gridAutoResumeView(surface(reason),1000);const expected=reason==='preference_off'?null:reason==='waiting_for_inner_band'?'waiting':['retry_limit','execution_revoked','policy_changed','risk_pause'].includes(reason)?'attention':'checking';expect(result?.state??null).toBe(expected);if(result)expect(JSON.stringify(result)).not.toContain(reason);});
  it.each(['reconciliation_required','operation_pending','market_data_unavailable','resume_authority_unavailable','stop_clearance_unavailable'])('escalates prolonged %s after ten minutes with one available action',(reason)=>{const s=surface(reason),at=1000+GRID_AUTO_RESUME_ATTENTION_MS;expect(gridAutoResumeView(s,at-1)?.state).toBe('checking');expect(gridAutoResumeView(s,at)).toMatchObject({title:'Needs your attention',action:'resume'});s.authorities.resume=false;expect(gridAutoResumeView(s,at)?.action).toBe('review');s.workerRunning=false;expect(gridAutoResumeView(s,at)?.action).toBe('review');});
  it('manual and risk pauses/stops use the normal view even with a stale arm',()=>{const s=surface();for(const status of ['paused','pausing','stopping','stopped']){s.bot.status=status;expect(gridAutoResumeView(s,1000)).toBeNull();}s.bot.status='range_exhausted';for(const action of ['pause','stop']){s.lifecycle.action=action;expect(gridAutoResumeView(s,1000)).toBeNull();}});
  it('narrow ranges use only the settings explanation; missing market data checks safety',()=>{const s=surface();s.autoResume.available=false;s.autoResume.unavailableReason='range_unavailable';expect(gridAutoResumeView(s,1000)).toBeNull();s.autoResume.unavailableReason='market_data_unavailable';expect(gridAutoResumeView(s,1000)?.state).toBe('checking');});
  it('does not show default-on waiting before arming, or for a manual Resume',()=>{const s=surface();s.autoResume.armed=false;expect(gridAutoResumeView(s,1000)).toBeNull();s.bot.status='resuming';s.lifecycle.action='resume';expect(gridAutoResumeView(s,1000)).toBeNull();s.autoResume.enabled=false;s.autoResume.armed=true;expect(gridAutoResumeView(s,1000)).toBeNull();});
});
