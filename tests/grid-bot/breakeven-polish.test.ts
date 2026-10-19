import {describe,it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {stopLocksProfit} from '../../shared/grid-breakeven';
import {gridSurface,gridEndedRun} from '../../server/grid-bot/surface';
import {gridPnl,type GridEconomicFill} from '../../server/grid-bot/pnl';
import {GridStorage} from '../../server/grid-bot/storage';
import {gridBreakevenSentence,gridStopProtected,gridBreakevenView,gridProfitCoversPosition} from '../../client/src/lib/grid-live-view';
import {GridBotOverview,GridBotDetails} from '../../client/src/components/grid-bot/GridBotDrawer';

const now=1_800_000_000_000;
const fill=(time:number,leg:'entry'|'exit',size:string,price:string,fee='0'):GridEconomicFill=>({
  tradeId:String(time),operationId:'EXAMPLE',orderId:String(time),levelId:null,time,leg,size,price,fee,
});
function fixture(side:'long'|'short'='long',fills=[fill(1,'entry','1','95.8')],mark='100',status='active'){
  const pnl=gridPnl(side,fills,{price:mark,observedAt:now});
  return gridSurface({bot:{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction:side,status,lowerPrice:'90',upperPrice:'110',
    stopLossPrice:side==='long'?'97':'103',gridCount:4,updatedAt:new Date(now)},levels:[],operations:[],runFills:fills},
    {reconciled_at:new Date(now),pnl,observation:{observedAt:now,inventoryComplete:true,orders:[],position:{size:pnl.quantity,direction:side},
      mark:{price:mark,observedAt:now},qualification:{feeRate:'0.01',observedAt:now}}},null,{pending:0,uncertain:0},now);
}
const overview=(surface:ReturnType<typeof fixture>)=>renderToStaticMarkup(createElement(GridBotOverview,{surface,now}));
const details=(surface:ReturnType<typeof fixture>)=>renderToStaticMarkup(createElement(GridBotDetails,{surface,now}));

describe('plain breakeven distance on the drawer face',()=>{
  it.each([
    ['long','95.8','100','BTC can fall 4.2% before this bot is at a loss'],
    ['short','104.2','100','BTC can rise 4.2% before this bot is at a loss'],
    ['long','104.2','100','BTC needs to rise 4.2% for this bot to break even'],
    ['short','95.8','100','BTC needs to fall 4.2% for this bot to break even'],
    ['long','100','100',"BTC is at this bot's breakeven"],
    ['short','100.01','100','BTC can rise less than 0.1% before this bot is at a loss'],
  ] as const)('uses mark-relative distance for %s', (side,entry,mark,sentence)=>{
    const s=fixture(side,[fill(1,'entry','1',entry)],mark);
    expect(gridBreakevenSentence(s,now)).toBe(sentence);
    expect(overview(s)).toContain(sentence.replaceAll("'",'&#x27;'));
    s.bot.market='ETH-PERP';expect(gridBreakevenSentence(s,now)).toMatch(/^ETH /);
  });
  it('renders house money and still counts it as protected at the stop',()=>{
    const s=fixture('long',[fill(1,'entry','2','100'),fill(2,'exit','1','210')]);
    expect(gridBreakevenSentence(s,now)).toBe('Profit covers your position');
    expect(gridStopProtected(s,now)).toBe(true);
    expect(overview(s)).toContain('Protected: even if it hits its stop, this bot keeps a profit.');
    expect(overview(s)).not.toContain('BTC can');expect(gridBreakevenView(s,now)).toBeNull();
  });
  it('omits the sentence without a position, line, mark or fresh observation',()=>{
    const s=fixture();
    for(const changed of [{...s,position:null},{...s,position:{size:'0',direction:'long'}},{...s,pnl:{...s.pnl,botBreakeven:null}},
      {...s,mark:null},{...s,observedAt:new Date(now-15001).toISOString()}]){
      expect(gridBreakevenSentence(changed,now)).toBeNull();expect(overview(changed)).not.toContain('BTC can');
    }
    expect(gridBreakevenSentence(fixture('short',[fill(1,'entry','2','100'),fill(2,'exit','1','210')]),now)).toBeNull();
  });
});

describe('strict stopLocksProfit for future range confirmation',()=>{
  it.each([
    ['long','101','100',true],['long','100','100',false],['long','99','100',false],
    ['short','99','100',true],['short','100','100',false],['short','101','100',false],
    ['long','1','0',true],['long','1','-10',true],['short','1','-10',false],
    ['long','100.000000000000000001','100',true],['short','99.999999999999999999','100',true],
    ['long',null,'100',false],['long','0','100',false],['short','NaN','100',false],
    ['long','100',null,false],['flat','101','100',false],['long','101\n','100',false],
  ])('%s stop %s against %s', (side,stop,breakeven,result)=>{
    expect(stopLocksProfit(side as string,stop as string|null,breakeven as string|null)).toBe(result);
  });
});

describe('conservative stop protection display',()=>{
  it.each([
    ['long','100','102',true],['long','100','101',false],['long','99','100',false],
    ['short','100','98',true],['short','100','99.5',false],['short','101','100',false],
  ] as const)('checks future closing fees for %s', (side,entry,stop,expected)=>{
    const s=fixture(side,[fill(1,'entry','1',entry)]);s.bot.stopLossPrice=stop;
    expect(gridStopProtected(s,now)).toBe(expected);
    expect(overview(s).includes('Protected:')).toBe(expected);
  });
  it.each(['long','short'] as const)('does not claim profit exactly at the fee-adjusted boundary for %s',side=>{
    const entry=side==='long'?'99':'101',s=fixture(side,[fill(1,'entry','1',entry)]);s.bot.stopLossPrice='100';
    expect(stopLocksProfit(side,'100',entry)).toBe(true);expect(gridStopProtected(s,now)).toBe(false);
  });
  it.each(['long','short'] as const)('does not turn an 18-place rounded threshold into protection for %s',side=>{
    const s=fixture(side);s.bot.stopLossPrice='100';s.pnl.botBreakeven=side==='long'?'98.999999999999999999':'101.000000000000000001';
    expect(gridStopProtected(s,now)).toBe(false);
  });
  it('includes actual entry and realised exit fees once through Convention B',()=>{
    const s=fixture('long',[fill(1,'entry','2','100','2'),fill(2,'exit','1','110','1')],'110');
    expect(s.pnl.botBreakeven).toBe('93');s.bot.stopLossPrice='94';expect(gridStopProtected(s,now)).toBe(true);
    s.bot.stopLossPrice='93.9';expect(gridStopProtected(s,now)).toBe(false);
  });
  it('requires the fresh conservative fee reading, stop, position, matching side and Convention B',()=>{
    const s=fixture();expect(s.stopFee).toEqual({rate:'0.01',observedAt:new Date(now).toISOString()});
    expect(gridStopProtected(s,now)).toBe(true);expect(gridStopProtected(s,now+5001)).toBe(false);
    for(const changed of [{...s,stopFee:null},{...s,stopFee:{rate:'1',observedAt:new Date(now).toISOString()}},
      {...s,stopFee:{rate:'-0.01',observedAt:new Date(now).toISOString()}},
      {...s,stopFee:{rate:'0',observedAt:new Date(now+1).toISOString()}},
      {...s,position:null},{...s,position:{size:'0',direction:'long'}},
      {...s,bot:{...s.bot,stopLossPrice:null}},{...s,bot:{...s.bot,direction:'short'}},
      {...s,pnl:{...s.pnl,botBreakeven:undefined}},{...s,observedAt:new Date(now-15001).toISOString()}]){
      expect(gridStopProtected(changed,now)).toBe(false);
    }
  });
  it('projects fees only from a fresh qualified monitor observation',()=>{
    const s=fixture(),snapshot={bot:{...s.bot,updatedAt:new Date(now)},levels:[],operations:[]};
    const observation={observedAt:now,inventoryComplete:true,orders:[],qualification:{feeRate:'0.01',observedAt:now}};
    const project=(o:typeof observation,at=now)=>gridSurface(snapshot,{reconciled_at:new Date(now),observation:o},null,{pending:0,uncertain:0},at).stopFee;
    expect(project(observation)).toEqual(s.stopFee);
    for(const changed of [{...observation,inventoryComplete:false},
      {...observation,qualification:{feeRate:'0.01',observedAt:now-5001}},
      {...observation,qualification:{feeRate:'0.01',observedAt:now+1}},
      {...observation,qualification:{feeRate:'1',observedAt:now}},
      {...observation,qualification:{feeRate:'-0.01',observedAt:now}}])expect(project(changed)).toBeNull();
    expect(project(observation,now+15001)).toBeNull();
  });
});

describe('ended run in existing lifecycle details',()=>{
  it.each(['long','short'] as const)('keeps final realised P&L and the last open threshold after stale %s observations',side=>{
    const fills=[fill(1,'entry','2','100','2'),fill(2,'exit','1',side==='long'?'110':'90','1'),fill(3,'exit','1','100','1')];
    const s=fixture(side,fills,'100','stopped');s.observedAt=null;
    const expected=side==='long'?'93':'107';
    expect(s.endedRun).toEqual({realised:'6',finalBreakeven:expected});
    expect(details(s)).toContain(`Run ended · realised P&amp;L $6 · final breakeven $${expected}`);
    // Even an accidentally fresh old position must never resurrect a stopped line/message.
    s.observedAt=new Date(now).toISOString();s.position={size:'1',direction:side};s.pnl.botBreakeven='90';s.pnl.profitCoversPosition=true;
    expect(gridBreakevenView(s,now)).toBeNull();expect(gridProfitCoversPosition(s,now)).toBe(false);
    expect(gridBreakevenSentence(s,now)).toBeNull();expect(gridStopProtected(s,now)).toBe(false);
  });
  it('replays every cycle beyond the chart marker limit and deduplicates exact trades',()=>{
    const fills=Array.from({length:60},(_,i)=>[fill(i*2+1,'entry','1','100'),fill(i*2+2,'exit','1','101')]).flat();
    const s=fixture('long',fills,'100','stopped');
    expect(s.endedRun).toEqual({realised:'60',finalBreakeven:'41'});
    expect(gridEndedRun('long',[...fills].reverse().concat(fills[0]))).toEqual(s.endedRun);
    expect(fixture('long',fills).endedRun).toBeNull();
  });
  it('reads the full terminal ledger in the existing snapshot without changing the chart marker limit or writing money state',async()=>{
    const fills=Array.from({length:60},(_,i)=>[fill(i*2+1,'entry','1','100'),fill(i*2+2,'exit','1','101')]).flat();
    const rows=fills.map(f=>({trade_id:f.tradeId,operation_id:f.operationId,order_id:f.orderId,level_id:f.levelId,
      venue_time:f.time,leg:f.leg,size:f.size,price:f.price,fee:f.fee}));
    const query=vi.fn(async(sql:string)=>{
      if(sql.startsWith('SELECT * FROM grid_bots'))return {rows:[{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction:'long',status:'stopped',
        grid_count:1,lower_price:'90',upper_price:'110',start_price:'100',total_investment:'500',total_fees:'0',
        stop_loss_percent:null,stop_loss_price:'80',sol_balance:null,residual_usdc:'0',updated_at:new Date(now)}]};
      if(sql.startsWith('SELECT id,bot_id,ordinal,price,size,side,reduce_only,status,venue_order_id,client_order_uuid,placement_attempt,cumulative_filled_size,last_filled_at,created_at,updated_at FROM grid_levels'))return {rows:[90,110].map((price,i)=>({id:String(i),ordinal:i+1,price:String(price),size:'1',cumulative_filled_size:'0'}))};
      if(sql.includes('FROM grid_exact_fills'))return {rows:sql.includes('LIMIT 100')?rows.slice(-100).reverse():rows};
      if(sql.includes('AS pending'))return {rows:[{pending:0,uncertain:0}]};
      return {rows:[]};
    });
    const release=vi.fn(),storage=new GridStorage({connect:async()=>({query,release})} as never,async()=>{});
    const result=await storage.getBotSnapshot('EXAMPLE','EXAMPLE',true);
    expect(result.surface?.endedRun).toEqual({realised:'60',finalBreakeven:'41'});
    expect(result.surface?.fills).toHaveLength(100);expect(release).toHaveBeenCalledOnce();
    expect(query.mock.calls.every(([sql])=>/^(?:SELECT|SET|BEGIN|COMMIT)/.test(sql))).toBe(true);
  });
  it('shows unavailable facts for missing or non-flat terminal ledgers',()=>{
    expect(gridEndedRun('long',[])).toBeNull();expect(gridEndedRun('long',[fill(1,'entry','1','100')])).toBeNull();
    expect(gridEndedRun('long',[fill(1,'exit','1','100')])).toBeNull();
    expect(details(fixture('long',[],'100','stopped'))).toContain('Run ended · realised P&amp;L — · final breakeven —');
  });
  it('prefixes every rendered money field with dollars',()=>{
    const s=fixture();s.pnl.realised='12';s.pnl.unrealised='4.2';s.pnl.total='16.2';s.pnl.fees='1.1';s.residual='50';
    expect(overview(s)).toContain('$16.2');expect(overview(s)).toContain('$90');expect(overview(s)).toContain('$110');
    for(const text of ['$12','$4.2','$95.8','$1.1','$100','$50'])expect(details(s)).toContain(text);
  });
});
