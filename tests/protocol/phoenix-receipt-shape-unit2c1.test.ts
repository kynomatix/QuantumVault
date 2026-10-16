import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Message, MessageV0, PublicKey, type ConnectionConfig } from '@solana/web3.js';
import bs58 from 'bs58';
import { authority, identity, intent, key, now, pin } from '../helpers/phoenix-orders';
import { createPhoenixExecutionProduction } from '../../server/protocol/phoenix/execution-production';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { phoenixEvents, actualPhoenixTrade } from '../../server/protocol/phoenix/native-events';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { phoenixMarket } from '../../server/protocol/phoenix/markets';
import { admitPhoenixOrder, orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import type { PhoenixOrderRecord } from '../../server/protocol/phoenix/order-store';
import type { PhoenixOrderIO } from '../../server/protocol/phoenix/order-service';
import type { ProtectionIO } from '../../server/protocol/phoenix/protection-service';
import { request } from '../helpers/phoenix-protection';

vi.mock('../../server/protocol/phoenix/custody', () => ({ withPhoenixBotSigner: vi.fn() }));

// Unmodified mainnet JSON-RPC capture. This is a maintenance crank, NOT a trade.
const captured = JSON.parse(readFileSync('tests/fixtures/phoenix-finalized-maintenance-rpc.json', 'utf8'));
const signature = captured.result.transaction.signatures[0];
const digest = (message: Message | MessageV0) => createHash('sha256').update(message.serialize()).digest('hex');

function transport(raw = structuredClone(captured.result), statusPatch: Record<string, unknown> = {}) {
  const calls: { method: string; params: any[] }[] = [];
  const fetch: ConnectionConfig['fetch'] = async (_url, init) => {
    const body = JSON.parse(init!.body as string); calls.push(body);
    let result;
    if (body.method === 'getTransaction') {
      expect(body.params).toEqual([signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      result = raw;
    } else {
      expect(body.method).toBe('getSignatureStatuses');
      expect(body.params).toEqual([[signature], { searchTransactionHistory: true }]);
      result = { context: { slot: captured.result.slot }, value: [{ slot: captured.result.slot, confirmations: null,
        err: null, confirmationStatus: 'finalized', ...statusPatch }] };
    }
    // Only HTTP is replaced: Connection's actual superstruct coercion and message hydration run.
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) as any;
  };
  const rpc = new Connection('https://example.invalid', { commitment: 'finalized', fetch, disableRetryOnRateLimit: true });
  const bot = { id: 'EXAMPLE-bot', activeProtocol: 'phoenix', walletAddress: 'EXAMPLE-owner', derivationIndex: 1, ...phoenixIdentityColumns(identity) };
  const holder = createPhoenixExecutionProduction({ rpc, pin,
    pool: { connect: async () => { throw new Error('unexpected DB'); }, query: async () => { throw new Error('unexpected DB'); } } as any,
    getBot: async () => bot as any, retained: async () => ({ state: 'completed', intent: { identity } }) as any, verify: async () => {} });
  const services = holder.forMarket('SOL');
  return { raw, calls, rpc, orderIO: (services.orders as unknown as { io: PhoenixOrderIO }).io,
    protectionIO: (services.protection as unknown as { io: ProtectionIO }).io };
}
async function record(f: ReturnType<typeof transport>): Promise<PhoenixOrderRecord> {
  const parsed = (await f.rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }))!;
  const i = intent();
  return { id: 'EXAMPLE-intent', intent: i, intent_hash: orderIntentHash(i), state: 'submission_pending', revision: 1,
    data: { admission: admitPhoenixOrder(i, authority(), now), attempt: { signature, transactionHash: digest(parsed.transaction.message),
      blockhash: parsed.transaction.message.recentBlockhash, lastValidBlockHeight: '500' } } };
}
function protection(r: PhoenixOrderRecord) {
  return { id: 'EXAMPLE-protection', intent: { identity, protection: { request: request({ action: 'cancel' }) } } } as any;
}

// Explicitly synthetic metadata derivatives of the real wire response, for trade/ALT coverage.
function tradeResponse(version: 'legacy' | 0) {
  const raw = structuredClone(captured.result), m = phoenixMarket('SOL'), message = raw.transaction.message;
  raw.version = version;
  let programIdIndex = message.accountKeys.indexOf(PHOENIX_PUBLIC_ADDRESSES.program);
  if (version === 0) {
    message.addressTableLookups = [{ accountKey: key.publicKey.toBase58(), writableIndexes: [0], readonlyIndexes: [1] }];
    raw.meta.loadedAddresses = { writable: [key.publicKey.toBase58()], readonly: [PHOENIX_PUBLIC_ADDRESSES.program] };
    programIdIndex = message.accountKeys.length + 1;
  }
  const header = Buffer.alloc(107); header[0] = 1; header.write(m.market, 17); header.writeUInt32LE(m.assetId, 33);
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(header, 75);
  const summary = Buffer.alloc(106); summary[0] = 6; new PublicKey(identity.traderAccountAddress).toBuffer().copy(summary, 1);
  summary.writeBigUInt64LE(7n, 33); summary.writeBigUInt64LE(123n, 50); summary.writeBigUInt64LE(184500000n, 58); summary.writeBigUInt64LE(64575n, 66);
  const lengths = Buffer.alloc(20); lengths.writeBigUInt64LE(0x479947b5cb8607f7n); lengths.writeUInt32LE(2, 12);
  lengths.writeUInt16LE(header.length, 16); lengths.writeUInt16LE(summary.length, 18);
  const batch = Buffer.alloc(16); batch.writeBigUInt64LE(0xaacfd109f2d6e68dn); batch.writeUInt32LE(2, 12);
  raw.meta.innerInstructions = [{ index: 0, instructions: [lengths, Buffer.concat([batch, header, summary])]
    .map(data => ({ programIdIndex, accounts: [], data: bs58.encode(data) })) }];
  return raw;
}

describe('UNIT2C1 real Connection receipt parsing', () => {
  it('hydrates the unmodified captured legacy response and consumes its native events and protection receipt', async () => {
    expect(typeof captured.result.transaction.message.accountKeys[0]).toBe('string');
    expect(captured.result.transaction.message.serialize).toBeUndefined();
    const f = transport(), r = await record(f);
    const parsed = (await f.rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }))!;
    expect(parsed.transaction.message).toBeInstanceOf(Message);
    expect((parsed.transaction.message as Message).accountKeys.every(k => k instanceof PublicKey)).toBe(true);
    expect(digest(parsed.transaction.message)).toBe(digest(new Message(captured.result.transaction.message)));
    expect(phoenixEvents(parsed).map(e => e[0])).toEqual([0, 29]);
    expect(() => actualPhoenixTrade(parsed, identity.traderAccountAddress, 'SOL', phoenixMarket('SOL').assetId, 'buy')).toThrow('Unambiguous');
    await expect(f.orderIO.receipt(r)).rejects.toThrow('Unambiguous');
    expect(await f.protectionIO.receipt(protection(r), r.data.attempt!)).toMatchObject({ signature, finalized: true, outcome: 'confirmed' });
  });
  it.each(['legacy', 0] as const)('parses a synthetic %s trade through Connection, then native events and production hash binding', async version => {
    const f = transport(tradeResponse(version)), r = await record(f);
    const parsed = (await f.rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }))!;
    expect(parsed.transaction.message).toBeInstanceOf(version === 0 ? MessageV0 : Message);
    const keys = parsed.transaction.message.staticAccountKeys;
    expect(keys.every(k => k instanceof PublicKey)).toBe(true);
    if (version === 0) {
      expect(parsed.meta!.loadedAddresses!.writable[0]).toBeInstanceOf(PublicKey);
      expect(parsed.meta!.loadedAddresses!.readonly[0]).toBeInstanceOf(PublicKey);
      expect(parsed.transaction.message.serialize()[0] & 0x80).toBe(0x80);
    }
    expect(actualPhoenixTrade(parsed, identity.traderAccountAddress, 'SOL', phoenixMarket('SOL').assetId, 'buy'))
      .toEqual({ sequence: '7', baseLots: '123', quoteMicros: '184500000', feeMicros: '64575' });
    expect(await f.orderIO.receipt(r)).toMatchObject({ signature, complete: true,
      fills: [{ baseLots: '123', quoteMicros: '184500000', feeMicros: '64575' }] });
    expect(await f.protectionIO.receipt(protection(r), r.data.attempt!)).toMatchObject({ outcome: 'confirmed' });
    r.data.attempt!.transactionHash = 'EXAMPLE-wrong-hash';
    await expect(f.orderIO.receipt(r)).rejects.toThrow('Unbound');
    expect(await f.protectionIO.receipt(protection(r), r.data.attempt!)).toBeNull();
  });
  it('refuses a returned transaction with a different signature even when its message hash matches', async () => {
    const f = transport(tradeResponse('legacy')), r = await record(f);
    f.raw.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(1));
    await expect(f.orderIO.receipt(r)).rejects.toThrow('Unbound');
    expect(await f.protectionIO.receipt(protection(r), r.data.attempt!)).toBeNull();
  });
  it('returns a terminal failed outcome for exactly the persisted signature without requiring transaction metadata', async () => {
    const f = transport(undefined, { err: { InstructionError: [0, { Custom: 1 }] } }), r = await record(f);
    f.calls.length = 0;
    expect(await f.orderIO.receipt(r)).toMatchObject({ signature, outcome: 'failed', complete: true, landed: true, fills: [],
      source: 'solana-finalized-signature', reference: `finalized:${captured.result.slot}:${signature}` });
    expect(f.calls.map(c => c.method)).toEqual(['getSignatureStatuses']);
    expect(await f.protectionIO.receipt(protection(r), r.data.attempt!)).toMatchObject({ signature, outcome: 'failed' });
    r.intent_hash = 'EXAMPLE-wrong-hash';
    await expect(f.orderIO.receipt(r)).rejects.toThrow('Unbound');
  });
  it('keeps a nonfinal failed status unresolved', async () => {
    const f = transport(undefined, { confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 1 }] } });
    expect(await f.orderIO.receipt(await record(f))).toBeNull();
  });
});
