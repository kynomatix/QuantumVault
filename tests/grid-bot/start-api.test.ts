import {afterEach,describe,expect,it,vi} from 'vitest';
import express,{type Request} from 'express';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
vi.mock('../../server/grid-planner/default-deps',()=>({defaultPlannerDeps:{}}));
vi.mock('../../server/grid-bot/draft-default-deps',()=>({}));
import {registerGridBotRoutes} from '../../server/grid-bot/draft-routes';
import {gridFlag,gridRuntimeGates,gridWorkerState} from '../../server/grid-bot/service';
import {GridStorageError} from '../../server/grid-bot/storage';
import type {GridStartRequest,GridStartResult} from '../../shared/grid-start';

afterEach(()=>{gridWorkerState(false);vi.unstubAllEnvs();});
const expected:GridStartRequest={draftRevision:'EXAMPLE_REVISION',serverIntentDigest:'A'.repeat(64)};
async function withApi(env:NodeJS.ProcessEnv,run:(url:string,start:ReturnType<typeof vi.fn>)=>Promise<void>){
  const start=vi.fn(async(wallet:string,id:string,_expected:GridStartRequest,_signal:AbortSignal):Promise<GridStartResult>=>{
    if(wallet!=='EXAMPLE_OWNER')throw new GridStorageError('not_found');
    return {launchId:id,state:'pending'};
  });
  const app=express();app.use(express.json());
  registerGridBotRoutes(app,(req,res,next)=>{const wallet=req.headers['x-wallet'];if(typeof wallet!=='string'){res.sendStatus(401);return;}
    (req as Request&{walletAddress:string}).walletAddress=wallet;next();},{deps:{} as never,storage:{} as never,enabled:()=>env.GRID_BOT_ENABLED==='true',gates:()=>gridRuntimeGates(env),start});
  const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));
  try{await run('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/grid-bots',start);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
const headers={'content-type':'application/json','x-wallet':'EXAMPLE_OWNER'};
describe('C7 guarded Start and independent release flags',()=>{
  it.each([undefined,'','false','TRUE','True','1',' true','true ','on','yes'])('rejects ambiguous flag %s',value=>expect(gridFlag(value)).toBe(false));
  it('enables only exact true and defaults off',()=>{expect(gridFlag('true')).toBe(true);expect(gridRuntimeGates({})).toMatchObject({startConfigured:false,startEnabled:false,workerEnabled:false,workerRunning:false});});
  it('requires a running worker and draft access before admitting new Starts',()=>{
    const env={GRID_BOT_ENABLED:'true',GRID_START_ENABLED:'true',GRID_WORKER_ENABLED:'true'};
    expect(gridRuntimeGates(env).startEnabled).toBe(false);gridWorkerState(true);expect(gridRuntimeGates(env).startEnabled).toBe(true);
    expect(gridRuntimeGates({...env,GRID_BOT_ENABLED:'false'}).startEnabled).toBe(false);
  });
  it.each([{}, {GRID_WORKER_ENABLED:'true'}, {GRID_START_ENABLED:'true'}, {GRID_BOT_ENABLED:'true',GRID_START_ENABLED:'true',GRID_WORKER_ENABLED:'TRUE'}, {GRID_BOT_ENABLED:'true',GRID_WORKER_ENABLED:'true'}])('off gates never call financial Start: %j',async env=>{
    gridWorkerState(true);await withApi(env,async(url,start)=>{
      expect((await fetch(url+'/'+randomUUID()+'/start',{method:'POST',headers,body:JSON.stringify(expected)})).status).toBe(503);expect(start).not.toHaveBeenCalled();
    });
  });
  it('authenticates before Start, scopes owner, validates strict retained identity and returns stable launch id',async()=>{
    gridWorkerState(true);await withApi({GRID_BOT_ENABLED:'true',GRID_START_ENABLED:'true',GRID_WORKER_ENABLED:'true'},async(url,start)=>{
      const id=randomUUID(),post=(body:unknown,h:Record<string,string>=headers)=>fetch(url+'/'+id+'/start',{method:'POST',headers:h,body:JSON.stringify(body)});
      expect((await post(expected,{'content-type':'application/json'})).status).toBe(401);expect(start).not.toHaveBeenCalled();
      for(const body of [{},{...expected,account:'EXAMPLE_OVERRIDE'},{...expected,serverIntentDigest:'EXAMPLE'},{...expected,draftRevision:' EXAMPLE'}])expect((await post(body)).status).toBe(400);
      expect(start).not.toHaveBeenCalled();expect((await post(expected,{...headers,'x-wallet':'EXAMPLE_OTHER'})).status).toBe(404);
      const reply=await post(expected);expect(reply.status).toBe(202);expect(reply.headers.get('cache-control')).toBe('no-store');expect(await reply.json()).toEqual({launchId:id,state:'pending'});
      expect(start).toHaveBeenLastCalledWith('EXAMPLE_OWNER',id,expected,expect.any(AbortSignal));
    });
  });
  it('reports a running worker with Start off',async()=>{
    gridWorkerState(true);await withApi({GRID_WORKER_ENABLED:'true'},async(url,start)=>{
      const result=await fetch(url+'/status',{headers});expect(await result.json()).toMatchObject({workerEnabled:true,workerRunning:true,startEnabled:false});expect(start).not.toHaveBeenCalled();
    });
  });
});
