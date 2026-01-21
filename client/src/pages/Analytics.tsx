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

function GlowCard({ children, className = "", glowColor = "violet", testId }: { 
  children: React.ReactNode; 
  className?: string;
  glowColor?: "violet" | "blue" | "mixed";
  testId?: string;
}) {
  const glowClasses = {
    violet: "before:bg-violet-500/20 hover:before:bg-violet-500/30",
    blue: "before:bg-blue-500/20 hover:before:bg-blue-500/30",
    mixed: "before:bg-gradient-to-r before:from-violet-500/20 before:to-blue-500/20 hover:before:from-violet-500/30 hover:before:to-blue-500/30"
  };

  return (
    <motion.div
      className={`relative group ${className}`}
      whileHover={{ scale: 1.02, transition: { duration: 0.2 } }}
      data-testid={testId}
    >
      <div className={`absolute -inset-0.5 rounded-xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 ${glowClasses[glowColor].replace('before:', '')}`} />
      <div className="relative">
        {children}
      </div>
    </motion.div>
  );
}

function AnimatedBorder({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative p-[1px] rounded-xl overflow-hidden ${className}`}>
      <div className="absolute inset-0 bg-gradient-to-r from-violet-500/50 via-blue-500/50 to-violet-500/50 animate-gradient-x" />
      <div className="relative bg-card/90 backdrop-blur-sm rounded-xl">
        {children}
      </div>
    </div>
  );
}

function createSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  
  let path = `M ${points[0].x} ${points[0].y}`;
  
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    
    const midX = (p0.x + p1.x) / 2;
    const midY = (p0.y + p1.y) / 2;
    
    if (i === 0) {
      path += ` Q ${p0.x} ${p0.y}, ${midX} ${midY}`;
    } else {
      path += ` Q ${p0.x} ${p0.y}, ${midX} ${midY}`;
    }
  }
  
  const last = points[points.length - 1];
  const secondLast = points[points.length - 2];
  path += ` Q ${secondLast.x} ${secondLast.y}, ${last.x} ${last.y}`;
  
  return path;
}

function AreaChart({ data, label, testId }: {
  data: HistoricalDataPoint[];
  label: string;
  testId: string;
}) {
  if (!data || data.length < 2) return null;

  const sortedData = [...data].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const values = sortedData.map(d => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  
  const width = 400;
  const height = 140;
  const padding = { top: 16, right: 16, bottom: 32, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const points = sortedData.map((d, i) => {
    const x = padding.left + (i / (sortedData.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - ((d.value - min) / range) * chartHeight;
    return { x, y, value: d.value, date: d.timestamp };
  });

  const straightLinePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const linePath = createSmoothPath(points);
  const areaPath = `${straightLinePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${padding.left} ${padding.top + chartHeight} Z`;

  const yAxisTicks = [min, min + range * 0.5, max];
  
  return (
    <div data-testid={testId}>
      <p className="text-sm text-muted-foreground mb-3">{label}</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <defs>
          <linearGradient id={`grad-${testId}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(139, 92, 246)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="rgb(139, 92, 246)" stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${testId}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
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
          strokeWidth="2.5"
          strokeLinecap="round"
          filter={`url(#glow-${testId})`}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.2, duration: 0.8, ease: "easeOut" }}
        />

        {points.length > 0 && (
          <motion.circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r="4"
            fill="rgb(139, 92, 246)"
            className="drop-shadow-[0_0_6px_rgba(139,92,246,0.8)]"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 1, duration: 0.3 }}
          />
        )}

        <text x={padding.left} y={height - 8} fill="currentColor" fontSize="9" opacity="0.5">
          {formatShortDate(sortedData[0].timestamp)}
        </text>
        <text x={width - padding.right} y={height - 8} fill="currentColor" fontSize="9" textAnchor="end" opacity="0.5">
          {formatShortDate(sortedData[sortedData.length - 1].timestamp)}
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
    <div className="min-h-screen bg-background overflow-hidden">
      <style>{`
        @keyframes gradient-x {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        .animate-gradient-x {
          background-size: 200% 200%;
          animation: gradient-x 3s ease infinite;
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-20px); }
        }
        .animate-float {
          animation: float 6s ease-in-out infinite;
        }
        .animate-float-delayed {
          animation: float 8s ease-in-out infinite;
          animation-delay: -2s;
        }
      `}</style>

      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-violet-500/15 rounded-full blur-3xl animate-float" />
        <div className="absolute top-1/3 -left-40 w-80 h-80 bg-blue-500/15 rounded-full blur-3xl animate-float-delayed" />
        <div className="absolute bottom-20 right-1/4 w-64 h-64 bg-violet-500/10 rounded-full blur-3xl animate-float" />
      </div>

      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/60 backdrop-blur-xl border-b border-white/5">
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
              <Button size="sm" className="bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 shadow-lg shadow-violet-500/25" data-testid="button-launch-app">
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
            <h1 className="text-4xl md:text-5xl font-display font-bold mb-3 bg-gradient-to-r from-white via-white to-white/60 bg-clip-text text-transparent">
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
                <GlowCard glowColor="violet" testId="card-tvl">
                  <div className="p-6 rounded-xl bg-gradient-to-br from-violet-500/15 to-violet-500/5 border border-violet-500/20 backdrop-blur-sm">
                    <p className="text-xs text-violet-300/80 uppercase tracking-wider mb-1">TVL</p>
                    <p className="text-3xl font-display font-bold text-white drop-shadow-[0_0_10px_rgba(139,92,246,0.3)]" data-testid="value-tvl">
                      {formatCurrency(metrics.tvl)}
                    </p>
                  </div>
                </GlowCard>
                
                <GlowCard glowColor="blue" testId="card-total-volume">
                  <div className="p-6 rounded-xl bg-gradient-to-br from-blue-500/15 to-blue-500/5 border border-blue-500/20 backdrop-blur-sm">
                    <p className="text-xs text-blue-300/80 uppercase tracking-wider mb-1">Total Volume</p>
                    <p className="text-3xl font-display font-bold text-white drop-shadow-[0_0_10px_rgba(59,130,246,0.3)]" data-testid="value-total-volume">
                      {formatCurrency(metrics.totalVolume)}
                    </p>
                  </div>
                </GlowCard>
                
                <GlowCard testId="card-volume-24h">
                  <div className="p-6 rounded-xl bg-card/40 border border-white/5 backdrop-blur-sm">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">24h Volume</p>
                    <p className="text-3xl font-display font-bold" data-testid="value-volume-24h">{formatCurrency(metrics.volume24h)}</p>
                  </div>
                </GlowCard>
                
                <GlowCard testId="card-volume-7d">
                  <div className="p-6 rounded-xl bg-card/40 border border-white/5 backdrop-blur-sm">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">7d Volume</p>
                    <p className="text-3xl font-display font-bold" data-testid="value-volume-7d">{formatCurrency(metrics.volume7d)}</p>
                  </div>
                </GlowCard>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <AnimatedBorder>
                  <div className="grid grid-cols-3 divide-x divide-white/5">
                    <div className="p-8 text-center" data-testid="card-active-bots">
                      <motion.p 
                        className="text-5xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent drop-shadow-[0_0_20px_rgba(139,92,246,0.4)]"
                        data-testid="value-active-bots"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.2, type: "spring" }}
                      >
                        {metrics.activeBots}
                      </motion.p>
                      <p className="text-sm text-muted-foreground mt-2">Active Bots</p>
                    </div>
                    <div className="p-8 text-center" data-testid="card-active-users">
                      <motion.p 
                        className="text-5xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent drop-shadow-[0_0_20px_rgba(139,92,246,0.4)]"
                        data-testid="value-active-users"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.3, type: "spring" }}
                      >
                        {metrics.activeUsers}
                      </motion.p>
                      <p className="text-sm text-muted-foreground mt-2">Traders</p>
                    </div>
                    <div className="p-8 text-center" data-testid="card-total-trades">
                      <motion.p 
                        className="text-5xl font-display font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent drop-shadow-[0_0_20px_rgba(139,92,246,0.4)]"
                        data-testid="value-total-trades"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.4, type: "spring" }}
                      >
                        {formatNumber(metrics.totalTrades)}
                      </motion.p>
                      <p className="text-sm text-muted-foreground mt-2">Trades</p>
                    </div>
                  </div>
                </AnimatedBorder>
              </motion.div>

              {history && (history.tvl.length > 1 || history.volume.length > 1) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="grid grid-cols-1 lg:grid-cols-2 gap-6"
                >
                  {history.tvl.length > 1 && (
                    <GlowCard glowColor="violet">
                      <div className="p-6 rounded-xl bg-card/40 border border-white/5 backdrop-blur-sm">
                        <AreaChart data={history.tvl} label="TVL Over Time" testId="chart-tvl-history" />
                      </div>
                    </GlowCard>
                  )}
                  {history.volume.length > 1 && (
                    <GlowCard glowColor="blue">
                      <div className="p-6 rounded-xl bg-card/40 border border-white/5 backdrop-blur-sm">
                        <AreaChart data={history.volume} label="Cumulative Volume" testId="chart-volume-history" />
                      </div>
                    </GlowCard>
                  )}
                </motion.div>
              )}

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="relative group"
              >
                <div className="absolute -inset-1 bg-gradient-to-r from-violet-600 via-blue-600 to-violet-600 rounded-2xl blur-lg opacity-40 group-hover:opacity-60 transition-opacity animate-gradient-x" />
                <div className="relative p-8 rounded-xl bg-background/80 backdrop-blur-xl border border-white/10">
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div>
                      <h3 className="font-display font-bold text-xl mb-1">Ready to trade?</h3>
                      <p className="text-sm text-muted-foreground">Deploy automated bots on Solana</p>
                    </div>
                    <a href="/app">
                      <Button className="gap-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 shadow-lg shadow-violet-500/30" data-testid="button-get-started">
                        Get Started
                        <ArrowUpRight className="w-4 h-4" />
                      </Button>
                    </a>
                  </div>
                </div>
              </motion.div>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="border-t border-white/5 bg-card/10 backdrop-blur-sm">
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
