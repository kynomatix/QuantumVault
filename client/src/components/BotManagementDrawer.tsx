import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Plus,
  Minus,
  AlertCircle,
  Sparkles,
} from 'lucide-react';

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

interface BotTrade {
  id: string;
  market: string;
  side: string;
  size: string;
  price: string;
  status: string;
  executedAt: string;
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
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();

  const [activeTab, setActiveTab] = useState('overview');
  const [botBalance, setBotBalance] = useState<number>(0);
  const [mainAccountBalance, setMainAccountBalance] = useState<number>(0);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [trades, setTrades] = useState<BotTrade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [addEquityAmount, setAddEquityAmount] = useState('');
  const [removeEquityAmount, setRemoveEquityAmount] = useState('');
  const [isProcessingAdd, setIsProcessingAdd] = useState(false);
  const [isProcessingRemove, setIsProcessingRemove] = useState(false);

  useEffect(() => {
    if (isOpen && bot) {
      fetchBotBalance();
      setActiveTab('overview');
      setAddEquityAmount('');
      setRemoveEquityAmount('');
    }
  }, [isOpen, bot?.id]);

  useEffect(() => {
    if (isOpen && bot && activeTab === 'history') {
      fetchTrades();
    }
  }, [isOpen, bot?.id, activeTab]);

  const fetchBotBalance = async () => {
    if (!bot) return;
    setBalanceLoading(true);
    try {
      const [balanceRes, capitalRes] = await Promise.all([
        fetch(`/api/bot/${bot.id}/balance`, { credentials: 'include' }),
        fetch('/api/wallet/capital', { credentials: 'include' }),
      ]);

      if (balanceRes.ok) {
        const data = await balanceRes.json();
        setBotBalance(data.usdcBalance ?? 0);
      }

      if (capitalRes.ok) {
        const data = await capitalRes.json();
        setMainAccountBalance(data.mainAccountBalance ?? 0);
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
    } finally {
      setBalanceLoading(false);
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

  const getWebhookUrl = () => {
    if (!bot) return '';
    const baseUrl = window.location.origin;
    return `${baseUrl}/api/webhook/tradingview/${bot.id}?secret=${bot.webhookSecret}`;
  };

  const getMessageTemplate = () => {
    return `order {{strategy.order.action}} @ {{strategy.order.contracts}} filled on {{ticker}}. New strategy position is {{strategy.position_size}}`;
  };

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast({ title: `${field} copied to clipboard` });
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleAddEquity = async () => {
    if (!bot || !addEquityAmount || parseFloat(addEquityAmount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    setIsProcessingAdd(true);
    try {
      const response = await fetch(`/api/bot/${bot.id}/deposit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wallet-address': solanaWallet.publicKey.toString(),
        },
        body: JSON.stringify({ amount: parseFloat(addEquityAmount) }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add equity');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = data;

      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());

      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({
        title: 'Equity Added Successfully!',
        description: message,
      });

      setAddEquityAmount('');
      await fetchBotBalance();
      onBotUpdated();
    } catch (error: any) {
      console.error('Add equity error:', error);
      toast({
        title: 'Failed to add equity',
        description: error.message || 'Please try again',
        variant: 'destructive',
      });
    } finally {
      setIsProcessingAdd(false);
    }
  };

  const handleRemoveEquity = async () => {
    if (!bot || !removeEquityAmount || parseFloat(removeEquityAmount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (parseFloat(removeEquityAmount) > botBalance) {
      toast({ title: 'Amount exceeds bot balance', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    setIsProcessingRemove(true);
    try {
      const response = await fetch(`/api/bot/${bot.id}/withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wallet-address': solanaWallet.publicKey.toString(),
        },
        body: JSON.stringify({ amount: parseFloat(removeEquityAmount) }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove equity');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = data;

      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());

      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({
        title: 'Equity Removed Successfully!',
        description: message,
      });

      setRemoveEquityAmount('');
      await fetchBotBalance();
      onBotUpdated();
    } catch (error: any) {
      console.error('Remove equity error:', error);
      toast({
        title: 'Failed to remove equity',
        description: error.message || 'Please try again',
        variant: 'destructive',
      });
    } finally {
      setIsProcessingRemove(false);
    }
  };

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
                variant={bot.isActive ? 'default' : 'secondary'}
                className={bot.isActive ? 'bg-emerald-500' : ''}
                data-testid="badge-bot-status"
              >
                {bot.isActive ? 'Active' : 'Inactive'}
              </Badge>
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
          <TabsList className="w-full grid grid-cols-4" data-testid="tabs-bot-management">
            <TabsTrigger value="overview" data-testid="tab-overview">
              <BarChart3 className="w-4 h-4 mr-1.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="equity" data-testid="tab-equity">
              <Wallet className="w-4 h-4 mr-1.5" />
              Equity
            </TabsTrigger>
            <TabsTrigger value="webhook" data-testid="tab-webhook">
              <Webhook className="w-4 h-4 mr-1.5" />
              Webhook
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              <History className="w-4 h-4 mr-1.5" />
              History
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
                <p className="text-lg font-semibold mt-1" data-testid="text-leverage">{bot.leverage}x</p>
              </div>
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
            <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Current Bot Balance</p>
                  <p className="text-3xl font-bold mt-1" data-testid="text-current-balance">
                    {balanceLoading ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : (
                      `$${botBalance.toFixed(2)}`
                    )}
                  </p>
                </div>
                <Wallet className="w-10 h-10 text-primary/50" />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Main account: ${mainAccountBalance.toFixed(2)} available
              </p>
            </div>

            <div className="p-4 rounded-xl border space-y-3">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-500" />
                <Label className="font-medium">Add Equity</Label>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={addEquityAmount}
                    onChange={(e) => setAddEquityAmount(e.target.value)}
                    className="pl-7"
                    data-testid="input-add-equity"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddEquityAmount(mainAccountBalance.toString())}
                  data-testid="button-add-max"
                >
                  Max
                </Button>
                <Button
                  onClick={handleAddEquity}
                  disabled={isProcessingAdd || !addEquityAmount}
                  className="bg-emerald-500 hover:bg-emerald-600"
                  data-testid="button-add-equity"
                >
                  {isProcessingAdd ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
                </Button>
              </div>
            </div>

            <div className="p-4 rounded-xl border space-y-3">
              <div className="flex items-center gap-2">
                <Minus className="w-4 h-4 text-red-500" />
                <Label className="font-medium">Remove Equity</Label>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={removeEquityAmount}
                    onChange={(e) => setRemoveEquityAmount(e.target.value)}
                    className="pl-7"
                    data-testid="input-remove-equity"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRemoveEquityAmount(botBalance.toString())}
                  data-testid="button-remove-max"
                >
                  Max
                </Button>
                <Button
                  onClick={handleRemoveEquity}
                  disabled={isProcessingRemove || !removeEquityAmount}
                  variant="destructive"
                  data-testid="button-remove-equity"
                >
                  {isProcessingRemove ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Remove'}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="webhook" className="space-y-4 mt-4">
            <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-primary/10 border border-emerald-500/20">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">1</span>
                Webhook URL
              </h3>
              <div className="p-3 bg-background/80 rounded-lg font-mono text-xs border break-all">
                {getWebhookUrl()}
              </div>
              <Button
                className="w-full mt-3"
                variant="secondary"
                onClick={() => copyToClipboard(getWebhookUrl(), 'Webhook URL')}
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
                Paste this in TradingView Alert → Notifications → Webhook URL
              </p>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">2</span>
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
                Paste this in TradingView Alert → Message field
              </p>
            </div>

            <div className="p-4 rounded-xl bg-muted/50 border">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                How The Placeholders Work
              </h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.order.action}}'}</code> → "buy" or "sell"
                </p>
                <p>
                  <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.order.contracts}}'}</code> → Order size
                </p>
                <p>
                  <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{strategy.position_size}}'}</code> → Total position
                </p>
                <p>
                  <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{ticker}}'}</code> → Trading symbol
                </p>
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

          <TabsContent value="history" className="mt-4">
            {tradesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : trades.length === 0 ? (
              <div className="text-center py-12">
                <History className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                <p className="text-muted-foreground">No trades yet</p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  Trades will appear here when your bot executes them
                </p>
              </div>
            ) : (
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.map((trade) => (
                      <TableRow key={trade.id} data-testid={`row-trade-${trade.id}`}>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(trade.executedAt)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={trade.side.toLowerCase() === 'buy' ? 'default' : 'destructive'}
                            className={trade.side.toLowerCase() === 'buy' ? 'bg-emerald-500' : ''}
                          >
                            {trade.side.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {parseFloat(trade.size).toFixed(4)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          ${parseFloat(trade.price).toFixed(2)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={trade.status === 'executed' ? 'outline' : 'secondary'}
                            className={trade.status === 'executed' ? 'border-emerald-500 text-emerald-500' : ''}
                          >
                            {trade.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
