import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHOENIX_RISK_FLAGS, PHOENIX_RECOVERY_ACTIONS, phoenixCanaryAllows, phoenixFeatureEnabled, phoenixExposureAllows, readPhoenixCanaryPolicy,
  type PhoenixCanaryPolicy } from '../../server/protocol/phoenix/rollout';
const now = 10_000;
function policy(): PhoenixCanaryPolicy {
  return {version:1,authorizationId:'EXAMPLE-owner-word',ownerWallet:'EXAMPLE-owner',botIds:['EXAMPLE-bot'],maxBots:1,
    expiresAt:now+60_000,stage:'carry',acceptedUnits:Array.from({length:16},(_,i)=>`U${String(i+1).padStart(2,'0')}`),
    reviewedDeployment:true,recoveryDrillPassed:true,caps:{maxRegistrationLamports:'100',maxTransferUsdcMicros:'100',
      maxExposureUsdcMicros:'1000',maxDebtUsdcMicros:'500',maxParkUsdcMicros:'100',maxCollateralRaw:'200',collateralMint:'EXAMPLE-mint',maxLeverage:'2'}};
}
function environment(p = policy()): NodeJS.ProcessEnv {
  return {PHOENIX_CANARY_POLICY:JSON.stringify(p),PHOENIX_NEW_RISK_ENABLED:'true',PHOENIX_OWNER_LAUNCH_AUTHORIZED:'true',
    ...Object.fromEntries(Object.values(PHOENIX_RISK_FLAGS).map(flag=>[flag,'true']))};
}
const r = {ownerWallet:'EXAMPLE-owner',botId:'EXAMPLE-bot',registrationLamports:'100',transferUsdcMicros:'100',
  notionalMicros:'500',leverage:'2',debtUsdcMicros:'500',parkUsdcMicros:'100',collateralRaw:'200',collateralMint:'EXAMPLE-mint'};
afterEach(()=>vi.unstubAllEnvs());
describe('U16 owner canary admission',()=>{
  it('reuses an immutable parse while checking expiry on every call',()=>{
    const env=environment(), first=readPhoenixCanaryPolicy(env,now);
    expect(readPhoenixCanaryPolicy(env,now+1)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(readPhoenixCanaryPolicy(env,now+60_000)).toBeNull();
    const changed=environment({...policy(),authorizationId:'EXAMPLE-new-grant'});
    expect(readPhoenixCanaryPolicy(changed,now)?.authorizationId).toBe('EXAMPLE-new-grant');
  });
  it.each(Object.keys(PHOENIX_RISK_FLAGS) as (keyof typeof PHOENIX_RISK_FLAGS)[])('%s fails closed without a launch policy and admits exact capped owner',action=>{
    expect(phoenixCanaryAllows(action,r,{},now)).toBe(false);
    expect(phoenixCanaryAllows(action,r,environment(),now)).toBe(true);
    expect(phoenixCanaryAllows(action,{...r,ownerWallet:'EXAMPLE-stranger'},environment(),now)).toBe(false);
    expect(phoenixCanaryAllows(action,{...r,botId:'EXAMPLE-other'},environment(),now)).toBe(false);
    for(const flag of ['PHOENIX_NEW_RISK_ENABLED','PHOENIX_OWNER_LAUNCH_AUTHORIZED',PHOENIX_RISK_FLAGS[action]]) {
      expect(phoenixCanaryAllows(action,r,{...environment(),[flag]:'false'},now)).toBe(false);
    }
  });
  it.each(PHOENIX_RECOVERY_ACTIONS)('%s survives kill, expiry, removed allowlist and missing grant',action=>{
    expect(phoenixCanaryAllows(action,{ownerWallet:'EXAMPLE-recovery-owner',botId:'EXAMPLE-old-bot'},{},now)).toBe(true);
  });
  it('rejects missing acceptance, malformed caps, cohort expansion and unproved deployment/drill',()=>{
    for(const patch of [{acceptedUnits:['U01']},{maxBots:6},{botIds:['EXAMPLE-bot','EXAMPLE-other']},{expiresAt:now},
      {expiresAt:now+86_400_001},{reviewedDeployment:false},{recoveryDrillPassed:false},{caps:{...policy().caps,maxLeverage:'2\n'}}]) {
      expect(readPhoenixCanaryPolicy(environment({...policy(),...patch} as PhoenixCanaryPolicy),now)).toBeNull();
    }
    expect(readPhoenixCanaryPolicy({PHOENIX_CANARY_POLICY:'{EXAMPLE'},now)).toBeNull();
  });
  it('enforces every monetary cap and rejects absent/unknown exposure',()=>{
    for(const [action,field,value] of [['create','registrationLamports','101'],['fund','transferUsdcMicros','101'],
      ['entry','notionalMicros','1001'],['entry','leverage','3'],['borrow','debtUsdcMicros','501'],
      ['topup','collateralRaw','201'],['defense','collateralMint','EXAMPLE-other'],['park','parkUsdcMicros','101'],['carry','parkUsdcMicros','101']] as const) {
      expect(phoenixCanaryAllows(action,{...r,[field]:value},environment(),now)).toBe(false);
    }
    expect(phoenixExposureAllows(undefined,'500',environment(),now)).toBe(false);
    expect(phoenixExposureAllows('501','500',environment(),now)).toBe(false);
    expect(phoenixExposureAllows('500','500',environment(),now)).toBe(true);
  });
  it('stages parking before debt, defense before carry; stale grants revoke active flags',()=>{
    expect(phoenixFeatureEnabled('borrow',environment({...policy(),stage:'trading'}),now)).toBe(false);
    expect(phoenixFeatureEnabled('carry',{...environment(),PHOENIX_AUTO_DEFENSE_ENABLED:'false'},now)).toBe(false);
    expect(phoenixFeatureEnabled('entry',environment(),now+60_000)).toBe(false);
    expect(phoenixFeatureEnabled('entry',{...environment(),PHOENIX_ENTRY_ENABLED:'TRUE'},now)).toBe(false);
  });
  it('latches shutdown before async drain while recovery remains available',async()=>{
    vi.resetModules();const isolated=await import('../../server/protocol/phoenix/rollout');
    expect(isolated.phoenixCanaryAllows('entry',r,environment(),now)).toBe(true);
    isolated.stopPhoenixNewRisk();
    expect(isolated.phoenixCanaryAllows('entry',r,environment(),now)).toBe(false);
    expect(isolated.phoenixCanaryAllows('repay',r,{},now)).toBe(true);
    expect(isolated.phoenixCanaryAllows('withdraw',r,{},now)).toBe(true);
  });
});
