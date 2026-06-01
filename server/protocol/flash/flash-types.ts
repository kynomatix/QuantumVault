/**
 * Internal TypeScript types for the Flash Trade adapter.
 *
 * These types mirror the flash-sdk v15 PositionAccount / OrderAccount shapes
 * but are decoupled from the SDK so the rest of the codebase never imports
 * flash-sdk types directly (only flash-adapter.ts does).
 */

import type BN from 'bn.js';
import type { PublicKey } from '@solana/web3.js';

// ── Flash position shape (from PositionAccount) ──────────────────────────────

export interface FlashRawPosition {
  pubkey: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  delegate: PublicKey;
  openTime: BN;
  updateTime: BN;
  /** Entry price struct from the SDK — has .price (BN) and .exponent (number). */
  entryPrice: { price: BN; exponent: number; conf?: BN };
  sizeUsd: BN;
  sizeAmount: BN;
  lockedAmount: BN;
  lockedUsd: BN;
  collateralUsd: BN;
  unsettledValueUsd: BN;
  unsettledFeesUsd: BN;
  isActive: boolean;
  sizeDecimals: number;
  lockedDecimals: number;
  collateralDecimals: number;
}

// ── Flash order account shape (from OrderAccount) ────────────────────────────

export interface FlashTriggerOrder {
  price: BN;
  sizeUsd: BN;
  isExecuted: boolean;
  isActive: boolean;
  expiryTimestamp: BN;
}

export interface FlashLimitOrder {
  price: BN;
  sizeUsd: BN;
  isExecuted: boolean;
  isActive: boolean;
  expiryTimestamp: BN;
}

export interface FlashRawOrderAccount {
  pubkey: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  limitOrders: FlashLimitOrder[];
  takeProfitOrders: FlashTriggerOrder[];
  stopLossOrders: FlashTriggerOrder[];
  isInitialised: boolean;
  isActive: boolean;
  openSl: number;
  openTp: number;
}

// ── Flash market info (from MarketConfig) ────────────────────────────────────

export interface FlashMarketInfo {
  /** marketId from PoolConfig */
  marketId: number;
  /** on-chain address of the market account */
  marketAccount: string;
  /** target asset symbol (e.g. 'SOL') */
  targetSymbol: string;
  /** collateral asset symbol (e.g. 'USDC' for shorts, 'SOL' for longs) */
  collateralSymbol: string;
  /** 'long' | 'short' */
  side: 'long' | 'short';
  maxLev: number;
}

// ── Pyth Hermes API response ─────────────────────────────────────────────────

export interface PythHermesPriceEntry {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export interface PythHermesResponse {
  parsed: Array<{
    id: string;
    price: PythHermesPriceEntry;
    ema_price: PythHermesPriceEntry;
    metadata?: { slot: number; proof_available_time: number };
  }>;
}

// ── Side helper ───────────────────────────────────────────────────────────────

export type FlashSide = 'long' | 'short';

export function toFlashSide(side: 'long' | 'short'): FlashSide {
  return side;
}

export function fromFlashSide(side: FlashSide): 'long' | 'short' {
  return side;
}

// ── BN to number helpers ─────────────────────────────────────────────────────

/**
 * Convert a flash-sdk BN price struct to a plain USD number.
 * price.price * 10^price.exponent
 */
export function bnPriceToNumber(price: { price: BN; exponent: number }): number {
  return price.price.toNumber() * Math.pow(10, price.exponent);
}

/**
 * Convert a BN USD amount (stored with 6-decimal USDC precision) to a plain
 * number. Flash stores collateral USD values with USDC decimals (1e6).
 */
export function bnUsdToNumber(bn: BN): number {
  return bn.toNumber() / 1e6;
}

/**
 * Convert a BN token amount to a plain number given the token's decimals.
 */
export function bnTokenToNumber(bn: BN, decimals: number): number {
  return bn.toNumber() / Math.pow(10, decimals);
}
