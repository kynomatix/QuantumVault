import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bip39 from 'bip39';
import { derivePhoenixBotMaterial, withPhoenixBotSigner } from '../../server/protocol/phoenix/custody';
import { deriveBotSecretKeyFromAgentSeed } from '../../server/bot-derived-secret';
import { derivePhoenixIdentity, phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { PublicKey } from '@solana/web3.js';
import { authority, identity } from '../helpers/phoenix-registration';

const security = vi.hoisted(() => ({ getUmkForWebhook: vi.fn(), decryptMnemonic: vi.fn(), encryptBotSubaccountKeyV3: vi.fn(),
  computeBotPolicyHmac: vi.fn(), verifyBotPolicyHmac: vi.fn(), decryptBotSubaccountKeyV3: vi.fn() }));
vi.mock('../../server/session-v3', () => security);
let held: Buffer, cached: Buffer, phrase: Buffer;
const cleanup = vi.fn(() => held.fill(0));
const bot = () => ({ id: 'EXAMPLE-bot', walletAddress: 'EXAMPLE-owner', activeProtocol: 'phoenix', derivationIndex: 1,
  ...phoenixIdentityColumns(identity), market: 'SOL', leverage: 1, maxPositionSize: '0.00', policyHmac: 'EXAMPLE-policy-hmac', botSubaccountKeyEncryptedV3: 'EXAMPLE-ciphertext' });
beforeEach(() => {
  vi.resetAllMocks(); held = Buffer.alloc(32, 1); cached = Buffer.from(authority.secretKey);
  phrase = Buffer.from(bip39.entropyToMnemonic(Buffer.alloc(16, 5)));
  cleanup.mockImplementation(() => held.fill(0));
  security.getUmkForWebhook.mockResolvedValue({ umk: held, cleanup });
  security.decryptMnemonic.mockResolvedValue(phrase);
  security.decryptBotSubaccountKeyV3.mockImplementation(() => cached);
  security.verifyBotPolicyHmac.mockReturnValue(true);
  security.encryptBotSubaccountKeyV3.mockReturnValue('EXAMPLE-ciphertext');
  security.computeBotPolicyHmac.mockReturnValue('EXAMPLE-policy-hmac');
});
describe('U03 key lifetimes with synthetic custody', () => {
  it('clears mnemonic, owned secret and UMK after allocation and persists only ciphertext/public identity/policy', async () => {
    let secret: Buffer | undefined;
    security.encryptBotSubaccountKeyV3.mockImplementation((_umk, value) => { secret = value; return 'EXAMPLE-ciphertext'; });
    const material = await derivePhoenixBotMaterial({ ownerWallet: 'EXAMPLE-owner', requestId: 'EXAMPLE-request', name: 'EXAMPLE-bot', market: 'SOL', maxPositions: 32, maxCostLamports: '20000' }, 1, 'EXAMPLE-bot');
    expect(Object.keys(material).sort()).toEqual(['authority', 'encryptedKey', 'policyHmac']);
    expect(phrase.every(byte => byte === 0)).toBe(true); expect(secret!.every(byte => byte === 0)).toBe(true); expect(held.every(byte => byte === 0)).toBe(true);
    expect(security.computeBotPolicyHmac.mock.calls[0][1]).toMatchObject({ activeProtocol: 'phoenix', derivationIndex: 1, maxPositionSize: '0.00' });
  });
  it.each(['success', 'throw', 'async'])('cleans the signer and UMK when callback outcome is %s', async outcome => {
    const call = withPhoenixBotSigner(bot(), secret => {
      expect(secret.some(byte => byte !== 0)).toBe(true);
      if (outcome === 'throw') throw new Error('EXAMPLE-callback-error');
      if (outcome === 'async') return Promise.resolve('EXAMPLE-result');
      return 'EXAMPLE-result';
    });
    if (outcome === 'success') await expect(call).resolves.toBe('EXAMPLE-result'); else await expect(call).rejects.toThrow();
    expect(cached.every(byte => byte === 0)).toBe(true); expect(held.every(byte => byte === 0)).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('rejects policy tampering before decrypting a private key', async () => {
    security.verifyBotPolicyHmac.mockReturnValue(false);
    await expect(withPhoenixBotSigner(bot(), () => 'EXAMPLE')).rejects.toThrow('policy integrity');
    expect(security.decryptBotSubaccountKeyV3).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('recovers a corrupt cache only from the same derivation and verifies authority rather than the trader PDA', async () => {
    const secret = deriveBotSecretKeyFromAgentSeed(phrase, 1, 1);
    const recovered = derivePhoenixIdentity(new PublicKey(secret.subarray(32)).toBase58()); secret.fill(0);
    security.decryptBotSubaccountKeyV3.mockImplementation(() => { throw new Error('EXAMPLE-corrupt-cache'); });
    const value = await withPhoenixBotSigner({ ...bot(), ...phoenixIdentityColumns(recovered) }, value => new PublicKey(value.subarray(32)).toBase58());
    expect(value).toBe(recovered.authorityWalletAddress); expect(value).not.toBe(recovered.traderAccountAddress);
    expect(phrase.every(byte => byte === 0)).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('refuses recovery from an unrelated seed and cleans every buffer', async () => {
    security.decryptBotSubaccountKeyV3.mockImplementation(() => { throw new Error('EXAMPLE-corrupt-cache'); });
    await expect(withPhoenixBotSigner(bot(), () => 'EXAMPLE')).rejects.toThrow('signer mismatch');
    expect(phrase.every(byte => byte === 0)).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
