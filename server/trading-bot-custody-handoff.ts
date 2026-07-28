export type DriftCustodyDetachResult = {
  deleted: boolean;
  orphanHandoffRequired: boolean;
  orphanHandoffComplete: boolean;
  blockedReason?: "invalid_subaccount_id" | "missing_agent_generation" | "orphan_handoff_failed";
};

type DriftCustodyDetachParams = {
  walletAddress: string;
  agentPublicKey: string | null | undefined;
  driftSubaccountId: number | null | undefined;
  subaccountAuthMode: string | null | undefined;
  closeConfirmed: boolean;
  orphanReason: string | null | undefined;
  createOrphanedSubaccount: (row: {
    walletAddress: string;
    agentPublicKey: string;
    driftSubaccountId: number;
    reason: string | null;
  }) => Promise<unknown>;
  deleteTradingBot: () => Promise<unknown>;
};

/**
 * Preserve a durable Reset blocker before detaching a Drift bot whose
 * subaccount close was not confirmed. The orphan insert must commit before
 * deletion is invoked; a missing generation or failed insert blocks deletion.
 */
export async function detachTradingBotAfterDriftCustodyHandoff(
  params: DriftCustodyDetachParams,
): Promise<DriftCustodyDetachResult> {
  const subaccountId = params.driftSubaccountId;
  const isExternalKey = params.subaccountAuthMode === "external_key";
  let orphanHandoffRequired = false;

  if (subaccountId !== null && subaccountId !== undefined && subaccountId !== 0 && !isExternalKey) {
    if (!Number.isSafeInteger(subaccountId) || subaccountId < 0) {
      return {
        deleted: false,
        orphanHandoffRequired: true,
        orphanHandoffComplete: false,
        blockedReason: "invalid_subaccount_id",
      };
    }
    orphanHandoffRequired = !params.closeConfirmed;
  }

  if (orphanHandoffRequired) {
    const agentPublicKey = params.agentPublicKey?.trim();
    if (!agentPublicKey) {
      return {
        deleted: false,
        orphanHandoffRequired: true,
        orphanHandoffComplete: false,
        blockedReason: "missing_agent_generation",
      };
    }
    try {
      await params.createOrphanedSubaccount({
        walletAddress: params.walletAddress,
        agentPublicKey,
        driftSubaccountId: subaccountId as number,
        reason: params.orphanReason?.trim() || "Subaccount close was not confirmed before bot deletion",
      });
    } catch {
      return {
        deleted: false,
        orphanHandoffRequired: true,
        orphanHandoffComplete: false,
        blockedReason: "orphan_handoff_failed",
      };
    }
  }

  await params.deleteTradingBot();
  return {
    deleted: true,
    orphanHandoffRequired,
    orphanHandoffComplete: orphanHandoffRequired,
  };
}
