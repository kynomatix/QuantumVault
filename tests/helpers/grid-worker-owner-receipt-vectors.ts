import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import bs58 from 'bs58';

// Synthetic deterministic fixture material; never an application signer or real wallet.
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();
const seed = sha256('EXAMPLE_OWNER_ACTION_VECTOR_SEED');
const fixtureDer = Buffer.concat([Buffer.from([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]), seed]);
// EXAMPLE is a KeyObject derived only from the public deterministic fixture seed.
const EXAMPLE = createPrivateKey({ key: fixtureDer, type: 'pkcs8', format: 'der' });
const ownerWallet = bs58.encode(createPublicKey(EXAMPLE).export({ type: 'spki', format: 'der' }).subarray(-32));
const botId = '00000000-0000-4000-8000-000000000001';
export const OWNER_RECEIPT_VECTORS = ['pause', 'reset_pause', 'ack_critical', 'widen_scope', 'break_glass_close'].map(action => {
  const params = action === 'widen_scope' ? { globalCapUsd: '200', perBotCapUsd: '100', wallets: [ownerWallet] }
    : action === 'break_glass_close' ? { botId } : undefined;
  const paramsJson = params ? JSON.stringify(params) : undefined;
  const paramsDigest = paramsJson ? sha256(paramsJson).toString('hex') : 'none';
  const nonce = bs58.encode(sha256('EXAMPLE_NONCE_' + action));
  const target = action === 'break_glass_close' ? 'bot:' + botId : 'all';
  const message = `QV-OWNER-ACTION v1\naction:${action}\nscope:grid_worker\ntarget:${target}\nnonce:${nonce}\nissued:2026-01-01T00:00:00.000Z\nexpires:2026-01-01T00:02:00.000Z\nparams:${paramsDigest}`;
  const bytes = Buffer.from(message, 'utf8');
  return { action, ownerWallet, target, nonce, paramsJson, paramsDigest, message, messageBytes: [...bytes], messageDigest: sha256(bytes).toString('hex'), signature: bs58.encode(sign(null, bytes, EXAMPLE)) };
});
