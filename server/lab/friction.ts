// Trade-friction model shared by all QuantumLab backtest engines.
//
// Slippage is charged as a fraction of notional PER SIDE, mirroring how
// commission is charged round-trip at every close site. The entry side is
// always 1x; the exit side is 2x for stop-style exits (stops cross the book at
// market when they trigger and fill worse than limit/signal exits). This is a
// cost-only model — it never changes fill prices or order logic, so adding it
// can only reduce net profit, never invent trades.

// Sensible default applied to NEW optimization runs at creation (routes.ts).
// Engines themselves treat undefined slippage as 0, so any direct caller or a
// legacy run resumed without slippage in its config stays exactly unchanged.
export const DEFAULT_LAB_SLIPPAGE = 0.0005;

// Stop-style exits fill worse than limit/signal exits. Matches the exitReason
// strings used across every lab engine: native ("Stop Loss" / "BE Stop" /
// "Trail Stop"), sbr ("sl" / "trail"), ar38 ("Stop"), and Pine user comments
// (best-effort). Non-stop exits (TP, signal flips, end-of-data, "Open
// Position") → false → single exit-side slippage.
export function isStopExit(reason: string | undefined | null): boolean {
  return /stop|trail|liquidat|\bsl\b/i.test(reason || "");
}

// Round-trip slippage cost in dollars for closing `qty` units of `positionSize`
// notional each. `slip` is a fraction of notional per side. Entry side = 1x;
// exit side = 2x for stop-style exits, 1x otherwise. Returns 0 when slip is
// falsy (undefined / 0) so the default path is a no-op.
export function slippageCost(
  qty: number,
  positionSize: number,
  slip: number | undefined,
  reason?: string | null,
): number {
  if (!slip) return 0;
  const exitMult = isStopExit(reason) ? 2 : 1;
  return qty * positionSize * slip * (1 + exitMult);
}
