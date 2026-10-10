import { derivePhoenixIdentity, phoenixIdentityColumns, phoenixIdentityFromBot } from './identity';
import type { PhoenixCreationRequest } from './provisioning-store';
import type { PhoenixBotIdentityColumns } from './identity';
import { PublicKey } from '@solana/web3.js';
import { deriveBotSecretKeyFromAgentSeed } from '../../bot-derived-secret';
import type { BotPolicyInput } from './policy';

/** Public-only boundary shared with the existing V3 decrypt/recovery lifetime. */
export function botSigningAddress(bot: PhoenixBotIdentityColumns): string | null | undefined {
  return bot.activeProtocol === 'phoenix' ? phoenixIdentityFromBot(bot).authorityWalletAddress : bot.protocolSubaccountId;
}

export async function derivePhoenixBotMaterial(request: PhoenixCreationRequest, index: number, botId: string) {
  const security = await import('../../session-v3');
  const held = await security.getUmkForWebhook(request.ownerWallet);
  if (!held) throw new Error('Phoenix recovery key unavailable');
  let mnemonic: Buffer | null = null;
  let key: Uint8Array | null = null;
  let secret: Buffer | null = null;
  try {
    mnemonic = await security.decryptMnemonic(request.ownerWallet, held.umk);
    if (!mnemonic) throw new Error('Phoenix recovery phrase unavailable');
    key = deriveBotSecretKeyFromAgentSeed(mnemonic, index, 1);
    mnemonic.fill(0); mnemonic = null;
    const authority = new PublicKey(key.subarray(32)).toBase58();
    const identity = derivePhoenixIdentity(authority);
    secret = Buffer.from(key);
    const encryptedKey = security.encryptBotSubaccountKeyV3(held.umk, secret, request.ownerWallet, botId);
    const policyHmac = security.computeBotPolicyHmac(held.umk, { id: botId, walletAddress: request.ownerWallet,
      activeProtocol: 'phoenix', derivationIndex: index, ...phoenixIdentityColumns(identity),
      market: request.market, leverage: 1, maxPositionSize: '0.00' });
    return { authority, encryptedKey, policyHmac };
  } finally { mnemonic?.fill(0); secret?.fill(0); key?.fill(0); held.cleanup(); }
}

/** Only a synchronous callback may use the key. RPC/API work follows cleanup. */
export async function withPhoenixBotSigner<T>(input: BotPolicyInput & {
  id: string; walletAddress: string; protocolSubaccountId: string | null;
  botSubaccountKeyEncryptedV3: string | null; policyHmac: string | null;
}, sign: (secret: Uint8Array) => T): Promise<T> {
  const bot = structuredClone(input);
  phoenixIdentityFromBot(bot);
  const security = await import('../../session-v3');
  const held = await security.getUmkForWebhook(bot.walletAddress);
  if (!held) throw new Error('Phoenix signing key unavailable');
  let secret: Uint8Array | null = null;
  let mnemonic: Buffer | null = null;
  try {
    if (!bot.policyHmac || !security.verifyBotPolicyHmac(held.umk, bot, bot.policyHmac)) throw new Error('Phoenix policy integrity failed');
    try {
      if (bot.botSubaccountKeyEncryptedV3) secret = security.decryptBotSubaccountKeyV3(held.umk, bot.botSubaccountKeyEncryptedV3, bot.walletAddress, bot.id);
    } catch { /* Recover through the existing encrypted mnemonic lifetime below. */ }
    if (secret && (secret.length !== 64 || new PublicKey(secret.subarray(32)).toBase58() !== botSigningAddress(bot))) {
      secret.fill(0); secret = null;
    }
    if (!secret) {
      mnemonic = await security.decryptMnemonic(bot.walletAddress, held.umk);
      if (!mnemonic) throw new Error('Phoenix recovery phrase unavailable');
      secret = deriveBotSecretKeyFromAgentSeed(mnemonic, bot.derivationIndex!, bot.derivationPathVersion!);
      mnemonic.fill(0); mnemonic = null;
    }
    if (new PublicKey(secret.subarray(32)).toBase58() !== botSigningAddress(bot)) throw new Error('Phoenix recovered signer mismatch');
    const result = sign(secret);
    if (result && typeof (result as any).then === 'function') throw new Error('Phoenix signing callback must be synchronous');
    return result;
  } finally { secret?.fill(0); mnemonic?.fill(0); held.cleanup(); }
}
