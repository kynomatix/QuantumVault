import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { 
  TrendingUp, 
  Users, 
  Bot, 
  ArrowUpRight,
  Activity,
  DollarSign,
  BarChart3,
  Clock
} from 'lucide-react';
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

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 }
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.1 }
  }
};

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  trend?: 'up' | 'down' | 'neutral';
  delay?: number;
  testId: string;
}

function StatCard({ icon, label, value, subValue, delay = 0, testId }: StatCardProps) {
  return (
    <motion.div
      variants={fadeInUp}
      transition={{ delay }}
      className="relative p-6 rounded-2xl bg-card border border-border/50 overflow-hidden group hover:border-primary/30 transition-colors"
      data-testid={`card-${testId}`}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="relative">
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            {icon}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-1">{label}</p>
        <p className="text-3xl font-display font-bold text-foreground" data-testid={`value-${testId}`}>{value}</p>
        {subValue && (
          <p className="text-sm text-muted-foreground mt-1">{subValue}</p>
        )}
      </div>
    </motion.div>
  );
}

function MiniChart({ data, color = 'primary' }: { data: number[]; color?: string }) {
  if (!data.length) return null;
  
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  
  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = 100 - ((value - min) / range) * 80;
    return `${x},${y}`;
  }).join(' ');
  
  return (
    <svg className="w-full h-16" viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`gradient-${color}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.3" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        points={points}
      />
      <polygon
        fill={`url(#gradient-${color})`}
        points={`0,100 ${points} 100,100`}
      />
    </svg>
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
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/">
            <a className="flex items-center gap-3" data-testid="link-home">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-10 h-10 rounded-xl" />
              <span className="font-display font-bold text-xl">QuantumVault</span>
            </a>
          </Link>
          
          <div className="hidden md:flex items-center gap-8">
            <Link href="/">
              <a className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-home-nav">Home</a>
            </Link>
            <span className="text-sm text-foreground font-medium" data-testid="link-analytics-active">Analytics</span>
            <Link href="/docs">
              <a className="text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-docs">Docs</a>
            </Link>
          </div>

          <Link href="/app">
            <Button size="sm" className="gap-2" data-testid="button-launch-app">
              Launch App
              <ArrowUpRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </nav>

      <main className="pt-24 pb-16 px-6">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-12"
          >
            <h1 className="text-4xl md:text-5xl font-display font-bold mb-4">
              Platform Analytics
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl">
              Real-time statistics and metrics for the QuantumVault trading platform on Solana.
            </p>
            {metrics?.lastUpdated && (
              <p className="text-sm text-muted-foreground mt-2 flex items-center gap-2" data-testid="text-last-updated">
                <Clock className="w-4 h-4" />
                Last updated: {formatDate(metrics.lastUpdated)}
              </p>
            )}
          </motion.div>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-40 rounded-2xl bg-card/50 animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-destructive">Failed to load metrics. Please try again later.</p>
            </div>
          ) : metrics ? (
            <>
              <motion.div
                variants={staggerContainer}
                initial="hidden"
                animate="visible"
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12"
              >
                <StatCard
                  icon={<DollarSign className="w-5 h-5" />}
                  label="Total Value Locked"
                  value={formatCurrency(metrics.tvl)}
                  subValue="Active bot investments"
                  testId="tvl"
                />
                <StatCard
                  icon={<TrendingUp className="w-5 h-5" />}
                  label="Total Volume"
                  value={formatCurrency(metrics.totalVolume)}
                  subValue="All-time trading volume"
                  delay={0.1}
                  testId="total-volume"
                />
                <StatCard
                  icon={<Activity className="w-5 h-5" />}
                  label="24h Volume"
                  value={formatCurrency(metrics.volume24h)}
                  subValue="Last 24 hours"
                  delay={0.2}
                  testId="volume-24h"
                />
                <StatCard
                  icon={<BarChart3 className="w-5 h-5" />}
                  label="7d Volume"
                  value={formatCurrency(metrics.volume7d)}
                  subValue="Last 7 days"
                  delay={0.3}
                  testId="volume-7d"
                />
              </motion.div>

              <motion.div
                variants={staggerContainer}
                initial="hidden"
                animate="visible"
                className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12"
              >
                <StatCard
                  icon={<Bot className="w-5 h-5" />}
                  label="Active Trading Bots"
                  value={formatNumber(metrics.activeBots)}
                  subValue="Currently running"
                  delay={0.4}
                  testId="active-bots"
                />
                <StatCard
                  icon={<Users className="w-5 h-5" />}
                  label="Active Users"
                  value={formatNumber(metrics.activeUsers)}
                  subValue="With active bots"
                  delay={0.5}
                  testId="active-users"
                />
                <StatCard
                  icon={<Activity className="w-5 h-5" />}
                  label="Total Trades"
                  value={formatNumber(metrics.totalTrades)}
                  subValue="Executed trades"
                  delay={0.6}
                  testId="total-trades"
                />
              </motion.div>

              {history && (history.tvl.length > 1 || history.volume.length > 1) && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 }}
                  className="grid grid-cols-1 lg:grid-cols-2 gap-6"
                >
                  {history.tvl.length > 1 && (
                    <div className="p-6 rounded-2xl bg-card border border-border/50" data-testid="chart-tvl-history">
                      <h3 className="font-display font-semibold text-lg mb-4">TVL History</h3>
                      <MiniChart data={history.tvl.map(d => d.value)} />
                      <div className="flex justify-between text-xs text-muted-foreground mt-2">
                        <span>{formatDate(history.tvl[0].timestamp)}</span>
                        <span>{formatDate(history.tvl[history.tvl.length - 1].timestamp)}</span>
                      </div>
                    </div>
                  )}
                  {history.volume.length > 1 && (
                    <div className="p-6 rounded-2xl bg-card border border-border/50" data-testid="chart-volume-history">
                      <h3 className="font-display font-semibold text-lg mb-4">Volume History</h3>
                      <MiniChart data={history.volume.map(d => d.value)} />
                      <div className="flex justify-between text-xs text-muted-foreground mt-2">
                        <span>{formatDate(history.volume[0].timestamp)}</span>
                        <span>{formatDate(history.volume[history.volume.length - 1].timestamp)}</span>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
                className="mt-12 p-8 rounded-2xl bg-gradient-to-br from-primary/10 via-accent/5 to-transparent border border-primary/20"
              >
                <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                  <div>
                    <h3 className="font-display font-bold text-2xl mb-2">Ready to start trading?</h3>
                    <p className="text-muted-foreground">Deploy your first automated trading bot on Solana in minutes.</p>
                  </div>
                  <Link href="/app">
                    <Button size="lg" className="gap-2" data-testid="button-get-started">
                      Get Started
                      <ArrowUpRight className="w-5 h-5" />
                    </Button>
                  </Link>
                </div>
              </motion.div>
            </>
          ) : null}
        </div>
      </main>

      <footer className="border-t border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-8 h-8 rounded-lg" />
              <span className="font-display font-bold">QuantumVault</span>
            </div>
            <div className="flex items-center gap-8 text-sm">
              <Link href="/docs">
                <a className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-footer-docs">Docs</a>
              </Link>
              <a href="#" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-twitter">Twitter</a>
              <a href="#" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-discord">Discord</a>
            </div>
            <p className="text-sm text-muted-foreground">
              © 2026 QuantumVault. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
