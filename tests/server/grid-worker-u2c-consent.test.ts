import {describe,expect,it} from 'vitest';
import {createHmac,randomUUID} from 'node:crypto';
import {deriveSubkey,SUBKEY_PURPOSES,zeroizeBuffer} from '../../server/crypto-v3';
import {encodeStartConsent,startConsentMac,verifyStartConsentMac,START_CONSENT_PURPOSE,type StartConsent} from '../../server/grid-worker/consent';

const sha256='0'.repeat(64);
const fixture=():StartConsent=>({version:'1',action:'start',owner:'EXAMPLE',botId:randomUUID(),draftRevision:'EXAMPLE revision',
  serverIntentDigest:sha256,policyHmac:sha256,spendingPolicyDigest:sha256,walletGeneration:'0',scopeRevision:'1',consentVersion:'1',
  requestKey:'EXAMPLE',issuedAt:'2026-10-24T00:00:00.000Z',expiresAt:'2026-10-24T00:10:00.000Z'});
describe('U2c Start consent MAC and canonical wire',()=>{
  it('separates the purpose from every existing signing purpose',()=>{
    expect(Object.values(SUBKEY_PURPOSES)).not.toContain(START_CONSENT_PURPOSE);
  });
  it('matches an independent fixed-order encoder and SHA-256 HMAC',()=>{
    const c=fixture(),umk=Buffer.alloc(32,7),key=deriveSubkey(umk,'grid_start_consent_v1');
    try{
      const wire=JSON.stringify([['version',c.version],['action',c.action],['owner',c.owner],['botId',c.botId],['draftRevision',c.draftRevision],
        ['serverIntentDigest',c.serverIntentDigest],['policyHmac',c.policyHmac],['spendingPolicyDigest',c.spendingPolicyDigest],
        ['walletGeneration',c.walletGeneration],['scopeRevision',c.scopeRevision],['consentVersion',c.consentVersion],
        ['requestKey',c.requestKey],['issuedAt',c.issuedAt],['expiresAt',c.expiresAt]]);
      expect(encodeStartConsent(c)).toBe(wire);
      expect(startConsentMac(c,umk)).toBe(createHmac('sha256',key).update(wire).digest('hex'));
      expect(verifyStartConsentMac(c,startConsentMac(c,umk),umk)).toBe(true);
      for(const field of Object.keys(c) as (keyof StartConsent)[]){
        const changed={...c,[field]:c[field]+'x'};
        let accepted=false;try{accepted=verifyStartConsentMac(changed,startConsentMac(c,umk),umk);}catch{}
        expect(accepted,field).toBe(false);
      }
    }finally{zeroizeBuffer(key);zeroizeBuffer(umk);}
  });
  it.each(['','EXAMPLE','0'.repeat(63),'0'.repeat(65),'A'.repeat(64)])('refuses malformed MAC %s',mac=>{
    expect(verifyStartConsentMac(fixture(),mac,Buffer.alloc(32,7))).toBe(false);
  });
  it('refuses extra fields, noncanonical integers, digest case, and a lifetime over ten minutes',()=>{
    const c=fixture();
    for(const patch of [{unexpected:'EXAMPLE'},{walletGeneration:'00'},{scopeRevision:'0'},{policyHmac:'A'.repeat(64)},
      {issuedAt:'2026-10-24T00:00:00Z'},{expiresAt:'2026-10-24T00:10:00.001Z'},{expiresAt:c.issuedAt}]){
      expect(()=>encodeStartConsent({...c,...patch})).toThrow('GRID_CONSENT_CANONICAL');
    }
  });
});
