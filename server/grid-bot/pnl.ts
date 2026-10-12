/** Exact rational arithmetic: rounding occurs only at the API boundary. */
const gcd=(a:bigint,b:bigint):bigint=>b===0n?(a<0n?-a:a):gcd(b,a%b);
export class GridNumber {
  readonly n:bigint; readonly d:bigint;
  constructor(n:bigint,d=1n){if(d===0n)throw Error('Zero denominator');const g=gcd(n,d);this.n=n/g*(d<0n?-1n:1n);this.d=(d<0n?-d:d)/g;}
  static read(s:string){if(typeof s!=='string'||s.length>100||! /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)||s.trim()!==s)throw Error('Invalid exact decimal');const [a,b='']=s.split('.');return new GridNumber(BigInt(a+b),10n**BigInt(b.length));}
  plus(b:GridNumber){return new GridNumber(this.n*b.d+b.n*this.d,this.d*b.d);}
  minus(b:GridNumber){return this.plus(new GridNumber(-b.n,b.d));}
  mul(b:GridNumber){return new GridNumber(this.n*b.n,this.d*b.d);}
  div(b:GridNumber){return new GridNumber(this.n*b.d,this.d*b.n);}
  cmp(b:GridNumber){const n=this.n*b.d-b.n*this.d;return n<0n?-1:n>0n?1:0;}
  dto(){const negative=this.n<0n,n=(negative?-this.n:this.n)*10n**18n;let q=n/this.d;const r=n%this.d;if(r*2n>this.d||(r*2n===this.d&&q%2n===1n))q++;const s=q.toString().padStart(19,'0');const out=(s.slice(0,-18)+'.'+s.slice(-18)).replace(/\.?0+$/,'');return (negative&&q!==0n?'-':'')+out;}
}
export interface GridEconomicFill {
  tradeId:string; operationId:string; orderId:string; levelId:string|null; time:number;
  leg:'entry'|'exit'; size:string; price:string; fee:string;
}
const zero=()=>new GridNumber(0n);
export function orderedGridFills(fills:GridEconomicFill[]):GridEconomicFill[]{
  const byId=new Map<string,GridEconomicFill>();
  for(const f of fills){if(!f.tradeId||!f.operationId||!f.orderId||!Number.isSafeInteger(f.time)||f.time<0||!['entry','exit'].includes(f.leg))throw Error('Invalid fill identity');
    for(const k of ['size','price','fee'] as const){const x=GridNumber.read(f[k]);if(k!=='fee'&&x.cmp(zero())<=0)throw Error('Invalid fill economics');}
    const previous=byId.get(f.tradeId);
    if(previous&&(['operationId','orderId','levelId','time','leg','size','price','fee'] as const).some(k=>previous[k]!==f[k]))throw Error('Conflicting trade identity');
    byId.set(f.tradeId,f);
  }
  return [...byId.values()].sort((a,b)=>a.time-b.time||(a.tradeId<b.tradeId?-1:a.tradeId>b.tradeId?1:0));
}
export function exactGridPosition(fills:GridEconomicFill[]){return orderedGridFills(fills).reduce((q,f)=>f.leg==='entry'?q.plus(GridNumber.read(f.size)):q.minus(GridNumber.read(f.size)),zero());}
export function gridPnl(direction:'long'|'short',fills:GridEconomicFill[],mark:{price:string;observedAt:number}|null){
  if(!['long','short'].includes(direction))throw Error('Invalid direction');
  let quantity=zero(),basis=zero(),realised=zero(),fees=zero(),cycles=0;
  const ordered=orderedGridFills(fills);
  for(const f of ordered){const q=GridNumber.read(f.size),p=GridNumber.read(f.price),fee=GridNumber.read(f.fee),value=q.mul(p);fees=fees.plus(fee);
    if(f.leg==='entry'){quantity=quantity.plus(q);basis=basis.plus(direction==='long'?value.plus(fee):value.minus(fee));}
    else {if(q.cmp(quantity)>0)throw Error('Grid ledger overclose');const cost=basis.mul(q).div(quantity);
      realised=realised.plus(direction==='long'?value.minus(fee).minus(cost):cost.minus(value).minus(fee));
      quantity=quantity.minus(q);basis=basis.minus(cost);if(quantity.n===0n){basis=zero();cycles++;}}
  }
  let unrealised:GridNumber|null=null;
  if(mark){if(!Number.isSafeInteger(mark.observedAt)||mark.observedAt<0||GridNumber.read(mark.price).cmp(zero())<=0)throw Error('Invalid mark');
    const value=quantity.mul(GridNumber.read(mark.price));unrealised=direction==='long'?value.minus(basis):basis.minus(value);}
  return {quantity:quantity.dto(),costBasis:basis.dto(),realised:realised.dto(),fees:fees.dto(),
    averageEntry:quantity.n===0n?null:basis.div(quantity).dto(),breakeven:quantity.n===0n?null:basis.div(quantity).dto(),
    unrealised:unrealised?.dto()??null,total:unrealised?realised.plus(unrealised).dto():null,cycles,
    markObservedAt:mark?.observedAt??null,lastFillAt:ordered.at(-1)?.time??null,mathVersion:'grid-rational-v1',
    includesFunding:false,includesFutureCloseFee:false,label:'PnL excludes funding'};
}
