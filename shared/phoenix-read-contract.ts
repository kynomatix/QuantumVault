/** Public display observations. None of these types is execution authority. */
export interface PhoenixObservation<T> {
  state: 'fresh' | 'stale' | 'unknown';
  value: T | null;
  observedAt: number | null;
  source: string | null;
  reason: string | null;
}

/** Separate identities; a trader account is never a signer or wallet cash. */
export interface PhoenixTraderIdentity {
  venue: 'phoenix';
  network: 'solana-mainnet';
  programAddress: string;
  authorityWalletAddress: string;
  traderAccountAddress: string;
  portfolioIndex: number;
  subaccountIndex: number;
  derivationVersion: number;
}

export type PhoenixMoneyOperation = 'register' | 'deposit' | 'withdraw' | 'transfer'
  | 'trade' | 'close' | 'cancel' | 'settle' | 'recycle' | 'borrow' | 'carry' | 'park';

export interface PhoenixWithdrawalDetails {
  availability: PhoenixObservation<boolean>;
  queueAccount: PhoenixObservation<string>;
  queueLength: PhoenixObservation<number>;
  settlementEndpoint: PhoenixObservation<string>;
  delay: PhoenixObservation<{ seconds: number; basis: 'published' | 'measured' }>;
}

export interface PhoenixReadCapabilities {
  venue: 'phoenix';
  mode: 'read-only';
  enabled: boolean;
  publicReads: 'ready' | 'stale' | 'unknown' | 'disabled';
  operations: Record<PhoenixMoneyOperation, { ready: false; reason: 'not_implemented' }>;
  identity: PhoenixTraderIdentity | null;
  custody: {
    walletAuthority: 'separate_from_trader';
    venueCollateral: 'ember_wrapped_usdc';
    requiresDeposit: true;
    walletAvailableUsdc: PhoenixObservation<string>;
    venueCollateralUsdc: PhoenixObservation<string>;
    withdrawableUsdc: PhoenixObservation<string>;
    queuedReturnUsdc: PhoenixObservation<string>;
  };
  recycling: { supported: false; permanent: 'unknown'; maxPerAuthority: null };
  supportsPerBotExternalDebt: false;
  supportsCarryOnClose: false;
  exchangeStatus: PhoenixObservation<{ active: boolean; gated: boolean; runningState: string }>;
  withdrawals: PhoenixWithdrawalDetails;
}

export function unknownPhoenixObservation<T>(reason = 'not_published'): PhoenixObservation<T> {
  return { state: 'unknown', value: null, observedAt: null, source: null, reason };
}

/** No missing capability, public status or flag can grant money authority in U01. */
export function requirePhoenixMoneyCapability(
  capabilities: PhoenixReadCapabilities | null | undefined,
  operation: PhoenixMoneyOperation,
): never {
  throw new Error(`Phoenix ${operation} unavailable: ${capabilities?.mode ?? 'capability_absent'}`);
}

export function phoenixWithdrawalDelayText(
  details?: PhoenixWithdrawalDetails | null,
  now = Date.now(),
): string {
  const delay = details?.delay;
  if (delay?.state !== 'fresh' || !delay.value || typeof delay.source !== 'string' || !delay.source || delay.observedAt === null || !Number.isFinite(delay.observedAt)
    || now < delay.observedAt || now - delay.observedAt > 120_000
    || !Number.isFinite(delay.value.seconds) || delay.value.seconds < 0
    || !['published', 'measured'].includes(delay.value.basis)) {
    return 'Withdrawal delay not yet measured';
  }
  return `${delay.value.basis === 'measured' ? 'Measured' : 'Published'} withdrawal delay: ${delay.value.seconds} seconds`;
}
