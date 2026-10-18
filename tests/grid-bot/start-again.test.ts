import {describe,it,expect,vi} from 'vitest';
import {Children,createElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {gridSurface} from '../../server/grid-bot/surface';
import {gridCanStartAgain} from '../../client/src/lib/grid-live-view';
import {gridSetupForm,gridSetupIntent} from '../../client/src/lib/grid-setup-view';
import {GridStartAgain} from '../../client/src/components/grid-bot/GridBotDrawer';

function fixture(){
  const s=gridSurface({bot:{id:'EXAMPLE',name:'Ended Grid',market:'ETH-PERP',direction:'short',status:'stopped',
    lowerPrice:'90',upperPrice:'110',gridCount:17,updatedAt:new Date()},levels:[],operations:[]},null,null,{pending:0,uncertain:0});
  const form={...gridSetupForm(undefined,''),market:'ETH-PERP',side:'short' as const,lower:'90',upper:'110',stop:'115',intervals:'17',
    timeframe:'4h',bars:'200',investment:'234.56',leverage:'3',seed:false,entryScale:'ascending' as const,profitScale:'descending' as const};
  s.bot.createIntent=gridSetupIntent(form,form.stop,'auto');
  s.lifecycle={action:'stop',state:'complete',blocker:null};s.sweep='Confirmed terminal';
  s.draftEnabled=true;s.startEnabled=true;s.workerRunning=true;
  return {s,form};
}

describe('Start again opens a fresh editable draft',()=>{
  it('copies every saved setting through the existing callback without mutating the stopped run',()=>{
    const {s,form}=fixture(),onAdjust=vi.fn(),before=JSON.stringify(s);
    const element=GridStartAgain({surface:s,createEnabled:true,busy:false,onAdjust})!;
    const button=Children.toArray(element.props.children)[0] as ReactElement<{onClick:()=>void}>;
    button.props.onClick();
    expect(onAdjust).toHaveBeenCalledOnce();
    const intent=onAdjust.mock.calls[0][0];
    expect(intent).toEqual({...s.bot.createIntent,rangeSource:'manual'});
    expect(intent).not.toBe(s.bot.createIntent);expect(gridSetupForm(intent,'')).toEqual(form);
    expect(intent).not.toHaveProperty('id');expect(intent).not.toHaveProperty('pnl');expect(intent).not.toHaveProperty('breakeven');
    expect(JSON.stringify(s)).toBe(before);
    expect(renderToStaticMarkup(createElement(GridStartAgain,{surface:s,createEnabled:true,busy:false,onAdjust})))
      .toContain('Start again with the same settings');
  });
  it.each(['active','paused','pausing','stopping','draft','canary','range_exhausted','resuming'])('does not offer a new run while %s',status=>{
    const {s}=fixture();s.bot.status=status;
    expect(gridCanStartAgain(s)).toBe(false);
    expect(GridStartAgain({surface:s,createEnabled:true,busy:false,onAdjust:vi.fn()})).toBeNull();
  });
  it('requires confirmed settlement, saved settings and every existing access gate',()=>{
    const {s}=fixture();expect(gridCanStartAgain(s)).toBe(true);
    for(const changed of [{...s,lifecycle:{...s.lifecycle,state:'pending'}},{...s,sweep:'Pending'},
      {...s,bot:{...s.bot,createIntent:undefined}},{...s,draftEnabled:false},{...s,startEnabled:false},{...s,workerRunning:false}]){
      expect(gridCanStartAgain(changed)).toBe(false);
      expect(GridStartAgain({surface:changed,createEnabled:true,busy:false,onAdjust:vi.fn()})).toBeNull();
    }
    expect(GridStartAgain({surface:s,createEnabled:false,busy:false,onAdjust:vi.fn()})).toBeNull();
  });
  it('blocks a busy click and rechecks settlement before handing off',()=>{
    const {s}=fixture(),onAdjust=vi.fn();
    const busy=GridStartAgain({surface:s,createEnabled:true,busy:true,onAdjust})!;
    const button=Children.toArray(busy.props.children)[0] as ReactElement<{onClick:()=>void;disabled:boolean}>;
    expect(button.props.disabled).toBe(true);button.props.onClick();expect(onAdjust).not.toHaveBeenCalled();
    const ready=GridStartAgain({surface:s,createEnabled:true,busy:false,onAdjust})!;
    s.lifecycle.state='pending';
    (Children.toArray(ready.props.children)[0] as ReactElement<{onClick:()=>void}>).props.onClick();
    expect(onAdjust).not.toHaveBeenCalled();
  });
});
