import {describe,it,expect,vi} from 'vitest';
import bs58 from 'bs58';
import {GridWorkerCache} from '../../client/src/lib/grid-worker-cache';
import {GridWorkerActions} from '../../client/src/lib/grid-worker-actions';
import {validWorkerChallenge} from '../../client/src/lib/grid-worker-view';
import {auditGridWorkerCopy} from '../../script/grid-worker-copy-audit';
import {status,fixtureId,incident} from '../helpers/grid-worker-u5b-fixtures';
const challenge=(action='pause',target='all',expectedPauseRevision='3')=>({expectedPauseRevision,message:['QV-OWNER-ACTION v1','action:'+action,'scope:grid_worker','target:'+target,
  'nonce:'+bs58.encode(new Uint8Array(32).fill(9)),'issued:2026-10-25T00:00:00.000Z','expires:2026-10-25T00:02:00.000Z','params:none'].join('\n')});
describe('U5b wallet-scoped status and signed actions',()=>{
  it('one status request serves concurrent subscribers and a first 404 stops polling and focus reads',async()=>{
    const read=vi.fn(async()=>({status:404,body:null}));const c=new GridWorkerCache('EXAMPLE',read,()=>100000);
    await Promise.all([c.refresh(),c.refresh()]);c.tick();await c.refresh();expect(read).toHaveBeenCalledTimes(1);expect(c.snapshot().admitted).toBe(false);c.dispose();
  });
  it('survives StrictMode effect replay without a second status query',async()=>{
    const read=vi.fn(async()=>({status:200,body:status()})),c=new GridWorkerCache('EXAMPLE',read);
    const release=c.retain();const first=c.refresh();release();const again=c.retain();await c.refresh();await first;
    expect(read).toHaveBeenCalledTimes(1);expect(c.snapshot().status).not.toBeNull();again();await Promise.resolve();
  });
  it('clears owner state across later denial',async()=>{
    let now=0,code=200;const c=new GridWorkerCache('EXAMPLE',async()=>({status:code,body:status()}),()=>now);
    await c.refresh();now=61000;code=404;c.tick();await c.refresh();expect(c.snapshot().status).toBeNull();expect(c.snapshot().admitted).toBe(false);c.dispose();
  });
  it.each([503,409])('admits the stale first-load shell for %s',async code=>{const c=new GridWorkerCache('EXAMPLE',async()=>({status:code,body:null}));await c.refresh();expect(c.snapshot()).toMatchObject({admitted:true,overlay:'stale',status:null});c.dispose();});
  it('keeps an uncertain save unknown across polls until a newer currently paused revision is observed',async()=>{
    let current=status();const c=new GridWorkerCache('EXAMPLE',async()=>({status:200,body:current}));await c.refresh();c.pauseStarted('3');
    c.update({outcome:{saved:'unknown',pauseRevision:null,acknowledgementOutcome:'not_confirmed'}});await c.refresh();expect(c.snapshot().overlay).toBe('save_unknown');
    current=status({pauseRevision:'4',entriesPaused:false});await c.refresh();expect(c.snapshot().overlay).toBe('save_unknown');
    current=status({pauseRevision:'5',entriesPaused:true});await c.refresh();expect(c.snapshot().outcome?.saved).toBe(true);c.dispose();
  });
  it.each(['action','target','revision','params','ttl'])('refuses an altered challenge %s before wallet signing',async variant=>{
    const c=new GridWorkerCache('EXAMPLE',async()=>({status:200,body:status()}));const value=challenge();
    if(variant==='revision')value.expectedPauseRevision='4';else value.message=value.message.replace(variant==='action'?'action:pause':variant==='target'?'target:all':variant==='params'?'params:none':'00:02:00',''+(variant==='action'?'action:reset_pause':variant==='target'?'target:EXAMPLE':variant==='params'?'params:EXAMPLE':'00:03:00'));
    const post=vi.fn(async()=>({status:200,body:value})),sign=vi.fn(async()=>new Uint8Array(64));
    await new GridWorkerActions(c,post).run('pause','all',sign,()=>true);expect(sign).not.toHaveBeenCalled();expect(post).toHaveBeenCalledTimes(1);c.dispose();
  });
  it('locks from first click, captures the incident target, and encodes the exact wallet bytes',async()=>{
    const id=fixtureId(1),c=new GridWorkerCache('EXAMPLE',async()=>({status:200,body:status({incidents:[incident()]})}));
    let release!:(value:Uint8Array)=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
    const sign=vi.fn((bytes:Uint8Array)=>{expect(new TextDecoder().decode(bytes)).toBe(challenge('ack_critical','incident:'+id).message);entered();return new Promise<Uint8Array>(r=>release=r);});
    const post=vi.fn(async(path:string)=>({status:200,body:path==='/challenge'?challenge('ack_critical','incident:'+id):{acknowledged:true}}));
    const a=new GridWorkerActions(c,post),first=a.run('ack_critical','incident:'+id,sign,()=>true);await ready;
    await a.run('pause','all',sign,()=>true);expect(sign).toHaveBeenCalledTimes(1);release(new Uint8Array(64));await first;
    expect(post.mock.calls.map(x=>x[0])).toEqual(['/challenge','/incidents/'+id+'/ack']);c.dispose();
  });
  it.each(['revision','wallet','expired'])('does not POST after a signature %s race',async variant=>{
    let now=0,currentWallet=true;const c=new GridWorkerCache('EXAMPLE',async()=>({status:200,body:status()}));
    const post=vi.fn(async()=>({status:200,body:challenge()}));const a=new GridWorkerActions(c,post,()=>now);
    await a.run('pause','all',async()=>{if(variant==='revision')c.update({status:status({pauseRevision:'4'})});if(variant==='wallet')currentWallet=false;if(variant==='expired')now=110001;return new Uint8Array(64);},()=>currentWallet);
    expect(post).toHaveBeenCalledTimes(1);c.dispose();
  });
  it('rejects Resume after a fresh revision read says it is no longer paused',async()=>{
    const c=new GridWorkerCache('EXAMPLE',async()=>({status:200,body:status({pauseRevision:'4',entriesPaused:false})}));c.update({status:status({entriesPaused:true})});
    const post=vi.fn(),sign=vi.fn();await new GridWorkerActions(c,post).run('reset_pause','all',sign,()=>true);expect(post).not.toHaveBeenCalled();c.dispose();
  });
  it('checks exact wire and the build copy audit rejects injected prose',()=>{
    expect(validWorkerChallenge(challenge(),{action:'pause',target:'all',expectedPauseRevision:'3'})).toBe(true);
    expect(()=>auditGridWorkerCopy('const x=<p>Error: EXAMPLE</p>','EXAMPLE.tsx')).toThrow('GRID_STATUS_COPY_INVALID');
  });
});

describe('U5b action overlay freshness',()=>{
  it.each(['signing','pausing','resuming'] as const)('keeps %s until the action settles despite stale ticks and poll failures',async overlay=>{
    let now=0,code=200,body:unknown=status();
    const c=new GridWorkerCache('EXAMPLE',async()=>({status:code,body}),()=>now);
    await c.refresh();c.update({busy:true,overlay});now=61000;code=503;
    c.tick();await c.refresh();expect(c.snapshot()).toMatchObject({overlay,elapsedSeconds:61});
    code=200;body=status({cardState:'EXAMPLE_UNKNOWN'});await c.refresh();expect(c.snapshot().overlay).toBe(overlay);
    body=null;await c.refresh();expect(c.snapshot().overlay).toBe(overlay);
    c.update({busy:false});now=122000;c.tick();await c.refresh();expect(c.snapshot().overlay).toBe('stale');c.dispose();
  });
  it('applies stale after a real signed action settles with an unavailable final refresh',async()=>{
    let now=0,code=200;const c=new GridWorkerCache('EXAMPLE',async()=>({status:code,body:status()}),()=>now);
    const post=async(path:string)=>({status:200,body:path==='/challenge'?challenge():{saved:true,pauseRevision:'4',acknowledgementOutcome:'confirmed'}});
    await new GridWorkerActions(c,post,()=>now).run('pause','all',async()=>{
      now=61000;code=503;c.tick();await c.refresh();expect(c.snapshot().overlay).toBe('signing');return new Uint8Array(64);
    },()=>true);
    expect(c.snapshot()).toMatchObject({busy:false,target:null,overlay:'stale'});c.dispose();
  });
});
