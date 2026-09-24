export interface VaultPreviewIdentity {
  assetKey: string;
  direction: "park" | "unpark";
  amount: number;
  wallet: string;
}

export interface VaultPreviewLike {
  wouldReject: boolean;
  reasonCode?: string;
  clientRequestKey?: string;
}

export function vaultPreviewRequestKey(identity: VaultPreviewIdentity): string {
  return JSON.stringify([identity.assetKey, identity.direction, identity.amount, identity.wallet]);
}

export function isTemporaryPreviewReason(reasonCode: unknown): boolean {
  return reasonCode === "quote_provider_unavailable";
}

export function shouldRetryVaultPreview(failureCount: number, error: { reasonCode?: unknown } | null): boolean {
  return failureCount < 2 && isTemporaryPreviewReason(error?.reasonCode);
}

export function vaultPreviewForDisplay<T>(preview: T | undefined, errorPreview: T | undefined): T | undefined {
  return errorPreview ?? preview;
}

export function previewActionReady(input: {
  enabled: boolean;
  busy: boolean;
  fetching: boolean;
  errored: boolean;
  currentRequestKey: string;
  preview: VaultPreviewLike | undefined;
}): boolean {
  return input.enabled
    && !input.busy
    && !input.fetching
    && !input.errored
    && input.preview?.clientRequestKey === input.currentRequestKey
    && input.preview.wouldReject === false;
}
