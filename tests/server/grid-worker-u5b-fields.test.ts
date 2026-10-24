import {describe,it,expect} from 'vitest';
import {ownerCardState,executionRestrictions,type AdminFacts} from '../../server/grid-worker/admin-state';
import {checksFresh} from '../../server/grid-worker/status';
import {pauseSaveOutcome} from '../../server/grid-worker/admin-routes';
const facts=():AdminFacts=>({host:{execution_mode:'external',execution_enabled:true,run_mode:'trading',holder_role:'grid-worker',holder_live:true,heartbeat_online:true,heartbeat_fresh:true,progress_fresh:true,authority_tracking_enabled:true,entries_paused:false},catalog:true,identity:true,history:true,ownerKeys:true,unacknowledged:false,unresolved:false,protective:false,pauseUnconfirmed:false,botChecksFresh:true});
describe('U5b additive server truth',()=>{
  it.each(['external','legacy'])('carries every restriction independently in %s',mode=>{
    const f=facts();Object.assign(f.host,{execution_mode:mode,execution_enabled:false,run_mode:'test',drain_requested:true});f.unacknowledged=true;
    expect(executionRestrictions(f)).toEqual(['trading_off','test','drain']);expect(ownerCardState(f,[])).toBe('exec_off');
    f.host.execution_enabled=true;expect(ownerCardState(f,[])).toBe('needs_you');expect(executionRestrictions(f)).toEqual(['test','drain']);
  });
  it('uses the exact public-health boundary for running',()=>{
    expect(checksFresh([null],100000)).toBe(false);expect(checksFresh([100001],100000)).toBe(false);
    expect(checksFresh([55000],100000)).toBe(false);expect(checksFresh([55001],100000)).toBe(true);
    const f=facts();expect(ownerCardState(f,[])).toBe('running');f.botChecksFresh=false;expect(ownerCardState(f,[])).toBe('attention_checks');
  });
  it('separates persisted, unknown and rejected saves from acknowledgement and true elapsed timeout',()=>{
    expect(pauseSaveOutcome(false,undefined,30000)).toEqual({saved:false,acknowledgementOutcome:'not_confirmed'});
    expect(pauseSaveOutcome(true,undefined,30000)).toEqual({saved:'unknown',acknowledgementOutcome:'not_confirmed'});
    expect(pauseSaveOutcome(true,'4',19999)).toEqual({saved:true,acknowledgementOutcome:'not_confirmed'});
    expect(pauseSaveOutcome(true,'4',20000)).toEqual({saved:true,acknowledgementOutcome:'timeout'});
  });
});
