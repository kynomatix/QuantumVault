import { createHash } from 'node:crypto';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { expectedRegistration, validateRegistrationInstructions, PHOENIX_REGISTRATION_ACCOUNTS, type PhoenixRegistrationPin } from './registration';
import { PHOENIX_PUBLIC_API } from './sdk-boundary';
import { readPhoenixReferralConfig, type PhoenixReferralConfig } from './referral-config';

// Independently reviewed referral roles, never aliases of the legacy onboarder pin.
export const PHOENIX_REFERRAL_DEPLOYMENT = Object.freeze({
  onboarder: 'EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z',
  riskAuthority: '8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR',
  permissionAccount: '6UCimUpRW2CGh3ESJm3S59c4WcCaVLYcpPPbbrfX2nzr',
});
export interface PhoenixReferralPin extends PhoenixRegistrationPin { riskAuthority: string; deploymentPinSha256: string }
export type ReferralTraderState = 'missing' | 'inactive' | 'ready' | 'unknown';
export interface ReferralTraderEvidence {
  state: ReferralTraderState; identityHash: string; observedAt: number; accountSha256?: string;
}
export interface ReferralBinding {
  route: 'referral'; referralCodeSha256: string; deploymentPinSha256: string; identityHash: string;
  expectedState: 'missing' | 'inactive'; maxPositions: number;
  signature: string; blockhash: string; lastValidBlockHeight: string; transactionHash: string;
}
export interface ObservedRegistrationEvidence extends ReferralTraderEvidence { state: 'ready'; source: 'phoenix-finalized-rpc'; accountSha256: string }
export const referralIdentityHash = (identity: PhoenixTraderIdentity) => {
  assertPhoenixIdentity(identity);
  return createHash('sha256').update(JSON.stringify([identity.authorityWalletAddress, identity.traderAccountAddress,
    identity.programAddress, identity.network, identity.portfolioIndex, identity.subaccountIndex])).digest('hex');
};

export function phoenixReferralPin(registration: PhoenixRegistrationPin): PhoenixReferralPin {
  const accounts = { ...PHOENIX_REGISTRATION_ACCOUNTS, ...PHOENIX_REFERRAL_DEPLOYMENT,
    globalTraderIndex: [...registration.globalTraderIndex], activeTraderBuffer: [...registration.activeTraderBuffer] };
  const values = [accounts.program, accounts.logAuthority, accounts.globalConfiguration, accounts.onboarder,
    accounts.permissionAccount, accounts.riskAuthority, ...accounts.globalTraderIndex, ...accounts.activeTraderBuffer];
  if (!accounts.globalTraderIndex.length || !accounts.activeTraderBuffer.length || values.length > 240
    || new Set(values).size !== values.length) throw new Error('Phoenix referral account alias');
  for (const address of values) if (new PublicKey(address).toBase58() !== address) throw new Error('Phoenix referral pin invalid');
  Object.freeze(accounts.globalTraderIndex); Object.freeze(accounts.activeTraderBuffer);
  return Object.freeze({ onboarder: accounts.onboarder, permissionAccount: accounts.permissionAccount, riskAuthority: accounts.riskAuthority,
    globalTraderIndex: accounts.globalTraderIndex, activeTraderBuffer: accounts.activeTraderBuffer,
    deploymentPinSha256: createHash('sha256').update(JSON.stringify([PHOENIX_PUBLIC_API, accounts])).digest('hex') });
}

function assertReferralPin(pin: PhoenixReferralPin) {
  const expected = phoenixReferralPin(pin);
  if (pin.onboarder !== expected.onboarder || pin.permissionAccount !== expected.permissionAccount
    || pin.riskAuthority !== expected.riskAuthority || pin.deploymentPinSha256 !== expected.deploymentPinSha256) {
    throw new Error('Phoenix referral pin changed');
  }
}

export function validateReferralDeployment(permission: any, exchange: any, pin: PhoenixReferralPin) {
  assertReferralPin(pin);
  const keys = exchange?.keys;
  if (permission?.trader_onboarder !== pin.onboarder || permission?.risk_authority !== pin.riskAuthority
    || permission?.permission_account !== pin.permissionAccount || keys?.globalConfig !== PHOENIX_REGISTRATION_ACCOUNTS.globalConfiguration
    || keys?.currentAuthorities?.riskAuthority !== pin.riskAuthority
    || JSON.stringify(keys?.globalTraderIndex) !== JSON.stringify(pin.globalTraderIndex)
    || JSON.stringify(keys?.activeTraderBuffer) !== JSON.stringify(pin.activeTraderBuffer)) throw new Error('Phoenix referral deployment mismatch');
}

export function prepareReferralActivation(identity: PhoenixTraderIdentity, pin: PhoenixReferralPin, maxPositions: number,
  state: 'missing' | 'inactive', lifetime: { blockhash: string; lastValidBlockHeight: number }): VersionedTransaction {
  assertReferralPin(pin);
  if (!['missing', 'inactive'].includes(state) || new PublicKey(lifetime.blockhash).toBase58() !== lifetime.blockhash
    || !Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 1) throw new Error('Invalid referral lifetime/state');
  // Keep the legacy validator restricted to its original two instructions.
  const instructions = validateRegistrationInstructions(expectedRegistration(identity, pin, maxPositions), identity, pin, maxPositions);
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(identity.authorityWalletAddress),
    recentBlockhash: lifetime.blockhash, instructions: state === 'missing' ? instructions : instructions.slice(1) }).compileToV0Message());
}

export function validateReferralTransaction(transaction: VersionedTransaction, identity: PhoenixTraderIdentity,
  pin: PhoenixReferralPin, maxPositions: number, state: 'missing' | 'inactive', lifetime: { blockhash: string; lastValidBlockHeight: number }) {
  const clean = prepareReferralActivation(identity, pin, maxPositions, state, lifetime);
  if (transaction.version !== 0 || transaction.message.addressTableLookups.length !== 0
    || !Buffer.from(transaction.message.serialize()).equals(Buffer.from(clean.message.serialize()))
    || transaction.signatures.length !== 2 || transaction.message.header.numRequiredSignatures !== 2
    || transaction.message.staticAccountKeys[0].toBase58() !== identity.authorityWalletAddress
    || transaction.message.staticAccountKeys[1].toBase58() !== pin.onboarder
    || transaction.signatures[1].some(byte => byte !== 0)) throw new Error('Untrusted Phoenix referral transaction');
  return clean;
}

export function signReferralActivation(transaction: VersionedTransaction, identity: PhoenixTraderIdentity, pin: PhoenixReferralPin,
  maxPositions: number, state: 'missing' | 'inactive', lifetime: { blockhash: string; lastValidBlockHeight: number }, secret: Uint8Array) {
  const clean = validateReferralTransaction(transaction, identity, pin, maxPositions, state, lifetime);
  if (transaction.signatures[0].some(byte => byte !== 0) || secret.length !== 64
    || new PublicKey(secret.subarray(32)).toBase58() !== identity.authorityWalletAddress) throw new Error('Phoenix referral signer mismatch');
  clean.signatures[0] = nacl.sign.detached(clean.message.serialize(), secret);
  return { transaction: Buffer.from(clean.serialize()).toString('base64'), signature: bs58.encode(clean.signatures[0]),
    blockhash: lifetime.blockhash, lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    transactionHash: createHash('sha256').update(clean.message.serialize()).digest('hex') };
}

export function referralActivationRequest(signed: ReturnType<typeof signReferralActivation>, binding: ReferralBinding,
  identity: PhoenixTraderIdentity, pin: PhoenixReferralPin, config: PhoenixReferralConfig) {
  const checked = readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: config.state === 'enabled' ? config.code : undefined });
  if (binding.route !== 'referral' || config.state !== 'enabled' || checked.state !== 'enabled'
    || checked.referralCodeSha256 !== config.referralCodeSha256 || config.referralCodeSha256 !== binding.referralCodeSha256
    || pin.deploymentPinSha256 !== binding.deploymentPinSha256 || binding.identityHash !== referralIdentityHash(identity)) throw new Error('Phoenix referral binding changed');
  const wire = Buffer.from(signed.transaction, 'base64');
  const transaction = VersionedTransaction.deserialize(wire);
  if (wire.toString('base64') !== signed.transaction || !wire.equals(Buffer.from(transaction.serialize()))) throw new Error('Phoenix referral wire changed');
  validateReferralTransaction(transaction, identity, pin, binding.maxPositions, binding.expectedState,
    { blockhash: binding.blockhash, lastValidBlockHeight: Number(binding.lastValidBlockHeight) });
  if (signed.transactionHash !== binding.transactionHash || signed.signature !== binding.signature
    || signed.blockhash !== binding.blockhash || signed.lastValidBlockHeight !== binding.lastValidBlockHeight
    || createHash('sha256').update(transaction.message.serialize()).digest('hex') !== binding.transactionHash
    || bs58.encode(transaction.signatures[0]) !== binding.signature
    || !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], new PublicKey(identity.authorityWalletAddress).toBytes())) {
    throw new Error('Phoenix referral signed bytes changed');
  }
  return { referral_code: config.code, trader_authority: identity.authorityWalletAddress,
    trader_pda_index: 0, trader_subaccount_index: 0, recent_blockhash: binding.blockhash, transaction: signed.transaction };
}

export function validateReferralResponse(value: any, binding: ReferralBinding, identity: PhoenixTraderIdentity, code: string) {
  if (!value || value.trader_pda !== identity.traderAccountAddress || value.referral_code !== code
    || !['activated', 'submitted', 'already_activated'].includes(value.status)
    || (value.signature !== undefined && value.signature !== binding.signature)) throw new Error('Phoenix referral receipt mismatch');
  // Even a matching signature is only a hint; all completion goes through finalized RPC.
  return { status: value.status as 'activated' | 'submitted' | 'already_activated' };
}
