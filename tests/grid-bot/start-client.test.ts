import {describe,expect,it,vi} from 'vitest';
import {gridDraftStartIdentity,gridStartConfirmation,submitGridStart} from '../../client/src/lib/grid-start-view';
import {gridCanAdjust,gridLaunchState,gridVisibleActions} from '../../client/src/lib/grid-live-view';
import {gridSetupAccess} from '../../client/src/lib/grid-setup-view';
import {gridSurface} from '../../server/grid-bot/surface';
const expected={draftRevision:'EXAMPLE_REVISION',serverIntentDigest:'A'.repeat(64)};
const surface=()=>gridSurface({bot:{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction:'long',status:'active',lowerPrice:'90',upperPrice:'110',gridCount:20,updatedAt:new Date(),createIntent:{}},levels:[],operations:[]},null,null,{pending:0,uncertain:0});
describe('C7 owner Start and controls',()=>{
  it('binds Start to the retained revision and intent, with no client authority fields',()=>{expect(gridDraftStartIdentity({id:'EXAMPLE',...expected})).toEqual({id:'EXAMPLE',expected});expect(gridDraftStartIdentity({id:'EXAMPLE'})).toBeNull();});
  it('recovers a lost HTTP reply with one read and no automatic second POST',async()=>{
    const send=vi.fn().mockRejectedValueOnce(Error('EXAMPLE lost reply')).mockResolvedValueOnce({bot:{id:'EXAMPLE',status:'provisioning'},startDraft:expected});
    expect(await submitGridStart('EXAMPLE',expected,send)).toMatchObject({launchId:'EXAMPLE',state:'pending'});expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(['/api/grid-bots/EXAMPLE/start',{method:'POST',body:JSON.stringify(expected)}]);expect(send.mock.calls[1]).toEqual(['/api/grid-bots/EXAMPLE/surface']);
  });
  it.each(['draft',undefined])('does not manufacture admission from unresolved read %s',async status=>{const send=vi.fn().mockRejectedValueOnce(Error('EXAMPLE lost reply')).mockResolvedValueOnce({bot:{id:'EXAMPLE',status}});await expect(submitGridStart('EXAMPLE',expected,send)).rejects.toThrow('lost reply');expect(send).toHaveBeenCalledTimes(2);});
  it('does not recover a different signed draft as the confirmed launch',async()=>{const send=vi.fn().mockRejectedValueOnce(Error('EXAMPLE conflict')).mockResolvedValueOnce({bot:{id:'EXAMPLE',status:'active'},startDraft:{...expected,draftRevision:'EXAMPLE_CHANGED'}});await expect(submitGridStart('EXAMPLE',expected,send)).rejects.toThrow('conflict');});
  it('requires both gates for the live setup button',()=>{for(const drafts of [false,true])for(const start of [false,true])for(const worker of [false,true])expect(gridSetupAccess(true,drafts,start,worker).live).toBe(drafts&&start&&worker);});
  it('hides controls without a worker, permits safety controls without new Starts, and gives Stop priority',()=>{
    const s=surface();s.workerRunning=false;expect(gridVisibleActions(s)).toEqual([]);expect(gridCanAdjust(s)).toBe(false);
    s.workerRunning=true;s.authorities.resume=true;s.startEnabled=false;expect(gridVisibleActions(s)).toEqual(['pause','stop']);expect(gridCanAdjust(s)).toBe(false);
    s.bot.status='paused';expect(gridVisibleActions(s)).toEqual(['resume','resync','stop']);s.authorities.resume=false;expect(gridVisibleActions(s)).toEqual(['resync','stop']);
    s.bot.status='stopping';expect(gridVisibleActions(s)).toEqual(['stop']);expect(gridLaunchState(s)).toContain('Stop pending');
    s.startEnabled=true;s.bot.status='active';expect(gridCanAdjust(s)).toBe(true);
  });
  it('describes funding, first orders and uncertain settlement in plain words',()=>{
    expect(gridStartConfirmation('100',true)).toContain('full $100');expect(gridStartConfirmation('100',true)).toContain('starting position');expect(gridStartConfirmation('100',false)).toContain('A deposit alone does not start');
    const s=surface();s.bot.status='provisioning';s.operations=[{id:'EXAMPLE',type:'fund_subaccount',state:'unconfirmed'}];expect(gridLaunchState(s)).toBe('Funding isolated account; awaiting exchange confirmation');
    s.operations=[{id:'EXAMPLE',type:'place_level_order',state:'prepared'}];expect(gridLaunchState(s)).toBe('Placing order; prepared');s.bot.status='stopping';expect(gridLaunchState(s)).toContain('settlement');
  });
});
