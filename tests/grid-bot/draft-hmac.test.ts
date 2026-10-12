import { describe,it,expect,vi } from 'vitest';
vi.mock('node:crypto',async importOriginal=>{const actual=await importOriginal<typeof import('node:crypto')>();return {...actual,createHmac:vi.fn(actual.createHmac)};});
import * as crypto from 'node:crypto';
import * as subkeys from '../../server/crypto-v3';
import { computeGridPolicyHmac,verifyGridPolicyHmac,canonicalGridPolicy } from '../../server/grid-bot/policy-hmac';
import { policy,umk } from './draft-fixtures';
describe('immutable Grid policy HMAC',()=>{
  it('binds the complete ordered policy and leaves the UMK untouched',()=>{const p=policy(),secret=umk(),before=Buffer.from(secret),r=computeGridPolicyHmac(p,secret);expect(r.ok).toBe(true);if(!r.ok)return;
    expect(verifyGridPolicyHmac(p,secret,r.digest).ok).toBe(true);expect(secret).toEqual(before);p.levels[0].size='2.00000000';expect(verifyGridPolicyHmac(p,secret,r.digest)).toEqual({ok:false,reason:'mismatch'});});
  it.each(['id','market','direction','upperPrice','lowerPrice','startPrice','gridCount','totalInvestment','leverage','entryScaleType','profitScaleType','stopLossPrice','seedAtCreation'] as const)('binds %s',key=>{
    const p=policy(),r=computeGridPolicyHmac(p,umk());if(!r.ok)throw Error();const changed={...p,[key]:key==='leverage'?2:key==='seedAtCreation'?true:key==='gridCount'?2:key==='id'?crypto.randomUUID():key==='market'?'ETH-PERP':key==='direction'?'short':key.includes('Scale')?'ascending':key==='totalInvestment'?'200.00':'120.00000000'};
    expect(verifyGridPolicyHmac(changed,umk(),r.digest).ok).toBe(false);});
  it.each(['a','EXAMPLE','A'.repeat(64),'ab'.repeat(33)])('strictly rejects malformed digest %s',value=>{expect(verifyGridPolicyHmac(policy(),umk(),value)).toEqual({ok:false,reason:'malformed_digest'});});
  it('rejects secrets, unknown versions, exponent decimals and reordered levels',()=>{const p=policy();expect(computeGridPolicyHmac(p,null)).toEqual({ok:false,reason:'missing_secret'});expect(computeGridPolicyHmac(p,Buffer.alloc(31))).toEqual({ok:false,reason:'invalid_secret'});
    expect(computeGridPolicyHmac({...p,policyVersion:'EXAMPLE'},umk())).toEqual({ok:false,reason:'unknown_version'});expect(canonicalGridPolicy({...p,startPrice:'1e2'})).toBeNull();expect(canonicalGridPolicy({...p,levels:[...p.levels].reverse()})).toBeNull();});
  it('zeros the dedicated derived key on success and a crypto failure',()=>{const spy=vi.spyOn(subkeys,'zeroizeBuffer'),p=policy();computeGridPolicyHmac(p,umk());expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][0].every(v=>v===0)).toBe(true);
    const hmac=vi.mocked(crypto.createHmac).mockImplementationOnce(()=>{throw new Error('EXAMPLE');});expect(()=>computeGridPolicyHmac(p,umk())).toThrow('EXAMPLE');expect(spy).toHaveBeenCalledTimes(2);expect(spy.mock.calls[1][0].every(v=>v===0)).toBe(true);hmac.mockClear();spy.mockRestore();});
});
