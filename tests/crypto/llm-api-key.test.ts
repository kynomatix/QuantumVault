import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { generateUMK } from '../../server/crypto-v3.js';
import {
  LlmApiKeyDecryptionError,
  classifyLlmApiKeyDecryptionFailure,
  decryptLlmApiKeyV3,
  encryptLlmApiKeyV3,
  fingerprintLlmApiKeyV3,
} from '../../server/session-v3.js';

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

  it('classifies an invalid UMK without exposing raw error prose', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    let thrown: unknown;
    try {
      decryptLlmApiKeyV3(Buffer.alloc(31), ct, walletAddress);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LlmApiKeyDecryptionError);
    expect(classifyLlmApiKeyDecryptionFailure(thrown)).toBe('invalid_umk');
    expect((thrown as Error).message).toBe('invalid_umk');
    expect((thrown as Error).message).not.toContain('expected 32 bytes');
  });

  it('classifies an invalid wallet AAD without exposing raw error prose', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    let thrown: unknown;
    try {
      decryptLlmApiKeyV3(umk, ct, 'not-a-wallet');
    } catch (error) {
      thrown = error;
    }
    expect(classifyLlmApiKeyDecryptionFailure(thrown)).toBe('invalid_wallet_aad');
    expect((thrown as Error).message).toBe('invalid_wallet_aad');
    expect((thrown as Error).message).not.toContain('not-a-wallet');
  });

  it('classifies malformed Base64 and short envelopes before AES-GCM', () => {
    const { umk, walletAddress } = fixture();
    for (const value of ['not base64', 'YWJj', 'YWJjZA']) {
      let thrown: unknown;
      try {
        decryptLlmApiKeyV3(umk, value, walletAddress);
      } catch (error) {
        thrown = error;
      }
      expect(classifyLlmApiKeyDecryptionFailure(thrown)).toBe('malformed_ciphertext');
      expect((thrown as Error).message).toBe('malformed_ciphertext');
    }
  });

  it('classifies wrong-key, wrong-AAD, and tampered ciphertext as authentication_failed', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const ct = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const tampered = Buffer.from(ct, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    const attempts = [
      () => decryptLlmApiKeyV3(generateUMK(), ct, walletAddress),
      () => decryptLlmApiKeyV3(umk, ct, Keypair.generate().publicKey.toBase58()),
      () => decryptLlmApiKeyV3(umk, tampered.toString('base64'), walletAddress),
    ];
    for (const attempt of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(classifyLlmApiKeyDecryptionFailure(thrown)).toBe('authentication_failed');
      expect((thrown as Error).message).toBe('authentication_failed');
    }
  });

  it('returns internal_failure only for unrecognized thrown values', () => {
    expect(classifyLlmApiKeyDecryptionFailure(new Error('raw provider detail'))).toBe('internal_failure');
    expect(classifyLlmApiKeyDecryptionFailure('not-an-error')).toBe('internal_failure');
    expect(classifyLlmApiKeyDecryptionFailure(
      new LlmApiKeyDecryptionError('authentication_failed'),
    )).toBe('authentication_failed');
  });

  it('fingerprints ciphertext, AAD, and UMK authority independently', () => {
    const { umk, walletAddress, apiKey } = fixture();
    const firstCiphertext = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const secondCiphertext = encryptLlmApiKeyV3(umk, apiKey, walletAddress);
    const otherWallet = Keypair.generate().publicKey.toBase58();
    const otherUmk = generateUMK();
    const first = fingerprintLlmApiKeyV3(umk, firstCiphertext, walletAddress);
    const changedCiphertext = fingerprintLlmApiKeyV3(umk, secondCiphertext, walletAddress);
    const changedWallet = fingerprintLlmApiKeyV3(umk, firstCiphertext, otherWallet);
    const changedUmk = fingerprintLlmApiKeyV3(otherUmk, firstCiphertext, walletAddress);

    expect(first).toMatchObject({
      ciphertextBytes: Buffer.from(firstCiphertext, 'base64').length,
      base64Chars: firstCiphertext.length,
    });
    for (const tag of [first.ciphertextSha16, first.walletAadSha16, first.umkAuthorityTag16]) {
      expect(tag).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(changedCiphertext.ciphertextSha16).not.toBe(first.ciphertextSha16);
    expect(changedCiphertext.walletAadSha16).toBe(first.walletAadSha16);
    expect(changedCiphertext.umkAuthorityTag16).toBe(first.umkAuthorityTag16);
    expect(changedWallet.ciphertextSha16).toBe(first.ciphertextSha16);
    expect(changedWallet.walletAadSha16).not.toBe(first.walletAadSha16);
    expect(changedWallet.umkAuthorityTag16).toBe(first.umkAuthorityTag16);
    expect(changedUmk.ciphertextSha16).toBe(first.ciphertextSha16);
    expect(changedUmk.walletAadSha16).toBe(first.walletAadSha16);
    expect(changedUmk.umkAuthorityTag16).not.toBe(first.umkAuthorityTag16);
  });
});
