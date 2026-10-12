import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

/** Deployment-reviewed accounts, NEVER copied from build-register-ixs or user input.
 * No production pin is installed by U03. Eligibility/account-owner proof is a canary prerequisite.
 */
export interface PhoenixRegistrationPin {
  onboarder: string;
  permissionAccount: string;
  globalTraderIndex: string[];
  activeTraderBuffer: string[];
}
export interface RegistrationInstruction {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: number[];
}
const program = PHOENIX_PUBLIC_ADDRESSES.program;
const logAuthority = 'GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS';
const globalConfiguration = '2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ';
const discriminator = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });

/** Byte/account order port of Rise 0.6.1 RegisterTrader and OnboardTraderDelegated.
 * Only these two instructions are admitted; no transfers, compute fees, lookups or extra signers.
 * The payer is the bot authority, so its signature is known BEFORE onboarder submission.
 */
export function expectedRegistration(identity: PhoenixTraderIdentity, pin: PhoenixRegistrationPin, maxPositions: number): RegistrationInstruction[] {
  assertPhoenixIdentity(identity);
  if (!Number.isInteger(maxPositions) || maxPositions < 32 || maxPositions > 128) throw new Error('Invalid max positions');
  if (!pin.globalTraderIndex.length || !pin.activeTraderBuffer.length) throw new Error('Missing Phoenix arena pin');
  const pinned = [pin.onboarder, pin.permissionAccount, ...pin.globalTraderIndex, ...pin.activeTraderBuffer];
  const reserved = [program, logAuthority, globalConfiguration, SystemProgram.programId.toBase58(), identity.authorityWalletAddress, identity.traderAccountAddress];
  if (new Set([...pinned, ...reserved]).size !== pinned.length + reserved.length) throw new Error('Phoenix account alias');
  for (const address of pinned) if (new PublicKey(address).toBase58() !== address) throw new Error('Noncanonical pin');
  if (!PublicKey.isOnCurve(new PublicKey(pin.onboarder).toBytes())) throw new Error('Invalid onboarder signer');
  const register = Buffer.alloc(18);
  discriminator('register_trader').copy(register);
  register.writeUInt32LE(maxPositions, 8); // preference bits=0, portfolio=0, subaccount=0
  const onboard = Buffer.alloc(24);
  discriminator('set_trader_capabilities_delegated').copy(onboard);
  onboard.writeUInt32LE(6, 8);
  [0, 1, 3, 2, 4, 5].forEach((target, index) => { onboard[12 + index * 2] = target; onboard[13 + index * 2] = 1; });
  const common = [meta(program), meta(logAuthority), meta(globalConfiguration)];
  return [
    { programId: program, keys: [...common, meta(identity.authorityWalletAddress, true, true), meta(identity.authorityWalletAddress), meta(identity.traderAccountAddress, true), meta(SystemProgram.programId.toBase58())], data: [...register] },
    { programId: program, keys: [...common, meta(pin.onboarder, false, true), meta(pin.permissionAccount, true), meta(identity.traderAccountAddress, true), ...pin.globalTraderIndex.map(a => meta(a, true)), ...pin.activeTraderBuffer.map(a => meta(a, true))], data: [...onboard] },
  ];
}

export function validateRegistrationInstructions(input: unknown, identity: PhoenixTraderIdentity, pin: PhoenixRegistrationPin, maxPositions: number): TransactionInstruction[] {
  const expected = expectedRegistration(identity, pin, maxPositions);
  if (!Array.isArray(input) || input.length !== expected.length) throw new Error('Unexpected registration instructions');
  return expected.map((ix, index) => {
    const actual = input[index];
    if (!actual || actual.programId !== ix.programId || !Array.isArray(actual.keys) || !Array.isArray(actual.data)
      || actual.keys.length !== ix.keys.length || actual.data.length !== ix.data.length
      || actual.data.some((byte: unknown, i: number) => byte !== ix.data[i])
      || actual.keys.some((key: any, i: number) => !key || key.pubkey !== ix.keys[i].pubkey
        || key.isSigner !== ix.keys[i].isSigner || key.isWritable !== ix.keys[i].isWritable)) {
      throw new Error('Untrusted Phoenix registration instruction');
    }
    return new TransactionInstruction({ programId: new PublicKey(ix.programId), data: Buffer.from(ix.data),
      keys: ix.keys.map(key => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })) });
  });
}

export function prepareRegistration(input: unknown, identity: PhoenixTraderIdentity, pin: PhoenixRegistrationPin,
  maxPositions: number, lifetime: { blockhash: string; lastValidBlockHeight: number }): Transaction {
  if (new PublicKey(lifetime.blockhash).toBase58() !== lifetime.blockhash || !Number.isSafeInteger(lifetime.lastValidBlockHeight)
    || lifetime.lastValidBlockHeight < 1) throw new Error('Invalid registration lifetime');
  return new Transaction({ feePayer: new PublicKey(identity.authorityWalletAddress), ...lifetime })
    .add(...validateRegistrationInstructions(input, identity, pin, maxPositions));
}

/** Synchronous signing window. Caller owns key cleanup; no key survives into API/RPC awaits. */
export function signRegistration(transaction: Transaction, identity: PhoenixTraderIdentity, pin: PhoenixRegistrationPin,
  maxPositions: number, secretKey: Uint8Array) {
  if (transaction.feePayer?.toBase58() !== identity.authorityWalletAddress || transaction.nonceInfo) throw new Error('Wrong Phoenix fee payer');
  const clean = prepareRegistration(transaction.instructions.map(ix => ({ programId: ix.programId.toBase58(),
    keys: ix.keys.map(key => ({ ...key, pubkey: key.pubkey.toBase58() })), data: [...ix.data] })), identity, pin, maxPositions,
  { blockhash: transaction.recentBlockhash!, lastValidBlockHeight: transaction.lastValidBlockHeight! });
  if (secretKey.length !== 64 || new PublicKey(secretKey.subarray(32)).toBase58() !== identity.authorityWalletAddress) throw new Error('Missing Phoenix fee payer signer');
  clean.addSignature(new PublicKey(identity.authorityWalletAddress), Buffer.from(nacl.sign.detached(clean.serializeMessage(), secretKey)));
  if (!clean.verifySignatures(false) || clean.signatures.length !== 2
    || clean.signatures[0].publicKey.toBase58() !== identity.authorityWalletAddress
    || clean.signatures[1].publicKey.toBase58() !== pin.onboarder || clean.signatures[1].signature !== null) throw new Error('Unexpected signer set');
  const wire = clean.serialize({ requireAllSignatures: false, verifySignatures: true });
  return { transaction: wire.toString('base64'), signature: bs58.encode(clean.signatures[0].signature!),
    blockhash: clean.recentBlockhash!, lastValidBlockHeight: String(clean.lastValidBlockHeight),
    transactionHash: createHash('sha256').update(clean.serializeMessage()).digest('hex') };
}
