/** Display response only. Exact monetary values remain decimal integer strings. */
export interface PhoenixEquityDetailResponse {
  venue: 'phoenix';
  equity: null | {
    observedAt: number; walletCashMicros: string | null; walletCollateralValueMicros: string | null;
    venueEquityMicros: string | null; freeMarginMicros: string | null;
    queuedWithdrawalMicros: string | null; parkedValueMicros: string | null;
    externalDebtMicros: string | null; totalEquityMicros: string | null;
    pendingReturns: { operationId: string; reference: string; valueMicros: string | null }[];
  };
}
