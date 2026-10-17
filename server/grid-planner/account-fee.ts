import { plannerFeeDefault, type PlannerFee } from '../../shared/planner-fee';
import type { AccountInfo } from '../protocol/protocol-types';

/** Owner identity comes only from wallet authentication; account reads use the adapter's cache. */
export async function readPlannerAccountFee(owner: string,
  getWallet: (owner: string) => Promise<{ agentPublicKey: string | null } | undefined | null>,
  getAccount: (account: string) => Promise<AccountInfo>): Promise<PlannerFee> {
  try {
    const wallet = await getWallet(owner);
    return plannerFeeDefault(wallet?.agentPublicKey ? await getAccount(wallet.agentPublicKey) : null);
  } catch { return plannerFeeDefault(null); }
}
