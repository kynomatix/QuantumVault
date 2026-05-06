import { useEffect, useMemo, useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  Loader2,
  Bot,
  TrendingUp,
  Users,
  DollarSign,
  Percent,
  ExternalLink,
  LineChart as LineChartIcon,
  Wallet,
  AlertTriangle,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/hooks/useWallet';
import { useBotPerformance, type PublishedBot } from '@/hooks/useApi';
import { SubscribeBotModal } from '@/components/SubscribeBotModal';
import { safeResponseJson } from '@/lib/safe-fetch';

const PENDING_INTENT_KEY = 'pendingMarketplaceIntent';

interface PendingMarketplaceIntent {
  publishedBotId: string;
  referralCode?: string | null;
  createdAt: number;
}

function writePendingIntent(intent: PendingMarketplaceIntent) {
  try {
    sessionStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // ignore quota / privacy mode errors
  }
}

export default function MarketplaceBotPage() {
  const [, params] = useRoute<{ id: string }>('/marketplace/:id');
  const [, navigate] = useLocation();
  const botId = params?.id ?? null;

  const { sessionConnected } = useWallet();
  const { setVisible } = useWalletModal();

  const [bot, setBot] = useState<PublishedBot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscribeModalOpen, setSubscribeModalOpen] = useState(false);

  const refFromUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('ref');
  }, []);

  // Persist the marketplace intent so referral attribution survives onboarding
  useEffect(() => {
    if (!botId) return;
    writePendingIntent({
      publishedBotId: botId,
      referralCode: refFromUrl,
      createdAt: Date.now(),
    });
  }, [botId, refFromUrl]);

  // Fetch the published bot
  useEffect(() => {
    if (!botId) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    (async () => {
      try {
        const res = await fetch(`/api/marketplace/${botId}`, { credentials: 'include' });
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          throw new Error('Failed to load bot');
        }
        const data = (await safeResponseJson(res)) as PublishedBot;
        if (!data || !data.id) {
          setNotFound(true);
          return;
        }
        // If creator's referralCode wasn't on the URL, fall back to whatever is
        // already in sessionStorage (no-op when nothing useful is available).
        setBot(data);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load bot');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const { data: performanceData, isLoading: performanceLoading } = useBotPerformance(botId);

  const winRate = bot && bot.totalTrades > 0
    ? ((bot.winningTrades / bot.totalTrades) * 100).toFixed(1)
    : '0';
  const totalCapital = bot ? parseFloat(bot.totalCapitalInvested || '0') : 0;
  const profitShare = bot ? parseFloat(bot.profitSharePercent || '0') : 0;

  const formatPnl = (value: string | null | undefined) => {
    if (!value) return '--';
    const num = parseFloat(value);
    return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
  };
  const getPnlClass = (value: string | null | undefined) => {
    if (!value) return 'text-muted-foreground';
    const num = parseFloat(value);
    return num >= 0 ? 'text-emerald-400' : 'text-red-400';
  };

  const chartData = (performanceData?.equityHistory ?? []).map((point) => ({
    date: new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    performance: point.pnl,
  }));
  const latestPerformance = chartData.length > 0 ? chartData[chartData.length - 1].performance : 0;
  const performanceColor = latestPerformance >= 0 ? 'hsl(142.1 76.2% 36.3%)' : 'hsl(0 72.2% 50.6%)';

  const handleSubscribeClick = () => {
    if (!sessionConnected) {
      // Intent already in sessionStorage — open Solana wallet modal.
      setVisible(true);
      return;
    }
    setSubscribeModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10" data-testid="page-marketplace-bot">
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/')}
            className="text-muted-foreground hover:text-foreground"
            data-testid="button-back-home"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to QuantumVault
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-24" data-testid="state-loading">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {!loading && notFound && (
          <div
            className="rounded-2xl border border-border/60 bg-card p-10 text-center"
            data-testid="state-not-found"
          >
            <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-4" />
            <h1 className="text-2xl font-display font-semibold mb-2">This bot is no longer available</h1>
            <p className="text-muted-foreground mb-6">
              The strategy you're looking for has been unpublished or never existed.
            </p>
            <Button
              onClick={() => navigate('/app')}
              className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
              data-testid="button-browse-marketplace"
            >
              Browse Marketplace
            </Button>
          </div>
        )}

        {!loading && error && !notFound && (
          <div
            className="rounded-2xl border border-red-500/30 bg-red-500/5 p-8 text-center"
            data-testid="state-error"
          >
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-red-400 font-medium">{error}</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => window.location.reload()}
              data-testid="button-retry"
            >
              Try again
            </Button>
          </div>
        )}

        {!loading && bot && (
          <div className="space-y-5" data-testid={`marketplace-bot-${bot.id}`}>
            <div className="rounded-2xl border border-border/60 bg-card p-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                  <Bot className="w-7 h-7 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="font-display font-semibold text-2xl truncate" data-testid="text-bot-name">
                    {bot.name}
                  </h1>
                  <p className="text-sm text-muted-foreground">{bot.market}</p>
                </div>
                {!bot.isActive && (
                  <span className="px-2 py-1 rounded text-xs bg-muted-foreground/20 text-muted-foreground">
                    Inactive
                  </span>
                )}
              </div>

              {bot.creator?.displayName && (
                <div className="mt-4 flex items-center justify-between text-sm p-3 rounded-lg bg-muted/30 border border-border/50">
                  <span className="text-muted-foreground">Created by</span>
                  <span className="font-medium">
                    {bot.creator.displayName}
                    {bot.creator.xUsername && (
                      <a
                        href={`https://x.com/${bot.creator.xUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline ml-1 inline-flex items-center gap-0.5"
                      >
                        @{bot.creator.xUsername}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </span>
                </div>
              )}

              {bot.description && (
                <p className="mt-4 text-sm text-muted-foreground" data-testid="text-bot-description">
                  {bot.description}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <div className="flex items-center justify-center gap-1 text-lg font-bold">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  {winRate}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">Win Rate</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <div className="flex items-center justify-center gap-1 text-lg font-bold">
                  <Users className="w-4 h-4 text-primary" />
                  {bot.subscriberCount}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Subscribers</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <div className="flex items-center justify-center gap-1 text-lg font-bold">
                  <DollarSign className="w-4 h-4 text-primary" />
                  {totalCapital >= 1000 ? `${(totalCapital / 1000).toFixed(1)}K` : totalCapital.toFixed(0)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">TVL</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <div className="flex items-center justify-center gap-1 text-lg font-bold">
                  <Percent className="w-4 h-4 text-primary" />
                  {profitShare.toFixed(0)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">Profit Share</p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-muted/30 border border-border/50">
              <h2 className="font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                PnL Performance
              </h2>
              <div className="grid grid-cols-4 gap-3">
                <div className="text-center">
                  <p className={`text-lg font-bold ${getPnlClass(bot.pnlPercent7d)}`}>
                    {formatPnl(bot.pnlPercent7d)}
                  </p>
                  <p className="text-xs text-muted-foreground">7 Days</p>
                </div>
                <div className="text-center">
                  <p className={`text-lg font-bold ${getPnlClass(bot.pnlPercent30d)}`}>
                    {formatPnl(bot.pnlPercent30d)}
                  </p>
                  <p className="text-xs text-muted-foreground">30 Days</p>
                </div>
                <div className="text-center">
                  <p className={`text-lg font-bold ${getPnlClass(bot.pnlPercent90d)}`}>
                    {formatPnl(bot.pnlPercent90d)}
                  </p>
                  <p className="text-xs text-muted-foreground">90 Days</p>
                </div>
                <div className="text-center">
                  <p className={`text-lg font-bold ${getPnlClass(bot.pnlPercentAllTime)}`}>
                    {formatPnl(bot.pnlPercentAllTime)}
                  </p>
                  <p className="text-xs text-muted-foreground">All-Time</p>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-muted/30 border border-border/50">
              <h2 className="font-semibold mb-3 flex items-center gap-2">
                <LineChartIcon className="w-4 h-4 text-primary" />
                Performance Chart
              </h2>
              {performanceLoading ? (
                <div className="flex items-center justify-center h-56">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : chartData.length > 0 ? (
                <div className="h-56" data-testid="chart-performance">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                      <defs>
                        <linearGradient id="performanceGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={performanceColor} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={performanceColor} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickLine={false}
                        tickFormatter={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`}
                        domain={['auto', 'auto']}
                      />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" opacity={0.5} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                        formatter={(value: number) => [`${value >= 0 ? '+' : ''}${value.toFixed(2)}%`, 'Return']}
                      />
                      <Area
                        type="monotone"
                        dataKey="performance"
                        stroke={performanceColor}
                        strokeWidth={2}
                        fill="url(#performanceGradient)"
                        dot={false}
                        activeDot={{ r: 4, fill: performanceColor }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-56 text-muted-foreground">
                  <LineChartIcon className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">No performance history yet</p>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-border/60 bg-card p-5">
              {sessionConnected ? (
                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90"
                  size="lg"
                  onClick={handleSubscribeClick}
                  disabled={!bot.isActive}
                  data-testid="button-subscribe"
                >
                  {bot.isActive ? 'Subscribe to this bot' : 'Bot is inactive'}
                </Button>
              ) : (
                <div className="space-y-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    Connect your wallet to subscribe and start copy-trading this strategy.
                  </p>
                  <Button
                    className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90"
                    size="lg"
                    onClick={handleSubscribeClick}
                    data-testid="button-connect-wallet-to-subscribe"
                  >
                    <Wallet className="w-4 h-4 mr-2" />
                    Connect Wallet to Subscribe
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {bot && subscribeModalOpen && (
        <SubscribeBotModal
          isOpen={subscribeModalOpen}
          onClose={() => setSubscribeModalOpen(false)}
          bot={bot}
          onSubscribed={() => {
            setSubscribeModalOpen(false);
            try {
              sessionStorage.removeItem(PENDING_INTENT_KEY);
            } catch {
              // ignore
            }
            navigate('/app');
          }}
        />
      )}
    </div>
  );
}
