import {cardStates,currentPause,decimalCompare,parseWorkerStatus,type WorkerPresentation,type WorkerStatus} from './grid-worker-view';
export type WorkerRead=(signal:AbortSignal)=>Promise<{status:number;body:unknown}>;
const initial=():WorkerPresentation=>({status:null,admitted:false,overlay:'none',elapsedSeconds:0,target:null,outcome:null,notice:'',busy:false});
/** One query owner; card and drawer subscribe to this same wallet-scoped cache. */
export class GridWorkerCache {
  private value=initial();private listeners=new Set<()=>void>();private controller:AbortController|null=null;
  private pending:Promise<WorkerStatus|null>|null=null;private receivedAt:number|null=null;private nextPoll=Infinity;
  private disposed=false;private denied=false;private knownOwner=false;
  private leases=0;private pauseBaseline:string|null=null;private resumedAt:number|null=null;private resumeNotice='';
  constructor(readonly wallet:string,private read:WorkerRead,private now=()=>performance.now()){}
  snapshot=()=>this.value;
  retain(){this.leases++;return()=>{this.leases--;queueMicrotask(()=>{if(this.leases===0)this.dispose();});};}
  pauseStarted(revision:string){this.pauseBaseline=revision;}
  resumed(notice:string){this.resumedAt=this.now();this.resumeNotice=notice;}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  update(patch:Partial<WorkerPresentation>){if(this.disposed)return;this.value={...this.value,...patch};for(const l of this.listeners)l();}
  tick(){
    if(this.disposed||this.denied)return;
    if(this.receivedAt!==null){const elapsedSeconds=Math.max(0,(this.now()-this.receivedAt)/1000);
      this.update({elapsedSeconds,...(elapsedSeconds>=60?{overlay:'stale' as const}:{})});}
    if(this.now()>=this.nextPoll)void this.refresh();
  }
  refresh=():Promise<WorkerStatus|null>=>{
    if(this.disposed||this.denied)return Promise.resolve(null);
    if(this.pending)return this.pending;
    const controller=new AbortController();this.controller=controller;
    const timeout=setTimeout(()=>controller.abort(),30_000);
    if(this.value.admitted&&!this.value.busy)this.update({overlay:'checking'});
    this.pending=(async()=>{
      try{
        const result=await this.read(controller.signal);if(this.disposed)return null;
        if(result.status===200){
          const status=parseWorkerStatus(result.body);if(!status)throw Error('Invalid status');
          this.knownOwner=true;this.receivedAt=this.now();
          let outcome=this.value.outcome;
          if(outcome?.saved==='unknown'&&currentPause(status,outcome.pauseRevision)&&this.pauseBaseline!==null&&(decimalCompare(status.pauseRevision,this.pauseBaseline)??-1)>0)
            outcome={...outcome,saved:true,pauseRevision:status.pauseRevision};
          this.update({status,outcome,admitted:true,elapsedSeconds:0,
            ...(this.resumedAt!==null&&this.now()-this.resumedAt<=30_000&&status.entriesPaused?{notice:this.resumeNotice}:{}),
            overlay:cardStates.includes(status.cardState as typeof cardStates[number])?(this.value.busy?this.value.overlay:outcome?.saved==='unknown'?'save_unknown':'none'):'stale'});
          return status;
        }
        if(!this.knownOwner&&result.status===404){this.denied=true;this.update(initial());return null;}
        if(this.knownOwner||result.status===503||result.status===409){this.knownOwner=true;this.update({admitted:true,overlay:'stale'});}
        return null;
      }catch{if(this.knownOwner)this.update({overlay:'stale'});return null;}
      finally{clearTimeout(timeout);this.pending=null;this.controller=null;this.nextPoll=this.knownOwner?this.now()+(this.value.busy?2000:30000):Infinity;}
    })();return this.pending;
  };
  accelerate(){this.nextPoll=this.now()+2000;}
  dispose(){this.disposed=true;this.controller?.abort();this.value=initial();this.listeners.clear();}
}
