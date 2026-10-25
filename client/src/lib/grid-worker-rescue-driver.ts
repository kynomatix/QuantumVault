import bs58 from 'bs58';
import {GridWorkerCache} from './grid-worker-cache';
import {validWorkerChallenge} from './grid-worker-view';
import {parseWorkerRescue,type WorkerRescue} from './grid-worker-rescue-wire';
import {rescueCopy,rescueRefusals,rescueTriggers,rescueStale} from './grid-worker-rescue-copy';
import {emptyRescueDriver,type RescueDriverState} from './grid-worker-rescue-state';
export {emptyRescueDriver,type RescueDriverState} from './grid-worker-rescue-state';
export type RescueTransport=(path:string,body?:unknown)=>Promise<{status:number;body:unknown}>;
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
/** Wallet lifetime, independent of navigation. Only a signature or explicit Continue authorizes this page. */
export class GridWorkerRescueDriver {
  private value={...emptyRescueDriver};private listeners=new Set<()=>void>();private generation=0;private disposed=false;
  private signedNonce:string|null=null;private request:WorkerRescue|null=null;private requestKey:string|null=null;private flight:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;private recovering:Promise<void>|null=null;
  constructor(private cache:GridWorkerCache,private transport:RescueTransport,private now=()=>performance.now()){}
  snapshot=()=>this.value;
  private leases=0;
  retain(){this.leases++;return()=>{this.leases--;queueMicrotask(()=>{if(!this.leases)this.dispose();});};}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(p:Partial<RescueDriverState>){if(this.disposed)return;this.value={...this.value,...p};this.cache.update({rescueUncertain:this.value.mode==='uncertain'});for(const fn of this.listeners)fn();}
  private current(g:number){return !this.disposed&&g===this.generation;}
  private cancelTimer(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;}
  private denied(){this.generation++;this.cancelTimer();this.request=null;this.requestKey=null;this.signedNonce=null;this.cache.clearOwner();this.update({...emptyRescueDriver});}
  private accept(r:WorkerRescue){
    if(this.requestKey!==r.requestKey||this.value.botId!==r.botId)return false;
    if(this.request&&!this.request.live&&this.request.requestId===r.requestId&&r.live)return false;
    const cached=this.cache.snapshot().status?.rescue;
    if(cached?.requestId===r.requestId&&!cached.live&&r.live)return false;
    if(!this.cache.acceptRescueStep(r,true))return false;this.request=r;
    this.update({mode:'idle',driving:r.live});if(!r.live)this.cancelTimer();return true;
  }
  async start(botId:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>,walletCurrent:()=>boolean){
    if(this.disposed||this.value.driving||!['idle','refused'].includes(this.value.mode)||!walletCurrent())return;
    const release=this.cache.acquireSignature();if(!release)return;
    const g=++this.generation;this.cancelTimer();this.request=null;this.requestKey=null;this.signedNonce=null;
    const valid=()=>this.current(g)&&walletCurrent();let sent=false,signing=false;
    this.update({botId,mode:'preparing',notice:''});
    try{
      const s=await this.cache.refresh();if(!valid())return;
      const offer=s?.rescueOffers?.find(o=>o.botId===botId);
      if(!s||s.executionMode!=='external'||!offer||offer.blockedBy||!Object.hasOwn(rescueTriggers,offer.trigger)||s.rescue?.live||s.rescue?.unknownOpen||rescueStale(this.cache.snapshot()))throw Error('prepare');
      const challenge=await this.transport('/challenge',{action:'break_glass_close',target:'bot:'+botId,params:{botId}});
      const arrived=this.now();if(!valid())return;
      if(challenge.status===404){this.denied();return;}
      if(challenge.status!==200||!await validWorkerChallenge(challenge.body,{action:'break_glass_close',target:'bot:'+botId,params:{botId}})||!valid())throw Error('prepare');
      const message=record(challenge.body).message as string;
      const nonce=message.split('\n')[4].slice(6);this.signedNonce=nonce;
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(this.signedNonce));if(!valid())return;
      this.requestKey=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
      this.update({mode:'signing'});signing=true;
      const signature=bs58.encode(await sign(new TextEncoder().encode(message)));signing=false;if(!valid())return;
      if(this.now()-arrived>110000)throw Error('expired');
      this.update({mode:'starting',notice:rescueCopy.starting});sent=true;
      const response=await this.transport('/rescue',{botId,message,signature});if(!valid())return;
      const body=record(response.body);
      if(response.status===404){this.denied();return;}
      const r=parseWorkerRescue(body.rescue);
      if(response.status===200&&body.started===true&&r&&this.accept(r)){
        this.update({notice:''});if(r.live)void this.step();
      }else if(body.started===false){this.requestKey=null;this.signedNonce=null;this.update({mode:'refused',notice:Object.hasOwn(rescueRefusals,String(body.refusal))?rescueRefusals[String(body.refusal)]:rescueRefusals.unknown});}
      else{this.update({mode:'uncertain',notice:rescueCopy.uncertain});await this.recover();}
    }catch(e){if(valid()){
      if(sent){this.update({mode:'uncertain',notice:rescueCopy.uncertain});await this.recover();}
      else{this.requestKey=null;this.signedNonce=null;this.update({mode:'refused',notice:signing?rescueCopy.cancelled:e instanceof Error&&e.message==='expired'?rescueCopy.expired:rescueCopy.prepare});}
    }}finally{release();}
  }
  recover=():Promise<void>=>{
    if(this.recovering)return this.recovering;
    if(!this.requestKey||this.disposed)return Promise.resolve();
    const key=this.requestKey,g=this.generation;
    this.recovering=(async()=>{try{
      const response=await this.transport('/rescue?requestKey='+encodeURIComponent(key));if(!this.current(g))return;
      if(response.status===404){this.denied();return;}
      const r=parseWorkerRescue(record(response.body).rescue);
      if(response.status===200&&r&&this.accept(r)){this.update({notice:r.live?rescueCopy.recovered:''});if(r.live)this.schedule(0);}
      // A missing exact lookup is not proof of refusal. Never unlock another signature.
    }catch{/* Keep the attempt identity and conservative lock. */}finally{this.recovering=null;}})();return this.recovering;
  };
  continueHere=()=>{
    const p=this.cache.snapshot(),r=p.status?.rescue;
    if(this.disposed||p.busy||p.control?.phase==='unknown'||p.outcome?.saved==='unknown'||p.rescueUncertain||this.value.driving||!['idle','refused'].includes(this.value.mode)||!r?.live||r.stepIdleSeconds===null||r.stepIdleSeconds+(p.rescueElapsedSeconds??p.elapsedSeconds)<15||rescueStale(p))return;
    this.generation++;this.request=r;this.requestKey=r.requestKey;this.update({botId:r.botId,mode:'idle',driving:true,notice:''});void this.step();
  };
  private schedule(seconds:number){this.cancelTimer();if(this.value.driving)this.timer=setTimeout(()=>{this.timer=null;void this.step();},seconds*1000);}
  focus=()=>{this.cancelTimer();if(this.value.driving)return this.step();if(this.value.mode==='uncertain')return this.recover();return Promise.resolve();};
  step=():Promise<void>=>{
    if(this.flight)return this.flight;
    if(this.disposed||!this.value.driving||!this.request?.live)return Promise.resolve();
    this.cancelTimer();const g=this.generation,r=this.request;
    this.flight=(async()=>{let delay=2;try{
      const response=await this.transport('/rescue/'+r.requestId+'/step',{});if(!this.current(g))return;
      if(response.status===404){this.denied();return;}
      const body=record(response.body),next=parseWorkerRescue(body.rescue??body);
      if(response.status===200&&next&&next.requestId===r.requestId&&this.accept(next)){this.update({notice:''});delay=next.next==='wait'?next.retryAfterSeconds:0;}
      else if(response.status===409){
        this.update({notice:body.refusal==='superseded'?rescueCopy.superseded:rescueCopy.unknownPhase});
        await this.recover();if(this.current(g))await this.cache.refresh();
      }else if(response.status===200&&body.next==='wait'&&Number.isInteger(body.retryAfterSeconds)&&Number(body.retryAfterSeconds)>=1&&Number(body.retryAfterSeconds)<=10){delay=Number(body.retryAfterSeconds);}
      else this.update({notice:rescueCopy.stepUnavailable});
    }catch{if(this.current(g))this.update({notice:rescueCopy.stepUnavailable});}
    finally{this.flight=null;if(this.current(g)&&this.value.driving)this.schedule(delay);}})();return this.flight;
  };
  locked(botId:string){return this.value.botId===botId&&(this.value.driving||['preparing','signing','starting','uncertain'].includes(this.value.mode));}
  dispose(){this.generation++;this.disposed=true;this.cancelTimer();this.requestKey=null;this.signedNonce=null;this.request=null;this.value={...emptyRescueDriver};this.listeners.clear();}
}
