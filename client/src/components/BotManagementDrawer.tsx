import { safeResponseJson } from "@/lib/safe-fetch";
import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { useToast } from '@/hooks/use-toast';
import { useLeverageLimits } from '@/hooks/useLeverageLimits';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ExchangeBadge } from '@/components/ExchangeBadge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import VaultIdleFunds from '@/components/VaultIdleFunds';
import {
  Bot,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  Wallet,
  History,
  Webhook,
  Share2,
  Loader2,
  BarChart3,
  AlertCircle,
  Sparkles,
  Info,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Pause,
  Play,
  Trash2,
  Settings,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Vault,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { PublishBotModal } from './PublishBotModal';
import { SharePnLCard } from './SharePnLCard';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

// Smart price formatting: more decimals for prices under $1
function formatPrice(price: number | undefined): string {
  if (price === undefined || price === null) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  return price.toFixed(2);
}

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
  // Renamed from `botAgentPublicKey` in Group D item 17b (April 17, 2026):
  // the value is the on-chain identifier of the trading subaccount (a sub
  // pubkey for Pacifica, a derived sub address for Drift), not an "agent"
  // pubkey. The old name implied an off-chain wallet role.
  botSubaccountIdentifier?: string | null;
  activeProtocol?: 'pacifica' | 'drift' | 'flash' | null;
  sourcePublishedBotId?: string | null;
  profitReinvest?: boolean;
  autoWithdrawThreshold?: string | null;
  autoTopUp?: boolean;
  autoParkIdle?: boolean;
  pauseReason?: string | null;
  riskConfig?: Record<string, unknown>;
  stats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
    totalVolume?: number;
    lastTradeAt?: string;
  } | null;
  createdAt: string;
}

interface BotTrade {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  pnl?: string | null;
  fee?: string | null;
  status: string;
  errorMessage?: string | null;
  executionMethod?: string | null;
  executedAt: string;
  webhookPayload?: {
    data?: {
      action?: string;
      position_size?: string | number;
    };
    action?: string;
    position_size?: string | number;
  } | null;
}

interface EquityEvent {
  id: string;
  walletAddress: string;
  tradingBotId: string | null;
  eventType: string;
  amount: string;
  txSignature: string | null;
  notes: string | null;
  createdAt: string;
}

// Vault park/unpark events embed the destination protocol in `notes` via a fixed
// server template ("Parked X USDC into <Protocol>" / "Unparked <Protocol>. ...").
// Extract it so the per-bot flows show WHERE idle funds went — e.g. so a user can
// audit their exposure if a yield protocol has an incident. Best-effort: returns
// null (renders nothing) if the protocol name can't be extracted.
function parkDestinationFromNotes(eventType: string, notes: string | null): string | null {
  if (eventType !== 'vault_park' && eventType !== 'vault_unpark') return null;
  const n = notes ?? '';
  const parked = n.match(/\binto\s+(.+?)\s*$/i);
  if (parked) return parked[1].trim();
  const unparked = n.match(/^Unparked\s+(.+?)\./i);
  if (unparked) return unparked[1].trim();
  return null;
}

interface BotPosition {
  hasPosition: boolean;
  side?: 'LONG' | 'SHORT';
  size?: number;
  avgEntryPrice?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  market?: string;
  healthFactor?: number;
  liquidationPrice?: number;
  totalCollateral?: number;
  freeCollateral?: number;
}

function formatUsdSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// Given a TP/SL input (percent or absolute price), compute the resulting target
// price, the price-move % from entry, and the expected $ P&L at that target for
// the open position. P&L respects side (LONG/SHORT). Returns null when inputs are
// not usable yet. pnl is null when position size is unknown.
function computeTpSlOutcome(
  raw: string,
  mode: 'percent' | 'price',
  kind: 'tp' | 'sl',
  side: 'LONG' | 'SHORT' | undefined,
  entry: number | undefined,
  size: number | undefined,
): { targetPrice: number; movePct: number; pnl: number | null } | null {
  const val = parseFloat(raw || '');
  if (!Number.isFinite(val) || val <= 0 || !entry || entry <= 0 || !side) return null;
  const isLong = side === 'LONG';
  let targetPrice: number;
  if (mode === 'percent') {
    // TP for a long moves up, for a short moves down. SL is the inverse.
    const favorableUp = kind === 'tp' ? isLong : !isLong;
    targetPrice = entry * (favorableUp ? 1 + val / 100 : 1 - val / 100);
  } else {
    targetPrice = val;
  }
  const dir = isLong ? 1 : -1;
  const movePct = Math.abs((targetPrice - entry) / entry) * 100;
  const pnl = size && size > 0 ? (targetPrice - entry) * dir * size : null;
  return { targetPrice, movePct, pnl };
}

interface BotManagementDrawerProps {
  bot: TradingBot | null;
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  referralCode?: string;
  onBotUpdated: () => void;
  onShowWalletTab?: () => void;
  displayName?: string;
  xUsername?: string;
}

export function BotManagementDrawer({
  bot,
  isOpen,
  onClose,
  walletAddress,
  referralCode,
  onBotUpdated,
  onShowWalletTab,
  displayName,
  xUsername,
}: BotManagementDrawerProps) {
  const { toast } = useToast();
  const { getMaxLeverage } = useLeverageLimits();
  const wallet = useWallet();

  const [activeTab, setActiveTab] = useState('overview');
  const [showVaultPark, setShowVaultPark] = useState(false);
  const [botBalance, setBotBalance] = useState<number>(0);
  // Per-bot Vault-parked value (Flash/independent_trader). OFF-exchange, NOT tradable —
  // folded into the displayed Bot Balance / PnL only, never into sizing or margin math.
  const [parkedValueUsdc, setParkedValueUsdc] = useState<number>(0);
  const [mainAccountBalance, setMainAccountBalance] = useState<number>(0);
  const [exchangeBalance, setExchangeBalance] = useState<number>(0);
  const [exchangeFreeCollateral, setExchangeFreeCollateral] = useState<number>(0);
  const [hasOpenPositions, setHasOpenPositions] = useState<boolean>(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [hasBalanceLoaded, setHasBalanceLoaded] = useState(false);
  const [trades, setTrades] = useState<BotTrade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [equityEvents, setEquityEvents] = useState<EquityEvent[]>([]);
  const [equityEventsLoading, setEquityEventsLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [addEquityAmount, setAddEquityAmount] = useState<string>('');
  const [removeEquityAmount, setRemoveEquityAmount] = useState<string>('');
  const [addEquityLoading, setAddEquityLoading] = useState(false);
  const [removeEquityLoading, setRemoveEquityLoading] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [localBot, setLocalBot] = useState<TradingBot | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editLeverage, setEditLeverage] = useState<number>(1);
  const [editMaxPositionSize, setEditMaxPositionSize] = useState<string>('');
  const [editProfitReinvest, setEditProfitReinvest] = useState<boolean>(false);
  const [editAutoWithdrawThreshold, setEditAutoWithdrawThreshold] = useState<string>('');
  const [editAutoTopUp, setEditAutoTopUp] = useState<boolean>(false);
  const [editAutoParkIdle, setEditAutoParkIdle] = useState<boolean>(false);
  const [saveSettingsLoading, setSaveSettingsLoading] = useState(false);
  const [userWebhookUrl, setUserWebhookUrl] = useState<string | null>(null);
  const [webhookUrlLoading, setWebhookUrlLoading] = useState(false);
  const [dataPartial, setDataPartial] = useState(false);
  const [botPosition, setBotPosition] = useState<BotPosition | null>(null);
  const [positionLoading, setPositionLoading] = useState(false);
  const [hasPositionLoaded, setHasPositionLoaded] = useState(false);
  const [netDeposited, setNetDeposited] = useState<number>(0);
  const [closePositionLoading, setClosePositionLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshPositionLoading, setRefreshPositionLoading] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [shareCardOpen, setShareCardOpen] = useState(false);
  const [publishedBotId, setPublishedBotId] = useState<string | null>(null);
  const [performanceTimeframe, setPerformanceTimeframe] = useState<'7d' | '30d' | '90d' | 'all'>('7d');
  const [performanceView, setPerformanceView] = useState<'dollar' | 'percent'>('dollar');
  const [performanceData, setPerformanceData] = useState<{ timestamp: string; pnl: number; cumulativePnl: number }[]>([]);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [performanceTotalPnl, setPerformanceTotalPnl] = useState<number>(0);
  const [performanceTradeCount, setPerformanceTradeCount] = useState<number>(0);
  const [manualTradeLoading, setManualTradeLoading] = useState<'long' | 'short' | null>(null);
  const [tpslOpen, setTpslOpen] = useState(false);
  const [tpslMode, setTpslMode] = useState<'price' | 'percent'>('percent');
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [tpslLoading, setTpslLoading] = useState(false);
  const [tpslCancelLoading, setTpslCancelLoading] = useState(false);
  const [activeTp, setActiveTp] = useState<number | null>(null);
  const [activeSl, setActiveSl] = useState<number | null>(null);

  useEffect(() => {
    if (bot?.riskConfig) {
      const tp = Number(bot.riskConfig.takeProfitPrice || 0);
      const sl = Number(bot.riskConfig.stopLossPrice || 0);
      if (tp > 0) setActiveTp(tp);
      else setActiveTp(null);
      if (sl > 0) setActiveSl(sl);
      else setActiveSl(null);
    }
  }, [bot?.id, bot?.riskConfig]);

  // Fetch published bot status
  const fetchPublishedStatus = async () => {
    if (!bot?.id) return;
    try {
      const response = await fetch(`/api/trading-bots/${bot.id}/published`, { credentials: 'include' });
      if (response.ok) {
        const data = await safeResponseJson(response);
        if (data.isPublished && data.publishedBot?.id) {
          setPublishedBotId(data.publishedBot.id);
        } else {
          setPublishedBotId(null);
        }
      }
    } catch (error) {
      console.error('Failed to fetch published status:', error);
      setPublishedBotId(null);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchPublishedStatus();
    }
  }, [isOpen, bot?.id]);

  const fetchPerformanceData = async () => {
    if (!bot) return;
    setPerformanceLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${bot.id}/performance?timeframe=${performanceTimeframe}&wallet=${walletAddress}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await safeResponseJson(res);
        setPerformanceData(data.series || []);
        setPerformanceTotalPnl(data.totalPnl || 0);
        setPerformanceTradeCount(data.tradeCount || 0);
      }
    } catch (error) {
      console.error('Failed to fetch performance data:', error);
    } finally {
      setPerformanceLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && bot) {
      fetchPerformanceData();
    }
  }, [isOpen, bot?.id, performanceTimeframe]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await fetchBotOverview();
    setLastUpdated(new Date());
    setIsRefreshing(false);
  };

  useEffect(() => {
    if (bot) {
      setLocalBot(bot);
      setEditName(bot.name);
      // Clamp leverage to market's max
      const maxLev = getMaxLeverage(bot.market);
      setEditLeverage(Math.min(bot.leverage, maxLev));
      // Convert stored maxPositionSize (leveraged) to investment amount (raw)
      const storedMaxPos = parseFloat(bot.maxPositionSize || '0');
      const investmentAmount = bot.leverage > 0 ? storedMaxPos / bot.leverage : storedMaxPos;
      setEditMaxPositionSize(investmentAmount > 0 ? investmentAmount.toFixed(2) : '');
      // Initialize profit reinvest, auto withdraw, and auto top-up settings
      setEditProfitReinvest(bot.profitReinvest ?? false);
      setEditAutoWithdrawThreshold(bot.autoWithdrawThreshold ?? '');
      setEditAutoTopUp(bot.autoTopUp ?? false);
      setEditAutoParkIdle(bot.autoParkIdle ?? false);
    }
  }, [bot]);

  const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      return null;
    }
  };

  // Consolidated fetch - uses single /api/bots/:id/overview endpoint
  // Reduces 6 API calls (7-8 RPC) to 1 API call (2-3 RPC)
  const fetchBotOverview = async () => {
    if (!bot) return;
    setBalanceLoading(true);
    setPositionLoading(true);
    setWebhookUrlLoading(true);
    setDataPartial(false); // Reset before fetching new data
    try {
      const cacheBust = Date.now();
      const res = await fetchWithTimeout(
        `/api/bots/${bot.id}/overview?wallet=${walletAddress}&_=${cacheBust}`, 
        { credentials: 'include', cache: 'no-store' }
      );
      
      if (res?.ok) {
        const data = await safeResponseJson(res);
        
        // Balance data
        setBotBalance(data.usdcBalance ?? 0);
        setParkedValueUsdc(data.parkedValueUsdc ?? 0);
        setMainAccountBalance(data.mainAccountBalance ?? 0);
        setExchangeBalance(data.totalCollateral ?? 0);
        setExchangeFreeCollateral(data.freeCollateral ?? 0);
        setHasOpenPositions(data.hasOpenPositions ?? false);
        setNetDeposited(data.netDeposited ?? 0);
        setHasBalanceLoaded(true);
        
        // Position data
        if (data.position) {
          setBotPosition(data.position);
        }
        setHasPositionLoaded(true);
        
        // Webhook URL
        if (data.webhookUrl) {
          setUserWebhookUrl(data.webhookUrl);
        }
        
        // Track partial data status (some RPC calls may have failed)
        setDataPartial(data.partialData ?? false);
        
        // Update bot status if changed (for auto-pause detection)
        if (data.isActive !== undefined || data.pauseReason !== undefined) {
          setLocalBot(prev => prev ? {
            ...prev,
            isActive: data.isActive ?? prev.isActive,
            pauseReason: data.pauseReason,
            autoTopUp: data.autoTopUp ?? prev.autoTopUp,
          } : prev);
        }
      }
    } catch (error) {
      console.error('Failed to fetch bot overview:', error);
    } finally {
      setBalanceLoading(false);
      setPositionLoading(false);
      setWebhookUrlLoading(false);
    }
  };

  // Legacy individual fetches kept for backwards compatibility and specific use cases
  const fetchUserWebhookUrl = async () => {
    setWebhookUrlLoading(true);
    try {
      const res = await fetch(`/api/user/webhook-url?wallet=${walletAddress}`, { credentials: 'include' });
      if (res.ok) {
        const data = await safeResponseJson(res);
        setUserWebhookUrl(data.webhookUrl);
      }
    } catch (error) {
      console.error('Failed to fetch user webhook URL:', error);
    } finally {
      setWebhookUrlLoading(false);
    }
  };

  const fetchBotPosition = async () => {
    if (!bot) return;
    setPositionLoading(true);
    try {
      const res = await fetchWithTimeout(`/api/trading-bots/${bot.id}/position?wallet=${walletAddress}`, { 
        credentials: 'include' 
      });
      if (res?.ok) {
        const data = await safeResponseJson(res);
        setBotPosition(data);
      }
    } catch (error) {
      console.error('Failed to fetch bot position:', error);
    } finally {
      setPositionLoading(false);
    }
  };

  const fetchBotBalance = async () => {
    if (!bot) return;
    setBalanceLoading(true);
    try {
      const cacheBust = Date.now();
      const [balanceRes, agentRes, botDriftRes, netDepositedRes] = await Promise.all([
        fetchWithTimeout(`/api/bot/${bot.id}/balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
        fetchWithTimeout(`/api/agent/balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
        fetchWithTimeout(`/api/bots/${bot.id}/balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
        fetchWithTimeout(`/api/bots/${bot.id}/net-deposited?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
      ]);

      if (balanceRes?.ok) {
        const data = await safeResponseJson(balanceRes);
        setBotBalance(data.usdcBalance ?? 0);
      }

      if (agentRes?.ok) {
        const data = await safeResponseJson(agentRes);
        setMainAccountBalance(data.balance ?? 0);
      }

      if (botDriftRes?.ok) {
        const data = await safeResponseJson(botDriftRes);
        setExchangeBalance(data.totalCollateral ?? data.balance ?? 0);
        setExchangeFreeCollateral(data.freeCollateral ?? 0);
        setHasOpenPositions(data.hasOpenPositions ?? false);
        setParkedValueUsdc(data.parkedValueUsdc ?? 0);
      }

      if (netDepositedRes?.ok) {
        const data = await safeResponseJson(netDepositedRes);
        setNetDeposited(data.netDeposited ?? 0);
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
    } finally {
      setBalanceLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && bot) {
      // Reset first-load tracking when drawer opens or bot changes
      setHasBalanceLoaded(false);
      setHasPositionLoaded(false);

      // Use consolidated endpoint for initial load and refreshes
      fetchBotOverview();
      setActiveTab('overview');
      
      // Auto-refresh every 15 seconds when drawer is open
      setLastUpdated(new Date());
      const refreshInterval = setInterval(() => {
        fetchBotOverview();
        setLastUpdated(new Date());
      }, 15000);
      
      return () => clearInterval(refreshInterval);
    } else if (!isOpen) {
      setHasBalanceLoaded(false);
      setHasPositionLoaded(false);
    }
  }, [isOpen, bot?.id]);

  useEffect(() => {
    if (isOpen && bot && (activeTab === 'history' || activeTab === 'overview')) {
      fetchTrades();
    }
    if (isOpen && bot && activeTab === 'history') {
      fetchEquityEvents();
    }
  }, [isOpen, bot?.id, activeTab]);

  const [addEquityStatus, setAddEquityStatus] = useState('');

  const handleAddEquity = async () => {
    const amount = parseFloat(addEquityAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return;
    }

    setAddEquityLoading(true);
    setAddEquityStatus('Depositing USDC on-chain...');
    try {
      const res = await fetch('/api/exchange/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount, botId: bot?.id }),
      });

      const data = await safeResponseJson(res);
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add to bot');
      }

      if (data.subaccountTransferWarning) {
        toast({ 
          title: 'Partial Success', 
          description: data.subaccountTransferWarning,
          variant: 'destructive',
        });
      } else {
        toast({ title: `Successfully added $${amount} to bot`, description: data.signature ? `Transaction: ${data.signature.slice(0, 8)}...` : 'Transfer complete' });
      }
      setAddEquityAmount('');

      setAddEquityStatus('Verifying balance...');
      const verifyBalance = async (retries: number, delay: number) => {
        for (let i = 0; i < retries; i++) {
          await new Promise(r => setTimeout(r, delay));
          await fetchBotOverview();
        }
      };
      await verifyBalance(3, 3000);
    } catch (error) {
      toast({ title: 'Failed to add to bot', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setAddEquityLoading(false);
      setAddEquityStatus('');
    }
  };

  const handleRemoveEquity = async () => {
    const amount = parseFloat(removeEquityAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return;
    }

    // Validate amount doesn't exceed withdrawable
    if (amount > exchangeFreeCollateral + 0.000001) {
      toast({ 
        title: 'Amount exceeds withdrawable balance', 
        description: `Maximum you can withdraw is $${exchangeFreeCollateral.toFixed(2)}`,
        variant: 'destructive' 
      });
      return;
    }

    setRemoveEquityLoading(true);
    try {
      const res = await fetch('/api/exchange/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount, botId: bot?.id }),
      });

      const data = await safeResponseJson(res);
      
      if (!res.ok) {
        let friendlyMessage = data.error || 'Failed to remove from bot';
        if (data.error?.includes('InsufficientCollateral') || data.error?.includes('0x1773')) {
          friendlyMessage = 'Not enough available balance. Try a smaller amount.';
        } else if (data.error?.includes('Simulation failed')) {
          friendlyMessage = 'Transaction would fail. Try a smaller amount.';
        }
        throw new Error(friendlyMessage);
      }

      toast({ title: `Successfully removed $${amount} from bot`, description: data.signature ? `Transaction: ${data.signature.slice(0, 8)}...` : 'Withdrawal complete' });
      setRemoveEquityAmount('');

      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 3000));
        await fetchBotOverview();
      }
    } catch (error) {
      toast({ title: 'Withdrawal failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setRemoveEquityLoading(false);
    }
  };

  const fetchTrades = async () => {
    if (!bot) return;
    setTradesLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${bot.id}/trades?wallet=${walletAddress}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await safeResponseJson(res);
        setTrades(data);
      }
    } catch (error) {
      console.error('Failed to fetch trades:', error);
    } finally {
      setTradesLoading(false);
    }
  };

  const fetchEquityEvents = async () => {
    if (!bot) return;
    setEquityEventsLoading(true);
    try {
      const res = await fetch(`/api/equity-events?limit=50&botId=${bot.id}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await safeResponseJson(res);
        setEquityEvents(data);
      }
    } catch (error) {
      console.error('Failed to fetch equity events:', error);
    } finally {
      setEquityEventsLoading(false);
    }
  };

  const getMessageTemplate = () => {
    if (!bot) return '';
    return `{
  "botId": "${bot.id}",
  "action": "{{strategy.order.action}}",
  "contracts": "{{strategy.order.contracts}}",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{timenow}}",
  "position_size": "{{strategy.position_size}}"
}`;
  };

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast({ title: `${field} copied to clipboard` });
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleNavigateToWalletManagement = () => {
    onClose();
    if (onShowWalletTab) {
      onShowWalletTab();
    }
  };

  const handlePauseResume = async () => {
    if (!localBot) return;
    setPauseLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}?wallet=${walletAddress}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: !localBot.isActive }),
      });

      if (!res.ok) {
        const data = await safeResponseJson(res);
        throw new Error(data.error || 'Failed to update bot');
      }

      const updatedBot = await safeResponseJson(res);
      setLocalBot(updatedBot);
      toast({
        title: updatedBot.isActive ? 'Bot resumed' : 'Bot paused',
        description: updatedBot.isActive ? 'Your bot is now active and will process signals' : 'Your bot is now paused and will not process signals',
      });
      onBotUpdated();
    } catch (error) {
      toast({
        title: 'Failed to update bot',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setPauseLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!localBot) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}?wallet=${walletAddress}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await safeResponseJson(res);
        throw new Error(data.error || data.message || 'Failed to delete bot');
      }

      toast({
        title: 'Bot deleted',
        description: `${localBot.name} has been permanently deleted`,
      });
      setDeleteDialogOpen(false);
      onClose();
      onBotUpdated();
    } catch (error) {
      toast({
        title: 'Failed to delete bot',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleClosePosition = async () => {
    console.log('[ClosePosition] Button clicked, localBot:', localBot?.id, 'walletAddress:', walletAddress);
    if (!localBot) {
      console.log('[ClosePosition] No localBot, returning early');
      return;
    }
    setClosePositionLoading(true);
    console.log('[ClosePosition] Making fetch request to:', `/api/trading-bots/${localBot.id}/close-position?wallet=${walletAddress}`);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}/close-position?wallet=${walletAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      const data = await safeResponseJson(res);

      if (!res.ok) {
        throw new Error(data.error || 'Failed to close position');
      }

      toast({
        title: 'Position closed',
        description: `Closed ${data.closedSize?.toFixed(4)} ${localBot.market} @ $${data.fillPrice?.toFixed(2)}`,
      });
      
      // Refresh position and balance data
      setTimeout(() => fetchBotOverview(), 1500);
      
      onBotUpdated();
    } catch (error) {
      toast({
        title: 'Failed to close position',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setClosePositionLoading(false);
    }
  };

  const handleSetTpSl = async () => {
    if (!localBot) return;
    const entryPrice = botPosition?.avgEntryPrice;
    if (!entryPrice || entryPrice <= 0) {
      toast({ title: 'Cannot set TP/SL', description: 'Entry price not available', variant: 'destructive' });
      return;
    }

    let takeProfitPrice: number | undefined;
    let stopLossPrice: number | undefined;

    if (tpInput) {
      const tpVal = parseFloat(tpInput);
      if (isNaN(tpVal) || tpVal <= 0) {
        toast({ title: 'Invalid take profit', description: 'Enter a valid positive number', variant: 'destructive' });
        return;
      }
      if (tpslMode === 'percent') {
        const multiplier = botPosition?.side === 'LONG' ? 1 + tpVal / 100 : 1 - tpVal / 100;
        takeProfitPrice = parseFloat((entryPrice * multiplier).toFixed(4));
      } else {
        takeProfitPrice = tpVal;
      }
    }

    if (slInput) {
      const slVal = parseFloat(slInput);
      if (isNaN(slVal) || slVal <= 0) {
        toast({ title: 'Invalid stop loss', description: 'Enter a valid positive number', variant: 'destructive' });
        return;
      }
      if (tpslMode === 'percent') {
        const multiplier = botPosition?.side === 'LONG' ? 1 - slVal / 100 : 1 + slVal / 100;
        stopLossPrice = parseFloat((entryPrice * multiplier).toFixed(4));
      } else {
        stopLossPrice = slVal;
      }
    }

    if (!takeProfitPrice && !stopLossPrice) {
      toast({ title: 'Enter a value', description: 'Set at least a take profit or stop loss', variant: 'destructive' });
      return;
    }

    setTpslLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}/set-tpsl?wallet=${walletAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ takeProfitPrice, stopLossPrice }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to set TP/SL');

      const appliedTp: number | null = data.appliedTakeProfitPrice ?? null;
      const appliedSl: number | null = data.appliedStopLossPrice ?? null;
      if (appliedTp != null) setActiveTp(appliedTp);
      if (appliedSl != null) setActiveSl(appliedSl);

      const baseDesc = [
        appliedTp != null ? `TP: $${formatPrice(appliedTp)}` : '',
        appliedSl != null ? `SL: $${formatPrice(appliedSl)}` : '',
      ].filter(Boolean).join(' | ');
      const dropped: Array<{ leg: 'tp' | 'sl' }> = data.droppedLegs ?? [];
      toast({
        title: data.warning ? 'TP/SL partially set' : 'TP/SL set',
        description: data.warning ? `${baseDesc} — ${data.warning}` : baseDesc,
        variant: data.warning ? 'destructive' : undefined,
      });
      // Clear inputs only for legs that were actually applied; keep rejected
      // leg's input populated so the user can correct and resubmit.
      const tpDropped = dropped.some(l => l.leg === 'tp');
      const slDropped = dropped.some(l => l.leg === 'sl');
      if (!tpDropped) setTpInput('');
      if (!slDropped) setSlInput('');
      if (!data.warning) setTpslOpen(false);
    } catch (error) {
      toast({
        title: 'Failed to set TP/SL',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setTpslLoading(false);
    }
  };

  const handleCancelTpSl = async () => {
    if (!localBot) return;
    setTpslCancelLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}/cancel-tpsl?wallet=${walletAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to cancel TP/SL');

      setActiveTp(null);
      setActiveSl(null);
      toast({ title: 'TP/SL cleared', description: 'Take profit and stop loss removed' });
    } catch (error) {
      toast({
        title: 'Failed to clear TP/SL',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setTpslCancelLoading(false);
    }
  };

  const bindAgentWallet = async (): Promise<boolean> => {
    try {
      if (!wallet.signMessage || !wallet.publicKey) {
        toast({ title: 'Wallet not connected', description: 'Please connect your wallet to authorize the agent.', variant: 'destructive' });
        return false;
      }
      toast({ title: 'Authorizing agent wallet...', description: 'Please approve the signing request in your wallet.' });
      const prepareRes = await fetch('/api/agent/prepare-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!prepareRes.ok) {
        const err = await safeResponseJson(prepareRes);
        throw new Error(err.error || 'Failed to prepare bind');
      }
      const { message } = await prepareRes.json();
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      const confirmRes = await fetch('/api/agent/confirm-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ signature: signatureBase58 }),
      });
      if (!confirmRes.ok) {
        const err = await safeResponseJson(confirmRes);
        throw new Error(err.error || 'Failed to bind agent wallet');
      }
      toast({ title: 'Agent wallet authorized', description: 'Your bot can now execute trades.' });
      return true;
    } catch (error: any) {
      if (error?.message?.includes('User rejected')) {
        toast({ title: 'Signing cancelled', description: 'You declined the wallet signing request.', variant: 'destructive' });
      } else {
        toast({ title: 'Authorization failed', description: error.message, variant: 'destructive' });
      }
      return false;
    }
  };

  const handleManualTrade = async (side: 'long' | 'short') => {
    if (!localBot) return;
    setManualTradeLoading(side);
    try {
      let res = await fetch(`/api/trading-bots/${localBot.id}/manual-trade?wallet=${walletAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ side }),
      });

      let data = await safeResponseJson(res);

      if (!res.ok && data.error?.includes('unauthorized to sign on behalf of')) {
        const bound = await bindAgentWallet();
        if (!bound) {
          setManualTradeLoading(null);
          return;
        }
        res = await fetch(`/api/trading-bots/${localBot.id}/manual-trade?wallet=${walletAddress}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ side }),
        });
        data = await safeResponseJson(res);
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to execute trade');
      }

      toast({
        title: `${side.toUpperCase()} opened`,
        description: `${data.size?.toFixed(4)} ${localBot.market} @ $${data.price?.toFixed(2)}`,
      });
      
      setTimeout(() => fetchBotOverview(), 1500);
      
      onBotUpdated();
    } catch (error) {
      toast({
        title: 'Trade failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setManualTradeLoading(null);
    }
  };

  const handleRefreshPosition = async () => {
    if (!localBot) return;
    setRefreshPositionLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}/refresh-position?wallet=${walletAddress}`, {
        method: 'POST',
        credentials: 'include',
      });

      const data = await safeResponseJson(res);

      if (!res.ok) {
        throw new Error(data.error || 'Failed to refresh position');
      }

      toast({
        title: 'Position refreshed',
        description: 'Entry price updated from blockchain',
      });
      
      // Refresh position data
      fetchBotOverview();
    } catch (error) {
      toast({
        title: 'Refresh failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRefreshPositionLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!localBot) return;
    
    const maxLev = getMaxLeverage(localBot.market);
    if (editLeverage < 1 || editLeverage > maxLev) {
      toast({ title: `Leverage must be between 1 and ${maxLev}x for ${localBot.market}`, variant: 'destructive' });
      return;
    }
    
    if (!editName.trim()) {
      toast({ title: 'Bot name is required', variant: 'destructive' });
      return;
    }
    
    // Validate investment amount doesn't exceed available funds
    // When Auto Top-Up is enabled, can use bot balance + agent wallet balance
    // Use small tolerance (0.01) to handle floating point precision when clicking "Max"
    const investmentValue = editMaxPositionSize ? parseFloat(editMaxPositionSize) : 0;
    const tolerance = 0.01;
    const maxAvailable = editAutoTopUp ? (botBalance + mainAccountBalance) : botBalance;
    
    if (investmentValue > 0 && maxAvailable > 0 && investmentValue > maxAvailable + tolerance) {
      if (editAutoTopUp) {
        toast({ 
          title: 'Investment too high', 
          description: `Total available is $${maxAvailable.toFixed(2)} (bot: $${botBalance.toFixed(2)} + agent wallet: $${mainAccountBalance.toFixed(2)})`,
          variant: 'destructive' 
        });
      } else {
        toast({ 
          title: 'Investment too high', 
          description: `Bot only has $${botBalance.toFixed(2)} available. Enable Auto Top-Up to use agent wallet funds, or click "Max".`,
          variant: 'destructive' 
        });
      }
      return;
    }
    
    // Calculate leveraged max position size (investment × leverage) for backend
    const calculatedMaxPosition = investmentValue * editLeverage;
    
    setSaveSettingsLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}?wallet=${walletAddress}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          name: editName.trim(),
          leverage: editLeverage,
          maxPositionSize: calculatedMaxPosition > 0 ? calculatedMaxPosition : null,
          profitReinvest: editProfitReinvest,
          autoWithdrawThreshold: editAutoWithdrawThreshold ? parseFloat(editAutoWithdrawThreshold) : null,
          autoTopUp: editAutoTopUp,
          autoParkIdle: editAutoParkIdle,
        }),
      });

      if (!res.ok) {
        const data = await safeResponseJson(res);
        throw new Error(data.error || 'Failed to save settings');
      }

      const updatedBot = await safeResponseJson(res);
      setLocalBot(updatedBot);
      toast({
        title: 'Settings saved',
        description: 'Bot settings have been updated successfully',
      });
      onBotUpdated();
    } catch (error) {
      toast({
        title: 'Failed to save settings',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSaveSettingsLoading(false);
    }
  };

  const handleCancelEdit = () => {
    if (localBot) {
      setEditName(localBot.name);
      // Clamp leverage to market's max when resetting
      const maxLev = getMaxLeverage(localBot.market);
      setEditLeverage(Math.min(localBot.leverage, maxLev));
      // Convert stored maxPositionSize (leveraged) to investment amount (raw)
      const storedMaxPos = parseFloat(localBot.maxPositionSize || '0');
      const investmentAmount = localBot.leverage > 0 ? storedMaxPos / localBot.leverage : storedMaxPos;
      setEditMaxPositionSize(investmentAmount > 0 ? investmentAmount.toFixed(2) : '');
      // Reset profit reinvest, auto withdraw, and auto top-up settings
      setEditProfitReinvest(localBot.profitReinvest ?? false);
      setEditAutoWithdrawThreshold(localBot.autoWithdrawThreshold ?? '');
      setEditAutoTopUp(localBot.autoTopUp ?? false);
      setEditAutoParkIdle(localBot.autoParkIdle ?? false);
    }
  };

  // Compare investment amounts (convert stored leveraged value to raw for comparison)
  const getStoredInvestmentAmount = () => {
    if (!localBot?.maxPositionSize) return '';
    const storedMaxPos = parseFloat(localBot.maxPositionSize);
    const investment = localBot.leverage > 0 ? storedMaxPos / localBot.leverage : storedMaxPos;
    return investment > 0 ? investment.toFixed(2) : '';
  };
  
  const hasSettingsChanges = localBot ? (
    editName !== localBot.name || 
    editLeverage !== Math.min(localBot.leverage, getMaxLeverage(localBot.market)) || 
    editMaxPositionSize !== getStoredInvestmentAmount() ||
    editProfitReinvest !== (localBot.profitReinvest ?? false) ||
    editAutoWithdrawThreshold !== (localBot.autoWithdrawThreshold ?? '') ||
    editAutoTopUp !== (localBot.autoTopUp ?? false) ||
    editAutoParkIdle !== (localBot.autoParkIdle ?? false)
  ) : false;

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // Win rate is undefined (not 0) when no realized trades exist so consumers
  // can render "—" instead of a misleading "0.0%". Always returns a number
  // (or undefined), never NaN.
  const getWinRate = (): number | undefined => {
    const stats = localBot?.stats || bot?.stats;
    if (!stats) return undefined;
    const wins = stats.winningTrades || 0;
    const losses = stats.losingTrades || 0;
    const realizedTrades = wins + losses;
    if (realizedTrades === 0) return undefined;
    const rate = (wins / realizedTrades) * 100;
    return isNaN(rate) ? undefined : rate;
  };
  const formatWinRate = () => {
    const r = getWinRate();
    return r === undefined ? '—' : r.toFixed(1) + '%';
  };

  const displayBot = localBot || bot;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()} modal={false}>
      <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto" data-testid="drawer-bot-management">
        {displayBot && (
        <>
        <SheetHeader className="space-y-3 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <SheetTitle className="text-lg" data-testid="text-bot-name">{displayBot.name}</SheetTitle>
                <SheetDescription className="text-sm flex items-center gap-1.5" data-testid="text-bot-market">
                  <span>{displayBot.market}</span>
                  <ExchangeBadge protocol={displayBot.activeProtocol} />
                </SheetDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={(localBot?.isActive ?? displayBot?.isActive) ? 'default' : 'secondary'}
                className={(localBot?.isActive ?? displayBot?.isActive) ? 'bg-emerald-500' : ''}
                data-testid="badge-bot-status"
              >
                {(localBot?.isActive ?? displayBot?.isActive) ? 'Active' : 'Inactive'}
              </Badge>
              <Button
                variant={(localBot?.isActive ?? displayBot?.isActive) ? 'outline' : 'default'}
                size="icon"
                onClick={handlePauseResume}
                disabled={pauseLoading}
                data-testid="button-pause-resume"
                className="group w-9 h-9 hover:w-[85px] transition-[width] duration-150 ease-out overflow-hidden"
              >
                <span className="flex items-center justify-center w-full">
                  {pauseLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (localBot?.isActive ?? displayBot?.isActive) ? (
                    <>
                      <Pause className="w-4 h-4 flex-shrink-0" />
                      <span className="w-0 opacity-0 group-hover:w-[45px] group-hover:opacity-100 group-hover:ml-1.5 transition-[width,opacity] duration-150 ease-out overflow-hidden whitespace-nowrap text-sm">Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 flex-shrink-0" />
                      <span className="w-0 opacity-0 group-hover:w-[50px] group-hover:opacity-100 group-hover:ml-1.5 transition-[width,opacity] duration-150 ease-out overflow-hidden whitespace-nowrap text-sm">Resume</span>
                    </>
                  )}
                </span>
              </Button>
              {!displayBot?.sourcePublishedBotId && (
                <Button 
                  variant="default" 
                  size="icon"
                  onClick={() => setPublishModalOpen(true)}
                  className="group w-9 h-9 hover:w-[80px] transition-[width] duration-150 ease-out overflow-hidden bg-gradient-to-r from-primary to-accent hover:opacity-90"
                  data-testid="button-share"
                >
                  <span className="flex items-center justify-center w-full">
                    <Share2 className="w-4 h-4 flex-shrink-0" />
                    <span className="w-0 opacity-0 group-hover:w-[40px] group-hover:opacity-100 group-hover:ml-1.5 transition-[width,opacity] duration-150 ease-out overflow-hidden whitespace-nowrap text-sm">Share</span>
                  </span>
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="w-full grid grid-cols-5" data-testid="tabs-bot-management">
            <TabsTrigger value="overview" data-testid="tab-overview" className="text-xs px-2">
              <BarChart3 className="w-4 h-4 mr-1" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="equity" data-testid="tab-equity" className="text-xs px-2">
              <Wallet className="w-4 h-4 mr-1" />
              Equity
            </TabsTrigger>
            <TabsTrigger value="webhook" data-testid="tab-webhook" className="text-xs px-2">
              <Webhook className="w-4 h-4 mr-1" />
              Webhook
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history" className="text-xs px-2">
              <History className="w-4 h-4 mr-1" />
              History
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings" className="text-xs px-2">
              <Settings className="w-4 h-4 mr-1" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 mt-4">
            {/* Pause reason warning banner */}
            {displayBot?.pauseReason && !displayBot?.isActive && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-amber-500">Bot Paused - Insufficient Margin</p>
                  <p className="text-xs text-muted-foreground">{displayBot.pauseReason}</p>
                  <div className="flex gap-2 mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => onShowWalletTab?.()}
                      data-testid="button-add-funds"
                    >
                      <Wallet className="w-3 h-3 mr-1" />
                      Add Funds
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setActiveTab('settings')}
                      data-testid="button-enable-auto-topup"
                    >
                      <Settings className="w-3 h-3 mr-1" />
                      Enable Auto Top-Up
                    </Button>
                  </div>
                </div>
              </div>
            )}
            
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Auto-updates every 15s'}
                </p>
                {dataPartial && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="text-xs text-amber-500">Partial data</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Some data may be delayed due to network issues</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleManualRefresh}
                disabled={isRefreshing || balanceLoading}
                className="h-6 px-2"
                data-testid="button-refresh-balance"
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border">
                <div className="flex items-center gap-1">
                  <p className="text-sm text-muted-foreground">Bot Equity</p>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Current trading account balance (Total Collateral)</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {parkedValueUsdc > 0 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Vault className="w-3 h-3 text-purple-400" data-testid="icon-bot-equity-parked" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Includes ${parkedValueUsdc.toFixed(2)} parked in Vault, earning yield</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                <p className="text-2xl font-bold mt-1" data-testid="text-bot-equity">
                  {balanceLoading && !hasBalanceLoaded ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    `$${(exchangeBalance + parkedValueUsdc).toFixed(2)}`
                  )}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-muted/50 border">
                <div className="flex items-center gap-1">
                  <p className="text-sm text-muted-foreground">Net P&L</p>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>True performance including all fees & funding</p>
                        <p className="text-xs text-muted-foreground">Bot Equity - Total Deposited</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    ((exchangeBalance + parkedValueUsdc) - netDeposited) >= 0 ? 'text-emerald-500' : 'text-red-500'
                  }`}
                  data-testid="text-net-pnl"
                >
                  {balanceLoading && !hasBalanceLoaded ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    `${((exchangeBalance + parkedValueUsdc) - netDeposited) >= 0 ? '+' : ''}$${((exchangeBalance + parkedValueUsdc) - netDeposited).toFixed(2)}`
                  )}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-muted/50 border">
                <div className="flex items-center gap-1">
                  <p className="text-sm text-muted-foreground">Net Return</p>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Net P&L as % of deposited amount</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    ((exchangeBalance + parkedValueUsdc) - netDeposited) >= 0 ? 'text-emerald-500' : 'text-red-500'
                  }`}
                  data-testid="text-return-pct"
                >
                  {balanceLoading && !hasBalanceLoaded ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : netDeposited > 0 ? (
                    `${((((exchangeBalance + parkedValueUsdc) - netDeposited) / netDeposited) * 100).toFixed(2)}%`
                  ) : (
                    '0%'
                  )}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Total Trades</p>
                <p className="text-lg font-semibold mt-1" data-testid="text-total-trades">
                  {(displayBot as any)?.actualTradeCount ?? displayBot?.stats?.totalTrades ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className="text-lg font-semibold mt-1 text-emerald-500" data-testid="text-win-rate">
                  {formatWinRate()}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Leverage</p>
                <p className="text-lg font-semibold mt-1" data-testid="text-leverage">{localBot?.leverage ?? displayBot?.leverage}x</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <div className="flex items-center justify-center gap-1">
                  <p className="text-xs text-muted-foreground">Volume</p>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Total traded volume across all executed trades</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-lg font-semibold mt-1 text-primary" data-testid="text-volume">
                  ${((displayBot?.stats?.totalVolume ?? 0)).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </p>
              </div>
            </div>
            
            {(() => {
              const liquidationTrades = trades.filter(t => t.status === 'liquidated');
              if (liquidationTrades.length === 0) return null;
              const totalLiquidationLoss = liquidationTrades.reduce((sum, t) => sum + parseFloat(t.pnl || '0'), 0);
              return (
                <div className="p-3 rounded-lg border border-orange-500/30 bg-orange-500/5" data-testid="liquidation-summary">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-semibold text-orange-500">Liquidation Events</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {liquidationTrades.length} liquidation{liquidationTrades.length > 1 ? 's' : ''} detected — estimated total loss: <span className="text-orange-500 font-medium">${Math.abs(totalLiquidationLoss).toFixed(2)}</span>
                  </p>
                </div>
              );
            })()}

            {/* Current Position Section */}
            <div className="p-4 rounded-xl border bg-muted/20">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  <h3 className="font-semibold text-sm">Current Position</h3>
                </div>
                {/* Manual Trade Buttons */}
                {localBot?.isActive && !botPosition?.hasPosition && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-500"
                      onClick={() => handleManualTrade('long')}
                      disabled={manualTradeLoading !== null}
                      data-testid="button-manual-long"
                    >
                      {manualTradeLoading === 'long' ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <ArrowUp className="w-3 h-3 mr-1" />
                          Long
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs bg-red-500/10 border-red-500/30 hover:bg-red-500/20 text-red-500"
                      onClick={() => handleManualTrade('short')}
                      disabled={manualTradeLoading !== null}
                      data-testid="button-manual-short"
                    >
                      {manualTradeLoading === 'short' ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <ArrowDown className="w-3 h-3 mr-1" />
                          Short
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
              
              {positionLoading && !hasPositionLoaded ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : botPosition?.hasPosition ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge 
                        className={botPosition.side === 'LONG' ? 'bg-emerald-500' : 'bg-red-500'}
                        data-testid="badge-position-side"
                      >
                        {botPosition.side === 'LONG' ? (
                          <ArrowUp className="w-3 h-3 mr-1" />
                        ) : (
                          <ArrowDown className="w-3 h-3 mr-1" />
                        )}
                        {botPosition.side}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{botPosition.market}</span>
                    </div>
                    <span className="font-mono font-semibold" data-testid="text-position-size">
                      {botPosition.size?.toFixed(4)} contracts
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-2 rounded-lg bg-background/50">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Entry Price</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-4 w-4 p-0 hover:bg-transparent"
                          onClick={handleRefreshPosition}
                          disabled={refreshPositionLoading}
                          title="Refresh from blockchain"
                          data-testid="button-refresh-position"
                        >
                          <RefreshCw className={`w-3 h-3 text-muted-foreground hover:text-foreground ${refreshPositionLoading ? 'animate-spin' : ''}`} />
                        </Button>
                      </div>
                      <p className="font-mono font-semibold" data-testid="text-entry-price">
                        ${formatPrice(botPosition.avgEntryPrice)}
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">Current Price</p>
                      <p className="font-mono font-semibold" data-testid="text-current-price">
                        ${formatPrice(botPosition.currentPrice)}
                      </p>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
                      <p className="text-xs text-muted-foreground">Position Value</p>
                      <p className="font-mono font-bold text-lg" data-testid="text-position-value">
                        ${((botPosition.size ?? 0) * (botPosition.currentPrice ?? 0)).toFixed(2)}
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">Unrealized P&L</p>
                      <p 
                        className={`font-mono font-bold text-lg ${
                          (botPosition.unrealizedPnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                        }`}
                        data-testid="text-unrealized-pnl"
                      >
                        {(botPosition.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${botPosition.unrealizedPnl?.toFixed(2)}
                      </p>
                    </div>
                  </div>
                  
                  {/* Health Metrics */}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">Health Factor</p>
                      <p 
                        className={`font-mono font-semibold ${
                          (botPosition.healthFactor ?? 100) >= 50 ? 'text-emerald-500' :
                          (botPosition.healthFactor ?? 100) >= 20 ? 'text-amber-500' : 'text-red-500'
                        }`}
                        data-testid="text-bot-health"
                      >
                        {botPosition.healthFactor !== undefined ? `${botPosition.healthFactor.toFixed(0)}%` : '--'}
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">Liq. Price</p>
                      <p className="font-mono font-semibold text-amber-500" data-testid="text-liq-price">
                        {botPosition.liquidationPrice ? `$${formatPrice(botPosition.liquidationPrice)}` : '--'}
                      </p>
                    </div>
                  </div>
                  
                  {botPosition.totalCollateral !== undefined && (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="p-2 rounded-lg bg-background/50">
                        <p className="text-xs text-muted-foreground">Total Collateral</p>
                        <p className="font-mono font-semibold" data-testid="text-bot-collateral">
                          ${botPosition.totalCollateral.toFixed(2)}
                        </p>
                      </div>
                      <div className="p-2 rounded-lg bg-background/50">
                        <p className="text-xs text-muted-foreground">Free Collateral</p>
                        <p className="font-mono font-semibold text-muted-foreground" data-testid="text-free-collateral">
                          ${botPosition.freeCollateral?.toFixed(2) ?? '--'}
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {(activeTp || activeSl) && (
                    <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm" data-testid="tpsl-active-banner">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <div className="flex-1 font-mono text-xs">
                        {activeTp && <span className="text-emerald-500" data-testid="text-active-tp">TP: ${formatPrice(activeTp)}</span>}
                        {activeTp && activeSl && <span className="text-muted-foreground mx-1">|</span>}
                        {activeSl && <span className="text-red-500" data-testid="text-active-sl">SL: ${formatPrice(activeSl)}</span>}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 p-0"
                        onClick={handleCancelTpSl}
                        disabled={tpslCancelLoading}
                        data-testid="button-cancel-tpsl"
                      >
                        {tpslCancelLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3 text-muted-foreground hover:text-foreground" />}
                      </Button>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTpslOpen(!tpslOpen)}
                    className="w-full"
                    data-testid="button-toggle-tpsl"
                  >
                    <Settings className="w-3.5 h-3.5 mr-2" />
                    {tpslOpen ? 'Hide' : 'Set'} TP / SL
                  </Button>

                  {tpslOpen && (
                    <div className="space-y-3 p-3 rounded-lg border border-border/50 bg-background/30" data-testid="tpsl-form">
                      <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
                        <button
                          className={`flex-1 text-xs py-1 px-2 rounded transition-colors ${tpslMode === 'percent' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
                          onClick={() => setTpslMode('percent')}
                          data-testid="button-tpsl-mode-percent"
                        >
                          Percentage
                        </button>
                        <button
                          className={`flex-1 text-xs py-1 px-2 rounded transition-colors ${tpslMode === 'price' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
                          onClick={() => setTpslMode('price')}
                          data-testid="button-tpsl-mode-price"
                        >
                          Price
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-emerald-500 font-medium mb-1 block">
                            Take Profit {tpslMode === 'percent' ? '(%)' : '($)'}
                          </label>
                          <Input
                            type="number"
                            step={tpslMode === 'percent' ? '0.5' : '0.01'}
                            min="0"
                            placeholder={tpslMode === 'percent' ? '2.0' : formatPrice(botPosition?.avgEntryPrice)}
                            value={tpInput}
                            onChange={(e) => setTpInput(e.target.value)}
                            className="h-8 text-sm font-mono"
                            data-testid="input-tp"
                          />
                          {tpInput && botPosition?.avgEntryPrice && (() => {
                            const o = computeTpSlOutcome(tpInput, tpslMode, 'tp', botPosition.side, botPosition.avgEntryPrice, botPosition.size);
                            if (!o) return null;
                            return (
                              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono space-x-1" data-testid="text-tp-preview">
                                <span>{tpslMode === 'percent' ? `= $${formatPrice(o.targetPrice)}` : `${o.movePct.toFixed(2)}% move`}</span>
                                {o.pnl !== null && (
                                  <span className={o.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'} data-testid="text-tp-pnl">· {formatUsdSigned(o.pnl)}</span>
                                )}
                              </p>
                            );
                          })()}
                        </div>
                        <div>
                          <label className="text-xs text-red-500 font-medium mb-1 block">
                            Stop Loss {tpslMode === 'percent' ? '(%)' : '($)'}
                          </label>
                          <Input
                            type="number"
                            step={tpslMode === 'percent' ? '0.5' : '0.01'}
                            min="0"
                            placeholder={tpslMode === 'percent' ? '1.0' : formatPrice(botPosition?.avgEntryPrice)}
                            value={slInput}
                            onChange={(e) => setSlInput(e.target.value)}
                            className="h-8 text-sm font-mono"
                            data-testid="input-sl"
                          />
                          {slInput && botPosition?.avgEntryPrice && (() => {
                            const o = computeTpSlOutcome(slInput, tpslMode, 'sl', botPosition.side, botPosition.avgEntryPrice, botPosition.size);
                            if (!o) return null;
                            return (
                              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono space-x-1" data-testid="text-sl-preview">
                                <span>{tpslMode === 'percent' ? `= $${formatPrice(o.targetPrice)}` : `${o.movePct.toFixed(2)}% move`}</span>
                                {o.pnl !== null && (
                                  <span className={o.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'} data-testid="text-sl-pnl">· {formatUsdSigned(o.pnl)}</span>
                                )}
                              </p>
                            );
                          })()}
                        </div>
                      </div>

                      <Button
                        size="sm"
                        onClick={handleSetTpSl}
                        disabled={tpslLoading || (!tpInput && !slInput)}
                        className="w-full"
                        data-testid="button-submit-tpsl"
                      >
                        {tpslLoading ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                            Setting...
                          </>
                        ) : (
                          'Set TP / SL on Exchange'
                        )}
                      </Button>
                    </div>
                  )}

                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleClosePosition}
                    disabled={closePositionLoading}
                    className="w-full"
                    data-testid="button-close-position"
                  >
                    {closePositionLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Closing Position...
                      </>
                    ) : (
                      <>
                        <XCircle className="w-4 h-4 mr-2" />
                        Close Position
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="text-center py-4 text-muted-foreground">
                  <p className="text-sm">No open position</p>
                  <p className="text-xs mt-1">Position will appear when bot executes a trade</p>
                </div>
              )}
            </div>

            <div className="p-4 rounded-xl border bg-muted/20" data-testid="performance-chart-container">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium">Performance Chart</p>
                <div className="flex gap-1">
                  {(['7d', '30d', '90d', 'all'] as const).map((tf) => (
                    <Button
                      key={tf}
                      variant={performanceTimeframe === tf ? 'default' : 'outline'}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setPerformanceTimeframe(tf)}
                      data-testid={`button-timeframe-${tf}`}
                    >
                      {tf === 'all' ? 'All' : tf.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>
              {performanceLoading ? (
                <div className="h-[130px] flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : performanceData.length === 0 ? (
                <div className="h-[130px] flex items-center justify-center rounded-lg bg-muted/50 border border-dashed">
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No executed trades yet</p>
                  </div>
                </div>
              ) : (
                <div className="h-[130px]" data-testid="performance-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart 
                      data={performanceView === 'percent' && netDeposited > 0
                        ? performanceData.map(d => ({ ...d, cumulativePnlPercent: (d.cumulativePnl / netDeposited) * 100 }))
                        : performanceData
                      } 
                      margin={{ top: 5, right: 5, left: -20, bottom: 5 }}
                    >
                      <XAxis
                        dataKey="timestamp"
                        tick={{ fontSize: 10 }}
                        tickFormatter={(value) => {
                          const d = new Date(value);
                          return `${d.getMonth() + 1}/${d.getDate()}`;
                        }}
                        stroke="#888"
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(value) => performanceView === 'percent' 
                          ? `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`
                          : `$${value >= 0 ? '+' : ''}${value.toFixed(0)}`
                        }
                        stroke="#888"
                        axisLine={false}
                        tickLine={false}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: number) => [
                          performanceView === 'percent'
                            ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
                            : `$${value >= 0 ? '+' : ''}${value.toFixed(2)}`,
                          'PnL'
                        ]}
                      />
                      <Line
                        type="monotone"
                        dataKey={performanceView === 'percent' ? 'cumulativePnlPercent' : 'cumulativePnl'}
                        stroke={performanceTotalPnl >= 0 ? '#22c55e' : '#ef4444'}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
                <div className="flex gap-1" data-testid="toggle-performance-view">
                  <Button
                    variant={performanceView === 'dollar' ? 'default' : 'outline'}
                    size="sm"
                    className="h-5 px-2 text-xs"
                    onClick={() => setPerformanceView('dollar')}
                  >
                    $
                  </Button>
                  <Button
                    variant={performanceView === 'percent' ? 'default' : 'outline'}
                    size="sm"
                    className="h-5 px-2 text-xs"
                    onClick={() => setPerformanceView('percent')}
                  >
                    %
                  </Button>
                </div>
                <span>{performanceTradeCount} trade{performanceTradeCount !== 1 ? 's' : ''}</span>
                <span className={performanceTotalPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                  {performanceView === 'percent' && netDeposited > 0
                    ? `${performanceTotalPnl >= 0 ? '+' : ''}${((performanceTotalPnl / netDeposited) * 100).toFixed(2)}%`
                    : `${performanceTotalPnl >= 0 ? '+' : ''}$${performanceTotalPnl.toFixed(2)}`
                  }
                </span>
              </div>
              
              <div className="mt-3 pt-3 border-t border-border/50">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs gap-2"
                  onClick={() => {
                    setShareCardOpen(true);
                    void fetchPerformanceData();
                    void fetchBotOverview();
                  }}
                  data-testid="button-share-performance"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share Performance Card
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="equity" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Agent Wallet</p>
                    <p className="text-2xl font-bold mt-1" data-testid="text-agent-balance">
                      {balanceLoading && !hasBalanceLoaded ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        `$${mainAccountBalance.toFixed(2)}`
                      )}
                    </p>
                  </div>
                  <Wallet className="w-8 h-8 text-primary/50" />
                </div>
              </div>
              <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-primary/10 border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1">
                      <p className="text-sm text-muted-foreground">Bot Balance</p>
                      {parkedValueUsdc > 0 && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger>
                              <Vault className="w-3 h-3 text-purple-400" data-testid="icon-parked-value" />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Includes ${parkedValueUsdc.toFixed(2)} parked in Vault, earning yield</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                    <p className="text-2xl font-bold mt-1" data-testid="text-trading-balance">
                      {balanceLoading && !hasBalanceLoaded ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        `$${(botBalance + parkedValueUsdc).toFixed(2)}`
                      )}
                    </p>
                  </div>
                  <BarChart3 className="w-8 h-8 text-emerald-500/50" />
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
              <div className="flex items-center gap-2">
                <ArrowUp className="w-4 h-4 text-emerald-500" />
                <h3 className="font-semibold text-sm">Add to Bot</h3>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    type="number"
                    placeholder="Amount (USDC)"
                    value={addEquityAmount}
                    onChange={(e) => setAddEquityAmount(e.target.value)}
                    className="pr-16"
                    data-testid="input-add-equity"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 px-2 text-xs"
                    onClick={() => setAddEquityAmount(mainAccountBalance.toString())}
                    data-testid="button-add-max"
                  >
                    Max
                  </Button>
                </div>
                <Button
                  onClick={handleAddEquity}
                  disabled={addEquityLoading || !addEquityAmount}
                  data-testid="button-add-equity"
                >
                  {addEquityLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
                </Button>
              </div>
              {addEquityStatus ? (
                <p className="text-xs text-amber-500 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {addEquityStatus}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Transfer USDC from your wallet to the bot for trading
                </p>
              )}
            </div>

            <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
              <div className="flex items-center gap-2">
                <ArrowDown className="w-4 h-4 text-orange-500" />
                <h3 className="font-semibold text-sm">Remove from Bot</h3>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    type="number"
                    placeholder="Amount (USDC)"
                    value={removeEquityAmount}
                    onChange={(e) => setRemoveEquityAmount(e.target.value)}
                    className="pr-16"
                    data-testid="input-remove-equity"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 px-2 text-xs"
                    onClick={() => {
                      // Floor to 2 decimal places (cents) for clean display values
                      const maxWithdrawable = Math.floor(exchangeFreeCollateral * 100) / 100;
                      setRemoveEquityAmount(maxWithdrawable.toString());
                    }}
                    data-testid="button-remove-max"
                  >
                    Max
                  </Button>
                </div>
                <Button
                  onClick={handleRemoveEquity}
                  disabled={removeEquityLoading || !removeEquityAmount || parseFloat(removeEquityAmount) > exchangeFreeCollateral + 0.000001}
                  variant="outline"
                  data-testid="button-remove-equity"
                >
                  {removeEquityLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Remove'}
                </Button>
              </div>
              {removeEquityAmount && parseFloat(removeEquityAmount) > exchangeFreeCollateral + 0.000001 && (
                <p className="text-xs text-red-500">
                  Amount exceeds max withdrawable (${exchangeFreeCollateral.toFixed(2)})
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Withdraw USDC from the bot back to your wallet
              </p>
              {displayBot?.activeProtocol === 'pacifica' && (
                <div
                  className="text-xs text-amber-500/90 flex items-start gap-1 leading-relaxed bg-amber-500/5 border border-amber-500/20 rounded-md px-2.5 py-1.5"
                  data-testid="text-remove-equity-fee-notice"
                >
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    Pacifica charges a flat <span className="font-medium">$1 USDC</span> fee per on-chain withdrawal.
                    {removeEquityAmount && parseFloat(removeEquityAmount) > 1 && (
                      <>
                        {' '}You'll receive{' '}
                        <span className="font-mono font-medium" data-testid="text-remove-equity-net-amount">
                          ${(parseFloat(removeEquityAmount) - 1).toFixed(2)}
                        </span>{' '}
                        in your wallet.
                      </>
                    )}{' '}
                    This fee is charged by the exchange — not QuantumVault.
                  </span>
                </div>
              )}
              {hasOpenPositions && exchangeBalance > exchangeFreeCollateral && (
                <p className="text-xs text-amber-500">
                  Note: ${(exchangeBalance - exchangeFreeCollateral).toFixed(2)} is locked as margin for open positions
                </p>
              )}
            </div>

            <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-500/5">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-sm">How It Works</h3>
                  <p className="text-sm text-muted-foreground">
                    Funds in the bot are used for trading. Transfer from your wallet to the bot to enable trading, or withdraw profits back to your wallet.
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="webhook" className="space-y-4 mt-4">
            <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">1</span>
                Alert Message
              </h3>
              <pre className="p-3 bg-background/80 rounded-lg font-mono text-xs border whitespace-pre-wrap break-all">
                {getMessageTemplate()}
              </pre>
              <Button
                className="w-full mt-3"
                variant="secondary"
                onClick={() => copyToClipboard(getMessageTemplate(), 'Message')}
                data-testid="button-copy-message"
              >
                {copiedField === 'Message' ? (
                  <Check className="w-4 h-4 mr-2" />
                ) : (
                  <Copy className="w-4 h-4 mr-2" />
                )}
                {copiedField === 'Message' ? 'Copied!' : 'Copy Alert Message'}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Paste this in TradingView Alert → Message field. The botId routes signals to this specific bot.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-primary/10 border border-emerald-500/20">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">2</span>
                Webhook URL
              </h3>
              <div className="p-3 bg-background/80 rounded-lg font-mono text-xs border break-all">
                {webhookUrlLoading ? (
                  <span className="text-muted-foreground">Loading...</span>
                ) : (
                  userWebhookUrl || 'Loading webhook URL...'
                )}
              </div>
              <Button
                className="w-full mt-3"
                variant="secondary"
                onClick={() => userWebhookUrl && copyToClipboard(userWebhookUrl, 'Webhook URL')}
                disabled={!userWebhookUrl}
                data-testid="button-copy-webhook-url"
              >
                {copiedField === 'Webhook URL' ? (
                  <Check className="w-4 h-4 mr-2" />
                ) : (
                  <Copy className="w-4 h-4 mr-2" />
                )}
                {copiedField === 'Webhook URL' ? 'Copied!' : 'Copy Webhook URL'}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                This is your universal webhook URL - same for all bots! Paste in TradingView Alert → Notifications → Webhook URL
              </p>
            </div>

            <div className="p-4 rounded-xl bg-muted/50 border">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                How It Works
              </h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <strong>1.</strong> Set your <strong>Total Investment</strong> on the bot (e.g., $100)
                </p>
                <p>
                  <strong>2.</strong> In TradingView, set <strong>Initial Capital: 100</strong> and <strong>Order Size</strong>:
                </p>
                <ul className="ml-4 space-y-1">
                  <li>• <strong>100</strong> = 100% per trade (no pyramiding)</li>
                  <li>• <strong>33.33</strong> = 33.33% per trade (3-order pyramiding)</li>
                </ul>
                <p>
                  <strong>3.</strong> TradingView sends the % → Platform trades that % of your capital
                </p>
                <div className="pt-2 border-t mt-2">
                  <p className="font-medium text-foreground mb-1">Placeholders:</p>
                  <p>
                    <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.order.contracts}}'}</code> → % of your capital (100 = 100%, 33.33 = 33.33%)
                  </p>
                  <p>
                    <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.order.action}}'}</code> → "buy" or "sell"
                  </p>
                  <p>
                    <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.position_size}}'}</code> → Detects SL/TP closes (0 = close position)
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/5">
              <h3 className="font-semibold mb-2 flex items-center gap-2 text-yellow-600">
                <AlertCircle className="w-4 h-4" />
                Important
              </h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Your script must use <code className="px-1 py-0.5 bg-background rounded text-xs">strategy()</code> not <code className="px-1 py-0.5 bg-background rounded text-xs">indicator()</code></li>
                <li>• Webhook alerts require TradingView Essential plan or higher</li>
              </ul>
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-4 flex flex-col h-[calc(100vh-280px)]">
            {/* Trades Section - 3/4 of available space */}
            <div className="flex-[3] flex flex-col min-h-0">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Trade Executions
              </h3>
              {tradesLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : trades.length === 0 ? (
                <div className="text-center py-6 bg-muted/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">No trades yet</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Trades from TradingView signals will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-2 flex-1 overflow-y-auto">
                  {trades.map((trade) => {
                    const isFailed = trade.status === 'failed';
                    const isLiquidated = trade.status === 'liquidated';
                    const payload = trade.webhookPayload as any;
                    const action = payload?.data?.action?.toLowerCase() || payload?.action?.toLowerCase() || '';
                    const positionSize = payload?.position_size || payload?.data?.position_size;
                    const closeReason = payload?.closeReason;
                    const isOnChainClose = trade.executionMethod === 'on-chain-detected';
                    const isTpSl = closeReason === 'tpsl';
                    const sideUpper = trade.side?.toUpperCase();
                    const isClose = action === 'close' || sideUpper === 'CLOSE' || positionSize === '0' || positionSize === 0 || isOnChainClose || isTpSl;
                    const isLong = !isClose && (sideUpper === 'LONG' || sideUpper === 'BUY');
                    
                    const getTradeIcon = () => {
                      if (isLiquidated) {
                        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
                      }
                      if (isClose) {
                        return <XCircle className="h-4 w-4 text-amber-500" />;
                      }
                      if (isLong) {
                        return <TrendingUp className="h-4 w-4 text-emerald-500" />;
                      }
                      return <TrendingDown className="h-4 w-4 text-red-500" />;
                    };
                    
                    const getTradeLabel = () => {
                      if (isLiquidated) return 'LIQUIDATED';
                      if (isClose) return 'CLOSE';
                      return sideUpper;
                    };
                    
                    const getIconBgClass = () => {
                      if (isLiquidated) return 'bg-orange-500/10';
                      if (isClose) return 'bg-amber-500/10';
                      if (isLong) return 'bg-emerald-500/10';
                      return 'bg-red-500/10';
                    };
                    
                    const getLabelColor = () => {
                      if (isLiquidated) return 'text-orange-500';
                      if (isClose) return 'text-amber-500';
                      if (isLong) return 'text-emerald-500';
                      return 'text-red-500';
                    };
                    
                    const getErrorExplanation = (error: string | null | undefined): string | null => {
                      if (!error) return null;
                      const e = error.toLowerCase();
                      if (e.includes('market status') || e.includes('doesnt allow placing orders')) {
                        return 'Market temporarily paused - try again later';
                      }
                      if (e.includes('insufficientcollateral') || e.includes('insufficient collateral')) {
                        return 'Not enough margin - reduce position size or add funds';
                      }
                      if (e.includes('max leverage') || e.includes('exceeds leverage')) {
                        return 'Position too large for this market\'s leverage limit';
                      }
                      if (e.includes('oracle') || e.includes('stale oracle')) {
                        return 'Price feed issue - try again in a moment';
                      }
                      if (e.includes('reduce only')) {
                        return 'Market in reduce-only mode - can only close positions';
                      }
                      if (e.includes('user not found') || e.includes('no user account')) {
                        return 'Trading account not initialized - deposit funds first';
                      }
                      if (e.includes('subaccount')) {
                        return 'Bot trading account issue - check bot funding';
                      }
                      return error.length > 50 ? error.substring(0, 50) + '...' : error;
                    };
                    
                    return (
                      <div 
                        key={trade.id} 
                        className="flex items-center justify-between py-3 px-3 border rounded-lg bg-muted/30"
                        data-testid={`trade-${trade.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${getIconBgClass()}`}>
                            {getTradeIcon()}
                          </div>
                          <div>
                            <p className="text-sm font-medium flex items-center gap-2">
                              <span className={getLabelColor()}>{getTradeLabel()}</span> {trade.market}
                              {isLiquidated && (
                                <span className="text-xs px-1.5 py-0.5 bg-orange-500/20 text-orange-500 rounded font-semibold" data-testid={`badge-liquidated-${trade.id}`}>
                                  Liquidated
                                </span>
                              )}
                              {isFailed && !isLiquidated && (
                                <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-500 rounded">
                                  Failed
                                </span>
                              )}
                              {isClose && !isFailed && !isLiquidated && (
                                <span className="text-xs px-1.5 py-0.5 bg-amber-500/20 text-amber-500 rounded">
                                  Exit
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(trade.executedAt)}
                            </p>
                            {isLiquidated && trade.errorMessage && (
                              <p className="text-xs text-orange-400 mt-0.5">
                                {trade.errorMessage}
                              </p>
                            )}
                            {isFailed && !isLiquidated && trade.errorMessage && (
                              <p className="text-xs text-red-400 mt-0.5">
                                {getErrorExplanation(trade.errorMessage)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-mono text-sm font-medium">
                            {parseFloat(trade.size).toFixed(4)}
                          </span>
                          <p className="text-xs text-muted-foreground">
                            {isLiquidated ? 'liquidated' : 'contracts'} @ ${parseFloat(trade.price || '0').toFixed(2)}
                          </p>
                          {trade.pnl !== null && trade.pnl !== undefined && (
                            <p className={`text-xs font-medium ${isLiquidated ? 'text-orange-500' : parseFloat(trade.pnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}`} title={isLiquidated ? "Estimated liquidation loss" : "Gross PnL (excludes fees, slippage, funding)"}>
                              {isLiquidated ? 'Est. loss: ' : ''}{parseFloat(trade.pnl) >= 0 ? '+' : ''}${parseFloat(trade.pnl).toFixed(2)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Equity Events Section - 1/4 of available space */}
            <div className="flex-1 flex flex-col min-h-0 mt-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Wallet className="w-4 h-4" />
                Deposits & Withdrawals
              </h3>
              {equityEventsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : equityEvents.length === 0 ? (
                <div className="text-center py-4 bg-muted/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">No transactions yet</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Deposits and withdrawals will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-2 flex-1 overflow-y-auto">
                  {equityEvents.map((event) => {
                    const isPositive = parseFloat(event.amount) > 0;
                    const destination = parkDestinationFromNotes(event.eventType, event.notes);
                    const isVaultMove = event.eventType === 'vault_park' || event.eventType === 'vault_unpark';
                    const formatEventType = (type: string) => {
                      switch (type) {
                        case 'agent_deposit': return 'Deposit to Bot Wallet';
                        case 'agent_withdraw': return 'Withdraw from Bot Wallet';
                        case 'drift_deposit': return 'Deposit to Bot';
                        case 'drift_withdraw': return 'Withdraw from Bot';
                        case 'auto_topup': return 'Auto Top-Up';
                        case 'auto_withdraw': return 'Auto Withdraw';
                        default: return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                      }
                    };
                    return (
                      <div 
                        key={event.id} 
                        className="flex items-center justify-between py-3 px-3 border rounded-lg bg-muted/30"
                        data-testid={`equity-event-${event.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isPositive ? 'bg-emerald-500/10' : 'bg-orange-500/10'}`}>
                            {isPositive ? (
                              <ArrowDown className="h-4 w-4 text-emerald-500" />
                            ) : (
                              <ArrowUp className="h-4 w-4 text-orange-500" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{formatEventType(event.eventType)}</p>
                            {isVaultMove && (
                              <p className="text-xs text-muted-foreground" data-testid={`equity-event-destination-${event.id}`}>
                                {destination
                                  ? `${event.eventType === 'vault_unpark' ? 'Pulled from' : 'Parked to'} ${destination}`
                                  : 'Destination not recorded'}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatDate(event.createdAt)}
                            </p>
                          </div>
                        </div>
                        <span className={`font-mono text-sm font-medium ${isPositive ? 'text-emerald-500' : 'text-orange-500'}`}>
                          {isPositive ? '+' : ''}{parseFloat(event.amount).toFixed(2)} USDC
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="space-y-4 mt-4">
            <div className="p-4 rounded-xl border bg-muted/20">
              <div className="flex items-center gap-2 mb-4">
                <Settings className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">Bot Settings</h3>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">Bot Name</label>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Enter bot name"
                    data-testid="input-edit-name"
                  />
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-muted-foreground flex items-center gap-1.5">
                      Leverage
                      {(() => {
                        const maxLev = getMaxLeverage(localBot?.market || '');
                        if (maxLev < 10) {
                          return (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                              Max {maxLev}x
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </label>
                    <span className="text-sm font-semibold" data-testid="text-edit-leverage">{editLeverage}x</span>
                  </div>
                  <Slider
                    value={[Math.min(editLeverage, getMaxLeverage(localBot?.market || ''))]}
                    onValueChange={(value) => setEditLeverage(value[0])}
                    min={1}
                    max={getMaxLeverage(localBot?.market || '')}
                    step={1}
                    className="w-full"
                    data-testid="slider-leverage"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>1x</span>
                    <span>{getMaxLeverage(localBot?.market || '')}x (Max)</span>
                  </div>
                  {getMaxLeverage(localBot?.market || '') < 10 && (
                    <p className="text-xs text-amber-400 flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {localBot?.market.replace('-PERP', '')} has a {getMaxLeverage(localBot?.market || '')}x max leverage limit
                    </p>
                  )}
                </div>
                
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-muted-foreground">Investment Amount (USDC)</label>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={editMaxPositionSize}
                      onChange={(e) => setEditMaxPositionSize(e.target.value)}
                      placeholder="Required for trading"
                      min="1"
                      step="0.01"
                      className="flex-1"
                      data-testid="input-max-position-size"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditMaxPositionSize(botBalance.toFixed(2))}
                      disabled={botBalance <= 0}
                      className="px-3"
                      data-testid="button-max-position-size"
                    >
                      Max
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    Bot equity: ${botBalance.toFixed(2)}. With {editLeverage}x leverage = ${(botBalance * editLeverage).toFixed(2)} max position.
                  </p>
                  {/* Show shortfall warning when Auto Top-Up is enabled and investment exceeds bot balance */}
                  {editAutoTopUp && editMaxPositionSize && parseFloat(editMaxPositionSize) > botBalance && (
                    (() => {
                      const investmentValue = parseFloat(editMaxPositionSize);
                      const shortfall = investmentValue - botBalance;
                      const canCover = mainAccountBalance >= shortfall;
                      return (
                        <p className={`text-xs flex items-center gap-1 ${canCover ? 'text-blue-500' : 'text-red-500'}`}>
                          {canCover ? <Info className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                          {canCover 
                            ? `Auto Top-Up will deposit $${shortfall.toFixed(2)} from agent wallet when needed`
                            : `Agent wallet ($${mainAccountBalance.toFixed(2)}) can't cover $${shortfall.toFixed(2)} shortfall - reduce investment or add funds`
                          }
                        </p>
                      );
                    })()
                  )}
                </div>

                {/* Position Growth: how the bot grows its trading position */}
                <div className="pt-4 mt-2 border-t border-border/50">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground" data-testid="heading-position-growth">
                    Position Growth
                  </h4>

                  {/* Profit Reinvest Toggle */}
                  <div className="flex items-center justify-between py-3">
                    <div className="space-y-0.5">
                      <label className="text-sm font-medium">Profit Reinvest</label>
                      <p className="text-xs text-muted-foreground">
                        When enabled, bot uses full available margin instead of fixed investment amount
                      </p>
                    </div>
                    <Switch
                      checked={editProfitReinvest}
                      onCheckedChange={setEditProfitReinvest}
                      data-testid="switch-profit-reinvest"
                    />
                  </div>

                  {/* Auto Top-Up Toggle */}
                  <div className="flex items-center justify-between py-3 border-t border-border/40">
                    <div className="space-y-0.5">
                      <label className={`text-sm font-medium ${mainAccountBalance <= 0 ? 'text-muted-foreground' : ''}`}>Auto top-up</label>
                      <p className="text-xs text-muted-foreground">
                        Automatically deposit from your agent wallet when margin is too low to trade
                      </p>
                    </div>
                    <Switch
                      checked={editAutoTopUp}
                      onCheckedChange={setEditAutoTopUp}
                      disabled={mainAccountBalance <= 0}
                      data-testid="switch-auto-top-up"
                    />
                  </div>
                  {mainAccountBalance <= 0 && !editAutoTopUp && (
                    <p className="text-xs text-amber-500 flex items-center gap-1 -mt-2 pb-2">
                      <AlertTriangle className="w-3 h-3" />
                      Agent wallet has no USDC balance - deposit funds to enable auto top-up
                    </p>
                  )}
                  {editAutoTopUp && (
                    <p className="text-xs text-blue-500 flex items-center gap-1 -mt-2 pb-2">
                      <Info className="w-3 h-3" />
                      When bot needs more margin, it will deposit from your agent wallet (${mainAccountBalance.toFixed(2)} available)
                    </p>
                  )}
                </div>

                {/* Cash Management: what happens to profits and idle cash */}
                <div className="pt-4 mt-2 border-t border-border/50">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground" data-testid="heading-cash-management">
                    Cash Management
                  </h4>

                  {/* Auto Withdraw Threshold */}
                  <div className="space-y-2 py-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <label className="text-sm font-medium">Auto Withdraw Threshold</label>
                        <p className="text-xs text-muted-foreground">
                          Automatically withdraw profits to your agent wallet when equity exceeds this amount
                        </p>
                      </div>
                    </div>
                    <Input
                      type="number"
                      value={editAutoWithdrawThreshold}
                      onChange={(e) => setEditAutoWithdrawThreshold(e.target.value)}
                      placeholder="Leave empty to disable"
                      min="0"
                      step="1"
                      className="w-full"
                      data-testid="input-auto-withdraw-threshold"
                    />
                    {editAutoWithdrawThreshold && parseFloat(editAutoWithdrawThreshold) > 0 && (
                      <p className="text-xs text-emerald-500 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        When equity exceeds ${parseFloat(editAutoWithdrawThreshold).toFixed(2)}, excess profits will be withdrawn automatically
                      </p>
                    )}
                    {displayBot?.activeProtocol === 'pacifica' && editAutoWithdrawThreshold && parseFloat(editAutoWithdrawThreshold) > 0 && (
                      <p
                        className="text-xs text-amber-500/90 flex items-start gap-1 leading-relaxed"
                        data-testid="text-auto-withdraw-fee-notice"
                      >
                        <Info className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          Pacifica charges a flat <span className="font-medium">$1 USDC</span> fee per on-chain withdrawal. To avoid the fee eating into small profits, set the threshold so each auto-withdrawal sweeps a meaningful amount (e.g. $20+). The fee is charged by the exchange — not QuantumVault.
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Auto-park idle funds (Flash only — isolated per-bot wallet) */}
                  {displayBot?.activeProtocol === 'flash' && (
                    <div className="flex items-center justify-between py-3 border-t border-border/40">
                      <div className="space-y-0.5">
                        <label className="text-sm font-medium">Auto-park idle funds</label>
                        <p className="text-xs text-muted-foreground">
                          Automatically earn yield on this bot's spare USDC after each position fully closes
                        </p>
                      </div>
                      <Switch
                        checked={editAutoParkIdle}
                        onCheckedChange={setEditAutoParkIdle}
                        data-testid="switch-auto-park-idle"
                      />
                    </div>
                  )}
                  {displayBot?.activeProtocol === 'flash' && editAutoParkIdle && (
                    <p className="text-xs text-emerald-500 flex items-center gap-1 -mt-1 pb-2" data-testid="text-auto-park-idle-info">
                      <Sparkles className="w-3 h-3 shrink-0" />
                      Spare USDC is parked into yield about a minute after a position closes, then pulled back automatically before the next trade
                    </p>
                  )}

                  {/* Manual park/unpark lives in this same section, tucked behind a
                      reveal so Auto stays the default. Works on both venues (Flash
                      per-bot wallet; Pacifica shared account). */}
                  <div className="py-3 border-t border-border/40">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <label className="text-sm font-medium">Park funds manually</label>
                        <p className="text-xs text-muted-foreground">
                          Move this bot's spare USDC into yield (or back) right now, on demand.
                        </p>
                      </div>
                      <Switch
                        checked={showVaultPark}
                        onCheckedChange={setShowVaultPark}
                        data-testid="switch-bot-vault-park"
                      />
                    </div>
                    {displayBot?.activeProtocol === 'pacifica' && (
                      <div
                        className="mt-3 text-xs text-muted-foreground flex items-start gap-1.5 leading-relaxed bg-muted/30 border border-border/50 rounded-md px-2.5 py-1.5"
                        data-testid="text-bot-vault-park-pacifica-notice"
                      >
                        <Info className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          On Pacifica this parks your shared <span className="font-medium">account</span> idle USDC (not only this bot's).
                          Pacifica's $1 withdrawal fee and $10 minimum apply to moving funds on or off the exchange — so it pays off
                          mainly for funds sitting idle a while, or to hold them in self-custody and spread risk.
                        </span>
                      </div>
                    )}
                    {showVaultPark && displayBot?.id && (
                      <div className="mt-4">
                        {/* key on bot id so park amount/selection never carries across a bot switch */}
                        <VaultIdleFunds key={displayBot.id} botId={displayBot.id} />
                      </div>
                    )}
                  </div>
                </div>
                
                {hasSettingsChanges && (
                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelEdit}
                      disabled={saveSettingsLoading}
                      className="flex-1"
                      data-testid="button-cancel-settings"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSaveSettings}
                      disabled={saveSettingsLoading}
                      className="flex-1"
                      data-testid="button-save-settings"
                    >
                      {saveSettingsLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      ) : null}
                      Save Changes
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {(displayBot?.botSubaccountIdentifier || (displayBot?.driftSubaccountId !== null && displayBot?.driftSubaccountId !== undefined)) && (
              <div className="p-4 rounded-xl border border-border/50 bg-muted/30">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Trading Subaccount</span>
                  </div>
                  {displayBot.botSubaccountIdentifier ? (
                    <div className="flex items-center gap-1.5">
                      <a
                        href={`https://solscan.io/account/${displayBot.botSubaccountIdentifier}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-mono font-medium hover:text-primary transition-colors flex items-center gap-1"
                        data-testid="link-subaccount-solscan"
                      >
                        {displayBot.botSubaccountIdentifier.slice(0, 4)}...{displayBot.botSubaccountIdentifier.slice(-4)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      {displayBot.activeProtocol === 'pacifica' && (
                        <a
                          href={`https://app.pacifica.fi/portfolio/${displayBot.botSubaccountIdentifier}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title="View subaccount on Pacifica"
                          data-testid="link-subaccount-pacifica"
                        >
                          <ExternalLink className="w-3 h-3 text-muted-foreground" />
                        </a>
                      )}
                      {displayBot.activeProtocol === 'flash' && (
                        <a
                          href={`https://www.flash.trade/USDC-SOL?public_key=${displayBot.botSubaccountIdentifier}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title="View live position on Flash"
                          data-testid="link-subaccount-flash"
                        >
                          <ExternalLink className="w-3 h-3 text-muted-foreground" />
                        </a>
                      )}
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(displayBot.botSubaccountIdentifier!);
                          toast({ title: 'Copied', description: 'Subaccount address copied to clipboard' });
                        }}
                        className="p-1 rounded hover:bg-muted transition-colors"
                        data-testid="button-copy-subaccount"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm font-mono font-medium" data-testid="text-subaccount-id">
                      Subaccount {displayBot.driftSubaccountId}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  This bot's funds are isolated in its own trading subaccount.
                  Each bot operates independently with separate balances and positions.
                </p>
              </div>
            )}

            <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5">
              <div className="flex items-center gap-2 mb-3">
                <Trash2 className="w-4 h-4 text-destructive" />
                <h3 className="font-semibold text-sm text-destructive">Danger Zone</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Permanently delete this bot and all associated trade history. Any funds should be withdrawn first.
              </p>
              <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    className="w-full"
                    data-testid="button-delete-bot"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Bot
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {displayBot?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete the bot
                      and all associated trade history. Any funds in the bot's account
                      should be withdrawn first.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleteLoading}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      data-testid="button-confirm-delete"
                    >
                      {deleteLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      ) : (
                        <Trash2 className="w-4 h-4 mr-2" />
                      )}
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </TabsContent>
        </Tabs>
        </>
        )}
      </SheetContent>

      {displayBot && (
        <PublishBotModal
          isOpen={publishModalOpen}
          onClose={() => setPublishModalOpen(false)}
          bot={{
            id: displayBot.id,
            name: displayBot.name,
            market: displayBot.market,
          }}
          walletAddress={walletAddress}
          referralCode={referralCode}
          onPublished={() => {
            onBotUpdated();
          }}
        />
      )}

      {displayBot && (
        <SharePnLCard
          isOpen={shareCardOpen}
          onClose={() => setShareCardOpen(false)}
          botName={displayBot.name}
          market={displayBot.market}
          pnl={(exchangeBalance + parkedValueUsdc) - netDeposited}
          pnlPercent={netDeposited > 0 ? (((exchangeBalance + parkedValueUsdc) - netDeposited) / netDeposited) * 100 : 0}
          timeframe={performanceTimeframe}
          tradeCount={performanceTradeCount}
          winRate={getWinRate()}
          chartData={performanceData}
          displayName={displayName}
          xUsername={xUsername}
          onTimeframeChange={setPerformanceTimeframe}
          shareUrl={publishedBotId 
            ? `https://myquantumvault.com/marketplace/${publishedBotId}${referralCode ? `?ref=${referralCode}` : ''}` 
            : (referralCode ? `https://myquantumvault.com/?ref=${referralCode}` : 'https://myquantumvault.com')}
          isPublishedBot={!!publishedBotId}
        />
      )}
    </Sheet>
  );
}
