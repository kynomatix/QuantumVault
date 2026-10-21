import {scores,rank,quarterDates,DAY} from './core.mjs';
export const ARMS=['flat_flat','further_near','further_further'];
export const MAJORS=['BTC','ETH','SOL','HYPE','ZEC'];
export function fullEfficiency(rows){let movement=0;for(let i=1;i<rows.length;i++)movement+=Math.abs(rows[i].close-rows[i-1].close);return movement?Math.abs(rows.at(-1).close-rows[0].close)/movement:0;}
export function selections(markets){
 const out=[];
 for(const universe of ['A','A+B']){
  const population=markets.filter(x=>universe==='A+B'||x.universe==='A');
  const hindsight=rank(population.map(m=>({symbol:m.symbol,score:{efficiency:fullEfficiency(m.daily.filter(x=>x.time>=m.begin))}}))).ranging;
  for(const at of quarterDates()){
   const entries=population.map(m=>({symbol:m.symbol,score:scores(m.daily,at,12),sixMonth:scores(m.daily,at,6)})).filter(x=>x.score);
   const groups=rank(entries);groups.hindsight=hindsight.filter(s=>groups.all.includes(s));groups.majors=MAJORS.filter(s=>groups.all.includes(s));
   out.push({universe,at,entries,groups,missingMajors:MAJORS.filter(s=>!groups.all.includes(s))});
  }
 }
 return out;
}
export function worstPath(rows){if(rows.length!==2||rows.some(x=>!x.admitted)||new Set(rows.map(x=>x.path)).size!==2)throw Error('Two admitted paths required');return rows.reduce((a,b)=>a.netReturn<=b.netReturn?a:b);}
export function marketSpec(c){
 if(c.universe==='A'){const m=c.pacifica;return {market:{symbol:c.symbol,tick:m.tick_size,lot:m.lot_size,minimumQuote:String(Math.max(10,Number(m.min_order_size))),maximumQuote:m.max_order_size,minimumPrice:Number(m.min_tick)>0?m.min_tick:m.tick_size,maximumPrice:m.max_tick},maxLeverage:Number(m.max_leverage)};}
 const i=c.okx;if(Number(i.minSz)!==Number(i.lotSz)||i.ctValCcy!==c.symbol)throw Error('Unsupported OKX contract minimum/lot');return {market:{symbol:c.symbol,tick:i.tickSz,lot:String(Number(i.ctVal)*Number(i.lotSz)),minimumQuote:'10',maximumQuote:'1000000000',minimumPrice:i.tickSz,maximumPrice:'1000000000'},maxLeverage:Number(i.lever)};
}