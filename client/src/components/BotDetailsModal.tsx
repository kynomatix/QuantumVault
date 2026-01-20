import { useState } from 'react';
import { useBotPerformance, type PublishedBot } from '@/hooks/useApi';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { 
  Loader2, 
  Bot,
  TrendingUp,
  Users,
  DollarSign,
  Percent,
  ExternalLink,
  LineChart as LineChartIcon
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { SubscribeBotModal } from './SubscribeBotModal';

interface BotDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  bot: PublishedBot;
  isSubscribed?: boolean;
  onSubscribed?: () => void;
}

export function BotDetailsModal({ isOpen, onClose, bot, isSubscribed, onSubscribed }: BotDetailsModalProps) {
  const [subscribeModalOpen, setSubscribeModalOpen] = useState(false);
  
  const { data: performanceData, isLoading: performanceLoading } = useBotPerformance(isOpen ? bot.id : null);

  const winRate = bot.totalTrades > 0 
    ? ((bot.winningTrades / bot.totalTrades) * 100).toFixed(1) 
    : '0';

  const totalCapital = parseFloat(bot.totalCapitalInvested || '0');
  const profitShare = parseFloat(bot.profitSharePercent || '0');

  const formatPnl = (value: string | null) => {
    if (!value) return '--';
    const num = parseFloat(value);
    return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
  };

  const getPnlClass = (value: string | null) => {
    if (!value) return 'text-muted-foreground';
    const num = parseFloat(value);
    return num >= 0 ? 'text-emerald-400' : 'text-red-400';
  };

  const chartData = performanceData?.equityHistory?.map((point) => ({
    date: new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    equity: point.equity,
  })) || [];

  const handleSubscribe = () => {
    setSubscribeModalOpen(true);
  };

  const handleSubscribed = () => {
    setSubscribeModalOpen(false);
    onSubscribed?.();
    onClose();
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[600px] bg-card border-border max-h-[90vh] overflow-y-auto" data-testid="modal-bot-details">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              <Bot className="w-5 h-5 text-primary" />
              Bot Details
            </DialogTitle>
            <DialogDescription>
              Review strategy performance before subscribing.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-7 h-7 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-display font-semibold text-lg">{bot.name}</h3>
                <p className="text-sm text-muted-foreground">{bot.market}</p>
              </div>
            </div>

            {bot.creator.displayName && (
              <div className="flex items-center justify-between text-sm p-3 rounded-lg bg-muted/30 border border-border/50">
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
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                <p className="text-sm text-muted-foreground">{bot.description}</p>
              </div>
            )}

            <div className="grid grid-cols-4 gap-3">
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
                  {totalCapital >= 1000 ? `${(totalCapital/1000).toFixed(1)}K` : totalCapital.toFixed(0)}
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
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                PnL Performance
              </h4>
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
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <LineChartIcon className="w-4 h-4 text-primary" />
                Equity History
              </h4>
              {performanceLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <span className="ml-2 text-muted-foreground">Loading performance data...</span>
                </div>
              ) : chartData.length > 0 ? (
                <div className="h-48" data-testid="chart-equity-history">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
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
                        tickFormatter={(value) => `$${value >= 1000 ? `${(value/1000).toFixed(1)}K` : value}`}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, 'Equity']}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="equity" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: 'hsl(var(--primary))' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <LineChartIcon className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">No performance history yet</p>
                  <p className="text-xs">Chart will update as trades are made</p>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button 
                variant="outline" 
                onClick={onClose}
                className="flex-1"
              >
                Close
              </Button>
              {!isSubscribed && (
                <Button 
                  className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90"
                  onClick={handleSubscribe}
                  data-testid="button-view-subscribe"
                >
                  Subscribe
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {subscribeModalOpen && (
        <SubscribeBotModal
          isOpen={subscribeModalOpen}
          onClose={() => setSubscribeModalOpen(false)}
          bot={bot}
          onSubscribed={handleSubscribed}
        />
      )}
    </>
  );
}
