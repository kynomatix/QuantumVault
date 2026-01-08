import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'wouter';
import { useAuth } from '@/hooks/useAuth';
import { useBots, useSubscriptions, usePortfolio, usePositions, useTrades, useLeaderboard, useSubscribeToBot, useUpdateSubscription } from '@/hooks/useApi';
import { useToast } from '@/hooks/use-toast';
import { 
  Wallet, 
  TrendingUp, 
  TrendingDown,
  Bot, 
  LayoutDashboard,
  ArrowUpRight,
  ArrowDownRight,
  Activity,
  Settings,
  Bell,
  Search,
  Plus,
  Minus,
  RefreshCw,
  Copy,
  BarChart3,
  Users,
  Sparkles,
  LogOut,
  Menu,
  Store,
  Star,
  Zap,
  Shield,
  ChevronRight,
  ChevronLeft,
  PanelLeftClose,
  PanelLeft
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const markets = [
  { symbol: 'SOL-PERP', price: 98.45, change: 5.23, volume: '124.5M' },
  { symbol: 'BTC-PERP', price: 43250.00, change: 2.14, volume: '892.3M' },
  { symbol: 'ETH-PERP', price: 2340.50, change: -1.82, volume: '456.7M' },
  { symbol: 'JUP-PERP', price: 0.8234, change: 12.45, volume: '45.2M' },
  { symbol: 'BONK-PERP', price: 0.00001234, change: -3.21, volume: '23.1M' },
];

const positions = [
  { market: 'SOL-PERP', side: 'LONG', size: 50, entry: 94.20, current: 98.45, pnl: 212.50, pnlPercent: 4.51 },
  { market: 'ETH-PERP', side: 'SHORT', size: 2, entry: 2380.00, current: 2340.50, pnl: 79.00, pnlPercent: 1.66 },
  { market: 'BTC-PERP', side: 'LONG', size: 0.5, entry: 42800.00, current: 43250.00, pnl: 225.00, pnlPercent: 1.05 },
];

const activeBots = [
  { id: 1, name: 'SOL Momentum Pro', market: 'SOL-PERP', status: 'running', trades: 47, pnl: 1245.80, pnlPercent: 12.4 },
  { id: 2, name: 'ETH Grid Master', market: 'ETH-PERP', status: 'running', trades: 124, pnl: 892.30, pnlPercent: 8.9 },
  { id: 3, name: 'Multi Trend Alpha', market: 'Multi', status: 'paused', trades: 23, pnl: -124.50, pnlPercent: -2.1 },
];

const marketplaceBots = [
  { id: 'sol-momentum', name: 'SOL Momentum Pro', type: 'Signal Bot', market: 'SOL-PERP', apr: 42.8, subscribers: 1247, creator: 'quantum_whale', rating: 4.8, minDeposit: 500, featured: true },
  { id: 'btc-grid', name: 'BTC Range Master', type: 'Grid Bot', market: 'BTC-PERP', apr: 28.4, subscribers: 892, creator: 'grid_wizard', rating: 4.6, minDeposit: 1000, featured: true },
  { id: 'eth-scalper', name: 'ETH Scalper Elite', type: 'Signal Bot', market: 'ETH-PERP', apr: 35.2, subscribers: 634, creator: 'alpha_hunter', rating: 4.5, minDeposit: 750, featured: false },
  { id: 'multi-perp', name: 'Multi-Asset Trend', type: 'Signal Bot', market: 'Multi', apr: 52.1, subscribers: 2103, creator: 'drift_master', rating: 4.9, minDeposit: 2000, featured: true },
  { id: 'sol-grid', name: 'SOL Grid Runner', type: 'Grid Bot', market: 'SOL-PERP', apr: 31.7, subscribers: 445, creator: 'perp_lord', rating: 4.3, minDeposit: 300, featured: false },
  { id: 'jup-signal', name: 'JUP Signal Alpha', type: 'Signal Bot', market: 'JUP-PERP', apr: 67.3, subscribers: 328, creator: 'moon_trader', rating: 4.7, minDeposit: 250, featured: true },
  { id: 'bonk-degen', name: 'BONK Degen Play', type: 'Signal Bot', market: 'BONK-PERP', apr: 89.2, subscribers: 156, creator: 'degen_king', rating: 4.1, minDeposit: 100, featured: false },
  { id: 'eth-grid-pro', name: 'ETH Grid Pro', type: 'Grid Bot', market: 'ETH-PERP', apr: 24.5, subscribers: 567, creator: 'grid_wizard', rating: 4.4, minDeposit: 800, featured: false },
];

const recentTrades = [
  { time: '14:32:05', market: 'SOL-PERP', side: 'BUY', size: 10, price: 98.42, total: 984.20 },
  { time: '14:28:12', market: 'ETH-PERP', side: 'SELL', size: 0.5, price: 2342.10, total: 1171.05 },
  { time: '14:15:44', market: 'SOL-PERP', side: 'BUY', size: 15, price: 97.85, total: 1467.75 },
  { time: '13:58:21', market: 'BTC-PERP', side: 'BUY', size: 0.1, price: 43180.00, total: 4318.00 },
  { time: '13:42:08', market: 'JUP-PERP', side: 'SELL', size: 1000, price: 0.8180, total: 818.00 },
];

const orderbook = {
  asks: [
    { price: 98.72, size: 245.5, total: 24230.36 },
    { price: 98.68, size: 189.2, total: 18662.46 },
    { price: 98.62, size: 312.8, total: 30848.34 },
    { price: 98.55, size: 156.4, total: 15413.22 },
    { price: 98.50, size: 423.1, total: 41675.35 },
  ],
  bids: [
    { price: 98.45, size: 387.2, total: 38119.64 },
    { price: 98.40, size: 234.6, total: 23084.64 },
    { price: 98.35, size: 445.8, total: 43844.43 },
    { price: 98.28, size: 178.3, total: 17523.32 },
    { price: 98.22, size: 289.4, total: 28426.87 },
  ],
};

type NavItem = 'dashboard' | 'trade' | 'marketplace' | 'bots' | 'leaderboard' | 'settings';

export default function AppPage() {
  const [, navigate] = useLocation();
  const { user, logout, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [activeNav, setActiveNav] = useState<NavItem>('dashboard');
  const [selectedMarket, setSelectedMarket] = useState(markets[0]);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [orderSide, setOrderSide] = useState<'long' | 'short'>('long');
  const [orderSize, setOrderSize] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Fetch data using React Query hooks
  const { data: portfolioData } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: subscriptionsData } = useSubscriptions();
  const { data: tradesData } = useTrades(10);
  const { data: botsData } = useBots();
  const { data: leaderboardData } = useLeaderboard(100);
  const subscribeBot = useSubscribeToBot();
  const updateSub = useUpdateSubscription();

  // Redirect to landing if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/');
    }
  }, [user, authLoading, navigate]);

  const handleDisconnect = async () => {
    await logout();
  };

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] bg-primary/20 rounded-full blur-[150px]" />
          <div className="absolute bottom-1/3 right-1/4 w-[400px] h-[400px] bg-accent/15 rounded-full blur-[120px]" />
        </div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full"
        >
          <div className="gradient-border p-8 noise text-center">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center animate-pulse">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-display font-bold mb-2">Loading...</h1>
            <p className="text-muted-foreground">
              Please wait while we load your dashboard
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className={`fixed inset-y-0 left-0 z-50 bg-card/95 backdrop-blur-xl border-r border-border/50 transform transition-all duration-300 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'} w-64`}>
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-border/50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              {!sidebarCollapsed && (
                <div className="hidden lg:block">
                  <span className="font-display font-bold text-lg">QuantumVault</span>
                  <p className="text-xs text-muted-foreground">Solana • Mainnet</p>
                </div>
              )}
              <div className="lg:hidden">
                <span className="font-display font-bold text-lg">QuantumVault</span>
                <p className="text-xs text-muted-foreground">Solana • Mainnet</p>
              </div>
            </div>
          </div>

          <nav className="flex-1 p-3 space-y-1">
            {[
              { id: 'dashboard' as NavItem, icon: LayoutDashboard, label: 'Dashboard' },
              { id: 'trade' as NavItem, icon: Activity, label: 'Trade' },
              { id: 'marketplace' as NavItem, icon: Store, label: 'Marketplace' },
              { id: 'bots' as NavItem, icon: Bot, label: 'My Bots' },
              { id: 'leaderboard' as NavItem, icon: Users, label: 'Leaderboard' },
              { id: 'settings' as NavItem, icon: Settings, label: 'Settings' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { setActiveNav(item.id); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${sidebarCollapsed ? 'lg:justify-center lg:px-3' : ''} ${
                  activeNav === item.id 
                    ? 'bg-primary/20 text-primary' 
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
                data-testid={`nav-${item.id}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {!sidebarCollapsed && <span className="hidden lg:inline">{item.label}</span>}
                <span className="lg:hidden">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="p-3 border-t border-border/50">
            {!sidebarCollapsed ? (
              <>
                <div className="p-3 rounded-xl bg-muted/30 mb-3 hidden lg:block">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                      7x
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{walletAddress}</p>
                      <p className="text-xs text-muted-foreground">Connected</p>
                    </div>
                    <button className="p-1.5 hover:bg-muted rounded-lg transition-colors" data-testid="button-copy-address">
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">SOL</p>
                      <p className="text-sm font-semibold font-mono">12.45</p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">USDC</p>
                      <p className="text-sm font-semibold font-mono">8,450</p>
                    </div>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-muted/30 mb-3 lg:hidden">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                      7x
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{walletAddress}</p>
                      <p className="text-xs text-muted-foreground">Connected</p>
                    </div>
                    <button className="p-1.5 hover:bg-muted rounded-lg transition-colors">
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">SOL</p>
                      <p className="text-sm font-semibold font-mono">12.45</p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">USDC</p>
                      <p className="text-sm font-semibold font-mono">8,450</p>
                    </div>
                  </div>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full"
                  onClick={handleDisconnect}
                  data-testid="button-disconnect"
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  <span className="hidden lg:inline">Disconnect</span>
                  <span className="lg:hidden">Disconnect</span>
                </Button>
              </>
            ) : (
              <div className="hidden lg:flex flex-col items-center gap-2">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                  7x
                </div>
                <button 
                  onClick={handleDisconnect}
                  className="p-2 hover:bg-muted rounded-lg transition-colors"
                  title="Disconnect"
                  data-testid="button-disconnect-collapsed"
                >
                  <LogOut className="w-5 h-5 text-muted-foreground" />
                </button>
              </div>
            )}
            
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="hidden lg:flex w-full mt-3 items-center justify-center gap-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-all"
              data-testid="button-collapse-sidebar"
            >
              {sidebarCollapsed ? (
                <PanelLeft className="w-5 h-5" />
              ) : (
                <>
                  <PanelLeftClose className="w-5 h-5" />
                  <span className="text-sm">Collapse</span>
                </>
              )}
            </button>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'}`}>
        <header className="sticky top-0 z-30 h-14 bg-background/80 backdrop-blur-xl border-b border-border/50 flex items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-4">
            <button 
              className="lg:hidden p-2 hover:bg-muted rounded-lg"
              onClick={() => setSidebarOpen(true)}
              data-testid="button-menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="relative hidden sm:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search markets..." 
                className="pl-9 w-64 bg-muted/30 border-border/50"
                data-testid="input-search"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 hover:bg-muted rounded-lg relative" data-testid="button-notifications">
              <Bell className="w-5 h-5 text-muted-foreground" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full" />
            </button>
            <button className="p-2 hover:bg-muted rounded-lg" data-testid="button-refresh">
              <RefreshCw className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
        </header>

        <main className="p-4 lg:p-6">
          <AnimatePresence mode="wait">
            {activeNav === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Portfolio Value</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-value">$24,891.45</p>
                    <p className="text-xs text-emerald-400 mt-1">+$2,456.80 (10.9%)</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Unrealized PnL</p>
                    <p className="text-2xl font-bold font-mono text-emerald-400" data-testid="text-unrealized-pnl">+$516.50</p>
                    <p className="text-xs text-muted-foreground mt-1">3 open positions</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Today's PnL</p>
                    <p className="text-2xl font-bold font-mono text-emerald-400" data-testid="text-today-pnl">+$342.18</p>
                    <p className="text-xs text-muted-foreground mt-1">12 trades</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Active Bots</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-active-bots">2</p>
                    <p className="text-xs text-muted-foreground mt-1">1 paused</p>
                  </div>
                </div>

                <div className="grid lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 gradient-border p-4 noise">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-display font-semibold">Open Positions</h2>
                      <Button variant="outline" size="sm" data-testid="button-view-all-positions">View All</Button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground text-xs border-b border-border/50">
                            <th className="text-left py-3 font-medium">Market</th>
                            <th className="text-left py-3 font-medium">Side</th>
                            <th className="text-right py-3 font-medium">Size</th>
                            <th className="text-right py-3 font-medium">Entry</th>
                            <th className="text-right py-3 font-medium">Current</th>
                            <th className="text-right py-3 font-medium">PnL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {positions.map((pos, i) => (
                            <tr key={i} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-position-${i}`}>
                              <td className="py-3 font-medium">{pos.market}</td>
                              <td className="py-3">
                                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                  pos.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                }`}>
                                  {pos.side}
                                </span>
                              </td>
                              <td className="py-3 text-right font-mono">{pos.size}</td>
                              <td className="py-3 text-right font-mono text-muted-foreground">${pos.entry.toLocaleString()}</td>
                              <td className="py-3 text-right font-mono">${pos.current.toLocaleString()}</td>
                              <td className={`py-3 text-right font-mono ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)} ({pos.pnlPercent}%)
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="gradient-border p-4 noise">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-display font-semibold">Active Bots</h2>
                      <Button variant="outline" size="sm" data-testid="button-manage-bots">Manage</Button>
                    </div>
                    <div className="space-y-3">
                      {activeBots.map((bot) => (
                        <div key={bot.id} className="p-3 rounded-xl bg-muted/30 hover:bg-muted/40 transition-colors" data-testid={`bot-item-${bot.id}`}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center">
                                <Bot className="w-4 h-4 text-primary" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">{bot.name}</p>
                                <p className="text-xs text-muted-foreground">{bot.market}</p>
                              </div>
                            </div>
                            <span className={`w-2 h-2 rounded-full ${bot.status === 'running' ? 'bg-emerald-400' : 'bg-yellow-400'}`} />
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{bot.trades} trades</span>
                            <span className={bot.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {bot.pnl >= 0 ? '+' : ''}${bot.pnl.toFixed(2)} ({bot.pnlPercent}%)
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="gradient-border p-4 noise">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-display font-semibold">Recent Trades</h2>
                    <Button variant="outline" size="sm" data-testid="button-trade-history">Full History</Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-xs border-b border-border/50">
                          <th className="text-left py-3 font-medium">Time</th>
                          <th className="text-left py-3 font-medium">Market</th>
                          <th className="text-left py-3 font-medium">Side</th>
                          <th className="text-right py-3 font-medium">Size</th>
                          <th className="text-right py-3 font-medium">Price</th>
                          <th className="text-right py-3 font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentTrades.map((trade, i) => (
                          <tr key={i} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-trade-${i}`}>
                            <td className="py-3 font-mono text-muted-foreground">{trade.time}</td>
                            <td className="py-3 font-medium">{trade.market}</td>
                            <td className="py-3">
                              <span className={`flex items-center gap-1 ${trade.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                                {trade.side === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                                {trade.side}
                              </span>
                            </td>
                            <td className="py-3 text-right font-mono">{trade.size}</td>
                            <td className="py-3 text-right font-mono">${trade.price.toLocaleString()}</td>
                            <td className="py-3 text-right font-mono">${trade.total.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </motion.div>
            )}

            {activeNav === 'trade' && (
              <motion.div
                key="trade"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex flex-wrap gap-2 mb-4">
                  {markets.map((m) => (
                    <button
                      key={m.symbol}
                      onClick={() => setSelectedMarket(m)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                        selectedMarket.symbol === m.symbol
                          ? 'bg-primary/20 text-primary border border-primary/50'
                          : 'bg-muted/30 text-muted-foreground hover:bg-muted/50 border border-transparent'
                      }`}
                      data-testid={`market-${m.symbol}`}
                    >
                      <span className="font-semibold">{m.symbol}</span>
                      <span className={`ml-2 ${m.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {m.change >= 0 ? '+' : ''}{m.change}%
                      </span>
                    </button>
                  ))}
                </div>

                <div className="grid lg:grid-cols-4 gap-6">
                  <div className="lg:col-span-3 space-y-6">
                    <div className="gradient-border p-4 noise">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h2 className="text-2xl font-display font-bold">{selectedMarket.symbol}</h2>
                          <div className="flex items-center gap-4 mt-1">
                            <span className="text-3xl font-mono font-bold">${selectedMarket.price.toLocaleString()}</span>
                            <span className={`flex items-center gap-1 text-lg ${selectedMarket.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {selectedMarket.change >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                              {selectedMarket.change >= 0 ? '+' : ''}{selectedMarket.change}%
                            </span>
                          </div>
                        </div>
                        <div className="text-right text-sm">
                          <p className="text-muted-foreground">24h Volume</p>
                          <p className="font-mono font-semibold">${selectedMarket.volume}</p>
                        </div>
                      </div>
                      <div className="h-64 bg-muted/20 rounded-xl flex items-center justify-center border border-border/30">
                        <div className="text-center text-muted-foreground">
                          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
                          <p>TradingView Chart</p>
                          <p className="text-xs">Real-time price data</p>
                        </div>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-6">
                      <div className="gradient-border p-4 noise">
                        <h3 className="font-display font-semibold mb-3">Order Book</h3>
                        <div className="space-y-1 mb-3">
                          {orderbook.asks.slice().reverse().map((ask, i) => (
                            <div key={i} className="relative flex items-center justify-between text-xs py-1 px-2 rounded" data-testid={`ask-${i}`}>
                              <div 
                                className="absolute inset-0 bg-red-500/10 rounded" 
                                style={{ width: `${(ask.size / 500) * 100}%` }} 
                              />
                              <span className="relative text-red-400 font-mono">${ask.price.toFixed(2)}</span>
                              <span className="relative font-mono text-muted-foreground">{ask.size.toFixed(1)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="py-2 px-2 bg-muted/30 rounded-lg text-center mb-3">
                          <span className="text-lg font-mono font-bold">${selectedMarket.price.toFixed(2)}</span>
                        </div>
                        <div className="space-y-1">
                          {orderbook.bids.map((bid, i) => (
                            <div key={i} className="relative flex items-center justify-between text-xs py-1 px-2 rounded" data-testid={`bid-${i}`}>
                              <div 
                                className="absolute inset-0 bg-emerald-500/10 rounded" 
                                style={{ width: `${(bid.size / 500) * 100}%` }} 
                              />
                              <span className="relative text-emerald-400 font-mono">${bid.price.toFixed(2)}</span>
                              <span className="relative font-mono text-muted-foreground">{bid.size.toFixed(1)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="gradient-border p-4 noise">
                        <h3 className="font-display font-semibold mb-3">Recent Trades</h3>
                        <div className="space-y-2">
                          {recentTrades.slice(0, 8).map((trade, i) => (
                            <div key={i} className="flex items-center justify-between text-xs py-1">
                              <span className="text-muted-foreground font-mono">{trade.time}</span>
                              <span className={trade.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>
                                ${trade.price.toLocaleString()}
                              </span>
                              <span className="font-mono text-muted-foreground">{trade.size}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="gradient-border p-4 noise h-fit sticky top-20">
                    <h3 className="font-display font-semibold mb-4">Place Order</h3>
                    
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <button
                        onClick={() => setOrderSide('long')}
                        className={`py-3 rounded-xl font-semibold transition-all ${
                          orderSide === 'long'
                            ? 'bg-emerald-500 text-white'
                            : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                        }`}
                        data-testid="button-long"
                      >
                        Long
                      </button>
                      <button
                        onClick={() => setOrderSide('short')}
                        className={`py-3 rounded-xl font-semibold transition-all ${
                          orderSide === 'short'
                            ? 'bg-red-500 text-white'
                            : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                        }`}
                        data-testid="button-short"
                      >
                        Short
                      </button>
                    </div>

                    <div className="flex gap-2 mb-4">
                      <button
                        onClick={() => setOrderType('market')}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                          orderType === 'market'
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        data-testid="button-market-order"
                      >
                        Market
                      </button>
                      <button
                        onClick={() => setOrderType('limit')}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                          orderType === 'limit'
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        data-testid="button-limit-order"
                      >
                        Limit
                      </button>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1.5 block">Size (USDC)</label>
                        <div className="relative">
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={orderSize}
                            onChange={(e) => setOrderSize(e.target.value)}
                            className="pr-16 bg-muted/30 border-border/50"
                            data-testid="input-order-size"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
                        </div>
                        <div className="flex gap-2 mt-2">
                          {['25%', '50%', '75%', '100%'].map((pct) => (
                            <button
                              key={pct}
                              className="flex-1 py-1.5 text-xs bg-muted/30 hover:bg-muted/50 rounded-lg transition-colors"
                              data-testid={`button-size-${pct}`}
                            >
                              {pct}
                            </button>
                          ))}
                        </div>
                      </div>

                      {orderType === 'limit' && (
                        <div>
                          <label className="text-xs text-muted-foreground mb-1.5 block">Limit Price</label>
                          <Input
                            type="number"
                            placeholder={selectedMarket.price.toString()}
                            value={limitPrice}
                            onChange={(e) => setLimitPrice(e.target.value)}
                            className="bg-muted/30 border-border/50"
                            data-testid="input-limit-price"
                          />
                        </div>
                      )}

                      <div className="p-3 rounded-xl bg-muted/20 space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Est. Entry</span>
                          <span className="font-mono">${selectedMarket.price.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Leverage</span>
                          <span className="font-mono">5x</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fee</span>
                          <span className="font-mono">~$0.50</span>
                        </div>
                      </div>

                      <Button
                        className={`w-full py-6 text-lg font-semibold ${
                          orderSide === 'long'
                            ? 'bg-emerald-500 hover:bg-emerald-600'
                            : 'bg-red-500 hover:bg-red-600'
                        }`}
                        data-testid="button-place-order"
                      >
                        {orderSide === 'long' ? 'Long' : 'Short'} {selectedMarket.symbol}
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeNav === 'marketplace' && (
              <motion.div
                key="marketplace"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-display font-bold">Bot Marketplace</h1>
                    <p className="text-muted-foreground">Discover and subscribe to proven trading strategies</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" data-testid="button-filter-all">All</Button>
                    <Button variant="outline" size="sm" data-testid="button-filter-signal">Signal Bots</Button>
                    <Button variant="outline" size="sm" data-testid="button-filter-grid">Grid Bots</Button>
                  </div>
                </div>

                <div className="gradient-border p-6 noise">
                  <div className="flex items-center gap-3 mb-4">
                    <Zap className="w-5 h-5 text-primary" />
                    <h2 className="font-display font-semibold">Featured Bots</h2>
                  </div>
                  <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {marketplaceBots.filter(b => b.featured).map((bot) => (
                      <div 
                        key={bot.id} 
                        className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/5 border border-primary/20 hover:border-primary/40 transition-all cursor-pointer group"
                        data-testid={`featured-bot-${bot.id}`}
                      >
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                            <Bot className="w-5 h-5 text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-sm truncate">{bot.name}</h3>
                            <p className="text-xs text-muted-foreground">{bot.type}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-emerald-400 font-bold">+{bot.apr}% APR</span>
                          <span className="text-muted-foreground text-xs">{bot.subscribers.toLocaleString()} users</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input 
                    placeholder="Search bots by name, market, or creator..." 
                    className="pl-12 py-6 bg-card border-border/50 text-lg"
                    data-testid="input-search-bots"
                  />
                </div>

                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {marketplaceBots.map((bot) => (
                    <div 
                      key={bot.id} 
                      className="gradient-border p-5 noise hover:scale-[1.02] transition-transform cursor-pointer group"
                      data-testid={`marketplace-bot-${bot.id}`}
                    >
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center">
                            <Bot className="w-6 h-6 text-primary" />
                          </div>
                          <div>
                            <h3 className="font-display font-semibold">{bot.name}</h3>
                            <p className="text-sm text-muted-foreground">{bot.type} • {bot.market}</p>
                          </div>
                        </div>
                        {bot.featured && (
                          <span className="px-2 py-1 rounded-full text-xs font-medium bg-primary/20 text-primary flex items-center gap-1">
                            <Star className="w-3 h-3" /> Featured
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-3 mb-4">
                        <div className="text-center p-2 rounded-lg bg-muted/30">
                          <p className="text-lg font-bold text-emerald-400">+{bot.apr}%</p>
                          <p className="text-xs text-muted-foreground">Est. APR</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-muted/30">
                          <p className="text-lg font-bold">{bot.subscribers.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Subscribers</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-muted/30">
                          <div className="flex items-center justify-center gap-1">
                            <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                            <span className="text-lg font-bold">{bot.rating}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">Rating</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-sm text-muted-foreground mb-4">
                        <span>By @{bot.creator}</span>
                        <span>Min: ${bot.minDeposit} USDC</span>
                      </div>

                      <div className="flex gap-2">
                        <Button 
                          className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90"
                          data-testid={`button-subscribe-${bot.id}`}
                        >
                          Subscribe
                        </Button>
                        <Button variant="outline" size="icon" data-testid={`button-details-${bot.id}`}>
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="gradient-border p-6 noise">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                      <Shield className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-display font-semibold">Create Your Own Bot</h3>
                      <p className="text-sm text-muted-foreground">Build custom strategies and earn from subscribers</p>
                    </div>
                    <Button className="bg-gradient-to-r from-primary to-accent" data-testid="button-create-strategy">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Strategy
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeNav === 'bots' && (
              <motion.div
                key="bots"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-display font-bold">My Bots</h1>
                    <p className="text-muted-foreground">Manage your trading bots and subscriptions</p>
                  </div>
                  <Button className="bg-gradient-to-r from-primary to-accent" data-testid="button-create-bot">
                    <Plus className="w-4 h-4 mr-2" />
                    Create Bot
                  </Button>
                </div>

                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {activeBots.map((bot) => (
                    <div key={bot.id} className="gradient-border p-5 noise" data-testid={`bot-card-${bot.id}`}>
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                            <Bot className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h3 className="font-display font-semibold">{bot.name}</h3>
                            <p className="text-sm text-muted-foreground">{bot.market}</p>
                          </div>
                        </div>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          bot.status === 'running' 
                            ? 'bg-emerald-500/20 text-emerald-400' 
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {bot.status}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Total Trades</p>
                          <p className="text-xl font-bold font-mono">{bot.trades}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Total PnL</p>
                          <p className={`text-xl font-bold font-mono ${bot.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {bot.pnl >= 0 ? '+' : ''}${bot.pnl.toFixed(2)}
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="flex-1" data-testid={`button-edit-bot-${bot.id}`}>
                          <Settings className="w-4 h-4 mr-1" />
                          Settings
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="flex-1"
                          data-testid={`button-toggle-bot-${bot.id}`}
                        >
                          {bot.status === 'running' ? (
                            <>
                              <Minus className="w-4 h-4 mr-1" />
                              Pause
                            </>
                          ) : (
                            <>
                              <Plus className="w-4 h-4 mr-1" />
                              Start
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}

                  <div className="border-2 border-dashed border-border/50 rounded-2xl p-8 flex flex-col items-center justify-center text-center hover:border-primary/50 transition-colors cursor-pointer" data-testid="button-add-new-bot">
                    <div className="w-12 h-12 rounded-xl bg-muted/30 flex items-center justify-center mb-3">
                      <Plus className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <p className="font-medium mb-1">Add New Bot</p>
                    <p className="text-sm text-muted-foreground">Browse marketplace or create custom</p>
                  </div>
                </div>
              </motion.div>
            )}

            {activeNav === 'leaderboard' && (
              <motion.div
                key="leaderboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div>
                  <h1 className="text-2xl font-display font-bold">Leaderboard</h1>
                  <p className="text-muted-foreground">Top traders this epoch</p>
                </div>

                <div className="gradient-border noise overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/20 text-muted-foreground text-xs">
                        <th className="text-left py-4 px-4 font-medium">Rank</th>
                        <th className="text-left py-4 px-4 font-medium">Trader</th>
                        <th className="text-right py-4 px-4 font-medium">Volume</th>
                        <th className="text-right py-4 px-4 font-medium">PnL</th>
                        <th className="text-right py-4 px-4 font-medium">Win Rate</th>
                        <th className="text-right py-4 px-4 font-medium">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { rank: 1, name: 'quantum_whale', volume: '2.4M', pnl: '+$124,500', winRate: '72%', trades: 1247 },
                        { rank: 2, name: 'sol_maxi_2024', volume: '1.8M', pnl: '+$89,230', winRate: '68%', trades: 892 },
                        { rank: 3, name: 'drift_master', volume: '1.2M', pnl: '+$67,890', winRate: '71%', trades: 634 },
                        { rank: 4, name: 'perp_lord', volume: '980K', pnl: '+$45,120', winRate: '65%', trades: 521 },
                        { rank: 5, name: 'alpha_hunter', volume: '750K', pnl: '+$32,450', winRate: '69%', trades: 445 },
                        { rank: 6, name: 'grid_wizard', volume: '620K', pnl: '+$28,900', winRate: '74%', trades: 328 },
                        { rank: 7, name: 'moon_trader', volume: '580K', pnl: '+$24,150', winRate: '62%', trades: 412 },
                        { rank: 8, name: 'signal_king', volume: '520K', pnl: '+$21,800', winRate: '67%', trades: 289 },
                      ].map((trader) => (
                        <tr key={trader.rank} className="border-t border-border/30 hover:bg-muted/20" data-testid={`row-leaderboard-${trader.rank}`}>
                          <td className="py-4 px-4">
                            <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold ${
                              trader.rank === 1 ? 'bg-yellow-500/20 text-yellow-400' :
                              trader.rank === 2 ? 'bg-gray-400/20 text-gray-400' :
                              trader.rank === 3 ? 'bg-orange-500/20 text-orange-400' :
                              'bg-muted/30 text-muted-foreground'
                            }`}>
                              {trader.rank}
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30" />
                              <span className="font-medium">@{trader.name}</span>
                            </div>
                          </td>
                          <td className="py-4 px-4 text-right font-mono">${trader.volume}</td>
                          <td className="py-4 px-4 text-right font-mono text-emerald-400">{trader.pnl}</td>
                          <td className="py-4 px-4 text-right font-mono">{trader.winRate}</td>
                          <td className="py-4 px-4 text-right font-mono text-muted-foreground">{trader.trades}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            )}

            {activeNav === 'settings' && (
              <motion.div
                key="settings"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-2xl space-y-6"
              >
                <div>
                  <h1 className="text-2xl font-display font-bold">Settings</h1>
                  <p className="text-muted-foreground">Manage your account and preferences</p>
                </div>

                <div className="gradient-border p-6 noise space-y-6">
                  <div>
                    <h3 className="font-display font-semibold mb-4">Profile</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm text-muted-foreground mb-1.5 block">Username</label>
                        <Input defaultValue="quantum_trader" className="bg-muted/30 border-border/50" data-testid="input-username" />
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground mb-1.5 block">Referral Code</label>
                        <div className="flex gap-2">
                          <Input defaultValue="QUANTUM2024" readOnly className="bg-muted/30 border-border/50 font-mono" data-testid="input-referral" />
                          <Button variant="outline" data-testid="button-copy-referral">
                            <Copy className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-border/50 pt-6">
                    <h3 className="font-display font-semibold mb-4">Trading Defaults</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm text-muted-foreground mb-1.5 block">Default Leverage</label>
                        <Input type="number" defaultValue="5" className="bg-muted/30 border-border/50" data-testid="input-leverage" />
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground mb-1.5 block">Slippage Tolerance (bps)</label>
                        <Input type="number" defaultValue="30" className="bg-muted/30 border-border/50" data-testid="input-slippage" />
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-border/50 pt-6">
                    <h3 className="font-display font-semibold mb-4">Danger Zone</h3>
                    <Button variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/10" data-testid="button-close-positions">
                      Close All Positions
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}