import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { previewActionReady, shouldRetryVaultPreview, vaultPreviewForDisplay, vaultPreviewRequestKey } from "../../client/src/lib/vault-preview-availability";

const identity = { assetKey: "onre_onyc", direction: "park" as const, amount: 0.73, wallet: "wallet" };
const key = vaultPreviewRequestKey(identity);

describe("Vault preview availability", () => {
  it("enables only the current successful preview", () => {
    const base = { enabled: true, busy: false, fetching: false, errored: false, currentRequestKey: key, preview: { wouldReject: false, clientRequestKey: key } };
    expect(previewActionReady(base)).toBe(true);
    for (const patch of [
      { enabled: false },
      { busy: true },
      { fetching: true },
      { errored: true },
      { preview: undefined },
      { preview: { wouldReject: true, clientRequestKey: key } },
      { preview: { wouldReject: false, clientRequestKey: `${key}-stale` } },
    ]) expect(previewActionReady({ ...base, ...patch })).toBe(false);
  });

  it("retries only temporary provider availability twice", () => {
    expect(shouldRetryVaultPreview(0, { reasonCode: "quote_provider_unavailable" })).toBe(true);
    expect(shouldRetryVaultPreview(1, { reasonCode: "quote_provider_unavailable" })).toBe(true);
    expect(shouldRetryVaultPreview(2, { reasonCode: "quote_provider_unavailable" })).toBe(false);
    expect(shouldRetryVaultPreview(0, { reasonCode: "no_route" })).toBe(false);
  });

  it("displays an exhausted temporary failure ahead of retained successful data", () => {
    const retained: { wouldReject: boolean; reason?: string } = { wouldReject: false };
    const failed: { wouldReject: boolean; reason?: string } = { wouldReject: true, reason: "Pricing service is temporarily unavailable" };
    expect(vaultPreviewForDisplay(retained, failed)).toBe(failed);
    expect(vaultPreviewForDisplay(retained, undefined)).toBe(retained);
  });

  it("wires the centralized fail-closed predicate to all four money controls", () => {
    const source = readFileSync(join(process.cwd(), "client/src/components/VaultIdleFunds.tsx"), "utf8");
    for (const predicate of ["canPark", "canUnpark", "canEmbPark", "canEmbUnpark"]) {
      expect(source).toContain(`const ${predicate} = previewReady(`);
      expect(source).toContain(`disabled={!${predicate}}`);
    }
  });

  it("renders temporary pricing truth and an explicit refresh without enabling an action", () => {
    const source = readFileSync(join(process.cwd(), "client/src/components/VaultIdleFunds.tsx"), "utf8");
    expect(source).toContain('preview.reasonCode === "quote_provider_unavailable" && onRefresh');
    expect(source).toContain('onClick={onRefresh}>Refresh</Button>');
    expect(source).toContain('detailPosition.pricingReasonCode === "quote_provider_unavailable"');
    expect(source).toContain("Pricing temporarily unavailable");
  });
});
