import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {gridPnl,type GridEconomicFill} from '../../server/grid-bot/pnl';
import {gridSurface} from '../../server/grid-bot/surface';
import {gridBreakevenView,gridProfitCoversPosition} from '../../client/src/lib/grid-live-view';
import {GridBotDetails} from '../../client/src/components/grid-bot/GridBotDrawer';

const now=1_800_000_000_000;
const fill=(index:number,leg:'entry'|'exit',size:string,price:string,fee='0'):GridEconomicFill=>({
  tradeId:String(index),operationId:'EXAMPLE',orderId:String(index),levelId:null,time:index,leg,size,price,fee,
});
function surface(direction:'long'|'short',fills:GridEconomicFill[],mark='100'){
  const pnl=gridPnl(direction,fills,{price:mark,observedAt:now});
  return gridSurface({bot:{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction,status:'active',lowerPrice:'80',upperPrice:'120',
    gridCount:4,updatedAt:new Date(now)},levels:[],operations:[]},{reconciled_at:new Date(now),pnl,
    observation:{observedAt:now,inventoryComplete:true,orders:[],position:{size:pnl.quantity,direction},mark:{price:mark,observedAt:now}}},
    null,{pending:0,uncertain:0},now);
}

describe('Grid bot-lifetime Convention B display',()=>{
  it('matches spec sections 6 Scenario A and 15 while retaining average-cost accounting',()=>{
    const fills=[fill(1,'entry','1000','0.1'),fill(2,'entry','500','0.2'),fill(3,'exit','750','0.25')];
    const pnl=gridPnl('long',fills,{price:'0.25',observedAt:now});
    expect(pnl).toMatchObject({quantity:'750',costBasis:'100',averageEntry:'0.133333333333333333',
      breakeven:'0.133333333333333333',botBreakeven:'0.016666666666666667',realised:'87.5',unrealised:'87.5',total:'175'});
    const rebought=gridPnl('long',[...fills,fill(4,'entry','200','0.3')],null);
    expect(rebought.botBreakeven).toBe('0.076315789473684211'); // (12.5 + 60) / 950
    expect(rebought.costBasis).toBe('160');
  });
  it('carries profit through multiple flat cycles and different level identities on the same bot',()=>{
    const fills=[fill(1,'entry','2','100'),fill(2,'exit','2','110'),fill(3,'entry','1','120'),fill(4,'exit','1','130'),
      {...fill(5,'entry','2','100'),levelId:'EXAMPLE_NEXT'}];
    expect(gridPnl('long',fills.slice(0,4),null)).toMatchObject({cycles:2,quantity:'0',botBreakeven:null,profitCoversPosition:false});
    expect(gridPnl('long',fills,{price:'90',observedAt:now})).toMatchObject({cycles:2,quantity:'2',averageEntry:'100',
      botBreakeven:'85',realised:'30',unrealised:'-20',total:'10'});
    expect(gridPnl('long',[...fills].reverse().concat(fills[0]),null).botBreakeven).toBe('85');
    expect(gridBreakevenView(surface('long',fills,'90'),now)).toEqual({price:'85',percent:'5.88',tone:'profit'});
  });
  it('carries earlier losses into a later long re-entry',()=>{
    expect(gridPnl('long',[fill(1,'entry','1','100'),fill(2,'exit','1','80'),fill(3,'entry','1','90')],
      {price:'110',observedAt:now})).toMatchObject({averageEntry:'90',botBreakeven:'110',total:'0'});
  });
  it('mirrors short net proceeds, retaining profits across a full close and reopen',()=>{
    const fills=[fill(1,'entry','2','100'),fill(2,'exit','2','90'),fill(3,'entry','2','100'),fill(4,'exit','1','80')];
    expect(gridPnl('short',fills,{price:'140',observedAt:now})).toMatchObject({averageEntry:'100',
      botBreakeven:'140',realised:'40',total:'0',profitCoversPosition:false,cycles:1});
    expect(gridBreakevenView(surface('short',fills,'130'),now)).toEqual({price:'140',percent:'7.14',tone:'profit'});
    expect(gridBreakevenView(surface('short',fills,'150'),now)?.tone).toBe('loss');
  });
  it.each([
    {direction:'long' as const,exit:'110',expected:'92',average:'100.5',mark:'92'},
    {direction:'short' as const,exit:'90',expected:'108',average:'99.5',mark:'108'},
  ])('includes both actual entry and exit fees for $direction',({direction,exit,expected,average,mark})=>{
    expect(gridPnl(direction,[fill(1,'entry','2','100','1'),fill(2,'exit','1',exit,'1')],{price:mark,observedAt:now}))
      .toMatchObject({botBreakeven:expected,averageEntry:average,total:'0',fees:'2',includesFunding:false,
        includesFutureCloseFee:false,label:'PnL excludes funding'});
  });
  it.each(['200','210'])('hides a covered long line and renders the message after exit at %s',exit=>{
    const s=surface('long',[fill(1,'entry','2','100'),fill(2,'exit','1',exit)]);
    expect(gridBreakevenView(s,now)).toBeNull();expect(gridProfitCoversPosition(s,now)).toBe(true);
    const html=renderToStaticMarkup(createElement(GridBotDetails,{surface:s,now}));
    expect(html).toContain('Profit covers your position');expect(html).toContain('Average entry');
    expect(html).toContain('100');expect(html).not.toContain('Average open');
    expect(gridProfitCoversPosition(s,now+15001)).toBe(false);
    s.position!.size='0';expect(gridProfitCoversPosition(s,now)).toBe(false);
  });
  it('retains excess profit on later buys instead of clamping lifetime net outlay',()=>{
    const fills=[fill(1,'entry','2','100'),fill(2,'exit','1','250')];
    expect(gridPnl('long',[...fills,fill(3,'entry','1','40')],null)).toMatchObject({botBreakeven:'-5',profitCoversPosition:true});
    expect(gridPnl('long',[...fills,fill(3,'entry','1','60')],null)).toMatchObject({botBreakeven:'5',profitCoversPosition:false});
  });
  it('does not mistake a positive exact outlay rounded to zero for a covered position',()=>{
    expect(gridPnl('long',[fill(1,'entry','1','0.0000000000000000001')],null))
      .toMatchObject({botBreakeven:'0',profitCoversPosition:false});
  });
  it.each(['200','210'])('never calls a nonpositive short threshold house money after buyback at %s',exit=>{
    const s=surface('short',[fill(1,'entry','2','100'),fill(2,'exit','1',exit)]);
    expect(gridBreakevenView(s,now)).toBeNull();expect(gridProfitCoversPosition(s,now)).toBe(false);
    expect(renderToStaticMarkup(createElement(GridBotDetails,{surface:s,now}))).not.toContain('Profit covers your position');
  });
  it('expires cumulative display authority and never falls back from an explicit null to average entry',()=>{
    const s=surface('long',[fill(1,'entry','2','100'),fill(2,'exit','1','110')]);
    expect(s.pnl.botBreakeven).toBe('90');expect(gridBreakevenView(s,now+15001)).toBeNull();
    const stale=gridSurface({bot:{...s.bot,updatedAt:new Date(now)},levels:[],operations:[]},
      {pnl:{botBreakeven:'-10',profitCoversPosition:true}},null,{pending:0,uncertain:0},now);
    expect(stale.pnl).toMatchObject({botBreakeven:null,profitCoversPosition:false});
    s.pnl.botBreakeven=null;expect(gridBreakevenView(s,now)).toBeNull();
    delete s.pnl.botBreakeven;expect(gridBreakevenView(s,now)?.price).toBe('100');
  });
});
