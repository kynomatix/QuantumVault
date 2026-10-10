import type { StoredPhoenixOperation } from './operation-store';
import type { FundingHistory } from './funding-contract';
import type { PhoenixFundingDetail } from '../../../shared/phoenix-funding-contract';

/** Request-to-observed-release measurements, not predicted liquidity or final wallet cash.
 * Dropped requests are counted separately and never included in successful delays.
 */
export function phoenixFundingDetail(history: StoredPhoenixOperation[]): PhoenixFundingDetail {
  const operations = history.filter(op => op.intent.funding).map(op => {
    const h = op.observation?.funding as FundingHistory | undefined;
    return { id: op.id, leg: op.intent.funding!.leg, state: op.state,
      requestedAt: h?.requestedAt ?? NaN, queuedAt: h?.queuedAt,
      completedAt: h?.completedAt, droppedAt: h?.droppedAt, queueRequestId: h?.queueRequestId,
      walletCashConfirmed: op.state === 'completed' && ['unwrap', 'wallet_return'].includes(op.intent.funding!.leg) };
  });
  const samples = operations.filter(op => op.leg === 'withdraw' && op.state === 'completed'
    && Number.isFinite(op.completedAt) && op.completedAt! >= op.requestedAt);
  const delays = samples.map(op => (op.completedAt! - op.requestedAt) / 1000);
  const latest = history.filter(op => (op.observation?.funding as FundingHistory | undefined)?.receipt)
    .sort((a, b) => (b.observation!.funding as FundingHistory).receipt!.observedAt - (a.observation!.funding as FundingHistory).receipt!.observedAt)[0];
  const receipt = latest ? (latest.observation!.funding as FundingHistory).receipt! : null;
  return { enabled: false, autoReturn: false, parking: false, debt: false, operations,
    lastSnapshot: receipt ? { observedAt: receipt.observedAt, slot: receipt.slot, sourceWallet: latest.intent.funding!.sourceWallet,
      destinationWallet: ['wallet_funding', 'wallet_return'].includes(latest.intent.funding!.leg) ? latest.intent.destination : null,
      authorityWallet: latest.intent.identity.authorityWalletAddress, traderAccount: latest.intent.identity.traderAccountAddress,
      balances: receipt.balances } : null,
    droppedSamples: operations.filter(op => op.leg === 'withdraw' && op.state === 'dropped').length,
    measured: delays.length ? { samples: delays.length, meanSeconds: delays.reduce((a, b) => a + b, 0) / delays.length,
      minSeconds: Math.min(...delays), maxSeconds: Math.max(...delays), lastCompletedAt: Math.max(...samples.map(op => op.completedAt!)) } : null };
}
