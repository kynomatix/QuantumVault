import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'wouter';
import bs58 from 'bs58';
import { useWallet } from '@/hooks/useWallet';
import { useBots, useSubscriptions, usePortfolio, usePositions, useTrades, useLeaderboard, useSubscribeToBot, useUpdateSubscription, usePrices, useTradingBots, useHealthMetrics, useBotHealth, useReconcilePositions, useMarketplace, useMyMarketplaceSubscriptions, useMyPublishedBots, useUnpublishBot, useUnsubscribeFromBot, usePortfolioPerformance, type HealthMetrics, type PublishedBot, type PortfolioPerformanceData } from '@/hooks/useApi';
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
  Fuel,
  Key,
  Eye,
  EyeOff,
  Clock,
  Sliders,
  User,
  BarChart3,
  BookOpen,
  Info,
  DollarSign
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { BotDetailsModal } from '@/components/BotDetailsModal';
import { useExecutionAuthorization } from '@/hooks/useExecutionAuthorization';
import { AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

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

type NavItem = 'dashboard' | 'bots' | 'portfolio' | 'marketplace' | 'leaderboard' | 'settings' | 'wallet';
type MarketplaceSortBy = 'pnl7d' | 'pnl30d' | 'pnl90d' | 'pnlAllTime' | 'subscribers';

export default function AppPage() {
  const [, navigate] = useLocation();
  const { connected, connecting, disconnect, shortenedAddress, balance, balanceLoading, publicKeyString, sessionConnected, referralCode: walletReferralCode } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const [activeNav, setActiveNav] = useState<NavItem>('dashboard');
  const [walletInitialTab, setWalletInitialTab] = useState<'deposit' | 'withdraw' | 'gas'>('deposit');
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
  const [portfolioChartView, setPortfolioChartView] = useState<'dollar' | 'percent'>('dollar');
  const [welcomePopupOpen, setWelcomePopupOpen] = useState(false);
  const [agentPublicKey, setAgentPublicKey] = useState<string | null>(null);
  const welcomeCheckedRef = useRef(false);
  const prevWalletRef = useRef<string | null>(null);
  const pendingRefreshRef = useRef(false);
  
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
  const [expandedSection, setExpandedSection] = useState<'account' | 'trading' | 'notifications' | 'security' | 'danger' | null>(null);
  const [closeAllDialogOpen, setCloseAllDialogOpen] = useState(false);
  const [closingAllPositions, setClosingAllPositions] = useState(false);
  const [resetDriftDialogOpen, setResetDriftDialogOpen] = useState(false);
  const [resettingDriftAccount, setResettingDriftAccount] = useState(false);
  const [resetStep, setResetStep] = useState<'idle' | 'closing' | 'settling' | 'sweeping' | 'withdrawing' | 'deleting' | 'complete'>('idle');
  const [resetAgentDialogOpen, setResetAgentDialogOpen] = useState(false);
  const [resettingAgentWallet, setResettingAgentWallet] = useState(false);
  const [resetAgentProgress, setResetAgentProgress] = useState<string[]>([]);
  const [notificationDropdownOpen, setNotificationDropdownOpen] = useState(false);
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referredBy, setReferredBy] = useState<string | null>(null);
  const [defaultLeverage, setDefaultLeverage] = useState(3);
  const [slippageBps, setSlippageBps] = useState(50);
  
  // RPC status state
  const [rpcStatus, setRpcStatus] = useState<{
    primary: { name: string; configured: boolean; healthy: boolean; latency: number | null };
    backup: { name: string | null; configured: boolean; healthy: boolean; latency: number | null };
    network: string;
  } | null>(null);
  const [rpcStatusLoading, setRpcStatusLoading] = useState(false);
  
  // Seed phrase backup state
  const [revealMnemonicLoading, setRevealMnemonicLoading] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicExpiresAt, setMnemonicExpiresAt] = useState<Date | null>(null);
  const [mnemonicCountdown, setMnemonicCountdown] = useState<number>(0);
  const [backupConfirmChecked, setBackupConfirmChecked] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
  
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
  const [viewDetailBot, setViewDetailBot] = useState<PublishedBot | null>(null);
  const [sharePopupBot, setSharePopupBot] = useState<{ id: string; tradingBotId: string; name: string; market: string } | null>(null);
  const [copiedField, setCopiedField] = useState<'botId' | 'shareLink' | null>(null);

  // Fetch data using React Query hooks
  const { data: portfolioData } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: subscriptionsData } = useSubscriptions();
  const { data: tradesData, refetch: refetchTrades } = useTrades(10);
  const { data: allTradesData } = useTrades();
  const { data: botsData, refetch: refetchBots } = useTradingBots();
  const { data: leaderboardData } = useLeaderboard(100);
  const { data: pricesData } = usePrices();
  const { data: healthMetrics } = useHealthMetrics();
  const { data: expandedBotHealth, isLoading: healthLoading } = useBotHealth(expandedPositionBotId, !!expandedPositionBotId);
  const subscribeBot = useSubscribeToBot();
  const updateSub = useUpdateSubscription();
  const reconcilePositions = useReconcilePositions();
  const { executionEnabled, executionLoading, enableExecution, revokeExecution } = useExecutionAuthorization();
  
  // Marketplace data
  const { data: marketplaceData, isLoading: marketplaceLoading } = useMarketplace({
    search: marketplaceSearch || undefined,
    sortBy: marketplaceSortBy,
  });
  const { data: mySubscriptions, refetch: refetchMySubscriptions } = useMyMarketplaceSubscriptions();
  const { data: myPublishedBots, refetch: refetchMyPublishedBots } = useMyPublishedBots();
  const unpublishBotMutation = useUnpublishBot();
  const unsubscribeMutation = useUnsubscribeFromBot();
  
  // Portfolio performance data
  const { data: portfolioPerformanceData, isLoading: portfolioPerformanceLoading } = usePortfolioPerformance();

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
          setDefaultLeverage(data.defaultLeverage ?? 3);
          setSlippageBps(data.slippageBps ?? 50);
        }
        
      } catch (error) {
        console.error('Error loading settings:', error);
      } finally {
        setSettingsLoading(false);
      }
    };
    
    loadSettings();
  }, [connected]);

  // Fetch RPC status when trading section is expanded
  useEffect(() => {
    if (expandedSection !== 'trading') return;
    
    const fetchRpcStatus = async () => {
      setRpcStatusLoading(true);
      try {
        const res = await fetch('/api/rpc-status');
        if (res.ok) {
          const data = await res.json();
          setRpcStatus(data);
        }
      } catch (error) {
        console.error('Error fetching RPC status:', error);
      } finally {
        setRpcStatusLoading(false);
      }
    };
    
    fetchRpcStatus();
  }, [expandedSection]);

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
          defaultLeverage,
          slippageBps,
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

  const [refreshing, setRefreshing] = useState(false);
  
  const handleRefreshAll = async () => {
    if (refreshing || !publicKeyString) return;
    
    setRefreshing(true);
    try {
      // Reconnect session with current wallet to handle wallet switches
      const connectRes = await fetch('/api/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: publicKeyString }),
      });
      
      if (!connectRes.ok) {
        console.warn('Session reconnect failed, data may be stale');
      }
      
      // Helper to safely fetch JSON
      const safeFetchJson = async (url: string) => {
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return null;
          const text = await res.text();
          if (!text || text.startsWith('<!')) return null;
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      
      // Refresh all data in parallel
      const refreshPromises = [
        refetchBots().catch(() => null),
        refetchTrades().catch(() => null),
        refetchMySubscriptions?.().catch(() => null),
        refetchMyPublishedBots?.().catch(() => null),
      ].filter(Boolean);
      
      // Refresh equity data
      const equityPromise = safeFetchJson('/api/total-equity')
        .then(data => {
          if (data) {
            setTotalEquity(data.totalEquity ?? 0);
            setAgentBalance(data.agentBalance ?? 0);
            setDriftBalance(data.driftBalance ?? 0);
            setSolBalance(data.solBalance ?? 0);
          }
        });
      
      // Refresh settings
      const settingsPromise = safeFetchJson('/api/wallet/settings')
        .then(data => {
          if (data) {
            setDisplayName(data.displayName || '');
            setXUsername(data.xUsername || '');
            setNotificationsEnabled(data.notificationsEnabled ?? false);
            setNotifyTradeExecuted(data.notifyTradeExecuted ?? true);
            setNotifyTradeFailed(data.notifyTradeFailed ?? true);
            setNotifyPositionClosed(data.notifyPositionClosed ?? true);
            setTelegramConnected(data.telegramConnected ?? false);
            setReferralCode(data.referralCode || null);
            setReferredBy(data.referredBy || null);
            setDefaultLeverage(data.defaultLeverage ?? 3);
            setSlippageBps(data.slippageBps ?? 50);
          }
        });
      
      // Fetch agent public key
      const agentKeyPromise = safeFetchJson('/api/wallet/agent-public-key')
        .then(data => {
          if (data?.agentPublicKey) {
            setAgentPublicKey(data.agentPublicKey);
          }
        });
      
      await Promise.all([...refreshPromises, equityPromise, settingsPromise, agentKeyPromise]);
      
      toast({ title: 'Refreshed', description: 'All data updated' });
    } catch (error) {
      console.error('Refresh error:', error);
      toast({ 
        title: 'Refresh failed', 
        description: 'Some data may not have updated',
        variant: 'destructive' 
      });
    } finally {
      setRefreshing(false);
    }
  };

  // Auto-refresh when wallet changes (e.g., user switches wallets in Phantom)
  useEffect(() => {
    if (!publicKeyString) {
      prevWalletRef.current = null;
      pendingRefreshRef.current = false;
      return;
    }
    
    // If this is the first connection, just store and return
    if (!prevWalletRef.current) {
      prevWalletRef.current = publicKeyString;
      return;
    }
    
    // Wallet changed - trigger refresh
    if (prevWalletRef.current !== publicKeyString) {
      const prevWallet = prevWalletRef.current;
      prevWalletRef.current = publicKeyString;
      
      console.log(`[Wallet] Detected wallet change: ${prevWallet?.slice(0,8)}... → ${publicKeyString.slice(0,8)}...`);
      
      // If already refreshing, set flag to refresh when done
      if (refreshing) {
        console.log('[Wallet] Refresh in progress, will refresh when complete');
        pendingRefreshRef.current = true;
        return;
      }
      
      // Trigger immediate refresh
      handleRefreshAll();
    }
  }, [publicKeyString, refreshing]);
  
  // Process pending refresh when refreshing completes
  useEffect(() => {
    if (!refreshing && pendingRefreshRef.current && publicKeyString) {
      console.log(`[Wallet] Processing pending refresh for ${publicKeyString.slice(0,8)}...`);
      pendingRefreshRef.current = false;
      // Small delay to ensure state is settled
      setTimeout(() => handleRefreshAll(), 100);
    }
  }, [refreshing, publicKeyString]);

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
    setResetStep('closing');
    
    // Simulate step progression while the actual request runs
    const stepTimer = setInterval(() => {
      setResetStep(prev => {
        if (prev === 'closing') return 'settling';
        if (prev === 'settling') return 'sweeping';
        if (prev === 'sweeping') return 'withdrawing';
        if (prev === 'withdrawing') return 'deleting';
        return prev;
      });
    }, 3000);
    
    try {
      const res = await fetch('/api/wallet/reset-drift-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      clearInterval(stepTimer);
      setResetStep('complete');
      
      const data = await res.json();
      
      if (res.status === 400 || res.status === 500) {
        throw new Error(data.message || data.error || 'Failed to reset Drift account');
      }
      
      // Show completion for a moment before closing
      await new Promise(resolve => setTimeout(resolve, 1500));
      
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
      clearInterval(stepTimer);
      toast({ 
        title: 'Reset Failed', 
        description: error.message || 'Failed to reset Drift account',
        variant: 'destructive' 
      });
      setResetDriftDialogOpen(false);
    } finally {
      setResettingDriftAccount(false);
      setResetStep('idle');
    }
  };

  const handleResetAgentWallet = async () => {
    setResettingAgentWallet(true);
    setResetAgentProgress(['Starting agent wallet reset...']);
    
    try {
      // Step 1: Get current session
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) throw new Error('Failed to check session');
      const sessionData = await sessionRes.json();
      
      if (!sessionData.hasSession || !sessionData.sessionId) {
        throw new Error('No active session. Please reconnect your wallet.');
      }
      
      setResetAgentProgress(['Session verified', 'Initiating reset...']);
      
      const res = await fetch('/api/wallet/reset-agent-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionData.sessionId }),
        credentials: 'include',
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset agent wallet');
      }
      
      setResetAgentProgress(data.progress || ['Reset complete']);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      toast({ 
        title: 'Agent Wallet Reset', 
        description: `New agent wallet created: ${data.newAgentWallet?.slice(0, 8)}...`
      });
      
      setResetAgentDialogOpen(false);
      setAgentPublicKey(data.newAgentWallet);
      refetchBots();
    } catch (error: any) {
      toast({ 
        title: 'Reset Failed', 
        description: error.message || 'Failed to reset agent wallet',
        variant: 'destructive' 
      });
      setResetAgentDialogOpen(false);
    } finally {
      setResettingAgentWallet(false);
      setResetAgentProgress([]);
    }
  };

  // Reset welcome check when wallet changes
  useEffect(() => {
    welcomeCheckedRef.current = false;
    setAgentPublicKey(null);
  }, [publicKeyString]);

  // Check if agent wallet needs SOL for gas and show welcome popup
  // Use sessionConnected (not just connected) to ensure backend session is established first
  useEffect(() => {
    if (!sessionConnected || welcomeCheckedRef.current) return;
    
    // Delay the check to allow balance to be fetched and avoid showing during disconnect
    const timeoutId = setTimeout(async () => {
      // Double-check we're still connected after the delay
      if (!sessionConnected) return;
      
      try {
        const res = await fetch('/api/agent/balance', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setAgentPublicKey(data.agentPublicKey);
          
          // Check if agent wallet is low on SOL for gas (0.035 SOL needed for bot creation)
          const needsGas = data.solBalance === 0 || data.solBalance < 0.035;
          
          if (needsGas) {
            if (data.solBalance === 0) {
              // Agent has zero SOL - fresh agent wallet (new or reset), show welcome popup
              setWelcomePopupOpen(true);
            } else if (data.isExistingUser && data.driftAccountExists) {
              // Only show low gas toast for existing users who have an active Drift account
              // This avoids showing it during initial setup or when user is just browsing
              toast({
                title: 'Low Gas Balance',
                description: 'Your agent wallet is low on SOL for transaction fees. Visit Wallet tab to deposit more.',
                duration: 8000,
              });
            } else if (!data.isExistingUser) {
              // New user with some SOL but still needs more - show welcome popup
              setWelcomePopupOpen(true);
            }
          }
          welcomeCheckedRef.current = true;
        }
      } catch (error) {
        console.error('Error checking agent balance:', error);
      }
    }, 1500); // Wait 1.5 seconds to allow initial data to load
    
    return () => clearTimeout(timeoutId);
  }, [sessionConnected, publicKeyString]);

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

  // Mnemonic countdown timer effect
  useEffect(() => {
    if (!mnemonic || !mnemonicExpiresAt) return;
    
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((mnemonicExpiresAt.getTime() - Date.now()) / 1000));
      setMnemonicCountdown(remaining);
      
      if (remaining <= 0) {
        setMnemonic(null);
        setMnemonicExpiresAt(null);
        setBackupConfirmChecked(false);
        setMnemonicCopied(false);
      }
    };
    
    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [mnemonic, mnemonicExpiresAt]);

  const handleRevealMnemonic = async () => {
    if (!solanaWallet.publicKey || !solanaWallet.signMessage) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }
    
    setRevealMnemonicLoading(true);
    try {
      // Step 1: Check session status
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) throw new Error('Session check failed');
      let sessionData = await sessionRes.json();
      
      // Step 2: Unlock session if missing
      if (sessionData.sessionMissing) {
        const nonceRes = await fetch('/api/auth/nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ walletAddress: solanaWallet.publicKey.toBase58(), purpose: 'unlock_umk' }),
        });
        if (!nonceRes.ok) throw new Error('Failed to get signing nonce');
        const { nonce: unlockNonce, message: unlockMessage } = await nonceRes.json();
        
        toast({ title: 'Session expired', description: 'Please sign to reconnect.' });
        
        const unlockMsgBytes = new TextEncoder().encode(unlockMessage);
        const unlockSigBytes = await solanaWallet.signMessage(unlockMsgBytes);
        const unlockSigBase58 = bs58.encode(unlockSigBytes);
        
        const verifyRes = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            walletAddress: solanaWallet.publicKey.toBase58(),
            nonce: unlockNonce,
            signature: unlockSigBase58,
            purpose: 'unlock_umk',
          }),
        });
        if (!verifyRes.ok) throw new Error('Failed to reconnect session');
        
        // Re-fetch session
        const refreshRes = await fetch('/api/auth/session', { credentials: 'include' });
        if (!refreshRes.ok) throw new Error('Failed to refresh session');
        sessionData = await refreshRes.json();
      }
      
      if (!sessionData.hasSession || !sessionData.sessionId) {
        throw new Error('No active session. Please reconnect your wallet.');
      }
      
      // Step 3: Get nonce for reveal_mnemonic
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: solanaWallet.publicKey.toBase58(), purpose: 'reveal_mnemonic' }),
      });
      if (!nonceRes.ok) throw new Error('Failed to get signing nonce');
      const { nonce, message } = await nonceRes.json();
      
      // Step 4: Sign the message
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = await solanaWallet.signMessage(msgBytes);
      const sigBase58 = bs58.encode(sigBytes);
      
      // Step 5: Call reveal-mnemonic endpoint
      const revealRes = await fetch('/api/auth/reveal-mnemonic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sessionId: sessionData.sessionId,
          nonce,
          signature: sigBase58,
        }),
      });
      
      if (!revealRes.ok) {
        const errData = await revealRes.json();
        if (errData.retryAfterMs) {
          const retryMinutes = Math.ceil(errData.retryAfterMs / 60000);
          throw new Error(`Rate limited. Please wait ${retryMinutes} minute(s) before trying again.`);
        }
        throw new Error(errData.error || 'Failed to reveal recovery phrase');
      }
      
      const { mnemonic: revealedMnemonic, expiresAt } = await revealRes.json();
      setMnemonic(revealedMnemonic);
      setMnemonicExpiresAt(new Date(expiresAt));
      toast({ title: 'Recovery phrase revealed', description: 'Write it down and store securely. It will auto-hide in 60 seconds.' });
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message?.includes('User rejected')) {
        toast({ title: 'Signature cancelled', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to reveal recovery phrase', description: error.message, variant: 'destructive' });
      }
    } finally {
      setRevealMnemonicLoading(false);
    }
  };

  const handleCopyMnemonic = async () => {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
      setMnemonicCopied(true);
      toast({ title: 'Recovery phrase copied to clipboard' });
      setTimeout(() => setMnemonicCopied(false), 3000);
    } catch (err) {
      toast({ title: 'Failed to copy', variant: 'destructive' });
    }
  };

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
              { id: 'portfolio' as NavItem, icon: BarChart3, label: 'Portfolio' },
              { id: 'leaderboard' as NavItem, icon: Users, label: 'Leaderboard' },
              { id: 'settings' as NavItem, icon: Settings, label: 'Settings' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { 
                  setActiveNav(item.id);
                  setWalletInitialTab('deposit'); // Reset to default when clicking nav
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
          <div className="flex items-center gap-1">
            <a 
              href="/analytics" 
              className="p-2 hover:bg-muted rounded-lg"
              data-testid="link-analytics-header"
              title="Analytics"
            >
              <BarChart3 className="w-5 h-5 text-muted-foreground" />
            </a>
            <a 
              href="/docs" 
              className="p-2 hover:bg-muted rounded-lg"
              data-testid="link-docs-header"
              title="Documentation"
            >
              <BookOpen className="w-5 h-5 text-muted-foreground" />
            </a>
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
                          setWalletInitialTab('gas');
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
            <button 
              className="p-2 hover:bg-muted rounded-lg" 
              data-testid="button-refresh"
              onClick={handleRefreshAll}
              disabled={refreshing}
              title="Refresh all data"
            >
              <RefreshCw className={`w-5 h-5 text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
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
                                      <div className="flex justify-end mt-3 pt-3 border-t border-border/20">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const bot = botsData?.find((b: TradingBot) => b.id === pos.botId);
                                            if (bot) {
                                              setSelectedManagedBot(bot);
                                              setManageBotDrawerOpen(true);
                                            }
                                          }}
                                          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                                          data-testid={`button-manage-position-bot-${i}`}
                                        >
                                          <Settings className="w-3 h-3" />
                                          Manage Bot
                                        </button>
                                      </div>
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
                                  <div className="flex items-center justify-end gap-1">
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
                                    {isFailed && trade.side?.toUpperCase() !== 'CLOSE' && (
                                      <TooltipProvider>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <button
                                              className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                                              data-testid={`button-retry-trade-${i}`}
                                              onClick={async (e) => {
                                                e.stopPropagation();
                                                const btn = e.currentTarget;
                                                btn.disabled = true;
                                                btn.classList.add('opacity-50');
                                                try {
                                                  const res = await fetch(`/api/trades/${trade.id}/retry`, {
                                                    method: 'POST',
                                                    credentials: 'include',
                                                  });
                                                  const data = await res.json();
                                                  if (res.ok && data.success) {
                                                    toast({
                                                      title: "Trade Executed",
                                                      description: `${trade.side} ${trade.market} executed at $${data.fillPrice?.toFixed(2) || 'market'}`,
                                                    });
                                                    refetchTrades();
                                                  } else {
                                                    toast({
                                                      title: "Retry Failed",
                                                      description: data.error || "Could not execute trade",
                                                      variant: "destructive",
                                                    });
                                                  }
                                                } catch (err) {
                                                  toast({
                                                    title: "Retry Failed",
                                                    description: "Network error",
                                                    variant: "destructive",
                                                  });
                                                } finally {
                                                  btn.disabled = false;
                                                  btn.classList.remove('opacity-50');
                                                }
                                              }}
                                            >
                                              <RefreshCw className="w-3 h-3" />
                                            </button>
                                          </TooltipTrigger>
                                          <TooltipContent side="top">
                                            <p className="text-xs">Retry trade at current price</p>
                                          </TooltipContent>
                                        </Tooltip>
                                      </TooltipProvider>
                                    )}
                                  </div>
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

            {activeNav === 'portfolio' && (
              <motion.div
                key="portfolio"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-display font-bold">Portfolio Performance</h1>
                    <p className="text-muted-foreground">Track your TRUE trading P&L</p>
                  </div>
                </div>

                {portfolioPerformanceLoading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <span className="ml-3 text-muted-foreground">Loading portfolio data...</span>
                  </div>
                ) : portfolioPerformanceData ? (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <DollarSign className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Current Balance</p>
                        </div>
                        <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-balance">
                          ${portfolioPerformanceData.currentBalance.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">USDC</p>
                      </div>
                      <div className="gradient-border p-4 noise relative">
                        <div className="flex items-center gap-2 mb-1">
                          <TrendingUp className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Net P&L</p>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                <p className="text-xs">True P&L = Current Balance - Total Deposits + Total Withdrawals. This shows your actual trading performance, not inflated by deposits.</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        <p className={`text-2xl font-bold font-mono ${portfolioPerformanceData.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} data-testid="text-portfolio-pnl">
                          {portfolioPerformanceData.netPnl >= 0 ? '+' : ''}${portfolioPerformanceData.netPnl.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">True trading performance</p>
                      </div>
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <Activity className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">P&L Percentage</p>
                        </div>
                        <p className={`text-2xl font-bold font-mono ${portfolioPerformanceData.pnlPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`} data-testid="text-portfolio-pnl-percent">
                          {portfolioPerformanceData.pnlPercent >= 0 ? '+' : ''}{portfolioPerformanceData.pnlPercent.toFixed(2)}%
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Return on deposits</p>
                      </div>
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <Wallet className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Deposits / Withdrawals</p>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <p className="text-lg font-bold font-mono text-emerald-400" data-testid="text-portfolio-deposits">
                            +${portfolioPerformanceData.totalDeposits.toFixed(2)}
                          </p>
                          <span className="text-muted-foreground">/</span>
                          <p className="text-lg font-bold font-mono text-red-400" data-testid="text-portfolio-withdrawals">
                            -${portfolioPerformanceData.totalWithdrawals.toFixed(2)}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">USDC flows</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <Bot className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Active / Total Bots</p>
                        </div>
                        <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-bots">
                          {portfolioPerformanceData.activeBotCount} <span className="text-muted-foreground text-lg">/ {portfolioPerformanceData.totalBots}</span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Trading bots</p>
                      </div>
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <Activity className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Total Trades</p>
                        </div>
                        <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-trades">
                          {portfolioPerformanceData.totalTrades.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Executed trades</p>
                      </div>
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <BarChart3 className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Total Volume</p>
                        </div>
                        <p className="text-2xl font-bold font-mono" data-testid="text-portfolio-volume">
                          ${portfolioPerformanceData.totalVolume >= 1000000 
                            ? (portfolioPerformanceData.totalVolume / 1000000).toFixed(2) + 'M' 
                            : portfolioPerformanceData.totalVolume >= 1000 
                              ? (portfolioPerformanceData.totalVolume / 1000).toFixed(2) + 'K' 
                              : portfolioPerformanceData.totalVolume.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">USDC traded</p>
                      </div>
                      <div className="gradient-border p-4 noise">
                        <div className="flex items-center gap-2 mb-1">
                          <Share2 className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">Creator Earnings</p>
                        </div>
                        <p className="text-2xl font-bold font-mono text-primary" data-testid="text-portfolio-creator-earnings">
                          ${portfolioPerformanceData.creatorEarnings.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">From signal sharing</p>
                      </div>
                    </div>

                    <div className="gradient-border p-6 noise">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <h2 className="font-display font-semibold">P&L History</h2>
                          <div className="flex gap-1" data-testid="toggle-portfolio-chart-view">
                            <Button
                              variant={portfolioChartView === 'dollar' ? 'default' : 'outline'}
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => setPortfolioChartView('dollar')}
                            >
                              $
                            </Button>
                            <Button
                              variant={portfolioChartView === 'percent' ? 'default' : 'outline'}
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => setPortfolioChartView('percent')}
                            >
                              %
                            </Button>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {portfolioChartView === 'dollar' ? 'Net P&L in USD' : 'P&L as % of deposits'}
                        </p>
                      </div>
                      {portfolioPerformanceData.chartData && portfolioPerformanceData.chartData.length > 0 ? (
                        <div className="h-[300px]" data-testid="portfolio-pnl-chart">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={portfolioPerformanceData.chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                              <defs>
                                <linearGradient id="colorPnlPositive" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                                </linearGradient>
                                <linearGradient id="colorPnlNegative" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <XAxis 
                                dataKey="date" 
                                stroke="#6b7280"
                                tick={{ fill: '#9ca3af', fontSize: 12 }}
                                tickFormatter={(value) => {
                                  const date = new Date(value);
                                  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                }}
                              />
                              <YAxis 
                                stroke="#6b7280"
                                tick={{ fill: '#9ca3af', fontSize: 12 }}
                                tickFormatter={(value) => portfolioChartView === 'dollar' 
                                  ? `$${value >= 1000 ? (value / 1000).toFixed(1) + 'K' : value >= -1000 ? value.toFixed(0) : (value / 1000).toFixed(1) + 'K'}`
                                  : `${value.toFixed(1)}%`
                                }
                              />
                              <RechartsTooltip 
                                contentStyle={{ 
                                  backgroundColor: 'rgba(23, 23, 23, 0.95)', 
                                  border: '1px solid rgba(255,255,255,0.1)', 
                                  borderRadius: '8px',
                                  padding: '8px 12px'
                                }}
                                labelStyle={{ color: '#9ca3af' }}
                                formatter={(value: number) => [
                                  portfolioChartView === 'dollar' 
                                    ? `$${value.toFixed(2)}` 
                                    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
                                  portfolioChartView === 'dollar' ? 'Net P&L' : 'P&L %'
                                ]}
                                labelFormatter={(label) => new Date(label).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                              />
                              <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
                              <Area 
                                type="monotone" 
                                dataKey={portfolioChartView === 'dollar' ? 'netPnl' : 'pnlPercent'}
                                stroke={portfolioPerformanceData.netPnl >= 0 ? '#10b981' : '#ef4444'}
                                strokeWidth={2}
                                fill={portfolioPerformanceData.netPnl >= 0 ? 'url(#colorPnlPositive)' : 'url(#colorPnlNegative)'}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p>No P&L history available yet</p>
                            <p className="text-sm mt-1">Start trading to see your performance chart</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="gradient-border p-8 noise text-center">
                    <BarChart3 className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <h3 className="text-lg font-semibold mb-2">No Portfolio Data</h3>
                    <p className="text-muted-foreground mb-4">Start trading to see your portfolio performance</p>
                    <Button 
                      className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
                      onClick={() => setActiveNav('bots')}
                      data-testid="button-go-to-bots"
                    >
                      <Bot className="w-4 h-4 mr-2" />
                      Create a Bot
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
                          const shareUrl = `https://myquantumvault.com/app?bot=${bot.id}&ref=${walletReferralCode || ''}`;
                          
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

                              <div className="grid grid-cols-3 gap-2 mb-3">
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
                                <div className="text-center p-2 rounded-lg bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/30">
                                  <p className="text-sm font-bold text-emerald-400">
                                    ${parseFloat(bot.creatorEarnings || '0').toFixed(2)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">Earnings</p>
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
                                          setSharePopupBot({ 
                                            id: bot.id, 
                                            tradingBotId: bot.tradingBotId, 
                                            name: bot.name, 
                                            market: bot.market 
                                          });
                                          setCopiedField(null);
                                        }}
                                        data-testid={`button-share-${bot.id}`}
                                      >
                                        <Share2 className="w-4 h-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Share Bot</TooltipContent>
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
                            onClick={() => setViewDetailBot(bot)}
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
                            <div className="flex items-center gap-3">
                              {parseFloat(bot.profitSharePercent || '0') > 0 && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary" data-testid={`text-profit-share-${bot.id}`}>
                                  {parseFloat(bot.profitSharePercent).toFixed(0)}% share
                                </span>
                              )}
                              <span>${totalCapital.toLocaleString()} TVL</span>
                            </div>
                          </div>

                          <div className="flex gap-2">
                            <Button 
                              variant="outline"
                              className="flex-1"
                              onClick={() => setViewDetailBot(bot)}
                              data-testid={`button-view-details-${bot.id}`}
                            >
                              <Eye className="w-4 h-4 mr-2" />
                              Details
                            </Button>
                            {isSubscribed ? (
                              <Button 
                                variant="outline"
                                className="flex-1 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
                                onClick={async () => {
                                  if (confirm('Are you sure you want to unsubscribe? This will stop copying trades from this bot. Any funds in your copy bot will remain in your account.')) {
                                    try {
                                      await unsubscribeMutation.mutateAsync(bot.id);
                                      toast({ title: 'Unsubscribed successfully' });
                                      refetchMySubscriptions();
                                    } catch (error: any) {
                                      toast({ title: 'Failed to unsubscribe', description: error.message, variant: 'destructive' });
                                    }
                                  }
                                }}
                                disabled={unsubscribeMutation.isPending}
                                data-testid={`button-subscribed-${bot.id}`}
                              >
                                {unsubscribeMutation.isPending ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4 mr-2" />
                                )}
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
                          <th className="text-right py-4 px-4 font-medium">P&L %</th>
                          <th className="text-right py-4 px-4 font-medium">Win Rate</th>
                          <th className="text-right py-4 px-4 font-medium">Trades</th>
                          <th className="text-center py-4 px-4 font-medium">Profile</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboardData.map((trader: { walletAddress: string; displayName: string | null; xUsername: string | null; totalVolume: number; totalPnl: number; pnlPercent: number; winRate: number; tradeCount: number }, index: number) => {
                          const rank = index + 1;
                          const shortenedWallet = `${trader.walletAddress.slice(0, 4)}...${trader.walletAddress.slice(-4)}`;
                          const displayName = trader.displayName || shortenedWallet;
                          const formatVolume = (v: number) => {
                            if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
                            if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
                            return v.toFixed(0);
                          };
                          const pnlFormatted = trader.pnlPercent >= 0 ? `+${trader.pnlPercent.toFixed(2)}%` : `${trader.pnlPercent.toFixed(2)}%`;
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
                              <td className={`py-4 px-4 text-right font-mono ${trader.pnlPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnlFormatted}</td>
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
                  <div className="space-y-4">
                    {/* Account Section */}
                    <div className="gradient-border p-0 noise">
                      <button
                        onClick={() => setExpandedSection(expandedSection === 'account' ? null : 'account')}
                        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-muted/10 transition-colors rounded-t-xl"
                        data-testid="button-toggle-account"
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-primary/20">
                            <User className="w-5 h-5 text-primary" />
                          </div>
                          <h3 className="font-display font-semibold">Account</h3>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === 'account' ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {expandedSection === 'account' && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4 space-y-4">
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
                              
                              {referralCode && (
                                <div className="pt-4 border-t border-border/30">
                                  <h4 className="font-medium mb-3">Referral Program</h4>
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
                                          value={`https://myquantumvault.com/app?ref=${referralCode}`}
                                          readOnly
                                          className="bg-muted/30 border-border/50 font-mono text-sm"
                                          data-testid="input-referral-link"
                                        />
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          onClick={async () => {
                                            await navigator.clipboard.writeText(`https://myquantumvault.com/app?ref=${referralCode}`);
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
                              
                              {agentPublicKey && (
                                <div className="pt-4 border-t border-border/30">
                                  <h4 className="font-medium mb-3">Drift Account</h4>
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
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Trading Preferences Section */}
                    <div className="gradient-border p-0 noise">
                      <button
                        onClick={() => setExpandedSection(expandedSection === 'trading' ? null : 'trading')}
                        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-muted/10 transition-colors rounded-t-xl"
                        data-testid="button-toggle-trading-prefs"
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-primary/20">
                            <Sliders className="w-5 h-5 text-primary" />
                          </div>
                          <h3 className="font-display font-semibold">Trading Preferences</h3>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === 'trading' ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {expandedSection === 'trading' && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4 space-y-4">
                              <div>
                                <label className="text-sm text-muted-foreground mb-1.5 block">Default Leverage</label>
                                <p className="text-xs text-muted-foreground mb-2">Used when creating new bots. Markets have different max limits (3x-20x) - your value will be capped to each market's maximum.</p>
                                <div className="flex items-center gap-3">
                                  <Input 
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={defaultLeverage} 
                                    onChange={(e) => setDefaultLeverage(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
                                    className="bg-muted/30 border-border/50 w-24" 
                                    data-testid="input-default-leverage" 
                                  />
                                  <span className="text-sm text-muted-foreground">x (1-20)</span>
                                </div>
                              </div>
                              <div>
                                <label className="text-sm text-muted-foreground mb-1.5 block">Max Slippage</label>
                                <p className="text-xs text-muted-foreground mb-2">Maximum price slippage tolerance for trades. Higher values help with volatile markets.</p>
                                <div className="flex items-center gap-3">
                                  <Input 
                                    type="number"
                                    min={1}
                                    max={500}
                                    value={slippageBps} 
                                    onChange={(e) => setSlippageBps(Math.min(500, Math.max(1, parseInt(e.target.value) || 50)))}
                                    className="bg-muted/30 border-border/50 w-24" 
                                    data-testid="input-slippage-bps" 
                                  />
                                  <span className="text-sm text-muted-foreground">bps ({(slippageBps / 100).toFixed(2)}%)</span>
                                </div>
                              </div>
                              
                              {/* RPC Status */}
                              <div className="pt-4 border-t border-border/30">
                                <label className="text-sm text-muted-foreground mb-1.5 block">RPC Status</label>
                                <p className="text-xs text-muted-foreground mb-3">Connection status of Solana RPC providers used for trade execution.</p>
                                {rpcStatusLoading ? (
                                  <div className="text-sm text-muted-foreground">Checking RPC status...</div>
                                ) : rpcStatus ? (
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between bg-muted/30 rounded-lg p-3 border border-border/50">
                                      <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${rpcStatus.primary.healthy ? 'bg-green-500' : 'bg-red-500'}`} />
                                        <span className="text-sm font-medium">{rpcStatus.primary.name}</span>
                                        <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">Primary</span>
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {rpcStatus.primary.healthy 
                                          ? `${rpcStatus.primary.latency}ms` 
                                          : 'Offline'}
                                      </div>
                                    </div>
                                    {rpcStatus.backup.configured ? (
                                      <div className="flex items-center justify-between bg-muted/30 rounded-lg p-3 border border-border/50">
                                        <div className="flex items-center gap-2">
                                          <div className={`w-2 h-2 rounded-full ${rpcStatus.backup.healthy ? 'bg-green-500' : 'bg-amber-500'}`} />
                                          <span className="text-sm font-medium">{rpcStatus.backup.name}</span>
                                          <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded">Backup</span>
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                          {rpcStatus.backup.healthy 
                                            ? `${rpcStatus.backup.latency}ms` 
                                            : 'Offline'}
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <span>No backup RPC configured</span>
                                      </div>
                                    )}
                                    <p className="text-xs text-muted-foreground mt-1">
                                      Network: {rpcStatus.network}
                                    </p>
                                  </div>
                                ) : (
                                  <div className="text-sm text-muted-foreground">Unable to check RPC status</div>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Notifications Section */}
                    <div className="gradient-border p-0 noise">
                      <button
                        onClick={() => setExpandedSection(expandedSection === 'notifications' ? null : 'notifications')}
                        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-muted/10 transition-colors rounded-t-xl"
                        data-testid="button-toggle-notifications"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${telegramConnected ? 'bg-green-500/20' : 'bg-primary/20'}`}>
                            <Bell className={`w-5 h-5 ${telegramConnected ? 'text-green-500' : 'text-primary'}`} />
                          </div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-display font-semibold">Notifications</h3>
                            {telegramConnected && (
                              <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-500 rounded-full">Connected</span>
                            )}
                          </div>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === 'notifications' ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {expandedSection === 'notifications' && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4">
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
                                    {telegramConnected && (
                                      <div className="mt-3">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={async () => {
                                            try {
                                              const res = await fetch('/api/telegram/disconnect', { 
                                                method: 'POST',
                                                credentials: 'include' 
                                              });
                                              if (res.ok) {
                                                setTelegramConnected(false);
                                                toast({
                                                  title: "Telegram Disconnected",
                                                  description: "You will no longer receive alerts via Telegram.",
                                                });
                                              }
                                            } catch (error) {
                                              toast({
                                                title: "Error",
                                                description: "Failed to disconnect Telegram",
                                                variant: "destructive",
                                              });
                                            }
                                          }}
                                          data-testid="button-disconnect-telegram"
                                        >
                                          Disconnect Telegram
                                        </Button>
                                      </div>
                                    )}
                                    {!telegramConnected && (
                                      <div className="mt-3 space-y-3">
                                        <Button
                                          variant="default"
                                          onClick={async () => {
                                            try {
                                              const res = await fetch('/api/telegram/connect', { 
                                                method: 'POST',
                                                credentials: 'include' 
                                              });
                                              const data = await res.json();
                                              
                                              if (res.ok && data.deepLink) {
                                                window.open(data.deepLink, '_blank');
                                                toast({
                                                  title: "Telegram Opened",
                                                  description: "Click 'Start' in the bot to connect. Return here when done.",
                                                });
                                              } else {
                                                toast({
                                                  title: "Setup Not Available",
                                                  description: data.error || "Telegram notifications are not yet configured.",
                                                  variant: "destructive",
                                                });
                                              }
                                            } catch (error) {
                                              toast({
                                                title: "Error",
                                                description: "Failed to generate Telegram link",
                                                variant: "destructive",
                                              });
                                            }
                                          }}
                                          data-testid="button-connect-telegram"
                                        >
                                          <ExternalLink className="w-4 h-4 mr-2" />
                                          Connect Telegram
                                        </Button>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={async () => {
                                            try {
                                              const res = await fetch('/api/telegram/status', { 
                                                method: 'GET',
                                                credentials: 'include' 
                                              });
                                              const data = await res.json();
                                              
                                              if (data.connected) {
                                                setTelegramConnected(true);
                                                toast({
                                                  title: "Telegram Connected!",
                                                  description: "You'll now receive trade alerts via Telegram.",
                                                });
                                              } else {
                                                toast({
                                                  title: "Not Connected Yet",
                                                  description: "Click 'Connect Telegram' and press Start in the bot.",
                                                  variant: "destructive",
                                                });
                                              }
                                            } catch (error) {
                                              toast({
                                                title: "Error",
                                                description: "Failed to check connection status",
                                                variant: "destructive",
                                              });
                                            }
                                          }}
                                          data-testid="button-check-telegram-status"
                                        >
                                          <Check className="w-4 h-4 mr-2" />
                                          Check Connection
                                        </Button>
                                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-xs text-blue-300">
                                          <p className="font-medium mb-1">Quick Setup</p>
                                          <p>Click "Connect Telegram", then press "Start" in our bot. You can link multiple wallets to the same Telegram account.</p>
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
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Security Section */}
                    <div className="gradient-border p-0 noise">
                      <button
                        onClick={() => setExpandedSection(expandedSection === 'security' ? null : 'security')}
                        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-muted/10 transition-colors rounded-t-xl"
                        data-testid="button-toggle-security"
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-primary/20">
                            <Shield className="w-5 h-5 text-primary" />
                          </div>
                          <h3 className="font-display font-semibold">Security</h3>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === 'security' ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {expandedSection === 'security' && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4 space-y-4">
                              {/* Automated Trading */}
                              <div className="bg-muted/30 rounded-lg border border-border/50 p-4">
                                <div className="flex items-start gap-3">
                                  <div className={`p-2 rounded-full ${executionEnabled ? 'bg-green-500/20' : 'bg-amber-500/20'}`}>
                                    <Zap className={`w-5 h-5 ${executionEnabled ? 'text-green-500' : 'text-amber-500'}`} />
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="font-medium">Webhook Execution</p>
                                      {executionEnabled ? (
                                        <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-500 rounded-full">Enabled</span>
                                      ) : (
                                        <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-500 rounded-full">Disabled</span>
                                      )}
                                    </div>
                                    <p className="text-sm text-muted-foreground mt-1">
                                      {executionEnabled 
                                        ? 'Your bots can execute trades via TradingView webhooks. Authorization remains active until you revoke it.'
                                        : 'Enable automated trading to allow your bots to execute trades when webhook signals arrive from TradingView.'}
                                    </p>
                                    <div className="mt-3">
                                      {executionEnabled ? (
                                        <Button
                                          variant="outline"
                                          onClick={revokeExecution}
                                          disabled={executionLoading}
                                          data-testid="button-revoke-execution"
                                        >
                                          {executionLoading ? (
                                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                                          ) : (
                                            'Revoke Authorization'
                                          )}
                                        </Button>
                                      ) : (
                                        <Button
                                          onClick={enableExecution}
                                          disabled={executionLoading}
                                          data-testid="button-enable-execution"
                                        >
                                          {executionLoading ? (
                                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                                          ) : (
                                            <><Shield className="w-4 h-4 mr-2" /> Enable Automated Trading</>
                                          )}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Agent Wallet Backup */}
                              <div className="bg-muted/30 rounded-lg border border-border/50 p-4">
                                <div className="flex items-start gap-3">
                                  <div className="p-2 rounded-full bg-amber-500/20">
                                    <Key className="w-5 h-5 text-amber-500" />
                                  </div>
                                  <div className="flex-1">
                                    <p className="font-medium">Recovery Phrase</p>
                                    <p className="text-sm text-muted-foreground mt-1">
                                      Your agent wallet's recovery phrase allows you to restore access if needed. Keep it safe and never share it with anyone.
                                    </p>
                                    
                                    {mnemonic ? (
                                      <div className="mt-4 space-y-3">
                                        <div className="flex items-center gap-2 text-amber-500">
                                          <Clock className="w-4 h-4" />
                                          <span className="text-sm font-medium">Auto-hides in {mnemonicCountdown}s</span>
                                        </div>
                                        <div className="bg-background/50 rounded-lg border border-amber-500/30 p-4">
                                          <p className="font-mono text-sm leading-relaxed break-all select-all" data-testid="text-mnemonic">
                                            {mnemonic}
                                          </p>
                                        </div>
                                        <div className="flex gap-2">
                                          <Button
                                            variant="outline"
                                            onClick={handleCopyMnemonic}
                                            className="flex-1"
                                            data-testid="button-copy-mnemonic"
                                          >
                                            {mnemonicCopied ? (
                                              <><Check className="w-4 h-4 mr-2 text-green-500" /> Copied</>
                                            ) : (
                                              <><Copy className="w-4 h-4 mr-2" /> Copy to Clipboard</>
                                            )}
                                          </Button>
                                          <Button
                                            variant="outline"
                                            onClick={() => {
                                              setMnemonic(null);
                                              setMnemonicExpiresAt(null);
                                              setBackupConfirmChecked(false);
                                            }}
                                            data-testid="button-hide-mnemonic"
                                          >
                                            <EyeOff className="w-4 h-4 mr-2" /> Hide
                                          </Button>
                                        </div>
                                        <div className="bg-red-500/10 rounded-lg border border-red-500/30 p-3">
                                          <div className="flex items-start gap-2">
                                            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                                            <div className="text-xs text-red-400">
                                              <p className="font-medium mb-1">Keep this phrase secure!</p>
                                              <ul className="list-disc ml-4 space-y-0.5">
                                                <li>Never share it with anyone</li>
                                                <li>Store it offline in a safe place</li>
                                                <li>Anyone with this phrase can control your funds</li>
                                                <li>QuantumVault will never ask for your recovery phrase</li>
                                              </ul>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="mt-4 space-y-4">
                                        <div className="bg-amber-500/10 rounded-lg border border-amber-500/30 p-3">
                                          <div className="flex items-start gap-2">
                                            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                                            <p className="text-xs text-amber-400">
                                              Only reveal your recovery phrase in a private location. Make sure no one is watching your screen.
                                            </p>
                                          </div>
                                        </div>
                                        <div className="flex items-start gap-2">
                                          <Checkbox
                                            id="backup-confirm"
                                            checked={backupConfirmChecked}
                                            onCheckedChange={(checked) => setBackupConfirmChecked(checked === true)}
                                            data-testid="checkbox-confirm-backup"
                                          />
                                          <label htmlFor="backup-confirm" className="text-sm text-muted-foreground cursor-pointer">
                                            I understand this phrase controls my agent wallet funds and I'm in a private location
                                          </label>
                                        </div>
                                        <Button
                                          onClick={handleRevealMnemonic}
                                          disabled={!backupConfirmChecked || revealMnemonicLoading}
                                          data-testid="button-reveal-mnemonic"
                                        >
                                          {revealMnemonicLoading ? (
                                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Revealing...</>
                                          ) : (
                                            <><Eye className="w-4 h-4 mr-2" /> Reveal Recovery Phrase</>
                                          )}
                                        </Button>
                                        <p className="text-xs text-muted-foreground">
                                          Limited to 3 reveals per hour. Phrase auto-hides after 60 seconds.
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Danger Zone Section */}
                    <div className="gradient-border p-0 noise border-red-500/30">
                      <button
                        onClick={() => setExpandedSection(expandedSection === 'danger' ? null : 'danger')}
                        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-red-500/5 transition-colors rounded-t-xl"
                        data-testid="button-toggle-danger-zone"
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-full bg-red-500/20">
                            <AlertTriangle className="w-5 h-5 text-red-400" />
                          </div>
                          <h3 className="font-display font-semibold text-red-400">Danger Zone</h3>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-red-400 transition-transform ${expandedSection === 'danger' ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {expandedSection === 'danger' && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4 space-y-4">
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
                              <div>
                                <p className="text-sm text-muted-foreground mb-2">
                                  Withdraw all funds to your wallet and generate a new agent wallet address.
                                </p>
                                <Button 
                                  variant="outline" 
                                  className="border-red-500/50 text-red-400 hover:bg-red-500/10" 
                                  onClick={() => setResetAgentDialogOpen(true)}
                                  data-testid="button-reset-agent"
                                >
                                  <RefreshCw className="w-4 h-4 mr-2" />
                                  Reset Agent Wallet
                                </Button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Save Button */}
                    <div className="pt-2">
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
                  </div>
                )}
              </motion.div>
            )}

            {activeNav === 'wallet' && (
              <WalletContent initialTab={walletInitialTab} />
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
            {resettingDriftAccount ? (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center">
                    <RefreshCw className="w-6 h-6 text-primary animate-spin" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-lg">Resetting Account</h3>
                    <p className="text-sm text-muted-foreground">Please wait while we reset your Drift account...</p>
                  </div>
                </div>

                <div className="py-4 space-y-3">
                  {[
                    { id: 'closing', label: 'Closing open positions', icon: XCircle },
                    { id: 'settling', label: 'Settling PnL to USDC', icon: Activity },
                    { id: 'sweeping', label: 'Sweeping funds to main account', icon: ArrowUpFromLine },
                    { id: 'withdrawing', label: 'Withdrawing to agent wallet', icon: Wallet },
                    { id: 'deleting', label: 'Deleting subaccounts & recovering rent', icon: Trash2 },
                    { id: 'complete', label: 'Reset complete', icon: Check },
                  ].map((step, index) => {
                    const stepOrder = ['closing', 'settling', 'sweeping', 'withdrawing', 'deleting', 'complete'];
                    const currentIndex = stepOrder.indexOf(resetStep);
                    const stepIndex = stepOrder.indexOf(step.id);
                    const status = stepIndex < currentIndex ? 'complete' : stepIndex === currentIndex ? 'active' : 'pending';
                    const Icon = step.icon;
                    
                    return (
                      <motion.div
                        key={step.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                          status === 'active' 
                            ? 'bg-primary/10 border border-primary/30' 
                            : status === 'complete'
                              ? 'bg-green-500/10 border border-green-500/30'
                              : 'bg-muted/30'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          status === 'active'
                            ? 'bg-primary/20'
                            : status === 'complete'
                              ? 'bg-green-500/20'
                              : 'bg-muted/50'
                        }`}>
                          {status === 'active' ? (
                            <Loader2 className="w-4 h-4 text-primary animate-spin" />
                          ) : status === 'complete' ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Icon className="w-4 h-4 text-muted-foreground" />
                          )}
                        </div>
                        <p className={`text-sm font-medium flex-1 ${
                          status === 'active' 
                            ? 'text-primary' 
                            : status === 'complete'
                              ? 'text-green-500'
                              : 'text-muted-foreground'
                        }`}>
                          {step.label}
                        </p>
                        {status === 'active' && (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex items-center gap-1"
                          >
                            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                          </motion.div>
                        )}
                      </motion.div>
                    );
                  })}
                </div>

                <p className="text-center text-xs text-muted-foreground mt-2">
                  This may take up to a minute. Please don't close this window.
                </p>
              </>
            ) : (
              <>
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
                    Reset Account
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}

      {resetAgentDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            data-testid="modal-reset-agent"
          >
            {resettingAgentWallet ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-red-400 animate-spin" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-lg">Resetting Agent Wallet</h3>
                    <p className="text-sm text-muted-foreground">Please wait...</p>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  {resetAgentProgress.map((step, idx) => (
                    <p key={idx} className="flex items-center gap-2 text-muted-foreground">
                      <span className="text-primary">•</span> {step}
                    </p>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                    <RefreshCw className="w-6 h-6 text-red-400" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-lg">Reset Agent Wallet</h3>
                    <p className="text-sm text-muted-foreground">This will generate a new wallet</p>
                  </div>
                </div>

                <div className="mb-6">
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-red-400">Warning</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          This action will withdraw all funds from your agent wallet to your connected wallet 
                          and create a new agent wallet. All existing Drift subaccounts will no longer be accessible.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 mb-4">
                    <div className="flex items-start gap-3">
                      <ArrowUpFromLine className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium">Requirements</p>
                        <ul className="text-sm text-muted-foreground mt-2 list-disc ml-4 space-y-1">
                          <li>No open positions on Drift</li>
                          <li>No funds remaining in Drift subaccounts</li>
                          <li>Use "Reset Drift Account" first if needed</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    USDC and SOL in your agent wallet will be automatically transferred to your connected wallet.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button 
                    variant="outline" 
                    className="flex-1" 
                    onClick={() => setResetAgentDialogOpen(false)}
                    data-testid="button-cancel-reset-agent"
                  >
                    Cancel
                  </Button>
                  <Button 
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                    onClick={handleResetAgentWallet}
                    data-testid="button-confirm-reset-agent"
                  >
                    Reset Agent Wallet
                  </Button>
                </div>
              </>
            )}
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

      {sharePopupBot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSharePopupBot(null)}>
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="gradient-border p-6 noise max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
            data-testid="modal-share-bot"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center">
                  <Share2 className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-lg">Share Bot</h3>
                  <p className="text-sm text-muted-foreground">{sharePopupBot.name}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSharePopupBot(null)}
                data-testid="button-close-share"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Bot ID</label>
                <div className="flex gap-2">
                  <Input 
                    value={sharePopupBot.tradingBotId} 
                    readOnly 
                    className="font-mono text-sm bg-muted/30"
                    data-testid="input-bot-id"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(sharePopupBot.tradingBotId);
                      setCopiedField('botId');
                      setTimeout(() => setCopiedField(null), 2000);
                      toast({ title: "Bot ID copied!" });
                    }}
                    data-testid="button-copy-bot-id"
                  >
                    {copiedField === 'botId' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Share Link</label>
                <div className="flex gap-2">
                  <Input 
                    value={`https://myquantumvault.com/app?bot=${sharePopupBot.id}&ref=${walletReferralCode || ''}`}
                    readOnly 
                    className="font-mono text-sm bg-muted/30"
                    data-testid="input-share-link"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const shareUrl = `https://myquantumvault.com/app?bot=${sharePopupBot.id}&ref=${walletReferralCode || ''}`;
                      navigator.clipboard.writeText(shareUrl);
                      setCopiedField('shareLink');
                      setTimeout(() => setCopiedField(null), 2000);
                      toast({ title: "Share link copied!" });
                    }}
                    data-testid="button-copy-share-link"
                  >
                    {copiedField === 'shareLink' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <Button
                className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90"
                onClick={() => {
                  const shareUrl = `https://myquantumvault.com/app?bot=${sharePopupBot.id}&ref=${walletReferralCode || ''}`;
                  const tweetText = encodeURIComponent(`Check out my ${sharePopupBot.market} trading bot "${sharePopupBot.name}" on QuantumVault! 🤖📈`);
                  const tweetUrl = encodeURIComponent(shareUrl);
                  window.open(`https://twitter.com/intent/tweet?text=${tweetText}&url=${tweetUrl}`, '_blank');
                }}
                data-testid="button-share-to-x"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Share to X
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
        defaultLeverage={defaultLeverage}
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
              // Refresh settings to get the displayName saved in WelcomePopup
              // Note: Don't close popup here - let user complete USDC deposit step or skip
              const settingsRes = await fetch('/api/wallet/settings', { credentials: 'include' });
              if (settingsRes.ok) {
                const settingsData = await settingsRes.json();
                setDisplayName(settingsData.displayName || '');
                setXUsername(settingsData.xUsername || '');
              }
            } catch (error) {
              console.error('Error refreshing settings after deposit:', error);
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
            refetchMySubscriptions();
          }}
        />
      )}

      {viewDetailBot && (
        <BotDetailsModal
          isOpen={!!viewDetailBot}
          onClose={() => setViewDetailBot(null)}
          bot={viewDetailBot}
          isSubscribed={mySubscriptions?.some((sub) => sub.publishedBotId === viewDetailBot.id)}
          onSubscribed={() => {
            refetchBots();
            refetchMySubscriptions();
          }}
        />
      )}
    </div>
  );
}