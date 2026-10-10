import type { PhoenixIntent, StoredPhoenixOperation } from './operation-store';
import { assertPhoenixIdentity } from './identity';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { PublicKey } from '@solana/web3.js';

export type FundingLeg = 'wallet_funding' | 'deposit' | 'withdraw' | 'unwrap' | 'wallet_return';
export interface FundingTerms {
  leg: FundingLeg;
  parentOperationId?: string;
  sourceWallet: string;
  grossBaseUnits: string;
  minimumBaseUnits: string;
  maxGasLamports: string;
  quoteSource: string;
  quoteReference: string;
  quoteExpiresAt: number;
}
export type FundingIntent = PhoenixIntent & { funding: FundingTerms };
export function units(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || value.includes('\n')
    || BigInt(value) > 18446744073709551615n) throw new Error('Invalid funding base units');
  return BigInt(value);
}
export function validateFundingIntent(intent: PhoenixIntent): asserts intent is FundingIntent {
  assertPhoenixIdentity(intent.identity);
  const terms = intent.funding;
  if (!terms || !['wallet_funding', 'deposit', 'withdraw', 'unwrap', 'wallet_return'].includes(terms.leg)
    || intent.mint !== PHOENIX_PUBLIC_ADDRESSES.usdcMint || !terms.quoteSource || !terms.quoteReference
    || !Number.isSafeInteger(terms.quoteExpiresAt) || terms.quoteExpiresAt <= 0) throw new Error('Invalid Phoenix funding terms');
  for (const address of [terms.sourceWallet, intent.destination]) {
    if (new PublicKey(address).toBase58() !== address) throw new Error('Invalid funding address');
  }
  const net = units(intent.amountBaseUnits), fee = units(intent.feeBaseUnits), gross = units(terms.grossBaseUnits);
  if (net === 0n || gross !== net + fee || gross < units(terms.minimumBaseUnits)) throw new Error('Funding minimum or net mismatch');
  units(terms.maxGasLamports);
  // Only withdrawal queue fees are supported. No invented application/transfer fee.
  if (terms.leg !== 'withdraw' && fee !== 0n) throw new Error('Unsupported funding fee');
  const authority = intent.identity.authorityWalletAddress, trader = intent.identity.traderAccountAddress;
  const kind = terms.leg === 'deposit' ? 'deposit' : terms.leg === 'withdraw' ? 'withdraw' : 'transfer';
  if (intent.kind !== kind) throw new Error('Funding kind mismatch');
  if (terms.leg === 'wallet_funding') {
    if (intent.destination !== authority || terms.sourceWallet === authority || terms.parentOperationId) throw new Error('Wrong wallet funding binding');
  } else {
    if (terms.sourceWallet !== authority) throw new Error('Wrong funding authority');
    if (terms.leg === 'deposit' && intent.destination !== trader) throw new Error('Wrong deposit PDA');
    if (['withdraw', 'unwrap'].includes(terms.leg) && intent.destination !== authority) throw new Error('Wrong withdrawal destination');
    if (['unwrap', 'wallet_return'].includes(terms.leg) && !terms.parentOperationId) throw new Error('Missing settlement parent');
    if (terms.leg === 'withdraw' && terms.parentOperationId) throw new Error('Invalid withdrawal parent');
    if (terms.leg === 'wallet_return' && intent.destination === authority) throw new Error('Invalid wallet return');
  }
}

/** Finalized receipts come only from a reviewed observer, never from an HTTP body.
 * Balances share one finalized slot; queued amount is a memorandum subset of venue
 * collateral, never another asset added to total custody.
 */
export interface FundingReceipt {
  source: string; reference: string; intentHash: string; signature: string;
  outcome: 'settled' | 'queued' | 'dropped'; finalized: true; slot: string;
  observedAt: number; queueRequestId?: string;
  balances: { sourceWalletUsdc: string; destinationWalletUsdc: string | null; botWalletUsdc: string; botWalletCollateral: string;
    venueCollateral: string; withdrawable: string; queued: string };
  creditedBaseUnits: string;
}
export interface FundingHistory {
  events?: { state: string; observedAt: number; source: string; reference: string; receipt: FundingReceipt }[];
  requestedAt: number;
  queuedAt?: number;
  completedAt?: number;
  droppedAt?: number;
  queueRequestId?: string;
  receipt?: FundingReceipt;
}

export function validateFundingReceipt(operation: StoredPhoenixOperation, signature: string, receipt: FundingReceipt) {
  validateFundingIntent(operation.intent);
  const intent = operation.intent, prior = operation.observation?.funding as FundingHistory | undefined;
  if (receipt.finalized !== true || !receipt.source || !receipt.reference || receipt.signature !== signature
    || receipt.intentHash !== operation.intent_hash || !['settled', 'queued', 'dropped'].includes(receipt.outcome)
    || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt > Date.now()
    || !prior || !Number.isSafeInteger(prior.requestedAt) || receipt.observedAt < prior.requestedAt
    || (prior?.receipt && receipt.observedAt < prior.receipt.observedAt)) throw new Error('Invalid finalized funding receipt');
  units(receipt.slot);
  if (prior.receipt && units(receipt.slot) < units(prior.receipt.slot)) throw new Error('Funding finalized slot regressed');
  for (const name of ['sourceWalletUsdc', 'botWalletUsdc', 'botWalletCollateral', 'venueCollateral', 'withdrawable', 'queued'] as const) units(receipt.balances[name]);
  if (['wallet_funding', 'wallet_return'].includes(intent.funding.leg)) {
    units(receipt.balances.destinationWalletUsdc!);
    if (intent.destination === intent.identity.authorityWalletAddress
      && receipt.balances.destinationWalletUsdc !== receipt.balances.botWalletUsdc) throw new Error('Aliased destination balance mismatch');
  } else if (receipt.balances.destinationWalletUsdc !== null) throw new Error('Unexpected wallet destination balance');
  if (units(receipt.balances.queued) > units(receipt.balances.venueCollateral)) throw new Error('Queue double counting');
  if (intent.funding.sourceWallet === intent.identity.authorityWalletAddress
    && receipt.balances.sourceWalletUsdc !== receipt.balances.botWalletUsdc) throw new Error('Aliased custody balance mismatch');
  if (intent.kind !== 'withdraw' && receipt.outcome !== 'settled') throw new Error('Invalid non-withdrawal receipt');
  if ((receipt.outcome !== 'settled' || prior?.queueRequestId) && (!receipt.queueRequestId
    || (prior?.queueRequestId && receipt.queueRequestId !== prior.queueRequestId))) throw new Error('Queue identity mismatch');
  if (units(receipt.creditedBaseUnits) !== (receipt.outcome === 'settled' ? units(intent.amountBaseUnits) : 0n)) throw new Error('Funding credit mismatch');
}
