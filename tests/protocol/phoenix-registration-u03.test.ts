import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { deriveBotSecretKeyFromAgentSeed } from '../../server/bot-derived-secret';
import { prepareRegistration, signRegistration, validateRegistrationInstructions } from '../../server/protocol/phoenix/registration';
import { authority, identity, instructions, key, lifetime, onboarder, pin } from '../helpers/phoenix-registration';

describe('U03 fail-closed registration signer', () => {
  it('produces a payer signature before the onboarder co-sign and keeps the same transaction id', () => {
    const tx = prepareRegistration(instructions(), identity, pin, 32, lifetime);
    const secret = authority.secretKey;
    const signed = signRegistration(tx, identity, pin, 32, secret);
    secret.fill(0);
    const wire = Transaction.from(Buffer.from(signed.transaction, 'base64'));
    expect(wire.verifySignatures(false)).toBe(true);
    expect(wire.verifySignatures(true)).toBe(false);
    expect(wire.signatures.map(s => s.publicKey.toBase58())).toEqual([identity.authorityWalletAddress, pin.onboarder]);
    wire.partialSign(onboarder);
    expect(wire.verifySignatures(true)).toBe(true);
    expect(bs58.encode(wire.signature!)).toBe(signed.signature);
    expect(wire.feePayer?.toBase58()).toBe(identity.authorityWalletAddress);
  });
  const mutations: [string, (ix: ReturnType<typeof instructions>) => void][] = [];
  instructions().forEach((ix, i) => {
    mutations.push([`program ${i}`, x => { x[i].programId = SystemProgram.programId.toBase58(); }]);
    ix.keys.forEach((_, k) => {
      mutations.push([`account ${i}/${k}`, x => { x[i].keys[k].pubkey = key(20).publicKey.toBase58(); }],
        [`signer ${i}/${k}`, x => { x[i].keys[k].isSigner = !x[i].keys[k].isSigner; }],
        [`writable ${i}/${k}`, x => { x[i].keys[k].isWritable = !x[i].keys[k].isWritable; }]);
    });
    ix.data.forEach((_, b) => mutations.push([`data ${i}/${b}`, x => { x[i].data[b] ^= 1; }]));
  });
  it.each(mutations)('rejects a server mutation to %s', (_, mutate) => {
    const response = instructions(); mutate(response);
    expect(() => validateRegistrationInstructions(response, identity, pin, 32)).toThrow();
  });
  it.each(['extra', 'missing', 'reverse', 'extra-account', 'extra-data'])('rejects %s instructions/accounts/data', mode => {
    const response = instructions();
    if (mode === 'extra') response.push(response[0]);
    if (mode === 'missing') response.pop();
    if (mode === 'reverse') response.reverse();
    if (mode === 'extra-account') response[0].keys.push(response[0].keys[0]);
    if (mode === 'extra-data') response[0].data.push(0);
    expect(() => prepareRegistration(response, identity, pin, 32, lifetime)).toThrow();
  });
  it('revalidates at the signing boundary, including payer, amounts, and secret identity', () => {
    const tx = prepareRegistration(instructions(), identity, pin, 32, lifetime);
    tx.feePayer = new PublicKey(pin.onboarder);
    expect(() => signRegistration(tx, identity, pin, 32, authority.secretKey)).toThrow();
    tx.feePayer = authority.publicKey;
    expect(() => signRegistration(tx, identity, pin, 32, onboarder.secretKey)).toThrow();
    tx.instructions[0].data[8] = 128;
    expect(() => signRegistration(tx, identity, pin, 32, authority.secretKey)).toThrow();
  });
  it('rejects aliasing trusted accounts and invalid lifetimes', () => {
    expect(() => prepareRegistration(instructions(), identity, { ...pin, onboarder: identity.authorityWalletAddress }, 32, lifetime)).toThrow();
    expect(() => prepareRegistration(instructions(), identity, pin, 32, { ...lifetime, lastValidBlockHeight: NaN })).toThrow();
  });
});

describe('U03 controlled derivation preserves version-1 bot paths', () => {
  it.each([1, 2, 2147483647])('matches the incumbent derivation for index %s and returns a clearable owned buffer', index => {
    const mnemonic = Buffer.from(bip39.entropyToMnemonic(Buffer.alloc(16, 7)));
    const seed = bip39.mnemonicToSeedSync(mnemonic.toString());
    const derived = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex')).key;
    const secret = deriveBotSecretKeyFromAgentSeed(mnemonic, index, 1);
    expect(Buffer.from(secret.subarray(0, 32))).toEqual(derived);
    expect(new PublicKey(secret.subarray(32)).toBase58()).not.toBe(identity.authorityWalletAddress);
    secret.fill(0); seed.fill(0); derived.fill(0); mnemonic.fill(0);
    expect(secret.every(byte => byte === 0)).toBe(true);
  });
  it.each([0, -1, 1.5, 2147483648, NaN])('rejects invalid index %s', index => {
    expect(() => deriveBotSecretKeyFromAgentSeed(Buffer.from('EXAMPLE-invalid'), index)).toThrow();
  });
  it('rejects a different derivation version and invalid mnemonic', () => {
    expect(() => deriveBotSecretKeyFromAgentSeed(Buffer.from('EXAMPLE-invalid'), 1, 2)).toThrow();
    expect(() => deriveBotSecretKeyFromAgentSeed(Buffer.from('EXAMPLE-invalid'), 1, 1)).toThrow();
  });
});
