import {installRescuePageLifetime} from '../../client/src/lib/grid-worker-rescue-lifetime';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {GridWorkerCache} from '../../client/src/lib/grid-worker-cache';
import {GridWorkerActions} from '../../client/src/lib/grid-worker-actions';
import {GridWorkerRescueDriver,type RescueTransport} from '../../client/src/lib/grid-worker-rescue-driver';
import {fixtureId,status} from '../helpers/grid-worker-u5b-fixtures';
import {rescue} from '../helpers/grid-worker-u6b-fixtures';
const botId=fixtureId(2),nonce=bs58.encode(new Uint8Array(32).fill(9));
const requestKeyHash=createHash('sha256').update(nonce).digest('hex');
const paramsDigest=createHash('sha256').update(JSON.stringify({botId})).digest('hex');
const challenge={message:['QV-OWNER-ACTION v1','action:break_glass_close','scope:grid_worker','target:bot:'+botId,'nonce:'+nonce,'issued:2026-10-25T00:00:00.000Z','expires:2026-10-25T00:02:00.000Z','params:'+paramsDigest].join('\n')};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const resources:{dispose:()=>void}[]=[];
function setup(transport:RescueTransport,body=status({rescueOffers:[{botId,trigger:'worker_unavailable',blockedBy:null}]})){
  const cache=new GridWorkerCache('EXAMPLE',async()=>({status:200,body}),()=>Date.now()),driver=new GridWorkerRescueDriver(cache,transport,()=>Date.now());resources.push(cache,driver);return {cache,driver};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{for(const r of resources.splice(0))r.dispose();vi.useRealTimers();});
describe('U6b local driver generations and serialization',()=>{
  it('navigation and visibility join one in-flight step; a scheduled wait is cancelled on focus',async()=>{
    const flight=deferred<{status:number;body:unknown}>(),post=vi.fn(()=>flight.promise);
    const {cache,driver}=setup(post,status({rescue:rescue()}));await cache.refresh();driver.continueHere();
    const joined=driver.focus();expect(driver.focus()).toBe(joined);expect(post).toHaveBeenCalledTimes(1);
    const release=driver.retain(),next=driver.retain();release();await Promise.resolve();expect(driver.snapshot().driving).toBe(true);
    flight.resolve({status:200,body:{rescue:rescue()}});await joined;
    post.mockImplementation(async()=>({status:200,body:{rescue:rescue({live:false,next:'done',phase:'complete',completedSeconds:0})}}));
    await driver.focus();await vi.advanceTimersByTimeAsync(3000);expect(post).toHaveBeenCalledTimes(2);expect(driver.snapshot().driving).toBe(false);next();
  });
  it('wallet change during signing prevents the old start, and another owner action shares the signature gate',async()=>{
    const ready=deferred<void>(),signed=deferred<Uint8Array>();let current=true;
    const post=vi.fn(async()=>({status:200,body:challenge})),{cache,driver}=setup(post);
    const start=driver.start(botId,async()=>{ready.resolve();return signed.promise;},()=>current);await ready.promise;
    const otherPost=vi.fn();await new GridWorkerActions(cache,otherPost).run('pause','all',vi.fn(),()=>true);expect(otherPost).not.toHaveBeenCalled();
    current=false;driver.dispose();signed.resolve(new Uint8Array(64));await start;expect(post).toHaveBeenCalledTimes(1);expect(cache.snapshot().busy).toBe(false);
  });
  it.each(['action','target','params'])('rejects altered %s before asking for a signature',async field=>{
    const altered=challenge.message.replace(field==='action'?'action:break_glass_close':field==='target'?'target:bot:'+botId:'params:'+paramsDigest,field+':EXAMPLE');
    const {driver}=setup(async()=>({status:200,body:{message:altered}})),sign=vi.fn();await driver.start(botId,sign,()=>true);expect(sign).not.toHaveBeenCalled();
  });
  it('an older GET cannot overwrite a newer terminal step or clear a newer pending GET',async()=>{
    const old=deferred<{status:number;body:unknown}>(),newer=deferred<{status:number;body:unknown}>();let calls=0;
    const cache=new GridWorkerCache('EXAMPLE',()=>++calls===1?Promise.resolve({status:200,body:status({rescue:rescue()})}):calls===2?old.promise:newer.promise);resources.push(cache);
    await cache.refresh();const pending=cache.refresh();const terminal=rescue({live:false,next:'done',phase:'complete',completedSeconds:0});expect(cache.acceptRescueStep(terminal)).toBe(true);
    const latest=cache.refresh();old.resolve({status:200,body:status({rescue:rescue()})});await pending;expect(cache.refresh()).toBe(latest);expect(cache.snapshot().status?.rescue?.phase).toBe('complete');
    newer.resolve({status:200,body:status({rescue:rescue()})});await latest;expect(cache.snapshot().status?.rescue?.phase).toBe('complete');expect(cache.snapshot().overlay).toBe('stale');
  });
  it('recovers a lost start by exact request key, never replays the start, and does not accept a different attempt',async()=>{
    let found=false;const post=vi.fn(async(path:string)=>{
      if(path==='/challenge')return {status:200,body:challenge};
      if(path==='/rescue')throw Error('EXAMPLE');
      if(path.startsWith('/rescue?'))return {status:200,body:{rescue:found?rescue({requestKey:requestKeyHash}):rescue()}};
      return {status:200,body:{rescue:rescue({requestKey:requestKeyHash})}};
    });
    const {driver}=setup(post);await driver.start(botId,async()=>new Uint8Array(64),()=>true);
    expect(driver.snapshot().mode).toBe('uncertain');expect(driver.locked(botId)).toBe(true);
    await driver.start(botId,vi.fn(),()=>true);found=true;await driver.recover();expect(driver.snapshot().driving).toBe(true);
    expect(post.mock.calls.filter(([path])=>path==='/rescue')).toHaveLength(1);expect(post.mock.calls.filter(([path])=>path.startsWith('/rescue?')).every(([path])=>path==='/rescue?requestKey='+requestKeyHash)).toBe(true);
  });
  it('Continue here requires fifteen seconds, freshness and a live envelope; unknown display phases still run',async()=>{
    const post=vi.fn(async()=>({status:200,body:{next:'wait',retryAfterSeconds:2}})),{cache,driver}=setup(post,status({rescue:rescue({stepIdleSeconds:14,phase:'EXAMPLE_UNKNOWN'})}));
    await cache.refresh();driver.continueHere();expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);cache.tick();driver.continueHere();await driver.focus();expect(post).toHaveBeenCalledTimes(1);
    driver.dispose();const stale=setup(post,status({rescue:rescue()}));await stale.cache.refresh();stale.cache.update({overlay:'stale'});stale.driver.continueHere();expect(post).toHaveBeenCalledTimes(1);
  });
  it('a delayed start response from a disposed wallet cannot revive the driver',async()=>{
    const sent=deferred<void>(),response=deferred<{status:number;body:unknown}>();const post=vi.fn(async(path:string)=>{if(path==='/challenge')return {status:200,body:challenge};sent.resolve();return response.promise;});
    const {driver}=setup(post);const starting=driver.start(botId,async()=>new Uint8Array(64),()=>true);await sent.promise;driver.dispose();response.resolve({status:200,body:{started:true,rescue:rescue({requestKey:requestKeyHash})}});await starting;expect(driver.snapshot().driving).toBe(false);
  });
  it('a denial erases owner data and stops driving',async()=>{
    const {cache,driver}=setup(async()=>({status:404,body:null}),status({rescue:rescue()}));await cache.refresh();driver.continueHere();await driver.focus();expect(cache.snapshot().admitted).toBe(false);expect(cache.snapshot().status).toBeNull();expect(driver.snapshot().driving).toBe(false);
  });
});

it('late wake locks cannot revive an old attempt; refusal and unsupported APIs are tolerated',async()=>{
  const page=new EventTarget(),visibility=Object.assign(new EventTarget(),{visibilityState:'visible'}),pending=deferred<{release:()=>Promise<void>}>(),release=vi.fn(async()=>{});
  const cleanup=installRescuePageLifetime(page,visibility,{wakeLock:{request:()=>pending.promise}});
  const leaving=new Event('beforeunload',{cancelable:true});page.dispatchEvent(leaving);expect(leaving.defaultPrevented).toBe(true);
  cleanup();pending.resolve({release});await Promise.resolve();await Promise.resolve();expect(release).toHaveBeenCalledTimes(1);
  const later=new Event('beforeunload',{cancelable:true});page.dispatchEvent(later);expect(later.defaultPrevented).toBe(false);
  const unsupported=installRescuePageLifetime(page,visibility,{});unsupported();
  const refused=installRescuePageLifetime(page,visibility,{wakeLock:{request:async()=>{throw Error('EXAMPLE');}}});await Promise.resolve();refused();
});
it('releases wake lock on hiding and requests it again on becoming visible',async()=>{
  const page=new EventTarget(),visibility=Object.assign(new EventTarget(),{visibilityState:'visible'}),release=vi.fn(async()=>{}),request=vi.fn(async()=>({release}));
  const cleanup=installRescuePageLifetime(page,visibility,{wakeLock:{request}});await Promise.resolve();
  visibility.visibilityState='hidden';visibility.dispatchEvent(new Event('visibilitychange'));expect(release).toHaveBeenCalledTimes(1);
  visibility.visibilityState='visible';visibility.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();expect(request).toHaveBeenCalledTimes(2);cleanup();expect(release).toHaveBeenCalledTimes(2);
});

it('a countdown reaching zero requests status instead of inferring completion',async()=>{
  const body=status({rescue:rescue({leaseRemainingSeconds:1,expiresInSeconds:600})}),read=vi.fn(async()=>({status:200,body}));
  const cache=new GridWorkerCache('EXAMPLE',read,()=>Date.now());resources.push(cache);await cache.refresh();
  await vi.advanceTimersByTimeAsync(1000);cache.tick();expect(read).toHaveBeenCalledTimes(2);expect(cache.snapshot().status?.rescue?.live).toBe(true);
  await cache.refresh();expect(cache.snapshot().status?.rescue?.phase).not.toBe('complete');
});
