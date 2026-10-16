export interface PhoenixFundingDetail {
  enabled: false;
  autoReturn: false;
  parking: false;
  debt: boolean;
  borrowing?: { externalLender: 'jupiter-lend'; phoenixMarginIsCollateral: false; newBorrowing: boolean; manualRecovery: boolean;
    requiresMeasuredDelay: true; requiresDeploymentConsent: true; requiresSeparateLiquidReserve: true };
  measured: null | { samples: number; meanSeconds: number; minSeconds: number; maxSeconds: number; lastCompletedAt: number };
  droppedSamples: number;
  lastSnapshot: null | { observedAt: number; slot: string; sourceWallet: string; destinationWallet: string | null; authorityWallet: string; traderAccount: string;
    balances: { sourceWalletUsdc: string; destinationWalletUsdc: string | null; botWalletUsdc: string; botWalletCollateral: string; venueCollateral: string; withdrawable: string; queued: string } };
  operations: { id: string; leg: string; state: string; requestedAt: number; queuedAt?: number;
    completedAt?: number; droppedAt?: number; queueRequestId?: string; walletCashConfirmed: boolean;
    amountBaseUnits?: string; parentOperationId?: string;
    queueObservation?: { position: number | null; state: string; reason: number | null; observedSlot: string };
    feeUnexpected?: boolean }[];
}

export function phoenixMeasuredDelayText(measured: PhoenixFundingDetail['measured']): string | null {
  return measured ? `Measured withdrawal delay: ${measured.meanSeconds.toFixed(1)} seconds average (${measured.samples} completed requests; ${measured.minSeconds.toFixed(1)}–${measured.maxSeconds.toFixed(1)} seconds).` : null;
}
