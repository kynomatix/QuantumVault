import { borrowHash, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';
import { carryRepayIntent } from './carry-contract';
import type { PhoenixCarryService } from './carry-service';
import type { PhoenixBorrowService } from './borrow-service';
import type { BorrowRecord, BorrowRepository } from './borrow-store';
import type { PhoenixParkingIO } from './parking-service';
import type { ParkingRecord, ParkingReceipt } from './parking-contract';
import type { FundingIntent } from './funding-contract';

/** Reuses U10 for U04 settlement/vault attempts and U11 for bounded repayment.
 * The latter runs through the same pre-broadcast automatic boundary as U12. */
export function createCarryExecutor(parking: PhoenixParkingIO, borrowing: Pick<PhoenixBorrowService,'run'>,
  loans: Pick<BorrowRepository,'read'>, observeRepayment: (i: PhoenixBorrowIntent, r: BorrowRecord) => Promise<ParkingReceipt | null>): PhoenixParkingIO {
  return {
    snapshot: i => parking.snapshot(i),
    async submit(r,l) {
      if (l.kind === 'repay') { await borrowing.run(carryRepayIntent(r,l)); return; }
      if (l.kind === 'unpark' || l.kind === 'deposit') throw new Error('Carry cannot unpark, redeploy or borrow');
      await parking.submit(r,l);
    },
    async receipt(r,l) {
      if (l.kind !== 'repay') return parking.receipt(r,l);
      const i = carryRepayIntent(r,l);
      let loan: BorrowRecord;
      try { loan = await loans.read(i); } catch { return null; }
      if (loan.status !== 'completed') {
        // Existing U11 journal reconciles ambiguous primitives. Its debt floor
        // and fresh parent authorizer still apply to any proven-absent retry.
        try { loan = await borrowing.run(i); } catch { return null; }
      }
      if (loan.status !== 'completed' || loan.metadata.legs.repay?.state !== 'completed') return null;
      // Finalized lender/token delta evidence is required, not an aggregate debt
      // drop that might have been a different repayment or liquidation.
      const receipt = await observeRepayment(i,loan);
      if (receipt && (receipt.key !== l.key || receipt.state !== 'settled')) throw new Error('Unbound carry repayment receipt');
      return receipt;
    },
  };
}
export function carryRepaymentAuthorizer(service: Pick<PhoenixCarryService,'authorize'>,
  parent: (id: string) => Promise<ParkingRecord>) {
  return async (i: PhoenixBorrowIntent, _snapshot: BorrowSnapshot) => {
    if (i.automation?.kind !== 'carry' || !i.automation.parkingIntentId) throw new Error('Carry parent required');
    const r = await parent(i.automation.parkingIntentId), l = r.legs.at(-1)?.leg;
    if (!l || borrowHash(carryRepayIntent(r,l)) !== borrowHash(i)) throw new Error('Carry repayment terms changed');
    await service.authorize(r);
  };
}
export function carrySettlementAuthorizer(service: Pick<PhoenixCarryService,'authorize'>,
  parent: (id: string) => Promise<ParkingRecord>) {
  return async (i: FundingIntent) => {
    if (!i.carryIntentId || i.carryIntentId !== i.parkingIntentId) throw new Error('Carry parent required');
    const r = await parent(i.carryIntentId), l = r.legs.at(-1)?.leg;
    if (r.intent.botId !== i.botId || r.intent.ownerWallet !== i.ownerWallet || !l || l.key !== i.requestKey
      || l.kind !== i.funding.leg || l.amount !== i.funding.grossBaseUnits
      || borrowHash(r.intent.identity) !== borrowHash(i.identity)) throw new Error('Carry settlement terms changed');
    await service.authorize(r);
  };
}
