import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {AiTraderExcursion} from '../../client/src/components/AiTraderExcursion';
import type {AiDecisionRow} from '../../client/src/components/AiTraderDecisionCard';

const start=Date.parse('2026-01-01T00:00:00Z'),tf=900_000;
const observation=()=>({
  version:1,status:'observed',bootId:'test-boot',coverage:'partial',basis:'paper_closed_candles',
  decisionStartedAtMs:start,fromMs:start+tf,throughMs:start+2*tf,
  sampleCount:2,timeframeMs:tf,expectedInteriorBars:2,missingInteriorBars:0,
  high:{price:108,atMs:start+tf},low:{price:96,atMs:start+2*tf},
  source:{provider:'okx',venue:'okx',basis:'perp',proxy:'direct',timeSemantic:'open_time'},
});
function decision(): AiDecisionRow {
  return {
    id:'test-decision',outcome:'executed',decidedAt:new Date(start).toISOString(),
    closedAt:new Date(start+3*tf).toISOString(),entryPrice:'100',contextDigest:{price:100},
    clampedDecision:{action:'long',stopLossPrice:95,takeProfitPrice:110},
    priceExcursion:observation(),
  } as unknown as AiDecisionRow;
}
const render=(d:AiDecisionRow)=>renderToStaticMarkup(createElement(AiTraderExcursion,{decision:d}));
describe('human-only retained price-path observations',()=>{
  it('renders partial observed extrema, source, timestamps and explicit interval limits',()=>{
    const html=render(decision());
    for(const marker of ['Observed price path — partial coverage','8.00%','4.00%','80.00%','0.80R',
      '2 observations','0 missing/unusable of 2','2026-01-01T00:15:00.000Z','2026-01-01T00:30:00.000Z',
      'okx / okx / perp / direct','test-boot','0.75 hours','not exact fill-to-fill','Entry, exit and forming candles excluded',
      'not lifetime maxima or net P','Restart or eviction can lose'])expect(html).toContain(marker);
  });
  it('uses original stop risk after a ratchet, not the moved break-even stop',()=>{
    const d=decision();d.clampedDecision={action:'long',stopLossPrice:100,takeProfitPrice:110,breakevenProtect:{originalStopLossPrice:95}};
    expect(render(d)).toContain('0.80R');
  });
  it('handles short-side favorable/adverse observations independently',()=>{
    const d=decision();d.clampedDecision={action:'short',stopLossPrice:105,takeProfitPrice:90};
    const html=render(d);expect(html).toContain('Observed favorable excursion: 4.00%');
    expect(html).toContain('adverse: 8.00%');expect(html).toContain('40.00%');expect(html).toContain('1.60R');
  });
  it('describes live marks as sparse polls, not complete candle or venue-time coverage',()=>{
    const d=decision();d.priceExcursion={...observation(),basis:'live_sampled_marks',timeframeMs:null,
      expectedInteriorBars:null,missingInteriorBars:null,
      source:{provider:'pacifica',venue:'pacifica',basis:'mark',proxy:'direct',timeSemantic:'monitor_read_time'}};
    const html=render(d);expect(html).toContain('Sampled venue marks');expect(html).toContain('monitor reads, not venue quote timestamps');
    expect(html).toContain('Unobserved intervals between polls');expect(html).not.toContain('missing/unusable of');
  });
  it.each([undefined,null,{},false,'',JSON.stringify(observation()),
    {...observation(),coverage:'complete'},{...observation(),version:2},
    {...observation(),throughMs:start+4*tf},{...observation(),decisionStartedAtMs:start+1}])
  ('withholds missing, malformed or inconsistent observations without inventing zeros: %j',record=>{
    const d=decision();d.priceExcursion=record;const html=render(d);
    expect(html).toContain('Price-path observations unavailable');expect(html).not.toContain('0.00%');
    expect(html).not.toContain('data-testid="excursion-observed"');
  });
  it('distinguishes an observed adverse-only interval from absent observations',()=>{
    const d=decision();d.priceExcursion={...observation(),high:{price:99,atMs:start+tf}};
    const html=render(d);expect(html).toContain('Observed favorable excursion: 0.00%');
    expect(html).toContain('does not prove none occurred');expect(html).not.toContain('Price-path observations unavailable');
  });
  it('does not show close-only diagnostics on open or unexecuted proposals',()=>{
    const open=decision();open.closedAt=null;expect(render(open)).toBe('');
    const proposal=decision();proposal.outcome='user_skipped';expect(render(proposal)).toBe('');
  });
  it('withholds ratio metrics when entry or original bracket cannot be established, but retains observations',()=>{
    const d=decision();d.entryPrice=null;expect(render(d)).toContain('Observed favorable excursion: unavailable');
    expect(render(d)).toContain('High 108');
    d.entryPrice='100';d.clampedDecision={action:'long',takeProfitPrice:110,breakevenProtect:{}};
    expect(render(d)).toContain('adverse / original risk: unavailable');
  });
  it('discloses an unavailable record reason without printing arbitrary stored text',()=>{
    const d=decision();d.priceExcursion={version:1,status:'unavailable',bootId:'fixture',reason:'no_retained_observation'};
    expect(render(d)).toContain('lost on restart/eviction');
    d.priceExcursion={version:1,status:'unavailable',bootId:'fixture',reason:'<script>bad</script>'};
    expect(render(d)).toContain('Legacy or unverified');expect(render(d)).not.toContain('bad');
  });
  it('wires the bounded component only to human decision history',()=>{
    const source=readFileSync(resolve(process.cwd(),'client/src/components/AiTraderDrawer.tsx'),'utf8');
    expect(source).toContain("import { AiTraderExcursion } from './AiTraderExcursion'");
    expect(source).toContain('<AiTraderExcursion decision={d} />');
    for(const path of ['server/ai-trader/context-builder.ts','server/ai-trader/reflection-service.ts','server/ai-trader/graduation.ts']){
      const text=readFileSync(resolve(process.cwd(),path),'utf8');
      expect(text).not.toContain('priceExcursion');expect(text).not.toContain('price_excursion');
    }
  });
});
