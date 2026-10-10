import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from './sdk-boundary';
import { validateFundingIntent, units, type FundingIntent } from './funding-contract';

/** Reviewed deployment accounts, not user/API input. No production pin is installed. */
export interface PhoenixFundingPin {
  logAuthority: string; globalConfiguration: string; globalVault: string;
  perpAssetMap: string; withdrawQueue: string; emberState: string; emberVault: string;
  globalTraderIndex: string[]; activeTraderBuffer: string[];
}
const pk = (value: string) => new PublicKey(value);
const meta = (value: string, isWritable = false, isSigner = false) => ({ pubkey: pk(value), isWritable, isSigner });
// Single-owner SPL Token layouts; compare against the official library in U04 tests.
const ata = (owner: string, mint: string) => {
  if (!PublicKey.isOnCurve(pk(owner).toBuffer())) throw new Error('Funding owner must be on curve');
  return PublicKey.findProgramAddressSync([pk(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), pk(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
};
const tokenData = (opcode: number, amount: string, decimals?: number) => {
  const bytes = Buffer.alloc(decimals === undefined ? 9 : 10);
  bytes[0] = opcode; bytes.writeBigUInt64LE(units(amount), 1);
  if (decimals !== undefined) bytes[9] = decimals;
  return bytes;
};
const data = (name: string, amount: string, optional = false) => {
  const buffer = Buffer.alloc(optional ? 17 : 16);
  createHash('sha256').update(`global:${name}`).digest().copy(buffer, 0, 0, 8);
  if (optional) buffer[8] = 1;
  buffer.writeBigUInt64LE(units(amount), optional ? 9 : 8); return buffer;
};

/** Rise 0.6.1 byte/account port. Each returned array is ONE atomic transaction.
 * Withdrawal deliberately requests canonical collateral only; unwrap is a separate,
 * parent-bound operation AFTER queue release. An ATA already existing is safe.
 */
export function fundingInstructions(intent: FundingIntent, pin: PhoenixFundingPin): TransactionInstruction[] {
  validateFundingIntent(intent);
  const a = intent.identity.authorityWalletAddress, trader = intent.identity.traderAccountAddress;
  const t = intent.funding, amount = t.grossBaseUnits;
  const token = TOKEN_PROGRAM_ID.toBase58();
  const publicPins = [pin.logAuthority, pin.globalConfiguration, pin.globalVault, pin.perpAssetMap,
    pin.withdrawQueue, pin.emberState, pin.emberVault, ...pin.globalTraderIndex, ...pin.activeTraderBuffer];
  const reserved = [a, trader, ...Object.values(addresses), token, SystemProgram.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()];
  if (!pin.globalTraderIndex.length || !pin.activeTraderBuffer.length
    || new Set([...publicPins, ...reserved]).size !== publicPins.length + reserved.length) throw new Error('Invalid funding account pin');
  for (const address of publicPins) if (pk(address).toBase58() !== address) throw new Error('Invalid funding pin address');
  const usdc = ata(a, addresses.usdcMint), collateral = ata(a, addresses.collateralMint);
  const create = (owner: string, mint: string, payer = a) => new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID, data: Buffer.from([1]), keys: [meta(payer, true, true),
      meta(ata(owner, mint).toBase58(), true), meta(owner), meta(mint), meta(SystemProgram.programId.toBase58()), meta(token)] });
  if (t.leg === 'wallet_funding' || t.leg === 'wallet_return') {
    return [create(intent.destination, addresses.usdcMint, t.sourceWallet),
      new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data: tokenData(12, amount, 6), keys: [
        meta(ata(t.sourceWallet, addresses.usdcMint).toBase58(), true), meta(addresses.usdcMint),
        meta(ata(intent.destination, addresses.usdcMint).toBase58(), true), meta(t.sourceWallet, false, true)] })];
  }
  const emberKeys = [meta(a, false, true), meta(pin.emberState), meta(addresses.usdcMint), meta(addresses.collateralMint, true),
    meta(usdc.toBase58(), true), meta(collateral.toBase58(), true), meta(pin.emberVault, true), meta(token)];
  const common = [meta(addresses.program), meta(pin.logAuthority), meta(pin.globalConfiguration, true), meta(a, false, true)];
  const arenas = [...pin.globalTraderIndex, ...pin.activeTraderBuffer].map(value => meta(value, true));
  if (t.leg === 'deposit') return [create(a, addresses.collateralMint),
    new TransactionInstruction({ programId: pk(addresses.emberProgram), keys: emberKeys, data: data('deposit', amount) }),
    new TransactionInstruction({ programId: pk(addresses.program), data: data('deposit_funds', amount),
      keys: [...common, meta(collateral.toBase58(), true), meta(trader, true), meta(pin.globalVault, true), meta(token), ...arenas] })];
  if (t.leg === 'withdraw') return [create(a, addresses.collateralMint),
    new TransactionInstruction({ programId: pk(addresses.program), data: data('withdraw_funds', amount), keys: [...common,
      meta(trader, true), meta(pin.perpAssetMap, true), meta(pin.globalVault, true), meta(collateral.toBase58(), true), meta(token), ...arenas, meta(pin.withdrawQueue, true)] })];
  return [create(a, addresses.usdcMint), new TransactionInstruction({ programId: TOKEN_PROGRAM_ID,
    data: tokenData(4, amount), keys: [meta(collateral.toBase58(), true), meta(pin.emberState), meta(a, false, true)] }),
    new TransactionInstruction({ programId: pk(addresses.emberProgram), keys: emberKeys, data: data('withdraw', amount, true) })];
}

export function prepareFundingTransaction(intent: FundingIntent, pin: PhoenixFundingPin,
  lifetime: { blockhash: string; lastValidBlockHeight: number }) {
  if (pk(lifetime.blockhash).toBase58() !== lifetime.blockhash || !Number.isSafeInteger(lifetime.lastValidBlockHeight)
    || lifetime.lastValidBlockHeight < 1) throw new Error('Invalid funding lifetime');
  return new Transaction({ feePayer: pk(intent.funding.sourceWallet), ...lifetime }).add(...fundingInstructions(intent, pin));
}

/** Rebuild at the signing boundary; neither simulation nor API can add instructions. */
export function signFundingTransaction(transaction: Transaction, intent: FundingIntent, pin: PhoenixFundingPin, secret: Uint8Array) {
  const clean = prepareFundingTransaction(intent, pin, { blockhash: transaction.recentBlockhash!, lastValidBlockHeight: transaction.lastValidBlockHeight! });
  if (transaction.nonceInfo || !clean.serializeMessage().equals(transaction.serializeMessage())
    || secret.length !== 64 || pk(intent.funding.sourceWallet).toBase58() !== new PublicKey(secret.subarray(32)).toBase58()) throw new Error('Funding signer or message mismatch');
  clean.addSignature(pk(intent.funding.sourceWallet), Buffer.from(nacl.sign.detached(clean.serializeMessage(), secret)));
  if (!clean.verifySignatures() || clean.signatures.length !== 1) throw new Error('Invalid funding signer set');
  return { transaction: clean.serialize().toString('base64'), signature: bs58.encode(clean.signature!),
    blockhash: clean.recentBlockhash!, lastValidBlockHeight: String(clean.lastValidBlockHeight),
    transactionHash: createHash('sha256').update(clean.serializeMessage()).digest('hex') };
}
