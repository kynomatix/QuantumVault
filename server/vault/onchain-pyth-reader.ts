/**
 * On-chain Pyth price account reader — HERMES_EXIT_PLAN Phase 3b.
 *
 * READ-ONLY, strictly additive. Does not touch any money path, gate, or
 * threshold. Returns { priceUsd, publishTimeSec } | null per feed.
 * Null on ANY uncertainty (bad data, RPC error, parse failure).
 *
 * Reads Pyth push-oracle PriceUpdateV2 accounts from Solana mainnet.
 * PDA derivation mirrors @pythnetwork/pyth-solana-receiver shard-0:
 *   seeds = [shardId_le_u16, feedId_bytes_32], program = PUSH_ORACLE_PROGRAM
 *
 * Uses getMultipleAccountsInfo for batched reads (one RPC round-trip per call
 * to readFeedsAll, regardless of how many feeds are requested).
 */

import { PublicKey, Connection } from '@solana/web3.js';
import { getPrimaryRpcUrl } from '../rpc-config.js';

export interface OnchainPricePoint {
  priceUsd: number;
  publishTimeSec: number;
}

/** Pyth push-oracle program (shard 0, sponsored). */
const PUSH_ORACLE_PROGRAM = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
const DEFAULT_SHARD_ID = 0;

/**
 * Minimum meaningful PriceUpdateV2 account size:
 *   8 (discriminator) + 32 (write_authority) + 1 (VerificationLevel:Full tag)
 *   + 32 (price_message.feed_id) + 8 (price) + 8 (conf) + 4 (exponent) + 8 (publish_time)
 *   = 101 bytes.
 */
const MIN_ACCOUNT_BYTES = 101;

/**
 * Derive the on-chain PriceUpdateV2 account address for a Pyth feed.
 * mirrors PythSolanaReceiver.getPriceFeedAccountAddress(shardId, feedIdBuffer).
 *
 * Throws if feedIdHex is not 64 hex characters (32 bytes).
 */
export function getPriceFeedAccountAddress(feedIdHex: string, shardId = DEFAULT_SHARD_ID): PublicKey {
  const cleaned = feedIdHex.trim().toLowerCase().replace(/^0x/, '');
  const feedIdBytes = Buffer.from(cleaned, 'hex');
  if (feedIdBytes.length !== 32) {
    throw new Error(`[OnchainPyth] Invalid feed id (expected 32 bytes): ${feedIdHex}`);
  }
  const shardBuffer = Buffer.from([shardId & 0xff, (shardId >> 8) & 0xff]);
  const [address] = PublicKey.findProgramAddressSync([shardBuffer, feedIdBytes], PUSH_ORACLE_PROGRAM);
  return address;
}

/**
 * Parse a raw PriceUpdateV2 account buffer.
 * Returns null on ANY failure (too short, unexpected enum tag, bad values).
 *
 * Anchor/Borsh binary layout:
 *   [0..7]   8-byte discriminator (skip)
 *   [8..39]  write_authority pubkey (32 bytes, skip)
 *   [40]     VerificationLevel tag (u8): 0=Partial (2 bytes total), 1=Full (1 byte total)
 *   [40+n..] price_message:
 *     feed_id        [u8; 32]   (skip)
 *     price          i64 LE
 *     conf           u64 LE     (skip)
 *     exponent       i32 LE
 *     publish_time   i64 LE
 *     prev_publish_time i64 LE  (skip)
 *     ema_price      i64 LE     (skip)
 *     ema_conf       u64 LE     (skip)
 *   posted_slot      u64 LE     (skip)
 */
export function parsePriceUpdateV2(data: Buffer): OnchainPricePoint | null {
  try {
    if (data.length < MIN_ACCOUNT_BYTES) return null;

    // VerificationLevel enum at offset 40
    const verificationTag = data[40];
    let enumBytes: number;
    if (verificationTag === 0) enumBytes = 2;       // Partial { num_signatures: u8 }
    else if (verificationTag === 1) enumBytes = 1;  // Full
    else return null; // unknown variant → fail closed

    let offset = 40 + enumBytes; // start of price_message.feed_id

    // Ensure we have feed_id(32) + price(8) + conf(8) + exponent(4) + publish_time(8)
    if (offset + 60 > data.length) return null;

    offset += 32; // skip price_message.feed_id

    // price (i64 LE)
    const priceRaw = data.readBigInt64LE(offset);
    offset += 8;

    // conf (u64 LE, skip)
    offset += 8;

    // exponent (i32 LE)
    const exponent = data.readInt32LE(offset);
    offset += 4;

    // publish_time (i64 LE)
    const publishTimeSec = Number(data.readBigInt64LE(offset));

    const priceUsd = Number(priceRaw) * Math.pow(10, exponent);

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    if (!Number.isFinite(publishTimeSec) || publishTimeSec <= 0) return null;

    return { priceUsd, publishTimeSec };
  } catch {
    return null;
  }
}

// Lazy singleton Connection (avoids allocating a new connection per call).
let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) {
    _conn = new Connection(getPrimaryRpcUrl(), 'confirmed');
  }
  return _conn;
}

/**
 * Read a single Pyth feed from the on-chain push-oracle account.
 * Returns null on any uncertainty. Prefer readFeedsAll for multiple feeds.
 */
export async function readOnchainPrice(feedIdHex: string): Promise<OnchainPricePoint | null> {
  const result = await readFeedsAll([feedIdHex]);
  return result.get(feedIdHex.trim().toLowerCase().replace(/^0x/, '')) ?? null;
}

/**
 * Batch-read multiple Pyth feeds in a single getMultipleAccountsInfo RPC call.
 *
 * Returns Map<normalizedFeedId, OnchainPricePoint | null>.
 * Any feed that is missing, cannot be parsed, or fails on RPC error maps to null.
 * On a whole-call RPC error the map contains null for every requested feed.
 */
export async function readFeedsAll(
  feedIds: string[],
  shardId = DEFAULT_SHARD_ID,
): Promise<Map<string, OnchainPricePoint | null>> {
  const out = new Map<string, OnchainPricePoint | null>();
  if (feedIds.length === 0) return out;

  // Normalize ids and derive PDA addresses, tracking which succeeded.
  const validPairs: Array<{ id: string; address: PublicKey }> = [];
  for (const raw of feedIds) {
    const id = raw.trim().toLowerCase().replace(/^0x/, '');
    try {
      validPairs.push({ id, address: getPriceFeedAccountAddress(id, shardId) });
    } catch {
      out.set(id, null); // invalid feed id (wrong length, non-hex, etc.)
    }
  }

  if (validPairs.length === 0) return out;

  try {
    const conn = getConn();
    const infos = await conn.getMultipleAccountsInfo(validPairs.map((p) => p.address));
    for (let i = 0; i < validPairs.length; i++) {
      const { id } = validPairs[i];
      const info = infos[i];
      if (!info?.data) {
        out.set(id, null);
        continue;
      }
      let buf: Buffer;
      if (Buffer.isBuffer(info.data)) {
        buf = info.data;
      } else if (Array.isArray(info.data)) {
        buf = Buffer.from(info.data[0] as string, info.data[1] as BufferEncoding);
      } else {
        out.set(id, null);
        continue;
      }
      out.set(id, parsePriceUpdateV2(buf));
    }
  } catch {
    // RPC error → null for every feed not yet answered
    for (const { id } of validPairs) {
      if (!out.has(id)) out.set(id, null);
    }
  }

  return out;
}
