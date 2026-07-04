/**
 * Fixed Yield maturity notifier.
 *
 * Scans for active fy_positions past their maturity date whose owner has not
 * been told, and sends a one-time Telegram note per position. Contract cloned
 * from the borrow-health monitor:
 *   - notify BEFORE persist: notifiedMaturityAt is only written after the
 *     send resolves `sent` (delivered) or `skipped` (no recipient — nothing
 *     will ever deliver, don't spin forever).
 *   - a `failed` (transient) send leaves the row un-marked so the next scan
 *     retries — a maturity note is never silently lost.
 *
 * Read-only w.r.t. money: this scan never touches funds. Redemption is a
 * separate (future) money path; v1 tells the user their fixed rate is earned.
 */

import { storage } from "../../storage";
import { sendFyMaturityNotification } from "../../notification-service";

export interface FyMaturityScanResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runFyMaturityScan(): Promise<FyMaturityScanResult> {
  const now = new Date();
  const rows = await storage.getMaturedUnnotifiedFyPositions(now);
  const result: FyMaturityScanResult = { scanned: rows.length, sent: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    try {
      const costBasis = Number(row.costBasisUsdc);
      const apy = row.impliedApyAtEntry !== null ? Number(row.impliedApyAtEntry) : null;
      // Same est. formula as the status route: cost × (1 + apy × termYears).
      let projected: number | null = null;
      if (Number.isFinite(costBasis) && apy !== null && Number.isFinite(apy) && row.createdAt && row.maturityAt) {
        const termYears = (row.maturityAt.getTime() - row.createdAt.getTime()) / (365.25 * 86_400_000);
        if (termYears > 0) projected = costBasis * (1 + apy * termYears);
      }
      const maturityLabel = row.maturityAt ? row.maturityAt.toISOString().slice(0, 10) : "recently";

      const outcome = await sendFyMaturityNotification(row.walletAddress, {
        underlyingSymbol: row.underlyingSymbol,
        costBasisUsdc: Number.isFinite(costBasis) ? costBasis : null,
        projectedValueUsdc: projected,
        maturityDateLabel: maturityLabel,
      });

      if (outcome === "failed") {
        result.failed += 1;
        continue; // leave un-marked → retried next scan
      }
      await storage.updateFyPosition(row.id, { notifiedMaturityAt: now });
      if (outcome === "sent") result.sent += 1;
      else result.skipped += 1;
    } catch (err) {
      // Fail-soft per row: one bad row must not block the rest of the list.
      result.failed += 1;
      console.error(`[fixed-yield] maturity notify failed for position ${row.id}:`, err);
    }
  }

  return result;
}
