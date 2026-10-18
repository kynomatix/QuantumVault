import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {GridBotOverview,GridBotDetails,GridAutoResumeSetting} from '../../client/src/components/grid-bot/GridBotDrawer';
import {gridSurface} from '../../server/grid-bot/surface';
vi.mock('../../client/src/components/grid-bot/GridDraftCard',()=>({gridJson:vi.fn()}));
vi.mock('../../client/src/components/grid-bot/GridBotChart',()=>({GridBotChart:()=>null}));

function surface(){
  const s=gridSurface({bot:{id:'EXAMPLE',name:'Grid',market:'BTC-PERP',direction:'long',status:'range_exhausted',lowerPrice:'90000',upperPrice:'100000',gridCount:20,updatedAt:new Date(1000)},levels:[],operations:[]},null,null,{pending:0,uncertain:0},1000);
  s.workerRunning=true;s.startEnabled=true;s.observedAt=new Date(1000).toISOString();s.mark='101000';s.authorities.resume=true;s.lifecycle.action='band';
  s.autoResume={enabled:true,generation:'0',cycle:'1',attempts:0,armed:true,heldReason:'waiting_for_inner_band',heldSince:new Date(1000).toISOString(),available:true,band:{lower:'91800',upper:'98000',tick:'0.1'}};
  return s;
}
const markup=(component:React.ElementType,props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(component,props));
describe('simplified auto-resume drawer',()=>{
  it('renders one waiting line with formatted inner prices and no main-view switch or machinery',()=>{
    const html=markup(GridBotOverview,{surface:surface(),now:1000});
    expect(html).toContain('Waiting for price to return · resumes between $91,800 and $98,000');
    expect(html.match(/Waiting for price to return/g)).toHaveLength(1);
    expect(html).not.toMatch(/role="switch"|2%|tick|rounding|popover|waiting_for_inner_band/);
  });
  it('puts the only preference switch in Details, defaults on, and wires both changes',()=>{
    const s=surface(),change=vi.fn((enabled:boolean)=>{s.autoResume!.enabled=enabled;});
    const html=markup(GridBotDetails,{surface:s,now:1000,onAutoResumeChange:change});
    expect(html.indexOf('<details')).toBeLessThan(html.indexOf('Auto-resume when price returns'));
    expect(html.match(/role="switch"/g)).toHaveLength(1);expect(html).toContain('aria-checked="true"');
    for(const enabled of [false,true]){
      const row=GridAutoResumeSetting({surface:s,busy:false,onChange:change})!;
      const control=React.Children.toArray(row.props.children).find(child=>React.isValidElement<{id?:string}>(child)&&child.props.id==='grid-auto-resume') as React.ReactElement<{onCheckedChange:(enabled:boolean)=>void}>;
      control.props.onCheckedChange(enabled);
      expect(change).toHaveBeenLastCalledWith(enabled);
      expect(markup(GridAutoResumeSetting,{surface:s,busy:false,onChange:change})).toContain('aria-checked="'+enabled+'"');
    }
  });
  it('offers no switch for a narrow range, only one muted line',()=>{
    const s=surface();s.autoResume!.available=false;s.autoResume!.unavailableReason='range_unavailable';s.autoResume!.band=null;
    const html=markup(GridAutoResumeSetting,{surface:s,busy:false,onChange:vi.fn()});
    expect(html).toContain('text-muted-foreground');expect(html).toContain('Auto-resume isn&#x27;t available for this range.');expect(html).not.toContain('switch');
  });
  it('renders a brief safety check or one attention sentence and action without internal reasons',()=>{
    const s=surface();s.autoResume!.heldReason='operation_pending';
    s.lifecycle.blocker='operation_pending';s.entriesBlockedReasons=['reconciliation_required'];const details=markup(GridBotDetails,{surface:s,now:1000});expect(details).not.toMatch(/operation_pending|reconciliation_required/);
    const checking=markup(GridBotOverview,{surface:s,now:1000});expect(checking).toContain('Resuming — checking safety');expect(checking).not.toContain('operation_pending');
    s.autoResume!.heldReason='retry_limit';
    const html=markup(GridBotOverview,{surface:s,now:1000,onResume:vi.fn()});expect(html).toContain('Needs your attention');expect(html).toContain('Your bot needs a fresh safety check before it can resume.');expect(html.match(/<button/g)).toHaveLength(1);expect(html).toContain('Resume</button>');
    s.autoResume!.heldReason='execution_revoked';expect(markup(GridBotOverview,{surface:s,now:1000,onReview:vi.fn()})).toContain('Review</button>');
  });
  it('renders normal Paused after manual or risk pause',()=>{const s=surface();s.bot.status='paused';s.lifecycle.action='pause';const html=markup(GridBotOverview,{surface:s,now:1000});expect(html).toContain('Paused');expect(html).not.toMatch(/Waiting for price to return|Resuming —|Needs your attention/);});
  it('shows user details with local dates and dollar amounts while keeping diagnostic evidence in history',()=>{
    const s=surface();s.bot.totalInvestment='500';s.bot.leverage=2;s.pnl.fees='1.26';s.pnl.averageEntry='93752';
    s.qualification.firstConfirmedAt='2026-10-17T03:00:00.000Z';
    const html=markup(GridBotDetails,{surface:s,now:1000});
    for(const label of ['Investment','Leverage','Grids','Started','Fees','Average entry','$500','$1.26','$93,752'])expect(html).toContain(label);
    expect(html).not.toMatch(/Configured switches|return to master|clean-history|First trading exposure|2026-10-17T|operation_pending|Capacity and launch/);
    s.qualification.firstConfirmedAt='invalid';expect(markup(GridBotDetails,{surface:s,now:1000})).not.toContain('Invalid Date');
  });
});
