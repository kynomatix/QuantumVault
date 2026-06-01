import { describe, it, expect, afterAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  deriveBotKeypairFromAgentSeed,
  deriveKeypairFromMnemonic,
  BOT_DERIVATION_PATH_VERSION,
} from '../../server/session-v3.js';

// Phase 4b (Flash agent-HD wallets). A per-bot wallet is derived from the agent
// recovery phrase at m/44'/501'/<botIndex>'/0' (account 0' is RESERVED for the
// agent). The agent seed + the non-secret botIndex re-creates the EXACT wallet, so
// funds remain recoverable even if the encrypted blob — or the whole DB — is lost.
// These tests pin the fund-safety invariants: determinism (re-derive == stored),
// the bot path can never collide with the agent path, index validation fails closed,
// and the atomic allocator hands out unique monotonic indexes under concurrency.

// Well-known, valid BIP39 test vector. NOT a real wallet — public test mnemonic.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = () => Buffer.from(TEST_MNEMONIC, 'utf8');

describe('deriveBotKeypairFromAgentSeed — determinism & recovery', () => {
  it('re-derives the SAME pubkey for a given (seed, index) — recovery == stored', () => {
    // Simulate: "stored" pubkey at creation, then "recovered" pubkey later from
    // the seed + index alone (the blob-deleted recovery scenario).
    const stored = deriveBotKeypairFromAgentSeed(seed(), 1).publicKey.toBase58();
    const recovered = deriveBotKeypairFromAgentSeed(seed(), 1).publicKey.toBase58();
    expect(recovered).toBe(stored);
  });

  it('derives DISTINCT wallets for distinct indexes (no commingling)', () => {
    const a = deriveBotKeypairFromAgentSeed(seed(), 1).publicKey.toBase58();
    const b = deriveBotKeypairFromAgentSeed(seed(), 2).publicKey.toBase58();
    const c = deriveBotKeypairFromAgentSeed(seed(), 3).publicKey.toBase58();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('produces a valid 64-byte ed25519 keypair', () => {
    const kp = deriveBotKeypairFromAgentSeed(seed(), 7);
    expect(kp.secretKey.length).toBe(64);
    // Round-trips: the secret key reproduces the same public key.
    expect(Keypair.fromSecretKey(kp.secretKey).publicKey.toBase58()).toBe(
      kp.publicKey.toBase58(),
    );
  });

  it('defaults to BOT_DERIVATION_PATH_VERSION when version omitted', () => {
    const implicit = deriveBotKeypairFromAgentSeed(seed(), 5).publicKey.toBase58();
    const explicit = deriveBotKeypairFromAgentSeed(
      seed(),
      5,
      BOT_DERIVATION_PATH_VERSION,
    ).publicKey.toBase58();
    expect(implicit).toBe(explicit);
  });
});

describe('deriveBotKeypairFromAgentSeed — path-collision safety (fail closed)', () => {
  it('a bot wallet can NEVER equal the agent wallet (index 1 != agent path)', () => {
    const agent = deriveKeypairFromMnemonic(seed()).publicKey.toBase58();
    // Lowest valid bot index must already diverge from the agent account.
    const bot1 = deriveBotKeypairFromAgentSeed(seed(), 1).publicKey.toBase58();
    expect(bot1).not.toBe(agent);
  });

  it('rejects botIndex < 1 (0 would resolve to the agent account)', () => {
    expect(() => deriveBotKeypairFromAgentSeed(seed(), 0)).toThrow();
    expect(() => deriveBotKeypairFromAgentSeed(seed(), -1)).toThrow();
  });

  it('rejects non-integer and out-of-range indexes', () => {
    expect(() => deriveBotKeypairFromAgentSeed(seed(), 1.5)).toThrow();
    expect(() => deriveBotKeypairFromAgentSeed(seed(), 2 ** 31)).toThrow();
    expect(() => deriveBotKeypairFromAgentSeed(seed(), NaN)).toThrow();
  });

  it('rejects an unsupported path version (no silent fallback)', () => {
    expect(() => deriveBotKeypairFromAgentSeed(seed(), 1, 0)).toThrow();
    expect(() => deriveBotKeypairFromAgentSeed(seed(), 1, 2)).toThrow();
  });

  it('rejects an invalid mnemonic', () => {
    expect(() =>
      deriveBotKeypairFromAgentSeed(Buffer.from('not a real mnemonic', 'utf8'), 1),
    ).toThrow();
  });
});

// ── Atomic allocator concurrency (DB-backed) ────────────────────────────────
// The allocator is a single-statement, row-locked UPDATE ... RETURNING, so
// concurrent creates for one wallet MUST serialize into unique, monotonic indexes
// with no reuse — the property the DB UNIQUE(wallet_address, derivation_index)
// constraint depends on. Uses a throwaway wallet row and cleans it up.
describe('allocateBotDerivationIndex — atomic, unique, monotonic', () => {
  const testAddress = `test-hd-alloc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  let storage: typeof import('../../server/storage.js')['storage'];
  let db: typeof import('../../server/db.js')['db'];
  let sqlTag: typeof import('drizzle-orm')['sql'];

  afterAll(async () => {
    if (db && sqlTag) {
      try {
        await db.execute(sqlTag`DELETE FROM wallets WHERE address = ${testAddress}`);
      } catch { /* best-effort cleanup */ }
    }
  });

  it('hands out unique monotonic indexes 1..N under concurrent allocation', async () => {
    ({ storage } = await import('../../server/storage.js'));
    ({ db } = await import('../../server/db.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));

    await storage.createWallet({ address: testAddress });

    const N = 25;
    const allocated = await Promise.all(
      Array.from({ length: N }, () => storage.allocateBotDerivationIndex(testAddress)),
    );

    // Unique (no reuse), and exactly the contiguous range 1..N (monotonic, no gaps).
    expect(new Set(allocated).size).toBe(N);
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    // The next allocation continues from N+1 (burn-on-allocate persisted).
    expect(await storage.allocateBotDerivationIndex(testAddress)).toBe(N + 1);
  });

  it('throws for an unknown wallet (fail closed, never returns a phantom index)', async () => {
    ({ storage } = await import('../../server/storage.js'));
    await expect(
      storage.allocateBotDerivationIndex(`does-not-exist-${Date.now()}`),
    ).rejects.toThrow();
  });
});
