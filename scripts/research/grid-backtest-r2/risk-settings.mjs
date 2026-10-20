import {read} from './data.mjs';
import path from 'node:path';
export function riskSettings(root){
 const families=new Map(),add=s=>families.set(JSON.stringify(s),s);
 const base={window:'week',multiplier:1,mode:'step_back',stopMode:'touch',moveMode:'fixed',intervals:10,makerRate:0.00115,takerRate:0.0014};
 for(const window of ['week','month'])for(const multiplier of [1,1.5,2])add({...base,window,multiplier});
 const b=read(path.join(root,'phase-b-selection.json')).selected.split('-');
 add({...base,window:b[0],multiplier:Number(b[1]),mode:b[2],stopMode:b.slice(3).join('-')});
 const m=read(path.join(root,'phase-c-movement-selection.json')).selected.split('-');
 add({...base,window:m[0],moveMode:m[1]});
 const selections=read(path.join(root,'phase-c-lines-selection.json'));
 for(const family of ['lines','fees']){
  const s=read(path.join(root,'phase-c-lines-method.json')).settings.find(s=>s.id===selections[family].selected);
  add({...base,window:s.window,intervals:s.intervals,makerRate:s.makerRate,takerRate:s.takerRate});
 }
 return [...families.values()].flatMap((s,index)=>[1,3,5,10].map(leverage=>({...s,family:`family${index}`,leverage,id:`family${index}-L${leverage}`})));
}
