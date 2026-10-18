import {describe,it,expect} from 'vitest';
import {GridReadOrder,GridActionKeys,gridAdjustReady,gridFactsFresh,gridRangeState,gridBreakevenView,gridVisibleActions,gridCycleDisplayLevels} from '../../client/src/lib/grid-live-view';
import {gridActionAllowed} from '../../shared/grid-surface';
import {gridSurface} from '../../server/grid-bot/surface';
const snapshot=()=>({bot:{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction:'long',status:'stopping',lowerPrice:'90',upperPrice:'110',gridCount:20,updatedAt:new Date(),createIntent:{lowerPrice:'90'},residualUsdc:'0',residualObservedAt:new Date()},levels:[],operations:[]});
describe('Grid owner surface request and settlement guards',()=>{
  it('projects an absent preference as on but unarmed and retains explicit off',()=>{const s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0});expect(s.autoResume).toMatchObject({enabled:true,generation:'0',armed:false,heldReason:null});const off=gridSurface({...snapshot(),autoPreference:{enabled:false,generation:'2',held_reason:'preference_off'}},null,null,{pending:0,uncertain:0});expect(off.autoResume).toMatchObject({enabled:false,generation:'2',armed:false});});
  it('projects both cycle legs as stopped and retains paused opening semantics',()=>{
    const now=Date.now(),orders=[{ownerOrdinal:0,leg:'opening',price:'90',side:'buy',size:'1',state:'queued'},{ownerOrdinal:0,leg:'closing',price:'100',side:'sell',size:'1',state:'waiting for fills'}];
    const base={...snapshot(),cycleProjection:{generation:'1',observedAt:now,orders}},monitor={generation:'1',reconciled_at:new Date(now),observation:{observedAt:now,inventoryComplete:true,orders:[]}};
    const project=(status:string)=>gridSurface({...base,bot:{...base.bot,policyVersion:'2.0.0',status}},monitor,null,{pending:0,uncertain:0},now).cycleProjection!.orders.map(o=>o.state);
    expect(project('stopped')).toEqual(['stopped','stopped']);expect(project('paused')).toEqual(['paused','waiting for fills']);
  });
  it('labels both stopped cycle legs Stopped for the drawer and chart',()=>{
    const now=Date.now(),orders=[{ownerOrdinal:0,leg:'opening',price:'90',side:'buy',size:'1',state:'queued'},{ownerOrdinal:0,leg:'closing',price:'100',side:'sell',size:'1',state:'waiting for fills'}];
    const monitor={generation:'1',reconciled_at:new Date(now),observation:{observedAt:now,inventoryComplete:true,orders:[]}};
    const surface=gridSurface({...snapshot(),bot:{...snapshot().bot,policyVersion:'2.0.0',status:'stopped'},cycleProjection:{generation:'1',observedAt:now,orders}},monitor,null,{pending:0,uncertain:0},now);
    expect(gridCycleDisplayLevels(surface,now).map(o=>o.status)).toEqual(['Stopped','Stopped']);
    expect(surface.cycleProjection!.orders.map(o=>o.state)).toEqual(['stopped','stopped']);
  });
  it('rejects delayed detail reads after a newer read, action or identity change',()=>{const reads=new GridReadOrder(),old=reads.next(),newer=reads.next();expect(reads.accepts(old)).toBe(false);expect(reads.accepts(newer)).toBe(true);reads.next();expect(reads.accepts(newer)).toBe(false);});
  it('retains lost-response action identity without triggering a replay',()=>{const keys=new GridActionKeys();let calls=0;const uuid=()=>`EXAMPLE_${++calls}`;expect(keys.key('EXAMPLE','stop',uuid)).toBe(keys.key('EXAMPLE','stop',uuid));expect(calls).toBe(1);keys.accepted('EXAMPLE','stop');keys.key('EXAMPLE','stop',uuid);expect(calls).toBe(2);});
  it('does not fabricate financial zero or terminal state from an empty or stale read',()=>{const s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0});expect(s.pnl.total).toBeNull();expect(s.position).toBeNull();expect(s.capacity.liveOrders).toBeNull();expect(gridAdjustReady(s)).toBe(false);expect(s.sweep).toBe('Awaiting venue settlement');expect(s.authorities).toMatchObject({safeWindow:false,safeWindowState:'unavailable',resume:false,lostSweepLookup:false,breaker:'retained_terminal_failures'});expect(s.startEnabled).toBe(false);expect(s.workerEnabled).toBe(false);expect(s.qualification).toEqual({firstConfirmedAt:null,cleanSince:null,cleanTicks:null,promotedAt:null});});
  it('expires a once-fresh snapshot while preserving realised ledger PnL',()=>{const now=Date.now(),s=gridSurface(snapshot(),{reconciled_at:new Date(now),observation:{observedAt:now,inventoryComplete:true,orders:[],position:{size:'0',direction:'long'}},pnl:{realised:'2',unrealised:'0',total:'2',fees:'0.01'}},null,{pending:0,uncertain:0},now);expect(s.pnl.total).toBe('2');expect(s.position?.size).toBe('0');expect(gridFactsFresh(s,now)).toBe(true);expect(gridFactsFresh(s,now+15001)).toBe(false);const stale=gridSurface(snapshot(),{reconciled_at:new Date(now-15001),pnl:{realised:'2',total:'2'}},null,{pending:0,uncertain:0},now);expect(stale.pnl.realised).toBe('2');expect(stale.pnl.total).toBeNull();});
  it('requires terminal stop and completed control before opening a new range draft',()=>{const s=gridSurface(snapshot(),null,{action:'stop',state:'pending'},{pending:0,uncertain:0});expect(gridAdjustReady(s)).toBe(false);s.bot.status='stopped';expect(gridAdjustReady(s)).toBe(false);s.lifecycle.state='complete';s.sweep='Confirmed terminal';expect(gridAdjustReady(s)).toBe(true);expect(s.bot.createIntent).toEqual({lowerPrice:'90'});});
  it('keeps entry controls unavailable on terminal and stopping states',()=>{const s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0});for(const status of ['draft','failed','stopped']){s.bot.status=status;for(const action of ['pause','resume','resync','stop'] as const)expect(gridActionAllowed(s.bot,action)).toBe(false);}s.bot.status='stopping';expect(gridActionAllowed(s.bot,'stop')).toBe(true);expect(gridActionAllowed(s.bot,'resume')).toBe(false);});
  it('projects cumulative completed ledger cycles without inventing an unknown count',()=>{
    for(const cycles of [0,3,999]) expect(gridSurface(snapshot(),{pnl:{cycles}},null,{pending:0,uncertain:0}).cycles).toBe(cycles);
    for(const cycles of [undefined,-1,1.5,'3',NaN]) expect(gridSurface(snapshot(),{pnl:{cycles}},null,{pending:0,uncertain:0}).cycles).toBeNull();
  });
  it('surfaces retained clock checkpoints and actual confirmed sweep evidence',()=>{
    const now=Date.now(),snap=snapshot();
    const s=gridSurface({...snap,bot:{...snap.bot,canaryStartedAt:new Date(now-60000),canaryCleanSince:new Date(now-30000),canaryCleanTicks:1},returnedFunds:{amount:'42.50',terminal_at:new Date(now-1000)}},null,null,{pending:0,uncertain:0},now);
    expect(s.qualification).toEqual({firstConfirmedAt:new Date(now-60000).toISOString(),cleanSince:new Date(now-30000).toISOString(),cleanTicks:1,promotedAt:null});
    expect(s.returnedFunds).toEqual({amount:'42.50',confirmedAt:new Date(now-1000).toISOString()});
    expect(gridSurface(snapshot(),null,null,{pending:0,uncertain:0}).returnedFunds).toEqual({amount:null,confirmedAt:null});
  });
  it('labels the production history cut as inferred and expires its authority',()=>{
    const now=Date.now(),monitor={reconciled_at:new Date(now),observation:{observedAt:now,inventoryComplete:true,orders:[],history:{source:'pacifica_full_replay_stable_last_id',inclusive:true,lastId:'1',from:now-180000,through:now-120000,publicationLagMs:120000}}};
    expect(gridSurface(snapshot(),monitor,null,{pending:0,uncertain:0},now).authorities).toMatchObject({safeWindow:true,safeWindowState:'inferred'});
    expect(gridSurface(snapshot(),monitor,null,{pending:0,uncertain:0},now+5001).authorities).toMatchObject({safeWindow:false,safeWindowState:'unavailable'});
  });
  it('uses inclusive boundaries and only a fresh positive Pacifica mark for the range badge',()=>{
    const now=Date.now(),s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0},now);s.observedAt=new Date(now).toISOString();
    for(const [mark,label] of [['89','Below range'],['90','Within range'],['100','Within range'],['110','Within range'],['111','Above range']]){s.mark=mark;expect(gridRangeState(s,now)).toBe(label);}
    expect(gridRangeState(s,now+15001)).toBe('Price unavailable');s.observedAt=new Date(now+1).toISOString();expect(gridRangeState(s,now)).toBe('Price unavailable');
    s.observedAt=new Date(now).toISOString();for(const mark of [null,'0','NaN']){s.mark=mark;expect(gridRangeState(s,now)).toBe('Price unavailable');}
  });
  it('offers only applicable requests and never offers unavailable resume authority',()=>{
    const s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0});
    expect(gridVisibleActions(s)).toEqual([]);s.workerRunning=true;
    for(const [status,actions] of [['draft',[]],['failed',[]],['stopped',[]],['stopping',['stop']],['active',['pause','stop']],['paused',['resync','stop']],['range_exhausted',['pause','resync','stop']]] as const){
      s.bot.status=status;expect(gridVisibleActions(s)).toEqual(actions);
      for(const action of gridVisibleActions(s))expect(gridActionAllowed(s.bot,action)).toBe(true);
    }
    expect(gridAdjustReady(s)).toBe(false);
  });
  it('shows a position-only fee-inclusive breakeven with direction-aware profit and loss, then removes stale authority',()=>{
    const now=Date.now(),s=gridSurface(snapshot(),null,null,{pending:0,uncertain:0},now);s.observedAt=new Date(now).toISOString();s.pnl.botBreakeven='100';s.mark='110';s.position={size:'2',direction:'long'};
    expect(gridBreakevenView(s,now)).toEqual({price:'100',percent:'10.00',tone:'profit'});
    s.position.direction='short';expect(gridBreakevenView(s,now)).toEqual({price:'100',percent:'-10.00',tone:'loss'});
    s.mark='90';expect(gridBreakevenView(s,now)?.tone).toBe('profit');s.mark='100';expect(gridBreakevenView(s,now)?.tone).toBe('neutral');
    s.mark=null;expect(gridBreakevenView(s,now)?.percent).toBeNull();expect(gridBreakevenView(s,now+15001)).toBeNull();
    s.position.size='0';expect(gridBreakevenView(s,now)).toBeNull();s.position=null;expect(gridBreakevenView(s,now)).toBeNull();
  });
});
