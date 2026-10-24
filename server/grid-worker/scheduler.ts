export interface WorkerWork {
  existing(signal:AbortSignal):Promise<void>;
  lifecycle(signal:AbortSignal):Promise<void>;
  reconcile(signal:AbortSignal):Promise<boolean>;
  startOne(signal:AbortSignal):Promise<void>;
}
/** One pass, one Start, no detached money promises. Renewal has its own lane/timer. */
export class WorkerScheduler {
  private controller:AbortController|null=null;
  private running:Promise<void>|null=null;
  private closed=false;
  constructor(private readonly work:WorkerWork,private readonly canEnter:()=>boolean){}
  pass():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.running)return this.running;
    const controller=new AbortController();this.controller=controller;
    const deadline=setTimeout(()=>controller.abort(Error('GRID_PASS_TIMEOUT')),30000);
    this.running=(async()=>{
      await this.work.existing(controller.signal);controller.signal.throwIfAborted();
      await this.work.lifecycle(controller.signal);controller.signal.throwIfAborted();
      const clean=await this.work.reconcile(controller.signal);controller.signal.throwIfAborted();
      if(clean&&!this.closed&&this.canEnter())await this.work.startOne(controller.signal);
    })().finally(()=>{clearTimeout(deadline);this.controller=null;this.running=null;});
    return this.running;
  }
  async stop(){this.closed=true;this.controller?.abort();await this.running;}
}
