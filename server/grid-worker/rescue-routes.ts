import type {Express,RequestHandler} from 'express';
import {z} from 'zod';
import type {AdminDependencies} from './admin-routes';
import type {ProtectiveExecutor} from './protective-executor';
import {RescueRefusal,rescueView} from './rescue-state';
import {fencedTransaction} from './transaction';
import {parseOwnerMessage,ownerSha256} from './owner-auth';

export type RescueService=Pick<ProtectiveExecutor,'start'|'step'>;
const uuid=z.string().uuid().regex(/^[0-9a-f-]+$/);
const start=z.object({botId:uuid,message:z.string().max(2048),signature:z.string().max(128)}).strict();
/** Separate MAIN routes; middleware preserves disabled/non-owner indistinguishability. */
export function registerRescueRoutes(app:Express,off:RequestHandler,auth:RequestHandler,dependencies:()=>Promise<AdminDependencies>){
  const external:RequestHandler=async(req,res,next)=>{
    try{
      const d=await dependencies(),wallet=(req as typeof req&{walletAddress:string}).walletAddress;
      const allowed=await fencedTransaction(d.lane,async c=>(await c.query(`SELECT 1 FROM grid_worker_host h
        JOIN grid_worker_owner o ON o.wallet_address=h.owner_wallet WHERE h.singleton_id=1
        AND h.execution_mode='external' AND h.owner_wallet=$1`,[wallet])).rowCount===1,{mode:'none',terminate:d.terminate});
      if(!allowed){res.removeHeader('Cache-Control');next('route');return;}next();
    }catch{res.status(503).json({error:'unavailable'});}
  };
  app.get('/api/grid-worker/rescue',off,auth,external,async(req,res)=>{
    try{
      const requestKey=z.string().regex(/^[0-9a-f]{64}$/).parse(req.query.requestKey),d=await dependencies();
      const wallet=(req as typeof req&{walletAddress:string}).walletAddress;
      const rescue=await fencedTransaction(d.lane,async c=>{
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return rescueView(c,wallet,requestKey);
      },{mode:'none',terminate:d.terminate});
      res.json({rescue,rescueAlertsPhone:false});
    }catch(error){res.status(error instanceof z.ZodError?400:503).json({error:'unavailable'});}
  });
  app.post('/api/grid-worker/rescue',off,auth,external,async(req,res)=>{
    let requestKey:string|undefined,attempted=false;
    try{
      const input=start.parse(req.body);requestKey=ownerSha256(parseOwnerMessage(input.message).nonce);
      const d=await dependencies();if(!d.rescue)throw Error('GRID_RESCUE_UNAVAILABLE');
      attempted=true;
      const rescue=await d.rescue.start((req as typeof req&{walletAddress:string}).walletAddress,input);
      res.json({started:true,requestKey,rescue,rescueAlertsPhone:false});
    }catch(error){
      if(error instanceof RescueRefusal){res.status(error.code==='not_owner'?404:409).json({started:false,refusal:error.code});return;}
      if(error instanceof z.ZodError||error instanceof Error&&/^GRID_(?:OWNER|RECEIPT|VERIFIED|PROTECTIVE_CONSENT)/.test(error.message)){
        res.status(error instanceof z.ZodError?400:409).json({started:false,refusal:'changed'});return;
      }
      res.status(503).json({started:attempted?'unknown':false,requestKey:requestKey??null,error:'unavailable'});
    }
  });
  app.post('/api/grid-worker/rescue/:id/step',off,auth,external,async(req,res)=>{
    try{
      const id=uuid.parse(req.params.id);z.object({}).strict().parse(req.body??{});
      const d=await dependencies();if(!d.rescue)throw Error('GRID_RESCUE_UNAVAILABLE');
      res.json(await d.rescue.step((req as typeof req&{walletAddress:string}).walletAddress,id));
    }catch(error){
      if(error instanceof RescueRefusal){res.status(error.code==='not_owner'?404:409).json({refusal:error.code,next:'done'});return;}
      res.status(error instanceof z.ZodError?400:503).json({error:'unavailable',next:'wait',retryAfterSeconds:2});
    }
  });
}
