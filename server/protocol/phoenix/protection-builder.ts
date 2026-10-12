import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { units } from './funding-contract';
import type { PhoenixOrderPin } from './order-builder';
import { protectionAddresses, type ProtectionTarget, type ProtectionCommand } from './protection-contract';

const pk = (s: string) => new PublicKey(s);
const u64 = (s: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(units(s)); return b; };
const discriminator = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const meta = (s: string, isWritable = false, isSigner = false) => ({ pubkey: pk(s), isWritable, isSigner });
export function protectionInstruction(t: ProtectionTarget, pin: PhoenixOrderPin, c: ProtectionCommand, percent = false) {
  if (pin.market !== t.market || pin.assetId !== t.assetId || !pin.globalTraderIndex.length || !pin.activeTraderBuffer.length) throw new Error('Protection pin mismatch');
  const { conditionalAccount, standaloneAccount } = protectionAddresses(t.identity.traderAccountAddress, t.assetId);
  const p = PHOENIX_PUBLIC_ADDRESSES.program, wallet = t.identity.authorityWalletAddress, trader = t.identity.traderAccountAddress;
  const distinct = [p, pin.logAuthority, pin.globalConfiguration, wallet, trader, pin.perpAssetMap,
    ...pin.globalTraderIndex, ...pin.activeTraderBuffer, pin.orderbook, pin.splineCollection, conditionalAccount, standaloneAccount];
  if (new Set(distinct).size !== distinct.length) throw new Error('Protection account alias');
  distinct.forEach(pk);
  let keys: ReturnType<typeof meta>[], data: Buffer;
  const arena = [pin.perpAssetMap, ...pin.globalTraderIndex, ...pin.activeTraderBuffer, pin.orderbook, pin.splineCollection].map(s => meta(s, true));
  if (c.kind === 'cancel-book') {
    keys = [meta(p), meta(pin.logAuthority), meta(pin.globalConfiguration, true), meta(wallet, false, true), meta(trader, true), ...arena];
    data = discriminator('cancel_all');
  } else if (c.kind === 'cancel-conditional') {
    if (!Number.isInteger(c.index) || c.index < 1 || c.index > 191) throw new Error('Invalid conditional index');
    keys = [meta(p), meta(pin.logAuthority), meta(pin.globalConfiguration), meta(trader, true), meta(wallet, false, true), meta(pin.orderbook, true), meta(conditionalAccount, true)];
    data = Buffer.concat([discriminator('cancel_conditional_order'), Buffer.from([c.index, 1, 1])]);
  } else if (c.kind === 'cancel-standalone') {
    keys = [meta(p), meta(pin.logAuthority), meta(pin.globalConfiguration), meta(c.funder, true), meta(trader), meta(wallet, false, true), meta(standaloneAccount, true), meta(SystemProgram.programId.toBase58())];
    data = Buffer.concat([discriminator('cancel_stop_loss'), Buffer.from([c.direction === 'greater' ? 0 : 1])]);
  } else {
    // Native conditional triggers are reduce-only. Kind IOC, bounded execution ticks.
    keys = [meta(p), meta(pin.logAuthority), meta(pin.globalConfiguration), meta(wallet, true, true), meta(trader, true), ...arena,
      meta(wallet, false, true), meta(conditionalAccount, true), meta(SystemProgram.programId.toBase58())];
    const trigger = Buffer.concat([Buffer.from([1, c.direction === 'greater' ? 0 : 1, c.side === 'buy' ? 0 : 1, 0]), u64(c.triggerTicks), u64(c.executionTicks)]);
    const asset = Buffer.alloc(4); asset.writeUInt32LE(t.assetId);
    data = Buffer.concat([discriminator('place_position_conditional_order'), asset,
      c.direction === 'greater' ? trigger : Buffer.from([0]), c.direction === 'less' ? trigger : Buffer.from([0]),
      percent ? Buffer.from([0, 1, 100]) : Buffer.concat([Buffer.from([1]), u64(c.baseLots), Buffer.from([0])])]);
  }
  return new TransactionInstruction({ programId: pk(p), keys, data });
}
export function signProtectionTransaction(t: ProtectionTarget, pin: PhoenixOrderPin, c: ProtectionCommand,
  lifetime: { blockhash: string; lastValidBlockHeight: number }, secret: Uint8Array) {
  const wallet = pk(t.identity.authorityWalletAddress);
  if (!Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight < 1 || pk(lifetime.blockhash).toBase58() !== lifetime.blockhash
    || secret.length !== 64 || !wallet.equals(pk(bs58.encode(secret.subarray(32))))) throw new Error('Invalid protection signer/lifetime');
  const tx = new Transaction({ feePayer: wallet, ...lifetime }).add(protectionInstruction(t, pin, c));
  tx.addSignature(wallet, Buffer.from(nacl.sign.detached(tx.serializeMessage(), secret)));
  if (!tx.verifySignatures() || tx.signatures.length !== 1) throw new Error('Invalid protection signer set');
  return { transaction: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature!), blockhash: lifetime.blockhash,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight), transactionHash: createHash('sha256').update(tx.serializeMessage()).digest('hex') };
}
