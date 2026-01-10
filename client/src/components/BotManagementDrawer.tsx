import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useToast } from '@/hooks/use-toast';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
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

interface BotTrade {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  status: string;
  executedAt: string;
  webhookPayload?: {
    data?: {
      action?: string;
    };
    action?: string;
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

interface BotPosition {
  hasPosition: boolean;
  side?: 'LONG' | 'SHORT';
  size?: number;
  avgEntryPrice?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  market?: string;
}

interface BotManagementDrawerProps {
  bot: TradingBot | null;
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onBotUpdated: () => void;
}

export function BotManagementDrawer({
  bot,
  isOpen,
  onClose,
  walletAddress,
  onBotUpdated,
}: BotManagementDrawerProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [activeTab, setActiveTab] = useState('overview');
  const [botBalance, setBotBalance] = useState<number>(0);
  const [mainAccountBalance, setMainAccountBalance] = useState<number>(0);
  const [driftBalance, setDriftBalance] = useState<number>(0);
  const [driftFreeCollateral, setDriftFreeCollateral] = useState<number>(0);
  const [hasOpenPositions, setHasOpenPositions] = useState<boolean>(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
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
  const [saveSettingsLoading, setSaveSettingsLoading] = useState(false);
  const [userWebhookUrl, setUserWebhookUrl] = useState<string | null>(null);
  const [webhookUrlLoading, setWebhookUrlLoading] = useState(false);
  const [botPosition, setBotPosition] = useState<BotPosition | null>(null);
  const [positionLoading, setPositionLoading] = useState(false);

  useEffect(() => {
    if (bot) {
      setLocalBot(bot);
      setEditName(bot.name);
      setEditLeverage(bot.leverage);
      setEditMaxPositionSize(bot.maxPositionSize || '');
    }
  }, [bot]);

  const fetchUserWebhookUrl = async () => {
    setWebhookUrlLoading(true);
    try {
      const res = await fetch(`/api/user/webhook-url?wallet=${walletAddress}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
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
      const res = await fetch(`/api/trading-bots/${bot.id}/position?wallet=${walletAddress}`, { 
        credentials: 'include' 
      });
      if (res.ok) {
        const data = await res.json();
        setBotPosition(data);
      }
    } catch (error) {
      console.error('Failed to fetch bot position:', error);
    } finally {
      setPositionLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && bot) {
      fetchBotBalance();
      fetchBotPosition();
      fetchUserWebhookUrl();
      setActiveTab('overview');
    }
  }, [isOpen, bot?.id]);

  useEffect(() => {
    if (isOpen && bot && activeTab === 'history') {
      fetchTrades();
      fetchEquityEvents();
    }
  }, [isOpen, bot?.id, activeTab]);

  const fetchBotBalance = async () => {
    if (!bot) return;
    setBalanceLoading(true);
    try {
      const cacheBust = Date.now();
      const [balanceRes, agentRes, driftRes] = await Promise.all([
        fetch(`/api/bot/${bot.id}/balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/agent/balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/agent/drift-balance?wallet=${walletAddress}&_=${cacheBust}`, { credentials: 'include', cache: 'no-store' }),
      ]);

      if (balanceRes.ok) {
        const data = await balanceRes.json();
        setBotBalance(data.usdcBalance ?? 0);
      }

      if (agentRes.ok) {
        const data = await agentRes.json();
        setMainAccountBalance(data.balance ?? 0);
      }

      if (driftRes.ok) {
        const data = await driftRes.json();
        setDriftBalance(data.balance ?? 0);
        setDriftFreeCollateral(data.freeCollateral ?? data.balance ?? 0);
        setHasOpenPositions(data.hasOpenPositions ?? false);
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
    } finally {
      setBalanceLoading(false);
    }
  };

  const handleAddEquity = async () => {
    const amount = parseFloat(addEquityAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return;
    }

    setAddEquityLoading(true);
    try {
      const res = await fetch('/api/agent/drift-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount }),
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add to Drift');
      }

      toast({ title: `Successfully added $${amount} to Drift`, description: `Transaction: ${data.signature?.slice(0, 8)}...` });
      setAddEquityAmount('');
      setTimeout(() => fetchBotBalance(), 1500);
    } catch (error) {
      toast({ title: 'Failed to add to Drift', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setAddEquityLoading(false);
    }
  };

  const handleRemoveEquity = async () => {
    const amount = parseFloat(removeEquityAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return;
    }

    // Validate amount doesn't exceed withdrawable
    if (amount > driftFreeCollateral + 0.000001) {
      toast({ 
        title: 'Amount exceeds withdrawable balance', 
        description: `Maximum you can withdraw is $${driftFreeCollateral.toFixed(2)}`,
        variant: 'destructive' 
      });
      return;
    }

    setRemoveEquityLoading(true);
    try {
      const res = await fetch('/api/agent/drift-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount }),
      });

      const data = await res.json();
      
      if (!res.ok) {
        // Map Drift errors to friendly messages
        let friendlyMessage = data.error || 'Failed to remove from Drift';
        if (data.error?.includes('InsufficientCollateral') || data.error?.includes('0x1773')) {
          friendlyMessage = 'Not enough available balance. Try a smaller amount.';
        } else if (data.error?.includes('Simulation failed')) {
          friendlyMessage = 'Transaction would fail. Try a smaller amount.';
        }
        throw new Error(friendlyMessage);
      }

      toast({ title: `Successfully removed $${amount} from Drift`, description: `Transaction: ${data.signature?.slice(0, 8)}...` });
      setRemoveEquityAmount('');
      setTimeout(() => fetchBotBalance(), 1500);
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
        const data = await res.json();
        setTrades(data);
      }
    } catch (error) {
      console.error('Failed to fetch trades:', error);
    } finally {
      setTradesLoading(false);
    }
  };

  const fetchEquityEvents = async () => {
    setEquityEventsLoading(true);
    try {
      const res = await fetch(`/api/equity-events?limit=50`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
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
    navigate('/wallet');
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
        const data = await res.json();
        throw new Error(data.error || 'Failed to update bot');
      }

      const updatedBot = await res.json();
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
        const data = await res.json();
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

  const handleSaveSettings = async () => {
    if (!localBot) return;
    
    if (editLeverage < 1 || editLeverage > 20) {
      toast({ title: 'Leverage must be between 1 and 20', variant: 'destructive' });
      return;
    }
    
    if (!editName.trim()) {
      toast({ title: 'Bot name is required', variant: 'destructive' });
      return;
    }
    
    setSaveSettingsLoading(true);
    try {
      const res = await fetch(`/api/trading-bots/${localBot.id}?wallet=${walletAddress}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          name: editName.trim(),
          leverage: editLeverage,
          maxPositionSize: editMaxPositionSize ? parseFloat(editMaxPositionSize) : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      const updatedBot = await res.json();
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
      setEditLeverage(localBot.leverage);
      setEditMaxPositionSize(localBot.maxPositionSize || '');
    }
  };

  const hasSettingsChanges = localBot ? (
    editName !== localBot.name || 
    editLeverage !== localBot.leverage || 
    editMaxPositionSize !== (localBot.maxPositionSize || '')
  ) : false;

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getWinRate = () => {
    if (!bot?.stats) return 0;
    const total = bot.stats.totalTrades;
    if (total === 0) return 0;
    return ((bot.stats.winningTrades / total) * 100).toFixed(1);
  };

  if (!bot) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto" data-testid="drawer-bot-management">
        <SheetHeader className="space-y-3 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <SheetTitle className="text-lg" data-testid="text-bot-name">{bot.name}</SheetTitle>
                <SheetDescription className="text-sm" data-testid="text-bot-market">{bot.market}</SheetDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={(localBot?.isActive ?? bot.isActive) ? 'default' : 'secondary'}
                className={(localBot?.isActive ?? bot.isActive) ? 'bg-emerald-500' : ''}
                data-testid="badge-bot-status"
              >
                {(localBot?.isActive ?? bot.isActive) ? 'Active' : 'Inactive'}
              </Badge>
              <Button
                variant={(localBot?.isActive ?? bot.isActive) ? 'outline' : 'default'}
                size="sm"
                onClick={handlePauseResume}
                disabled={pauseLoading}
                data-testid="button-pause-resume"
              >
                {pauseLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (localBot?.isActive ?? bot.isActive) ? (
                  <>
                    <Pause className="w-4 h-4 mr-1.5" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-1.5" />
                    Resume
                  </>
                )}
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" disabled data-testid="button-share">
                      <Share2 className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Coming soon</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border">
                <p className="text-sm text-muted-foreground">Bot Equity</p>
                <p className="text-2xl font-bold mt-1" data-testid="text-bot-equity">
                  {balanceLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    `$${botBalance.toFixed(2)}`
                  )}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-muted/50 border">
                <p className="text-sm text-muted-foreground">Total P&L</p>
                <div className="flex items-center gap-1 mt-1">
                  {(bot.stats?.totalPnl ?? 0) >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-red-500" />
                  )}
                  <p
                    className={`text-2xl font-bold ${
                      (bot.stats?.totalPnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                    }`}
                    data-testid="text-total-pnl"
                  >
                    ${(bot.stats?.totalPnl ?? 0).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Total Trades</p>
                <p className="text-lg font-semibold mt-1" data-testid="text-total-trades">
                  {bot.stats?.totalTrades ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className="text-lg font-semibold mt-1 text-emerald-500" data-testid="text-win-rate">
                  {getWinRate()}%
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border text-center">
                <p className="text-xs text-muted-foreground">Leverage</p>
                <p className="text-lg font-semibold mt-1" data-testid="text-leverage">{localBot?.leverage ?? bot.leverage}x</p>
              </div>
            </div>

            {/* Current Position Section */}
            <div className="p-4 rounded-xl border bg-muted/20">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">Current Position</h3>
              </div>
              
              {positionLoading ? (
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
                      <p className="text-xs text-muted-foreground">Entry Price</p>
                      <p className="font-mono font-semibold" data-testid="text-entry-price">
                        ${botPosition.avgEntryPrice?.toFixed(2)}
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-background/50">
                      <p className="text-xs text-muted-foreground">Current Price</p>
                      <p className="font-mono font-semibold" data-testid="text-current-price">
                        ${botPosition.currentPrice?.toFixed(2)}
                      </p>
                    </div>
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
              ) : (
                <div className="text-center py-4 text-muted-foreground">
                  <p className="text-sm">No open position</p>
                  <p className="text-xs mt-1">Position will appear when bot executes a trade</p>
                </div>
              )}
            </div>

            <div className="p-4 rounded-xl border bg-muted/20">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium">Performance Chart</p>
                <Badge variant="outline" className="text-xs">Coming Soon</Badge>
              </div>
              <div className="h-32 flex items-center justify-center rounded-lg bg-muted/50 border border-dashed">
                <div className="text-center text-muted-foreground">
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Performance chart placeholder</p>
                </div>
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
                      {balanceLoading ? (
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
                    <p className="text-sm text-muted-foreground">Bot Balance</p>
                    <p className="text-2xl font-bold mt-1" data-testid="text-drift-balance">
                      {balanceLoading ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        `$${botBalance.toFixed(2)}`
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
                <h3 className="font-semibold text-sm">Add to Drift</h3>
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
              <p className="text-xs text-muted-foreground">
                Transfer USDC from your agent wallet to Drift for trading
              </p>
            </div>

            <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
              <div className="flex items-center gap-2">
                <ArrowDown className="w-4 h-4 text-orange-500" />
                <h3 className="font-semibold text-sm">Remove from Drift</h3>
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
                      const maxWithdrawable = Math.floor(driftFreeCollateral * 100) / 100;
                      setRemoveEquityAmount(maxWithdrawable.toString());
                    }}
                    data-testid="button-remove-max"
                  >
                    Max
                  </Button>
                </div>
                <Button
                  onClick={handleRemoveEquity}
                  disabled={removeEquityLoading || !removeEquityAmount || parseFloat(removeEquityAmount) > driftFreeCollateral + 0.000001}
                  variant="outline"
                  data-testid="button-remove-equity"
                >
                  {removeEquityLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Remove'}
                </Button>
              </div>
              {removeEquityAmount && parseFloat(removeEquityAmount) > driftFreeCollateral + 0.000001 && (
                <p className="text-xs text-red-500">
                  Amount exceeds max withdrawable (${driftFreeCollateral.toFixed(2)})
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Withdraw USDC from Drift back to your agent wallet
              </p>
              {hasOpenPositions && driftBalance > driftFreeCollateral && (
                <p className="text-xs text-amber-500">
                  Note: ${(driftBalance - driftFreeCollateral).toFixed(2)} is locked as margin for open positions
                </p>
              )}
            </div>

            <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-500/5">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-sm">How It Works</h3>
                  <p className="text-sm text-muted-foreground">
                    Funds in Drift are used for trading. Transfer from your agent wallet to Drift to enable trading, or withdraw profits back to your agent wallet.
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

          <TabsContent value="history" className="mt-4 space-y-6">
            {/* Trades Section */}
            <div>
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
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {trades.map((trade) => {
                    const isLong = trade.side === 'LONG';
                    const isSimulated = trade.status === 'executed' && (trade.price === '0' || trade.price === '0.000000');
                    const payload = trade.webhookPayload;
                    const action = payload?.data?.action?.toLowerCase() || payload?.action?.toLowerCase() || '';
                    const isClose = action === 'close' || trade.side === 'CLOSE';
                    
                    const getTradeIcon = () => {
                      if (isClose) {
                        return <XCircle className="h-4 w-4 text-purple-500" />;
                      }
                      if (isLong) {
                        return <TrendingUp className="h-4 w-4 text-emerald-500" />;
                      }
                      return <TrendingDown className="h-4 w-4 text-red-500" />;
                    };
                    
                    const getTradeLabel = () => {
                      if (isClose) return 'CLOSE';
                      return trade.side;
                    };
                    
                    const getIconBgClass = () => {
                      if (isClose) return 'bg-purple-500/10';
                      if (isLong) return 'bg-emerald-500/10';
                      return 'bg-red-500/10';
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
                              {getTradeLabel()} {trade.market}
                              {isSimulated && (
                                <span className="text-xs px-1.5 py-0.5 bg-amber-500/20 text-amber-600 rounded">
                                  Simulated
                                </span>
                              )}
                              {isClose && (
                                <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-600 rounded">
                                  Exit
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(trade.executedAt)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-mono text-sm font-medium">
                            {parseFloat(trade.size).toFixed(4)}
                          </span>
                          <p className="text-xs text-muted-foreground">contracts</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Equity Events Section */}
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Wallet className="w-4 h-4" />
                Deposits & Withdrawals
              </h3>
              {equityEventsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : equityEvents.length === 0 ? (
                <div className="text-center py-6 bg-muted/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">No transactions yet</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Deposits and withdrawals will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {equityEvents.map((event) => {
                    const isPositive = parseFloat(event.amount) > 0;
                    const formatEventType = (type: string) => {
                      switch (type) {
                        case 'agent_deposit': return 'Deposit to Bot Wallet';
                        case 'agent_withdraw': return 'Withdraw from Bot Wallet';
                        case 'drift_deposit': return 'Deposit to Trading';
                        case 'drift_withdraw': return 'Withdraw from Trading';
                        default: return type.replace(/_/g, ' ');
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
                    <label className="text-sm text-muted-foreground">Leverage</label>
                    <span className="text-sm font-semibold" data-testid="text-edit-leverage">{editLeverage}x</span>
                  </div>
                  <Slider
                    value={[editLeverage]}
                    onValueChange={(value) => setEditLeverage(value[0])}
                    min={1}
                    max={20}
                    step={1}
                    className="w-full"
                    data-testid="slider-leverage"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>1x</span>
                    <span>10x</span>
                    <span>20x</span>
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    Applied to your trades when bot executes signals
                  </p>
                </div>
                
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-muted-foreground">Max Position Size (USDC)</label>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      value={editMaxPositionSize}
                      onChange={(e) => setEditMaxPositionSize(e.target.value)}
                      placeholder="Required for trading"
                      min="1"
                      step="1"
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
                    Your capital base. TradingView signals trade a % of this amount.
                    {botBalance > 0 && (
                      <span className="ml-1">(Bot has ${botBalance.toFixed(2)})</span>
                    )}
                  </p>
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
                    <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
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
      </SheetContent>
    </Sheet>
  );
}
