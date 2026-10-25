import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {GridWorkerStatusView} from '../../client/src/components/grid-bot/GridWorkerStatusView';
import {GridWorkerControlsView} from '../../client/src/components/grid-bot/GridWorkerControlsView';
import {auditGridWorkerCopy,auditGridWorkerMarkup} from '../../script/grid-worker-copy-audit';
import {controlCopy} from '../../client/src/lib/grid-worker-controls-copy';
import {relativeAgo} from '../../client/src/lib/grid-worker-copy';
import {controlsCases,controlsState,confirming,challenge} from '../helpers/grid-worker-u7b-fixtures';
import {fixtureNames,incident} from '../helpers/grid-worker-u5b-fixtures';
import {rescue} from '../helpers/grid-worker-u6b-fixtures';
const render=(state=controlsState(),canSign=true)=>renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state,canSign,names:fixtureNames,expanded:true}));
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&#x27;/g,"'");
describe('U7b actual card markup',()=>{
  it.each(controlsCases())('renders and audits %s',async(name,p)=>{
    const html=render(p);await auditGridWorkerMarkup(html,p.control?.message?{message:p.control.message}:undefined,p.control?.request??undefined);
    expect(html).not.toMatch(/just now ago|not yet ago|position:\s*(?:fixed|sticky)|role="dialog"/);
    if(['non-owner','wallet-changed','dormant','legacy-off'].includes(name))expect(html).toBe('');
    if(name.includes('-blocker-'))expect(html).toMatch(/disabled=""[^>]*>(?:Hand over to the worker in test mode|Turn on trading|Renew limits)/);
    if(p.control?.phase==='unknown'){expect(text(html)).toContain(controlCopy.unknown);expect(html).not.toContain('Resume new activity</button>');expect(html).not.toContain('Sign handover</button>');expect(html).toContain('Pause again');}
  });
  it.each(['handover','trading','renewal'] as const)('requires a checkbox and exact transcript for %s',async kind=>{
    const p=confirming(kind),html=render(p);expect(html).toContain('type="checkbox"');expect(html).toMatch(/disabled=""[^>]*>Sign/);expect(html).toContain('tabindex="-1"');
    await auditGridWorkerMarkup(html,{message:p.control!.message},p.control!.request!);
    await expect(auditGridWorkerMarkup(html,{message:p.control!.message+' '},p.control!.request!)).rejects.toThrow();
    await expect(auditGridWorkerMarkup(html+'<p>EXAMPLE_RAW_BACKEND</p>',{message:p.control!.message},p.control!.request!)).rejects.toThrow();
    await expect(auditGridWorkerMarkup(html)).rejects.toThrow();
  });
  it('keeps all restrictions and exact copy, including fallback and large change numbers',()=>{
    const h=text(render(confirming('handover'))),t=text(render(confirming('trading')));
    expect(h).toContain('This hands grid bots to the worker, in test mode first.');expect(h).toContain('9007199254740995');expect(h).toContain('9007199254740996');
    for(const copy of [controlCopy.fallback,controlCopy.waiting,'Grid bots you start can place real orders on Pacifica with real money. Trading fees apply.','In trading mode, the worker can attempt stops and closes while it is online and request limits are available.','If the worker goes down, it cannot run automatic stops. An eligible rescue close needs your signature and available request limits.'])expect(t).toContain(copy);
    expect(t).not.toContain('fencing');expect(h).toContain('including those listed above');
  });
  it('disables Resume during live or unknown rescue even without a reset blocker',()=>{
    for(const flags of [{live:true,unknownOpen:false},{live:false,unknownOpen:true}]){const p=controlsState('trading');p.status!.rescue=rescue(flags);p.status!.resetBlockedBy=[];const html=render(p);expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>Resume new activity/);}
  });
  it('uses DB seconds, including elapsed time, for expiry stages and omits unsupported owner scope',()=>{
    expect(render(controlsState('renewal',15*86400))).not.toContain('Request limits end on');
    const p=controlsState('renewal',1);p.elapsedSeconds=2;expect(text(render(p))).toContain('Some request limits have ended. Renew them. Stop or rescue requests may be refused.');
    const rpc=controlsState('renewal',-1);rpc.status!.quotaPolicy!.providers[0].secondsLeft=86400;
    expect(text(render(rpc))).not.toMatch(/owner account|main account/i);
    expect(render(controlsState(),false)).toMatch(/disabled=""[^>]*>Hand over/);
  });
  it('has one normal-flow confirmation and responsive wrapping without overlays',()=>{
    const p=confirming('renewal'),html=render(p);expect((html.match(/aria-label="Before you sign"/g)||[])).toHaveLength(1);
    const css=readFileSync('client/src/components/grid-bot/grid-worker.css','utf8');expect(css).toContain('overflow-wrap: anywhere');expect(css).toContain('@container (max-width: 520px)');
    const source=readFileSync('client/src/components/grid-bot/GridWorkerControlsView.tsx','utf8');expect(source).toContain('panel.current?.focus()');expect(source).toContain('trigger.current?.focus()');expect(source).not.toMatch(/createPortal|Dialog|position:\s*(?:fixed|sticky)/);
  });
  it('audits surrounding source prose and proves banned prose fires',()=>{
    for(const file of ['client/src/lib/grid-worker-controls-copy.ts','client/src/lib/grid-worker-controls-driver.ts','client/src/components/grid-bot/GridWorkerControlsView.tsx'])auditGridWorkerCopy(readFileSync(file,'utf8'),file);
    for(const copy of ['just now ago','not yet ago','EXAMPLE_BACKEND','Use the runbook'])expect(()=>auditGridWorkerCopy('const x=<p>'+copy+'</p>','EXAMPLE.tsx')).toThrow();
  });
  it.each([null,0,1,59,60,3600])('keeps all four relative-age sites grammatical at %s',age=>{
    const p=controlsState('trading');p.status!.ages.workerCheckInSeconds=age;p.status!.ages.monitorPollSeconds=age;
    p.status!.incidents=[incident({first_seen_seconds:age,last_seen_seconds:age})];expect(render(p)).not.toMatch(/(?:just now|not yet) ago/);expect(relativeAgo(age)).not.toMatch(/(?:just now|not yet) ago/);
    for(const file of ['client/src/components/grid-bot/GridWorkerStatusView.tsx','client/src/components/grid-bot/GridWorkerInbox.tsx'])expect(readFileSync(file,'utf8')).toContain('relativeAgo(');
  });
});
