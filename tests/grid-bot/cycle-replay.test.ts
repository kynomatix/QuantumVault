import { describe, expect, it } from 'vitest';
import { executableCycleQuantity, replayGridCycles, validateCycleSourceCredit, type CycleReplayInput } from '../../server/grid-bot/cycle-replay';
import { cyclePolicy, fill, history, operation, seeded, terminal } from './cycle-fixtures';

function states(h: CycleReplayInput) {
  const result=replayGridCycles(h);expect(result.ok).toBe(true);
  if(!result.ok)throw Error(result.reason);return result.cycles;
}
describe('v2 exact cycle replay and source-credit validation',()=>{
  it.each(['long','short'] as const)('repeats a seeded %s cycle without increasing its quota',direction=>{
    const h=seeded(direction),owner=direction==='long'?3:0;
    const close=operation(h.policy,'EXAMPLE_CLOSE_1',owner,'closing','1',4);
    h.operations.push(close);h.allocations.push({operationId:close.id,cycleOrdinal:owner,tradeId:'EXAMPLE_SEED_FILL',size:'1'});
    h.fills.push(fill(close,'EXAMPLE_EXIT_1','1',5));h.progress.push(terminal(close,'1',6));
    expect(states(h).find(s=>s.cycle.ownerOrdinal===owner)).toMatchObject({held:'0',openingCredit:'1'});
    const open=operation(h.policy,'EXAMPLE_OPEN_2',owner,'opening','1',7);
    open.recycleAllocations=[{tradeId:'EXAMPLE_EXIT_1',size:'1'}];
    expect(validateCycleSourceCredit(h,open).ok).toBe(true);
    h.operations.push(open);h.fills.push(fill(open,'EXAMPLE_ENTRY_2','1',8));h.progress.push(terminal(open,'1',9));
    const close2=operation(h.policy,'EXAMPLE_CLOSE_2',owner,'closing','1',10);
    h.operations.push(close2);h.allocations.push({operationId:close2.id,cycleOrdinal:owner,tradeId:'EXAMPLE_ENTRY_2',size:'1'});
    h.fills.push(fill(close2,'EXAMPLE_EXIT_2','1',11));h.progress.push(terminal(close2,'1',12));
    expect(states(h).find(s=>s.cycle.ownerOrdinal===owner)).toMatchObject({held:'0',openingCredit:'1',recycleCredits:[{tradeId:'EXAMPLE_EXIT_2',size:'1'}]});
    const reordered={...h,operations:[...h.operations].reverse(),fills:[...h.fills].reverse().concat(h.fills[0]),
      progress:[...h.progress].reverse().concat(h.progress[0]),allocations:[...h.allocations].reverse().concat(h.allocations[0])};
    expect(replayGridCycles(reordered)).toEqual(replayGridCycles(h));
  });
  it('keeps the two start-interval owners separate despite identical endpoint prices',()=>{
    const h=history(cyclePolicy('long',false));
    for(const owner of [1,2]){const op=operation(h.policy,`EXAMPLE_OPEN_${owner}`,owner,'opening','1',1);op.initialCredit='1';h.operations.push(op);}
    const result=states(h).filter(s=>[1,2].includes(s.cycle.ownerOrdinal));
    expect(result.map(s=>[s.cycle.openingPrice,s.cycle.closingPrice])).toEqual([['90.00000000','100.00000000'],['90.00000000','100.00000000']]);
    expect(result.map(s=>s.openingCommitments)).toEqual(['1','1']);
  });
  it('allows a protected partial opening while reserving its full uncertain residual',()=>{
    const h=history(cyclePolicy('long',false)),open=operation(h.policy,'EXAMPLE_OPEN',0,'opening','1',1);open.initialCredit='1';
    h.operations.push(open);h.fills.push(fill(open,'EXAMPLE_ENTRY','0.4',2));
    const close=operation(h.policy,'EXAMPLE_CLOSE',0,'closing','0.4',3);
    expect(validateCycleSourceCredit(h,close,[{operationId:close.id,cycleOrdinal:0,tradeId:'EXAMPLE_ENTRY',size:'0.4'}]).ok).toBe(true);
    expect(states(h)[0]).toMatchObject({held:'0.4',openingCommitments:'0.6',initialCredit:'0'});
    h.progress.push({operationId:open.id,state:'terminal',filledSize:'0.4',observedAt:3});
    expect(states(h)[0].openingCommitments).toBe('0.6');
    h.progress.push(terminal(open,'0.4',4));
    expect(states(h)[0]).toMatchObject({held:'0.4',openingCommitments:'0',initialCredit:'0.6'});
    const replacement=operation(h.policy,'EXAMPLE_REPLACEMENT',0,'opening','0.6',5);replacement.initialCredit='0.6';
    expect(validateCycleSourceCredit(h,replacement).ok).toBe(true);
    expect(validateCycleSourceCredit(h,{...replacement,preparedAt:3}).ok).toBe(false);
  });
  it('rejects double initial issuance, a second live leg, and missing or conflicting evidence',()=>{
    const h=history(cyclePolicy('long',false)),a=operation(h.policy,'EXAMPLE_A',0,'opening','0.6',1);a.initialCredit='0.6';
    h.operations.push(a);
    expect(validateCycleSourceCredit(h,{...a,id:'EXAMPLE_B',preparedAt:2}).ok).toBe(false);
    expect(validateCycleSourceCredit(h,{...a,id:'EXAMPLE_C',size:'0.1',initialCredit:'0.1',preparedAt:2}).ok).toBe(false);
    expect(replayGridCycles({...h,historyComplete:false}).ok).toBe(false);
    expect(replayGridCycles({...h,operations:[a,{...a,size:'0.5'}]}).ok).toBe(false);
    expect(replayGridCycles({...h,fills:[fill(a,'EXAMPLE_TRADE','0.1',2),fill(a,'EXAMPLE_TRADE','0.2',2)]}).ok).toBe(false);
    const older={operationId:a.id,state:'unknown' as const,observedAt:2},newer={...older,observedAt:3};
    const conflicting={...older,state:'live' as const,filledSize:'0',remainingSize:'0.6'};
    for(const progress of [[older,newer,conflicting],[newer,conflicting,older],[conflicting,older,newer]])
      expect(replayGridCycles({...h,progress}).ok).toBe(false);
  });
  it('never lends a different cycle its seed partition or closing credit',()=>{
    const h=seeded(),close=operation(h.policy,'EXAMPLE_CLOSE',3,'closing','1',4);
    expect(validateCycleSourceCredit(h,close,[{operationId:close.id,cycleOrdinal:2,tradeId:'EXAMPLE_SEED_FILL',size:'1'}]).ok).toBe(false);
    h.operations.push(close);h.allocations.push({operationId:close.id,cycleOrdinal:3,tradeId:'EXAMPLE_SEED_FILL',size:'1'});
    h.fills.push(fill(close,'EXAMPLE_EXIT','1',5));h.progress.push(terminal(close,'1',6));
    const open=operation(h.policy,'EXAMPLE_OPEN',2,'opening','1',7);open.recycleAllocations=[{tradeId:'EXAMPLE_EXIT',size:'1'}];
    expect(validateCycleSourceCredit(h,open).ok).toBe(false);
    const own={...open,cycleOrdinal:3,price:'100.00000000'};expect(validateCycleSourceCredit(h,own).ok).toBe(true);
    h.operations.push(own);h.fills.push(fill(own,'EXAMPLE_ENTRY','1',8));h.progress.push(terminal(own,'1',9));
    expect(validateCycleSourceCredit(h,{...own,id:'EXAMPLE_REUSE',preparedAt:10}).ok).toBe(false);
  });
  it('keeps a partial closing residual protected while its actual fill funds an opening',()=>{
    const h=seeded(),close=operation(h.policy,'EXAMPLE_CLOSE',3,'closing','1',4);
    h.operations.push(close);h.allocations.push({operationId:close.id,cycleOrdinal:3,tradeId:'EXAMPLE_SEED_FILL',size:'1'});
    h.fills.push(fill(close,'EXAMPLE_EXIT','0.4',5));
    h.progress.push({operationId:close.id,state:'live',filledSize:'0.4',remainingSize:'0.6',observedAt:6});
    const open=operation(h.policy,'EXAMPLE_OPEN',3,'opening','0.4',7);open.recycleAllocations=[{tradeId:'EXAMPLE_EXIT',size:'0.4'}];
    expect(validateCycleSourceCredit(h,open).ok).toBe(true);h.operations.push(open);
    expect(states(h)[3]).toMatchObject({held:'0.6',openingCommitments:'0.4',closingCommitments:'0.6',openingCredit:'0',liveOpening:[open.id],liveClosing:[close.id]});
    expect(replayGridCycles({...h,progress:[{...h.progress.at(-1)!,filledSize:'0.5'}]}).ok).toBe(false);
  });
  it('releases only the unfilled source portions of a proven canceled recycle request',()=>{
    const h=seeded(),close=operation(h.policy,'EXAMPLE_CLOSE',3,'closing','1',4);
    h.operations.push(close);h.allocations.push({operationId:close.id,cycleOrdinal:3,tradeId:'EXAMPLE_SEED_FILL',size:'1'});
    h.fills.push(fill(close,'EXAMPLE_EXIT_A','0.4',5),fill(close,'EXAMPLE_EXIT_B','0.6',6));h.progress.push(terminal(close,'1',7));
    const open=operation(h.policy,'EXAMPLE_OPEN',3,'opening','1',8);
    open.recycleAllocations=[{tradeId:'EXAMPLE_EXIT_A',size:'0.4'},{tradeId:'EXAMPLE_EXIT_B',size:'0.6'}];
    h.operations.push(open);h.fills.push(fill(open,'EXAMPLE_ENTRY','0.5',9));h.progress.push(terminal(open,'0.5',10));
    expect(states(h)[3]).toMatchObject({held:'0.5',openingCredit:'0.5',recycleCredits:[{tradeId:'EXAMPLE_EXIT_B',size:'0.5'}]});
  });
  it('never turns a stop/manual/sweep close into recycle credit',()=>{
    const h=seeded(),close=operation(h.policy,'EXAMPLE_STOP',null,'closing','1',4,'close');
    h.operations.push(close);h.allocations.push({operationId:close.id,cycleOrdinal:3,tradeId:'EXAMPLE_SEED_FILL',size:'1'});
    h.fills.push(fill(close,'EXAMPLE_STOP_FILL','1',5));h.progress.push(terminal(close,'1',6));
    expect(states(h)[3]).toMatchObject({held:'0',openingCredit:'0',recycleCredits:[]});
  });
  it('assigns only actual seed fills, then releases unused quotas with complete terminal proof',()=>{
    const h=history(),seed=operation(h.policy,'EXAMPLE_SEED',null,'opening','3',1,'seed');h.operations.push(seed);
    h.fills.push(fill(seed,'EXAMPLE_SEED_FILL','1.4',2));h.progress.push(terminal(seed,'1.4',3));
    expect(states(h).slice(2).map(s=>[s.held,s.pendingSeed,s.initialCredit])).toEqual([['1','0','0'],['0.4','0.6','0'],['0','1','0']]);
    h.unusedSeedProof={operationIds:[seed.id],historyThrough:3,entriesAllowed:true};
    expect(states(h).slice(2).map(s=>s.initialCredit)).toEqual(['0','0.6','1']);
    const open=operation(h.policy,'EXAMPLE_OPEN',4,'opening','1',4);open.initialCredit='1';
    expect(validateCycleSourceCredit(h,open).ok).toBe(true);
    expect(replayGridCycles({...h,operations:[...h.operations,{...open,preparedAt:2}]}).ok).toBe(false);
    expect(replayGridCycles({...h,unusedSeedProof:{...h.unusedSeedProof,operationIds:[]}}).ok).toBe(false);
  });
  it('retains dust and exempts backed reductions from the opening minimum',()=>{
    const h=history(cyclePolicy('long',false)),open=operation(h.policy,'EXAMPLE_OPEN',0,'opening','1',1);open.initialCredit='1';
    h.operations.push(open);h.fills.push(fill(open,'EXAMPLE_DUST','0.0049',2));h.progress.push(terminal(open,'0.0049',3));
    const s=states(h)[0];expect(s.held).toBe('0.0049');
    expect(executableCycleQuantity(s,'closing','0.001','10')).toBe('0.004');
    expect(executableCycleQuantity({...s,openingCredit:'0.0049'},'opening','0.001','10')).toBe('0');
  });
});
