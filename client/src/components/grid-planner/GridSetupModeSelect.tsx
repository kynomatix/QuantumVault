import React from 'react';
import { Sparkles, SlidersHorizontal } from 'lucide-react';
import { GRID_BACKTEST_LABEL, GRID_BACKTEST_PERIOD } from '../../../../shared/grid-research-facts';
import type { GridSetupMode } from '@/lib/grid-simple-view';

export function GridSimpleWhy() {
  return <details className="rounded-xl border border-border bg-card/60 text-sm">
    <summary className="cursor-pointer min-h-12 px-4 py-3 font-medium focus-visible:outline focus-visible:outline-primary">Why these settings?</summary>
    <div className="px-4 pb-4 space-y-3">
      <p><strong className="capitalize">{GRID_BACKTEST_LABEL}</strong> simulated grid bots, {GRID_BACKTEST_PERIOD}</p>
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground">What Simple uses</h4>
      <ul className="grid grid-cols-1 @min-[440px]:grid-cols-2 gap-2 list-disc pl-4">
        <li>A range from the last 7 days' high and low</li><li>10 levels between them</li>
        <li>Step back: waits for price to come back before buying again</li>
        <li>Keeps the stop: bots without one lost far more at leverage</li>
        <li>Bigger buys further from price, bigger take-profits near it</li>
        <li>Low fees matter most, so we keep them low</li>
      </ul>
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground">What didn't help, so it's left out</h4>
      <ul className="grid grid-cols-1 @min-[440px]:grid-cols-2 gap-2 list-disc pl-4 text-muted-foreground">
        <li>Moving the range automatically</li><li>Direction signals</li>
        <li>Picking "quiet" or sideways markets</li><li>Extra entry rules</li>
      </ul>
      <p className="text-xs text-muted-foreground">Past results don't guarantee future returns. Grid bots can lose money, and leverage multiplies losses as well as gains.</p>
    </div>
  </details>;
}
export function GridSetupModeSelect({ onSelect }: { onSelect: (mode: GridSetupMode) => void }) {
  return <div className="@container space-y-4">
    <div className="grid grid-cols-1 @min-[440px]:grid-cols-2 auto-rows-fr items-stretch gap-5">
      {(['simple', 'advanced'] as const).map(mode => {
        const simple = mode === 'simple', Icon = simple ? Sparkles : SlidersHorizontal;
        return <button key={mode} type="button" onClick={() => onSelect(mode)} data-testid={`grid-setup-${mode}`}
          aria-label={simple ? 'Simple setup' : 'Advanced setup'}
          aria-description={simple ? `Settings informed by ${GRID_BACKTEST_LABEL} simulated grid bot runs, ${GRID_BACKTEST_PERIOD}.` : undefined}
          className="gradient-border p-5 noise flex flex-col gap-3 text-left min-w-0 no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary hover:scale-[1.01] transition-transform">
          <span className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center shrink-0"><Icon className="h-5 w-5 text-primary" aria-hidden="true" /></span>
            <span><span className="block font-semibold">{simple ? 'Simple' : 'Advanced'}</span>
              <span className="block text-xs text-muted-foreground">{simple ? 'We set it up for you' : 'Every setting, your way'}</span></span>
          </span>
          <span className="text-xs text-muted-foreground">{simple ? 'Pick a market, direction and amount. We set the rest from our backtests.' : 'Set every setting yourself: range, levels, sizing, leverage and stop.'}</span>
          <span className="mt-auto min-h-11 rounded-md bg-gradient-to-r from-primary to-accent text-primary-foreground px-3 py-3 text-sm text-center font-medium">{simple ? 'Start simple →' : 'Open advanced →'}</span>
        </button>;
      })}
    </div>
    <GridSimpleWhy />
  </div>;
}
