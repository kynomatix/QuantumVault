import { describe, it, expect } from 'vitest';
import {
  parsePriceUpdateV2,
  getPriceFeedAccountAddress,
  readFeedsAll,
} from '../../server/vault/onchain-pyth-reader';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface AccountOpts {
  verificationTag?: number;
  priceRaw?: bigint;
  exponent?: number;
  publishTimeSec?: number;
  truncateAt?: number; // trim the buffer to test short-buffer paths
}

/**
 * Build a synthetic PriceUpdateV2 buffer with the given field values.
 * Offset layout mirrors parsePriceUpdateV2 documentation.
 */
function makeAccount(opts: AccountOpts = {}): Buffer {
  const tag = opts.verificationTag ?? 1; // default Full
  const enumBytes = tag === 0 ? 2 : 1;
  // allocate enough for all fields we care about plus padding
  const totalSize = 8 + 32 + enumBytes + 32 + 8 + 8 + 4 + 8 + 32;
  const buf = Buffer.alloc(totalSize, 0);

  let offset = 0;
  // discriminator (8 bytes)
  offset += 8;
  // write_authority (32 bytes)
  offset += 32;
  // VerificationLevel enum
  buf[offset] = tag;
  if (tag === 0) buf[offset + 1] = 1; // Partial: num_signatures = 1
  offset += enumBytes;
  // price_message.feed_id (32 bytes): zeros
  offset += 32;
  // price (i64 LE)
  buf.writeBigInt64LE(opts.priceRaw ?? 12_345_678_900n, offset);
  offset += 8;
  // conf (u64 LE): zeros
  offset += 8;
  // exponent (i32 LE)
  buf.writeInt32LE(opts.exponent ?? -8, offset);
  offset += 4;
  // publish_time (i64 LE)
  buf.writeBigInt64LE(BigInt(opts.publishTimeSec ?? 1_720_000_000), offset);

  if (opts.truncateAt != null) return buf.slice(0, opts.truncateAt);
  return buf;
}

// ─── parsePriceUpdateV2 ───────────────────────────────────────────────────────

describe('parsePriceUpdateV2 — null-on-uncertainty', () => {
  it('returns null for an empty buffer', () => {
    expect(parsePriceUpdateV2(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when buffer is shorter than MIN_ACCOUNT_BYTES (101)', () => {
    expect(parsePriceUpdateV2(makeAccount({ truncateAt: 100 }))).toBeNull();
    expect(parsePriceUpdateV2(makeAccount({ truncateAt: 50 }))).toBeNull();
  });

  it('returns null for an unknown VerificationLevel tag (not 0 or 1)', () => {
    expect(parsePriceUpdateV2(makeAccount({ verificationTag: 2 }))).toBeNull();
    expect(parsePriceUpdateV2(makeAccount({ verificationTag: 255 }))).toBeNull();
  });

  it('returns null when price is zero (priceUsd would be 0, not positive)', () => {
    expect(parsePriceUpdateV2(makeAccount({ priceRaw: 0n }))).toBeNull();
  });

  it('returns null when price is negative', () => {
    expect(parsePriceUpdateV2(makeAccount({ priceRaw: -1_000_000_000n }))).toBeNull();
  });

  it('returns null when publishTimeSec is zero', () => {
    expect(parsePriceUpdateV2(makeAccount({ publishTimeSec: 0 }))).toBeNull();
  });

  it('returns null when publishTimeSec is negative', () => {
    expect(parsePriceUpdateV2(makeAccount({ publishTimeSec: -1 }))).toBeNull();
  });

  it('parses a Full-variant account correctly', () => {
    // priceRaw=12_345_678_900, exponent=-8 → priceUsd = 123.456789
    const result = parsePriceUpdateV2(
      makeAccount({ priceRaw: 12_345_678_900n, exponent: -8, publishTimeSec: 1_720_000_000 }),
    );
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeCloseTo(123.456789, 4);
    expect(result!.publishTimeSec).toBe(1_720_000_000);
  });

  it('parses a Partial-variant account (tag=0) correctly', () => {
    const result = parsePriceUpdateV2(
      makeAccount({
        verificationTag: 0,
        priceRaw: 6_000_000_000_000n,
        exponent: -8,
        publishTimeSec: 1_720_000_001,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeCloseTo(60_000, 0);
    expect(result!.publishTimeSec).toBe(1_720_000_001);
  });

  it('handles large price values (BTC-range) without overflow', () => {
    // BTC $65,432.10 with exponent -8 → raw = 6_543_210_000_000n
    const result = parsePriceUpdateV2(
      makeAccount({ priceRaw: 6_543_210_000_000n, exponent: -8, publishTimeSec: 1_720_000_000 }),
    );
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeCloseTo(65_432.1, 0);
  });

  it('handles small prices (sub-cent meme coins) correctly', () => {
    // $0.00012345 with exponent -10 → raw = 1_234_500n
    const result = parsePriceUpdateV2(
      makeAccount({ priceRaw: 1_234_500n, exponent: -10, publishTimeSec: 1_720_000_000 }),
    );
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBeCloseTo(0.00012345, 10);
  });
});

// ─── getPriceFeedAccountAddress ───────────────────────────────────────────────

describe('getPriceFeedAccountAddress', () => {
  // SOL/USD feed id (verified Pyth Hermes)
  const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

  it('returns a base58 PublicKey string for a valid 64-hex feed id', () => {
    const addr = getPriceFeedAccountAddress(SOL_FEED);
    expect(addr).toBeDefined();
    expect(addr.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('is deterministic — same feed id always produces the same address', () => {
    const a = getPriceFeedAccountAddress(SOL_FEED);
    const b = getPriceFeedAccountAddress(SOL_FEED);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it('produces different addresses for different feed ids', () => {
    const BTC_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
    const sol = getPriceFeedAccountAddress(SOL_FEED);
    const btc = getPriceFeedAccountAddress(BTC_FEED);
    expect(sol.toBase58()).not.toBe(btc.toBase58());
  });

  it('throws for a feed id shorter than 32 bytes', () => {
    expect(() => getPriceFeedAccountAddress('deadbeef')).toThrow();
  });

  it('throws for a feed id longer than 32 bytes', () => {
    expect(() => getPriceFeedAccountAddress('ab'.repeat(33))).toThrow();
  });
});

// ─── readFeedsAll — edge cases that don't require a real RPC ─────────────────

describe('readFeedsAll — no-RPC edge cases', () => {
  it('returns an empty Map for an empty input array', async () => {
    const result = await readFeedsAll([]);
    expect(result.size).toBe(0);
  });

  it('maps an invalid (short) feed id to null without throwing', async () => {
    const result = await readFeedsAll(['not-a-valid-feed']);
    expect(result.size).toBe(1);
    expect(result.get('not-a-valid-feed')).toBeNull();
  });

  it('maps multiple invalid feed ids to null', async () => {
    const result = await readFeedsAll(['bad1', 'bad2', 'bad3']);
    expect(result.size).toBe(3);
    for (const v of result.values()) expect(v).toBeNull();
  });
});
