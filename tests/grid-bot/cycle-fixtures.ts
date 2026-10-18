import type { GridPolicy } from '../../server/grid-bot/policy-hmac';
import { retainedGridCycles } from '../../server/grid-bot/cycle-policy';
import type { CycleOperation, CycleFill, CycleProgress, CycleReplayInput } from '../../server/grid-bot/cycle-replay';

export function cyclePolicy(direction: 'long'|'short' = 'long', seedAtCreation = true): GridPolicy {
  return { id: '00000000-0000-4000-8000-000000000001', protocol: 'pacifica', market: 'BTC-PERP', direction,
    lowerPrice: '80.00000000', upperPrice: '120.00000000', startPrice: '95.00000000', gridCount: 4,
    totalInvestment: '600.00', leverage: 1, entryScaleType: 'flat', profitScaleType: 'flat',
    policyVersion: '2.0.0', runtimePolicyVersion: '2.0.0', feePolicyVersion: '1.0.0',
    stopLossPercent: '20.0000', stopLossPrice: direction === 'long' ? '76.00000000' : '114.00000000', seedAtCreation,
    levels: [80,90,100,110,120].map<GridPolicy['levels'][number]>((price, i) => {
      const closing = direction === 'long' ? price > 95 : price < 95;
      return { ordinal:i+1, price:price.toFixed(8), size:'1.00000000', reduceOnly:closing,
        side:direction === 'long' ? closing ? 'sell' : 'buy' : closing ? 'buy' : 'sell' };
    }) };
}
export function history(policy = cyclePolicy()): CycleReplayInput {
  return {policy,account:'EXAMPLE_ACCOUNT',historyComplete:true,operations:[],fills:[],progress:[],allocations:[]};
}
export function operation(p: GridPolicy, id: string, cycleOrdinal: number|null, leg: 'opening'|'closing',
  size: string, preparedAt: number, kind: CycleOperation['kind'] = 'limit'): CycleOperation {
  const c = retainedGridCycles(p)!.find(c=>c.ownerOrdinal===cycleOrdinal);
  return {id,botId:p.id,account:'EXAMPLE_ACCOUNT',kind,cycleOrdinal,leg,size,preparedAt,reduceOnly:leg==='closing',
    side:p.direction==='long' ? leg==='opening'?'buy':'sell' : leg==='opening'?'sell':'buy',
    price:c ? leg==='opening'?c.openingPrice:c.closingPrice : null};
}
export function fill(op: CycleOperation, tradeId: string, size: string, time: number): CycleFill {
  return {operationId:op.id,tradeId,account:op.account,size,time,price:op.price??'95',leg:op.reduceOnly?'exit':'entry'};
}
export function terminal(op: CycleOperation, filledSize: string, at: number): CycleProgress {
  return {operationId:op.id,state:'terminal',filledSize,observedAt:at,terminalAt:at,historyThrough:at};
}
export function seeded(direction: 'long'|'short' = 'long') {
  const h=history(cyclePolicy(direction)),size=direction==='long'?'3':'2';
  const seed=operation(h.policy,'EXAMPLE_SEED',null,'opening',size,1,'seed');
  h.operations.push(seed);h.fills.push(fill(seed,'EXAMPLE_SEED_FILL',size,2));h.progress.push(terminal(seed,size,3));
  return h;
}
