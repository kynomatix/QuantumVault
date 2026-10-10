import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { derivePhoenixIdentity } from '../../server/protocol/phoenix/identity';
import { expectedRegistration } from '../../server/protocol/phoenix/registration';

// All keys are deterministic synthetic test keys, never user or deployment keys.
export const key = (index: number) => Keypair.fromSeed(new Uint8Array(32).fill(index));
export const authority = key(11);
export const identity = derivePhoenixIdentity(authority.publicKey.toBase58());
export const onboarder = key(12);
export const pin = { onboarder: onboarder.publicKey.toBase58(), permissionAccount: key(13).publicKey.toBase58(),
  globalTraderIndex: [key(14).publicKey.toBase58()], activeTraderBuffer: [key(15).publicKey.toBase58()],
  traderBytesByMaxPositions: { 32: 1520 } }; // Synthetic simulation account space, not a deployment pin.
export const lifetime = { blockhash: key(16).publicKey.toBase58(), lastValidBlockHeight: 100 };
export const instructions = () => expectedRegistration(identity, pin, 32);
export function traderData() {
  const data = Buffer.alloc(1520);
  createHash('sha256').update('account:trader').digest().copy(data, 0, 0, 8);
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(data, 24);
  authority.publicKey.toBuffer().copy(data, 56);
  data.writeUInt32LE(63, 96); data.writeUInt32LE(32, 112);
  return data;
}
