export const BOT_TRADE_PNL_CONVENTIONS = [
  "net_of_close_fee",
  "gross_before_close_fee",
] as const;

export type BotTradePnlConvention = typeof BOT_TRADE_PNL_CONVENTIONS[number];

export const BOT_TRADE_FEE_TRUTH_STATUSES = [
  "legacy_unverified",
  "venue_exact_repaired",
  "current_pipeline",
] as const;

export type BotTradeFeeTruthStatus = typeof BOT_TRADE_FEE_TRUTH_STATUSES[number];

const RECONCILED_FULL_CLOSE_REASONS = new Set([
  "external_close",
  "tpsl",
  "liquidation",
]);

export interface LegacyBotTradePnlProvenance {
  executionMethod: string | null | undefined;
  reconciled: boolean | null | undefined;
  closeReason: string | null | undefined;
}

export function classifyLegacyBotTradePnlConvention(
  provenance: LegacyBotTradePnlProvenance,
): BotTradePnlConvention {
  return provenance.executionMethod === "on-chain-detected"
    && provenance.reconciled === true
    && typeof provenance.closeReason === "string"
    && RECONCILED_FULL_CLOSE_REASONS.has(provenance.closeReason)
    ? "gross_before_close_fee"
    : "net_of_close_fee";
}

export interface BotTradePnlValue {
  pnl: string | number | null | undefined;
  fee: string | number | null | undefined;
  pnlConvention: string | null | undefined;
}

function finiteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert one persisted bot_trades row to the canonical net-of-close-fee value.
 *
 * Unclassified, malformed, and gross rows without a finite fee are unavailable.
 * Callers must omit them from enrichment/derived statistics rather than coerce
 * them to zero.
 */
export function resolveBotTradeNetPnl(row: BotTradePnlValue): number | null {
  const pnl = finiteNumber(row.pnl);
  if (pnl === null) return null;

  if (row.pnlConvention === "net_of_close_fee") return pnl;
  if (row.pnlConvention !== "gross_before_close_fee") return null;

  const fee = finiteNumber(row.fee);
  return fee === null ? null : pnl - fee;
}
