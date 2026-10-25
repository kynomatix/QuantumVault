import bs58 from 'bs58';
import {controlBlockers} from '../../../shared/grid-worker-controls';
import {GridWorkerCache} from './grid-worker-cache';
import {validWorkerChallenge} from './grid-worker-view';
import {controlCopy,controlLabels,refusedControl} from './grid-worker-controls-copy';
import {emptyControl,type ControlKind,type ControlState} from './grid-worker-controls-state';
import type {WorkerPost} from './grid-worker-actions';
import {controlOffer} from './grid-worker-controls-offer';
export {controlOffer} from './grid-worker-controls-offer';
const record=(v:unknown)=>v&&typeof v==='object'?v as Record<string,unknown>:{};
/** Wallet-scoped, memory-only identity. Only exact server receipt proof resolves an uncertain send. */
export class GridWorkerControlsDriver {
  private generation=0;private disposed=false;private arrived=0;private ttl=0;private flight=false;
  private unsubscribe:()=>void;
  constructor(private cache:GridWorkerCache,private post:WorkerPost,private now=()=>performance.now()){
    this.unsubscribe=cache.subscribe(()=>{
      const c=this.state();
      if(c.phase==='confirming'&&(cache.snapshot().confirmation!=='control'||controlOffer(cache.snapshot(),c.kind!)?.key!==c.offerKey))this.cancel(controlCopy.changed);
    });
  }
  private state(){return this.cache.snapshot().control??emptyControl;}
  private update(p:Partial<ControlState>){if(!this.disposed)this.cache.update({control:{...this.state(),...p}});}
  cancel(notice=''){
    if(this.flight||['signing','sending','unknown'].includes(this.state().phase))return;
    this.generation++;this.cache.update({control:{...emptyControl,notice},confirmation:this.cache.snapshot().confirmation==='control'?null:this.cache.snapshot().confirmation});
  }
  check(checked:boolean){if(this.state().phase==='confirming')this.update({checked});}
  async open(kind:ControlKind,current:()=>boolean){
    if(this.disposed||this.flight||this.state().phase==='unknown'||!current())return;
    const offer=controlOffer(this.cache.snapshot(),kind);if(!offer)return;const captured=structuredClone(offer);
    const release=this.cache.acquireSignature();if(!release)return;
    this.flight=true;const g=++this.generation,valid=()=>!this.disposed&&g===this.generation&&current();
    this.cache.update({confirmation:'control',control:{...emptyControl,kind,phase:'preparing',request:captured.request,offerKey:captured.key}});
    try{
      const fresh=await this.cache.refreshForSignature();if(!valid())return;if(!fresh)throw Error('prepare');
      if(controlOffer(this.cache.snapshot(),kind)?.key!==captured.key)throw Error('changed');
      const {policies,...request}=captured.request;
      const r=await this.post('/challenge',request);this.arrived=this.now();
      if(r.status===404){this.cache.clearOwner();return;}
      if(r.status!==200||!await validWorkerChallenge(r.body,captured.request))throw Error('prepare');
      if(!valid())return;
      if(controlOffer(this.cache.snapshot(),kind)?.key!==captured.key)throw Error('changed');
      const message=record(r.body).message as string,lines=message.split('\n');
      this.ttl=Math.min(110000,Date.parse(lines[6].slice(8))-Date.parse(lines[5].slice(7)));
      this.update({phase:'confirming',message,checked:false});
    }catch(e){if(valid())this.update({phase:'refused',checked:false,message:null,notice:e instanceof Error&&e.message==='changed'?controlCopy.changed:controlCopy.prepare});}
    finally{if(!this.disposed&&!valid())this.update({phase:'refused',checked:false,message:null,notice:controlCopy.changed});this.flight=false;release();}
  }
  async sign(sign:(bytes:Uint8Array)=>Promise<Uint8Array>,current:()=>boolean){
    const c=this.state();if(this.disposed||this.flight||c.phase!=='confirming'||!c.checked||!c.message||!c.request||!c.kind||!current())return;
    const release=this.cache.acquireSignature();if(!release)return;
    this.flight=true;const g=this.generation,valid=()=>!this.disposed&&g===this.generation&&current();let sent=false,signing=false;
    this.update({phase:'preparing'});
    const unchanged=()=>controlOffer(this.cache.snapshot(),c.kind!)?.key===c.offerKey;
    try{
      const fresh=await this.cache.refreshForSignature();if(!valid())return;if(!fresh)throw Error('prepare');
      if(!unchanged())throw Error('changed');
      if(this.now()-this.arrived>=this.ttl)throw Error('expired');
      if(!await validWorkerChallenge({message:c.message},c.request))throw Error('prepare');
      if(!valid())return;
      this.update({phase:'signing'});signing=true;
      const signature=bs58.encode(await sign(new TextEncoder().encode(c.message)));signing=false;
      if(!valid())return;
      if(this.now()-this.arrived>=this.ttl)throw Error('expired');
      if(!unchanged())throw Error('changed');
      const latest=await this.cache.refreshForSignature();if(!valid())return;if(!latest)throw Error('prepare');
      if(!unchanged())throw Error('changed');
      if(this.now()-this.arrived>=this.ttl)throw Error('expired');
      this.update({phase:'sending',checked:false});sent=true;
      const r=await this.post(c.kind==='renewal'?'/quota-policy':'/host-transition',{
        message:c.message,signature,...(c.kind==='renewal'?{policies:c.request.policies}:{params:c.request.params})});
      if(valid())this.accept(r);
    }catch(e){if(valid())this.update({phase:sent?'unknown':'refused',checked:false,notice:sent?controlCopy.unknown:signing?'You cancelled the signature.':e instanceof Error&&e.message==='expired'?controlCopy.expired:e instanceof Error&&e.message==='changed'?controlCopy.changed:controlCopy.prepare});}
    finally{if(!this.disposed&&!valid())this.update({phase:sent?'unknown':'refused',checked:false,notice:sent?controlCopy.unknown:controlCopy.changed});if(valid())await this.cache.refresh();this.flight=false;release();}
  }
  private accept(r:{status:number;body:unknown}){
    const b=record(r.body),c=this.state();
    if(r.status===404){this.cache.clearOwner();return;}
    if(r.status===200&&b.outcome==='saved'&&b.saved===true&&b.blockedBy===null)this.update({phase:'saved',notice:controlLabels[c.kind!].done,checked:false,message:null});
    else if((r.status===200||r.status===409)&&b.outcome==='refused'&&b.saved===false&&(controlBlockers as readonly unknown[]).includes(b.blockedBy))
      this.update({phase:'refused',notice:refusedControl(c.kind!,b.blockedBy as typeof controlBlockers[number]),checked:false,message:null});
    else this.update({phase:'unknown',notice:controlCopy.unknown,checked:false});
  }
  async recover(current:()=>boolean){
    const c=this.state();if(this.flight||this.disposed||c.phase!=='unknown'||!c.message||!c.request||!current())return;
    this.flight=true;const g=this.generation;
    try{const r=await this.post('/action-result',{message:c.message,params:c.request.params});if(!this.disposed&&g===this.generation&&current())this.accept(r);}
    catch{/* Unknown remains locked. */}
    finally{if(!this.disposed&&current())await this.cache.refresh();this.flight=false;}
  }
  private leases=0;
  retain(){this.leases++;return()=>{this.leases--;queueMicrotask(()=>{if(!this.leases)this.dispose();});};}
  dispose(){this.disposed=true;this.generation++;this.unsubscribe();}
}
