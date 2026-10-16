import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { FundingReceipt } from './funding-contract';
import type { PhoenixFundingPin } from './funding-builder';
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from './sdk-boundary';

export const fundingTag = (name: string) => createHash('sha256').update(name).digest().subarray(0, 8);
export const fundingAta = (owner: string, mint: string) => PublicKey.findProgramAddressSync([
  new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer(),
], ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58();

/** Pinned Rust layout: 120-byte header, deque/allocator, 2,048 one-based nodes.
 * Only active deque members can describe a current generation. Freed bytes are ignored. */
export function decodeFundingQueue(data: Buffer) {
  if (data.length !== 213136 || !data.subarray(0, 8).equals(fundingTag('account:withdraw_queue'))) throw new Error('PHOENIX_QUEUE_LAYOUT');
  const size = Number(data.readBigUInt64LE(128));
  if (size > 2048 || data.readUInt32LE(136) > 2049) throw new Error('PHOENIX_QUEUE_LAYOUT');
  const nodes = []; const seen = new Set<number>();
  let pointer = data.readUInt32LE(120), previous = 0;
  while (pointer) {
    if (pointer > 2048 || seen.has(pointer) || nodes.length >= size) throw new Error('PHOENIX_QUEUE_LINKS');
    seen.add(pointer); const offset = 144 + (pointer - 1) * 104;
    if (data.readUInt32LE(offset) !== previous) throw new Error('PHOENIX_QUEUE_LINKS');
    const r = offset + 8;
    nodes.push({ nodeIndex: pointer, position: nodes.length + 1, trader: new PublicKey(data.subarray(r, r + 32)).toBase58(),
      wallet: new PublicKey(data.subarray(r + 32, r + 64)).toBase58(), amount: data.readBigUInt64LE(r + 64).toString(),
      enqueueSlot: data.readBigUInt64LE(r + 72).toString(), transitionCount: data.readUInt16LE(r + 88), state: data[r + 90], reason: data[r + 91] });
    previous = pointer; pointer = data.readUInt32LE(offset + 4);
  }
  if (nodes.length !== size || previous !== data.readUInt32LE(124)) throw new Error('PHOENIX_QUEUE_LINKS');
  return { withdrawalFee: data.readBigUInt64LE(64).toString(), enqueuingFee: data.readBigUInt64LE(72).toString(),
    remainingBudget: data.readBigUInt64LE(32).toString(), totalQueuedAmount: data.readBigUInt64LE(56).toString(), nodes };
}
export function observeFundingQueue(queue: ReturnType<typeof decodeFundingQueue>, anchor: NonNullable<FundingReceipt['queueAnchor']>, slot: string): NonNullable<FundingReceipt['queueObservation']> {
  const node = queue.nodes.find(n => n.nodeIndex === anchor.nodeIndex && n.trader === anchor.trader && n.wallet === anchor.wallet
    && n.amount === anchor.amount && n.enqueueSlot === anchor.enqueueSlot && n.transitionCount >= anchor.transitionCount);
  const states = ['Pending', 'Queued', 'Processing', 'Waiting', 'Processed', 'Rejected', 'Dropped', 'Canceled'];
  return { position: node?.position ?? null, state: node ? states[node.state] ?? 'Unknown' : 'Unknown (generation not established)',
    reason: node?.reason ?? null, observedSlot: slot };
}

export interface FundingChainInstruction { program: string; accounts: string[]; data: Buffer; depth: number }
export interface FundingWithdrawEvent {
  variant: number; trader: string; wallet?: string; amount: string; position: string;
  from?: number; to?: number; reason?: number; count?: number; node?: number;
}
/** Safety receipts support the pinned framed event format only. Unknown framing fails closed.
 * Events must be self-CPIs directly below OUR native Phoenix withdrawal instruction. */
export function decodeFundingWithdrawEvents(inner: FundingChainInstruction[], pin: PhoenixFundingPin): FundingWithdrawEvent[] {
  const batches = new Map<number, number[]>(), result: FundingWithdrawEvent[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ix = inner[i], d = ix.data;
    if (ix.program !== addresses.program) continue;
    if (ix.depth !== 2 || ix.accounts.length !== 1 || ix.accounts[0] !== pin.logAuthority || d.length < 16) throw new Error('PHOENIX_EVENT_PARENT');
    const batch = d.readUInt32LE(8), count = d.readUInt32LE(12);
    if (d.subarray(0, 8).equals(fundingTag('global:log_event_lengths'))) {
      if (count > 1024 || d.length !== 16 + count * 2 || batches.has(batch)) throw new Error('PHOENIX_EVENT_LENGTHS');
      batches.set(batch, Array.from({ length: count }, (_, n) => d.readUInt16LE(16 + n * 2))); continue;
    }
    if (!d.subarray(0, 8).equals(fundingTag('global:log'))) throw new Error('PHOENIX_EVENT_INSTRUCTION');
    const lengths = batches.get(batch); batches.delete(batch);
    if (!lengths || lengths.length !== count) throw new Error('PHOENIX_EVENT_FRAMING');
    let offset = 16;
    lengths.forEach((length, eventIndex) => {
      if (length < 1 || offset + length > d.length) throw new Error('PHOENIX_EVENT_FRAMING');
      const e = d.subarray(offset, offset + length); offset += length;
      if (![14, 15, 16, 17, 36, 43].includes(e[0])) return;
      const transition = e[0] === 36, short = [17, 43].includes(e[0]);
      if (length !== (transition ? 50 : short ? 105 : 129)) throw new Error('PHOENIX_EVENT_PAYLOAD');
      result.push({ variant: e[0], trader: new PublicKey(e.subarray(1, 33)).toBase58(),
        amount: e.readBigUInt64LE(transition ? 33 : 65).toString(), position: `${i}:${batch}:${eventIndex}`,
        ...(transition ? { from: e[41], to: e[42], reason: e[43], count: e.readUInt16LE(44), node: e.readUInt32LE(46) }
          : { wallet: new PublicKey(e.subarray(33, 65)).toBase58() }) });
    });
    if (offset !== d.length) throw new Error('PHOENIX_EVENT_FRAMING');
  }
  if (batches.size) throw new Error('PHOENIX_EVENT_FRAMING');
  return result;
}

export function verifyFundingWithdrawal(inner: FundingChainInstruction[], pin: PhoenixFundingPin,
  expected: { trader: string; wallet: string; amount: string; fee: string; signature: string; slot: string; instructionIndex: number }) {
  const all = decodeFundingWithdrawEvents(inner, pin);
  // A foreign trader/authority event in the same invocation is not an exact receipt.
  if (all.some(e => e.trader !== expected.trader || (e.wallet && e.wallet !== expected.wallet))) throw new Error('PHOENIX_EVENT_IDENTITY');
  const transitions = all.filter(e => e.variant === 36), fees = all.filter(e => e.variant === 43);
  if (transitions.length !== 1 || transitions[0].amount !== expected.amount) throw new Error('PHOENIX_WITHDRAW_PROOF');
  const observedFeeBaseUnits = fees.reduce((sum, e) => sum + BigInt(e.amount), 0n).toString();
  const transition = transitions[0];
  const transfer = inner.filter(ix => ix.program === TOKEN_PROGRAM_ID.toBase58() && [3, 12].includes(ix.data[0]));
  if (transition.from === 0 && transition.to === 4 && transition.reason === 0 && transition.count === 1 && transition.node === 0) {
    const paid = all.filter(e => e.variant === 14);
    const ix = transfer[0];
    if (observedFeeBaseUnits !== expected.fee || paid.length !== 1 || paid[0].amount !== expected.amount || all.some(e => [15, 16, 17].includes(e.variant))
      || transfer.length !== 1 || ix.depth !== 2 || ix.data[0] !== 3 || ix.data.length !== 9 || ix.accounts.length !== 3
      || ix.accounts[0] !== pin.globalVault || ix.accounts[1] !== fundingAta(expected.wallet, addresses.collateralMint)
      || ix.accounts[2] !== pin.globalVault || ix.data.readBigUInt64LE(1).toString() !== expected.amount) throw new Error('PHOENIX_WITHDRAW_TRANSFER');
    return { outcome: 'settled' as const };
  }
  const enqueued = all.filter(e => e.variant === 15);
  if (transition.from !== 0 || ![1, 3].includes(transition.to!) || !transition.node || transition.node > 2048
    || transition.count !== 1 || enqueued.length !== 1 || enqueued[0].amount !== expected.amount || transfer.length
    || all.some(e => [14, 16, 17].includes(e.variant))) throw new Error('PHOENIX_ENQUEUE_PROOF');
  const anchor: NonNullable<FundingReceipt['queueAnchor']> = { signature: expected.signature,
    instructionPath: `outer:${expected.instructionIndex}`, eventPosition: enqueued[0].position,
    trader: expected.trader, wallet: expected.wallet, amount: expected.amount, enqueueSlot: expected.slot,
    nodeIndex: transition.node, transitionCount: transition.count };
  return { outcome: 'queued' as const, queueAnchor: anchor, observedFeeBaseUnits, feeUnexpected: observedFeeBaseUnits !== expected.fee,
    queueRequestId: createHash('sha256').update(JSON.stringify(anchor)).digest('hex') };
}
