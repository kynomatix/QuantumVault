import { readFileSync } from 'node:fs';
import { canonicalRequest } from '../../server/grid-bot/request-digest';
import { describe, expect, it } from 'vitest';
import { canonicalGridPolicy, computeGridPolicyHmac, verifyGridPolicyHmac, type GridPolicy } from '../../server/grid-bot/policy-hmac';
import { retainedGridCycles, GRID_CYCLE_V2_CREATION } from '../../server/grid-bot/cycle-policy';
import { retainedGridPolicy } from '../../server/grid-bot/launch-authority';
import { GRID_RUNTIME_POLICY, GRID_RUNTIME_POLICY_DIGEST, GRID_CYCLE_RUNTIME_POLICY_DIGEST, gridRuntimePolicy } from '../../server/grid-bot/runtime-policy';
import { validateRetainedGridCycles, type GridCycleLimits } from '../../server/grid-bot/cycle-validation';
import { prepareGridOrder, validatePreparedGridOrder, type GridOrderIntent } from '../../server/grid-bot/order-identity';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import { authority, clock, umk } from './draft-fixtures';
import { launchAuthorityFixture, retainedFixture } from './launch-authority-fixtures';
import { cyclePolicy } from './cycle-fixtures';

const limits:GridCycleLimits={tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'1000',minimumPrice:'1',maximumPrice:'1000',openingFeeRate:'0',closingFeeRate:'0'};
describe('version-selected immutable Grid authority',()=>{
  it('pins the v1 canonical bytes, HMAC, runtime bytes and runtime digest to fixed baseline fixtures',()=>{
    const golden=JSON.parse(readFileSync(new URL('./fixtures/cycle-v1-golden.json',import.meta.url),'utf8'));
    expect(canonicalGridPolicy(golden.policy as GridPolicy)).toBe(golden.canonical);
    expect(computeGridPolicyHmac(golden.policy,umk())).toEqual({ok:true,digest:golden.policyDigest});
    expect(verifyGridPolicyHmac(golden.policy,umk(),golden.policyDigest).ok).toBe(true);
    expect(JSON.stringify(GRID_RUNTIME_POLICY)).toBe(golden.runtimeCanonical);
    expect(GRID_RUNTIME_POLICY_DIGEST).toBe(golden.runtimeDigest);
    expect(gridRuntimePolicy('1.0.0')?.digest).toBe(golden.runtimeDigest);
  });
  it.each(['long','short'] as const)('reconstructs all %s cycle authority solely from retained signed columns',direction=>{
    const p=cyclePolicy(direction),signature=computeGridPolicyHmac(p,umk());expect(signature.ok).toBe(true);if(!signature.ok)return;
    const f={...launchAuthorityFixture(),policy:p,policyHash:signature.digest},saved=retainedFixture(f);
    const reconstructed=retainedGridPolicy(saved.bot,saved.levels);
    expect(canonicalGridPolicy(reconstructed)).toBe(canonicalGridPolicy(p));
    expect(retainedGridCycles(reconstructed)).toEqual(retainedGridCycles(p));
    expect(verifyGridPolicyHmac(reconstructed,umk(),signature.digest).ok).toBe(true);
    for(const changed of [
      {...p,seedAtCreation:false}, {...p,totalInvestment:'601.00'}, {...p,leverage:2},
      {...p,stopLossPrice:'77.00000000'}, {...p,entryScaleType:'ascending' as const},
      {...p,startPrice:'96.00000000'}, {...p,levels:p.levels.map((l,i)=>i===3?{...l,size:'0.90000000'}:l)},
      {...p,levels:p.levels.map((l,i)=>i===3?{...l,price:'111.00000000'}:l)},
    ]) expect(verifyGridPolicyHmac(changed,umk(),signature.digest).ok).toBe(false);
  });
  it('rejects unknown/mixed versions, wrong anchor flags, missing stops and endpoint drift',()=>{
    const p=cyclePolicy();
    for(const changed of [
      {...p,runtimePolicyVersion:'1.0.0'}, {...p,policyVersion:'EXAMPLE'},
      {...p,stopLossPrice:null,stopLossPercent:null},
      {...p,levels:p.levels.map((l,i)=>i===3?{...l,reduceOnly:false}:l)},
      {...p,levels:p.levels.map((l,i)=>i===3?{...l,side:'buy' as const}:l)},
      {...p,levels:[...p.levels].reverse()},
    ]) expect(canonicalGridPolicy(changed)).toBeNull();
    expect(gridRuntimePolicy('EXAMPLE')).toBeNull();expect(GRID_CYCLE_V2_CREATION).toBe(false);
    expect(gridRuntimePolicy('2.0.0')?.digest).toBe(GRID_CYCLE_RUNTIME_POLICY_DIGEST);
    expect(GRID_CYCLE_RUNTIME_POLICY_DIGEST).not.toBe(GRID_RUNTIME_POLICY_DIGEST);
  });
  it('validates future opening minima, lot, fee, maxima and capacity without resizing retained rows',()=>{
    const p=cyclePolicy(),original=structuredClone(p);expect(validateRetainedGridCycles(p,limits).ok).toBe(true);
    const future={...p,levels:p.levels.map((l,i)=>i===3?{...l,size:'0.09500000'}:l)};
    expect(validateRetainedGridCycles(future,limits).ok).toBe(false);
    for(const change of [{lot:'0.3'},{maximumQuote:'100'},{openingFeeRate:'1'},{tick:'3'},{maximumPrice:'119'}])
      expect(validateRetainedGridCycles(p,{...limits,...change}).ok).toBe(false);
    expect(validateRetainedGridCycles({...p,totalInvestment:'599.99'},limits).ok).toBe(false);
    expect(p).toEqual(original);
  });
  it('binds prepared orders to the trusted retained runtime version while preserving legacy defaults',()=>{
    const constraint=observePacificaConstraints({tick_size:'0.01',lot_size:'0.001',min_order_size:'1'},'BTC-PERP',clock);
    const intent:GridOrderIntent={account:'EXAMPLE',subaccountId:null,market:'BTC-PERP',protocolSymbol:'BTC',
      signerPublicKey:'EXAMPLE_SIGNER',signerGeneration:'EXAMPLE_GENERATION',deployment:'EXAMPLE_DEPLOYMENT',
      endpoint:'https://api.pacifica.fi/api/v1/orders/create',clientOrderId:'00000000-0000-4000-8000-000000000002',
      side:'long',price:'90',amount:'1',reduceOnly:false,signingTimestamp:clock,signingExpiryMs:5000};
    const current={account:intent.account,subaccountId:null,signerPublicKey:intent.signerPublicKey,signerGeneration:intent.signerGeneration,
      deployment:intent.deployment,endpoint:intent.endpoint,constraint};
    const quote=authority().entryFee!,legacy=prepareGridOrder(intent,quote,constraint,clock);
    expect(legacy.policyDigest).toBe(GRID_RUNTIME_POLICY_DIGEST);
    expect(validatePreparedGridOrder(legacy,current,clock)).toBe(true);
    expect(validatePreparedGridOrder(legacy,{...current,runtimePolicyVersion:'1.0.0'},clock)).toBe(true);
    const v2=prepareGridOrder({...intent,runtimePolicyVersion:'2.0.0'},quote,constraint,clock);
    expect(v2.unsigned).toEqual(legacy.unsigned);expect(v2.policyDigest).toBe(GRID_CYCLE_RUNTIME_POLICY_DIGEST);
    expect(validatePreparedGridOrder(v2,current,clock)).toBe(false);
    expect(validatePreparedGridOrder(v2,{...current,runtimePolicyVersion:'2.0.0'},clock)).toBe(true);
    const persisted=JSON.parse(canonicalRequest(v2));
    expect(validatePreparedGridOrder(persisted,{...current,runtimePolicyVersion:'2.0.0',constraint:JSON.parse(canonicalRequest(constraint))},clock)).toBe(true);
    persisted.unsigned.amount='2';
    expect(validatePreparedGridOrder(persisted,{...current,runtimePolicyVersion:'2.0.0'},clock)).toBe(false);
    expect(validatePreparedGridOrder(legacy,{...current,runtimePolicyVersion:'2.0.0'},clock)).toBe(false);
    expect(validatePreparedGridOrder(v2,{...current,runtimePolicyVersion:'EXAMPLE'},clock)).toBe(false);
    expect(()=>prepareGridOrder({...intent,runtimePolicyVersion:'EXAMPLE'},quote,constraint,clock)).toThrow();
  });
});
