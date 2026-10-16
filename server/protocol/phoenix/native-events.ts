import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

// Rise 0.6.1 rust/events. Length framing is mandatory: never guess past an unknown event.
// sourceCommitHash: 573b773a6a7b38f941aed3a6f0602bc648346114
export function phoenixEvents(transaction: any): Buffer[] {
  const message = transaction.transaction.message;
  const keys: PublicKey[] = message.staticAccountKeys ?? message.accountKeys;
  const loaded = transaction.meta?.loadedAddresses;
  const addresses = [...keys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map(k => k.toBase58());
  const result: Buffer[] = [];
  for (const group of transaction.meta?.innerInstructions ?? []) {
    const instructions: Buffer[] = group.instructions.filter((i: any) => addresses[i.programIdIndex] === PHOENIX_PUBLIC_ADDRESSES.program)
      .map((i: any) => Buffer.from(bs58.decode(i.data)));
    const lengths = new Map<number, number[][]>();
    for (const b of instructions) {
      if (b.length < 8 || b.readBigUInt64LE() !== 0x479947b5cb8607f7n) continue;
      if (b.length < 16 || b.length !== 16 + 2 * b.readUInt32LE(12)) throw new Error('Incomplete Phoenix event lengths');
      const batch = b.readUInt32LE(8), list = lengths.get(batch) ?? [];
      list.push(Array.from({ length: b.readUInt32LE(12) }, (_, j) => b.readUInt16LE(16 + j * 2)));
      lengths.set(batch, list);
    }
    for (const b of instructions) {
      if (b.length < 8 || b.readBigUInt64LE() !== 0xaacfd109f2d6e68dn) continue;
      if (b.length < 16) throw new Error('Incomplete Phoenix event batch');
      const sizes = lengths.get(b.readUInt32LE(8))?.shift();
      if (!sizes || sizes.length !== b.readUInt32LE(12)) throw new Error('Unframed Phoenix event batch');
      let offset = 16;
      for (const size of sizes) {
        if (!size || offset + size > b.length) throw new Error('Truncated Phoenix event');
        result.push(b.subarray(offset, offset + size)); offset += size;
      }
      if (offset !== b.length) throw new Error('Trailing Phoenix event data');
    }
    if ([...lengths.values()].some(q => q.length)) throw new Error('Missing Phoenix event batch');
  }
  if (!result.length) throw new Error('Phoenix event evidence unavailable');
  return result;
}

export function actualPhoenixTrade(transaction: any, trader: string, market: string, assetId: number, side: 'buy' | 'sell') {
  let header = false;
  const summaries: { sequence: string; baseLots: string; quoteMicros: string; feeMicros: string }[] = [];
  for (const e of phoenixEvents(transaction)) {
    if (e[0] === 1) {
      if (e.length !== 107) throw new Error('Unexpected market header layout');
      header = e.subarray(17, 33).toString().replace(/\0+$/, '') === market && e.readUInt32LE(33) === assetId
        && new PublicKey(e.subarray(75, 107)).toBase58() === trader;
    } else if (e[0] === 6) {
      if (e.length !== 106) throw new Error('Unexpected trade summary layout');
      if (!header || new PublicKey(e.subarray(1, 33)).toBase58() !== trader) continue;
      if (e[49] !== (side === 'buy' ? 0 : 1)) throw new Error('Trade direction mismatch');
      summaries.push({ sequence: e.readBigUInt64LE(33).toString(), baseLots: e.readBigUInt64LE(50).toString(),
        quoteMicros: e.readBigUInt64LE(58).toString(), feeMicros: e.readBigUInt64LE(66).toString() });
    }
  }
  // A missing summary is unknown, including a zero-fill IOC; submission is never fill evidence.
  if (summaries.length !== 1) throw new Error('Unambiguous actual fill evidence unavailable');
  return summaries[0];
}
