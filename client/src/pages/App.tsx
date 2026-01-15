import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'wouter';
import { useWallet } from '@/hooks/useWallet';
import { useBots, useSubscriptions, usePortfolio, usePositions, useTrades, useLeaderboard, useSubscribeToBot, useUpdateSubscription, usePrices, useTradingBots, useHealthMetrics, useBotHealth, useReconcilePositions, useMarketplace, useMyMarketplaceSubscriptions, useMyPublishedBots, useUnpublishBot, type HealthMetrics, type PublishedBot } from '@/hooks/useApi';
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
  ChevronDown,
  PanelLeftClose,
  PanelLeft,
  Loader2,
  ArrowUpFromLine,
  Trash2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  X,
  Check,
  Share2,
  ChevronUp,
  Fuel
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { BotManagementDrawer } from '@/components/BotManagementDrawer';
import { CreateBotModal } from '@/components/CreateBotModal';
import { TradeHistoryModal } from '@/components/TradeHistoryModal';
import { WalletContent } from '@/pages/WalletManagement';
import { WelcomePopup } from '@/components/WelcomePopup';
import { PublishBotModal } from '@/components/PublishBotModal';
import { SubscribeBotModal } from '@/components/SubscribeBotModal';

interface TradingBot {
  id: string;
  name: string;
  market: string;
  webhookSecret: string;
  webhookUrl?: string;
  isActive: boolean;
  side: string;
  leverage: number;
  totalInvestment: string;
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
import { confirmTransactionWithFallback } from '@/lib/solana-utils';

type NavItem = 'dashboard' | 'bots' | 'marketplace' | 'leaderboard' | 'settings' | 'wallet';
type MarketplaceSortBy = 'pnl7d' | 'pnl30d' | 'pnl90d' | 'pnlAllTime' | 'subscribers';

export default function AppPage() {
  const [, navigate] = useLocation();
  const { connected, connecting, disconnect, shortenedAddress, balance, balanceLoading, publicKeyString, sessionConnected, referralCode: walletReferralCode } = useWallet();
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
  const [expandedPositionBotId, setExpandedPositionBotId] = useState<string | null>(null);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [tradeHistoryOpen, setTradeHistoryOpen] = useState(false);
  const [welcomePopupOpen, setWelcomePopupOpen] = useState(false);
  const [agentPublicKey, setAgentPublicKey] = useState<string | null>(null);
  const welcomeCheckedRef = useRef(false);
  
  // Settings state
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [xUsername, setXUsername] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notifyTradeExecuted, setNotifyTradeExecuted] = useState(true);
  const [notifyTradeFailed, setNotifyTradeFailed] = useState(true);
  const [notifyPositionClosed, setNotifyPositionClosed] = useState(true);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramVerifyCode, setTelegramVerifyCode] = useState<string | null>(null);
  const [dangerZoneExpanded, setDangerZoneExpanded] = useState(false);
  const [closeAllDialogOpen, setCloseAllDialogOpen] = useState(false);
  const [closingAllPositions, setClosingAllPositions] = useState(false);
  const [resetDriftDialogOpen, setResetDriftDialogOpen] = useState(false);
  const [resettingDriftAccount, setResettingDriftAccount] = useState(false);
  const [notificationDropdownOpen, setNotificationDropdownOpen] = useState(false);
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referredBy, setReferredBy] = useState<string | null>(null);
  
  // Marketplace state
  const [marketplaceSearch, setMarketplaceSearch] = useState('');
  const [marketplaceSortBy, setMarketplaceSortBy] = useState<MarketplaceSortBy>('pnlAllTime');
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [botToPublish, setBotToPublish] = useState<{ id: string; name: string; market: string } | null>(null);
  const [subscribeModalOpen, setSubscribeModalOpen] = useState(false);
  const [botToSubscribe, setBotToSubscribe] = useState<PublishedBot | null>(null);
  const [myPublishedBotsExpanded, setMyPublishedBotsExpanded] = useState(true);
  const [unpublishConfirmOpen, setUnpublishConfirmOpen] = useState(false);
  const [botToUnpublish, setBotToUnpublish] = useState<{ id: string; name: string } | null>(null);

  // Fetch data using React Query hooks
  const { data: portfolioData } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: subscriptionsData } = useSubscriptions();
  const { data: tradesData } = useTrades(10);
  const { data: allTradesData } = useTrades();
  const { data: botsData, refetch: refetchBots } = useTradingBots();
  const { data: leaderboardData } = useLeaderboard(100);
  const { data: pricesData } = usePrices();
  const { data: healthMetrics } = useHealthMetrics();
  const { data: expandedBotHealth, isLoading: healthLoading } = useBotHealth(expandedPositionBotId, !!expandedPositionBotId);
  const subscribeBot = useSubscribeToBot();
  const updateSub = useUpdateSubscription();
  const reconcilePositions = useReconcilePositions();
  
  // Marketplace data
  const { data: marketplaceData, isLoading: marketplaceLoading } = useMarketplace({
    search: marketplaceSearch || undefined,
    sortBy: marketplaceSortBy,
  });
  const { data: mySubscriptions } = useMyMarketplaceSubscriptions();
  const { data: myPublishedBots, refetch: refetchMyPublishedBots } = useMyPublishedBots();
  const unpublishBotMutation = useUnpublishBot();

  const [totalEquity, setTotalEquity] = useState<number | null>(null);
  const [driftBalance, setDriftBalance] = useState<number | null>(null);
  const [agentBalance, setAgentBalance] = useState<number | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [equityLoading, setEquityLoading] = useState(false);
  const equityInitialLoadDone = useRef(false);

  // Fetch total equity, agent balance, and drift balance together
  useEffect(() => {
    if (!connected) {
      setTotalEquity(null);
      setAgentBalance(null);
      setDriftBalance(null);
      setSolBalance(null);
      equityInitialLoadDone.current = false;
      return;
    }
    
    const fetchEquityData = async () => {
      if (!equityInitialLoadDone.current) {
        setEquityLoading(true);
      }
      try {
        const res = await fetch('/api/total-equity', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setTotalEquity(data.totalEquity ?? 0);
          setAgentBalance(data.agentBalance ?? 0);
          setDriftBalance(data.driftBalance ?? 0);
          setSolBalance(data.solBalance ?? 0);
          equityInitialLoadDone.current = true;
        }
      } catch (error) {
        // Network error, keep previous values
      } finally {
        setEquityLoading(false);
      }
    };
    
    fetchEquityData();
    const interval = setInterval(fetchEquityData, 30000);
    return () => clearInterval(interval);
  }, [connected, publicKeyString]);

  // Redirect to landing if wallet not connected
  useEffect(() => {
    if (!connecting && !connected) {
      navigate('/');
    }
  }, [connected, connecting, navigate]);

  // Load wallet settings on mount
  useEffect(() => {
    if (!connected) return;
    
    const loadSettings = async () => {
      setSettingsLoading(true);
      try {
        const res = await fetch('/api/wallet/settings', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setDisplayName(data.displayName || '');
          setXUsername(data.xUsername || '');
          setNotificationsEnabled(data.notificationsEnabled ?? false);
          setNotifyTradeExecuted(data.notifyTradeExecuted ?? true);
          setNotifyTradeFailed(data.notifyTradeFailed ?? true);
          setNotifyPositionClosed(data.notifyPositionClosed ?? true);
          setTelegramConnected(data.telegramConnected ?? false);
          setReferralCode(data.referralCode || null);
          setReferredBy(data.referredBy || null);
        }
      } catch (error) {
        console.error('Error loading settings:', error);
      } finally {
        setSettingsLoading(false);
      }
    };
    
    loadSettings();
  }, [connected]);

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      const res = await fetch('/api/wallet/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          displayName,
          xUsername,
        }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save settings');
      }
      
      toast({ title: 'Settings saved', description: 'Your preferences have been updated' });
    } catch (error: any) {
      toast({ 
        title: 'Failed to save settings', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSaveNotificationPrefs = async (updates: {
    notificationsEnabled?: boolean;
    notifyTradeExecuted?: boolean;
    notifyTradeFailed?: boolean;
    notifyPositionClosed?: boolean;
  }) => {
    setSavingNotifications(true);
    try {
      const res = await fetch('/api/wallet/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updates),
      });
      
      if (!res.ok) {
        throw new Error('Failed to save');
      }
      
      // Update local state
      if (updates.notificationsEnabled !== undefined) setNotificationsEnabled(updates.notificationsEnabled);
      if (updates.notifyTradeExecuted !== undefined) setNotifyTradeExecuted(updates.notifyTradeExecuted);
      if (updates.notifyTradeFailed !== undefined) setNotifyTradeFailed(updates.notifyTradeFailed);
      if (updates.notifyPositionClosed !== undefined) setNotifyPositionClosed(updates.notifyPositionClosed);
    } catch (error) {
      toast({ 
        title: 'Failed to save', 
        description: 'Could not update notification preferences',
        variant: 'destructive' 
      });
    } finally {
      setSavingNotifications(false);
    }
  };

  const handleCloseAllPositions = async () => {
    setClosingAllPositions(true);
    try {
      const res = await fetch('/api/close-all-positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to close positions');
      }
      
      const successCount = data.positionsClosed || 0;
      const failCount = data.results?.filter((r: any) => !r.success).length || 0;
      
      if (successCount > 0 && failCount === 0) {
        toast({ 
          title: 'Positions closed', 
          description: `Successfully closed ${successCount} position${successCount > 1 ? 's' : ''}` 
        });
      } else if (successCount > 0 && failCount > 0) {
        toast({ 
          title: 'Partial success', 
          description: `Closed ${successCount} position(s), ${failCount} failed`,
          variant: 'destructive'
        });
      } else if (successCount === 0 && failCount > 0) {
        toast({ 
          title: 'Failed to close positions', 
          description: 'Could not close any positions',
          variant: 'destructive'
        });
      } else {
        toast({ 
          title: 'No positions to close', 
          description: 'No open positions were found' 
        });
      }
      
      setCloseAllDialogOpen(false);
    } catch (error: any) {
      toast({ 
        title: 'Error', 
        description: error.message || 'Failed to close positions',
        variant: 'destructive' 
      });
    } finally {
      setClosingAllPositions(false);
    }
  };

  const handleResetDriftAccount = async () => {
    setResettingDriftAccount(true);
    try {
      const res = await fetch('/api/wallet/reset-drift-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (res.status === 400 || res.status === 500) {
        throw new Error(data.message || data.error || 'Failed to reset Drift account');
      }
      
      if (res.status === 207 || data.partialSuccess) {
        toast({ 
          title: 'Partial Reset', 
          description: data.message || 'Some operations failed. Please try again or check manually.',
          variant: 'destructive'
        });
      } else if (data.success) {
        toast({ 
          title: 'Reset Complete', 
          description: 'Your Drift account has been reset. Funds have been withdrawn to your agent wallet.'
        });
      }
      
      setResetDriftDialogOpen(false);
      refetchBots();
    } catch (error: any) {
      toast({ 
        title: 'Reset Failed', 
        description: error.message || 'Failed to reset Drift account',
        variant: 'destructive' 
      });
    } finally {
      setResettingDriftAccount(false);
    }
  };

  // Check if agent wallet needs SOL for gas and show welcome popup
  // Use sessionConnected (not just connected) to ensure backend session is established first
  useEffect(() => {
    if (!sessionConnected || welcomeCheckedRef.current) return;
    
    const checkAgentSolBalance = async () => {
      try {
        const res = await fetch('/api/agent/balance', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setAgentPublicKey(data.agentPublicKey);
          
          // Show welcome popup if agent has no SOL (can't pay for gas)
          if (data.solBalance === 0 || data.solBalance < 0.01) {
            setWelcomePopupOpen(true);
          }
          welcomeCheckedRef.current = true;
        }
      } catch (error) {
        console.error('Error checking agent balance:', error);
      }
    };
    
    checkAgentSolBalance();
  }, [sessionConnected]);

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
      
      await confirmTransactionWithFallback(connection, {
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
        
        await confirmTransactionWithFallback(connection, {
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
              <img src="/images/QV_Logo_02.png" alt="QuantumVault" className="w-10 h-10 rounded-xl flex-shrink-0" />
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
                    <button 
                      className="p-1.5 hover:bg-muted rounded-lg transition-colors" 
                      data-testid="button-copy-address"
                      onClick={() => {
                        if (publicKeyString) {
                          navigator.clipboard.writeText(publicKeyString);
                          toast({ title: 'Wallet address copied' });
                        }
                      }}
                    >
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="p-2 rounded-lg bg-background/50 text-center">
                    <p className="text-xs text-muted-foreground">Total Equity</p>
                    <p className="text-lg font-semibold font-mono text-primary" data-testid="text-total-equity">
                      {equityLoading ? '...' : totalEquity !== null ? `$${totalEquity.toFixed(2)}` : '$0.00'}
                    </p>
                  </div>
                  <div className="px-3 py-2 space-y-2 border-t border-border/30 mt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Available</span>
                      <span className="font-mono text-primary" data-testid="text-main-account">${agentBalance?.toFixed(2) ?? '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">In Trading</span>
                      <span className="font-mono text-emerald-400" data-testid="text-in-trading">${driftBalance?.toFixed(2) ?? '0.00'}</span>
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
                    <button 
                      className="p-1.5 hover:bg-muted rounded-lg transition-colors"
                      onClick={() => {
                        if (publicKeyString) {
                          navigator.clipboard.writeText(publicKeyString);
                          toast({ title: 'Wallet address copied' });
                        }
                      }}
                    >
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="p-2 rounded-lg bg-background/50 text-center">
                    <p className="text-xs text-muted-foreground">Total Equity</p>
                    <p className="text-lg font-semibold font-mono text-primary" data-testid="text-total-equity-mobile">
                      {equityLoading ? '...' : totalEquity !== null ? `$${totalEquity.toFixed(2)}` : '$0.00'}
                    </p>
                  </div>
                  <div className="px-3 py-2 space-y-2 border-t border-border/30 mt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Available</span>
                      <span className="font-mono text-primary" data-testid="text-main-account-mobile">${agentBalance?.toFixed(2) ?? '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">In Trading</span>
                      <span className="font-mono text-emerald-400" data-testid="text-in-trading-mobile">${driftBalance?.toFixed(2) ?? '0.00'}</span>
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
          </div>
          <div className="flex items-center gap-2">
            <button 
              className="p-2 hover:bg-muted rounded-lg relative" 
              data-testid="button-notifications"
              onClick={() => setNotificationDropdownOpen(true)}
            >
              <Bell className="w-5 h-5 text-muted-foreground" />
              {(solBalance !== null && solBalance < 0.035) ? (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
              ) : !telegramConnected ? (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-amber-500 rounded-full" />
              ) : null}
            </button>
            
            <Sheet open={notificationDropdownOpen} onOpenChange={setNotificationDropdownOpen}>
              <SheetContent side="right" className="w-full sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>Notifications</SheetTitle>
                  <SheetDescription>
                    {telegramConnected 
                      ? 'Your recent trade alerts and notifications' 
                      : 'Connect Telegram to receive trade alerts'}
                  </SheetDescription>
                </SheetHeader>
                
                <div className="mt-6 space-y-6">
                  {solBalance !== null && solBalance < 0.035 && (
                    <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg" data-testid="alert-low-gas">
                      <Fuel className="w-5 h-5 text-red-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-red-400">Low Gas Warning</p>
                        <p className="text-xs text-muted-foreground">
                          Your agent wallet has only {solBalance.toFixed(4)} SOL. You need at least 0.035 SOL to create new bots.
                        </p>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          setNotificationDropdownOpen(false);
                          setActiveNav('wallet');
                        }}
                        data-testid="button-go-to-wallet"
                      >
                        Add SOL
                      </Button>
                    </div>
                  )}
                  {!telegramConnected && (
                    <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                      <Bell className="w-5 h-5 text-amber-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Get push alerts on Telegram</p>
                        <p className="text-xs text-muted-foreground">Connect in Settings to receive instant alerts</p>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          setNotificationDropdownOpen(false);
                          setActiveNav('settings');
                        }}
                        data-testid="button-go-to-settings"
                      >
                        Setup
                      </Button>
                    </div>
                  )}
                  
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recent Activity</h4>
                    {tradesData && tradesData.length > 0 ? (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {tradesData.slice(0, 10).map((trade: any) => (
                          <div 
                            key={trade.id} 
                            className={`p-3 rounded-lg border ${
                              trade.status === 'executed' 
                                ? 'bg-green-500/5 border-green-500/20' 
                                : trade.status === 'failed' 
                                  ? 'bg-red-500/5 border-red-500/20'
                                  : 'bg-muted/30 border-border/50'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                  trade.side === 'LONG' || trade.side === 'BUY' 
                                    ? 'bg-green-500/20 text-green-500' 
                                    : trade.side === 'SHORT' || trade.side === 'SELL'
                                      ? 'bg-red-500/20 text-red-500'
                                      : 'bg-muted text-muted-foreground'
                                }`}>
                                  {trade.side === 'CLOSE' ? 'CLOSE' : trade.side}
                                </span>
                                <span className="text-sm font-medium">{trade.market}</span>
                              </div>
                              <span className={`text-xs ${
                                trade.status === 'executed' ? 'text-green-500' : 
                                trade.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'
                              }`}>
                                {trade.status}
                              </span>
                            </div>
                            <div className="flex items-center justify-between mt-1.5 text-xs text-muted-foreground">
                              <span>{trade.botName}</span>
                              <span>{new Date(trade.executedAt).toLocaleTimeString()}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <Bell className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No activity yet</p>
                        <p className="text-xs mt-1">Trade activity will appear here when your bots execute trades</p>
                      </div>
                    )}
                  </div>
                </div>
              </SheetContent>
            </Sheet>
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
                    <p className="text-xs text-muted-foreground mb-1">Available Balance</p>
                    <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-value">
                      {agentBalance !== null ? `$${agentBalance.toFixed(2)}` : '--'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Agent wallet USDC</p>
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
                      <div className="flex gap-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => {
                            reconcilePositions.mutate(undefined, {
                              onSuccess: () => toast({ title: "Synced", description: "Positions synced with Drift" }),
                              onError: () => toast({ title: "Sync failed", description: "Could not sync positions", variant: "destructive" })
                            });
                          }}
                          disabled={reconcilePositions.isPending}
                          data-testid="button-sync-positions"
                        >
                          <RefreshCw className={`w-4 h-4 mr-1 ${reconcilePositions.isPending ? 'animate-spin' : ''}`} />
                          Sync
                        </Button>
                        <Button variant="outline" size="sm" data-testid="button-view-all-positions">View All</Button>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {positionsData && positionsData.length > 0 ? (
                        positionsData.map((pos: any, i: number) => {
                          const isExpanded = expandedPositionBotId === pos.botId;
                          const health = isExpanded ? expandedBotHealth : null;
                          
                          return (
                            <div 
                              key={i} 
                              className="rounded-xl bg-muted/30 overflow-hidden transition-all"
                              data-testid={`position-card-${i}`}
                            >
                              <div 
                                className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                                onClick={() => setExpandedPositionBotId(isExpanded ? null : pos.botId)}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center">
                                      <TrendingUp className="w-5 h-5 text-primary" />
                                    </div>
                                    <div>
                                      <div className="flex items-center gap-2">
                                        <p className="font-medium">{pos.botName || 'Unknown'}</p>
                                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                          pos.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                        }`}>
                                          {pos.side}
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted-foreground">{pos.market}</p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-6">
                                    <div className="text-right">
                                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Size</p>
                                      <p className="font-mono font-semibold text-foreground">
                                        ${(Math.abs(pos.baseAssetAmount) * Number(pos.entryPrice)).toFixed(2)}
                                      </p>
                                      <p className="text-[10px] text-muted-foreground">
                                        {Math.abs(pos.baseAssetAmount).toFixed(4)} @ ${Number(pos.entryPrice).toFixed(2)}
                                      </p>
                                    </div>
                                    <div className="text-right border-l border-border/30 pl-4">
                                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">PnL</p>
                                      <p className={`font-mono font-semibold ${Number(pos.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {Number(pos.unrealizedPnl) >= 0 ? '+' : ''}${Number(pos.unrealizedPnl).toFixed(2)}
                                      </p>
                                    </div>
                                    <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                  </div>
                                </div>
                              </div>
                              
                              <AnimatePresence>
                                {isExpanded && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                  >
                                    <div className="px-4 pb-4 pt-2 border-t border-border/30">
                                      {healthLoading ? (
                                        <div className="flex items-center justify-center py-4">
                                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                          <span className="ml-2 text-sm text-muted-foreground">Loading health data...</span>
                                        </div>
                                      ) : health ? (
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                          <div>
                                            <p className="text-xs text-muted-foreground">Health Factor</p>
                                            <p className={`text-lg font-mono font-semibold ${
                                              health.healthFactor >= 50 ? 'text-emerald-400' :
                                              health.healthFactor >= 20 ? 'text-amber-400' : 'text-red-400'
                                            }`}>
                                              {health.healthFactor.toFixed(0)}%
                                            </p>
                                          </div>
                                          <div>
                                            <p className="text-xs text-muted-foreground">Total Collateral</p>
                                            <p className="text-lg font-mono font-semibold">${health.totalCollateral.toFixed(2)}</p>
                                          </div>
                                          <div>
                                            <p className="text-xs text-muted-foreground">Free Collateral</p>
                                            <p className="text-lg font-mono font-semibold text-muted-foreground">${health.freeCollateral.toFixed(2)}</p>
                                          </div>
                                          <div>
                                            <p className="text-xs text-muted-foreground">Liquidation Price</p>
                                            <p className="text-lg font-mono font-semibold text-amber-400">
                                              {health.positions?.[0]?.liquidationPrice 
                                                ? `$${health.positions[0].liquidationPrice.toFixed(2)}` 
                                                : '--'}
                                            </p>
                                          </div>
                                        </div>
                                      ) : (
                                        <p className="text-sm text-muted-foreground text-center py-2">Unable to load health data</p>
                                      )}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })
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
                        botsData.map((bot: TradingBot) => (
                          <div 
                            key={bot.id} 
                            className="p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer" 
                            data-testid={`bot-item-${bot.id}`}
                            onClick={() => {
                              setSelectedManagedBot(bot);
                              setManageBotDrawerOpen(true);
                            }}
                          >
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
                              <span className={`w-2 h-2 rounded-full ${bot.isActive ? 'bg-emerald-400' : 'bg-yellow-400'}`} />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">{(bot as any).actualTradeCount ?? (bot.stats as any)?.totalTrades ?? 0} trades</span>
                              <span className={((bot as any).netPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {((bot as any).netPnl ?? 0) >= 0 ? '+' : ''}${((bot as any).netPnl ?? 0).toFixed(2)}
                                {((bot as any).netDeposited ?? 0) > 0 && (
                                  <span className="ml-1">
                                    ({((bot as any).netPnlPercent ?? 0).toFixed(1)}%)
                                  </span>
                                )}
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
                    <Button variant="outline" size="sm" data-testid="button-trade-history" onClick={() => setTradeHistoryOpen(true)}>Full History</Button>
                  </div>
                  <div className="overflow-x-auto">
                    {tradesData && tradesData.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground text-xs border-b border-border/50">
                            <th className="text-left py-3 font-medium">Time</th>
                            <th className="text-left py-3 font-medium">Bot</th>
                            <th className="text-left py-3 font-medium">Market</th>
                            <th className="text-left py-3 font-medium">Side</th>
                            <th className="text-right py-3 font-medium">Size</th>
                            <th className="text-right py-3 font-medium">Price</th>
                            <th className="text-right py-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tradesData.slice(0, 10).map((trade: any, i: number) => {
                            const payload = trade.webhookPayload;
                            const positionSize = payload?.position_size || payload?.data?.position_size;
                            const isCloseSignal = positionSize === '0' || positionSize === 0 || trade.side === 'CLOSE';
                            const isLong = trade.side?.toUpperCase() === 'LONG';
                            const isShort = trade.side?.toUpperCase() === 'SHORT';
                            const isFailed = trade.status === 'failed';
                            const isExecuted = trade.status === 'executed';
                            
                            const getSideColor = () => {
                              if (isCloseSignal) return 'text-amber-400';
                              if (isLong) return 'text-emerald-400';
                              return 'text-red-400';
                            };
                            
                            const getSideIcon = () => {
                              if (isCloseSignal) return <XCircle className="w-3 h-3" />;
                              if (isLong) return <ArrowUpRight className="w-3 h-3" />;
                              return <ArrowDownRight className="w-3 h-3" />;
                            };
                            
                            const getSideLabel = () => {
                              if (isCloseSignal) return 'CLOSE';
                              return trade.side?.toUpperCase();
                            };
                            
                            const getStatusStyle = () => {
                              if (isFailed) return 'bg-red-500/20 text-red-400';
                              if (isExecuted) return 'bg-emerald-500/20 text-emerald-400';
                              return 'bg-yellow-500/20 text-yellow-400';
                            };
                            
                            const getErrorExplanation = (error: string | null | undefined): string | null => {
                              if (!error) return null;
                              const e = error.toLowerCase();
                              if (e.includes('market status') || e.includes('doesnt allow placing orders')) {
                                return 'Market temporarily paused';
                              }
                              if (e.includes('insufficientcollateral') || e.includes('insufficient collateral')) {
                                return 'Not enough margin';
                              }
                              if (e.includes('max leverage') || e.includes('exceeds leverage')) {
                                return 'Exceeds leverage limit';
                              }
                              if (e.includes('oracle') || e.includes('stale oracle')) {
                                return 'Price feed issue';
                              }
                              if (e.includes('reduce only')) {
                                return 'Reduce-only mode';
                              }
                              if (e.includes('user not found') || e.includes('no user account')) {
                                return 'Account not initialized';
                              }
                              return error.length > 30 ? error.substring(0, 30) + '...' : error;
                            };
                            
                            return (
                              <tr key={i} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-trade-${i}`}>
                                <td className="py-3 font-mono text-muted-foreground text-xs">
                                  {trade.executedAt ? new Date(trade.executedAt).toLocaleTimeString() : '--'}
                                </td>
                                <td className="py-3 text-xs text-muted-foreground max-w-[100px] truncate" title={trade.botName || 'Unknown'}>
                                  {trade.botName || 'Unknown'}
                                </td>
                                <td className="py-3 font-medium">{trade.market}</td>
                                <td className="py-3">
                                  <span className={`flex items-center gap-1 ${getSideColor()}`}>
                                    {getSideIcon()}
                                    {getSideLabel()}
                                  </span>
                                </td>
                                <td className="py-3 text-right font-mono">{trade.size}</td>
                                <td className="py-3 text-right font-mono">${Number(trade.price).toLocaleString()}</td>
                                <td className="py-3 text-right">
                                  {isFailed && trade.errorMessage ? (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className={`px-2 py-0.5 rounded text-xs cursor-help ${getStatusStyle()}`}>
                                            {trade.status}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent side="left" className="max-w-[250px] bg-popover border border-border">
                                          <p className="text-sm font-medium text-red-400 mb-1">Trade Failed</p>
                                          <p className="text-xs">{getErrorExplanation(trade.errorMessage)}</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  ) : (
                                    <span className={`px-2 py-0.5 rounded text-xs ${getStatusStyle()}`}>
                                      {trade.status}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
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
                    onClick={() => setCreateBotOpen(true)}
                    data-testid="button-create-bot"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Bot
                  </Button>
                </div>

                {botsData && botsData.length > 0 ? (
                  <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
                    {botsData.map((bot: TradingBot) => {
                      const position = positionsData?.find((p: any) => p.botId === bot.id);
                      const hasPosition = position && Math.abs(position.baseAssetAmount) > 0.0001;
                      const unrealizedPnl = position?.unrealizedPnl ?? 0;
                      
                      return (
                        <div 
                          key={bot.id} 
                          className="gradient-border p-5 noise hover:scale-[1.01] transition-transform cursor-pointer"
                          data-testid={`bot-card-${bot.id}`}
                          onClick={() => {
                            setSelectedManagedBot(bot);
                            setManageBotDrawerOpen(true);
                          }}
                        >
                          <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                                bot.isActive 
                                  ? 'bg-gradient-to-br from-primary to-accent' 
                                  : 'bg-gradient-to-br from-primary/30 to-accent/30'
                              }`}>
                                <Bot className={`w-6 h-6 ${bot.isActive ? 'text-white' : 'text-primary'}`} />
                              </div>
                              <div>
                                <h3 className="font-semibold text-base">{bot.name}</h3>
                                <p className="text-sm text-muted-foreground">{bot.market}</p>
                              </div>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                              bot.isActive 
                                ? 'bg-emerald-500/20 text-emerald-400' 
                                : 'bg-yellow-500/20 text-yellow-400'
                            }`}>
                              {bot.isActive ? 'Active' : 'Paused'}
                            </span>
                          </div>

                          {hasPosition && (
                            <div className={`mb-4 px-3 py-2.5 rounded-lg flex items-center justify-between ${
                              position.side === 'LONG' ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'
                            }`}>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                                  position.side === 'LONG' 
                                    ? 'bg-emerald-500/20 text-emerald-400' 
                                    : 'bg-red-500/20 text-red-400'
                                }`}>
                                  {position.side}
                                </span>
                                <span className="text-sm font-medium">
                                  {Math.abs(position.baseAssetAmount).toFixed(4)} {bot.market.replace('-PERP', '')}
                                </span>
                              </div>
                              <span className={`text-sm font-semibold ${
                                unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                              }`}>
                                {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)}
                              </span>
                            </div>
                          )}

                          <div className="grid grid-cols-3 gap-3 text-center">
                            <div className="p-2.5 rounded-lg bg-muted/30">
                              <p className="text-lg font-bold">{(bot as any).actualTradeCount ?? (bot.stats as any)?.totalTrades ?? 0}</p>
                              <p className="text-xs text-muted-foreground">Trades</p>
                            </div>
                            <div className="p-2.5 rounded-lg bg-muted/30">
                              <p className="text-lg font-bold">{bot.leverage}x</p>
                              <p className="text-xs text-muted-foreground">Leverage</p>
                            </div>
                            <div className="p-2.5 rounded-lg bg-muted/30">
                              <p className={`text-lg font-bold ${((bot as any).netPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {((bot as any).netPnl ?? 0) >= 0 ? '+' : ''}${((bot as any).netPnl ?? 0).toFixed(2)}
                              </p>
                              {((bot as any).netDeposited ?? 0) > 0 && (
                                <p className={`text-xs font-medium ${((bot as any).netPnlPercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {((bot as any).netPnlPercent ?? 0) >= 0 ? '+' : ''}{((bot as any).netPnlPercent ?? 0).toFixed(1)}%
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">Net P&L</p>
                            </div>
                          </div>

                          {!(bot as any).isPublished && (bot as any).botType !== 'grid' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full mt-4 border-primary/30 text-primary hover:bg-primary/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                setBotToPublish({ id: bot.id, name: bot.name, market: bot.market });
                                setPublishModalOpen(true);
                              }}
                              data-testid={`button-publish-${bot.id}`}
                            >
                              <Store className="w-4 h-4 mr-2" />
                              Publish to Marketplace
                            </Button>
                          )}
                          {(bot as any).isPublished && (
                            <div className="mt-4 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center gap-2 text-sm text-primary">
                              <Store className="w-4 h-4" />
                              Published
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="gradient-border p-12 noise text-center">
                    <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <h3 className="text-lg font-display font-semibold mb-2">No Bots Yet</h3>
                    <p className="text-muted-foreground mb-6">Create your first TradingView bot to start automated trading</p>
                    <Button 
                      className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
                      onClick={() => setCreateBotOpen(true)}
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
                </div>

                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input 
                      placeholder="Search bots by name, market, or creator..." 
                      className="pl-12 py-6 bg-card border-border/50 text-lg"
                      value={marketplaceSearch}
                      onChange={(e) => setMarketplaceSearch(e.target.value)}
                      data-testid="input-search-bots"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <span className="text-sm text-muted-foreground py-2 pr-2">Sort by:</span>
                  {[
                    { key: 'pnl7d', label: '7D PnL' },
                    { key: 'pnl30d', label: '30D PnL' },
                    { key: 'pnl90d', label: '90D PnL' },
                    { key: 'pnlAllTime', label: 'All Time' },
                    { key: 'subscribers', label: 'Subscribers' },
                  ].map((sortOption) => (
                    <Button
                      key={sortOption.key}
                      variant={marketplaceSortBy === sortOption.key ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setMarketplaceSortBy(sortOption.key as MarketplaceSortBy)}
                      className={marketplaceSortBy === sortOption.key ? 'bg-primary' : ''}
                      data-testid={`button-sort-${sortOption.key}`}
                    >
                      {sortOption.label}
                    </Button>
                  ))}
                </div>

                {myPublishedBots && myPublishedBots.length > 0 && (
                  <div className="gradient-border p-6 noise">
                    <div 
                      className="flex items-center justify-between cursor-pointer"
                      onClick={() => setMyPublishedBotsExpanded(!myPublishedBotsExpanded)}
                      data-testid="toggle-my-published-bots"
                    >
                      <div className="flex items-center gap-3">
                        <Store className="w-5 h-5 text-primary" />
                        <h2 className="font-display font-semibold">My Published Bots</h2>
                        <span className="text-sm text-muted-foreground">({myPublishedBots.length})</span>
                      </div>
                      {myPublishedBotsExpanded ? (
                        <ChevronUp className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    
                    {myPublishedBotsExpanded && (
                      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                        {myPublishedBots.map((bot: PublishedBot) => {
                          const pnlValue = bot.pnlPercentAllTime ? parseFloat(bot.pnlPercentAllTime) : null;
                          const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
                          const shareUrl = `${baseUrl}/app?bot=${bot.id}&ref=${walletReferralCode || ''}`;
                          
                          return (
                            <div 
                              key={bot.id} 
                              className={`p-5 rounded-xl border transition-all ${
                                bot.isActive 
                                  ? 'bg-gradient-to-br from-primary/10 to-accent/5 border-primary/30' 
                                  : 'bg-muted/30 border-muted-foreground/20 opacity-75'
                              }`}
                              data-testid={`my-published-bot-${bot.id}`}
                            >
                              <div className="flex items-start justify-between mb-3">
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                                    bot.isActive 
                                      ? 'bg-gradient-to-br from-primary to-accent' 
                                      : 'bg-muted-foreground/30'
                                  }`}>
                                    <Bot className="w-5 h-5 text-white" />
                                  </div>
                                  <div>
                                    <h3 className="font-semibold text-sm">{bot.name}</h3>
                                    <p className="text-xs text-muted-foreground">{bot.market}</p>
                                  </div>
                                </div>
                                {!bot.isActive && (
                                  <span className="px-2 py-0.5 rounded text-xs bg-muted-foreground/20 text-muted-foreground">
                                    Inactive
                                  </span>
                                )}
                              </div>

                              <div className="grid grid-cols-2 gap-2 mb-3">
                                <div className="text-center p-2 rounded-lg bg-muted/30">
                                  {pnlValue !== null ? (
                                    <p className={`text-sm font-bold ${pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                      {pnlValue >= 0 ? '+' : ''}{pnlValue.toFixed(1)}%
                                    </p>
                                  ) : (
                                    <p className="text-sm font-bold text-muted-foreground">--</p>
                                  )}
                                  <p className="text-xs text-muted-foreground">All Time</p>
                                </div>
                                <div className="text-center p-2 rounded-lg bg-muted/30">
                                  <p className="text-sm font-bold">{bot.subscriberCount}</p>
                                  <p className="text-xs text-muted-foreground">Subscribers</p>
                                </div>
                              </div>

                              <div className="flex gap-2">
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          navigator.clipboard.writeText(shareUrl);
                                          toast({
                                            title: "Link copied!",
                                            description: "Share URL copied to clipboard",
                                          });
                                        }}
                                        data-testid={`button-copy-url-${bot.id}`}
                                      >
                                        <Copy className="w-4 h-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Copy Share URL</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>

                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const tweetText = encodeURIComponent(`Check out my trading bot "${bot.name}" on QuantumVault! 🤖📈`);
                                          const tweetUrl = encodeURIComponent(shareUrl);
                                          window.open(`https://twitter.com/intent/tweet?text=${tweetText}&url=${tweetUrl}`, '_blank');
                                        }}
                                        data-testid={`button-share-x-${bot.id}`}
                                      >
                                        <Share2 className="w-4 h-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Share to X</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>

                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 hover:border-red-500/30"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setBotToUnpublish({ id: bot.id, name: bot.name });
                                          setUnpublishConfirmOpen(true);
                                        }}
                                        data-testid={`button-unpublish-${bot.id}`}
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Unpublish Bot</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {marketplaceData && marketplaceData.filter((b: PublishedBot) => b.isFeatured).length > 0 && (
                  <div className="gradient-border p-6 noise">
                    <div className="flex items-center gap-3 mb-4">
                      <Zap className="w-5 h-5 text-primary" />
                      <h2 className="font-display font-semibold">Featured Bots</h2>
                    </div>
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                      {marketplaceData.filter((b: PublishedBot) => b.isFeatured).map((bot: PublishedBot) => {
                        const pnl = marketplaceSortBy === 'pnl7d' ? bot.pnlPercent7d :
                                   marketplaceSortBy === 'pnl30d' ? bot.pnlPercent30d :
                                   marketplaceSortBy === 'pnl90d' ? bot.pnlPercent90d :
                                   bot.pnlPercentAllTime;
                        const pnlValue = pnl ? parseFloat(pnl) : null;
                        return (
                          <div 
                            key={bot.id} 
                            className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/5 border border-primary/20 hover:border-primary/40 transition-all cursor-pointer group"
                            onClick={() => {
                              setBotToSubscribe(bot);
                              setSubscribeModalOpen(true);
                            }}
                            data-testid={`featured-bot-${bot.id}`}
                          >
                            <div className="flex items-center gap-3 mb-3">
                              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                                <Bot className="w-5 h-5 text-white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-sm truncate">{bot.name}</h3>
                                <p className="text-xs text-muted-foreground">{bot.market}</p>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              {pnlValue !== null ? (
                                <span className={`font-bold ${pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pnlValue >= 0 ? '+' : ''}{pnlValue.toFixed(2)}%
                                </span>
                              ) : (
                                <span className="text-muted-foreground">--</span>
                              )}
                              <span className="text-muted-foreground text-xs">{bot.subscriberCount} users</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {marketplaceLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    <span className="ml-2 text-muted-foreground">Loading marketplace...</span>
                  </div>
                ) : marketplaceData && marketplaceData.length > 0 ? (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {marketplaceData.map((bot: PublishedBot) => {
                      const winRate = bot.totalTrades > 0 ? ((bot.winningTrades / bot.totalTrades) * 100).toFixed(1) : '0';
                      const pnl = marketplaceSortBy === 'pnl7d' ? bot.pnlPercent7d :
                                 marketplaceSortBy === 'pnl30d' ? bot.pnlPercent30d :
                                 marketplaceSortBy === 'pnl90d' ? bot.pnlPercent90d :
                                 bot.pnlPercentAllTime;
                      const pnlValue = pnl ? parseFloat(pnl) : null;
                      const totalCapital = parseFloat(bot.totalCapitalInvested || '0');
                      const isSubscribed = mySubscriptions?.some((sub) => sub.publishedBotId === bot.id);
                      
                      return (
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
                                <p className="text-sm text-muted-foreground">{bot.market}</p>
                              </div>
                            </div>
                            {bot.isFeatured && (
                              <span className="px-2 py-1 rounded-full text-xs font-medium bg-primary/20 text-primary flex items-center gap-1">
                                <Star className="w-3 h-3" /> Featured
                              </span>
                            )}
                          </div>

                          <div className="grid grid-cols-3 gap-3 mb-4">
                            <div className="text-center p-2 rounded-lg bg-muted/30">
                              {pnlValue !== null ? (
                                <p className={`text-lg font-bold ${pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pnlValue >= 0 ? '+' : ''}{pnlValue.toFixed(1)}%
                                </p>
                              ) : (
                                <p className="text-lg font-bold text-muted-foreground">--</p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {marketplaceSortBy === 'pnl7d' ? '7D' : 
                                 marketplaceSortBy === 'pnl30d' ? '30D' : 
                                 marketplaceSortBy === 'pnl90d' ? '90D' : 'All Time'}
                              </p>
                            </div>
                            <div className="text-center p-2 rounded-lg bg-muted/30">
                              <p className="text-lg font-bold">{winRate}%</p>
                              <p className="text-xs text-muted-foreground">Win Rate</p>
                            </div>
                            <div className="text-center p-2 rounded-lg bg-muted/30">
                              <p className="text-lg font-bold">{bot.subscriberCount}</p>
                              <p className="text-xs text-muted-foreground">Subscribers</p>
                            </div>
                          </div>

                          <div className="flex items-center justify-between text-sm text-muted-foreground mb-4">
                            <span className="flex items-center gap-1">
                              {bot.creator.displayName || 'Anonymous'}
                              {bot.creator.xUsername && (
                                <a
                                  href={`https://x.com/${bot.creator.xUsername}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  @{bot.creator.xUsername}
                                </a>
                              )}
                            </span>
                            <span>${totalCapital.toLocaleString()} TVL</span>
                          </div>

                          <div className="flex gap-2">
                            {isSubscribed ? (
                              <Button 
                                variant="outline"
                                className="flex-1"
                                disabled
                                data-testid={`button-subscribed-${bot.id}`}
                              >
                                <Check className="w-4 h-4 mr-2" />
                                Subscribed
                              </Button>
                            ) : (
                              <Button 
                                className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90"
                                onClick={() => {
                                  setBotToSubscribe(bot);
                                  setSubscribeModalOpen(true);
                                }}
                                data-testid={`button-subscribe-${bot.id}`}
                              >
                                Subscribe
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="gradient-border p-12 noise text-center">
                    <Store className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <h3 className="text-lg font-display font-semibold mb-2">No Bots Published Yet</h3>
                    <p className="text-muted-foreground mb-6">Be the first to publish your trading strategy!</p>
                    <Button 
                      className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
                      onClick={() => setActiveNav('bots')}
                      data-testid="button-go-to-bots"
                    >
                      Go to My Bots
                    </Button>
                  </div>
                )}

                <div className="gradient-border p-6 noise">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                      <Shield className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-display font-semibold">Publish Your Own Bot</h3>
                      <p className="text-sm text-muted-foreground">Share your strategy and attract subscribers</p>
                    </div>
                    <Button 
                      className="bg-gradient-to-r from-primary to-accent"
                      onClick={() => setActiveNav('bots')}
                      data-testid="button-create-strategy"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      My Bots
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
                  {!leaderboardData ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <span className="ml-2 text-muted-foreground">Loading leaderboard...</span>
                    </div>
                  ) : leaderboardData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Users className="w-12 h-12 mb-4 opacity-50" />
                      <p>No traders on the leaderboard yet</p>
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/20 text-muted-foreground text-xs">
                          <th className="text-left py-4 px-4 font-medium">Rank</th>
                          <th className="text-left py-4 px-4 font-medium">Trader</th>
                          <th className="text-right py-4 px-4 font-medium">Volume</th>
                          <th className="text-right py-4 px-4 font-medium">PnL</th>
                          <th className="text-right py-4 px-4 font-medium">Win Rate</th>
                          <th className="text-right py-4 px-4 font-medium">Trades</th>
                          <th className="text-center py-4 px-4 font-medium">Profile</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboardData.map((trader: { walletAddress: string; displayName: string | null; xUsername: string | null; totalVolume: number; totalPnl: number; winRate: number; tradeCount: number }, index: number) => {
                          const rank = index + 1;
                          const shortenedWallet = `${trader.walletAddress.slice(0, 4)}...${trader.walletAddress.slice(-4)}`;
                          const displayName = trader.displayName || shortenedWallet;
                          const formatVolume = (v: number) => {
                            if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
                            if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
                            return v.toFixed(0);
                          };
                          const pnlFormatted = trader.totalPnl >= 0 ? `+$${trader.totalPnl.toFixed(2)}` : `-$${Math.abs(trader.totalPnl).toFixed(2)}`;
                          return (
                            <tr key={trader.walletAddress} className="border-t border-border/30 hover:bg-muted/20" data-testid={`row-leaderboard-${rank}`}>
                              <td className="py-4 px-4">
                                <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold ${
                                  rank === 1 ? 'bg-yellow-500/20 text-yellow-400' :
                                  rank === 2 ? 'bg-gray-400/20 text-gray-400' :
                                  rank === 3 ? 'bg-orange-500/20 text-orange-400' :
                                  'bg-muted/30 text-muted-foreground'
                                }`}>
                                  {rank}
                                </span>
                              </td>
                              <td className="py-4 px-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center text-xs font-bold">
                                    {displayName.charAt(0).toUpperCase()}
                                  </div>
                                  <span className="font-medium">{displayName}</span>
                                </div>
                              </td>
                              <td className="py-4 px-4 text-right font-mono">${formatVolume(trader.totalVolume)}</td>
                              <td className={`py-4 px-4 text-right font-mono ${trader.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnlFormatted}</td>
                              <td className="py-4 px-4 text-right font-mono">{trader.winRate.toFixed(1)}%</td>
                              <td className="py-4 px-4 text-right font-mono text-muted-foreground">{trader.tradeCount}</td>
                              <td className="py-4 px-4 text-center">
                                {trader.xUsername ? (
                                  <a
                                    href={`https://x.com/${trader.xUsername}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-muted/30 hover:bg-primary/20 transition-colors"
                                    data-testid={`link-x-profile-${rank}`}
                                    title={`@${trader.xUsername}`}
                                  >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                                    </svg>
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground/30">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
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

                {settingsLoading ? (
                  <div className="gradient-border p-6 noise flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    <span className="ml-2 text-muted-foreground">Loading settings...</span>
                  </div>
                ) : (
                  <div className="gradient-border p-6 noise space-y-6">
                    <div>
                      <h3 className="font-display font-semibold mb-4">Profile</h3>
                      <div className="space-y-4">
                        <div>
                          <label className="text-sm text-muted-foreground mb-1.5 block">Username</label>
                          <Input 
                            value={displayName} 
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="Enter your display name"
                            className="bg-muted/30 border-border/50" 
                            data-testid="input-username" 
                          />
                        </div>
                        <div>
                          <label className="text-sm text-muted-foreground mb-1.5 block">X (Twitter) Username</label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">@</span>
                            <Input 
                              value={xUsername} 
                              onChange={(e) => setXUsername(e.target.value.replace(/^@/, ''))}
                              placeholder="username"
                              className="bg-muted/30 border-border/50 pl-8" 
                              data-testid="input-x-username" 
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {agentPublicKey && (
                      <div className="border-t border-border/50 pt-6">
                        <h3 className="font-display font-semibold mb-4">Drift Account</h3>
                        <p className="text-sm text-muted-foreground mb-3">
                          View your on-chain Drift trading account and positions directly.
                        </p>
                        <Button
                          variant="outline"
                          onClick={() => window.open(`https://app.drift.trade/portfolio/accounts?authority=${agentPublicKey}`, '_blank')}
                          className="w-full sm:w-auto"
                          data-testid="button-view-drift-settings"
                        >
                          <ExternalLink className="w-4 h-4 mr-2" />
                          View on Drift
                        </Button>
                        <p className="text-xs text-muted-foreground mt-2 font-mono break-all">
                          Agent: {agentPublicKey}
                        </p>
                      </div>
                    )}

                    {referralCode && (
                      <div className="border-t border-border/50 pt-6">
                        <h3 className="font-display font-semibold mb-4">Referral Program</h3>
                        <p className="text-sm text-muted-foreground mb-3">
                          Share your referral code to invite friends. You'll earn rewards when they sign up and trade!
                        </p>
                        <div className="space-y-3">
                          <div>
                            <label className="text-xs text-muted-foreground mb-1.5 block">Your Referral Code</label>
                            <div className="flex gap-2">
                              <Input
                                value={referralCode}
                                readOnly
                                className="bg-muted/30 border-border/50 font-mono font-bold tracking-wider text-lg"
                                data-testid="input-referral-code"
                              />
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={async () => {
                                  await navigator.clipboard.writeText(referralCode);
                                  toast({ title: 'Referral code copied!' });
                                }}
                                data-testid="button-copy-referral-code"
                              >
                                <Copy className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground mb-1.5 block">Referral Link</label>
                            <div className="flex gap-2">
                              <Input
                                value={`${window.location.origin}/app?ref=${referralCode}`}
                                readOnly
                                className="bg-muted/30 border-border/50 font-mono text-sm"
                                data-testid="input-referral-link"
                              />
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={async () => {
                                  await navigator.clipboard.writeText(`${window.location.origin}/app?ref=${referralCode}`);
                                  toast({ title: 'Referral link copied!' });
                                }}
                                data-testid="button-copy-referral-link"
                              >
                                <Copy className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                          {referredBy && (
                            <p className="text-xs text-muted-foreground">
                              You were referred by: <span className="font-mono">{referredBy.slice(0, 6)}...{referredBy.slice(-4)}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="border-t border-border/50 pt-6">
                      <h3 className="font-display font-semibold mb-4">Notifications</h3>
                      <div className="bg-muted/30 rounded-lg border border-border/50 p-4">
                        <div className="flex items-start gap-3">
                          <div className={`p-2 rounded-full ${telegramConnected ? 'bg-green-500/20' : 'bg-amber-500/20'}`}>
                            <Bell className={`w-5 h-5 ${telegramConnected ? 'text-green-500' : 'text-amber-500'}`} />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <p className="font-medium">Telegram</p>
                              {telegramConnected ? (
                                <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-500 rounded-full">Connected</span>
                              ) : (
                                <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-500 rounded-full">Not Connected</span>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">
                              {telegramConnected 
                                ? 'You will receive trade alerts via Telegram.'
                                : 'Connect Telegram to receive instant trade alerts when your bots execute trades.'}
                            </p>
                            {!telegramConnected && (
                              <div className="mt-3 space-y-3">
                                <div className="flex gap-2 flex-wrap">
                                  <Button
                                    variant="outline"
                                    onClick={async () => {
                                      console.log('[Telegram] Connect button clicked');
                                      try {
                                        console.log('[Telegram] Calling /api/telegram/connect...');
                                        const res = await fetch('/api/telegram/connect', { 
                                          method: 'POST',
                                          credentials: 'include' 
                                        });
                                        console.log('[Telegram] Response status:', res.status);
                                        const data = await res.json();
                                        console.log('[Telegram] Response data:', data);
                                        
                                        if (res.ok && data.verificationLink) {
                                          window.open(data.verificationLink, '_blank');
                                          if (data.verificationCode) {
                                            setTelegramVerifyCode(`/start ${data.verificationCode}`);
                                            toast({
                                              title: "Telegram opened",
                                              description: "Copy the command below and paste it in the bot chat.",
                                            });
                                          } else {
                                            toast({
                                              title: "Step 1: Open Telegram",
                                              description: "Click /start in the bot, then come back and click 'Verify Connection'.",
                                            });
                                          }
                                        } else {
                                          toast({
                                            title: "Setup Not Available",
                                            description: data.message || "Telegram notifications are not yet configured.",
                                            variant: "destructive",
                                          });
                                        }
                                      } catch (error) {
                                        toast({
                                          title: "Error",
                                          description: "Failed to start Telegram connection",
                                          variant: "destructive",
                                        });
                                      }
                                    }}
                                    data-testid="button-connect-telegram"
                                  >
                                    <ExternalLink className="w-4 h-4 mr-2" />
                                    1. Connect Telegram
                                  </Button>
                                  <Button
                                    variant="default"
                                    onClick={async () => {
                                      console.log('[Telegram] Verify button clicked');
                                      try {
                                        const res = await fetch('/api/telegram/verify', { 
                                          method: 'POST',
                                          credentials: 'include' 
                                        });
                                        const data = await res.json();
                                        console.log('[Telegram] Verify response:', data);
                                        
                                        if (data.success && data.verified) {
                                          setTelegramConnected(true);
                                          toast({
                                            title: "Telegram Connected!",
                                            description: "You'll now receive trade alerts via Telegram.",
                                          });
                                        } else {
                                          toast({
                                            title: "Not Verified Yet",
                                            description: data.message || "Please complete the Telegram bot setup first.",
                                            variant: "destructive",
                                          });
                                        }
                                      } catch (error) {
                                        toast({
                                          title: "Error",
                                          description: "Failed to verify Telegram connection",
                                          variant: "destructive",
                                        });
                                      }
                                    }}
                                    data-testid="button-verify-telegram"
                                  >
                                    <Check className="w-4 h-4 mr-2" />
                                    2. Verify Connection
                                  </Button>
                                </div>
                                {telegramVerifyCode && (
                                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                                    <p className="text-xs text-amber-400 mb-2 font-medium">
                                      Paste this command in @DialectLabsBot:
                                    </p>
                                    <div className="flex items-center gap-2">
                                      <code className="flex-1 bg-background/50 px-3 py-2 rounded text-xs font-mono break-all select-all">
                                        {telegramVerifyCode}
                                      </code>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          navigator.clipboard.writeText(telegramVerifyCode);
                                          toast({
                                            title: "Copied!",
                                            description: "Paste this in the Dialect bot chat.",
                                          });
                                        }}
                                        data-testid="button-copy-telegram-code"
                                      >
                                        <Copy className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  </div>
                                )}
                                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-xs text-blue-300">
                                  <p className="font-medium mb-1">Already use Dialect with Drift?</p>
                                  <p>If your Telegram is linked to another wallet, message @DialectLabsBot with <code className="bg-background/50 px-1 rounded">/unlink</code> first, then reconnect here.</p>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Once connected, you'll receive:
                                </p>
                                <ul className="text-xs text-muted-foreground space-y-1 ml-4 list-disc">
                                  <li>Instant alerts when trades execute</li>
                                  <li>Notifications on trade failures</li>
                                  <li>Position close summaries with PnL</li>
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-border/50 pt-6">
                      <Button 
                        onClick={handleSaveSettings} 
                        disabled={settingsSaving}
                        className="w-full sm:w-auto"
                        data-testid="button-save-settings"
                      >
                        {settingsSaving ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          'Save Changes'
                        )}
                      </Button>
                    </div>

                    <div className="border-t border-border/50 pt-6">
                      <button
                        onClick={() => setDangerZoneExpanded(!dangerZoneExpanded)}
                        className="w-full flex items-center justify-between text-left"
                        data-testid="button-toggle-danger-zone"
                      >
                        <h3 className="font-display font-semibold text-red-400">Danger Zone</h3>
                        <ChevronDown className={`w-4 h-4 text-red-400 transition-transform ${dangerZoneExpanded ? 'rotate-180' : ''}`} />
                      </button>
                      {dangerZoneExpanded && (
                        <div className="space-y-4 mt-4">
                          <div>
                            <p className="text-sm text-muted-foreground mb-2">
                              Close all open positions across all your trading bots.
                            </p>
                            <Button 
                              variant="outline" 
                              className="border-red-500/50 text-red-400 hover:bg-red-500/10" 
                              onClick={() => setCloseAllDialogOpen(true)}
                              data-testid="button-close-positions"
                            >
                              <XCircle className="w-4 h-4 mr-2" />
                              Close All Positions
                            </Button>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground mb-2">
                              Close all positions, withdraw all funds, and delete your Drift account.
                            </p>
                            <Button 
                              variant="outline" 
                              className="border-red-500/50 text-red-400 hover:bg-red-500/10" 
                              onClick={() => setResetDriftDialogOpen(true)}
                              data-testid="button-reset-drift"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Reset Drift Account
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {activeNav === 'wallet' && (
              <WalletContent />
            )}
          </AnimatePresence>
        </main>
      </div>

      {closeAllDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            data-testid="modal-close-all-positions"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-lg">Close All Positions</h3>
                <p className="text-sm text-muted-foreground">This action cannot be undone</p>
              </div>
            </div>

            <div className="mb-6">
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-400">Warning</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      This will close all open positions across all your active trading bots at current market prices. 
                      You may experience slippage on large positions.
                    </p>
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to proceed?
              </p>
            </div>

            <div className="flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1" 
                onClick={() => setCloseAllDialogOpen(false)}
                disabled={closingAllPositions}
                data-testid="button-cancel-close-all"
              >
                Cancel
              </Button>
              <Button 
                className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                onClick={handleCloseAllPositions}
                disabled={closingAllPositions}
                data-testid="button-confirm-close-all"
              >
                {closingAllPositions ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Closing...
                  </>
                ) : (
                  'Close All Positions'
                )}
              </Button>
            </div>
          </motion.div>
        </div>
      )}

      {resetDriftDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            data-testid="modal-reset-drift"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-lg">Reset Drift Account</h3>
                <p className="text-sm text-muted-foreground">Close all positions and withdraw funds</p>
              </div>
            </div>

            <div className="mb-6">
              <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <ArrowUpFromLine className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">This will automatically:</p>
                    <ul className="text-sm text-muted-foreground mt-2 list-disc ml-4 space-y-1">
                      <li>Close all open trading positions</li>
                      <li>Withdraw all funds to your agent wallet</li>
                      <li>Delete all Drift subaccounts</li>
                      <li>Recover any rent deposits</li>
                    </ul>
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                This process may take a minute to complete. Your funds will be returned to your agent wallet.
              </p>
            </div>

            <div className="flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1" 
                onClick={() => setResetDriftDialogOpen(false)}
                disabled={resettingDriftAccount}
                data-testid="button-cancel-reset-drift"
              >
                Cancel
              </Button>
              <Button 
                className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                onClick={handleResetDriftAccount}
                disabled={resettingDriftAccount}
                data-testid="button-confirm-reset-drift"
              >
                {resettingDriftAccount ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  'Reset Account'
                )}
              </Button>
            </div>
          </motion.div>
        </div>
      )}

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

      {unpublishConfirmOpen && botToUnpublish && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            data-testid="modal-unpublish-bot"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                <Store className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-lg">Unpublish Bot</h3>
                <p className="text-sm text-muted-foreground">{botToUnpublish.name}</p>
              </div>
            </div>

            <div className="mb-6">
              <p className="text-sm text-muted-foreground">
                Are you sure you want to unpublish this bot from the marketplace? 
                Existing subscribers will no longer receive signals from this bot.
              </p>
            </div>

            <div className="flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1" 
                onClick={() => { setUnpublishConfirmOpen(false); setBotToUnpublish(null); }}
                disabled={unpublishBotMutation.isPending}
                data-testid="button-cancel-unpublish"
              >
                Cancel
              </Button>
              <Button 
                className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                onClick={async () => {
                  try {
                    await unpublishBotMutation.mutateAsync(botToUnpublish.id);
                    toast({
                      title: "Bot unpublished",
                      description: `${botToUnpublish.name} has been removed from the marketplace`,
                    });
                    setUnpublishConfirmOpen(false);
                    setBotToUnpublish(null);
                    refetchMyPublishedBots();
                  } catch (error) {
                    toast({
                      title: "Failed to unpublish",
                      description: error instanceof Error ? error.message : "An error occurred",
                      variant: "destructive",
                    });
                  }
                }}
                disabled={unpublishBotMutation.isPending}
                data-testid="button-confirm-unpublish"
              >
                {unpublishBotMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Unpublishing...
                  </>
                ) : (
                  'Unpublish'
                )}
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
        referralCode={referralCode || walletReferralCode || undefined}
        onBotUpdated={() => {
          refetchBots();
        }}
        onShowWalletTab={() => setActiveNav('wallet')}
      />

      <CreateBotModal
        isOpen={createBotOpen}
        onClose={() => setCreateBotOpen(false)}
        walletAddress={publicKeyString || ''}
        onBotCreated={() => {
          refetchBots();
        }}
      />

      <TradeHistoryModal
        open={tradeHistoryOpen}
        onOpenChange={setTradeHistoryOpen}
        trades={allTradesData || []}
      />

      {agentPublicKey && (
        <WelcomePopup
          isOpen={welcomePopupOpen}
          onClose={() => setWelcomePopupOpen(false)}
          agentPublicKey={agentPublicKey}
          onDepositComplete={async () => {
            try {
              // Check agent balance
              const res = await fetch('/api/agent/balance', { credentials: 'include' });
              if (res.ok) {
                const data = await res.json();
                if (data.solBalance >= 0.01) {
                  setWelcomePopupOpen(false);
                }
              }
              // Refresh settings to get the displayName saved in WelcomePopup
              const settingsRes = await fetch('/api/wallet/settings', { credentials: 'include' });
              if (settingsRes.ok) {
                const settingsData = await settingsRes.json();
                setDisplayName(settingsData.displayName || '');
                setXUsername(settingsData.xUsername || '');
              }
            } catch (error) {
              console.error('Error checking agent balance after deposit:', error);
            }
          }}
        />
      )}

      {botToPublish && (
        <PublishBotModal
          isOpen={publishModalOpen}
          onClose={() => {
            setPublishModalOpen(false);
            setBotToPublish(null);
          }}
          bot={botToPublish}
          onPublished={() => {
            refetchBots();
          }}
        />
      )}

      {botToSubscribe && (
        <SubscribeBotModal
          isOpen={subscribeModalOpen}
          onClose={() => {
            setSubscribeModalOpen(false);
            setBotToSubscribe(null);
          }}
          bot={botToSubscribe}
          onSubscribed={() => {
            refetchBots();
          }}
        />
      )}
    </div>
  );
}