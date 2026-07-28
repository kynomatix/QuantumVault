import type { ProtocolAdapter } from "../protocol/adapter";
import { getDefaultAdapter } from "../protocol/adapter-registry";

export type ResetAgentOnChainAssessment =
  | { blocked: false }
  | { blocked: true; reason: "open_positions" | "exchange_funds" };

/**
 * Strict on-chain cleanliness read for destructive agent-key rotation.
 *
 * The active adapter owns the venue-specific authenticated inventory. Its
 * failures and malformed shapes THROW; the route catches once at its reset
 * boundary and fails closed without inspecting error text.
 */
export async function assessResetAgentOnChainStrict(
  agentPublicKey: string,
  agentSecretKey: Uint8Array,
  adapter: ProtocolAdapter = getDefaultAdapter(),
): Promise<ResetAgentOnChainAssessment> {
  if (typeof adapter.assessAgentWalletResetStateStrict !== "function") {
    throw new Error("active adapter has no strict reset assessment");
  }
  const state = await adapter.assessAgentWalletResetStateStrict({
    agentPublicKey,
    agentSecretKey,
  });
  if (
    !state ||
    typeof state.hasOpenPositions !== "boolean" ||
    typeof state.hasExchangeFunds !== "boolean"
  ) {
    throw new Error("reset venue assessment malformed");
  }
  if (state.hasOpenPositions) return { blocked: true, reason: "open_positions" };
  if (state.hasExchangeFunds) return { blocked: true, reason: "exchange_funds" };
  return { blocked: false };
}
