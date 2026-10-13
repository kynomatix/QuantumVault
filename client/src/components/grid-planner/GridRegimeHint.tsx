import type { GridRegime } from '../../../../shared/grid-regime';
export function GridRegimeHint({ regime, timeframe }: { regime: GridRegime | null; timeframe: string }) {
  return <section aria-label="Selected timeframe ADX advisory" className="rounded-lg border border-border/60 bg-card/40 p-3 text-sm space-y-1">
    <p className="font-medium" title={regime?.state === 'available'
      ? `${regime.venue.toUpperCase()} direct perpetual · ${regime.bars} finalized candles · latest ${new Date(regime.latestFinalizedTime).toUTCString()}`
      : regime?.reason ?? 'Choose a market to read finalized perpetual history.'}>
      ADX(14) · {timeframe}: {regime?.state === 'available' ? `${regime.adx.toFixed(1)} · ${regime.label}` : 'UNKNOWN'}</p>
    {regime?.state === 'available' && regime.label === 'trending' && <p className="text-amber-500">Caution: this market looks trending. Price may move out of your grid range.</p>}
    <p className="text-xs text-muted-foreground">Advisory only. Choose either direction; this does not block your plan.</p>
  </section>;
}
