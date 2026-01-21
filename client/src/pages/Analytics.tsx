import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowUpRight, Zap, Users, BarChart2 } from 'lucide-react';
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

function HeroStat({ value, label, sublabel, gradient, delay = 0, testId }: {
  value: string;
  label: string;
  sublabel: string;
  gradient: string;
  delay?: number;
  testId: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.5, ease: "easeOut" }}
      className="relative group"
      data-testid={`card-${testId}`}
    >
      <div className={`absolute inset-0 ${gradient} rounded-3xl blur-xl opacity-30 group-hover:opacity-50 transition-opacity duration-500`} />
      <div className="relative p-8 rounded-3xl bg-card/80 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className={`absolute top-0 right-0 w-32 h-32 ${gradient} opacity-10 blur-3xl`} />
        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">{label}</p>
        <p className="text-5xl md:text-6xl font-display font-bold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent" data-testid={`value-${testId}`}>
          {value}
        </p>
        <p className="text-sm text-muted-foreground mt-3">{sublabel}</p>
      </div>
    </motion.div>
  );
}

function StatBlock({ value, label, icon, gradient, delay = 0, testId }: {
  value: number;
  label: string;
  icon: React.ReactNode;
  gradient: string;
  delay?: number;
  testId: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
      className="relative p-8 rounded-2xl bg-card/50 border border-border/30 overflow-hidden group"
      data-testid={`card-${testId}`}
    >
      <div className={`absolute top-0 right-0 w-24 h-24 ${gradient} opacity-20 blur-2xl group-hover:opacity-30 transition-opacity`} />
      <div className="relative flex items-center gap-6">
        <div className={`w-16 h-16 rounded-2xl ${gradient} flex items-center justify-center text-white shadow-lg`}>
          {icon}
        </div>
        <div>
          <motion.p 
            className="text-4xl font-display font-bold"
            data-testid={`value-${testId}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: delay + 0.2 }}
          >
            {formatNumber(value)}
          </motion.p>
          <p className="text-sm text-muted-foreground mt-1">{label}</p>
        </div>
      </div>
    </motion.div>
  );
}

function AreaChart({ data, label, color, testId }: {
  data: HistoricalDataPoint[];
  label: string;
  color: string;
  testId: string;
}) {
  if (!data || data.length < 2) return null;

  const values = data.map(d => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  
  const width = 400;
  const height = 160;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
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
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.5, duration: 0.5 }}
      className="p-6 rounded-2xl bg-card/50 border border-border/30"
      data-testid={testId}
    >
      <h3 className="font-display font-semibold text-lg mb-4">{label}</h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: '200px' }}>
        <defs>
          <linearGradient id={`gradient-${testId}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
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
                stroke="hsl(var(--border))"
                strokeWidth="1"
                strokeDasharray="4,4"
                opacity="0.3"
              />
              <text
                x={padding.left - 8}
                y={y + 4}
                fill="hsl(var(--muted-foreground))"
                fontSize="10"
                textAnchor="end"
              >
                {formatCurrency(tick)}
              </text>
            </g>
          );
        })}

        <motion.path
          d={areaPath}
          fill={`url(#gradient-${testId})`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.5 }}
        />
        
        <motion.path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.6, duration: 1, ease: "easeOut" }}
        />

        {points.length > 0 && (
          <motion.circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r="5"
            fill={color}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 1.6, duration: 0.3 }}
          />
        )}

        <text
          x={padding.left}
          y={height - 10}
          fill="hsl(var(--muted-foreground))"
          fontSize="10"
        >
          {formatShortDate(data[0].timestamp)}
        </text>
        <text
          x={width - padding.right}
          y={height - 10}
          fill="hsl(var(--muted-foreground))"
          fontSize="10"
          textAnchor="end"
        >
          {formatShortDate(data[data.length - 1].timestamp)}
        </text>
      </svg>
    </motion.div>
  );
}

function LiveIndicator() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
      </span>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Live</span>
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
    <div className="min-h-screen bg-background overflow-hidden">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-3xl opacity-20" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/20 rounded-full blur-3xl opacity-20" />
      </div>

      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/60 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3" data-testid="link-home">
            <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-10 h-10 rounded-xl" />
            <span className="font-display font-bold text-xl">QuantumVault</span>
          </Link>
          
          <div className="hidden md:flex items-center gap-8">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-home-nav">Home</Link>
            <span className="text-sm text-foreground font-medium" data-testid="link-analytics-active">Analytics</span>
            <Link href="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-docs">Docs</Link>
          </div>

          <a href="/app">
            <Button size="sm" className="gap-2" data-testid="button-launch-app">
              Launch App
              <ArrowUpRight className="w-4 h-4" />
            </Button>
          </a>
        </div>
      </nav>

      <main className="relative pt-24 pb-16 px-6">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-16"
          >
            <div className="flex items-center justify-center gap-3 mb-6">
              <LiveIndicator />
              {metrics?.lastUpdated && (
                <span className="text-xs text-muted-foreground" data-testid="text-last-updated">
                  Updated {new Date(metrics.lastUpdated).toLocaleTimeString()}
                </span>
              )}
            </div>
            <h1 className="text-5xl md:text-7xl font-display font-bold mb-6 bg-gradient-to-r from-foreground via-foreground to-foreground/50 bg-clip-text text-transparent">
              Platform Analytics
            </h1>
            <p className="text-lg text-muted-foreground max-w-xl mx-auto">
              Real-time on-chain statistics from the Drift Protocol
            </p>
          </motion.div>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-48 rounded-3xl bg-card/30 animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-20"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10 mb-4">
                <span className="text-2xl">!</span>
              </div>
              <p className="text-destructive">Failed to load metrics</p>
            </motion.div>
          ) : metrics ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
                <HeroStat
                  value={formatCurrency(metrics.tvl)}
                  label="Total Value Locked"
                  sublabel="Capital deployed across all trading bots"
                  gradient="bg-gradient-to-br from-emerald-500 to-teal-600"
                  delay={0}
                  testId="tvl"
                />
                <HeroStat
                  value={formatCurrency(metrics.totalVolume)}
                  label="Trading Volume"
                  sublabel="All-time volume on Drift Protocol"
                  gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                  delay={0.1}
                  testId="total-volume"
                />
              </div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16"
              >
                <div className="p-5 rounded-2xl bg-card/40 border border-border/20 text-center" data-testid="card-volume-24h">
                  <p className="text-2xl md:text-3xl font-display font-bold" data-testid="value-volume-24h">{formatCurrency(metrics.volume24h)}</p>
                  <p className="text-xs text-muted-foreground mt-1">24h Volume</p>
                </div>
                <div className="p-5 rounded-2xl bg-card/40 border border-border/20 text-center" data-testid="card-volume-7d">
                  <p className="text-2xl md:text-3xl font-display font-bold" data-testid="value-volume-7d">{formatCurrency(metrics.volume7d)}</p>
                  <p className="text-xs text-muted-foreground mt-1">7d Volume</p>
                </div>
                <div className="p-5 rounded-2xl bg-card/40 border border-border/20 text-center" data-testid="card-active-bots">
                  <p className="text-2xl md:text-3xl font-display font-bold" data-testid="value-active-bots">{metrics.activeBots}</p>
                  <p className="text-xs text-muted-foreground mt-1">Active Bots</p>
                </div>
                <div className="p-5 rounded-2xl bg-card/40 border border-border/20 text-center" data-testid="card-total-trades">
                  <p className="text-2xl md:text-3xl font-display font-bold" data-testid="value-total-trades">{formatNumber(metrics.totalTrades)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Total Trades</p>
                </div>
              </motion.div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
                <StatBlock
                  value={metrics.activeBots}
                  label="Active Trading Bots"
                  icon={<Zap className="w-7 h-7" />}
                  gradient="bg-gradient-to-br from-emerald-500 to-green-600"
                  delay={0.3}
                  testId="stat-bots"
                />
                <StatBlock
                  value={metrics.activeUsers}
                  label="Active Traders"
                  icon={<Users className="w-7 h-7" />}
                  gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                  delay={0.4}
                  testId="stat-users"
                />
                <StatBlock
                  value={metrics.totalTrades}
                  label="Executed Trades"
                  icon={<BarChart2 className="w-7 h-7" />}
                  gradient="bg-gradient-to-br from-purple-500 to-pink-600"
                  delay={0.5}
                  testId="stat-trades"
                />
              </div>

              {history && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-16">
                  {history.tvl.length > 1 && (
                    <AreaChart
                      data={history.tvl}
                      label="TVL Over Time"
                      color="hsl(142, 76%, 36%)"
                      testId="chart-tvl-history"
                    />
                  )}
                  {history.volume.length > 1 && (
                    <AreaChart
                      data={history.volume}
                      label="Cumulative Volume"
                      color="hsl(217, 91%, 60%)"
                      testId="chart-volume-history"
                    />
                  )}
                </div>
              )}

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
                className="relative overflow-hidden rounded-3xl"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-primary via-purple-500 to-pink-500 opacity-90" />
                <div className="absolute inset-0 bg-[url('/images/grid.svg')] opacity-10" />
                <div className="relative p-10 md:p-14 flex flex-col md:flex-row items-center justify-between gap-8">
                  <div>
                    <h3 className="font-display font-bold text-3xl md:text-4xl text-white mb-3">
                      Start Trading Today
                    </h3>
                    <p className="text-white/80 text-lg max-w-md">
                      Deploy automated trading bots on Solana with just a few clicks.
                    </p>
                  </div>
                  <a href="/app">
                    <Button size="lg" variant="secondary" className="gap-2 text-lg px-8 py-6" data-testid="button-get-started">
                      Launch App
                      <ArrowUpRight className="w-5 h-5" />
                    </Button>
                  </a>
                </div>
              </motion.div>
            </>
          ) : null}
        </div>
      </main>

      <footer className="relative border-t border-white/5 bg-card/20">
        <div className="max-w-7xl mx-auto px-6 py-10">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
              <span className="font-display font-bold">QuantumVault</span>
            </div>
            <div className="flex items-center gap-8 text-sm">
              <Link href="/docs" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-footer-docs">Docs</Link>
              <a href="#" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-twitter">Twitter</a>
              <a href="#" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-discord">Discord</a>
            </div>
            <p className="text-sm text-muted-foreground">
              Built on Solana
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
