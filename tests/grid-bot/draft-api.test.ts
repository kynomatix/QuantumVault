import { describe,it,expect,vi,afterEach } from 'vitest';
import express from 'express';
import Decimal from 'decimal.js';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { authoritativeGridPreview,createGridDraft } from '../../server/grid-bot/draft-service';
import { calculateGrid } from '../../server/grid-bot/engine';
import { GridStorageError,type GridStorage,type StoredBot,type StoredLevel,type DraftRecord } from '../../server/grid-bot/storage';
import { gridIntentSchema,gridCreateRequestSchema } from '../../shared/grid-draft';
import { gridDraftRevision } from '../../client/src/lib/grid-draft-view';
import { intent,authority,clock,umk } from './draft-fixtures';
import type { GridDraftDeps } from '../../server/grid-bot/draft-service';
vi.mock('../../server/grid-planner/default-deps',()=>({defaultPlannerDeps:{now:()=>1_800_000_000_000,getMarkets:async()=>[],candles:async()=>[],cachedReference:()=>null,refreshReference:vi.fn(async()=>{})}}));
vi.mock('../../server/grid-bot/draft-default-deps',()=>({readGridRange:async()=>({state:'unavailable',manualAvailable:true}),defaultGridDraftDeps:()=>{throw Error('Unexpected default dependencies');}}));
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import { defaultPlannerDeps } from '../../server/grid-planner/default-deps';
import { registerGridBotRoutes } from '../../server/grid-bot/draft-routes';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
function memory() {
  const bots=new Map<string,StoredBot>(),levels=new Map<string,StoredLevel[]>();
  return {bots,levels,createDraftWithLevels:vi.fn(async(bot:DraftRecord,l:StoredLevel[])=>{
    const previous=[...bots.values()].find(b=>b.walletAddress===bot.walletAddress&&b.clientRequestId===bot.clientRequestId);if(previous)return {bot:previous,result:'existing_request' as const};
    const stored={...bot,status:'draft',totalFees:'0.00000000',residualUsdc:null,createdAt:new Date(clock),updatedAt:new Date(clock)};bots.set(bot.id,stored);levels.set(bot.id,l);return{bot:stored,result:'created' as const};
  }),findByClientRequest:async(wallet:string,request:string)=>[...bots.values()].find(b=>b.walletAddress===wallet&&b.clientRequestId===request)??null,
    getBotSnapshot:async(wallet:string,id:string)=>{const bot=bots.get(id);if(!bot || bot.walletAddress!==wallet)throw new GridStorageError('not_found');return{bot,levels:levels.get(id)!,operations:[]};},
    listBots:async(wallet:string)=>[...bots.values()].filter(b=>b.walletAddress===wallet),listFills:async(wallet:string,id:string)=>{if(bots.get(id)?.walletAddress!==wallet)throw new GridStorageError('not_found');return{fills:[],next:null};}};
}
const setup=()=>{const storage=memory(),a=authority(),deps:GridDraftDeps={storage:storage as never,observe:async()=>a,now:()=>clock,umk:async()=>umk()};return{storage,a,deps};};
const request=async(deps:GridDraftDeps)=>{const draftRevision=gridDraftRevision(intent),preview=await authoritativeGridPreview('EXAMPLE',intent,draftRevision,deps);expect(preview.state).toBe('ready');return{schemaVersion:1 as const,clientRequestId:randomUUID(),draftRevision,intent,serverIntentDigest:preview.serverIntentDigest!};};
describe('server authoritative Grid drafts',()=>{
  it('keeps v1 creation by default and signs v2 only through the server test injection',async()=>{
    const {deps,storage}=setup();
    const old=await createGridDraft('EXAMPLE',await request(deps),deps);
    expect(old.bot.policyVersion).toBe('1.0.0');expect(old.bot.runtimePolicyVersion).toBe('1.0.0');
    deps.cycleV2Creation=true;deps.projectedStop=false;
    const i={...intent,seedAtCreation:false},revision=gridDraftRevision(i),preview=await authoritativeGridPreview('EXAMPLE',i,revision,deps);
    expect(preview.state).toBe('ready');expect(preview.policy.policyVersion).toBe('2.0.0');
    expect(preview.plan?.cycles?.length).toBe(4);expect(preview.plan?.seedQuantity).toBe('0');
    expect(new Decimal(preview.geometrySummary!.totalRequiredCapital!).lte(i.totalInvestment)).toBe(true);
    const saved=await createGridDraft('EXAMPLE',{schemaVersion:1,clientRequestId:randomUUID(),draftRevision:revision,intent:i,serverIntentDigest:preview.serverIntentDigest!},deps);
    expect(saved.bot.policyVersion).toBe('2.0.0');expect(saved.bot.runtimePolicyVersion).toBe('2.0.0');
    expect(storage.levels.get(saved.bot.id)!.filter(l=>l.reduceOnly).every(l=>new Decimal(l.size).gt(0))).toBe(true);
    expect(old.bot.policyVersion).toBe('1.0.0');
  });
  it('rejects v2 authority that would round when persisted at eight decimal places',async()=>{
    const {a,deps}=setup();deps.cycleV2Creation=true;
    if(a.market.constraints.state!=='available'||a.market.reference.state!=='available')throw Error('EXAMPLE');
    a.market.constraints.value.tick='0.000000001';
    a.market.reference.value.price='100.000000009';
    const preview=await authoritativeGridPreview('EXAMPLE',intent,gridDraftRevision(intent),deps);
    expect(preview.state).not.toBe('ready');expect(preview.reasons).toContain('Cycle geometry exceeds durable policy precision');
  });
  it('signs and persists the lifted quantities from the fee-reserved sizing plan',async()=>{
    const {a,deps,storage}=setup();if(a.market.constraints.state!=='available')throw Error('EXAMPLE');
    a.market.constraints.value.minimumQuote='10';
    const i={...intent,gridCount:50,totalInvestment:'300',leverage:'10',entryScaleType:'ascending' as const,profitScaleType:'ascending' as const};
    const draftRevision=gridDraftRevision(i),preview=await authoritativeGridPreview('EXAMPLE',i,draftRevision,deps);
    expect(preview.state).toBe('ready');
    const investment=new Decimal(i.totalInvestment).div(new Decimal(1).plus(new Decimal(i.leverage).mul(a.seedFee!.effectiveRate)))
      .toDecimalPlaces(2,Decimal.ROUND_FLOOR).toFixed(2);
    const expected=calculateGrid({side:'long',lower:'90',upper:'110',start:'100',intervals:50,seed:true,entryScale:'ascending',profitScale:'ascending',
      investment,leverage:'10',tick:'0.01',lot:'0.001',minimumQuote:'10',investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:a.entryFee!.effectiveRate});
    expect(expected.ok).toBe(true);if(!expected.ok)return;
    expect(expected.plan.openingOrderLift?.count).toBe(2);
    expect(preview.levels!.map(l=>l.size)).toEqual(expected.plan.lines.map(l=>new Decimal(l.quantity).toFixed(8)));
    const saved=await createGridDraft('EXAMPLE',{schemaVersion:1,clientRequestId:randomUUID(),draftRevision,intent:i,serverIntentDigest:preview.serverIntentDigest!},deps);
    expect(storage.levels.get(saved.bot.id)!.map(l=>l.size)).toEqual(preview.levels!.map(l=>l.size));
  });
  it('saves a draft with unpublished optional limits while retaining every published limit check',async()=>{
    const {a,deps}=setup();if(a.market.constraints.state!=='available')throw Error('EXAMPLE');
    const c=a.market.constraints.value;
    c.maximumQuote={state:'unavailable',reason:'EXAMPLE'};c.priceBounds={state:'unavailable',reason:'EXAMPLE'};c.restrictions={state:'unavailable',reason:'EXAMPLE'};
    const saved=await createGridDraft('EXAMPLE',await request(deps),deps);expect(saved.result).toBe('created');
    c.priceBounds={state:'available',value:{minimum:'96',maximum:'104'}};
    expect((await authoritativeGridPreview('EXAMPLE',intent,gridDraftRevision(intent),deps)).reasons).toContain('Pacifica accepts prices from $96 to $104. Move the range inside those limits.');
    c.priceBounds={state:'available',value:{minimum:'0',maximum:'1000000'}};
    expect((await authoritativeGridPreview('EXAMPLE',intent,gridDraftRevision(intent),deps)).state).toBe('ready');
    c.maximumQuote={state:'available',value:'1'};
    expect((await authoritativeGridPreview('EXAMPLE',intent,gridDraftRevision(intent),deps)).reasons.some(reason=>/above Pacifica's \$1.00 maximum/.test(reason))).toBe(true);
    c.maximumQuote={state:'unavailable',reason:'EXAMPLE'};c.restrictions={state:'available',value:'isolated_only'};
    expect((await authoritativeGridPreview('EXAMPLE',intent,gridDraftRevision(intent),deps)).reasons).toContain('This market requires isolated margin, which Grid does not support. Choose another market.');
  });
  it('saves one draft on exact retries, signs all levels, and isolates wallets',async()=>{const {storage,deps}=setup(),r=await request(deps);const first=await createGridDraft('EXAMPLE',r,deps),retry=await createGridDraft('EXAMPLE',r,deps);expect(first.bot.id).toBe(retry.bot.id);expect(retry.result).toBe('existing_request');expect(storage.bots.size).toBe(1);expect(storage.levels.get(first.bot.id)).toHaveLength(intent.gridCount+1);expect(first.bot.policyHmac).toMatch(/^[0-9a-f]{64}$/);await createGridDraft('REDACTED',r,deps);expect(storage.bots.size).toBe(2);});
  it.each([true,false])('keeps required capital within the submitted budget and distinguishes seed capital (%s)',async(seedAtCreation)=>{
    const {deps}=setup(),i={...intent,seedAtCreation},p=await authoritativeGridPreview('EXAMPLE',i,gridDraftRevision(i),deps);
    expect(p.state).toBe('ready');expect(p.geometrySummary?.minimumSpacing).toBe('5');expect(p.geometrySummary?.maximumSpacing).toBe('5');
    expect(p.geometrySummary?.feeClearance).toBe('clears');expect(new Decimal(p.geometrySummary!.totalRequiredCapital!).lte(i.totalInvestment)).toBe(true);
    expect(new Decimal(p.geometrySummary!.restingEntryMargin).gt(0)).toBe(true);expect(new Decimal(p.geometrySummary!.seedNotional).gt(0)).toBe(seedAtCreation);
    if(!seedAtCreation){expect(p.seedTakerCost).toBe('0');expect(p.geometrySummary!.seedNotional).toBe('0');}
  });
  it('recomputes instead of accepting changed geometry, a seed change or fees',async()=>{const {storage,deps,a}=setup(),r=await request(deps);await expect(createGridDraft('EXAMPLE',{...r,intent:{...intent,upperPrice:'120'}},deps)).rejects.toMatchObject({code:'preview_drift'});
    await expect(createGridDraft('EXAMPLE',{...r,intent:{...intent,seedAtCreation:false}},deps)).rejects.toMatchObject({code:'preview_drift'});a.entryFee={...a.entryFee!,effectiveRate:'0'};await expect(createGridDraft('EXAMPLE',r,deps)).rejects.toMatchObject({code:'authority_unavailable'});expect(storage.bots.size).toBe(0);});
  it('rejects authority expiry and stop clearance, while unknown capacity is not a gate',async()=>{const {deps,a}=setup();const r=await request(deps);expect((await authoritativeGridPreview('EXAMPLE',intent,r.draftRevision,deps)).capacity.state).toBe('unavailable');a.stop={state:'unavailable',reason:'EXAMPLE unknown liquidation'};await expect(createGridDraft('EXAMPLE',r,deps)).rejects.toMatchObject({code:'authority_unavailable'});});
  it('rejects changed intent on the same request and never mutates the winner',async()=>{const {storage,deps}=setup(),r=await request(deps);const first=await createGridDraft('EXAMPLE',r,deps);const changed={...intent,totalInvestment:'200'},revision=gridDraftRevision(changed),p=await authoritativeGridPreview('EXAMPLE',changed,revision,deps);await expect(createGridDraft('EXAMPLE',{...r,intent:changed,draftRevision:revision,serverIntentDigest:p.serverIntentDigest!},deps)).rejects.toMatchObject({code:'idempotency_conflict'});expect(storage.bots.get(first.bot.id)?.totalInvestment).toBe('100.00');});
  it('denies tampered durable levels or HMAC on replay',async()=>{const {deps,storage}=setup(),r=await request(deps),saved=await createGridDraft('EXAMPLE',r,deps);storage.levels.get(saved.bot.id)![0].size='999.00000000';await expect(createGridDraft('EXAMPLE',r,deps)).rejects.toMatchObject({code:'idempotency_conflict'});});
  it('a missing UMK cannot commit a draft',async()=>{const {deps,storage}=setup(),r=await request(deps);deps.umk=async()=>null;await expect(createGridDraft('EXAMPLE',r,deps)).rejects.toMatchObject({code:'secret_unavailable'});expect(storage.bots.size).toBe(0);});
  it('rejects auto unavailable without breaking manual previews',async()=>{const {deps}=setup();expect((await authoritativeGridPreview('EXAMPLE',{...intent,rangeSource:'auto'},'EXAMPLE',deps)).state).toBe('unavailable');expect((await authoritativeGridPreview('EXAMPLE',intent,'EXAMPLE',deps)).state).toBe('ready');});
  it.each(['walletAddress','levels','startPrice','feeRate','policyHmac','serverIntentDigest'])('strictly rejects client authority %s',field=>{expect(gridIntentSchema.safeParse({...intent,[field]:'EXAMPLE'}).success).toBe(false);});
  it('rejects floating leverage, exponent/negative prices and invalid request UUID',()=>{expect(gridIntentSchema.safeParse({...intent,leverage:'1.5'}).success).toBe(false);expect(gridIntentSchema.safeParse({...intent,lowerPrice:'1e2'}).success).toBe(false);expect(gridCreateRequestSchema.safeParse({schemaVersion:1,clientRequestId:'EXAMPLE',draftRevision:'EXAMPLE',intent,serverIntentDigest:'EXAMPLE'}).success).toBe(false);});
});
const servers:Server[]=[];afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();})));});
async function api(enabled=true) {const {storage,deps}=setup(),app=express();app.use(express.json());registerGridBotRoutes(app,(req,res,next)=>{const wallet=req.headers['x-wallet'];if(!wallet){res.sendStatus(401);return;}(req as typeof req & {walletAddress:string}).walletAddress=String(wallet);next();},{deps,storage:storage as unknown as GridStorage,enabled:()=>enabled});const server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});servers.push(server);const address=server.address();if(!address||typeof address==='string')throw Error();return{...{storage,deps},url:'http://127.0.0.1:'+address.port};}
describe('Grid owner-only routes',()=>{
  it('keeps production-route drafts on v1 and accepts v2 only through injected server dependencies',async()=>{
    const {url,deps}=await api(),headers={'x-wallet':'EXAMPLE','content-type':'application/json'};
    const body={schemaVersion:1,requestId:1,draftRevision:gridDraftRevision(intent),intent};
    const preview=()=>fetch(url+'/api/grid-bots/preview',{method:'POST',headers,body:JSON.stringify(body)});
    expect(await (await preview()).json()).toMatchObject({state:'ready',policy:{policyVersion:'1.0.0',runtimePolicyVersion:'1.0.0'}});
    for(const field of ['cycleV2Creation','policyVersion','runtimePolicyVersion']){
      const response=await fetch(url+'/api/grid-bots/preview',{method:'POST',headers,body:JSON.stringify({...body,intent:{...intent,[field]:field==='cycleV2Creation'?true:'2.0.0'}})});
      expect(response.status).toBe(400);
    }
    deps.cycleV2Creation=true;
    const v2=await (await preview()).json();expect(v2).toMatchObject({state:'ready',policy:{policyVersion:'2.0.0',runtimePolicyVersion:'2.0.0'}});
    const saved=await fetch(url+'/api/grid-bots',{method:'POST',headers,body:JSON.stringify({schemaVersion:1,clientRequestId:randomUUID(),draftRevision:body.draftRevision,intent,serverIntentDigest:v2.serverIntentDigest})});
    expect(saved.status).toBe(201);expect(await saved.json()).toMatchObject({bot:{policyVersion:'2.0.0',runtimePolicyVersion:'2.0.0'}});
  });
  it.each(['grid-bots', 'grid-planner'])('maps time periods on %s read-only routes and shares chart context with range facts', async namespace => {
    const now = defaultPlannerDeps.now(), duration = 3_600_000, end = Math.floor(now / duration) * duration;
    const market = { internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
      constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', now) } as ProtocolMarket;
    const markets = vi.spyOn(defaultPlannerDeps, 'getMarkets').mockResolvedValue([market]);
    const candles = vi.spyOn(defaultPlannerDeps, 'candles').mockImplementation(async (_market, _tf, count) => Array.from({ length: count }, (_, i) => ({
      time: end - (count - i) * duration, open: 100, high: 102, low: 98, close: 100, volume: 1,
      provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } })));
    const { storage, deps } = setup(), app = express();
    const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!req.headers['x-wallet']) { res.sendStatus(401); return; }
      (req as express.Request & { walletAddress: string }).walletAddress = 'EXAMPLE'; next();
    };
    if (namespace === 'grid-bots') registerGridBotRoutes(app, auth, { deps, storage: storage as unknown as GridStorage, enabled: () => true });
    else registerGridPlannerRoutes(app, auth, async () => defaultPlannerDeps, true);
    const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw Error('EXAMPLE listener unavailable');
    const root = `http://127.0.0.1:${address.port}/api/${namespace}`, query = '?market=BTC-PERP&timeframe=1h&period=week', headers = { 'x-wallet': 'EXAMPLE' };
    try {
      expect((await fetch(root + '/chart' + query)).status).toBe(401);
      const [chart, range] = await Promise.all([fetch(root + '/chart' + query, { headers }), fetch(root + '/range' + query, { headers })]);
      expect(await chart.json()).toMatchObject({ state: 'available', requestedBars: 252, actualBars: 252 });
      expect(await range.json()).toMatchObject({ state: 'available', requestedBars: 168, regime: { state: 'available', bars: 200 }, range: { state: 'available', includedBars: 168 } });
      expect(candles).toHaveBeenCalledTimes(1); expect(storage.createDraftWithLevels).not.toHaveBeenCalled();
      for (const suffix of ['&period=year', namespace === 'grid-bots' ? '&lookback=100' : '&bars=100', '&extra=1'])
        expect((await fetch(root + '/range' + query + suffix, { headers })).status).toBe(400);
    } finally { markets.mockRestore(); candles.mockRestore(); }
  });
  it('refreshes the selected Pacifica price in draft-only setup while preserving auth and the draft flag',async()=>{
    const markets=vi.spyOn(defaultPlannerDeps,'getMarkets').mockResolvedValue([{internalSymbol:'BTC-PERP',protocolSymbol:'BTC',fullName:'Bitcoin'} as ProtocolMarket]);
    const cached=vi.spyOn(defaultPlannerDeps,'cachedReference').mockReturnValue({price:100,observedAt:defaultPlannerDeps.now()});
    const refresh=vi.mocked(defaultPlannerDeps.refreshReference!);refresh.mockClear();
    try{
      const {url,storage}=await api(),headers={'x-wallet':'EXAMPLE'};
      expect((await fetch(url+'/api/grid-bots/setup-markets?market=BTC-PERP')).status).toBe(401);
      expect((await fetch(url+'/api/grid-bots/setup-markets?market=BTC-PERP&extra=1',{headers})).status).toBe(400);
      expect((await fetch(url+'/api/grid-bots/setup-markets?market=ETH-PERP',{headers})).status).toBe(404);
      expect(refresh).not.toHaveBeenCalled();
      const response=await fetch(url+'/api/grid-bots/setup-markets?market=BTC-PERP',{headers});
      expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({state:'available',markets:[{market:'BTC-PERP',reference:{state:'available',value:{price:'100'}}}]});
      expect(refresh).toHaveBeenCalledOnce();expect(refresh).toHaveBeenCalledWith('BTC-PERP','BTC',expect.any(AbortSignal));
      const off=await api(false);expect((await fetch(off.url+'/api/grid-bots/setup-markets?market=BTC-PERP',{headers})).status).toBe(404);
      expect(refresh).toHaveBeenCalledOnce();expect(storage.createDraftWithLevels).not.toHaveBeenCalled();
    }finally{markets.mockRestore();cached.mockRestore();refresh.mockClear();}
  });

  it('requires authentication, keeps owner reads available and blocks draft creation with the flag off',async()=>{
    const {url,storage}=await api(false),headers={'x-wallet':'EXAMPLE','Content-Type':'application/json'};
    expect((await fetch(url+'/api/grid-bots')).status).toBe(401);
    const list=await fetch(url+'/api/grid-bots',{headers});expect(list.status).toBe(200);expect(await list.json()).toMatchObject({bots:[]});
    for(const path of ['/api/grid-bots/preview','/api/grid-bots'])expect((await fetch(url+path,{method:'POST',headers,body:'{}'})).status).toBe(404);
    expect((await fetch(url+'/api/grid-bots/'+randomUUID()+'/start',{method:'POST',headers})).status).toBe(503);
    expect(storage.createDraftWithLevels).not.toHaveBeenCalled();expect(storage.bots.size).toBe(0);
  });
  it('echoes only valid correlations, creates a draft, and returns the same foreign/missing result',async()=>{const {url,deps}=await api(),r=await request(deps),headers={'x-wallet':'EXAMPLE','Content-Type':'application/json'};
    const invalid=await fetch(url+'/api/grid-bots/preview',{method:'POST',headers,body:JSON.stringify({requestId:'EXAMPLE'})});expect(invalid.status).toBe(400);expect((await invalid.json()).requestId).toBeUndefined();
    const p=await fetch(url+'/api/grid-bots/preview',{method:'POST',headers,body:JSON.stringify({schemaVersion:1,requestId:1,draftRevision:r.draftRevision,intent})});expect(await p.json()).toMatchObject({requestId:1,draftRevision:r.draftRevision,state:'ready'});
    const saved=await fetch(url+'/api/grid-bots',{method:'POST',headers,body:JSON.stringify(r)});expect(saved.status).toBe(201);const body=await saved.json();
    const foreign=await fetch(url+'/api/grid-bots/'+body.bot.id,{headers:{'x-wallet':'REDACTED'}}),missing=await fetch(url+'/api/grid-bots/'+randomUUID(),{headers});expect(foreign.status).toBe(404);expect(await foreign.json()).toEqual(await missing.json());
    expect((await fetch(url+'/api/grid-bots/by-client-request/'+r.clientRequestId,{headers})).status).toBe(200);expect((await fetch(url+'/api/grid-bots/'+body.bot.id+'/levels',{headers})).status).toBe(200);});
  it('keeps start disabled and exposes no funding, provisioning or deposit route',async()=>{const {url,storage}=await api();for(const action of ['provision','deposit','fund'])expect((await fetch(url+'/api/grid-bots/'+randomUUID()+'/'+action,{method:'POST',headers:{'x-wallet':'EXAMPLE'}})).status).toBe(404);expect((await fetch(url+'/api/grid-bots/'+randomUUID()+'/start',{method:'POST',headers:{'x-wallet':'EXAMPLE'}})).status).toBe(503);expect(storage.bots.size).toBe(0);});
});
