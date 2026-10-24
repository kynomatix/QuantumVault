import bs58 from 'bs58';
import {GridWorkerCache} from './grid-worker-cache';
import {cardStates,currentPause,decimalCompare,validWorkerChallenge,type PauseOutcome,type WorkerAction} from './grid-worker-view';
import {outcomeCopy,resumeReason} from './grid-worker-copy';
export type WorkerPost=(path:string,body:unknown)=>Promise<{status:number;body:unknown}>;
/** One controller per wallet cache. Capture targets before any await; never use a row index. */
export class GridWorkerActions {
  private locked=false;
  constructor(private cache:GridWorkerCache,private post:WorkerPost,private now=()=>performance.now()){}
  async run(action:WorkerAction,target:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>,isWalletCurrent:()=>boolean){
    if(this.locked||!isWalletCurrent())return;
    if(action==='ack_critical'?!/^incident:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target):target!=='all')return;
    this.locked=true;const captured={action,target};let sent=false,signing=false;let beforeRevision:string|null=null;
    this.cache.update({busy:true,target:captured,notice:'',outcome:null});this.cache.accelerate();
    try{
      const current=await this.cache.refresh();if(!current||!isWalletCurrent())throw Error('prepare');
      beforeRevision=current.pauseRevision;
      if(action==='reset_pause'&&(!currentPause(current)||resumeReason(current,false)))throw Error('changed');
      if(action==='ack_critical'&&!current.incidents.some(i=>'incident:'+i.id===target&&i.canAcknowledge&&!i.acknowledged))throw Error('prepare');
      const request={...captured,expectedPauseRevision:beforeRevision};
      const challenge=await this.post('/challenge',request);const arrived=this.now();
      if(challenge.status!==200||!validWorkerChallenge(challenge.body,request)||!isWalletCurrent()||this.cache.snapshot().status?.pauseRevision!==beforeRevision)throw Error('prepare');
      this.cache.update({overlay:'signing'});signing=true;
      const signature=bs58.encode(await sign(new TextEncoder().encode(challenge.body.message)));signing=false;
      if(!isWalletCurrent())return;
      if(this.now()-arrived>110_000)throw Error('expired');
      if(this.cache.snapshot().status?.pauseRevision!==beforeRevision)throw Error('changed');
      this.cache.update({overlay:action==='pause'?'pausing':action==='reset_pause'?'resuming':'none'});
      sent=true;
      if(action==='pause')this.cache.pauseStarted(beforeRevision);
      const path=action==='pause'?'/pause':action==='reset_pause'?'/reset-pause':'/incidents/'+target.slice(9)+'/ack';
      const response=await this.post(path,{message:challenge.body.message,signature,...(action==='reset_pause'?{expectedPauseRevision:beforeRevision}:{})});
      if(!isWalletCurrent())return;
      if(action==='pause'){
        const body=response.body as Partial<PauseOutcome>|null;
        const outcome:PauseOutcome={saved:body?.saved===true?true:body?.saved===false?false:'unknown',
          acknowledgementOutcome:['confirmed','not_required','timeout'].includes(body?.acknowledgementOutcome??'')?body!.acknowledgementOutcome!:'not_confirmed',pauseRevision:typeof body?.pauseRevision==='string'?body.pauseRevision:null};
        this.cache.update({outcome,overlay:outcome.saved==='unknown'?'save_unknown':'none',notice:outcome.saved===false?outcomeCopy.refused:''});
      }else if(response.status!==200)throw Error(action==='reset_pause'?'changed':'ackFailed');
      else if(action==='reset_pause')this.cache.resumed(outcomeCopy.repaused);
    }catch(error){
      if(!isWalletCurrent())return;
      const code=error instanceof Error?error.message:'';
      if(action==='pause'&&sent)this.cache.update({overlay:'save_unknown',outcome:{saved:'unknown',acknowledgementOutcome:'not_confirmed',pauseRevision:null}});
      else this.cache.update({overlay:'none',notice:signing?(action==='pause'?outcomeCopy.pauseCancelled:action==='reset_pause'?outcomeCopy.resumeCancelled:outcomeCopy.ackCancelled):outcomeCopy[code as keyof typeof outcomeCopy]??(action==='ack_critical'?outcomeCopy.ackFailed:outcomeCopy.prepare)});
    }finally{
      if(isWalletCurrent()){
        const outcome=this.cache.snapshot().outcome;
        const latest=await this.cache.refresh();
        if(isWalletCurrent()){
          const provesPause=!!latest&&currentPause(latest,outcome?.pauseRevision)&&
            (outcome?.saved===true||beforeRevision!==null&&(decimalCompare(latest.pauseRevision,beforeRevision)??-1)>0);
          if(action==='pause'&&outcome?.saved==='unknown'&&!provesPause)this.cache.update({overlay:'save_unknown'});
          if(provesPause&&outcome?.saved==='unknown')this.cache.update({outcome:{...outcome,saved:true,pauseRevision:latest!.pauseRevision}});
          this.cache.update({busy:false,target:null,overlay:this.cache.snapshot().outcome?.saved==='unknown'?'save_unknown':latest&&cardStates.includes(latest.cardState as typeof cardStates[number])?'none':'stale'});
        }
      }
      this.locked=false;
    }
  }
  async seen(ids:readonly string[]){if(ids.length)try{await this.post('/incidents/seen',{ids});}catch{/* Seen-only is best effort; no signed action is implied. */}}
}
