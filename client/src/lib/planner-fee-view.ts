import Decimal from 'decimal.js';
import { plannerFeeDefault, PACIFICA_FEE_SOURCE, type PlannerFee } from '../../../shared/planner-fee';

export function readPlannerFee(value: unknown): PlannerFee {
  if (!value || typeof value !== 'object' || !('fee' in value)) return plannerFeeDefault(null);
  const fee = value.fee as Partial<NonNullable<PlannerFee>> | null;
  if (!fee) return null;
  if (fee.source === 'account') return plannerFeeDefault({ makerFeeRate: fee.rate, feeTier: fee.tier });
  return fee.source === 'published' ? plannerFeeDefault(null, fee.rate) : null;
}
export function plannerFeePercent(fee: PlannerFee): string {
  return fee ? new Decimal(fee.rate).times(100).toFixed() : '';
}
export function plannerFeeLabel(fee: PlannerFee): string {
  return !fee ? 'Fee unknown — enter your maker fee to check fees'
    : fee.source === 'account' ? `Your Pacifica maker fee${fee.tier === null ? '' : ` (tier ${fee.tier})`}`
    : 'Pacifica published base maker fee (tier 1)';
}
export { PACIFICA_FEE_SOURCE };
