import type { Express, RequestHandler, Response } from 'express';
import type { TradingBot } from '../../../shared/schema';
import { getPhoenixProduction } from './production';

function refused(res:Response,error:unknown) {
  const message=error instanceof Error?error.message:'';
  const code=/^(PHOENIX_[A-Z_]+|lab_provenance_required)$/.test(message)?message:'PHOENIX_RUNTIME_AUTHORITY_UNAVAILABLE';
  return res.status(409).json({code,status:'rejected',error:code==='lab_provenance_required'
    ?'Needs a Lab link before it can start (coming)':'Phoenix request refused; retained attempts remain available for recovery.'});
}
export async function handlePhoenixSignalPatch(owner:string,botId:string,input:Record<string,unknown>,res:Response) {
  res.setHeader('Cache-Control','no-store');
  try { const holder=getPhoenixProduction(); if(!holder) throw new Error('PHOENIX_RUNTIME_UNAVAILABLE');
    return res.json(await holder.signals.configure(owner,botId,input));
  } catch(error){return refused(res,error);}
}
/** Caller has already verified the incumbent endpoint's owner and secret. */
export async function handlePhoenixTradingView(bot:TradingBot,payload:unknown,res:Response) {
  res.setHeader('Cache-Control','no-store');
  try { const holder=getPhoenixProduction(); if(!holder) throw new Error('PHOENIX_RUNTIME_UNAVAILABLE');
    return res.json(await holder.signals.signal(bot,payload));
  } catch(error){return refused(res,error);}
}
export function registerPhoenixSignalRoutes(app:Express,requireWallet:RequestHandler) {
  app.get('/api/phoenix/bots/:botId/runtime',requireWallet,async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try {const holder=getPhoenixProduction();if(!holder)throw new Error('PHOENIX_RUNTIME_UNAVAILABLE');
      const owner=(req as typeof req & {walletAddress?:string}).walletAddress;
      if(!owner) throw new Error('PHOENIX_OWNER_REQUIRED');
      return res.json(await holder.signals.detail(owner,req.params.botId));
    }catch(error){return refused(res,error);}
  });
}
