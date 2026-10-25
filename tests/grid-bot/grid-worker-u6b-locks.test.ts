import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {GridBotFooter,GridAutoResumeSetting} from '../../client/src/components/grid-bot/GridBotDrawer';
import {GridRangeMoveView} from '../../client/src/components/grid-bot/GridRangeMove';
import {gridSurface} from '../../server/grid-bot/surface';
import {gridSetupForm,gridSetupIntent} from '../../client/src/lib/grid-setup-view';
vi.mock('../../client/src/components/grid-bot/GridDraftCard',()=>({gridJson:vi.fn()}));
vi.mock('../../client/src/components/grid-bot/GridBotChart',()=>({GridBotChart:()=>null}));
function surface(botStatus='active'){
  const s=gridSurface({bot:{id:'EXAMPLE',market:'ETH-PERP',direction:'long',status:botStatus,lowerPrice:'90',upperPrice:'110',gridCount:17,updatedAt:new Date(1000)},levels:[],operations:[]},null,null,{pending:0,uncertain:0},1000);
  const form={...gridSetupForm(undefined,''),market:'ETH-PERP',side:'long' as const,lower:'90',upper:'110',stop:'85',intervals:'17',investment:'100',leverage:'2'};
  s.bot.createIntent=gridSetupIntent(form,form.stop,'manual');s.workerRunning=true;s.startEnabled=true;s.draftEnabled=true;s.lifecycle={action:'stop',state:'complete',blocker:null};s.sweep='Confirmed terminal';
  s.autoResume={enabled:true,generation:'0',cycle:'1',attempts:0,armed:true,heldReason:null,heldSince:null,available:true,band:{lower:'92',upper:'108',tick:'0.1'}};return s;
}
it.each(['active','stopped'])('disables the real %s footer actions during rescue',botStatus=>{
  const props={surface:surface(botStatus),createEnabled:true,busy:false,adjust:false,rescueLocked:true,now:1000,onAdjust:vi.fn(),act:vi.fn(),setConfirm:vi.fn()};
  const html=renderToStaticMarkup(React.createElement(GridBotFooter,props));
  const buttons=html.match(/<button[^>]*>[\s\S]*?<\/button>/g)??[];expect(buttons.length).toBeGreaterThan(0);for(const button of buttons)expect(button).toContain('disabled=""');
  if(botStatus==='active'){expect(html).toContain('>Stop</button>');expect(html).toContain('>Pause</button>');expect(html).toContain('>Adjust Range</button>');}else expect(html).toContain('Start again with the same settings');
  expect(renderToStaticMarkup(React.createElement(GridBotFooter,{...props,rescueLocked:false}))).not.toContain('disabled=""');
});
it('disables the real auto-resume switch and range move controls',()=>{
  const auto=renderToStaticMarkup(React.createElement(GridAutoResumeSetting,{surface:surface(),busy:true,onChange:vi.fn()}));expect(auto).toMatch(/<button[^>]*disabled=""/);expect(auto).toContain('role="switch"');
  const html=renderToStaticMarkup(React.createElement(GridRangeMoveView,{state:{enabled:true,mode:'ask',generation:'0',direction:'long',available:true,epochs:[]},proposal:null,qualified:null,message:'',busy:false,rescueLocked:true,compact:false,perform:vi.fn(),id:'EXAMPLE',alive:{current:true},rescueLock:{current:true},keyRef:{current:''},setState:vi.fn(),setProposal:vi.fn(),setMessage:vi.fn()}));
  expect(html).toMatch(/<select[^>]*disabled=""/);expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move range up/);
});
it('places one wallet provider above navigation and dismisses previously open confirmations on rescue',()=>{
  const app=readFileSync('client/src/pages/App.tsx','utf8'),collection=readFileSync('client/src/components/grid-bot/GridDraftCard.tsx','utf8'),drawer=readFileSync('client/src/components/grid-bot/GridBotDrawer.tsx','utf8'),move=readFileSync('client/src/components/grid-bot/GridRangeMove.tsx','utf8');
  expect((app.match(/<GridWorkerProvider\b/g)??[])).toHaveLength(1);expect(collection).not.toContain('<GridWorkerProvider');expect(app.indexOf('<GridWorkerProvider')).toBeLessThan(app.indexOf('<GridWorkerStatusSlot'));
  expect(drawer).toContain('if(rescueLocked){setConfirm(null);setAdjust(false);adjusting.current=false;}');expect(drawer).toContain('open={!rescueLocked&&confirm!==null}');expect(move).toContain('if(rescueLocked){setProposal(null);setQualified(null);}');
  expect(drawer).toContain('min-h-0 flex-1');expect(drawer.indexOf('<GridWorkerDrawerSlot')).toBeLessThan(drawer.indexOf('<GridWorkerRescuePanel'));
});
