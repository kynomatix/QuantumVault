import { describe, it, expect, beforeEach } from 'vitest';
import {
  getFeedList,
  getRecentSnapshots,
  _clearRingForTest,
  _pushRingForTest,
  isOracleSnapshotRecorderEnabled,
  type SnapshotEntry,
} from '../../server/vault/oracle-snapshot-recorder';

// Known feed ids from borrow-oracle-registry (verified in source).
const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const INF_FEED = 'f51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f';

// Known Flash-only crypto feed (not in borrow registry).
const BTC_FLASH_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

beforeEach(() => {
  _clearRingForTest();
});

// ─── getFeedList — shape and content ─────────────────────────────────────────

describe('getFeedList', () => {
  it('returns a non-empty array', () => {
    expect(getFeedList().length).toBeGreaterThan(0);
  });

  it('contains the SOL/USD borrow-gate feed', () => {
    const ids = getFeedList().map((f) => f.feedId);
    expect(ids).toContain(SOL_FEED);
  });

  it('contains the INF borrow-gate feed', () => {
    const ids = getFeedList().map((f) => f.feedId);
    expect(ids).toContain(INF_FEED);
  });

  it('marks borrow-gate feeds with isBorrowFeed=true', () => {
    const solEntry = getFeedList().find((f) => f.feedId === SOL_FEED);
    expect(solEntry).toBeDefined();
    expect(solEntry!.isBorrowFeed).toBe(true);

    const infEntry = getFeedList().find((f) => f.feedId === INF_FEED);
    expect(infEntry).toBeDefined();
    expect(infEntry!.isBorrowFeed).toBe(true);
  });

  it('contains the BTC Flash crypto feed', () => {
    const ids = getFeedList().map((f) => f.feedId);
    expect(ids).toContain(BTC_FLASH_FEED);
  });

  it('marks Flash-only feeds with isBorrowFeed=false', () => {
    const btcEntry = getFeedList().find((f) => f.feedId === BTC_FLASH_FEED);
    expect(btcEntry).toBeDefined();
    expect(btcEntry!.isBorrowFeed).toBe(false);
  });

  it('deduplicates the SOL/USD feed (appears in borrow registry as proxy for JupSOL/dfdvSOL too)', () => {
    const ids = getFeedList().map((f) => f.feedId);
    const solCount = ids.filter((id) => id === SOL_FEED).length;
    expect(solCount).toBe(1);
  });

  it('has no empty feed ids', () => {
    for (const f of getFeedList()) {
      expect(f.feedId.length).toBeGreaterThan(0);
    }
  });

  it('all feed ids are 64-char hex strings (32 bytes)', () => {
    for (const f of getFeedList()) {
      expect(f.feedId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('has no duplicate feed ids', () => {
    const ids = getFeedList().map((f) => f.feedId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ─── getRecentSnapshots — ring queries ───────────────────────────────────────

describe('getRecentSnapshots', () => {
  it('returns an empty array when the ring is empty', () => {
    expect(getRecentSnapshots()).toHaveLength(0);
    expect(getRecentSnapshots(SOL_FEED)).toHaveLength(0);
  });

  it('returns pushed entries', () => {
    const entry: SnapshotEntry = {
      feedId: SOL_FEED,
      symbol: 'SOL',
      priceUsd: 123.45,
      publishTimeSec: 1_720_000_000,
      takenAt: new Date(),
    };
    _pushRingForTest(entry);
    const results = getRecentSnapshots();
    expect(results).toHaveLength(1);
    expect(results[0].feedId).toBe(SOL_FEED);
    expect(results[0].priceUsd).toBe(123.45);
  });

  it('filters by feedId', () => {
    _pushRingForTest({
      feedId: SOL_FEED,
      symbol: 'SOL',
      priceUsd: 100,
      publishTimeSec: 1_720_000_000,
      takenAt: new Date(),
    });
    _pushRingForTest({
      feedId: BTC_FLASH_FEED,
      symbol: 'BTC',
      priceUsd: 60_000,
      publishTimeSec: 1_720_000_001,
      takenAt: new Date(),
    });

    const solOnly = getRecentSnapshots(SOL_FEED);
    expect(solOnly).toHaveLength(1);
    expect(solOnly[0].feedId).toBe(SOL_FEED);

    const btcOnly = getRecentSnapshots(BTC_FLASH_FEED);
    expect(btcOnly).toHaveLength(1);
    expect(btcOnly[0].feedId).toBe(BTC_FLASH_FEED);
  });

  it('filters out entries older than sinceMs', () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    const fresh = new Date();

    _pushRingForTest({
      feedId: SOL_FEED,
      symbol: 'SOL',
      priceUsd: 99,
      publishTimeSec: 1_720_000_000,
      takenAt: old,
    });
    _pushRingForTest({
      feedId: SOL_FEED,
      symbol: 'SOL',
      priceUsd: 101,
      publishTimeSec: 1_720_000_100,
      takenAt: fresh,
    });

    const sinceMs = Date.now() - 60 * 60 * 1000; // only last 1h
    const results = getRecentSnapshots(SOL_FEED, sinceMs);
    expect(results).toHaveLength(1);
    expect(results[0].priceUsd).toBe(101);
  });

  it('returns all entries within sinceMs when feedId is omitted', () => {
    const now = new Date();
    _pushRingForTest({ feedId: SOL_FEED, symbol: 'SOL', priceUsd: 100, publishTimeSec: 1_720_000_000, takenAt: now });
    _pushRingForTest({ feedId: BTC_FLASH_FEED, symbol: 'BTC', priceUsd: 60000, publishTimeSec: 1_720_000_001, takenAt: now });

    expect(getRecentSnapshots()).toHaveLength(2);
  });

  it('_clearRingForTest empties the ring', () => {
    _pushRingForTest({
      feedId: SOL_FEED,
      symbol: 'SOL',
      priceUsd: 100,
      publishTimeSec: 1_720_000_000,
      takenAt: new Date(),
    });
    expect(getRecentSnapshots()).toHaveLength(1);
    _clearRingForTest();
    expect(getRecentSnapshots()).toHaveLength(0);
  });
});

// ─── isOracleSnapshotRecorderEnabled ─────────────────────────────────────────

describe('isOracleSnapshotRecorderEnabled', () => {
  it('returns true when ORACLE_SNAPSHOT_DISABLED is not set', () => {
    const prev = process.env.ORACLE_SNAPSHOT_DISABLED;
    delete process.env.ORACLE_SNAPSHOT_DISABLED;
    expect(isOracleSnapshotRecorderEnabled()).toBe(true);
    if (prev !== undefined) process.env.ORACLE_SNAPSHOT_DISABLED = prev;
  });

  it('returns false when ORACLE_SNAPSHOT_DISABLED=true', () => {
    const prev = process.env.ORACLE_SNAPSHOT_DISABLED;
    process.env.ORACLE_SNAPSHOT_DISABLED = 'true';
    expect(isOracleSnapshotRecorderEnabled()).toBe(false);
    if (prev !== undefined) process.env.ORACLE_SNAPSHOT_DISABLED = prev;
    else delete process.env.ORACLE_SNAPSHOT_DISABLED;
  });

  it('returns true when ORACLE_SNAPSHOT_DISABLED is set to something other than "true"', () => {
    const prev = process.env.ORACLE_SNAPSHOT_DISABLED;
    process.env.ORACLE_SNAPSHOT_DISABLED = 'false';
    expect(isOracleSnapshotRecorderEnabled()).toBe(true);
    if (prev !== undefined) process.env.ORACLE_SNAPSHOT_DISABLED = prev;
    else delete process.env.ORACLE_SNAPSHOT_DISABLED;
  });
});
