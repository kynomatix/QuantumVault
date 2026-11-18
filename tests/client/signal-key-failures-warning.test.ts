import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,expect,it } from 'vitest';
import { existsSync,readFileSync } from 'node:fs';
import ts from 'typescript';
// Evaluate the actual inline warning on pre-SB01 sources for the base control.
const componentPath='../../client/src/components/SignalBotPauseWarning';
const SignalBotPauseWarning=existsSync('client/src/components/SignalBotPauseWarning.tsx')
 ? (await import(componentPath)).SignalBotPauseWarning : legacyWarning();
function legacyWarning(){
 const source=readFileSync('client/src/components/BotManagementDrawer.tsx','utf8');
 const start=source.indexOf('{displayBot?.pauseReason && !displayBot?.isActive && (');
 const end=source.indexOf('<div className="flex items-center justify-between mb-2">',start);
 if(start<0||end<0) throw new Error('base drawer warning boundary changed');
 const jsx=source.slice(start,end).trim();
 const code=ts.transpileModule(`module.exports=({pauseReason,isActive})=>{const displayBot={pauseReason,isActive};return <>${jsx}</>}`,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText;
 const mod={exports:undefined as any};const Icon=()=>null;
 new Function('module','React','AlertCircle','Button','Wallet','Settings','onShowWalletTab','setActiveTab',code)(mod,{createElement,Fragment:Symbol.for('react.fragment')},Icon,'button',Icon,Icon,()=>{},()=>{});
 return mod.exports;
}
// Fixture input, including when the production reason helper does not exist.
const signalKeyFailurePauseReason=(kind:string)=>`Paused after 3 signals in a row failed: the bot's trading key could not be used (${kind}). Re-enable automated trading or reconnect the agent wallet, then resume.`;
const props={isActive:false,onAddFunds:()=>{},onSettings:()=>{}};
describe('SB01 drawer key warning',()=>{
 it('r2.non.key.auto.topup.reason.keeps.funds.buttons',()=>{const html=renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,pauseReason:'Auto top-up failed: EXAMPLE'}));expect(html).toContain('Add Funds');expect(html).toContain('Enable Auto Top-Up');});
 it('actual.key.pause.reason.without.add.funds',()=>{const reason=signalKeyFailurePauseReason('agent_decrypt');const html=renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,pauseReason:reason}));expect(html).toContain('agent_decrypt');expect(html).toContain('reconnect the agent wallet');expect(html).not.toContain('Add Funds');});
 it.each(['Bot underfunded: EXAMPLE','Insufficient margin: EXAMPLE','Order notional EXAMPLE'])('margin.reason.keeps.add.funds.%s',pauseReason=>{expect(renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,pauseReason}))).toContain('Add Funds');});
 it.each(['not_flat','unavailable'] as const)('active.warning.%s',outcome=>{const html=renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,isActive:true,streak:{count:3,kind:'subaccount_key',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:'EXAMPLE',outcome}}));expect(html).toContain(outcome==='not_flat'?'it holds a position':'its position could not be checked');expect(html).not.toContain('Add Funds');});
 it('no.warning.below.threshold',()=>{expect(renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,isActive:true,streak:{count:2,kind:'subaccount_key',firstAt:'EXAMPLE',lastAt:'EXAMPLE',alertedAt:null}}))).toBe('');});
});

it.each([null,undefined])('r3.incomplete.current.outcome.%s.hides.stale.warning',outcome=>{
 expect(renderToStaticMarkup(createElement(SignalBotPauseWarning,{...props,isActive:true,streak:{count:3,kind:'subaccount_key',firstAt:'EXAMPLE_NEW',lastAt:'EXAMPLE_NEW',alertedAt:null,outcome,pauseOutcome:'not_flat'} as any}))).toBe('');
});
