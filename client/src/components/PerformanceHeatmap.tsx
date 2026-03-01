import React from 'react';
import { usePerformanceHeatmap } from '@/hooks/useApi';
import { Loader2, BarChart3, TrendingUp, TrendingDown } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function getCellColor(pnl: number, maxAbs: number, count: number): string {
  if (count === 0) return 'rgba(255,255,255,0.03)';
  if (maxAbs === 0) return 'rgba(255,255,255,0.06)';
  const intensity = Math.min(Math.abs(pnl) / maxAbs, 1);
  if (pnl > 0) {
    const alpha = 0.15 + intensity * 0.7;
    return `rgba(16, 185, 129, ${alpha})`;
  } else {
    const alpha = 0.15 + intensity * 0.7;
    return `rgba(239, 68, 68, ${alpha})`;
  }
}

export function PerformanceHeatmap() {
  const { data, isLoading } = usePerformanceHeatmap();

  if (isLoading) {
    return (
      <div className="gradient-border p-6 noise">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="ml-3 text-muted-foreground">Loading heatmap...</span>
        </div>
      </div>
    );
  }

  if (!data || data.totalTrades === 0) {
    return (
      <div className="gradient-border p-6 noise">
        <div className="flex items-center gap-3 mb-4">
          <BarChart3 className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-display font-semibold">Performance Heatmap</h2>
        </div>
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <div className="text-center">
            <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No trade data available yet</p>
            <p className="text-sm mt-1">Execute some trades to see your performance heatmap</p>
          </div>
        </div>
      </div>
    );
  }

  const { days, cells, markets } = data;
  const maxAbsPnl = Math.max(...cells.filter(c => c.count > 0).map(c => Math.abs(c.pnl)), 0.01);

  const displayHours = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

  return (
    <div className="gradient-border p-6 noise space-y-6" data-testid="performance-heatmap">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-5 h-5 text-muted-foreground" />
          <div>
            <h2 className="font-display font-semibold">Performance Heatmap</h2>
            <p className="text-xs text-muted-foreground">{data.totalTrades} executed trades · P&L by day & hour (UTC)</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(239, 68, 68, 0.7)' }} />
            <span>Loss</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(255,255,255,0.06)' }} />
            <span>No trades</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(16, 185, 129, 0.7)' }} />
            <span>Profit</span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[600px]">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: '48px repeat(24, 1fr)' }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-center text-[10px] text-muted-foreground pb-1">
                {displayHours.includes(h) ? `${h.toString().padStart(2, '0')}` : ''}
              </div>
            ))}

            {days.map((day, dayIdx) => (
              <React.Fragment key={dayIdx}>
                <div className="flex items-center text-xs text-muted-foreground font-medium pr-2 justify-end">
                  {day}
                </div>
                {Array.from({ length: 24 }, (_, hourIdx) => {
                  const cell = cells[dayIdx * 24 + hourIdx];
                  return (
                    <TooltipProvider key={`${dayIdx}-${hourIdx}`}>
                      <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                          <div
                            className="aspect-square rounded-[3px] cursor-crosshair transition-all duration-150 hover:ring-1 hover:ring-white/30 hover:scale-110"
                            style={{ backgroundColor: getCellColor(cell.pnl, maxAbsPnl, cell.count) }}
                            data-testid={`heatmap-cell-${dayIdx}-${hourIdx}`}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <div className="text-xs space-y-0.5">
                            <p className="font-medium">{days[cell.day]} {cell.hour.toString().padStart(2, '0')}:00 UTC</p>
                            <p>{cell.count} trade{cell.count !== 1 ? 's' : ''}</p>
                            {cell.count > 0 && (
                              <p className={cell.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {cell.pnl >= 0 ? '+' : ''}${cell.pnl.toFixed(2)} P&L
                              </p>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {markets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">P&L by Market</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {markets.map((m) => (
              <div
                key={m.market}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                data-testid={`heatmap-market-${m.market}`}
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{m.market}</p>
                  <p className="text-[10px] text-muted-foreground">{m.count} trades · {m.winRate}% win</p>
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  {m.pnl >= 0 ? (
                    <TrendingUp className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-3 h-3 text-red-400" />
                  )}
                  <span className={`text-xs font-mono font-medium ${m.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}