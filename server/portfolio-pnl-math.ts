/**
 * Task 119: Modified Dietz return computation.
 *
 * Why Modified Dietz instead of chained daily returns:
 *   Chained returns require accurate balance reads at every interval. Our
 *   historical snapshots contain occasional zero/near-zero balance reads from
 *   RPC failures or transiently-empty subaccounts; chaining `(end - start -
 *   flow) / start` across those days compounds them and the cumulative return
 *   asymptotes to -100% even when actual trading PnL is small.
 *
 *   Modified Dietz uses ONLY the period's start balance, end balance, and the
 *   time-weighted external cash flows. Intermediate balance reads don't enter
 *   the formula, so a flaky mid-period balance cannot corrupt the result.
 *
 * Formula:
 *   numerator   = endBalance - startBalance - sum(flow.amount)
 *   denominator = startBalance + sum(flow.amount * (T_end - T_flow) / (T_end - T_start))
 *   return      = numerator / denominator
 *
 * `flow.amount` is positive for deposits, negative for withdrawals.
 *
 * For the portfolio chart we always anchor at the wallet's first external
 * deposit (startBalance = 0, startTime = first deposit time). Snapshots taken
 * before that anchor return 0.
 */

export interface ExternalFlow {
  time: Date;
  /** Positive for deposits, negative for withdrawals. USD-denominated. */
  amount: number;
}

export function modifiedDietzReturn(
  startTime: Date,
  endTime: Date,
  startBalance: number,
  endBalance: number,
  flows: ExternalFlow[],
): number {
  const periodMs = endTime.getTime() - startTime.getTime();
  if (periodMs <= 0) return 0;

  let totalFlow = 0;
  let weightedFlow = 0;
  for (const f of flows) {
    const t = f.time.getTime();
    if (t < startTime.getTime() || t > endTime.getTime()) continue;
    totalFlow += f.amount;
    const weight = (endTime.getTime() - t) / periodMs;
    weightedFlow += f.amount * weight;
  }

  const denom = startBalance + weightedFlow;
  if (Math.abs(denom) < 1) return 0; // not enough capital deployed to be meaningful
  const r = (endBalance - startBalance - totalFlow) / denom;
  // Sanity clamp: cap at [-99%, +1000%]. A return below -100% (lost more than
  // weighted capital) is mathematically possible when withdrawals exceed
  // contributions, but it confuses users on the chart. Cap to -0.99 for
  // display. Upper bound stays generous for genuine winners.
  return Math.max(-0.99, Math.min(10, r));
}
