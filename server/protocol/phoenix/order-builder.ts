import { createHash } from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { units } from './funding-contract';
import { admitPhoenixOrder, type PhoenixAdmission, type PhoenixOrderIntent, type PhoenixOrderPacket } from './order-contract';
import { desiredProtection } from './protection-contract';
import { protectionInstruction } from './protection-builder';

/** Reviewed deployment pins. Never accepted from a webhook; no production pin installed. */
export interface PhoenixOrderPin {
  market: string; assetId: number; logAuthority: string; globalConfiguration: string; perpAssetMap: string;
  globalTraderIndex: string[]; activeTraderBuffer: string[]; orderbook: string; splineCollection: string;
}
const u64 = (s: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(units(s)); return b; };
/** Rise 0.6.1 PlaceMarketOrder + ImmediateOrCancelOrderPacket byte layout. */
export function encodePhoenixOrder(p: PhoenixOrderPacket): Buffer {
  const client = BigInt(p.clientOrderId), id = Buffer.alloc(16);
  if (client < 0n || client >= 1n << 128n) throw new Error('Client id overflow');
  id.writeBigUInt64LE(client & ((1n << 64n) - 1n)); id.writeBigUInt64LE(client >> 64n, 8);
  return Buffer.concat([createHash('sha256').update('global:place_market_order').digest().subarray(0, 8),
    Buffer.from([2, p.side === 'buy' ? 0 : 1, 1]), u64(p.priceInTicks), u64(p.numBaseLots), Buffer.from([0]),
    u64(p.minBaseLotsToFill), u64(p.minQuoteLotsToFill), Buffer.from([0, 0]), id,
    Buffer.from([1]), u64(p.lastValidSlot), Buffer.from([p.orderFlags, 0])]);
}
export function validateOrderPin(i: PhoenixOrderIntent, a: PhoenixAdmission, pin: PhoenixOrderPin) {
  if (pin.market !== i.market || pin.assetId !== a.authority.assetId || !pin.globalTraderIndex.length || !pin.activeTraderBuffer.length) throw new Error('Invalid order pin');
  const list = [PHOENIX_PUBLIC_ADDRESSES.program, pin.logAuthority, pin.globalConfiguration,
    i.identity.authorityWalletAddress, i.identity.traderAccountAddress, pin.perpAssetMap,
    ...pin.globalTraderIndex, ...pin.activeTraderBuffer, pin.orderbook, pin.splineCollection];
  if (new Set(list).size !== list.length) throw new Error('Order account alias');
  for (const s of list) if (new PublicKey(s).toBase58() !== s) throw new Error('Invalid order account');
  return list;
}
export function prepareOrderTransaction(i: PhoenixOrderIntent, a: PhoenixAdmission, pin: PhoenixOrderPin,
  lifetime: { blockhash: string; lastValidBlockHeight: number }) {
  const list = validateOrderPin(i, a, pin), pk = (s: string) => new PublicKey(s);
  if (!Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 1
    || pk(lifetime.blockhash).toBase58() !== lifetime.blockhash) throw new Error('Invalid order lifetime');
  const keys = list.map((s, n) => ({ pubkey: pk(s), isWritable: n === 2 || n >= 4, isSigner: n === 3 }));
  const tx = new Transaction({ feePayer: pk(i.identity.authorityWalletAddress), ...lifetime }).add(new TransactionInstruction({
    programId: pk(PHOENIX_PUBLIC_ADDRESSES.program), keys, data: encodePhoenixOrder(a.packet) }));
  if (i.action === 'entry') {
    if (!a.authority.protection || !i.protection) throw new Error('Atomic entry protection required');
    const legs = desiredProtection(i.protection, i.side === 'buy' ? 'long' : 'short', a.packet.numBaseLots, a.authority.protection.markTicks);
    // Same transaction: IOC partial fills receive 100% of the resulting position; zero-fill
    // cannot leave a naked entry. No independently submitted follow-up bracket.
    for (const leg of [legs[1], legs[0]]) tx.add(protectionInstruction({ identity: i.identity, market: i.market, assetId: a.authority.assetId }, pin, leg, true));
  }
  return tx;
}
export function signOrderTransaction(i: PhoenixOrderIntent, a: PhoenixAdmission, pin: PhoenixOrderPin,
  lifetime: { blockhash: string; lastValidBlockHeight: number }, secret: Uint8Array, now: number) {
  // This synchronous check runs INSIDE custody.withPhoenixBotSigner, after key acquisition.
  const checked = admitPhoenixOrder(i, a.authority, now, true);
  const tx = prepareOrderTransaction(i, checked, pin, lifetime);
  const authority = new PublicKey(i.identity.authorityWalletAddress);
  if (secret.length !== 64 || !authority.equals(new PublicKey(secret.subarray(32)))) throw new Error('Order signer mismatch');
  tx.addSignature(authority, Buffer.from(nacl.sign.detached(tx.serializeMessage(), secret)));
  if (!tx.verifySignatures() || tx.signatures.length !== 1) throw new Error('Invalid order signer set');
  return { transaction: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature!), blockhash: lifetime.blockhash,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight), transactionHash: createHash('sha256').update(tx.serializeMessage()).digest('hex') };
}
