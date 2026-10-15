import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PHOENIX_REGISTRATION_ACCOUNTS } from '../../server/protocol/phoenix/registration';
import { phoenixReferralPin, prepareReferralActivation, validateReferralTransaction, signReferralActivation,
  referralActivationRequest, validateReferralResponse, validateReferralDeployment, referralIdentityHash,
  type ReferralBinding } from '../../server/protocol/phoenix/referral-activation';
import { readPhoenixReferralConfig } from '../../server/protocol/phoenix/referral-config';
import { authority, identity, key, lifetime, pin } from '../helpers/phoenix-registration';

const referralPin = phoenixReferralPin(pin);
const config = readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: 'EXAMPLE-Referral' });
// Independent static layout from pinned RegisterTrader/OnboardTraderDelegated codecs and invite builder.
function fixture(state: 'missing' | 'inactive', maxPositions = 32) {
  const { program, logAuthority, globalConfiguration } = PHOENIX_REGISTRATION_ACCOUNTS;
  const meta = (address: string, isWritable = false, isSigner = false) => ({ pubkey: new PublicKey(address), isWritable, isSigner });
  const common = [meta(program), meta(logAuthority), meta(globalConfiguration)];
  const register = Buffer.alloc(18);
  createHash('sha256').update('global:register_trader').digest().copy(register, 0, 0, 8);
  register.writeUInt32LE(maxPositions, 8);
  const onboard = Buffer.alloc(24);
  createHash('sha256').update('global:set_trader_capabilities_delegated').digest().copy(onboard, 0, 0, 8);
  onboard.writeUInt32LE(6, 8);
  Buffer.from([0,1,1,1,3,1,2,1,4,1,5,1]).copy(onboard, 12);
  const instructions = [
    new TransactionInstruction({ programId: new PublicKey(program), data: register, keys: [...common,
      meta(identity.authorityWalletAddress, true, true), meta(identity.authorityWalletAddress), meta(identity.traderAccountAddress, true), meta(SystemProgram.programId.toBase58())] }),
    new TransactionInstruction({ programId: new PublicKey(program), data: onboard, keys: [...common,
      meta(referralPin.onboarder, false, true), meta(referralPin.permissionAccount, true), meta(identity.traderAccountAddress, true),
      ...referralPin.globalTraderIndex.map(a => meta(a, true)), ...referralPin.activeTraderBuffer.map(a => meta(a, true))] }),
  ];
  return new TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: lifetime.blockhash,
    instructions: state === 'missing' ? instructions : instructions.slice(1) });
}
function signedFixture(state: 'missing' | 'inactive' = 'missing') {
  if (config.state !== 'enabled') throw new Error('EXAMPLE-config');
  const exampleSigningBytes = authority.secretKey;
  let signed: ReturnType<typeof signReferralActivation>;
  try { signed = signReferralActivation(prepareReferralActivation(identity, referralPin, 32, state, lifetime), identity, referralPin, 32, state, lifetime, exampleSigningBytes); }
  finally { exampleSigningBytes.fill(0); }
  const binding: ReferralBinding = { route: 'referral', expectedState: state, maxPositions: 32, identityHash: referralIdentityHash(identity),
    referralCodeSha256: config.referralCodeSha256, deploymentPinSha256: referralPin.deploymentPinSha256,
    signature: signed.signature, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight, transactionHash: signed.transactionHash };
  return { signed, binding };
}

describe('Phoenix exact-pin referral v0 wire', () => {
  it.each(['missing', 'inactive'] as const)('matches independent %s bytes, payer and exact signer pair', state => {
    for (const max of [32,128]) {
      const tx = prepareReferralActivation(identity, referralPin, max, state, lifetime);
      expect(Buffer.from(tx.message.serialize())).toEqual(Buffer.from(fixture(state, max).compileToV0Message().serialize()));
      expect(tx.message.header.numRequiredSignatures).toBe(2);
      expect(tx.message.staticAccountKeys.slice(0,2).map(k => k.toBase58())).toEqual([identity.authorityWalletAddress, referralPin.onboarder]);
      expect(tx.message.compiledInstructions).toHaveLength(state === 'missing' ? 2 : 1);
      expect(tx.signatures.every(s => s.every(b => b === 0))).toBe(true);
      const { signed, binding } = signedFixture(state);
      expect(referralActivationRequest(signed, binding, identity, referralPin, config)).toEqual({
        referral_code: 'EXAMPLE-Referral', trader_authority: identity.authorityWalletAddress,
        trader_pda_index: 0, trader_subaccount_index: 0, recent_blockhash: lifetime.blockhash, transaction: signed.transaction,
      });
    }
  });
  const mutations: [string, (tx: VersionedTransaction) => void][] = [
    ['payer sponsorship', tx => { tx.message.staticAccountKeys[0] = key(20).publicKey; }],
    ['account order', tx => { [tx.message.staticAccountKeys[2],tx.message.staticAccountKeys[3]] = [tx.message.staticAccountKeys[3],tx.message.staticAccountKeys[2]]; }],
    ['other signer', tx => { tx.message.staticAccountKeys[1] = key(20).publicKey; }],
    ['required signer count', tx => { tx.message.header.numRequiredSignatures++; }],
    ['writable role', tx => { tx.message.header.numReadonlyUnsignedAccounts++; }],
    ['lifetime', tx => { tx.message.recentBlockhash = key(20).publicKey.toBase58(); }],
    ['lookup', tx => { (tx.message as any).addressTableLookups.push({ accountKey: key(20).publicKey, writableIndexes: [0], readonlyIndexes: [] }); }],
    ['extra instruction', tx => { tx.message.compiledInstructions.push(tx.message.compiledInstructions[0]); }],
    ['instruction order', tx => { tx.message.compiledInstructions.reverse(); }],
    ['onboarder pre-signature', tx => { tx.signatures[1][0] = 1; }],
  ];
  const template = prepareReferralActivation(identity, referralPin, 32, 'missing', lifetime);
  template.message.compiledInstructions.forEach((ix, i) => {
    mutations.push([`program index ${i}`, tx => { tx.message.compiledInstructions[i].programIdIndex = 0; }]);
    ix.accountKeyIndexes.forEach((_, a) => mutations.push([`account index ${i}/${a}`, tx => { const indexes = tx.message.compiledInstructions[i].accountKeyIndexes; indexes[a] = (indexes[a] + 1) % tx.message.staticAccountKeys.length; }]));
    ix.data.forEach((_, b) => mutations.push([`instruction data ${i}/${b}`, tx => { tx.message.compiledInstructions[i].data[b] ^= 1; }]));
  });
  it.each(mutations)('refuses %s', (_, mutate) => {
    const tx = prepareReferralActivation(identity, referralPin, 32, 'missing', lifetime); mutate(tx);
    expect(() => validateReferralTransaction(tx, identity, referralPin, 32, 'missing', lifetime)).toThrow();
  });
  it('refuses legacy versions, invalid bounds, aliases and modified independent pins', () => {
    expect(() => validateReferralTransaction(new VersionedTransaction(fixture('missing').compileToLegacyMessage()), identity, referralPin, 32, 'missing', lifetime)).toThrow();
    for (const max of [31,129,32.5]) expect(() => prepareReferralActivation(identity, referralPin, max, 'missing', lifetime)).toThrow();
    for (const height of [0,-1,NaN,Number.MAX_SAFE_INTEGER+1]) expect(() => prepareReferralActivation(identity, referralPin, 32, 'missing', { ...lifetime, lastValidBlockHeight: height })).toThrow();
    expect(() => phoenixReferralPin({ ...pin, activeTraderBuffer: [...pin.globalTraderIndex] })).toThrow();
    expect(() => prepareReferralActivation(identity, { ...referralPin, onboarder: pin.onboarder }, 32, 'missing', lifetime)).toThrow();
  });
  it('rejects presigned payer, wrong secret and signed-byte/binding mutation at POST', () => {
    const tx = prepareReferralActivation(identity, referralPin, 32, 'missing', lifetime); tx.signatures[0][0] = 1;
    expect(() => signReferralActivation(tx, identity, referralPin, 32, 'missing', lifetime, authority.secretKey)).toThrow();
    expect(() => signReferralActivation(template, identity, referralPin, 32, 'missing', lifetime, key(20).secretKey)).toThrow();
    const { signed, binding } = signedFixture();
    const altered = VersionedTransaction.deserialize(Buffer.from(signed.transaction,'base64')); altered.signatures[0][0] ^= 1;
    for (const transaction of [Buffer.from(altered.serialize()).toString('base64'), Buffer.concat([Buffer.from(signed.transaction,'base64'), Buffer.from([0])]).toString('base64')]) {
      expect(() => referralActivationRequest({ ...signed, transaction }, binding, identity, referralPin, config)).toThrow();
    }
    expect(() => referralActivationRequest(signed, binding, identity, referralPin, readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: 'EXAMPLE-rotated' }))).toThrow();
    if (config.state !== 'enabled') throw new Error('EXAMPLE-config');
    expect(() => referralActivationRequest(signed, binding, identity, referralPin, {...config,code:'EXAMPLE-forged'})).toThrow();
    expect(() => referralActivationRequest(signed, { ...binding, lastValidBlockHeight: '101' }, identity, referralPin, config)).toThrow();
  });
  it.each(['activated','submitted','already_activated'])('treats %s with optional signature only as a hint', status => {
    const { binding } = signedFixture();
    const receipt = { status, trader_pda: identity.traderAccountAddress, referral_code: 'EXAMPLE-Referral' };
    expect(validateReferralResponse(receipt, binding, identity, 'EXAMPLE-Referral')).toEqual({ status });
    expect(validateReferralResponse({ ...receipt, signature: binding.signature }, binding, identity, 'EXAMPLE-Referral')).toEqual({ status });
    for (const mismatch of [{ trader_pda: key(20).publicKey.toBase58() }, { referral_code: 'EXAMPLE-other' }, { signature: 'EXAMPLE-other' }, { status: 'success' }, { signature: null }]) {
      expect(() => validateReferralResponse({ ...receipt, ...mismatch }, binding, identity, 'EXAMPLE-Referral')).toThrow();
    }
  });
  it('compares permission, risk authority and ordered exchange arenas against independent pins', () => {
    const permission = { trader_onboarder: referralPin.onboarder, risk_authority: referralPin.riskAuthority, permission_account: referralPin.permissionAccount };
    const exchange = { keys: { globalConfig: PHOENIX_REGISTRATION_ACCOUNTS.globalConfiguration, currentAuthorities: { riskAuthority: referralPin.riskAuthority },
      globalTraderIndex: referralPin.globalTraderIndex, activeTraderBuffer: referralPin.activeTraderBuffer } };
    expect(() => validateReferralDeployment(permission, exchange, referralPin)).not.toThrow();
    for (const field of Object.keys(permission)) expect(() => validateReferralDeployment({ ...permission, [field]: key(20).publicKey.toBase58() }, exchange, referralPin)).toThrow();
    expect(() => validateReferralDeployment(permission, { keys: { ...exchange.keys, globalTraderIndex: [] } }, referralPin)).toThrow();
    expect(Object.isFrozen(referralPin.globalTraderIndex)).toBe(true);
  });
});
