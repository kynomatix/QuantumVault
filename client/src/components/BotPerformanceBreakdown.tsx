import { usePortfolioBotPerformance } from '@/hooks/useApi';
import { Bot, TrendingUp, TrendingDown, AlertCircle, RefreshCw } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';

interface Props {
  range?: string;
}

function Sparkline({ data, positive }: { data: { t: string; v: number }[]; positive: boolean }) {
  if (data.length < 2) {
    return (
      <div className="w-24 h-10 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground/50">no data</span>
      </div>
    );
  }
  const color = positive ? '#10b981' : '#ef4444';
  return (
    <div className="w-24 h-10" data-testid="bot-sparkline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <RechartsTooltip
            contentStyle={{
              backgroundColor: 'rgba(23,23,23,0.95)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '11px',
            }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cum. P&L']}
            labelFormatter={(label: string) => label}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SharpeLabel({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground/50">—</span>;
  const color =
    value >= 1 ? 'text-emerald-400' :
    value >= 0 ? 'text-yellow-400' :
    'text-red-400';
  return <span className={color}>{value.toFixed(2)}</span>;
}

export function BotPerformanceBreakdown({ range = 'all' }: Props) {
  const { data, isLoading, isError, refetch } = usePortfolioBotPerformance(range);

  if (isLoading) {
    return (
      <div className="gradient-border p-6 noise">
        <div className="flex items-center gap-3 mb-5">
          <Bot className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-display font-semibold">Bot Performance</h2>
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || data === null) {
    return (
      <div className="gradient-border p-6 noise" data-testid="bot-performance-breakdown">
        <div className="flex items-center gap-3 mb-5">
          <Bot className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-display font-semibold">Bot Performance</h2>
        </div>
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <div className="text-center space-y-3">
            <AlertCircle className="w-10 h-10 mx-auto opacity-40" />
            <p className="text-sm">Could not load performance data</p>
            <button
              onClick={() => refetch()}
              className="flex items-center gap-1.5 mx-auto text-xs text-primary hover:underline"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const bots = data.bots ?? [];
  const markets = data.markets ?? [];

  if (bots.length === 0) {
    return (
      <div className="gradient-border p-6 noise" data-testid="bot-performance-breakdown">
        <div className="flex items-center gap-3 mb-5">
          <Bot className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-display font-semibold">Bot Performance</h2>
        </div>
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <div className="text-center">
            <Bot className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No bots yet</p>
            <p className="text-sm mt-1">Create a trading bot to see performance here</p>
          </div>
        </div>
      </div>
    );
  }

  const rangeLabel: Record<string, string> = {
    '7d': 'last 7 days', '1m': 'last 30 days', '3m': 'last 3 months',
    '12m': 'last 12 months', 'all': 'all time',
  };

  return (
    <div className="gradient-border p-6 noise space-y-6" data-testid="bot-performance-breakdown">
      <div className="flex items-start gap-3">
        <Bot className="w-5 h-5 text-muted-foreground mt-0.5" />
        <div className="space-y-0.5">
          <h2 className="font-display font-semibold">Bot Performance</h2>
          <p className="text-xs text-muted-foreground">
            Sorted by net P&L · {rangeLabel[range] ?? range} · Sharpe ratio annualised (daily returns ×√252)
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {bots.map((bot) => {
          const isProfit = bot.netPnl >= 0;
          return (
            <div
              key={bot.id}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-opacity ${
                bot.isActive
                  ? 'bg-white/[0.03] border-white/[0.06]'
                  : 'bg-white/[0.015] border-white/[0.04] opacity-55'
              }`}
              data-testid={`bot-performance-row-${bot.id}`}
            >
              {/* Name + market + badge */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium truncate" data-testid={`bot-name-${bot.id}`}>
                    {bot.name}
                  </p>
                  <span
                    className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                      bot.isActive
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-white/[0.06] text-muted-foreground'
                    }`}
                    data-testid={`bot-status-${bot.id}`}
                  >
                    {bot.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{bot.market}</p>
              </div>

              {/* Sparkline */}
              <div className="shrink-0 hidden sm:block">
                <Sparkline data={bot.sparkline} positive={isProfit} />
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right hidden md:block">
                  <p className="text-[10px] text-muted-foreground">Trades</p>
                  <p className="text-xs font-mono font-medium" data-testid={`bot-trades-${bot.id}`}>
                    {bot.totalTrades > 0 ? bot.totalTrades : '—'}
                  </p>
                </div>
                <div className="text-right hidden md:block">
                  <p className="text-[10px] text-muted-foreground">Win Rate</p>
                  <p className="text-xs font-mono font-medium" data-testid={`bot-winrate-${bot.id}`}>
                    {bot.totalTrades > 0 ? `${bot.winRate}%` : '—'}
                  </p>
                </div>
                <div className="text-right hidden lg:block">
                  <p className="text-[10px] text-muted-foreground">Sharpe</p>
                  <p className="text-xs font-mono font-medium" data-testid={`bot-sharpe-${bot.id}`}>
                    <SharpeLabel value={bot.sharpe} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground">Net P&L</p>
                  <div className="flex items-center gap-1 justify-end">
                    {bot.totalTrades > 0 ? (
                      isProfit ? (
                        <TrendingUp className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <TrendingDown className="w-3 h-3 text-red-400" />
                      )
                    ) : null}
                    <span
                      className={`text-xs font-mono font-semibold ${
                        bot.totalTrades === 0
                          ? 'text-muted-foreground'
                          : isProfit ? 'text-emerald-400' : 'text-red-400'
                      }`}
                      data-testid={`bot-pnl-${bot.id}`}
                    >
                      {bot.totalTrades === 0 ? '—' : `${isProfit ? '+' : ''}$${bot.netPnl.toFixed(2)}`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {markets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">P&L by Market</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {markets.map((m) => (
              <div
                key={m.market}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                data-testid={`bot-performance-market-${m.market}`}
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
