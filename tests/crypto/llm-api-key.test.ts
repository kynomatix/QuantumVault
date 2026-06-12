import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { generateUMK } from '../../server/crypto-v3.js';
import { encryptLlmApiKeyV3, decryptLlmApiKeyV3 } from '../../server/session-v3.js';

// BYO OpenRouter key for the QuantumLab AI Strategy Creator (Task 187). The key is
// AES-256-GCM encrypted under a UMK-derived subkey and AAD-bound to the owner wallet.
// Unlike the subaccount-key path (which returns null on failure), this mirrors the
// agent-key path: decryptBuffer THROWS on an authentication failure, so the wrong
// wallet / wrong UMK / tampered ciphertext cases assert a throw.

function fixture() {
  const umk = generateUMK();
  const walletAddress = Keypair.generate().publicKey.toBase58();
  const apiKey = Buffer.from('sk-or-v1-' + 'a'.repeat(48), 'utf8');
  return { umk, walletAddress, apiKey };
}

describe('LLM API key (BYO) v3 crypto — QuantumLab Creator', () => {
  it('round-trips a key bound to the owner wallet', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const out = decryptLlmApiKeyV3(umk, ct, walletAddress);
    expect(out.equals(apiKey)).toBe(true);
  });

  it('produces a different ciphertext each call (random nonce), both decrypting back', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const a = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const b = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    expect(a).not.toBe(b);
    expect(decryptLlmApiKeyV3(umk, a, walletAddress).equals(apiKey)).toBe(true);
    expect(decryptLlmApiKeyV3(umk, b, walletAddress).equals(apiKey)).toBe(true);
  });

  it('ACCOUNT SAFETY: a key written under one wallet cannot be decrypted as another wallet (AAD bind)', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const otherWallet = Keypair.generate().publicKey.toBase58();
    expect(() => decryptLlmApiKeyV3(umk, ct, otherWallet)).toThrow();
  });

  it('a key written under one UMK cannot be decrypted with a different UMK', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const otherUmk = generateUMK();
    expect(() => decryptLlmApiKeyV3(otherUmk, ct, walletAddress)).toThrow();
  });

  it('tampered ciphertext fails authentication', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const raw = Buffer.from(ct, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a bit in the GCM auth tag
    expect(() => decryptLlmApiKeyV3(umk, raw.toString('base64'), walletAddress)).toThrow();
  });
});
