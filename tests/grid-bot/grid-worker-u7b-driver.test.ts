import {afterEach,describe,expect,it,vi} from 'vitest';
import {GridWorkerCache} from '../../client/src/lib/grid-worker-cache';
import {GridWorkerControlsDriver,controlOffer} from '../../client/src/lib/grid-worker-controls-driver';
import {validWorkerChallenge} from '../../client/src/lib/grid-worker-view';
import type {WorkerPost} from '../../client/src/lib/grid-worker-actions';
import {controlsState,challenge} from '../helpers/grid-worker-u7b-fixtures';
import type {ControlKind} from '../../client/src/lib/grid-worker-controls-state';
const resources:{dispose:()=>void}[]=[];
afterEach(()=>{for(const r of resources.splice(0))r.dispose();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function setup(kind:ControlKind='handover',override?:WorkerPost){
  let body=controlsState(kind).status!,readStatus=200,time=0;
  const request=controlOffer(controlsState(kind),kind)!.request;
  const post=vi.fn(override??(async(path:string)=>({status:200,body:path==='/challenge'?challenge(request):{outcome:'saved',saved:true,blockedBy:null}})));
  const cache=new GridWorkerCache('EXAMPLE',async()=>({status:readStatus,body:structuredClone(body)})),driver=new GridWorkerControlsDriver(cache,post,()=>time);resources.push(driver,cache);await cache.refresh();
  return {cache,driver,post,request,setBody:(next:typeof body)=>{body=next;},failRead:()=>{readStatus=503;},expire:()=>{time=120001;}};
}
describe('U7b signature and receipt driver',()=>{
  it.each(['handover','trading','renewal'] as const)('signs one validated %s and reports only proven success',async kind=>{
    const {cache,driver,post}=await setup(kind);const sign=vi.fn(async()=>new Uint8Array(64));await driver.open(kind,()=>true);expect(cache.snapshot().control?.phase).toBe('confirming');
    await driver.sign(sign,()=>true);expect(sign).not.toHaveBeenCalled();driver.check(true);await driver.sign(sign,()=>true);expect(sign).toHaveBeenCalledTimes(1);expect(cache.snapshot().control?.phase).toBe('saved');expect(post).toHaveBeenCalledTimes(2);
  });
  it('invalidates checkbox and transcript when offer changes',async()=>{
    const {cache,driver}=await setup();await driver.open('handover',()=>true);driver.check(true);const next=controlsState();next.status!.hostTransitionOffer!.params.expectedFencingEpoch='9';cache.update({status:next.status});expect(cache.snapshot().control).toMatchObject({phase:'idle',checked:false,message:null});
  });
  it.each(['stale','failed-read','expired','changed'])('does not sign after %s pre-sign evidence',async reason=>{
    const s=await setup();await s.driver.open('handover',()=>true);s.driver.check(true);
    if(reason==='stale')s.cache.update({elapsedSeconds:61});if(reason==='failed-read')s.failRead();if(reason==='expired')s.expire();if(reason==='changed'){const p=controlsState().status!;p.hostTransitionOffer!.params.expectedFencingEpoch='2';s.setBody(p);}
    const sign=vi.fn();await s.driver.sign(sign,()=>true);expect(sign).not.toHaveBeenCalled();
  });
  it('never joins a GET begun before the signature mutex',async()=>{
    const old=deferred<{status:number;body:unknown}>(),body=controlsState().status!;let reads=0;
    const cache=new GridWorkerCache('EXAMPLE',async()=>++reads===2?old.promise:{status:200,body}),request=controlOffer(controlsState(),'handover')!.request;
    const driver=new GridWorkerControlsDriver(cache,async()=>({status:200,body:challenge(request)}));resources.push(driver,cache);await cache.refresh();const pending=cache.refresh();
    await driver.open('handover',()=>true);expect(reads).toBe(2); // checking disables open
    old.resolve({status:200,body});await pending;await driver.open('handover',()=>true);expect(reads).toBe(3);expect(cache.snapshot().control?.phase).toBe('confirming');
  });
  it.each(['action','target','params','nonce','issued','expires'])('rejects altered challenge %s',async field=>{
    const request=controlOffer(controlsState(),'handover')!.request,message=challenge(request).message.replace(new RegExp('^'+field+':.*$','m'),field+':EXAMPLE');
    const {cache,driver}=await setup('handover',async()=>({status:200,body:{message}}));await driver.open('handover',()=>true);expect(cache.snapshot().control?.phase).toBe('refused');expect(await validWorkerChallenge({message},request)).toBe(false);
  });
  it('rejects mutated numerical policy fields even with an unchanged claimed digest',async()=>{
    const request=controlOffer(controlsState('renewal'),'renewal')!.request,c=challenge(request);(request.policies![0] as {total_units:string}).total_units='1001';expect(await validWorkerChallenge(c,request)).toBe(false);
  });
  it('discards wallet changes and captured-offer changes during signing',async()=>{
    for(const change of ['wallet','offer']){const {cache,driver,post}=await setup();await driver.open('handover',()=>true);driver.check(true);let current=true;
      await driver.sign(async()=>{if(change==='wallet')current=false;else{const p=controlsState().status!;p.hostTransitionOffer!.params.expectedFencingEpoch='7';cache.update({status:p});}return new Uint8Array(64);},()=>current);
      expect(post).toHaveBeenCalledTimes(1);expect(cache.snapshot().busy).toBe(false);expect(cache.snapshot().control?.phase).toBe('refused');}
  });
  it('serializes signing with other controls and permits only Pause after an unknown send',async()=>{
    let proven=false;const request=controlOffer(controlsState(),'handover')!.request;
    const s=await setup('handover',async path=>path==='/challenge'?{status:200,body:challenge(request)}:path==='/action-result'&&proven?{status:200,body:{saved:true,outcome:'saved',blockedBy:null}}:{status:503,body:null});
    await s.driver.open('handover',()=>true);s.driver.check(true);const entered=deferred<void>(),signed=deferred<Uint8Array>();const pending=s.driver.sign(async()=>{entered.resolve();return signed.promise;},()=>true);await entered.promise;expect(s.cache.acquireSignature('pause')).toBeNull();signed.resolve(new Uint8Array(64));await pending;
    expect(s.cache.snapshot().control?.phase).toBe('unknown');expect(s.cache.acquireSignature()).toBeNull();const release=s.cache.acquireSignature('pause');expect(release).not.toBeNull();release!();
    await s.driver.open('handover',()=>true);await s.driver.recover(()=>true);expect(s.cache.snapshot().control?.phase).toBe('unknown');proven=true;await s.driver.recover(()=>true);expect(s.cache.snapshot().control?.phase).toBe('saved');expect(s.post.mock.calls.filter(([path])=>path==='/host-transition')).toHaveLength(1);
  });
  it.each([400,409,500])('untyped HTTP %s stays unknown rather than inventing refusal',async status=>{
    const request=controlOffer(controlsState(),'handover')!.request,s=await setup('handover',async path=>path==='/challenge'?{status:200,body:challenge(request)}:{status,body:{error:'EXAMPLE'}});await s.driver.open('handover',()=>true);s.driver.check(true);await s.driver.sign(async()=>new Uint8Array(64),()=>true);expect(s.cache.snapshot().control?.phase).toBe('unknown');
  });
  it('accepts only closed, proven refusals and clears private owner data on denial',async()=>{
    for(const status of [409,404]){const request=controlOffer(controlsState(),'handover')!.request,s=await setup('handover',async path=>path==='/challenge'?{status:200,body:challenge(request)}:{status,body:{outcome:'refused',saved:false,blockedBy:'not_flat'}});await s.driver.open('handover',()=>true);s.driver.check(true);await s.driver.sign(async()=>new Uint8Array(64),()=>true);if(status===404)expect(s.cache.snapshot().admitted).toBe(false);else expect(s.cache.snapshot().control?.phase).toBe('refused');}
  });
  it('allows the rescue confirmation to replace the card confirmation',async()=>{
    const s=await setup();await s.driver.open('handover',()=>true);s.driver.check(true);s.cache.update({confirmation:'rescue'});expect(s.cache.snapshot().confirmation).toBe('rescue');expect(s.cache.snapshot().control).toMatchObject({checked:false,phase:'idle'});
  });
  it('blocks controls on a locally unknown rescue and retains through strict effect replay',async()=>{
    const s=await setup();s.cache.update({rescueUncertain:true});await s.driver.open('handover',()=>true);expect(s.post).not.toHaveBeenCalled();expect(s.cache.acquireSignature()).toBeNull();s.cache.update({rescueUncertain:false});const release=s.driver.retain(),keep=s.driver.retain();release();await Promise.resolve();await s.driver.open('handover',()=>true);expect(s.cache.snapshot().control?.phase).toBe('confirming');keep();
  });
});
