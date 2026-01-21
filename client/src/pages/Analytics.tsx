import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';

interface PlatformMetrics {
  tvl: number;
  totalVolume: number;
  volume24h: number;
  volume7d: number;
  activeBots: number;
  activeUsers: number;
  totalTrades: number;
  lastUpdated: string;
}

interface HistoricalDataPoint {
  timestamp: string;
  value: number;
}

interface MetricsHistory {
  tvl: HistoricalDataPoint[];
  volume: HistoricalDataPoint[];
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  } else if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

function formatShortDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

function LivePulse() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
      <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
    </span>
  );
}

function AreaChart({ data, label, testId }: {
  data: HistoricalDataPoint[];
  label: string;
  testId: string;
}) {
  if (!data || data.length < 2) return null;

  const values = data.map(d => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  
  const width = 400;
  const height = 140;
  const padding = { top: 16, right: 16, bottom: 32, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const points = data.map((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - ((d.value - min) / range) * chartHeight;
    return { x, y, value: d.value, date: d.timestamp };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${padding.left} ${padding.top + chartHeight} Z`;

  const yAxisTicks = [min, min + range * 0.5, max];
  
  return (
    <div data-testid={testId}>
      <p className="text-sm text-muted-foreground mb-3">{label}</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <defs>
          <linearGradient id={`grad-${testId}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(139, 92, 246)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(139, 92, 246)" stopOpacity="0" />
          </linearGradient>
        </defs>
        
        {yAxisTicks.map((tick, i) => {
          const y = padding.top + chartHeight - ((tick - min) / range) * chartHeight;
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="currentColor"
                strokeWidth="1"
                opacity="0.1"
              />
              <text
                x={padding.left - 8}
                y={y + 3}
                fill="currentColor"
                fontSize="9"
                textAnchor="end"
                opacity="0.5"
              >
                {formatCurrency(tick)}
              </text>
            </g>
          );
        })}

        <motion.path
          d={areaPath}
          fill={`url(#grad-${testId})`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.5 }}
        />
        
        <motion.path
          d={linePath}
          fill="none"
          stroke="rgb(139, 92, 246)"
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.2, duration: 0.8, ease: "easeOut" }}
        />

        <text x={padding.left} y={height - 8} fill="currentColor" fontSize="9" opacity="0.5">
          {formatShortDate(data[0].timestamp)}
        </text>
        <text x={width - padding.right} y={height - 8} fill="currentColor" fontSize="9" textAnchor="end" opacity="0.5">
          {formatShortDate(data[data.length - 1].timestamp)}
        </text>
      </svg>
    </div>
  );
}

export default function Analytics() {
  const { data: metrics, isLoading, error } = useQuery<PlatformMetrics>({
    queryKey: ['platform-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error('Failed to fetch metrics');
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: history } = useQuery<MetricsHistory>({
    queryKey: ['metrics-history'],
    queryFn: async () => {
      const res = await fetch('/api/metrics/history');
      if (!res.ok) throw new Error('Failed to fetch history');
      return res.json();
    },
    refetchInterval: 300000,
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -left-40 w-80 h-80 bg-blue-500/10 rounded-full blur-3xl" />
      </div>

      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5" data-testid="link-home">
            <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
            <span className="font-display font-semibold text-lg">QuantumVault</span>
          </Link>
          
          <div className="flex items-center gap-6">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:block" data-testid="link-home-nav">Home</Link>
            <span className="text-sm text-foreground font-medium hidden sm:block" data-testid="link-analytics-active">Analytics</span>
            <Link href="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:block" data-testid="link-docs">Docs</Link>
            <a href="/app">
              <Button size="sm" data-testid="button-launch-app">
                Launch App
              </Button>
            </a>
          </div>
        </div>
      </nav>

      <main className="relative pt-20 pb-16 px-6">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-12"
          >
            <div className="flex items-center gap-2 mb-4">
              <LivePulse />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Live Data</span>
            </div>
            <h1 className="text-4xl md:text-5xl font-display font-bold mb-3">
              Platform Analytics
            </h1>
            <p className="text-muted-foreground">
              On-chain metrics from Drift Protocol
            </p>
          </motion.div>

          {isLoading ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-24 rounded-xl bg-card/50 animate-pulse" />
                ))}
              </div>
            </div>
          ) : error ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16">
              <p className="text-destructive">Failed to load metrics</p>
            </motion.div>
          ) : metrics ? (
            <div className="space-y-8">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="grid grid-cols-2 lg:grid-cols-4 gap-4"
              >
                <div className="p-6 rounded-xl bg-gradient-to-br from-violet-500/10 to-violet-500/5 border border-violet-500/20" data-testid="card-tvl">
                  <p className="text-xs text-violet-300 uppercase tracking-wider mb-1">TVL</p>
                  <p className="text-3xl font-display font-bold" data-testid="value-tvl">{formatCurrency(metrics.tvl)}</p>
                </div>
                <div className="p-6 rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20" data-testid="card-total-volume">
                  <p className="text-xs text-blue-300 uppercase tracking-wider mb-1">Total Volume</p>
                  <p className="text-3xl font-display font-bold" data-testid="value-total-volume">{formatCurrency(metrics.totalVolume)}</p>
                </div>
                <div className="p-6 rounded-xl bg-card/50 border border-border/30" data-testid="card-volume-24h">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">24h Volume</p>
                  <p className="text-3xl font-display font-bold" data-testid="value-volume-24h">{formatCurrency(metrics.volume24h)}</p>
                </div>
                <div className="p-6 rounded-xl bg-card/50 border border-border/30" data-testid="card-volume-7d">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">7d Volume</p>
                  <p className="text-3xl font-display font-bold" data-testid="value-volume-7d">{formatCurrency(metrics.volume7d)}</p>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="grid grid-cols-3 gap-4"
              >
                <div className="p-6 rounded-xl bg-card/30 border border-border/20 text-center" data-testid="card-active-bots">
                  <p className="text-4xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent" data-testid="value-active-bots">
                    {metrics.activeBots}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Active Bots</p>
                </div>
                <div className="p-6 rounded-xl bg-card/30 border border-border/20 text-center" data-testid="card-active-users">
                  <p className="text-4xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent" data-testid="value-active-users">
                    {metrics.activeUsers}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Traders</p>
                </div>
                <div className="p-6 rounded-xl bg-card/30 border border-border/20 text-center" data-testid="card-total-trades">
                  <p className="text-4xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent" data-testid="value-total-trades">
                    {formatNumber(metrics.totalTrades)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Trades</p>
                </div>
              </motion.div>

              {history && (history.tvl.length > 1 || history.volume.length > 1) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="grid grid-cols-1 lg:grid-cols-2 gap-6"
                >
                  {history.tvl.length > 1 && (
                    <div className="p-6 rounded-xl bg-card/30 border border-border/20">
                      <AreaChart data={history.tvl} label="TVL Over Time" testId="chart-tvl-history" />
                    </div>
                  )}
                  {history.volume.length > 1 && (
                    <div className="p-6 rounded-xl bg-card/30 border border-border/20">
                      <AreaChart data={history.volume} label="Cumulative Volume" testId="chart-volume-history" />
                    </div>
                  )}
                </motion.div>
              )}

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="p-8 rounded-xl bg-gradient-to-r from-violet-500/20 via-blue-500/20 to-violet-500/20 border border-violet-500/30"
              >
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div>
                    <h3 className="font-display font-bold text-xl mb-1">Ready to trade?</h3>
                    <p className="text-sm text-muted-foreground">Deploy automated bots on Solana</p>
                  </div>
                  <a href="/app">
                    <Button className="gap-2 bg-violet-600 hover:bg-violet-700" data-testid="button-get-started">
                      Get Started
                      <ArrowUpRight className="w-4 h-4" />
                    </Button>
                  </a>
                </div>
              </motion.div>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="border-t border-border/50 bg-card/20">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-6 h-6 rounded" />
              <span className="font-display font-semibold text-sm">QuantumVault</span>
            </div>
            <p className="text-xs text-muted-foreground">Built on Solana</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
