import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { GRID_BEHAVIOUR_MODES, gridBehaviourCopy, gridOneShotOwners } from '../../shared/grid-behaviour';
import { calculateGrid, minimumInvestment } from '../../server/grid-bot/engine';
import type { GridInput } from '../../server/grid-bot/engine-types';
import { canonicalGridPolicy, computeGridPolicyHmac, verifyGridPolicyHmac } from '../../server/grid-bot/policy-hmac';
import { retainedGridCycles } from '../../server/grid-bot/cycle-policy';
import { retainedGridPolicy } from '../../server/grid-bot/retained-policy';
import { executableCycleQuantity, replayGridCycles, validateCycleSourceCredit } from '../../server/grid-bot/cycle-replay';
import { cycleCapacity } from '../../server/grid-bot/cycle-capacity';
import { projectCycleOrders } from '../../server/grid-bot/cycle-projection';
import { projectGridStop } from '../../server/grid-bot/stop-clearance';
import { authoritativeGridPreview } from '../../server/grid-bot/draft-service';
import { previewGrid } from '../../server/grid-planner/preview';
import { gridRuntimePolicy } from '../../server/grid-bot/runtime-policy';
import { gridModePlanValid, gridModeLines } from '../../client/src/lib/grid-behaviour-view';
import { gridSetupForm, gridSetupIntent } from '../../client/src/lib/grid-setup-view';
import { plannerPreviewQuery } from '../../client/src/lib/grid-planner-view';
import { behaviourPolicy } from './behaviour-fixtures';
import { history, operation, fill, terminal } from './cycle-fixtures';
import { authority, clock, intent, umk } from './draft-fixtures';

const input: GridInput = { policyVersion: '2.2.0', sizingVersion: 'lean-1', safetyEnvelopePrice: '110', behaviourMode: 'repeat_all', side: 'long',
  lower: '90', upper: '110', start: '100', intervals: 20, investment: '1000', leverage: '1', seed: true, entryScale: 'flat', profitScale: 'flat',
  tick: '0.01', lot: '0.000001', minimumQuote: '1', investmentStep: '0.01', transferFloor: '0.01', effectiveMakerCostRate: '0' };
function plan(extra: Partial<GridInput> = {}) {
  const result = calculateGrid({ ...input, ...extra }); if (!result.ok) throw Error(result.issues.map(i => i.reason).join('; ')); return result.plan;
}
describe('signed behaviour modes', () => {
  it('records the owner example with actual per-line quantities and notionals', () => {
    console.log('GRID_MODE_EXAMPLES', JSON.stringify(GRID_BEHAVIOUR_MODES.map(behaviourMode => {
      const p = plan({behaviourMode});
      return {behaviourMode,capacity:p.capacityNotional,seedQuantity:p.seedQuantity,lines:p.lines.filter(l=>Number(l.quantity)>0).map(l=>({price:l.price,quantity:l.quantity,notional:new Decimal(l.price).mul(l.quantity).toFixed(8),recycles:p.cycles!.find(c=>c.ownerOrdinal===l.ordinal)?.recycles}))};
    })));
  });
  it('pins the exact quarter boundary after quantization, including off-node starts and small grids', () => {
    expect(plan({ behaviourMode: 'step_back_edge' }).gridPolicyExtension?.boundaryPrices.map(Number)).toEqual([106,107,108,109,110]);
    expect(plan({ behaviourMode: 'step_back_edge', side: 'short', safetyEnvelopePrice: '120' }).gridPolicyExtension?.boundaryPrices.map(Number)).toEqual([90,91,92,93,94]);
    expect(plan({ behaviourMode: 'step_back_edge', start: '100.457' }).gridPolicyExtension?.selectedOwnerOrdinals).toEqual([16,17,18,19,20]);
    expect(gridOneShotOwners('step_back_edge', [2], 1, true)).toEqual([2]);
    expect(gridOneShotOwners('step_back_edge', [1,2], 100, true)).toEqual([1,2]);
  });
  for (const behaviourMode of GRID_BEHAVIOUR_MODES) for (const side of ['long','short'] as const) for (const seed of [true,false])
    for (const scale of ['flat','ascending','descending'] as const) {
      it(`sizes, signs and searches minimums for ${behaviourMode}, ${side}, seed ${seed}, ${scale}`, () => {
        const extra = { behaviourMode, side, seed, entryScale: scale, profitScale: scale, safetyEnvelopePrice: side === 'long' ? '110' : '120' };
        const p = plan(extra); expect(gridModePlanValid(p)).toBe(true);
        for (const c of p.cycles!) {
          expect(new Decimal(c.quantity).mod(input.lot).isZero()).toBe(true);
          if (c.recycles === false) { expect(c.initialOpeningCredit).toBe('0'); expect(c.enabled).toBe(seed); }
          if (!c.enabled) expect([c.quantity,c.initialInventory,c.initialOpeningCredit]).toEqual(['0','0','0']);
          if (c.recycles) expect(new Decimal(c.quantity).mul(c.openingPrice).gte(input.minimumQuote)).toBe(true);
        }
        expect(new Decimal(p.capacityNotional!).lte(input.investment)).toBe(true);
        const minimum = minimumInvestment({ ...input, ...extra }); expect(minimum.ok).toBe(true);
        if (minimum.ok) {
          expect(calculateGrid({ ...input, ...extra, investment: minimum.investment }).ok).toBe(true);
          expect(calculateGrid({ ...input, ...extra, investment: new Decimal(minimum.investment).minus('0.01').toFixed(2) }).ok).toBe(false);
        }
      });
    }
  it('retires seed-off targets without shrinking the initial entry sizes or inventing upper orders', () => {
    const plans = GRID_BEHAVIOUR_MODES.map(behaviourMode => plan({ behaviourMode, seed: false }));
    expect(plans.map(p => p.lines.filter(l => l.role === 'entry').map(l => l.quantity))).toEqual(Array(3).fill(plans[0].lines.filter(l => l.role === 'entry').map(l => l.quantity)));
    expect(plans[1].cycles!.filter(c => c.anchor === 'closing').every(c => !c.enabled && c.quantity === '0')).toBe(true);
    expect(gridModeLines(plans[2]).filter(l => l.recycles === false)).toHaveLength(5);
  });
  it('binds every descriptor and restores it from the existing authority snapshot without changing legacy grammar', () => {
    const p = behaviourPolicy('step_back_edge'), signed = computeGridPolicyHmac(p, umk()); expect(signed.ok).toBe(true); if (!signed.ok) return;
    const mutate = (fn: (policy: typeof p) => void) => { const copy = structuredClone(p); fn(copy); expect(verifyGridPolicyHmac(copy, umk(), signed.digest).ok).toBe(false); };
    mutate(x => { x.gridPolicyExtension!.mode = 'repeat_all'; });
    mutate(x => { x.gridPolicyExtension!.owners[0].recycles = false; });
    mutate(x => { x.gridPolicyExtension!.owners[0].enabled = false; });
    mutate(x => { x.gridPolicyExtension!.selectedOwnerOrdinals = []; });
    mutate(x => { x.gridPolicyExtension!.boundaryPrices = []; });
    mutate(x => { x.gridPolicyExtension!.owners[0].quantity = '2.00000000'; });
    mutate(x => { x.gridPolicyExtension!.owners[0].openingValuationBound = '1.00000000'; });
    mutate(x => { x.gridPolicyExtension!.seedPriceBounds.high = '1.00000000'; });
    mutate(x => { x.runtimePolicyVersion = '2.0.0'; });
    const raw = Object.fromEntries(Object.entries(p).filter(([k]) => !['levels','sizingVersion','safetyEnvelopePrice','gridPolicyExtension'].includes(k)).map(([k,v]) => [k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
    raw.authority_snapshot = { gridSizing: { sizingVersion: p.sizingVersion, safetyEnvelopePrice: p.safetyEnvelopePrice }, gridPolicyExtension: p.gridPolicyExtension };
    expect(canonicalGridPolicy(retainedGridPolicy(raw, p.levels.map(l => ({ ...l, reduce_only: l.reduceOnly }))))).toBe(canonicalGridPolicy(p));
    expect(gridRuntimePolicy('2.2.0')?.digest).not.toBe(gridRuntimePolicy('2.0.0')?.digest);
    expect(gridRuntimePolicy('2.2.1')).toBeNull();
  });
  for (const mode of ['step_back','step_back_edge'] as const) for (const side of ['long','short'] as const) {
    it(`never reopens or compounds ${mode} ${side}, through partial fills, unknowns and reordered restart replay`, () => {
      const h = history(behaviourPolicy(mode, side)), cycles = retainedGridCycles(h.policy)!;
      const owner = cycles.find(c => c.recycles === false)!;
      const seedQuantity = cycles.reduce((s,c) => s.plus(c.initialInventory), new Decimal(0)).toFixed();
      const seed = operation(h.policy, 'EXAMPLE_SEED', null, 'opening', seedQuantity, 1, 'seed');
      h.operations.push(seed); h.fills.push(fill(seed, 'EXAMPLE_SEED_FILL', seedQuantity, 2)); h.progress.push(terminal(seed, seedQuantity, 3));
      const close = operation(h.policy, 'EXAMPLE_CLOSE', owner.ownerOrdinal, 'closing', '1', 4);
      h.operations.push(close); h.allocations.push({ operationId: close.id, cycleOrdinal: owner.ownerOrdinal, tradeId: 'EXAMPLE_SEED_FILL', size: '1' });
      const before = cycleCapacity(h, '95')!;
      for (let n = 1; n <= 10; n++) {
        h.fills.push(fill(close, `EXAMPLE_EXIT_${n}`, '0.1', 4 + n));
        const amount = new Decimal(n).div(10).toFixed();
        h.progress = [h.progress[0], ...(n === 10 ? [terminal(close, '1', 20)] : [{ operationId: close.id, state: 'live' as const, filledSize: amount, remainingSize: new Decimal(1).minus(amount).toFixed(), observedAt: 4 + n }])];
        const result = replayGridCycles(h); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.reason);
        const c = result.cycles.find(c => c.cycle.ownerOrdinal === owner.ownerOrdinal)!;
        expect(c.openingCredit).toBe('0'); expect(c.recycleCredits).toEqual([]); expect(executableCycleQuantity(c, 'opening', '0.001', '1')).toBe('0');
        expect(c.held).toBe(new Decimal(1).minus(amount).toFixed());
        expect(new Decimal(cycleCapacity(h, '95')!.used).eq(new Decimal(before.used).minus(new Decimal(amount).mul(before.envelope)))).toBe(true);
        for (const paused of [true,false]) expect(projectCycleOrders(result.cycles, h.progress, side, '0.001','1','95',!paused).filter(o=>o.ownerOrdinal===owner.ownerOrdinal).every(o=>o.leg==='closing')).toBe(true);
        const restored = JSON.parse(JSON.stringify(h)); restored.operations.reverse(); restored.fills.reverse(); restored.allocations.reverse();
        expect(replayGridCycles(restored)).toEqual(result);
        const reopen = operation(h.policy, 'EXAMPLE_REOPEN', owner.ownerOrdinal, 'opening', amount, 30);
        expect(validateCycleSourceCredit(h, { ...reopen, initialCredit: amount }).ok).toBe(false);
        expect(validateCycleSourceCredit(h, { ...reopen, recycleAllocations: [{ tradeId: `EXAMPLE_EXIT_${n}`, size: amount }] }).ok).toBe(false);
      }
      const result = replayGridCycles(h); if (!result.ok) throw Error(result.reason);
      expect(projectCycleOrders(result.cycles, h.progress, side, '0.001','1','95',true).find(o=>o.ownerOrdinal===owner.ownerOrdinal)?.state).toBe('Finished here');
      expect(result.cycles.every(c => c.cycle.quantity === '1.00000000')).toBe(true);
    });
    it(`retires only proven unused ${mode} ${side} seed targets, even when entries are paused`, () => {
      const h = history(behaviourPolicy(mode, side));
      const q = retainedGridCycles(h.policy)!.reduce((s,c)=>s.plus(c.initialInventory),new Decimal(0)).toFixed();
      const seed = operation(h.policy,'EXAMPLE_SEED',null,'opening',q,1,'seed'); h.operations.push(seed);
      const held = cycleCapacity(h,'95')!; expect(held.reserved).toBe(new Decimal(q).mul(held.envelope).toFixed());
      h.progress.push({ operationId:seed.id,state:'terminal',filledSize:'0',observedAt:3 });
      expect(cycleCapacity(h,'95')!.reserved).toBe(held.reserved);
      h.progress = [terminal(seed,'0',4)]; h.unusedSeedProof = { operationIds:[seed.id],historyThrough:4,entriesAllowed:false };
      const r = replayGridCycles(h); expect(r.ok).toBe(true); if (!r.ok) throw Error(r.reason);
      expect(r.cycles.filter(c=>!c.cycle.recycles).every(c=>c.pendingSeed==='0'&&c.openingCredit==='0')).toBe(true);
      expect(cycleCapacity(h,'95')!.used).toBe('0');
    });
  }
  for (const behaviourMode of GRID_BEHAVIOUR_MODES) for (const side of ['long','short'] as const) for (const seed of [true,false]) {
    it(`matches public and authoritative preview/minimum: ${behaviourMode} ${side} seed ${seed}`, async () => {
      const a = authority(), requested = { ...intent, behaviourMode, direction:side, stopPrice:side==='long'?'80':'120', seedAtCreation:seed,gridCount:20,totalInvestment:'1000' };
      const deps = {now:()=>clock,observe:async()=>a,umk:async()=>umk(),storage:{} as any};
      const draft = await authoritativeGridPreview('EXAMPLE',requested,'EXAMPLE_REVISION',deps);
      const q = {behaviourMode,market:requested.market,side,lower:requested.lowerPrice,upper:requested.upperPrice,stop:requested.stopPrice,intervals:20,entryScale:'flat' as const,profitScale:'flat' as const,seed,leverage:'1',investment:'1000',fee:seed?'0.0003':'0.0002'};
      const preview = previewGrid(q,a.market,clock);
      expect(draft.state).toBe('ready'); expect(draft.plan?.policyVersion).toBe('2.2.0'); expect(preview.requestedPlan?.lines).toEqual(draft.plan?.lines);
      expect(preview.minimum.state==='available'&&preview.minimum.value).toBe(draft.minimum);
      expect(previewGrid(q,a.market,clock,{modesCreation:false}).state).toBe('rejected');
      await expect(authoritativeGridPreview('EXAMPLE',requested,'EXAMPLE_REVISION',{...deps,modesCreation:false})).rejects.toThrow();
      const form = gridSetupForm(requested,requested.market); expect(gridSetupIntent(form,q.stop,'manual').behaviourMode).toBe(behaviourMode);
      expect(new URLSearchParams(plannerPreviewQuery(form,q.stop).value).get('behaviourMode')).toBe(behaviourMode);
      expect(gridBehaviourCopy(behaviourMode,side,seed).hint).toBeTruthy();
    });
  }
  it('bounds adverse one-shot inventory at the seed, and excludes disabled owners', () => {
    for (const side of ['long','short'] as const) for (const seed of [true,false]) {
      const p = plan({side,seed,behaviourMode:'step_back',safetyEnvelopePrice:side==='long'?'110':'120'});
      const r = projectGridStop({plan:p,funding:'1000',stop:side==='long'?'80':'120',tick:'0.01',maxLeverage:'10',makerRate:'0',takerRate:'0',observedAt:clock,expiresAt:clock+5000},clock);
      expect(r.state).toBe('available');
      if(r.state==='available') expect(r.projection.weightedEntry).toBe(seed?(side==='long'?p.seedPriceBounds!.high:p.seedPriceBounds!.low):side==='long'?'99':'101');
    }
  });
});
