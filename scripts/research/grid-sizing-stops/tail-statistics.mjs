// Fractional mass at the tail boundary avoids rounding a one-row tail up to 100%.
export function weightedTailMean(sortedReturns,weights,fraction){
 if(!(fraction>0&&fraction<=1)||sortedReturns.length!==weights.length)throw Error('Invalid tail inputs');
 let total=0;for(const n of weights){if(!Number.isFinite(n)||n<0)throw Error('Invalid tail mass');total+=n;}
 const target=total*fraction;let used=0,sum=0;
 for(let i=0;i<sortedReturns.length&&used<target;i++){
  if(!Number.isFinite(sortedReturns[i])||(i&&sortedReturns[i]<sortedReturns[i-1]))throw Error('Sorted finite outcomes required');
  const take=Math.min(target-used,weights[i]);sum+=take*sortedReturns[i];used+=take;
 }
 return used?sum/used:NaN;
}
export function weightedLowerTails(sortedReturns,weights){
 let n=0;for(const w of weights)n+=w;
 let used=0,sum=0,one=null;const t1=n*.01,t5=n*.05;
 for(let i=0;i<sortedReturns.length&&used<t5;i++){
  const w=weights[i],take=Math.min(w,t5-used);
  if(one===null&&used+w>=t1)one=t1?(sum+Math.max(0,t1-used)*sortedReturns[i])/t1:NaN;
  sum+=take*sortedReturns[i];used+=take;
 }
 return [one??NaN,used?sum/used:NaN];
}
