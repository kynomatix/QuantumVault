import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'wouter';
import { useWallet } from '@/hooks/useWallet';
import { useBots, useSubscriptions, usePortfolio, usePositions, useTrades, useLeaderboard, useSubscribeToBot, useUpdateSubscription, usePrices, useTradingBots } from '@/hooks/useApi';
import { useToast } from '@/hooks/use-toast';
import { 
  Wallet, 
  TrendingUp, 
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
  Users,
  Sparkles,
  LogOut,
  Menu,
  Store,
  Star,
  Zap,
  Shield,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  Loader2,
  ArrowUpFromLine,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BotManagementDrawer } from '@/components/BotManagementDrawer';
import { WalletContent } from '@/pages/WalletManagement';

interface TradingBot {
  id: string;
  name: string;
  market: string;
  webhookSecret: string;
  webhookUrl?: string;
  isActive: boolean;
  side: string;
  leverage: number;
  maxPositionSize: string | null;
  driftSubaccountId?: number | null;
  stats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
    lastTradeAt?: string;
  } | null;
  createdAt: string;
}
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

type MarketplaceBot = { 
  id: string; 
  name: string; 
  type: string; 
  market: string; 
  apr: number; 
  subscribers: number; 
  creator: string; 
  rating: number; 
  minDeposit: number; 
  featured: boolean;
};

const marketplaceBots: MarketplaceBot[] = [];

type NavItem = 'dashboard' | 'bots' | 'marketplace' | 'leaderboard' | 'settings' | 'wallet';

export default function AppPage() {
  const [, navigate] = useLocation();
  const { connected, connecting, disconnect, shortenedAddress, balance, balanceLoading, publicKeyString } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const [activeNav, setActiveNav] = useState<NavItem>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [withdrawingBotId, setWithdrawingBotId] = useState<string | null>(null);
  const [botBalances, setBotBalances] = useState<Record<string, { balance: number; exists: boolean }>>({});
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [botToDelete, setBotToDelete] = useState<{ id: string; name: string; balance: number; isLegacy?: boolean; agentPublicKey?: string } | null>(null);
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);
  const [manageBotDrawerOpen, setManageBotDrawerOpen] = useState(false);
  const [selectedManagedBot, setSelectedManagedBot] = useState<TradingBot | null>(null);

  // Fetch data using React Query hooks
  const { data: portfolioData } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: subscriptionsData } = useSubscriptions();
  const { data: tradesData } = useTrades(10);
  const { data: botsData, refetch: refetchBots } = useTradingBots();
  const { data: leaderboardData } = useLeaderboard(100);
  const { data: pricesData } = usePrices();
  const subscribeBot = useSubscribeToBot();
  const updateSub = useUpdateSubscription();

  const [totalEquity, setTotalEquity] = useState<number | null>(null);
  const [equityLoading, setEquityLoading] = useState(false);
  const [agentBalance, setAgentBalance] = useState<number | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  // Fetch total equity across all bot subaccounts
  useEffect(() => {
    if (!connected) {
      setTotalEquity(null);
      return;
    }
    
    const fetchTotalEquity = async () => {
      setEquityLoading(true);
      try {
        const res = await fetch('/api/total-equity', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setTotalEquity(data.totalEquity ?? 0);
        } else if (res.status === 401) {
          // Not authenticated yet, silently skip
          setTotalEquity(null);
        }
      } catch (error) {
        // Network error, silently skip
      } finally {
        setEquityLoading(false);
      }
    };
    
    fetchTotalEquity();
    // Refresh every 30 seconds
    const interval = setInterval(fetchTotalEquity, 30000);
    return () => clearInterval(interval);
  }, [connected]);

  // Fetch agent balance
  useEffect(() => {
    if (!connected) {
      setAgentBalance(null);
      return;
    }
    
    const fetchAgentBalance = async () => {
      setAgentLoading(true);
      try {
        const res = await fetch('/api/agent/balance', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setAgentBalance(data.balance ?? 0);
        }
      } catch (error) {
        // Silently fail
      } finally {
        setAgentLoading(false);
      }
    };
    
    fetchAgentBalance();
    const interval = setInterval(fetchAgentBalance, 30000);
    return () => clearInterval(interval);
  }, [connected]);

  // Redirect to landing if wallet not connected
  useEffect(() => {
    if (!connecting && !connected) {
      navigate('/');
    }
  }, [connected, connecting, navigate]);

  const handleDisconnect = async () => {
    await disconnect();
  };

  // Fetch bot balances when connected
  useEffect(() => {
    if (!connected || !botsData) return;
    
    const fetchBalances = async () => {
      const balances: Record<string, { balance: number; exists: boolean }> = {};
      for (const bot of botsData) {
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          try {
            const res = await fetch(`/api/bot/${bot.id}/balance`, { credentials: 'include' });
            if (res.ok) {
              const data = await res.json();
              balances[bot.id] = { balance: data.usdcBalance ?? 0, exists: data.subaccountExists ?? false };
            }
          } catch (error) {
            console.error(`Error fetching balance for bot ${bot.id}:`, error);
          }
        }
      }
      setBotBalances(balances);
    };
    
    fetchBalances();
  }, [connected, botsData]);

  const handleWithdrawAll = async (botId: string, subaccountId: number) => {
    const botBalance = botBalances[botId];
    if (!botBalance || botBalance.balance <= 0) {
      toast({ title: 'No funds to withdraw', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    setWithdrawingBotId(botId);
    try {
      const response = await fetch(`/api/bot/${botId}/withdraw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-wallet-address': solanaWallet.publicKey.toString(),
        },
        body: JSON.stringify({ amount: botBalance.balance }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Withdrawal Successful!', 
        description: message 
      });
      
      // Refresh balances
      setBotBalances(prev => ({
        ...prev,
        [botId]: { ...prev[botId], balance: 0 }
      }));
    } catch (error: any) {
      console.error('Withdraw error:', error);
      toast({ 
        title: 'Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setWithdrawingBotId(null);
    }
  };

  const handleDeleteBot = async (botId: string, botName: string) => {
    const botBalance = botBalances[botId]?.balance ?? 0;
    
    if (!solanaWallet.publicKey) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    // First try normal delete
    setDeletingBotId(botId);
    try {
      const response = await fetch(`/api/trading-bots/${botId}`, {
        method: 'DELETE',
        headers: { 'x-wallet-address': solanaWallet.publicKey.toString() },
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast({ title: 'Bot deleted successfully' });
        setBotBalances(prev => {
          const updated = { ...prev };
          delete updated[botId];
          return updated;
        });
        setDeletingBotId(null);
        return;
      }

      // Handle legacy bot warning
      if (data.isLegacy) {
        setBotToDelete({ id: botId, name: botName, balance: 0, isLegacy: true, agentPublicKey: data.agentPublicKey });
        setDeleteModalOpen(true);
        setDeletingBotId(null);
        return;
      }

      // Handle bot with funds
      if (data.requiresSweep) {
        setBotToDelete({ id: botId, name: botName, balance: data.balance });
        setDeleteModalOpen(true);
        setDeletingBotId(null);
        return;
      }

      throw new Error(data.error || 'Failed to delete bot');
    } catch (error: any) {
      console.error('Delete bot error:', error);
      toast({ 
        title: 'Delete Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
      setDeletingBotId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!botToDelete || !solanaWallet.publicKey || !solanaWallet.signTransaction) {
      return;
    }

    setDeletingBotId(botToDelete.id);
    setDeleteModalOpen(false);

    try {
      // For legacy bots, just confirm deletion without sweep
      if (botToDelete.isLegacy) {
        const response = await fetch(`/api/trading-bots/${botToDelete.id}/confirm-delete`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-wallet-address': solanaWallet.publicKey.toString(),
          },
          body: JSON.stringify({}),
          credentials: 'include',
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to delete bot');
        }

        toast({ title: 'Bot deleted successfully' });
        setBotBalances(prev => {
          const updated = { ...prev };
          delete updated[botToDelete.id];
          return updated;
        });
        setBotToDelete(null);
        setDeletingBotId(null);
        return;
      }

      // For bots with funds, use force delete endpoint
      const forceResponse = await fetch(`/api/trading-bots/${botToDelete.id}/force`, {
        method: 'DELETE',
        headers: { 'x-wallet-address': solanaWallet.publicKey.toString() },
        credentials: 'include',
      });

      const forceData = await forceResponse.json();

      if (forceResponse.ok && forceData.success) {
        toast({ title: 'Bot deleted successfully' });
        setBotBalances(prev => {
          const updated = { ...prev };
          delete updated[botToDelete.id];
          return updated;
        });
        setBotToDelete(null);
        setDeletingBotId(null);
        return;
      }

      // Need to sign and send transaction
      if (forceData.requiresTransaction) {
        const transaction = Transaction.from(Buffer.from(forceData.transaction, 'base64'));
        const signedTx = await solanaWallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        
        await connection.confirmTransaction({
          signature,
          blockhash: forceData.blockhash,
          lastValidBlockHeight: forceData.lastValidBlockHeight,
        });

        // Now confirm the deletion
        const confirmResponse = await fetch(`/api/trading-bots/${botToDelete.id}/confirm-delete`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-wallet-address': solanaWallet.publicKey.toString(),
          },
          body: JSON.stringify({ txSignature: signature }),
          credentials: 'include',
        });

        if (!confirmResponse.ok) {
          const error = await confirmResponse.json();
          throw new Error(error.error || 'Failed to confirm deletion');
        }

        toast({ 
          title: 'Bot deleted successfully!', 
          description: `$${forceData.balance.toFixed(2)} USDC has been returned to your main account.`
        });
        setBotBalances(prev => {
          const updated = { ...prev };
          delete updated[botToDelete.id];
          return updated;
        });
      }
    } catch (error: any) {
      console.error('Confirm delete error:', error);
      toast({ 
        title: 'Delete Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setBotToDelete(null);
      setDeletingBotId(null);
    }
  };


  if (connecting || !connected) {
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
              <img src="/images/qv_logo.png" alt="QuantumVault" className="w-10 h-10 rounded-xl flex-shrink-0" />
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
              { id: 'bots' as NavItem, icon: Bot, label: 'My Bots' },
              { id: 'marketplace' as NavItem, icon: Store, label: 'Marketplace' },
              { id: 'wallet' as NavItem, icon: Wallet, label: 'Wallet' },
              { id: 'leaderboard' as NavItem, icon: Users, label: 'Leaderboard' },
              { id: 'settings' as NavItem, icon: Settings, label: 'Settings' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { 
                  setActiveNav(item.id);
                  setSidebarOpen(false); 
                }}
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
                      <Wallet className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" data-testid="text-wallet-address">{shortenedAddress}</p>
                      <p className="text-xs text-muted-foreground">Connected</p>
                    </div>
                    <button className="p-1.5 hover:bg-muted rounded-lg transition-colors" data-testid="button-copy-address">
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="p-2 rounded-lg bg-background/50 text-center">
                    <p className="text-xs text-muted-foreground">Total Equity</p>
                    <p className="text-lg font-semibold font-mono text-primary" data-testid="text-total-equity">
                      {equityLoading ? '...' : totalEquity !== null ? `$${totalEquity.toFixed(2)}` : '$0.00'}
                    </p>
                    <p className="text-xs text-muted-foreground">USDC</p>
                  </div>
                  <div className="px-3 py-2 space-y-2 border-t border-border/30 mt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Main Account</span>
                      <span className="font-mono text-primary" data-testid="text-main-account">${agentBalance?.toFixed(2) ?? '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">In Trading</span>
                      <span className="font-mono text-emerald-400" data-testid="text-in-trading">${totalEquity?.toFixed(2) ?? '0.00'}</span>
                    </div>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-muted/30 mb-3 lg:hidden">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                      <Wallet className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" data-testid="text-wallet-address-mobile">{shortenedAddress}</p>
                      <p className="text-xs text-muted-foreground">Connected</p>
                    </div>
                    <button className="p-1.5 hover:bg-muted rounded-lg transition-colors">
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="p-2 rounded-lg bg-background/50 text-center">
                    <p className="text-xs text-muted-foreground">Total Equity</p>
                    <p className="text-lg font-semibold font-mono text-primary" data-testid="text-total-equity-mobile">
                      {equityLoading ? '...' : totalEquity !== null ? `$${totalEquity.toFixed(2)}` : '$0.00'}
                    </p>
                    <p className="text-xs text-muted-foreground">USDC</p>
                  </div>
                  <div className="px-3 py-2 space-y-2 border-t border-border/30 mt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Main Account</span>
                      <span className="font-mono text-primary" data-testid="text-main-account-mobile">${agentBalance?.toFixed(2) ?? '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">In Trading</span>
                      <span className="font-mono text-emerald-400" data-testid="text-in-trading-mobile">${totalEquity?.toFixed(2) ?? '0.00'}</span>
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
                  <Wallet className="w-5 h-5" />
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
                    <p className="text-xs text-muted-foreground mb-1">SOL Balance</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-value">
                      {balance !== null ? `${balance.toFixed(4)} SOL` : '--'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Wallet balance</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">SOL Price</p>
                    <p className="text-2xl font-bold font-mono text-emerald-400" data-testid="text-unrealized-pnl">
                      ${pricesData?.['SOL-PERP']?.toFixed(2) ?? '--'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Live from market</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Total Trades</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-today-pnl">
                      {tradesData?.length ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Bot executions</p>
                  </div>
                  <div className="gradient-border p-4 noise">
                    <p className="text-xs text-muted-foreground mb-1">Active Bots</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-active-bots">
                      {botsData?.length ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">TradingView bots</p>
                  </div>
                </div>

                <div className="grid lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 gradient-border p-4 noise">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-display font-semibold">Open Positions</h2>
                      <Button variant="outline" size="sm" data-testid="button-view-all-positions">View All</Button>
                    </div>
                    <div className="overflow-x-auto">
                      {positionsData && positionsData.length > 0 ? (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-muted-foreground text-xs border-b border-border/50">
                              <th className="text-left py-3 font-medium">Market</th>
                              <th className="text-left py-3 font-medium">Side</th>
                              <th className="text-right py-3 font-medium">Size</th>
                              <th className="text-right py-3 font-medium">Entry</th>
                              <th className="text-right py-3 font-medium">PnL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {positionsData.map((pos, i) => (
                              <tr key={i} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-position-${i}`}>
                                <td className="py-3 font-medium">{pos.market}</td>
                                <td className="py-3">
                                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                    pos.side === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                  }`}>
                                    {pos.side?.toUpperCase()}
                                  </span>
                                </td>
                                <td className="py-3 text-right font-mono">{pos.size}</td>
                                <td className="py-3 text-right font-mono text-muted-foreground">${Number(pos.entryPrice).toLocaleString()}</td>
                                <td className={`py-3 text-right font-mono ${Number(pos.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {Number(pos.unrealizedPnl) >= 0 ? '+' : ''}${Number(pos.unrealizedPnl).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="text-center py-8 text-muted-foreground">
                          <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-50" />
                          <p>No open positions</p>
                          <p className="text-xs mt-1">Positions will appear when your bots execute trades</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="gradient-border p-4 noise">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-display font-semibold">Active Bots</h2>
                      <Button variant="outline" size="sm" onClick={() => setActiveNav('bots')} data-testid="button-add-bot">
                        <Plus className="w-4 h-4 mr-1" />
                        Add Bot
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {botsData && botsData.length > 0 ? (
                        botsData.map((bot) => (
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
                              <div className="flex items-center gap-2">
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-6 w-6"
                                  onClick={() => {
                                    setSelectedManagedBot(bot);
                                    setManageBotDrawerOpen(true);
                                  }}
                                  data-testid={`button-bot-settings-${bot.id}`}
                                >
                                  <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                                </Button>
                                <span className={`w-2 h-2 rounded-full ${bot.isActive ? 'bg-emerald-400' : 'bg-yellow-400'}`} />
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">{(bot.stats as any)?.totalTrades ?? 0} trades</span>
                              <span className={(bot.stats as any)?.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {(bot.stats as any)?.totalPnl >= 0 ? '+' : ''}${((bot.stats as any)?.totalPnl ?? 0).toFixed(2)}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-6 text-muted-foreground">
                          <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
                          <p>No bots yet</p>
                          <p className="text-xs mt-1">Create a TradingView bot to start</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="gradient-border p-4 noise">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-display font-semibold">Recent Trades</h2>
                    <Button variant="outline" size="sm" data-testid="button-trade-history">Full History</Button>
                  </div>
                  <div className="overflow-x-auto">
                    {tradesData && tradesData.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground text-xs border-b border-border/50">
                            <th className="text-left py-3 font-medium">Time</th>
                            <th className="text-left py-3 font-medium">Market</th>
                            <th className="text-left py-3 font-medium">Side</th>
                            <th className="text-right py-3 font-medium">Size</th>
                            <th className="text-right py-3 font-medium">Price</th>
                            <th className="text-right py-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tradesData.slice(0, 10).map((trade, i) => (
                            <tr key={i} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-trade-${i}`}>
                              <td className="py-3 font-mono text-muted-foreground text-xs">
                                {trade.createdAt ? new Date(trade.createdAt).toLocaleTimeString() : '--'}
                              </td>
                              <td className="py-3 font-medium">{trade.market}</td>
                              <td className="py-3">
                                <span className={`flex items-center gap-1 ${trade.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {trade.side === 'long' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                                  {trade.side?.toUpperCase()}
                                </span>
                              </td>
                              <td className="py-3 text-right font-mono">{trade.size}</td>
                              <td className="py-3 text-right font-mono">${Number(trade.price).toLocaleString()}</td>
                              <td className="py-3 text-right">
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  trade.status === 'filled' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-yellow-500/20 text-yellow-400'
                                }`}>
                                  {trade.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p>No trades yet</p>
                        <p className="text-xs mt-1">Trades will appear when your bots execute orders</p>
                      </div>
                    )}
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
                    <p className="text-muted-foreground">Manage your TradingView trading bots</p>
                  </div>
                  <Button 
                    className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
                    onClick={() => navigate('/bots')}
                    data-testid="button-create-bot"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Bot
                  </Button>
                </div>

                {botsData && botsData.length > 0 ? (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {botsData.map((bot) => (
                      <div 
                        key={bot.id} 
                        className="gradient-border p-4 noise hover:scale-[1.01] transition-transform"
                        data-testid={`bot-card-${bot.id}`}
                      >
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center">
                              <Bot className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                              <h3 className="font-semibold">{bot.name}</h3>
                              <p className="text-sm text-muted-foreground">{bot.market}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                              bot.isActive 
                                ? 'bg-emerald-500/20 text-emerald-400' 
                                : 'bg-yellow-500/20 text-yellow-400'
                            }`}>
                              {bot.isActive ? 'Active' : 'Inactive'}
                            </span>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => {
                                setSelectedManagedBot(bot);
                                setManageBotDrawerOpen(true);
                              }}
                              data-testid={`button-manage-bot-${bot.id}`}
                            >
                              <Settings className="w-4 h-4 text-muted-foreground" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 rounded-lg bg-muted/30">
                            <p className="text-lg font-bold">{(bot.stats as any)?.totalTrades ?? 0}</p>
                            <p className="text-xs text-muted-foreground">Trades</p>
                          </div>
                          <div className="p-2 rounded-lg bg-muted/30">
                            <p className="text-lg font-bold">{bot.leverage}x</p>
                            <p className="text-xs text-muted-foreground">Leverage</p>
                          </div>
                          <div className="p-2 rounded-lg bg-muted/30">
                            <p className={`text-lg font-bold ${(bot.stats as any)?.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {(bot.stats as any)?.totalPnl >= 0 ? '+' : ''}${((bot.stats as any)?.totalPnl ?? 0).toFixed(2)}
                            </p>
                            <p className="text-xs text-muted-foreground">PnL</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="gradient-border p-12 noise text-center">
                    <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <h3 className="text-lg font-display font-semibold mb-2">No Bots Yet</h3>
                    <p className="text-muted-foreground mb-6">Create your first TradingView bot to start automated trading</p>
                    <Button 
                      className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
                      onClick={() => navigate('/bots')}
                      data-testid="button-create-first-bot"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Create Your First Bot
                    </Button>
                  </div>
                )}
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

            {activeNav === 'wallet' && (
              <WalletContent />
            )}
          </AnimatePresence>
        </main>
      </div>

      {deleteModalOpen && botToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            data-testid="modal-delete-bot"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-lg">Delete Bot</h3>
                <p className="text-sm text-muted-foreground">{botToDelete.name}</p>
              </div>
            </div>

            {botToDelete.isLegacy ? (
              <div className="mb-6">
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-yellow-500">Legacy Bot Warning</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        This bot uses an older wallet system. Please manually check the agent wallet for any remaining funds before deletion.
                      </p>
                      <p className="text-xs text-muted-foreground mt-2 font-mono break-all">
                        Agent: {botToDelete.agentPublicKey}
                      </p>
                    </div>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Are you sure you want to delete this bot? This action cannot be undone.
                </p>
              </div>
            ) : (
              <div className="mb-6">
                <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <ArrowUpFromLine className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">Automatic Fund Withdrawal</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        This bot has <span className="font-semibold text-primary">${botToDelete.balance.toFixed(2)} USDC</span>. 
                        Funds will be automatically withdrawn to your main Drift account before deletion.
                      </p>
                    </div>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  You'll be asked to sign a transaction to transfer the funds. After confirming, the bot will be deleted.
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1" 
                onClick={() => { setDeleteModalOpen(false); setBotToDelete(null); }}
                data-testid="button-cancel-delete"
              >
                Cancel
              </Button>
              <Button 
                className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                onClick={handleConfirmDelete}
                data-testid="button-confirm-delete"
              >
                {botToDelete.isLegacy ? 'Delete Anyway' : 'Withdraw & Delete'}
              </Button>
            </div>
          </motion.div>
        </div>
      )}

      <BotManagementDrawer
        bot={selectedManagedBot}
        isOpen={manageBotDrawerOpen}
        onClose={() => {
          setManageBotDrawerOpen(false);
          setSelectedManagedBot(null);
        }}
        walletAddress={publicKeyString || ''}
        onBotUpdated={() => {
          refetchBots();
        }}
      />
    </div>
  );
}