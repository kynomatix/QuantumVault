import {describe,it,expect,vi} from 'vitest';
import express from 'express';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
vi.mock('../../server/grid-planner/default-deps',()=>({defaultPlannerDeps:{}}));
vi.mock('../../server/grid-bot/draft-default-deps',()=>({}));
import {registerGridBotRoutes} from '../../server/grid-bot/draft-routes';
import {GridStorageError} from '../../server/grid-bot/storage';
describe('Grid owner controls while entry gates are disabled',()=>{
  it('authenticates, validates strict identity, scopes owner, and accepts all four controls with no venue action',async()=>{
    const request=vi.fn(async(wallet:string,_bot:string,_key:string,_action:string)=>{if(wallet!=='EXAMPLE_OWNER')throw new GridStorageError('not_found');return {state:'pending',id:randomUUID()};});
    const app=express();app.use(express.json());registerGridBotRoutes(app,(req,res,next)=>{const wallet=req.headers['x-wallet'];if(!wallet){res.status(401).end();return;}(req as any).walletAddress=wallet;next();},{deps:{} as never,storage:{} as never,enabled:()=>false,lifecycle:{request} as never});
    const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/grid-bots/'+randomUUID();
    const headers={'content-type':'application/json','x-wallet':'EXAMPLE_OWNER'},requestId=randomUUID();
    try{
      for(const action of ['pause','resume','resync','stop']){const r=await fetch(url+'/'+action,{method:'POST',headers,body:JSON.stringify({requestId})});expect(r.status).toBe(202);expect(request).toHaveBeenLastCalledWith('EXAMPLE_OWNER',expect.any(String),requestId,action,{requestedBy:'owner'});}
      expect((await fetch(url+'/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId})})).status).toBe(401);
      expect((await fetch(url+'/stop',{method:'POST',headers:{...headers,'x-wallet':'EXAMPLE_OTHER'},body:JSON.stringify({requestId})})).status).toBe(404);
      const calls=request.mock.calls.length;
      for(const body of [{},{requestId:'bad'},{requestId,account:'EXAMPLE_OVERRIDE'}])expect((await fetch(url+'/stop',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
      expect(request).toHaveBeenCalledTimes(calls);expect((await fetch(url+'/start',{method:'POST',headers})).status).toBe(503);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
