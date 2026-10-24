import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {GridWorkerStatusView,GridWorkerDrawerView} from '../../client/src/components/grid-bot/GridWorkerStatusView';
import {inboxGroups} from '../../client/src/components/grid-bot/GridWorkerInbox';
import {workerCopyViolation} from '../../shared/grid-worker-copy-check';
import {incidentCopy,restrictionText,resumeReason} from '../../client/src/lib/grid-worker-copy';
import {currentPause,decimalCompare} from '../../client/src/lib/grid-worker-view';
import {fixtureNames,fixtureId,incident,presentation,renderCases,status} from '../helpers/grid-worker-u5b-fixtures';
const render=(p= presentation())=>renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:p,names:fixtureNames,canSign:true,expanded:true}));
const words=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&quot;/g,'"');
describe('U5b real markup and copy',()=>{
  it.each(renderCases())('renders %s safely',(_name,p)=>{
    const html=render(p),text=words(html);expect(workerCopyViolation(text)).toBe(false);
    if(!p.admitted||p.status?.executionMode==='legacy'&&!p.status.host.legacy_controls_enabled)expect(html).toBe('');
    else expect(html).toContain('Grid worker');
    const drawer=renderToStaticMarkup(React.createElement(GridWorkerDrawerView,{state:p,botId:fixtureId(2)}));
    expect((drawer.match(/<p\b/g)??[]).length).toBeLessThanOrEqual(1);expect(workerCopyViolation(words(drawer))).toBe(false);
  });
  it.each(Object.keys(incidentCopy))('renders reviewed incident %s',code=>{expect(workerCopyViolation(words(render(presentation({status:status({incidents:[incident({code})],unacknowledgedCritical:1})}))))).toBe(false);});
  it.each([fixtureId(7),'EXAMPLE_RAW_CODE','0x'+'a'.repeat(40),'$123.45','100 USDC','Error: EXAMPLE','1'.repeat(44),String.fromCharCode(100,114,105,102,116)])('copy check rejects injected forbidden text',value=>expect(workerCopyViolation(value)).toBe(true));
  it('retains truthful restrictions beside higher priority alerts in both modes',()=>{
    for(const executionMode of ['legacy','external'] as const)for(const restriction of ['test','trading_off','drain']){
      const s=status({executionMode,cardState:'needs_you',host:{legacy_controls_enabled:true,observer_fenced:false},executionRestrictions:[restriction]});
      expect(words(render(presentation({status:s})))).toContain(restrictionText(s)[0]);
      expect(render(presentation({status:{...s,cardState:'paused',entriesPaused:true}}))).not.toContain('Stops and closes still run');
    }
  });
  it('unknown stored warnings never expose raw codes or acquire acknowledgement capability',()=>{
    const s=status({incidents:[incident({code:'constructor',severity:'warning',canAcknowledge:false})],entriesPaused:true,unacknowledgedCritical:1});
    expect(resumeReason(s,false)).not.toBe('');expect(render(presentation({status:s}))).not.toContain('>Acknowledge</button>');
    expect(render(presentation({status:s}))).toContain('Review needed');
  });
  it('keeps global totals and truncated-list warning independent of visible rows',()=>{
    const html=render(presentation({status:status({incidents:[incident({acknowledged:true,canAcknowledge:false})],unacknowledgedCritical:110,acknowledgedCritical:1,truncated:true})}));
    expect(html).toContain('110 alerts need you');expect(html).toContain('More alerts exist beyond this list');
  });
  it('groups notices by code, keeps critical occurrences distinct and ages seen notices out',()=>{
    const s=status({incidents:[incident(),incident({id:fixtureId(5)}),incident({code:'quota_pressure',severity:'warning',seen:true,last_seen_seconds:86401})]});
    expect(inboxGroups(s)).toHaveLength(2);
    expect(render(presentation({status:status()}))).toContain('No alerts to show.');
  });
  it('wraps friendly multiple names and substitutes a safe name for missing or unsafe names',()=>{
    const s=status({incidents:[incident()],unacknowledgedCritical:1});
    const html=renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:presentation({status:s}),names:new Map([[fixtureId(2),'$100']]),canSign:true}));
    expect(html).toContain('A grid bot');expect(html).not.toContain(fixtureId(2));
    expect(render(renderCases().find(([name])=>name==='multiple-names')![1])).toContain('Evening grid');
  });
  it('unknown states never claim running and known unconfirmed pauses offer only refresh',()=>{
    expect(render(presentation({status:status({cardState:'EXAMPLE_UNKNOWN'})}))).not.toContain('Running normally');
    const html=render(presentation({status:status({cardState:'pause_unconfirmed',entriesPaused:true})}));
    expect(html).toContain('Check again');expect(html).not.toContain('Resume new activity');
  });
  it('never proves a pause with an old revision after Resume',()=>{
    expect(currentPause(status({entriesPaused:false,pauseRevision:'5'}),'4')).toBe(false);
    expect(currentPause(status({entriesPaused:true,pauseRevision:'3'}),'4')).toBe(false);
    expect(decimalCompare('9007199254740993','9007199254740992')).toBe(1);
    const html=render(presentation({status:status({entriesPaused:false,pauseRevision:'5'}),outcome:{saved:true,pauseRevision:'4',acknowledgementOutcome:'confirmed'}}));
    expect(html).not.toContain('<dd>Yes</dd>');
  });
});

it('unconfirmed acknowledgement never invents elapsed timeout copy',()=>{
  const html=render(presentation({status:status({entriesPaused:true,cardState:'pause_unconfirmed'}),outcome:{saved:true,pauseRevision:'3',acknowledgementOutcome:'not_confirmed'}}));
  expect(html).toContain('Not confirmed yet');expect(html).not.toContain('Not after 20 s');
});
it('drawer uses the exclusive server state for offline versus pause-not-confirmed',()=>{
  for(const [cardState,line] of [['offline','The grid worker is offline; stops won'],['pause_unconfirmed','Pause saved, but the worker hasn']] as const){
    const html=renderToStaticMarkup(React.createElement(GridWorkerDrawerView,{state:presentation({status:status({cardState,entriesPaused:true,pauseAckRevision:null})}),botId:fixtureId(2)}));
    expect(html).toContain(line);expect((html.match(/<p\b/g)??[]).length).toBe(1);
  }
});
