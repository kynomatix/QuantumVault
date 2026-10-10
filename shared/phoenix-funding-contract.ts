export interface PhoenixFundingDetail {
  enabled: false;
  autoReturn: false;
  parking: false;
  debt: false;
  measured: null | { samples: number; meanSeconds: number; minSeconds: number; maxSeconds: number; lastCompletedAt: number };
  droppedSamples: number;
  lastSnapshot: null | { observedAt: number; slot: string; sourceWallet: string; destinationWallet: string | null; authorityWallet: string; traderAccount: string;
    balances: { sourceWalletUsdc: string; destinationWalletUsdc: string | null; botWalletUsdc: string; botWalletCollateral: string; venueCollateral: string; withdrawable: string; queued: string } };
  operations: { id: string; leg: string; state: string; requestedAt: number; queuedAt?: number;
    completedAt?: number; droppedAt?: number; queueRequestId?: string; walletCashConfirmed: boolean }[];
}

export function phoenixMeasuredDelayText(measured: PhoenixFundingDetail['measured']): string | null {
  return measured ? `Measured withdrawal delay: ${measured.meanSeconds.toFixed(1)} seconds average (${measured.samples} completed requests; ${measured.minSeconds.toFixed(1)}–${measured.maxSeconds.toFixed(1)} seconds).` : null;
}
