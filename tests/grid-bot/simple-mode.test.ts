import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gridSimplePreset, gridSimpleCompatible, gridSimpleLeverages, gridSimpleSideStop, gridReadMode, gridRememberMode, gridSetupScreen, gridSimpleIssue } from '../../client/src/lib/grid-simple-view';
import { gridSetupForm, gridSetupIntent } from '../../client/src/lib/grid-setup-view';
import { GridSetupModeSelect, GridSimpleWhy } from '../../client/src/components/grid-planner/GridSetupModeSelect';
import { gridHistoryWindow } from '../../shared/grid-lookback';
import { GRID_BACKTEST_RUNS, GRID_BACKTEST_LABEL } from '../../shared/grid-research-facts';
import { intent } from './draft-fixtures';
const storage = () => { const values = new Map<string,string>(); return { values, getItem: (key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>{values.set(key,value);} }; };
const preset = () => gridSimplePreset(gridSetupForm(undefined,'BTC-PERP'));
const saved = () => gridSetupIntent({...preset(),market:'BTC-PERP',lower:'90',upper:'110',stop:'80',investment:'1000'},'80','auto',true);
describe('Simple preset and navigation',()=>{
  it('maps the exact preset while retaining market, direction and amount',()=>{
    const form=gridSimplePreset({...gridSetupForm(intent,'BTC-PERP'),leverage:'10',side:'short'});
    expect(form).toMatchObject({market:intent.market,side:'short',investment:'100',leverage:'1',intervals:'10',behaviourMode:'step_back',entryScale:'ascending',profitScale:'descending',seed:true,timeframe:'1h',rangeWindow:'week',bars:'100',lower:'',upper:'',stop:''});
    expect(gridHistoryWindow(form.timeframe,form.rangeWindow)?.rangeBars).toBe(168);
    expect(saved()).toMatchObject({rangeSource:'manual',lookback:100,lowerPrice:'90',upperPrice:'110',stopPrice:'80'});
    expect(gridSimpleCompatible(saved(),true)).toBe(true);
    expect(gridSimpleCompatible({...saved(),gridCount:11},true)).toBe(false);
    expect(gridSimpleCompatible(saved(),false)).toBe(false);
    expect(gridSimpleLeverages('2')).toEqual(['1','2']); expect(gridSimpleLeverages(null)).toEqual([]);
    expect(gridSimpleLeverages('100')).toEqual(['1','2','3']);
  });
  it('mirrors the retained shipped stop buffer on a direction change',()=>{
    const form={...preset(),lower:'90',upper:'110',stop:'83'};
    expect(gridSimpleSideStop(form,'short')).toBe('117');
    expect(gridSimpleSideStop({...form,side:'short',stop:'117'},'long')).toBe('83');
    expect(gridSimpleSideStop({...form,stop:''},'short')).toBe('');
  });
  it('scopes preferences and successful bot markers by identity and version',()=>{
    const s=storage(); expect(gridSetupScreen('EXAMPLE',undefined,undefined,s)).toBe('chooser');
    gridRememberMode('EXAMPLE','simple',undefined,s);
    expect(gridSetupScreen('EXAMPLE',undefined,undefined,s)).toBe('simple');
    expect(gridSetupScreen('REDACTED',undefined,undefined,s)).toBe('chooser');
    expect(gridSetupScreen('EXAMPLE',saved(),'EXAMPLE',s)).toBe('advanced');
    gridRememberMode('EXAMPLE','simple','EXAMPLE',s);
    expect(gridSetupScreen('EXAMPLE',saved(),'EXAMPLE',s)).toBe('simple');
    expect(gridSetupScreen('EXAMPLE',{...saved(),leverage:'4'},'EXAMPLE',s)).toBe('advanced');
    for(const value of ['bad','{"mode":"simple","presetVersion":2}','{"mode":"unknown","presetVersion":1}']) {
      s.values.set('grid-setup:mode:v1:EXAMPLE',value); expect(gridReadMode('EXAMPLE',undefined,s)).toBeNull();
    }
  });
  it('catches storage failures and routes old drafts to Advanced',()=>{
    const broken={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
    expect(()=>gridRememberMode('EXAMPLE','simple',undefined,broken)).not.toThrow();
    expect(gridReadMode('EXAMPLE',undefined,broken)).toBe('simple');
    expect(gridSetupScreen('EXAMPLE',intent,undefined,broken)).toBe('advanced');
  });
  it('cards route immediately with no chooser Continue step',()=>{
    const onSelect=vi.fn(),tree=GridSetupModeSelect({onSelect});
    const cards=tree.props.children[0].props.children;
    cards[0].props.onClick();cards[1].props.onClick();expect(onSelect.mock.calls).toEqual([['simple'],['advanced']]);
    const html=renderToStaticMarkup(createElement(GridSetupModeSelect,{onSelect}));
    expect(html).toContain('@min-[440px]:grid-cols-2');expect(html).toContain('auto-rows-fr');expect(html).not.toContain('Continue');
    expect(html).toContain('We set it up for you');expect(html).toContain('Every setting, your way');expect(html).toContain(GRID_BACKTEST_LABEL);
    const why=renderToStaticMarkup(createElement(GridSimpleWhy));expect(why).not.toContain(' open=');expect(why.match(/<li>/g)).toHaveLength(11);
    expect(why).toContain('Avoids launching in an unusually quiet market');
    expect(GRID_BACKTEST_RUNS).toBe(10_594_212);expect(GRID_BACKTEST_LABEL).toBe('over 10.5 million');
  });
});
describe('one plain Simple fix',()=>{
  const base={investment:'90',leverage:'2'};
  it('prioritises launch, then liquidation, then market suitability, then amount',()=>{
    expect(gridSimpleIssue({...base,launchUnavailable:true,reasons:['liquidation']})).toEqual({message:'Grid launch is unavailable right now.',action:'none'});
    expect(gridSimpleIssue({...base,reasons:['Stop does not have validated liquidation clearance'],minimum:'100'}).action).toBe('leverage');
    expect(gridSimpleIssue({...base,leverage:'1',reasons:['liquidation']})).toMatchObject({action:'market'});
    expect(gridSimpleIssue({...base,reasons:['fee spread insufficient']})).toMatchObject({action:'market'});
    expect(gridSimpleIssue({...base,minimum:'100.001'})).toEqual({message:'Add $10.01 to use this setup.',action:'amount'});
  });
  it('never echoes diagnostics or invents a minimum',()=>{
    expect(gridSimpleIssue({...base,reasons:['EXAMPLE internal database failure']})).toEqual({message:"We couldn't check this setup. Refresh to try again.",action:'refresh'});
    expect(gridSimpleIssue({...base,reasons:['minimum unavailable']})).toEqual({message:"We couldn't check the amount. Refresh to try again.",action:'refresh'});
    expect(gridSimpleIssue(base)).toBeNull();
  });
});
