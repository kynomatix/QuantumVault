import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {GridWorkerRescueView} from '../../client/src/components/grid-bot/GridWorkerRescueView';
import {GridWorkerStatusView,GridWorkerDrawerView} from '../../client/src/components/grid-bot/GridWorkerStatusView';
import {workerCopyViolation} from '../../shared/grid-worker-copy-check';
import {auditGridWorkerCopy} from '../../script/grid-worker-copy-audit';
import {rescueBotLocked} from '../../client/src/lib/grid-worker-rescue-copy';
import {rescue,rescueCases,rescueProps} from '../helpers/grid-worker-u6b-fixtures';
import {fixtureId,fixtureNames,presentation,status,incident} from '../helpers/grid-worker-u5b-fixtures';
const render=(props= rescueProps())=>renderToStaticMarkup(React.createElement(GridWorkerRescueView,props));
const words=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&quot;/g,'"');
describe('U6b actual rescue markup',()=>{
  it.each(rescueCases())('renders %s with audited copy',(name,props)=>{
    const html=render(props);expect(workerCopyViolation(words(html))).toBe(false);
    if(['non-owner','legacy','dormant'].includes(name))expect(html).toBe('');else expect(html).toContain('Rescue close');
    expect(html).not.toMatch(/Checked on Pacifica|slippage|\bClosed\b/);
    if(name.startsWith('blocker-')||name==='stale-offer')expect(html).toMatch(/disabled=""[^>]*>Rescue close this bot/);
    if(name.startsWith('phase-')){expect(html).not.toContain('Sign rescue close');expect(html).not.toContain('Rescue not started');}
  });
  it('distinguishes complete, incomplete and unknown phases without inventing observations',()=>{
    const result=(phase:string)=>render(rescueProps({state:presentation({status:status({rescue:rescue({phase,live:false,next:'done',completedSeconds:null})})})}));
    expect(result('complete')).toContain('Rescue close finished. Completion time unavailable.');
    expect(result('partial_ended')).toContain('ended without confirming this bot closed');
    expect(result('EXAMPLE_UNKNOWN')).not.toContain('gw-teal');
  });
  it('keeps old unresolved phone warnings on both card and target drawer',()=>{
    const p=presentation({status:status({rescueAlertsPhone:false,incidents:[incident({code:'protective_failure',acknowledged:true})],rescue:rescue({live:false,next:'done',phase:'partial_ended',completedSeconds:1900})})});
    for(const html of [render(rescueProps({state:p})),renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:p,names:fixtureNames,canSign:true}))])expect(words(html)).toContain("Phone delivery isn't confirmed. Check here.");
    expect(render(rescueProps({state:{...p,status:{...p.status!,rescueAlertsPhone:true}}}))).toBe('');
  });
  it('expires an outcome only after thirty minutes, or stop, unless unknown',()=>{
    const r=rescue({live:false,next:'done',phase:'complete',completedSeconds:1790});
    const props=rescueProps({state:presentation({status:status({rescue:r,rescueAlertsPhone:true}),elapsedSeconds:11})});
    expect(render(props)).toBe('');expect(render({...props,state:{...props.state,elapsedSeconds:0},stopped:true})).toBe('');
    expect(render({...props,state:{...props.state,status:status({rescue:{...r,unknownOpen:true},rescueAlertsPhone:true})},stopped:true})).toContain('outcome is settled');
  });
  it('keeps other-bot warnings and restrictions independently visible; stale never asserts a current stop state',()=>{
    const state=presentation({status:status({rescue:rescue(),stopsAllowed:false,executionRestrictions:['trading_off']})});
    const line=renderToStaticMarkup(React.createElement(GridWorkerDrawerView,{state,botId:fixtureId(3),names:fixtureNames}));expect(words(line)).toContain('No bot has an automatic stop');expect(words(line)).toContain("Worker trading is off");
    const html=render(rescueProps({state:{...state,overlay:'stale'}}));expect(words(html)).toContain("Automatic stops aren't confirmed");expect(html).not.toContain('No bot has an automatic stop');
  });
  it('uses wrapping names and full-width small-screen controls in the real surface',()=>{
    const html=render(rescueProps({confirming:true}));expect(words(html)).toContain(fixtureNames.get(fixtureId(2)));expect(html).toContain('gw-name');expect(html).toContain('min-w-0');
    const css=readFileSync('client/src/components/grid-bot/grid-worker.css','utf8');expect(css).toContain('@container (max-width: 520px)');expect(css).toContain('width: 100%');expect(css).toContain('overflow-wrap: anywhere');
  });
  it('locks the target and conservatively blocks all bots with an unknown retained outcome',()=>{
    expect(rescueBotLocked(status({rescue:rescue()}),fixtureId(2))).toBe(true);expect(rescueBotLocked(status({rescue:rescue()}),fixtureId(3))).toBe(false);
    expect(rescueBotLocked(status({rescue:rescue({unknownOpen:true})}),fixtureId(3))).toBe(true);
  });
  it('audits every changed status surface and proves new banned copy fires',()=>{
    for(const file of ['client/src/lib/grid-worker-rescue-copy.ts','client/src/lib/grid-worker-rescue-driver.ts','client/src/lib/grid-worker-copy.ts','client/src/components/grid-bot/GridWorkerRescueView.tsx','client/src/components/grid-bot/GridWorkerRescuePanel.tsx','client/src/components/grid-bot/GridWorkerContext.tsx','client/src/components/grid-bot/GridWorkerStatusView.tsx','client/src/components/grid-bot/GridWorkerInbox.tsx'])auditGridWorkerCopy(readFileSync(file,'utf8'),file);
    for(const prose of ['Use the runbook','Slippage 0.5%','0.5% slippage','action:EXAMPLE_OTHER'])expect(()=>auditGridWorkerCopy('const x=<p>'+prose+'</p>','EXAMPLE.tsx')).toThrow('GRID_STATUS_COPY_INVALID');
    expect(workerCopyViolation('action:break_glass_close')).toBe(false);
  });
});

it('a new signature prompt takes precedence over an older terminal outcome',()=>{
  const p=rescueProps();p.state.status={...p.state.status!,rescue:rescue({live:false,next:'done',phase:'partial_ended',completedSeconds:30})};
  p.driverState={botId:p.botId,mode:'signing',driving:false,notice:''};
  const html=words(render(p));expect(html).toContain('Check your wallet');expect(html).not.toContain('ended without confirming');
});
it('confirmation discloses wallet-wide pause and stop consequences before signing',()=>{
  const html=words(render({...rescueProps(),confirming:true}));expect(html).toContain('new activity pauses for all bots');expect(html).toContain('other bots have no automatic stop until the worker takes back control');expect(html).toContain('Trading fees may apply');
});

it('suppresses the target drawer duplicate rescue line while retaining independent restrictions',()=>{
  const state=presentation({status:status({rescue:rescue(),executionRestrictions:['trading_off']})});
  const html=words(renderToStaticMarkup(React.createElement(GridWorkerDrawerView,{state,botId:fixtureId(2),names:fixtureNames})));
  expect(html).not.toContain('A rescue close is running on');expect(html).toContain('Worker trading is off');
});
