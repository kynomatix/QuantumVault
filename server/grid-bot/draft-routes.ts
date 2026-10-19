import { GRID_RANGE_MOVE_ENABLED } from './epoch-policy';
import { GridMoveError, type GridMoveStorage } from './move-storage';
import type { Express, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { GRID_CREATE_POLICY, GRID_CAPACITY_UNKNOWN, gridPreviewRequestSchema, gridCreateRequestSchema } from '../../shared/grid-draft';
import { authoritativeGridPreview, createGridDraft, GridDraftError, type GridDraftDeps } from './draft-service';
import { GridStorageError, type GridStorage } from './storage';
import { PlannerCharts } from '../grid-planner/chart';
import { defaultPlannerDeps } from '../grid-planner/default-deps';
import { readGridRange } from './draft-default-deps';
import { PlannerRangeFacts } from '../grid-planner/range-facts';
import { gridHistoryRequest } from '../../shared/grid-lookback';
import { marketSnapshot } from '../grid-planner/market-snapshot';
import type {GridLifecycleStorage} from './lifecycle-storage';
import type {GridAutoResumeStorage} from './auto-resume-storage';
import {gridAutoResumeBand} from './auto-resume-policy';
import {gridRuntimeGates,type GridRuntimeGates} from './service';
import {gridStartRequestSchema,type GridStartRequest,type GridStartResult} from '../../shared/grid-start';
import {GRID_CYCLE_V2_CREATION} from './cycle-policy';

const uuid=z.string().uuid();
const rangeQuery=z.object({market:z.string().regex(/^[A-Z0-9]+-PERP$/),timeframe:z.enum(['15m','1h','4h']),lookback:z.enum(['100','200'])}).strict();
const advisoryQuery=z.object({market:z.string().regex(/^[A-Z0-9]+-PERP$/),timeframe:z.enum(['15m','1h','4h']),
  lookback:z.enum(['100','200']).optional(),period:z.enum(['day','week','month']).optional()}).strict();
export function registerGridBotRoutes(app:Express,requireWallet:RequestHandler,provided?:{deps:GridDraftDeps;storage:GridStorage;enabled?:()=>boolean;lifecycle?:Pick<GridLifecycleStorage,'request'>;autoResume?:Pick<GridAutoResumeStorage,'set'|'identity'>;tick?:(market:string)=>Promise<string|null>;
  move?:Pick<GridMoveStorage,'surface'|'set'|'proposal'|'confirm'>;gates?:()=>GridRuntimeGates;start?:(wallet:string,id:string,expected:GridStartRequest,signal:AbortSignal)=>Promise<GridStartResult>}) {
  const gates=provided?.gates??gridRuntimeGates;
  app.post('/api/grid-bots/:id/start',requireWallet,async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!gates().startEnabled){res.status(503).json({error:'Grid Start is off or its worker is unavailable. Existing safety controls remain available.'});return;}
    const id=uuid.safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid Grid id'});return;}
    const body=gridStartRequestSchema.safeParse(req.body);if(!body.success){res.status(400).json({error:'Confirm the retained Grid draft before starting.'});return;}
    try{
      const start=provided?.start??(async(owner:string,bot:string,expected:GridStartRequest,signal:AbortSignal)=>(await (await import('./executor-runtime')).productionGridExecutor()).start(owner,bot,expected,signal));
      const result=await start(wallet(req),id.data,body.data,AbortSignal.timeout(60000));
      res.status(result.state==='denied'?422:result.state==='canary'?200:202).json(result);
    }catch(error){
      if(error instanceof GridStorageError)res.status(error.code==='not_found'?404:409).json({error:error.code});
      else res.status(503).json({error:'Grid launch authority unavailable. Refresh bot details; retrying this draft retains the same launch identity.'});
    }
  });
  const enabled=provided?.enabled??(()=>process.env.GRID_BOT_ENABLED==='true');
  let initialized:Promise<{deps:GridDraftDeps;storage:GridStorage}>|null=null;
  const runtime=()=>provided?Promise.resolve(provided):initialized??(initialized=Promise.all([import('../db'),import('./storage'),import('./draft-default-deps')]).then(([{pool},{GridStorage},{defaultGridDraftDeps}])=>{const storage=new GridStorage(pool);return {storage,deps:defaultGridDraftDeps(storage)};}));
  const wallet=(req:Request)=>(req as Request & {walletAddress:string}).walletAddress;
  const draftDeps=(deps:GridDraftDeps):GridDraftDeps=>({...deps,cycleV2Creation:provided?.deps.cycleV2Creation??GRID_CYCLE_V2_CREATION});
  const charts=new PlannerCharts(defaultPlannerDeps);
  const rangeFacts=new PlannerRangeFacts();
  let inFlight=0;const starts=new Map<string,number[]>();
  const gate:RequestHandler=(req,res,next)=>{if (!enabled()) {res.status(404).json({error:'Grid drafts are disabled'});return;}next();};
  const work=(handler:(req:Request,res:Response)=>Promise<void>,bounded=false):RequestHandler=>async(req,res)=>{
    const owner=wallet(req),now=Date.now(),recent=(starts.get(owner)??[]).filter(t=>now-t<60_000);
    if (bounded && (inFlight>=4 || recent.length>=12)) {res.status(429).json({error:'Grid preview is busy. Try again shortly.'});return;}
    if (bounded) {inFlight++;recent.push(now);starts.set(owner,recent);if(starts.size>512)starts.delete(starts.keys().next().value!);}
    try {await handler(req,res);} catch(e) {
      if(e instanceof GridMoveError) res.status(409).json({error:e.message});
       else if (e instanceof GridDraftError) res.status(e.code==='secret_unavailable'?409:e.code==='authority_unavailable'?422:409).json({error:e.code,reasons:e.reasons});
      else if(e instanceof GridStorageError) res.status(e.code==='not_found'?404:e.code==='conflict'?409:503).json({error:e.code});
      else res.status(503).json({error:'Grid authority or storage unavailable'});
    } finally {if(bounded)inFlight--;}
  };
  const moves=async()=>provided?.move??(await import('./move-runtime')).productionGridMoves();
  app.get('/api/grid-bots/:id/range-move',requireWallet,work(async(req,res)=>{
    res.set('Cache-Control','no-store');const id=uuid.safeParse(req.params.id);
    if(!id.success){res.status(400).json({error:'Invalid Grid id'});return;}
    res.json(await (await moves()).surface(wallet(req),id.data));
  }));
  app.post('/api/grid-bots/:id/range-following',requireWallet,work(async(req,res)=>{
    const id=uuid.safeParse(req.params.id),body=z.object({mode:z.enum(['off','ask']),generation:z.string().regex(/^(?:0|[1-9]\d*)$/).max(18)}).strict().safeParse(req.body);
    if(!id.success||!body.success){res.status(400).json({error:'Invalid following preference'});return;}
    res.json(await (await moves()).set(wallet(req),id.data,body.data.mode,body.data.generation));
  }));
  app.post('/api/grid-bots/:id/range-move/proposal',requireWallet,work(async(req,res)=>{
    res.set('Cache-Control','no-store');const id=uuid.safeParse(req.params.id);
    if(!id.success){res.status(400).json({error:'Invalid Grid id'});return;}
    res.json(await (await moves()).proposal(wallet(req),id.data,AbortSignal.timeout(30000)));
  },true));
  app.post('/api/grid-bots/:id/range-move/confirm',requireWallet,work(async(req,res)=>{
    const id=uuid.safeParse(req.params.id),body=z.object({requestId:uuid,proposal:z.record(z.unknown()),proposalHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict().safeParse(req.body);
    if(!id.success||!body.success){res.status(400).json({error:'Invalid move confirmation'});return;}
    res.status(202).json(await (await moves()).confirm(wallet(req),id.data,body.data.requestId,body.data.proposal as any,body.data.proposalHash,AbortSignal.timeout(30000)));
  },true));
  const currentTick=provided?.tick??(async(market:string)=>{
    try{const rows=await defaultPlannerDeps.getMarkets(),row=rows.find(m=>m.internalSymbol===market);if(!row)return null;
      const constraints=marketSnapshot(row,defaultPlannerDeps).constraints;
      return constraints.state==='available'&&constraints.value.expiresAt>Date.now()?constraints.value.tick:null;
    }catch{return null;}
  });
  app.post('/api/grid-bots/:id/auto-resume',requireWallet,work(async(req,res)=>{
    res.set('Cache-Control','no-store');
    const id=uuid.safeParse(req.params.id),body=z.object({enabled:z.boolean(),expectedGeneration:z.string().regex(/^(?:0|[1-9]\d*)$/).max(19).refine(v=>/^(?:0|[1-9]\d*)$/.test(v)&&BigInt(v)<=9223372036854775807n)}).strict().safeParse(req.body);
    if(!id.success||!body.success){res.status(400).json({error:'Invalid auto-resume preference'});return;}
    const {storage}=await runtime(),snapshot=await storage.getBotSnapshot(wallet(req),id.data);
    let auto=provided?.autoResume;
    if(!auto){const [{pool},{GridLaunchStorage},{GridMonitorStorage},{GridAutoResumeStorage}]=await Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./auto-resume-storage')]);auto=new GridAutoResumeStorage(new GridMonitorStorage(new GridLaunchStorage(pool)));}
    const tick=body.data.enabled?await currentTick(snapshot.bot.market):null;
    const identity=body.data.enabled?await auto.identity(wallet(req),id.data):null;
    const preference=await auto.set(wallet(req),id.data,body.data.enabled,body.data.expectedGeneration,tick,identity);
    res.json({enabled:preference.enabled,generation:String(preference.generation)});
  }));
  // Safety controls remain available under draft/entry denial. Owner identity comes only from auth middleware.
  for(const action of ['pause','resume','resync','stop'] as const)app.post('/api/grid-bots/:id/'+action,requireWallet,work(async(req,res)=>{
    const body=z.object({requestId:uuid}).strict().safeParse(req.body),id=uuid.safeParse(req.params.id);
    if(!body.success||!id.success){res.status(400).json({error:'Invalid control request'});return;}
    let lifecycle=provided?.lifecycle;
    if(!lifecycle){const [{pool},{GridLaunchStorage},{GridMonitorStorage},{GridLifecycleStorage}]=await Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./lifecycle-storage')]);
      lifecycle=new GridLifecycleStorage(new GridMonitorStorage(new GridLaunchStorage(pool)));}
    const result=await lifecycle.request(wallet(req),id.data,body.data.requestId,action,{requestedBy:'owner'});res.status(result.state==='complete'?200:202).json({request:result});
  }));
  app.get('/api/grid-bots/status',requireWallet,(_req,res)=>{res.set('Cache-Control','no-store');res.json({enabled:enabled(),...gates(),rangeMoveEnabled:GRID_RANGE_MOVE_ENABLED});});
  app.get('/api/grid-bots/create-policy',requireWallet,gate,(_req,res)=>{res.json(GRID_CREATE_POLICY);});
  app.get('/api/grid-bots/markets',requireWallet,gate,work(async(_req,res)=>{
    const markets=await defaultPlannerDeps.getMarkets();res.json({markets:markets.map(m=>({market:m.internalSymbol,name:m.fullName}))});
  }));
  app.get('/api/grid-bots/capacity',requireWallet,gate,(_req,res)=>{res.json({policy:GRID_CREATE_POLICY,...GRID_CAPACITY_UNKNOWN});});
  // Preserve the draft-only setup when the independent hypothetical Planner flag is off.
  app.get('/api/grid-bots/setup-markets',requireWallet,gate,work(async(req,res)=>{
    res.set('Cache-Control','no-store');
    const parsed=z.object({market:z.string().regex(/^[A-Z0-9]+-PERP$/).optional()}).strict().safeParse(req.query);
    if(!parsed.success){res.status(400).json({error:'Invalid market refresh request'});return;}
    const rows=await defaultPlannerDeps.getMarkets();
    if(parsed.data.market){
      const row=rows.find(m=>m.internalSymbol===parsed.data.market);
      if(!row){res.status(404).json({error:'Unknown Pacifica market'});return;}
      if(!defaultPlannerDeps.refreshReference)throw Error('Fresh price refresh unavailable');
      const controller=new AbortController(),onClose=()=>controller.abort(),timer=setTimeout(onClose,15_000);res.on('close',onClose);
      try{await defaultPlannerDeps.refreshReference(row.internalSymbol,row.protocolSymbol,controller.signal);}
      finally{clearTimeout(timer);res.off('close',onClose);}
    }
    if(!res.destroyed)res.json({state:'available',retrievedAt:defaultPlannerDeps.now(),markets:rows.map(row=>marketSnapshot(row,defaultPlannerDeps))});
  },true));
  app.get('/api/grid-bots/range',requireWallet,gate,work(async(req,res)=>{
    const parsed=advisoryQuery.safeParse(req.query);if(!parsed.success){res.status(400).json({error:'Invalid advisory request'});return;}
    const window=gridHistoryRequest(parsed.data.timeframe,parsed.data.period,parsed.data.lookback);if(!window){res.status(400).json({error:'Invalid advisory window'});return;}
    const rows=await defaultPlannerDeps.getMarkets(),row=rows.find(m=>m.internalSymbol===parsed.data.market);
    if(!row){res.status(400).json({error:'Unknown Pacifica market'});return;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),window.chartBars>200?30_000:15_000);res.once('close',()=>controller.abort());
    try{const chart=await charts.read(parsed.data.market,parsed.data.timeframe,window.chartBars,controller.signal);
      const value=await rangeFacts.read(row,parsed.data.timeframe,window.rangeBars,defaultPlannerDeps,controller.signal,chart,window.period);if(!res.destroyed)res.json(value);}finally{clearTimeout(timer);}
  },true));
  app.get('/api/grid-bots/suggest-range',requireWallet,gate,work(async(req,res)=>{
    const parsed=rangeQuery.safeParse(req.query);if(!parsed.success){res.status(400).json({error:'Invalid range request'});return;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);res.once('close',()=>controller.abort());
    try {res.json(await readGridRange({...parsed.data,lookback:Number(parsed.data.lookback) as 100|200},controller.signal));}finally{clearTimeout(timer);}
  },true));
  app.get('/api/grid-bots/chart',requireWallet,gate,work(async(req,res)=>{
    const parsed=advisoryQuery.safeParse(req.query);if(!parsed.success){res.status(400).json({error:'Invalid chart request'});return;}
    const window=gridHistoryRequest(parsed.data.timeframe,parsed.data.period,parsed.data.lookback);if(!window){res.status(400).json({error:'Invalid chart window'});return;}
    const markets=await defaultPlannerDeps.getMarkets();if(!markets.some(m=>m.internalSymbol===parsed.data.market)){res.status(400).json({error:'Unknown Pacifica market'});return;}
    const controller=new AbortController();res.once('close',()=>controller.abort());
    res.json(await charts.read(parsed.data.market,parsed.data.timeframe,window.chartBars,controller.signal));
  },true));
  app.post('/api/grid-bots/preview',requireWallet,gate,work(async(req,res)=>{
    const p=gridPreviewRequestSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid preview request'});return;}
    const {deps}=await runtime();const preview=await authoritativeGridPreview(wallet(req),p.data.intent,p.data.draftRevision,draftDeps(deps));
    res.json({...preview,requestId:p.data.requestId,draftRevision:p.data.draftRevision});
  },true));
  app.post('/api/grid-bots',requireWallet,gate,work(async(req,res)=>{
    const p=gridCreateRequestSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid create request'});return;}
    const {deps}=await runtime();const result=await createGridDraft(wallet(req),p.data,draftDeps(deps));res.status(result.result==='created'?201:200).json(result);
  },true));
  app.get('/api/grid-bots/by-client-request/:clientRequestId',requireWallet,gate,work(async(req,res)=>{
    const id=uuid.safeParse(req.params.clientRequestId);if(!id.success){res.status(400).json({error:'Invalid request identity'});return;}
    const {storage}=await runtime(),bot=await storage.findByClientRequest(wallet(req),id.data);if(!bot){res.status(404).json({error:'not_found'});return;}res.json({bot,pnlLabel:'Excludes funding'});
  }));
  app.get('/api/grid-bots',requireWallet,work(async(req,res)=>{
    const q=z.object({includeStopped:z.enum(['true','false']).optional()}).strict().safeParse(req.query);if(!q.success){res.status(400).json({error:'Invalid list filters'});return;}
    const {storage}=await runtime();res.json({bots:await storage.listBots(wallet(req),q.data.includeStopped==='true'),pnlLabel:'Excludes funding'});
  }));
  app.get('/api/grid-bots/:id/surface',requireWallet,work(async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid bot identity'});return;}
    const {storage}=await runtime(),snapshot=await storage.getBotSnapshot(wallet(req),req.params.id,true);res.set('Cache-Control','no-store');
    if(snapshot.surface?.autoResume){const tick=await currentTick(snapshot.bot.market),band=tick?gridAutoResumeBand(snapshot.bot.lowerPrice,snapshot.bot.upperPrice,tick):null;
      snapshot.surface.autoResume={...snapshot.surface.autoResume,band,unavailableReason:!tick?'market_data_unavailable':!band?'range_unavailable':'control_unavailable',available:!!band&&!['draft','failed','stopping','stopped'].includes(snapshot.bot.status)};}
    res.json(snapshot.surface);
  }));
  app.get('/api/grid-bots/:id/chart',requireWallet,work(async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid bot identity'});return;}
    const q=z.object({timeframe:z.enum(['15m','1h','4h'])}).strict().safeParse(req.query);
    if(!q.success){res.status(400).json({error:'Invalid chart timeframe'});return;}
    const {storage}=await runtime(),snapshot=await storage.getBotSnapshot(wallet(req),req.params.id);
    const controller=new AbortController();res.once('close',()=>controller.abort());
    res.json(await charts.read(snapshot.bot.market,q.data.timeframe,100,controller.signal));
  },true));
  app.get('/api/grid-bots/:id/fills',requireWallet,gate,work(async(req,res)=>{
    const q=z.object({limit:z.string().regex(/^\d+$/).optional(),cursor:z.string().max(512).optional()}).strict().safeParse(req.query);
    if(!q.success || !uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid fill request'});return;}
    const limit=Number(q.data.limit??50);if(limit<1 || limit>100){res.status(400).json({error:'Invalid limit'});return;}
    let cursor:{time:string;trade:string}|null=null;
    try {if(q.data.cursor) {const raw=Buffer.from(q.data.cursor,'base64url').toString('utf8');cursor=z.object({time:z.string().datetime(),trade:z.string().min(1).max(200)}).strict().parse(JSON.parse(raw));if(Buffer.from(raw).toString('base64url')!==q.data.cursor)throw Error();}}catch{res.status(400).json({error:'Invalid cursor'});return;}
    const {storage}=await runtime();const result=await storage.listFills(wallet(req),req.params.id,limit,cursor);
    res.json({fills:result.fills,cursor:result.next?Buffer.from(JSON.stringify(result.next)).toString('base64url'):null,pnlLabel:'Excludes funding'});
  }));
  app.get('/api/grid-bots/:id/levels',requireWallet,gate,work(async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid bot identity'});return;}
    const {storage}=await runtime(),snapshot=await storage.getBotSnapshot(wallet(req),req.params.id);res.json({levels:snapshot.levels});
  }));
  app.get('/api/grid-bots/:id/pnl',requireWallet,gate,work(async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid bot identity'});return;}
    const {storage}=await runtime();await storage.getBotSnapshot(wallet(req),req.params.id);
    const [{pool},{GridLaunchStorage},{GridMonitorStorage}]=await Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage')]);
    const result=await new GridMonitorStorage(new GridLaunchStorage(pool)).pnl(wallet(req),req.params.id);
    if(!result){res.status(404).json({error:'not_found'});return;}res.json(result);
  }));
  app.get('/api/grid-bots/:id',requireWallet,gate,work(async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.status(400).json({error:'Invalid bot identity'});return;}
    const {storage}=await runtime(),snapshot=await storage.getBotSnapshot(wallet(req),req.params.id);res.json({bot:snapshot.bot,operations:snapshot.operations,pnlLabel:'Excludes funding'});
  }));
}
