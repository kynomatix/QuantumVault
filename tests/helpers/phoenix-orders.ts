import { Keypair } from '@solana/web3.js';
import { derivePhoenixIdentity } from '../../server/protocol/phoenix/identity';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import type { PhoenixOrderIntent, PhoenixOrderAuthority } from '../../server/protocol/phoenix/order-contract';
import type { PhoenixOrderPin } from '../../server/protocol/phoenix/order-builder';
import { protectionAddresses } from '../../server/protocol/phoenix/protection-contract';
export const now = 1800000000000;
export const key = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const identity = derivePhoenixIdentity(key.publicKey.toBase58());
export function intent(patch: Partial<PhoenixOrderIntent> = {}): PhoenixOrderIntent {
  return { botId: 'EXAMPLE-bot', ownerWallet: 'EXAMPLE-owner', requestKey: 'EXAMPLE-request', identity,
    market: 'SOL', sequence: '1', action: 'entry', side: 'buy', baseUnits: '2', leverage: '2',
    maxNotionalMicros: '1000000000', fillPolicy: 'IOC', minFillLots: '0', slippageBps: 100,
    expiresAt: now + 30000, lastValidSlot: '150',
    protection: { tp: { triggerTicks: patch.side === 'sell' ? '13000' : '17000', slippageBps: 25 },
      sl: { triggerTicks: patch.side === 'sell' ? '16000' : '14000', slippageBps: 100 } }, ...patch };
}
export function authority(): PhoenixOrderAuthority {
  return { venue: 'phoenix', trader: identity.traderAccountAddress, market: 'SOL', assetId: 3,
    collateralMint: PHOENIX_PUBLIC_ADDRESSES.usdcMint, source: 'EXAMPLE-chain', reference: 'EXAMPLE-snapshot',
    observedAt: now, refreshFailed: false, status: 'active', isolatedOnly: false, tickSize: '100', baseLotsDecimals: 2,
    price: { usd: '150', observedAt: now, source: 'phoenix-execution', reference: 'EXAMPLE-book' }, slot: '100',
    entry: { observedAt: now, minimumNotionalMicros: '1000000', maxNotionalMicros: '10000000000',
      maxLeverage: '20', takerFeePpm: '350', feeReference: 'EXAMPLE-account-tier', feeObservedAt: now,
      freeMarginMicros: '1000000000', fundableMicros: '0', marginObservedAt: now },
    position: { observedAt: now, side: 'flat', baseLots: '0', epoch: 'EXAMPLE-position-epoch' },
    protection: { venue: 'phoenix', trader: identity.traderAccountAddress, market: 'SOL', assetId: 3,
      source: 'EXAMPLE-chain', reference: 'EXAMPLE-protection', observedAt: now, slot: '100', finalized: true, complete: true, refreshFailed: false,
      ...protectionAddresses(identity.traderAccountAddress, 3), conditionalExists: true, standaloneFunder: null,
      position: { side: 'flat', baseLots: '0', sequence: 1, epoch: 'EXAMPLE-position-epoch' },
      markTicks: '15000', orderbookOrderIds: [], legs: [], collectionSequence: '1' } };
}
const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
export const pin: PhoenixOrderPin = { market: 'SOL', assetId: 3, logAuthority: address(11), globalConfiguration: address(12),
  perpAssetMap: address(13), globalTraderIndex: [address(14)], activeTraderBuffer: [address(15)], orderbook: address(16), splineCollection: address(17) };
export const lifetime = { blockhash: address(18), lastValidBlockHeight: 500 };
