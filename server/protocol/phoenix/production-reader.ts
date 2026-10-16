import { createHash } from 'node:crypto';
import { Connection, PublicKey, TransactionMessage, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { phoenixBaseUnitsToLots, PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { phoenixMarket, PHOENIX_MARKETS, type PhoenixMarket } from './markets';
import { protectionAddresses, assertProtectionSnapshot, type ProtectionSnapshot, type ProtectionLeg } from './protection-contract';
import { protectionInstruction } from './protection-builder';
import type { PhoenixOrderPin } from './order-builder';
import type { PhoenixOrderAuthority, PhoenixOrderIntent } from './order-contract';

const pk = (s: string) => new PublicKey(s);
const tag = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);
type Account = { owner: string; data: Buffer; executable: boolean };
function checked(a: Account | null, name: string, bytes: number): Buffer {
  if (!a || a.executable || a.owner !== PHOENIX_PUBLIC_ADDRESSES.program || a.data.length !== bytes
    || !a.data.subarray(0, 8).equals(tag(`account:${name}`))) throw new Error(`Phoenix ${name} account mismatch`);
  return a.data;
}
const keyAt = (b: Buffer, n: number) => new PublicKey(b.subarray(n, n + 32)).toBase58();
const abs = (n: bigint) => n < 0n ? -n : n;
function decimal(n: bigint, places: number) {
  const s = n.toString().padStart(places + 1, '0');
  return places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
}
export interface PhoenixReaderPin {
  logAuthority: string; globalConfiguration: string; perpAssetMap: string;
  globalTraderIndex: string[]; activeTraderBuffer: string[];
}
export function productionOrderPin(base: PhoenixReaderPin, market: string): PhoenixOrderPin {
  const m = phoenixMarket(market);
  return { ...base, market, assetId: m.assetId, orderbook: m.orderbook, splineCollection: m.splineCollection };
}
interface Position { assetId: number; base: bigint; virtualQuote: bigint; funding: bigint; sequence: number }
export function decodeProductionTrader(a: Account | null, identity: PhoenixTraderIdentity) {
  assertPhoenixIdentity(identity);
  const b = checked(a, 'trader', 5360);
  if (keyAt(b, 24) !== identity.traderAccountAddress || keyAt(b, 56) !== identity.authorityWalletAddress
    || b[154] !== 0 || b[155] !== 0 || b.readUInt32LE(112) !== 128 || b.readBigUInt64LE(232) !== 128n
    || b.readBigUInt64LE(224) > 128n) throw new Error('Unbound Phoenix trader');
  const positions: Position[] = [], seen = new Set<number>();
  for (let j = 0; j < Number(b.readBigUInt64LE(224)); j++) {
    const offset = 240 + j * 40, assetId = Number(b.readBigUInt64LE(offset) & 0xffffffffn);
    // Extensions (including native SOL collateral) are outside this phUSD-only canary.
    if (assetId >= 0xff000000 || seen.has(assetId)) throw new Error('Unsupported or duplicate trader entry');
    seen.add(assetId);
    positions.push({ assetId, base: b.readBigInt64LE(offset + 8), virtualQuote: b.readBigInt64LE(offset + 16),
      funding: b.readBigInt64LE(offset + 24), sequence: b[offset + 32] });
  }
  return { positions, collateral: b.readBigInt64LE(88), flags: b.readUInt32LE(96), sequence: b[101],
    conditionalBits: b.subarray(200, 224), feeMultiplier: b.readInt8(103), numSplines: b.readUInt16LE(152) };
}

// The 1024-entry perp map is a short map, NOT a market/orderbook address alias.
// Rise 0.6.1 static metadata layout, 16-byte symbol + 1568-byte value.
export function decodeProductionMetadata(a: Account | null, m: PhoenixMarket, slot: number) {
  const b = checked(a, 'perp_asset_map', 1622064), count = b.readUInt32LE(32);
  if (count > 1024 || b.readBigUInt64LE(40) !== 1024n) throw new Error('Invalid perp map capacity');
  const matches: number[] = [];
  for (let i = 0; i < count; i++) {
    const k = 48 + i * 1584, v = k + 16;
    if (b[v + 1450] !== 0 || b[v + 1567] !== 0) continue;
    if (b.subarray(k, k + 16).toString().replace(/\0+$/, '') === m.market) matches.push(v);
  }
  if (matches.length !== 1) throw new Error('Missing or duplicate perp market');
  const v = matches[0], assetId = b.readUInt16LE(v + 944) + (b.readUInt16LE(v + 948) << 16);
  if (keyAt(b, v + 904) !== m.orderbook || assetId !== m.assetId || b.readBigUInt64LE(v + 936).toString() !== m.tickSize
    || b.readInt8(v + 946) !== m.baseLotsDecimals || Boolean(b[v + 1208]) !== m.isolatedOnly) throw new Error('Perp metadata drift');
  const mark = b.readBigUInt64LE(v + 16), markSlot = b.readBigUInt64LE(v + 24);
  if (!mark || markSlot > BigInt(slot) || BigInt(slot) - markSlot > 12n) throw new Error('Oracle execution reference stale');
  const tiers = Array.from({ length: 4 }, (_, j) => ({ maxLots: b.readBigUInt64LE(v + 1016 + j * 24), leverage: b.readBigUInt64LE(v + 1024 + j * 24) }));
  return { mark, tiers, funding: b.readBigInt64LE(v + 1312), assetFlags: b[v + 1456],
    openInterest: b.readBigUInt64LE(v + 1424), openInterestCap: b.readBigUInt64LE(v + 1432) };
}
interface BookOrder { id: string; ticks: bigint; remaining: bigint; expirySlot: number; side: 'buy' | 'sell' }
export function decodeProductionBook(a: Account | null, m: PhoenixMarket) {
  const b = checked(a, 'orderbook', m.bookBytes);
  if (b.readUInt32LE(32) !== m.assetId || b.subarray(40, 56).toString().replace(/\0+$/, '') !== m.market
    || b.readBigUInt64LE(56).toString() !== m.tickSize || b.readInt8(9) !== m.baseLotsDecimals) throw new Error('Orderbook metadata drift');
  const orders: BookOrder[] = [];
  for (let side = 0; side < 2; side++) {
    const map = 5504 + side * 589856, size = b.readBigUInt64LE(map + 16);
    if (size > 8192n) throw new Error('Orderbook size invalid');
    let node = b.readUInt32LE(map); const seen = new Set<number>();
    while (node) {
      if (node > 8192 || seen.has(node) || seen.size >= Number(size)) throw new Error('Orderbook list incomplete');
      seen.add(node); const offset = map + 32 + (node - 1) * 72;
      const ticks = b.readBigUInt64LE(offset + 8), sequence = b.readBigUInt64LE(offset + 16), remaining = b.readBigUInt64LE(offset + 40);
      if (!ticks || !remaining || b.readUInt32LE(offset + 28) !== m.assetId) throw new Error('Invalid resting order');
      orders.push({ id: `${ticks}:${sequence}`, ticks, remaining, expirySlot: b.readUInt32LE(offset + 52), side: side === 0 ? 'buy' : 'sell' });
      node = b.readUInt32LE(offset + 4);
    }
    if (seen.size !== Number(size)) throw new Error('Orderbook list incomplete');
  }
  return { orders, status: b[8], takerFeePpm: b.readUInt32LE(96).toString(), lastSlot: b.readBigUInt64LE(24) };
}

export function decodeProductionSpline(a: Account | null, m: PhoenixMarket) {
  const b = checked(a, 'spline_collection', m.splineBytes);
  if (keyAt(b, 8) !== m.orderbook || b.subarray(40, 56).toString().replace(/\0+$/, '') !== m.market
    || b.readUInt32LE(76) > b.readUInt32LE(72) || b.readUInt32LE(72) * 1336 + 112 !== m.splineBytes) throw new Error('Spline market binding invalid');
}

export function decodeProductionProtection(a: Account | null, standalone: Account | null, trader: ReturnType<typeof decodeProductionTrader>,
  request: { identity: PhoenixTraderIdentity; market: string; assetId: number }, slot: number, mark: bigint, orderIds: string[], observedAt: number): ProtectionSnapshot {
  const addresses = protectionAddresses(request.identity.traderAccountAddress, request.assetId), legs: ProtectionLeg[] = [];
  const position = trader.positions.find(p => p.assetId === request.assetId), positionLots = abs(position?.base ?? 0n);
  let collectionSequence = '0', standaloneFunder: string | null = null;
  if (a) {
    if (a.data.length < 96) throw new Error('Conditional header truncated');
    const capacity = a.data[89], b = checked(a, 'conditional_order', 96 + capacity * 112);
    if (capacity !== 8 || keyAt(b, 8) !== request.identity.traderAccountAddress || b[88] > capacity) throw new Error('Unbound conditional collection');
    collectionSequence = b.readBigUInt64LE(72).toString();
    let occupied = 0;
    for (let i = 0; i < 192; i++) {
      const active = Boolean(trader.conditionalBits[i >> 3] & (1 << (i & 7)));
      const triggerActive = i < capacity && Boolean((b[96 + i * 112 + 81] | b[96 + i * 112 + 105]) & 1);
      if (active !== triggerActive) throw new Error('Conditional activity mismatch');
      if (!active) continue;
      if (!i || i >= capacity) throw new Error('Conditional occupancy exceeds allocation');
      occupied++; const o = 96 + i * 112, assetId = b.readUInt32LE(o + 56), max = b.readBigUInt64LE(o + 24), fillable = b.readBigUInt64LE(o + 32), filled = b.readBigUInt64LE(o + 40);
      for (let direction = 0; direction < 2; direction++) {
        const t = o + 64 + direction * 24, flags = b[t + 17];
        if (!(flags & 1)) continue;
        if (Boolean(flags & 2) !== (direction === 0)) throw new Error('Conditional direction drift');
        const percent = b[o + 61], usePercent = Boolean(b[o + 60] & 1);
        if (filled > fillable || fillable > max || usePercent && (percent < 1 || percent > 100)) throw new Error('Conditional fill accounting invalid');
        const available = usePercent && b.readBigUInt64LE(o + 16) === 0n ? positionLots * BigInt(percent) / 100n : fillable - filled;
        const remaining = available < positionLots ? available : positionLots;
        legs.push({ surface: 'conditional', index: i, sequence: b.readBigUInt64LE(o).toString(), assetId,
          parentOrderId: b.readBigUInt64LE(o + 16) === 0n ? null : `${b.readBigUInt64LE(o + 8)}:${b.readBigUInt64LE(o + 16)}`,
          positionSequence: b[t + 16], side: flags & 4 ? 'buy' : 'sell', direction: direction === 0 ? 'greater' : 'less', kind: flags & 8 ? 'Limit' : 'IOC',
          triggerTicks: b.readBigUInt64LE(t).toString(), executionTicks: b.readBigUInt64LE(t + 8).toString(), remainingLots: remaining.toString(),
          sizePercent: b[o + 60] & 1 ? percent : null, rawMaxLots: max.toString(), rawFillableLots: fillable.toString(), rawFilledLots: filled.toString() });
      }
    }
    if (occupied !== b[88]) throw new Error('Conditional occupancy incomplete');
  } else if (trader.conditionalBits.some(x => x !== 0)) throw new Error('Conditional collection missing with active bits');
  if (standalone) {
    const b = checked(standalone, 'stop_losses', 328);
    if (b.readBigUInt64LE(168) === 0n || keyAt(b, 224) !== request.identity.traderAccountAddress || b.readBigUInt64LE(256) !== BigInt(request.assetId)) throw new Error('Unbound standalone protection');
    standaloneFunder = keyAt(b, 192);
    for (let i = 0; i < 2; i++) {
      const o = 8 + i * 80, flags = b[o + 41]; if (!(flags & 1)) continue;
      legs.push({ surface: 'standalone', index: i, sequence: b.readBigUInt64LE(o).toString(), assetId: request.assetId, parentOrderId: null,
        positionSequence: b[o + 40], side: flags & 4 ? 'buy' : 'sell', direction: flags & 2 ? 'greater' : 'less', kind: flags & 8 ? 'Limit' : 'IOC',
        triggerTicks: b.readBigUInt64LE(o + 8).toString(), executionTicks: b.readBigUInt64LE(o + 16).toString(), remainingLots: (b.readBigUInt64LE(o + 24) < positionLots ? b.readBigUInt64LE(o + 24) : positionLots).toString(),
        sizePercent: null, rawMaxLots: b.readBigUInt64LE(o + 24).toString(), rawFillableLots: b.readBigUInt64LE(o + 24).toString(), rawFilledLots: '0' });
    }
  }
  const p = trader.positions.find(p => p.assetId === request.assetId);
  const snapshot: ProtectionSnapshot = { venue: 'phoenix', trader: request.identity.traderAccountAddress, market: request.market, assetId: request.assetId,
    ...addresses, conditionalExists: Boolean(a), standaloneFunder, finalized: true, complete: true, refreshFailed: false, source: 'phoenix-finalized-native-simulation',
    reference: `finalized:${slot}:${request.identity.traderAccountAddress}`, observedAt, slot: String(slot), markTicks: mark.toString(),
    position: { side: !p?.base ? 'flat' : p.base > 0n ? 'long' : 'short', baseLots: abs(p?.base ?? 0n).toString(), sequence: p?.sequence ?? trader.sequence,
      epoch: `${p?.sequence ?? trader.sequence}` }, collectionSequence, orderbookOrderIds: orderIds, legs };
  assertProtectionSnapshot(snapshot, request, Date.now()); return snapshot;
}

export function createPhoenixProductionReader(rpc: Connection, base: PhoenixReaderPin, verify: () => Promise<void>) {
  async function simulate(identity: PhoenixTraderIdentity, instructions: TransactionInstruction[], addresses: string[], minimumSlot: number) {
    const lifetime = await rpc.getLatestBlockhash('finalized');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(identity.authorityWalletAddress), recentBlockhash: lifetime.blockhash, instructions }).compileToLegacyMessage());
    const response = await rpc.simulateTransaction(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: minimumSlot,
      accounts: { encoding: 'base64', addresses } });
    if (response.value.err || !response.value.accounts || response.value.accounts.length !== addresses.length) throw new Error('Native reader simulation unavailable');
    return { slot: response.context.slot, accounts: response.value.accounts.map(a => a ? { owner: a.owner, executable: a.executable, data: Buffer.from(a.data[0], 'base64') } : null) };
  }
  async function read(identity: PhoenixTraderIdentity, market: string, side: 'buy' | 'sell', minimumSlot = '0', includeProtection = true, requireQuote = true, fullExposure = false) {
    const started = Date.now(), m = phoenixMarket(market); assertPhoenixIdentity(identity); await verify();
    const pin = productionOrderPin(base, market), addresses = protectionAddresses(identity.traderAccountAddress, m.assetId);
    const keys = [PHOENIX_PUBLIC_ADDRESSES.program, base.logAuthority, base.globalConfiguration, identity.traderAccountAddress, base.perpAssetMap,
      ...base.globalTraderIndex, ...base.activeTraderBuffer];
    const sync = new TransactionInstruction({ programId: pk(PHOENIX_PUBLIC_ADDRESSES.program), data: tag('global:update_trader_state'),
      keys: keys.map((s, i) => ({ pubkey: pk(s), isSigner: false, isWritable: i === 3 || i > 4 })) });
    const dataAddresses = [identity.traderAccountAddress, base.perpAssetMap, m.orderbook, m.splineCollection, addresses.conditionalAccount, addresses.standaloneAccount];
    const state = await simulate(identity, [sync], dataAddresses, Number(BigInt(minimumSlot)));
    const trader = decodeProductionTrader(state.accounts[0], identity), metadata = decodeProductionMetadata(state.accounts[1], m, state.slot);
    decodeProductionSpline(state.accounts[3], m);
    const book = decodeProductionBook(state.accounts[2], m);
    // Native cancellation in an unsigned simulation identifies this trader's nodes without a guessed GTI layout.
    // Require the identical finalized bank before comparing; these simulations never enter the sender/custody path.
    const markets = new Map([[m.assetId, m]]);
    for (const p of fullExposure ? trader.positions : []) {
      const other = PHOENIX_MARKETS.find(x => x.assetId === p.assetId);
      if (!other) throw new Error('Unreviewed cross-market exposure'); markets.set(other.assetId, other);
    }
    let exposure = 0n, marginReserve = 0n;
    let ownOrders: BookOrder[] = [];
    for (const other of markets.values()) {
      const otherPin = productionOrderPin(base, other.market);
      const before = other.assetId === m.assetId ? state : await simulate(identity, [sync], [other.orderbook, other.splineCollection], state.slot);
      if (before.slot !== state.slot) throw new Error('Finalized bank changed during exposure read');
      const otherBook = other.assetId === m.assetId ? book : decodeProductionBook(before.accounts[0], other);
      if (other.assetId !== m.assetId) decodeProductionSpline(before.accounts[1], other);
      const cancelled = await simulate(identity, [sync, protectionInstruction({ identity, market: other.market, assetId: other.assetId }, otherPin, { kind: 'cancel-book' })], [other.orderbook], state.slot);
      if (cancelled.slot !== state.slot) throw new Error('Finalized bank changed during order ownership read');
      const remaining = new Set(decodeProductionBook(cancelled.accounts[0], other).orders.map(o => o.id));
      const owned = otherBook.orders.filter(o => !remaining.has(o.id));
      if (decodeProductionBook(cancelled.accounts[0], other).orders.some(o => !otherBook.orders.some(b => b.id === o.id))) throw new Error('Orderbook comparison changed');
      if (other.assetId === m.assetId) ownOrders = owned;
      const meta = other.assetId === m.assetId ? metadata : decodeProductionMetadata(state.accounts[1], other, state.slot);
      const position = trader.positions.find(p => p.assetId === other.assetId);
      const notional = (abs(position?.base ?? 0n) + owned.reduce((n, o) => n + o.remaining, 0n)) * meta.mark * BigInt(other.tickSize);
      exposure += notional;
      // Conservative collateral-only reserve, with no credit for unrealized profit or unrecognized fee tiers.
      marginReserve += notional;
      if (position) { const pnl = position.virtualQuote + position.base * meta.mark * BigInt(other.tickSize); if (pnl < 0n) marginReserve -= pnl; }
      if (position?.base && position.funding !== meta.funding) {
        const owed = position.base * (meta.funding - position.funding); if (owed > 0n) marginReserve += owed;
      }
    }
    if (Date.now() - started >= 5000) throw new Error('Phoenix snapshot expired while reading');
    const observedAt = started, p = trader.positions.find(p => p.assetId === m.assetId);
    const quote = book.orders.filter(o => o.side !== side && (!o.expirySlot || o.expirySlot > state.slot)).map(o => o.ticks).sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
    const executable = side === 'buy' ? quote[0] : quote[quote.length - 1], ticks = requireQuote ? executable : metadata.mark;
    if (!ticks || requireQuote && (book.lastSlot > BigInt(state.slot) || BigInt(state.slot) - book.lastSlot > 12n)) throw new Error('Fresh executable orderbook quote unavailable');
    const protection = includeProtection ? decodeProductionProtection(state.accounts[4], state.accounts[5], trader, { identity, market, assetId: m.assetId }, state.slot, metadata.mark, ownOrders.map(o => o.id), observedAt) : undefined;
    const authority: PhoenixOrderAuthority = { venue: 'phoenix', trader: identity.traderAccountAddress, market, assetId: m.assetId,
      collateralMint: PHOENIX_PUBLIC_ADDRESSES.collateralMint, source: 'phoenix-finalized-native-simulation', reference: `finalized:${state.slot}:${m.orderbook}`, observedAt,
      refreshFailed: false, status: book.status === 1 ? 'active' : 'halted', isolatedOnly: m.isolatedOnly,
      tickSize: m.tickSize, baseLotsDecimals: m.baseLotsDecimals, slot: String(state.slot),
      price: { usd: decimal(m.baseLotsDecimals >= 0 ? ticks * BigInt(m.tickSize) * 10n ** BigInt(m.baseLotsDecimals) : ticks * BigInt(m.tickSize) / 10n ** BigInt(-m.baseLotsDecimals), 6), observedAt, source: 'phoenix-execution', reference: `finalized:${state.slot}:${m.orderbook}:${side}` },
      position: { observedAt, side: !p?.base ? 'flat' : p.base > 0n ? 'long' : 'short', baseLots: abs(p?.base ?? 0n).toString(), epoch: `${p?.sequence ?? trader.sequence}` },
      canaryExposureMicros: exposure.toString(), entry: null, protection };
    const free = trader.collateral > marginReserve ? trader.collateral - marginReserve : 0n;
    return { authority, metadata, book, free, trader, m };
  }
  return {
    read,
    async snapshot(i: PhoenixOrderIntent) {
      const r = await read(i.identity, i.market, i.side, '0', i.action === 'entry', true, i.action === 'entry');
      if (i.action === 'entry') {
        const lots = phoenixBaseUnitsToLots(i.baseUnits, r.m.baseLotsDecimals);
        const tier = r.metadata.tiers.find(t => t.maxLots >= lots && t.leverage > 0n);
        if (!tier || r.metadata.assetFlags !== 0 || r.trader.flags !== 63 || r.trader.numSplines !== 0 || r.trader.feeMultiplier > 0 || r.metadata.openInterest + lots > r.metadata.openInterestCap) throw new Error('Entry market/risk authority unavailable');
        r.authority.entry = { observedAt: r.authority.observedAt, minimumNotionalMicros: (r.metadata.mark * BigInt(r.m.tickSize)).toString(),
          maxNotionalMicros: (tier.maxLots * r.metadata.mark * BigInt(r.m.tickSize)).toString(), maxLeverage: tier.leverage.toString(),
          takerFeePpm: r.book.takerFeePpm, feeReference: `finalized:${r.authority.slot}:base fee, tier unknown`, feeObservedAt: r.authority.observedAt,
          freeMarginMicros: r.free.toString(), fundableMicros: '0', marginObservedAt: r.authority.observedAt };
      }
      return r.authority;
    },
    async protection(request: { identity: PhoenixTraderIdentity; market: string; assetId: number }, minimumSlot: string) {
      const r = await read(request.identity, request.market, 'sell', minimumSlot, true, false);
      if (r.m.assetId !== request.assetId) throw new Error('Protection asset mismatch'); return r.authority.protection!;
    },
  };
}
