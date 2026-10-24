import {GridLaunchTransientError} from './launch-storage-core';
import type {GridMonitorClaim,GridMonitorStorage} from './monitor-storage';
export interface GridMonitorDeps {
  storage:Pick<GridMonitorStorage,'claim'|'release'|'block'>;
  tick:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<void>;
  report:(event:{kind:'bot_failure'|'cycle_failure'|'quota_pause';botId?:string})=>void;
  now?:()=>number;
}
/** One completion-scheduled supervisor, serial across bots; never detach timed-out money work. */
export class GridMonitor {
  private timer:ReturnType<typeof setTimeout>|null=null;
  private running:Promise<void>|null=null;
  private stopped=true;
  private controller:AbortController|null=null;
  private lastStart=-Infinity;
  constructor(private deps:GridMonitorDeps){}
  private report(kind:'bot_failure'|'cycle_failure'|'quota_pause',botId?:string){try{this.deps.report({kind,botId});}catch{/* Telemetry cannot silence supervision. */}}
  start(){if(!this.stopped)return;this.stopped=false;this.schedule(0);}
  private schedule(ms:number){if(!this.stopped)this.timer=setTimeout(()=>{this.timer=null;this.running=this.cycle().finally(()=>{this.running=null;this.schedule(15000);});},ms);}
  async stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;this.controller?.abort();await this.running;}
  async cycle(){const visited:string[]=[],masters=new Map<string,number>();
    try {for(let i=0;i<2&&!this.stopped;i++){
      const claim=await this.deps.storage.claim(visited);if(!claim)break;visited.push(claim.id);
      try {if((masters.get(claim.masterAccount)??0)>=2)continue;
        const wait=Math.max(0,1000-((this.deps.now?.()??Date.now())-this.lastStart));if(wait)await new Promise<void>(resolve=>setTimeout(resolve,wait));
        if(this.stopped)break;this.lastStart=this.deps.now?.()??Date.now();masters.set(claim.masterAccount,(masters.get(claim.masterAccount)??0)+1);
        this.controller=new AbortController();const controller=this.controller,timer=setTimeout(()=>controller.abort(),60000);
        try{await this.deps.tick(claim,controller.signal);}finally{clearTimeout(timer);this.controller=null;}
      }catch(error){try{await this.deps.storage.block(claim,error instanceof GridLaunchTransientError?'quota_unavailable':'monitor_failure');}catch{}
        if(error instanceof GridLaunchTransientError){this.report('quota_pause',claim.id);break;}this.report('bot_failure',claim.id);
      }finally{await this.deps.storage.release(claim);}
    }}catch{this.report('cycle_failure');}
  }
}
