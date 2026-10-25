import {expect,it,vi} from 'vitest';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {serviceBotPass} from '../../server/grid-worker/bot-pass';
import {protectiveQuotaRequest,withProtectivePurpose} from '../../server/grid-worker/protective-purpose';
import {workerFetch} from '../../server/grid-worker/transport';
import {gridActionAllowed,type KillContext} from '../../server/grid-worker/kill';
import {protectiveConsentMac,encodeProtectiveConsent,type ProtectiveConsent} from '../../server/grid-worker/protective-consent';
const url=(path:string)=>new URL('https://api.pacifica.fi/api/v1'+path);
it('keeps MAIN rescue construction and signing inside the protective core',()=>{
  const executor=readFileSync('server/grid-worker/protective-executor.ts','utf8');
  expect(executor).toContain('gridLifecycleCore(monitor,reads,json,this.dependencies,{},true)');
  expect(executor).not.toMatch(/from ['"][^'"]*(?:session|canonical|legacy-key)/i);
  expect(executor).not.toMatch(/kind:\s*['"](?:create|fund|leverage|seed|limit|sweep|transfer|recycle)['"]/);
  expect(executor).toContain('getExecutionUmk');
  expect(readFileSync('script/build-grid-worker.ts','utf8')).toContain('protective-executor');
});
it('records a refused owner master locally and services the next bot',async()=>{
  const tick=vi.fn(),refused=vi.fn(),observed=vi.fn();
  await serviceBotPass(new AbortController().signal,{assertHolder:()=>{},claim:async seen=>['EXAMPLE_A','EXAMPLE_B'].filter(id=>!seen.includes(id)).map(id=>({id}))[0]??null,
    allowed:c=>c.id==='EXAMPLE_B',refused,tick,observed,observationFailed:async()=>{},release:async()=>{}});
  expect(refused).toHaveBeenCalledOnce();expect(tick).toHaveBeenCalledExactlyOnceWith({id:'EXAMPLE_B'});
  expect(observed).toHaveBeenCalledWith({id:'EXAMPLE_A'},expect.any(Error));
});
it('keeps ordinary and unrelated requests out of the protective quota allocation',async()=>{
  expect(protectiveQuotaRequest(url('/positions'),'GET',undefined)).toBe(false);
  await withProtectivePurpose(async()=>{
    for(const path of ['/positions','/orders','/info/prices'])expect(protectiveQuotaRequest(url(path),'GET',undefined)).toBe(true);
    for(const path of ['/account','/trades','/orders/history'])expect(protectiveQuotaRequest(url(path),'GET',undefined)).toBe(false);
    expect(protectiveQuotaRequest(url('/orders/cancel'),'POST',JSON.stringify({order_id:'EXAMPLE'}))).toBe(true);
    expect(protectiveQuotaRequest(url('/orders/create_market'),'POST',JSON.stringify({reduce_only:true}))).toBe(true);
    expect(protectiveQuotaRequest(url('/orders/create_market'),'POST',JSON.stringify({reduce_only:false}))).toBe(false);
    expect(protectiveQuotaRequest(url('/orders/create'),'POST',JSON.stringify({reduce_only:true}))).toBe(false);
    expect(protectiveQuotaRequest(new URL('https://example.com/api/v1/positions'),'GET',undefined)).toBe(false);
  });
  expect(protectiveQuotaRequest(url('/positions'),'GET',undefined)).toBe(false);
});
it('charges each send once and honors backoff without blind retries',async()=>{
  const debit=vi.fn(async()=>{}),rateLimited=vi.fn(async()=>{}),fetcher=vi.fn(async()=>new Response('{}',{status:429}));
  const send=workerFetch({debit,rateLimited},fetcher as typeof fetch);
  await expect(withProtectivePurpose(()=>send(url('/orders/create_market'),{method:'POST',body:JSON.stringify({reduce_only:true})}))).rejects.toThrow('GRID_QUOTA_BACKOFF');
  expect(debit).toHaveBeenCalledWith('pacifica_rest',120,true);expect(rateLimited).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
});
it('protective authority never permits opening, funding, sweeping or release',()=>{
  const c:KillContext={role:'protective',executionMode:'external',legacyControlsEnabled:true,runMode:'trading',executionEnabled:true,entriesPaused:true,drainRequested:false,observerFenced:false,holderValid:true,identityValid:true,authorityValid:true,alreadyOwned:true,terminalProof:true,scopeAndConsent:true,retainedAuthority:true,signedPolicy:true,protectiveDrain:true};
  for(const action of ['start','resume','cycle','sweep','release'] as const)expect(gridActionAllowed(action,c)).toBe(false);
  for(const action of ['cancel','close','claim','settle'] as const)expect(gridActionAllowed(action,c)).toBe(true);
  expect(gridActionAllowed('claim',{...c,scopeAndConsent:false})).toBe(false);
  expect(gridActionAllowed('close',{...c,executionMode:'legacy'})).toBe(false);
  expect(gridActionAllowed('close',{...c,runMode:'test'})).toBe(false);
  expect(gridActionAllowed('close',{...c,authorityValid:false})).toBe(false);
});
it('binds every consent field and rejects malformed or overlong windows',()=>{
  const key=randomBytes(32),requestKey=createHash('sha256').update('EXAMPLE').digest('hex');
  const c:ProtectiveConsent={version:'1',action:'protective_close',owner:'EXAMPLE',botId:randomUUID(),walletGeneration:'0',scopeRevision:'1',requestKey,issuedAt:'2026-10-25T00:00:00.000Z',expiresAt:'2026-10-25T00:10:00.000Z'};
  try{
    const consentMacDigest=protectiveConsentMac(c,key);
    for(const change of [{owner:'EXAMPLE_OTHER'},{botId:randomUUID()},{walletGeneration:'1'},{scopeRevision:'2'},{requestKey:createHash('sha256').update('EXAMPLE_OTHER').digest('hex')},{expiresAt:'2026-10-25T00:09:00.000Z'}])expect(protectiveConsentMac({...c,...change},key)).not.toBe(consentMacDigest);
    expect(()=>encodeProtectiveConsent({...c,expiresAt:'2026-10-25T00:10:00.001Z'})).toThrow();
    expect(()=>encodeProtectiveConsent({...c,issuedAt:c.expiresAt})).toThrow();
    expect(()=>encodeProtectiveConsent({...c,action:'start'} as unknown as ProtectiveConsent)).toThrow();
  }finally{key.fill(0);}
});
