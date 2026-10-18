import {describe,it,expect,vi} from 'vitest';
import express from 'express';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
vi.mock('../../server/grid-planner/default-deps',()=>({defaultPlannerDeps:{}}));
vi.mock('../../server/grid-bot/draft-default-deps',()=>({}));
import {registerGridBotRoutes} from '../../server/grid-bot/draft-routes';
import {GridStorageError} from '../../server/grid-bot/storage';
describe('Grid owner controls while entry gates are disabled',()=>{
  it('preference is owner-scoped, strict and generation-bound even with all entry gates off',async()=>{
    const id=randomUUID(),set=vi.fn(async(_wallet:string,_id:string,enabled:boolean,generation:string)=>{if(generation!=='0')throw new GridStorageError('conflict');return {enabled,generation:'1'};}),identity=vi.fn(async()=>null);
    const getBotSnapshot=vi.fn(async(wallet:string)=>{if(wallet!=='EXAMPLE_OWNER')throw new GridStorageError('not_found');return {bot:{market:'BTC-PERP'}};});
    const app=express();app.use(express.json());registerGridBotRoutes(app,(req,res,next)=>{if(!req.headers['x-wallet']){res.status(401).end();return;}(req as any).walletAddress=req.headers['x-wallet'];next();},{deps:{} as never,storage:{getBotSnapshot} as never,enabled:()=>false,autoResume:{set,identity} as never,tick:async()=> '0.01'});
    const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/grid-bots/'+id+'/auto-resume';
    const post=(body:unknown,owner='EXAMPLE_OWNER')=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-wallet':owner},body:JSON.stringify(body)});
    try{
      expect((await post({enabled:true,expectedGeneration:'0'})).status).toBe(200);expect(set).toHaveBeenCalledWith('EXAMPLE_OWNER',id,true,'0','0.01',null);
      expect((await post({enabled:false,expectedGeneration:'1'})).status).toBe(409);
      expect((await post({enabled:true,expectedGeneration:'0'},'EXAMPLE_OTHER')).status).toBe(404);
      for(const body of [{enabled:true},{enabled:'true',expectedGeneration:'0'},{enabled:true,expectedGeneration:'-1'},{enabled:true,expectedGeneration:'invalid'},{enabled:true,expectedGeneration:'9223372036854775808'},{enabled:true,expectedGeneration:'0',source:'auto'}])expect((await post(body)).status).toBe(400);
    }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
  it('keeps owner-scoped live reads available with the draft flag off',async()=>{
    const id=randomUUID(),getBotSnapshot=vi.fn(async(wallet:string,bot:string,surface?:boolean)=>{if(wallet!=='EXAMPLE_OWNER'||bot!==id)throw new GridStorageError('not_found');return {surface:{bot:{id},startEnabled:false,workerEnabled:false}};}),listBots=vi.fn(async()=>[]);
    const app=express();registerGridBotRoutes(app,(req,res,next)=>{if(!req.headers['x-wallet']){res.status(401).end();return;}(req as any).walletAddress=req.headers['x-wallet'];next();},{deps:{} as never,storage:{getBotSnapshot,listBots} as never,enabled:()=>false});
    const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/grid-bots',headers={'x-wallet':'EXAMPLE_OWNER'};
    try{expect((await fetch(url,{headers})).status).toBe(200);const r=await fetch(url+'/'+id+'/surface',{headers});expect(r.status).toBe(200);expect(await r.json()).toMatchObject({startEnabled:false,workerEnabled:false});expect(getBotSnapshot).toHaveBeenCalledWith('EXAMPLE_OWNER',id,true);expect((await fetch(url+'/'+id+'/surface')).status).toBe(401);expect((await fetch(url+'/'+id+'/surface',{headers:{'x-wallet':'EXAMPLE_OTHER'}})).status).toBe(404);expect((await fetch(url+'/bad/surface',{headers})).status).toBe(400);expect((await fetch(url+'/'+id+'/chart?timeframe=bad',{headers})).status).toBe(400);expect((await fetch(url+'/status',{headers})).status).toBe(200);}
    finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
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
      for(const body of [{},{requestId:'bad'},{requestId,account:'EXAMPLE_OVERRIDE'},{requestId,source:'auto'}])expect((await fetch(url+'/stop',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
      expect(request).toHaveBeenCalledTimes(calls);expect((await fetch(url+'/start',{method:'POST',headers})).status).toBe(503);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
