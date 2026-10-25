import {parseWorkerRescue} from './grid-worker-rescue-wire';
import {cardStates,currentPause,decimalCompare,parseWorkerStatus,type WorkerPresentation,type WorkerStatus} from './grid-worker-view';
export type WorkerRead=(signal:AbortSignal)=>Promise<{status:number;body:unknown}>;
const initial=():WorkerPresentation=>({status:null,admitted:false,overlay:'none',elapsedSeconds:0,target:null,outcome:null,notice:'',busy:false});
/** One query owner; card and drawer subscribe to this same wallet-scoped cache. */
let signatureInFlight=false;
export class GridWorkerCache {
  private value=initial();private listeners=new Set<()=>void>();private controller:AbortController|null=null;
  private pending:Promise<WorkerStatus|null>|null=null;private receivedAt:number|null=null;private nextPoll=Infinity;
  private readGeneration=0;private rescueReceivedAt:number|null=null;
  private disposed=false;private denied=false;private knownOwner=false;
  private leases=0;private pauseBaseline:string|null=null;private resumedAt:number|null=null;private resumeNotice='';
  constructor(readonly wallet:string,private read:WorkerRead,private now=()=>performance.now()){}
  snapshot=()=>this.value;
  retain(){this.leases++;return()=>{this.leases--;queueMicrotask(()=>{if(this.leases===0)this.dispose();});};}
  acquireSignature(action:'pause'|'other'='other'){if(this.disposed||signatureInFlight||action!=='pause'&&(this.value.rescueUncertain||this.value.control?.phase==='unknown'||this.value.outcome?.saved==='unknown'||this.value.status?.rescue?.unknownOpen))return null;signatureInFlight=true;this.update({busy:true});let released=false;return()=>{if(released)return;released=true;signatureInFlight=false;this.update({busy:false});};}
  clearOwner(){this.denied=true;this.knownOwner=false;this.readGeneration++;this.controller?.abort();this.pending=null;this.controller=null;this.update(initial());}
  pauseStarted(revision:string){this.pauseBaseline=revision;}
  resumed(notice:string){this.resumedAt=this.now();this.resumeNotice=notice;}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  update(patch:Partial<WorkerPresentation>){if(this.disposed)return;this.value={...this.value,...patch};for(const l of this.listeners)l();}
  tick(){
    if(this.disposed||this.denied)return;
    if(this.receivedAt!==null){const elapsedSeconds=Math.max(0,(this.now()-this.receivedAt)/1000);
      const rescueElapsedSeconds=this.rescueReceivedAt===null?elapsedSeconds:Math.max(0,(this.now()-this.rescueReceivedAt)/1000),priorElapsed=this.value.rescueElapsedSeconds??this.value.elapsedSeconds,rescue=this.value.status?.rescue;
      if(rescue?.live&&[rescue.expiresInSeconds,rescue.leaseRemainingSeconds,rescue.waitSeconds].some(seconds=>seconds!==null&&priorElapsed<seconds&&rescueElapsedSeconds>=seconds))this.nextPoll=this.now();
      this.update({elapsedSeconds,rescueElapsedSeconds,...(elapsedSeconds>=60&&!this.value.busy?{overlay:'stale' as const}:{})});}
    if(this.now()>=this.nextPoll)void this.refresh();
  }
  refresh=():Promise<WorkerStatus|null>=>{
    if(this.disposed||this.denied)return Promise.resolve(null);
    if(this.pending)return this.pending;
    const generation=++this.readGeneration;
    const controller=new AbortController();this.controller=controller;
    const timeout=setTimeout(()=>controller.abort(),30_000);
    if(this.value.admitted&&!this.value.busy)this.update({overlay:'checking'});
    this.pending=(async()=>{
      try{
        const result=await this.read(controller.signal);if(this.disposed||generation!==this.readGeneration)return null;
        if(result.status===200){
          const status=parseWorkerStatus(result.body);if(!status)throw Error('Invalid status');
          const prior=this.value.status?.rescue;
          if(prior&&!prior.live&&status.rescue?.requestId===prior.requestId&&status.rescue.live)throw Error('Conflicting rescue snapshot');
          this.knownOwner=true;this.receivedAt=this.now();this.rescueReceivedAt=this.now();
          let outcome=this.value.outcome;
          if(outcome?.saved==='unknown'&&currentPause(status,outcome.pauseRevision)&&this.pauseBaseline!==null&&(decimalCompare(status.pauseRevision,this.pauseBaseline)??-1)>0)
            outcome={...outcome,saved:true,pauseRevision:status.pauseRevision};
          this.update({status,outcome,admitted:true,elapsedSeconds:0,rescueElapsedSeconds:0,
            ...(this.resumedAt!==null&&this.now()-this.resumedAt<=30_000&&status.entriesPaused?{notice:this.resumeNotice}:{}),
            overlay:this.value.busy?this.value.overlay:cardStates.includes(status.cardState as typeof cardStates[number])?(outcome?.saved==='unknown'?'save_unknown':'none'):'stale'});
          return status;
        }
        if(result.status===404){this.clearOwner();return null;}
        if(this.knownOwner||result.status===503||result.status===409){this.knownOwner=true;this.update({admitted:true,...(!this.value.busy?{overlay:'stale' as const}:{})});}
        return null;
      }catch{if(generation===this.readGeneration&&this.knownOwner&&!this.value.busy)this.update({overlay:'stale'});return null;}
      finally{clearTimeout(timeout);if(this.controller===controller){this.pending=null;this.controller=null;}if(generation===this.readGeneration)this.nextPoll=this.knownOwner?this.now()+(this.value.status?.rescue?.live?3000:this.value.busy?2000:30000):Infinity;}
    })();return this.pending;
  };
  /** Signing requires a GET started after acquiring the mutex, never an older poll. */
  refreshForSignature=()=>{this.readGeneration++;this.controller?.abort();this.controller=null;this.pending=null;return this.refresh();};
  /** U6b's driver calls this after a session step; older GETs cannot undo its result. */
  acceptRescueStep(value:unknown,allowStart=false):boolean {
    const rescue=parseWorkerRescue(value);
    if(this.disposed||!rescue||!this.value.status||!allowStart&&this.value.status.rescue?.requestId!==rescue.requestId)return false;
    const prior=this.value.status.rescue;
    if(prior?.requestId===rescue.requestId&&!prior.live&&rescue.live)return false;
    this.readGeneration++;this.controller?.abort();this.controller=null;this.pending=null;this.rescueReceivedAt=this.now();
    this.update({status:{...this.value.status,rescue},rescueElapsedSeconds:0});
    this.nextPoll=this.now();return true;
  }
  accelerate(){this.nextPoll=this.now()+2000;}
  dispose(){this.disposed=true;this.controller?.abort();this.value=initial();this.listeners.clear();}
}
