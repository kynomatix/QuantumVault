import { healthBarColor, RECOMMENDED_MAX_LTV, type LtvBarModel } from "@/lib/lending-format";

// One LTV / loan-health bar, shared by every borrow surface (per-bot loan card,
// Defend dialog, Borrow-More dialog, live Wallet loan rows) so the "danger line"
// — the per-asset LIQUIDATION LTV — renders identically everywhere. All geometry
// comes from getLtvBarModel(); this component is pure presentation.
//
// The bar is framed so its right edge = the liquidation threshold, so the fill's
// distance from the red danger line IS the position's real distance to
// liquidation. Two guide markers sit inside: "Safe" (recommended LTV) and, when
// there is a gap, "Max Borrow" (the protocol borrow cap). The fill COLOR still
// ramps with borrowing-power used, so a maxed-out loan reads hot while showing the
// small cushion left before the liquidation line.
//
// Render only when model.fillPct != null; the caller shows its own "unavailable"
// fallback (fail closed — never a fabricated fill).
export function LtvBar({
  model,
  currentLtvLabel,
  showLegend = true,
  testId,
  barTitle,
}: {
  model: LtvBarModel;
  /** Left-most legend chip, e.g. "32% LTV" or "Projected 40% LTV". Omitted when null. */
  currentLtvLabel?: string | null;
  showLegend?: boolean;
  /** Stable suffix for data-testids (bar-{testId}, marker-danger-{testId}, ...). */
  testId: string;
  barTitle?: string;
}) {
  const {
    fillPct,
    colorUsagePct,
    safeMarkerPct,
    maxBorrowMarkerPct,
    dangerMarkerPct,
    maxBorrowPct,
    liquidationPct,
  } = model;
  if (fillPct == null) return null;

  return (
    <>
      <div className="relative">
        <div
          className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
          title={barTitle}
          data-testid={`bar-${testId}`}
        >
          <div
            className="h-full rounded-full transition-all duration-200"
            style={{ width: `${fillPct}%`, backgroundColor: healthBarColor(colorUsagePct ?? fillPct) }}
          />
        </div>
        {/* Safe limit (recommended LTV) — faintest guide line. */}
        {safeMarkerPct != null && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/40"
            style={{ left: `${safeMarkerPct}%` }}
            title={`Safe limit (${Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)`}
            data-testid={`marker-safe-${testId}`}
          />
        )}
        {/* Max borrow (protocol cap) — only shown when it sits below liquidation.
            Bold NEUTRAL line (no amber): the firm borrow ceiling just short of the
            red liquidation edge. Red is reserved for the danger line alone. */}
        {maxBorrowMarkerPct != null && maxBorrowPct != null && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/90"
            style={{ left: `${maxBorrowMarkerPct}%` }}
            title={`Max Borrow (${maxBorrowPct}% LTV)`}
            data-testid={`marker-maxborrow-${testId}`}
          />
        )}
        {/* Danger line — the liquidation LTV at the frame's right edge. */}
        {dangerMarkerPct != null && liquidationPct != null && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-red-500"
            style={{ left: `${dangerMarkerPct}%`, transform: "translateX(-100%)" }}
            title={`Liquidation (${liquidationPct}% LTV)`}
            data-testid={`marker-danger-${testId}`}
          />
        )}
      </div>
      {showLegend && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground"
          data-testid={`legend-${testId}`}
        >
          {currentLtvLabel && (
            <span className="tabular-nums text-foreground" data-testid={`text-current-ltv-${testId}`}>
              {currentLtvLabel}
            </span>
          )}
          {safeMarkerPct != null && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-px shrink-0 bg-foreground/40" />
              Safe {Math.round(RECOMMENDED_MAX_LTV * 100)}%
            </span>
          )}
          {maxBorrowMarkerPct != null && maxBorrowPct != null && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-px shrink-0 bg-foreground/90" />
              Max Borrow {maxBorrowPct}%
            </span>
          )}
          {dangerMarkerPct != null && liquidationPct != null && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-500">
              <span className="inline-block h-2.5 w-0.5 shrink-0 rounded-full bg-red-500" />
              Liquidation {liquidationPct}%
            </span>
          )}
        </div>
      )}
    </>
  );
}
