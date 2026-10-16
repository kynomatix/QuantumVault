import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { identity, intent, pin, lifetime } from '../helpers/phoenix-orders';
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from '../../server/protocol/phoenix/sdk-boundary';
import { PHOENIX_MARKETS, phoenixMarket } from '../../server/protocol/phoenix/markets';
import { actualPhoenixTrade, phoenixEvents } from '../../server/protocol/phoenix/native-events';
import { createPhoenixProductionReader, decodeProductionBook, decodeProductionMetadata, decodeProductionProtection, decodeProductionSpline, decodeProductionTrader } from '../../server/protocol/phoenix/production-reader';

const m = phoenixMarket('SOL');
function account(name: string, bytes: number) {
  const data = Buffer.alloc(bytes); createHash('sha256').update(`account:${name}`).digest().copy(data, 0, 0, 8);
  return { owner: addresses.program, executable: false, data };
}
function fixture() {
  const trader = account('trader', 5360), b = trader.data;
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(b, 24);
  new PublicKey(identity.authorityWalletAddress).toBuffer().copy(b, 56);
  b.writeBigInt64LE(1_000_000_000n, 88); b.writeUInt32LE(63, 96); b[101] = 1;
  b.writeUInt32LE(128, 112); b.writeBigUInt64LE(128n, 232); b.writeBigUInt64LE(1n, 224);
  b.writeBigUInt64LE(BigInt(m.assetId), 240); b.writeBigInt64LE(200n, 248); b[272] = 1;
  const metadata = account('perp_asset_map', 1622064), p = metadata.data, v = 64;
  p.writeUInt32LE(1, 32); p.writeBigUInt64LE(1024n, 40); p.write(m.market, 48);
  p.writeBigUInt64LE(15000n, v + 16); p.writeBigUInt64LE(100n, v + 24);
  new PublicKey(m.orderbook).toBuffer().copy(p, v + 904); p.writeBigUInt64LE(BigInt(m.tickSize), v + 936);
  p.writeUInt16LE(m.assetId & 65535, v + 944); p.writeInt8(m.baseLotsDecimals, v + 946); p.writeUInt16LE(m.assetId >>> 16, v + 948);
  for (let i = 0; i < 4; i++) { p.writeBigUInt64LE(1000000n * BigInt(i + 1), v + 1016 + i * 24); p.writeBigUInt64LE(20n, v + 1024 + i * 24); }
  p.writeBigUInt64LE(1_000_000_000n, v + 1432);
  const book = account('orderbook', m.bookBytes), o = book.data;
  o[8] = 1; o.writeInt8(m.baseLotsDecimals, 9); o.writeBigUInt64LE(100n, 24); o.writeUInt32LE(m.assetId, 32);
  o.write(m.market, 40); o.writeBigUInt64LE(BigInt(m.tickSize), 56); o.writeUInt32LE(350, 96);
  for (let side = 0; side < 2; side++) {
    const map = 5504 + side * 589856, node = map + 32;
    o.writeUInt32LE(1, map); o.writeBigUInt64LE(1n, map + 16);
    o.writeBigUInt64LE(BigInt(side ? 15100 : 14900), node + 8); o.writeBigUInt64LE(BigInt(side + 1), node + 16);
    o.writeUInt32LE(m.assetId, node + 28); o.writeBigUInt64LE(1000n, node + 32); o.writeBigUInt64LE(1000n, node + 40);
  }
  const spline = account('spline_collection', m.splineBytes);
  new PublicKey(m.orderbook).toBuffer().copy(spline.data, 8); spline.data.write(m.market, 40);
  spline.data.writeUInt32LE((m.splineBytes - 112) / 1336, 72);
  const conditional = account('conditional_order', 992);
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(conditional.data, 8); conditional.data[89] = 8;
  return { trader, metadata, book, spline, conditional };
}
function transaction(events: Buffer[]) {
  const log = Buffer.alloc(16); log.writeBigUInt64LE(0xaacfd109f2d6e68dn); log.writeUInt32LE(events.length, 12);
  const lengths = Buffer.alloc(16 + 2 * events.length); lengths.writeBigUInt64LE(0x479947b5cb8607f7n); lengths.writeUInt32LE(events.length, 12);
  events.forEach((e, i) => lengths.writeUInt16LE(e.length, 16 + i * 2));
  return { transaction: { message: { accountKeys: [new PublicKey(addresses.program)] } }, meta: { innerInstructions: [{ index: 0, instructions: [lengths, Buffer.concat([log, ...events])].map(data => ({ programIdIndex: 0, data: bs58.encode(data) })) }] } };
}
function tradeEvents() {
  const header = Buffer.alloc(107); header[0] = 1; header.write(m.market, 17); header.writeUInt32LE(m.assetId, 33);
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(header, 75);
  const summary = Buffer.alloc(106); summary[0] = 6; new PublicKey(identity.traderAccountAddress).toBuffer().copy(summary, 1);
  summary.writeBigUInt64LE(7n, 33); summary.writeBigUInt64LE(123n, 50); summary.writeBigUInt64LE(184500000n, 58); summary.writeBigUInt64LE(64575n, 66);
  return [header, summary];
}

describe('UNIT2C1 pinned native production authority', () => {
  it('lists the reviewed 99 unique books and keeps ten isolated-only markets explicit', () => {
    expect(PHOENIX_MARKETS).toHaveLength(99); expect(PHOENIX_MARKETS.filter(x => x.isolatedOnly)).toHaveLength(10);
    expect(new Set(PHOENIX_MARKETS.map(x => x.assetId)).size).toBe(99);
    expect(() => phoenixMarket('UNREVIEWED')).toThrow();
  });
  it('reads exact trader, metadata, one-based book nodes and bound spline accounts', () => {
    const f = fixture(); expect(decodeProductionTrader(f.trader, identity).positions[0].base).toBe(200n);
    expect(decodeProductionMetadata(f.metadata, m, 100).mark).toBe(15000n);
    expect(decodeProductionBook(f.book, m).orders.map(x => x.ticks)).toEqual([14900n, 15100n]);
    expect(() => decodeProductionSpline(f.spline, m)).not.toThrow();
    f.spline.data.fill(0, 8, 40); expect(() => decodeProductionSpline(f.spline, m)).toThrow('binding');
  });
  it('refuses account owner/size, stale metadata, map alias and torn order lists', () => {
    const f = fixture(); expect(() => decodeProductionTrader({ ...f.trader, owner: identity.authorityWalletAddress }, identity)).toThrow();
    expect(() => decodeProductionBook({ ...f.book, data: f.book.data.subarray(1) }, m)).toThrow();
    expect(() => decodeProductionMetadata(f.metadata, m, 113)).toThrow('stale');
    f.metadata.data.fill(0, 64 + 904, 64 + 936); expect(() => decodeProductionMetadata(f.metadata, m, 100)).toThrow('drift');
    f.book.data.writeUInt32LE(1, 5504 + 32 + 4); expect(() => decodeProductionBook(f.book, m)).toThrow('incomplete');
  });
  it('sizes position-percent protection from the current position and refuses inconsistent occupancy', () => {
    const f = fixture(), b = f.conditional.data, o = 208;
    f.trader.data[200] = 2; b[88] = 1; b.writeBigUInt64LE(5n, o); b.writeUInt32LE(m.assetId, o + 56);
    b[o + 60] = 1; b[o + 61] = 100; b.writeBigUInt64LE(14000n, o + 88); b.writeBigUInt64LE(12600n, o + 96); b[o + 104] = 1; b[o + 105] = 1;
    const read = () => decodeProductionProtection(f.conditional, null, decodeProductionTrader(f.trader, identity), { identity, market: m.market, assetId: m.assetId }, 100, 15000n, [], Date.now());
    expect(read().legs[0]).toMatchObject({ remainingLots: '200', sizePercent: 100, direction: 'less', side: 'sell', kind: 'IOC' });
    f.trader.data[200] = 0; expect(read).toThrow('activity mismatch');
  });
  it('reads cancellation with an empty book while execution requires fresh executable liquidity', async () => {
    const f = fixture(); f.book.data.fill(0, 5504); // Preserve the pinned header, empty both maps.
    const result = (accounts: any[]) => ({ context: { slot: 100 }, value: { err: null, accounts: accounts.map(a => a && ({ ...a, data: [a.data.toString('base64'), 'base64'] })) } });
    const rpc = { getLatestBlockhash: async () => lifetime, simulateTransaction: async (_tx: any, options: any) => {
      expect(options.sigVerify).toBe(false); expect(options.commitment).toBe('finalized');
      return options.accounts.addresses.length === 1 ? result([f.book]) : result([f.trader, f.metadata, f.book, f.spline, f.conditional, null]);
    } } as any;
    const reader = createPhoenixProductionReader(rpc, pin, async () => {});
    expect((await reader.protection({ identity, market: m.market, assetId: m.assetId }, '100')).orderbookOrderIds).toEqual([]);
    await expect(reader.snapshot(intent())).rejects.toThrow('executable');
  });
  it('uses status one as active, exact book execution price and labelled base taker fees', async () => {
    const f = fixture();
    const rpc = { getLatestBlockhash: async () => lifetime, simulateTransaction: async (_tx: any, o: any) => ({ context: { slot: 100 }, value: { err: null,
      accounts: (o.accounts.addresses.length === 1 ? [f.book] : [f.trader, f.metadata, f.book, f.spline, f.conditional, null]).map(a => a && ({ ...a, data: [a.data.toString('base64'), 'base64'] })) } }) } as any;
    const a = await createPhoenixProductionReader(rpc, pin, async () => {}).snapshot(intent());
    expect(a.status).toBe('active'); expect(a.collateralMint).toBe(addresses.collateralMint); expect(a.entry?.fundableMicros).toBe('0');
    expect(a.entry?.feeReference).toContain('base fee, tier unknown'); expect(a.entry?.takerFeePpm).toBe('350');
    expect(a.price.usd).not.toBe('0');
  });
});

describe('UNIT2C1 finalized native fill evidence', () => {
  it('extracts actual partial quantities, quote and fee from framed TradeSummary', () => {
    expect(actualPhoenixTrade(transaction(tradeEvents()), identity.traderAccountAddress, m.market, m.assetId, 'buy'))
      .toEqual({ sequence: '7', baseLots: '123', quoteMicros: '184500000', feeMicros: '64575' });
  });
  it('refuses acceptance without fill evidence, another trader, wrong side and duplicate summaries', () => {
    const events = tradeEvents();
    expect(() => actualPhoenixTrade(transaction([events[0]]), identity.traderAccountAddress, m.market, m.assetId, 'buy')).toThrow();
    expect(() => actualPhoenixTrade(transaction(events), identity.authorityWalletAddress, m.market, m.assetId, 'buy')).toThrow();
    expect(() => actualPhoenixTrade(transaction(events), identity.traderAccountAddress, m.market, m.assetId, 'sell')).toThrow('direction');
    expect(() => actualPhoenixTrade(transaction([...events, events[1]]), identity.traderAccountAddress, m.market, m.assetId, 'buy')).toThrow('Unambiguous');
  });
  it('refuses unframed and truncated log batches rather than guessing event sizes', () => {
    const tx = transaction(tradeEvents()); tx.meta.innerInstructions[0].instructions.shift(); expect(() => phoenixEvents(tx)).toThrow('Unframed');
    const torn = transaction(tradeEvents()), ix = torn.meta.innerInstructions[0].instructions[1];
    ix.data = bs58.encode(bs58.decode(ix.data).subarray(0, -1)); expect(() => phoenixEvents(torn)).toThrow('Truncated');
  });
});
