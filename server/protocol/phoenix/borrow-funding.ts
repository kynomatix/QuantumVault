import { borrowHash, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';
import { phoenixFundingDetail } from './funding-detail';
import { validateFundingIntent, type FundingIntent } from './funding-contract';
import type { PhoenixFundingService } from './funding-service';
import type { PhoenixOperationStore, StoredPhoenixOperation } from './operation-store';

/** Only completed U04 withdrawal receipts produce measurements. Predictions,
 * dropped requests, queued balances and client-supplied latency are excluded. */
export function lenderWithdrawalMeasurement(history: StoredPhoenixOperation[]): BorrowSnapshot['measured'] {
  const measured = phoenixFundingDetail(history).measured;
  return measured ? {samples:measured.samples,maxSeconds:measured.maxSeconds,observedAt:measured.lastCompletedAt,
    reference:`sha256:${borrowHash(history.filter(o => o.state === 'completed' && o.intent.funding?.leg === 'withdraw')
      .map(o => ({id:o.id,observation:o.observation})))}`} : null;
}

export class PhoenixDebtFunding {
  constructor(private readonly funding: Pick<PhoenixFundingService,'create'|'resume'>,
    private readonly operations: Pick<PhoenixOperationStore,'fundingHistory'>,
    private readonly build: (i: PhoenixBorrowIntent, child: {borrowIntentId:string;requestKey:string;amountRaw:string}) => Promise<FundingIntent>) {}
  async deposit(i: PhoenixBorrowIntent, child: {borrowIntentId:string;requestKey:string;amountRaw:string}) {
    const history = await this.operations.fundingHistory(i.botId,i.ownerWallet);
    let op = history.find(o => o.request_key === child.requestKey);
    const intent = op?.intent ?? await this.build(i,child);
    validateFundingIntent(intent);
    if (intent.botId !== i.botId || intent.ownerWallet !== i.ownerWallet || borrowHash(intent.identity) !== borrowHash(i.identity)
      || intent.requestKey !== child.requestKey || intent.borrowIntentId !== child.borrowIntentId || intent.kind !== 'deposit'
      || intent.funding.leg !== 'deposit' || intent.funding.sourceWallet !== i.identity.authorityWalletAddress
      || intent.destination !== i.identity.traderAccountAddress || intent.amountBaseUnits !== child.amountRaw
      || intent.borrowReserveRaw !== i.reserveRaw || intent.funding.grossBaseUnits !== child.amountRaw || intent.feeBaseUnits !== '0' || intent.parkingIntentId || intent.executionOrderId) throw new Error('Debt deployment funding binding mismatch');
    op = op ? await this.funding.resume(i.botId,i.ownerWallet,op.id) : await this.funding.create(intent);
    return {success:op.state === 'completed',finalized:op.state === 'completed',operationId:op.id};
  }
}
