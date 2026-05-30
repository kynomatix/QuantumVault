import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  buildPooledSubaccountAAD,
  buildBotSubaccountAAD,
  SUBACCOUNT_AAD_VERSION,
  generateUMK,
} from '../../server/crypto-v3.js';
import {
  encryptPooledSubaccountKeyV3,
  encryptBotSubaccountKeyV3,
  decryptRetainedSubaccountKeyV3,
  rebindSubaccountKeyToPooledV3,
} from '../../server/session-v3.js';

const PROTOCOL = 'pacifica';

function freshFixture() {
  const umk = generateUMK();
  const subKp = Keypair.generate();
  const secret = Buffer.from(subKp.secretKey); // 64-byte ed25519 secret
  const protocolSubaccountId = subKp.publicKey.toBase58();
  const walletAddress = Keypair.generate().publicKey.toBase58();
  return { umk, secret, protocolSubaccountId, walletAddress };
}

// The pubkey-mismatch / wrong-AAD / missing-id paths all log via console.error
// by design; silence it so the suite output stays readable.
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('buildPooledSubaccountAAD', () => {
  it('is unambiguous across the two variable-length fields (length-prefixed protocol)', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const a = buildPooledSubaccountAAD('pa', wallet, 'cifica-XYZ');
    const b = buildPooledSubaccountAAD('pacifica', wallet, '-XYZ');
    expect(a.equals(b)).toBe(false);
  });

  it('changes when protocol, wallet, or subaccount id changes', () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const base = buildPooledSubaccountAAD('pacifica', w1, 'SUB1');
    expect(base.equals(buildPooledSubaccountAAD('drift', w1, 'SUB1'))).toBe(false);
    expect(base.equals(buildPooledSubaccountAAD('pacifica', w2, 'SUB1'))).toBe(false);
    expect(base.equals(buildPooledSubaccountAAD('pacifica', w1, 'SUB2'))).toBe(false);
  });

  it('rejects empty protocol / empty subaccount id', () => {
    const w = Keypair.generate().publicKey.toBase58();
    expect(() => buildPooledSubaccountAAD('', w, 'SUB')).toThrow();
    expect(() => buildPooledSubaccountAAD('pacifica', w, '')).toThrow();
  });

  it('never collides with the legacy bot-UUID AAD (0x06 vs 0x05 record type)', () => {
    // Worst case: the same string is used as both the bot UUID and the
    // subaccount id, under the same wallet. The record-type byte must still
    // keep the two schemes distinct.
    const w = Keypair.generate().publicKey.toBase58();
    const sameId = 'collision-candidate-id';
    const pooled = buildPooledSubaccountAAD('pacifica', w, sameId);
    const botUuid = buildBotSubaccountAAD(w, sameId);
    expect(pooled.equals(botUuid)).toBe(false);
  });
});

describe('pooled subaccount key crypto (Phase C)', () => {
  it('round-trips a key written under the POOLED AAD', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const ct = encryptPooledSubaccountKeyV3(umk, secret, PROTOCOL, walletAddress, protocolSubaccountId);
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: ct, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(res).not.toBeNull();
    expect(Buffer.from(res!.secretKey).equals(secret)).toBe(true);
    res!.cleanup();
  });

  it('dual-reads a legacy BOT_UUID-bound key when legacyBotId is supplied', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const botId = 'bot-uuid-1234';
    const ct = encryptBotSubaccountKeyV3(umk, secret, walletAddress, botId);
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: ct, aadVersion: SUBACCOUNT_AAD_VERSION.BOT_UUID,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId, legacyBotId: botId,
    });
    expect(res).not.toBeNull();
    expect(Buffer.from(res!.secretKey).equals(secret)).toBe(true);
    res!.cleanup();
  });

  it('returns null when a BOT_UUID key is read without legacyBotId', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const ct = encryptBotSubaccountKeyV3(umk, secret, walletAddress, 'bot-uuid-1');
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: ct, aadVersion: SUBACCOUNT_AAD_VERSION.BOT_UUID,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(res).toBeNull();
  });

  it('returns null on an unknown aadVersion', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const ct = encryptPooledSubaccountKeyV3(umk, secret, PROTOCOL, walletAddress, protocolSubaccountId);
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: ct, aadVersion: 99,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(res).toBeNull();
  });

  it('FUND SAFETY: rejects a key whose derived pubkey != protocolSubaccountId', () => {
    const { umk, protocolSubaccountId, walletAddress } = freshFixture();
    // Encrypt a DIFFERENT keypair under the AAD that claims protocolSubaccountId.
    const other = Keypair.generate();
    const ct = encryptPooledSubaccountKeyV3(
      umk, Buffer.from(other.secretKey), PROTOCOL, walletAddress, protocolSubaccountId,
    );
    // AAD matches (so GCM decrypt succeeds), but the pubkey check must fail.
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: ct, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(res).toBeNull();
  });

  it('AAD authenticity: wrong protocol / wallet / subaccount id fail to decrypt', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const ct = encryptPooledSubaccountKeyV3(umk, secret, PROTOCOL, walletAddress, protocolSubaccountId);
    const otherWallet = Keypair.generate().publicKey.toBase58();
    const common = { umk, encryptedV3: ct, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT };
    expect(decryptRetainedSubaccountKeyV3({ ...common, protocol: 'drift', walletAddress, protocolSubaccountId })).toBeNull();
    expect(decryptRetainedSubaccountKeyV3({ ...common, protocol: PROTOCOL, walletAddress: otherWallet, protocolSubaccountId })).toBeNull();
    expect(decryptRetainedSubaccountKeyV3({ ...common, protocol: PROTOCOL, walletAddress, protocolSubaccountId: 'SomeOtherId' })).toBeNull();
  });

  it('rebinds legacy BOT_UUID → POOLED, then reads as POOLED but no longer as BOT_UUID', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const botId = 'bot-uuid-rebind';
    const legacyCt = encryptBotSubaccountKeyV3(umk, secret, walletAddress, botId);

    const rebound = rebindSubaccountKeyToPooledV3({
      umk, currentEncryptedV3: legacyCt, currentAadVersion: SUBACCOUNT_AAD_VERSION.BOT_UUID,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId, legacyBotId: botId,
    });
    expect(rebound).not.toBeNull();
    expect(rebound!.aadVersion).toBe(SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT);

    const asPooled = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: rebound!.encryptedV3, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(asPooled).not.toBeNull();
    expect(Buffer.from(asPooled!.secretKey).equals(secret)).toBe(true);
    asPooled!.cleanup();

    // The rebound ciphertext is bound to the subaccount AAD now, so a BOT_UUID
    // read of the same bytes must fail authentication.
    const asBotUuid = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: rebound!.encryptedV3, aadVersion: SUBACCOUNT_AAD_VERSION.BOT_UUID,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId, legacyBotId: botId,
    });
    expect(asBotUuid).toBeNull();
  });

  it('rebind is idempotent for an already-POOLED key', () => {
    const { umk, secret, protocolSubaccountId, walletAddress } = freshFixture();
    const ct = encryptPooledSubaccountKeyV3(umk, secret, PROTOCOL, walletAddress, protocolSubaccountId);
    const rebound = rebindSubaccountKeyToPooledV3({
      umk, currentEncryptedV3: ct, currentAadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(rebound).not.toBeNull();
    expect(rebound!.aadVersion).toBe(SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT);
    const res = decryptRetainedSubaccountKeyV3({
      umk, encryptedV3: rebound!.encryptedV3, aadVersion: SUBACCOUNT_AAD_VERSION.POOLED_SUBACCOUNT,
      protocol: PROTOCOL, walletAddress, protocolSubaccountId,
    });
    expect(res).not.toBeNull();
    expect(Buffer.from(res!.secretKey).equals(secret)).toBe(true);
    res!.cleanup();
  });
});
