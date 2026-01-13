import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'wouter';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/hooks/use-toast';
import { 
  Bot, 
  Plus, 
  Trash2, 
  Copy, 
  Check,
  Pause,
  Play,
  ArrowLeft,
  Sparkles,
  TrendingUp,
  AlertCircle,
  ExternalLink,
  ChevronRight,
  Zap,
  Settings,
  Eye,
  Loader2,
  Wallet
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';

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

interface BotPosition {
  botId: string;
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  baseAssetAmount: number;
  sizeUsd: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl: number;
  totalFees: number;
  lastTradeAt: string;
}

const MARKETS = [
  'SOL-PERP',
  'BTC-PERP',
  'ETH-PERP',
  'JUP-PERP',
  'BONK-PERP',
  'AVAX-PERP',
  'MATIC-PERP',
  'LINK-PERP',
  'DOGE-PERP',
];

export default function BotSetup() {
  const [, navigate] = useLocation();
  const { connected, publicKeyString } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [selectedBot, setSelectedBot] = useState<TradingBot | null>(null);
  const [botTrades, setBotTrades] = useState<BotTrade[]>([]);
  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showWebhookDialog, setShowWebhookDialog] = useState(false);
  const [showAddEquityDialog, setShowAddEquityDialog] = useState(false);
  const [equityAmount, setEquityAmount] = useState('');
  const [isProcessingEquity, setIsProcessingEquity] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    leverage: 1,
    maxPositionSize: '100',
  });

  useEffect(() => {
    if (!connected || !publicKeyString) {
      if (!connected) navigate('/');
      return;
    }
    fetchBots();
    fetchPositions();
    const positionInterval = setInterval(fetchPositions, 15000);
    return () => clearInterval(positionInterval);
  }, [connected, publicKeyString]);

  const fetchBots = async () => {
    if (!publicKeyString) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/trading-bots?wallet=${publicKeyString}`);
      if (res.ok) {
        const data = await res.json();
        setBots(data);
      }
    } catch (error) {
      console.error('Failed to fetch bots:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchPositions = async () => {
    if (!publicKeyString) return;
    try {
      const res = await fetch(`/api/positions?wallet=${publicKeyString}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setPositions(data.positions || []);
      }
    } catch (error) {
      console.error('Failed to fetch positions:', error);
    }
  };

  const getPositionForBot = (botId: string): BotPosition | undefined => {
    return positions.find(p => p.botId === botId);
  };

  const fetchBotTrades = async (botId: string) => {
    if (!publicKeyString) return;
    try {
      const res = await fetch(`/api/trading-bots/${botId}/trades?wallet=${publicKeyString}`);
      if (res.ok) {
        const data = await res.json();
        setBotTrades(data);
      }
    } catch (error) {
      console.error('Failed to fetch bot trades:', error);
    }
  };

  const createBot = async () => {
    if (!publicKeyString || !newBot.name) return;
    
    try {
      const res = await fetch('/api/trading-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: publicKeyString,
          name: newBot.name,
          market: newBot.market,
          leverage: newBot.leverage,
          maxPositionSize: newBot.maxPositionSize || '100',
        }),
      });
      
      if (res.ok) {
        const bot = await res.json();
        setBots([bot, ...bots]);
        setSelectedBot(bot);
        setShowCreateDialog(false);
        setShowWebhookDialog(true);
        setNewBot({
          name: '',
          market: 'SOL-PERP',
          leverage: 1,
          maxPositionSize: '100',
        });
        toast({ title: 'Bot created! Copy your webhook details below.' });
      } else {
        const error = await res.json();
        toast({ title: 'Failed to create bot', description: error.error, variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to create bot', variant: 'destructive' });
    }
  };

  const toggleBot = async (botId: string, isActive: boolean) => {
    if (!publicKeyString) return;
    
    try {
      const res = await fetch(`/api/trading-bots/${botId}?wallet=${publicKeyString}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      
      if (res.ok) {
        setBots(bots.map(b => b.id === botId ? { ...b, isActive } : b));
        if (selectedBot?.id === botId) {
          setSelectedBot({ ...selectedBot, isActive });
        }
        toast({ title: isActive ? 'Bot activated' : 'Bot paused' });
      }
    } catch (error) {
      toast({ title: 'Failed to update bot', variant: 'destructive' });
    }
  };

  const deleteBot = async (botId: string) => {
    if (!publicKeyString) return;
    
    try {
      const res = await fetch(`/api/trading-bots/${botId}?wallet=${publicKeyString}`, {
        method: 'DELETE',
      });
      
      if (res.ok) {
        setBots(bots.filter(b => b.id !== botId));
        if (selectedBot?.id === botId) {
          setSelectedBot(null);
          setBotTrades([]);
        }
        toast({ title: 'Bot deleted' });
      }
    } catch (error) {
      toast({ title: 'Failed to delete bot', variant: 'destructive' });
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast({ title: `${field} copied to clipboard` });
    setTimeout(() => setCopiedField(null), 2000);
  };

  const selectBot = (bot: TradingBot) => {
    setSelectedBot(bot);
    fetchBotTrades(bot.id);
  };

  const getWebhookUrl = (bot: TradingBot) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/api/webhook/tradingview/${bot.id}?secret=${bot.webhookSecret}`;
  };

  const getMessageTemplate = () => {
    return `order {{strategy.order.action}} @ {{strategy.order.contracts}} filled on {{ticker}}. New strategy position is {{strategy.position_size}}`;
  };

  const handleAddEquity = async () => {
    if (!selectedBot || !equityAmount || parseFloat(equityAmount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    setIsProcessingEquity(true);
    try {
      const response = await fetch(`/api/bot/${selectedBot.id}/deposit`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-wallet-address': solanaWallet.publicKey.toString(),
        },
        body: JSON.stringify({ amount: parseFloat(equityAmount) }),
        credentials: 'include',
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to allocate equity');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = data;
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      
      if (!solanaWallet.signTransaction) {
        throw new Error('Wallet does not support signing');
      }
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Equity Allocated Successfully!', 
        description: message 
      });
      
      setEquityAmount('');
      setShowAddEquityDialog(false);
      
      // Refresh bots to update balances
      await fetchBots();
    } catch (error: any) {
      console.error('Equity allocation error:', error);
      toast({ 
        title: 'Failed to allocate equity', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsProcessingEquity(false);
    }
  };

  if (!connected) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-accent/10 rounded-full blur-[120px]" />
      </div>

      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate('/app')}
              data-testid="button-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="font-display font-bold text-xl">TradingView Signal Bot</h1>
                <p className="text-sm text-muted-foreground">Connect your TradingView strategy to Drift Protocol</p>
              </div>
            </div>
          </div>
          
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-primary to-accent" data-testid="button-create-bot">
                <Plus className="w-4 h-4 mr-2" />
                Create Signal Bot
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[450px]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-primary" />
                  Create Signal Bot
                </DialogTitle>
                <DialogDescription>
                  Set up your bot, then copy the webhook URL and message to TradingView
                </DialogDescription>
              </DialogHeader>
              
              <div className="grid gap-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Bot Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g. SOL EMA Crossover"
                    value={newBot.name}
                    onChange={(e) => setNewBot({ ...newBot, name: e.target.value })}
                    data-testid="input-bot-name"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Market</Label>
                  <Select value={newBot.market} onValueChange={(v) => setNewBot({ ...newBot, market: v })}>
                    <SelectTrigger data-testid="select-market">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MARKETS.map((market) => (
                        <SelectItem key={market} value={market}>{market}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Leverage</Label>
                  <Select value={String(newBot.leverage)} onValueChange={(v) => setNewBot({ ...newBot, leverage: parseInt(v) })}>
                    <SelectTrigger data-testid="select-leverage">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 5, 10, 20].map((lev) => (
                        <SelectItem key={lev} value={String(lev)}>{lev}x</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxSize">Position Size (USDC per trade)</Label>
                  <Input
                    id="maxSize"
                    type="number"
                    placeholder="100"
                    value={newBot.maxPositionSize}
                    onChange={(e) => setNewBot({ ...newBot, maxPositionSize: e.target.value })}
                    data-testid="input-max-size"
                  />
                  <p className="text-xs text-muted-foreground">Amount in USDC for each trade signal</p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={createBot}
                  disabled={!newBot.name}
                  className="bg-gradient-to-r from-primary to-accent"
                  data-testid="button-confirm-create"
                >
                  Create & Get Webhook
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Dialog open={showWebhookDialog} onOpenChange={setShowWebhookDialog}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <Check className="w-6 h-6 text-emerald-500" />
              Bot Created Successfully!
            </DialogTitle>
            <DialogDescription>
              Copy the webhook URL and message below to your TradingView alert
            </DialogDescription>
          </DialogHeader>
          
          {selectedBot && (
            <div className="space-y-6 py-4">
              <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-primary/10 border border-emerald-500/20">
                <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">1</span>
                  Webhook URL
                </h3>
                <div className="p-3 bg-background/80 rounded-lg font-mono text-sm border" style={{ wordBreak: 'break-word' }}>
                  {getWebhookUrl(selectedBot)}
                </div>
                <Button
                  className="w-full mt-3"
                  onClick={() => copyToClipboard(getWebhookUrl(selectedBot), 'Webhook URL')}
                  data-testid="button-copy-webhook"
                >
                  {copiedField === 'Webhook URL' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                  {copiedField === 'Webhook URL' ? 'Copied!' : 'Copy Webhook URL'}
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Paste this in TradingView Alert → Notifications → Webhook URL
                </p>
              </div>

              <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
                <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">2</span>
                  Alert Message
                </h3>
                <pre className="p-3 bg-background/80 rounded-lg font-mono text-sm border whitespace-pre-wrap" style={{ wordBreak: 'break-word' }}>
{getMessageTemplate()}
                </pre>
                <Button
                  className="w-full mt-3"
                  onClick={() => copyToClipboard(getMessageTemplate(), 'Message')}
                  data-testid="button-copy-message"
                >
                  {copiedField === 'Message' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                  {copiedField === 'Message' ? 'Copied!' : 'Copy Alert Message'}
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Paste this in TradingView Alert → Message field (replace all existing content)
                </p>
              </div>

              <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 border border-blue-500/20">
                <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">3</span>
                  TradingView Strategy Settings
                </h3>
                <p className="text-sm text-muted-foreground mb-3">
                  In TradingView, go to your strategy's Settings → Properties and configure:
                </p>
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between p-2 bg-background/50 rounded-lg">
                    <span className="font-medium">Initial Capital</span>
                    <span className="text-muted-foreground">Set to your total position size (e.g. 100 USDC)</span>
                  </div>
                  <div className="flex items-center justify-between p-2 bg-background/50 rounded-lg">
                    <span className="font-medium">Default Order Size</span>
                    <span className="text-muted-foreground">Size per entry (e.g. 33.33 for 3 entries)</span>
                  </div>
                  <div className="flex items-center justify-between p-2 bg-background/50 rounded-lg">
                    <span className="font-medium">Pyramiding</span>
                    <span className="text-muted-foreground">Number of orders allowed (e.g. 3 orders)</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Example: 100 USDC capital / 33.33 order size / 3 pyramiding = 3 entries of 33.33 each
                </p>
              </div>

              <div className="p-4 rounded-xl bg-muted/50 border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  How The Placeholders Work
                </h3>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.action}}"}</code> → "buy" or "sell" from your strategy</p>
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.contracts}}"}</code> → Order size for this entry (e.g. 33.33)</p>
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.position_size}}"}</code> → Total position after this order</p>
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{ticker}}"}</code> → The trading symbol</p>
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
                  <li>• Make sure your bot is activated before testing</li>
                </ul>
              </div>

              <div className="p-4 rounded-xl bg-gradient-to-br from-green-500/10 to-emerald-500/10 border border-green-500/20">
                <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-green-500 text-white text-sm flex items-center justify-center">4</span>
                  Fund Your Bot
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Your bot needs equity to execute trades. Add USDC from your main account to start trading.
                </p>
                <div className="flex flex-col gap-2">
                  <Button
                    className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600"
                    onClick={() => {
                      setShowWebhookDialog(false);
                      setShowAddEquityDialog(true);
                    }}
                    data-testid="button-add-equity-now"
                  >
                    <Wallet className="w-4 h-4 mr-2" />
                    Add Equity Now
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full text-muted-foreground"
                    onClick={() => setShowWebhookDialog(false)}
                    data-testid="button-add-equity-later"
                  >
                    I'll do this later
                  </Button>
                </div>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => window.open('https://www.tradingview.com/chart/', '_blank')}
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Open TradingView
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setShowWebhookDialog(false)}
                  data-testid="button-done-setup"
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showAddEquityDialog} onOpenChange={setShowAddEquityDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-green-500" />
              Fund Your Bot
            </DialogTitle>
            <DialogDescription>
              Add USDC from your main account to enable your bot to execute trades.
            </DialogDescription>
          </DialogHeader>
          
          {selectedBot && (
            <div className="space-y-4 py-4">
              <div className="p-3 rounded-lg bg-muted/50 border">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="font-semibold">{selectedBot.name}</p>
                    <p className="text-sm text-muted-foreground">{selectedBot.market}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="equity-amount">Amount (USDC)</Label>
                <Input
                  id="equity-amount"
                  type="number"
                  placeholder="100"
                  value={equityAmount}
                  onChange={(e) => setEquityAmount(e.target.value)}
                  className="font-mono"
                  data-testid="input-equity-amount"
                />
                <p className="text-xs text-muted-foreground">
                  This will be transferred from your main Drift account to this bot's subaccount.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <p className="text-xs text-yellow-600">
                  Make sure you have sufficient USDC in your main Drift account before proceeding.
                </p>
              </div>
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full bg-gradient-to-r from-green-500 to-emerald-500"
              onClick={handleAddEquity}
              disabled={!equityAmount || parseFloat(equityAmount) <= 0 || isProcessingEquity}
              data-testid="button-confirm-equity"
            >
              {isProcessingEquity ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Wallet className="w-4 h-4 mr-2" />
                  Add Equity
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setShowAddEquityDialog(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="container mx-auto px-4 py-8">
        {bots.length === 0 && !loading ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-2xl mx-auto text-center py-16"
          >
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center mx-auto mb-6">
              <Bot className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-3">Create Your First Signal Bot</h2>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto">
              Connect your TradingView strategy to automatically execute trades on Drift Protocol. 
              Just copy the webhook URL and message into your TradingView alert.
            </p>
            
            <div className="grid md:grid-cols-3 gap-4 mb-8 text-left">
              <div className="p-4 rounded-xl border bg-card/50">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
                  <span className="text-primary font-bold">1</span>
                </div>
                <h3 className="font-semibold mb-1">Create Bot</h3>
                <p className="text-sm text-muted-foreground">Choose your market and settings</p>
              </div>
              <div className="p-4 rounded-xl border bg-card/50">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
                  <span className="text-primary font-bold">2</span>
                </div>
                <h3 className="font-semibold mb-1">Copy to TradingView</h3>
                <p className="text-sm text-muted-foreground">Paste webhook URL & message into your alert</p>
              </div>
              <div className="p-4 rounded-xl border bg-card/50">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
                  <span className="text-primary font-bold">3</span>
                </div>
                <h3 className="font-semibold mb-1">Auto Trade</h3>
                <p className="text-sm text-muted-foreground">Trades execute when your strategy signals</p>
              </div>
            </div>
            
            <Button 
              size="lg"
              className="bg-gradient-to-r from-primary to-accent"
              onClick={() => setShowCreateDialog(true)}
              data-testid="button-create-first-bot"
            >
              <Plus className="w-5 h-5 mr-2" />
              Create Signal Bot
            </Button>
          </motion.div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <h2 className="text-lg font-semibold">Your Bots</h2>
              {loading ? (
                <div className="space-y-3">
                  {[1, 2].map(i => (
                    <div key={i} className="h-24 rounded-xl bg-muted/50 animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {bots.map((bot) => {
                    const position = getPositionForBot(bot.id);
                    const hasPosition = position && position.baseAssetAmount > 0.0001;
                    const totalPnl = bot.stats?.totalPnl || 0;
                    const unrealizedPnl = position?.unrealizedPnl || 0;
                    
                    return (
                      <motion.div
                        key={bot.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className={`p-5 rounded-xl border cursor-pointer transition-all ${
                          selectedBot?.id === bot.id 
                            ? 'border-primary bg-primary/5' 
                            : 'border-border/50 bg-card/50 hover:border-primary/50'
                        }`}
                        onClick={() => selectBot(bot)}
                        data-testid={`bot-card-${bot.id}`}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                              bot.isActive 
                                ? 'bg-gradient-to-br from-primary to-accent' 
                                : 'bg-muted'
                            }`}>
                              <Bot className={`w-6 h-6 ${bot.isActive ? 'text-white' : 'text-muted-foreground'}`} />
                            </div>
                            <div>
                              <h3 className="font-semibold text-base">{bot.name}</h3>
                              <p className="text-sm text-muted-foreground">{bot.market}</p>
                            </div>
                          </div>
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                            bot.isActive 
                              ? 'bg-emerald-500/20 text-emerald-400' 
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {bot.isActive ? 'Active' : 'Paused'}
                          </span>
                        </div>
                        
                        {hasPosition && (
                          <div className={`mb-3 px-3 py-2 rounded-lg flex items-center justify-between ${
                            position.side === 'LONG' ? 'bg-emerald-500/10' : 'bg-red-500/10'
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
                                {position.baseAssetAmount.toFixed(4)} {position.market.replace('-PERP', '')}
                              </span>
                            </div>
                            <span className={`text-sm font-semibold ${
                              unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}>
                              {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)}
                            </span>
                          </div>
                        )}
                        
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 rounded-lg bg-muted/50">
                            <p className="text-lg font-bold">{bot.stats?.totalTrades || 0}</p>
                            <p className="text-xs text-muted-foreground">Trades</p>
                          </div>
                          <div className="p-2 rounded-lg bg-muted/50">
                            <p className="text-lg font-bold">{bot.leverage}x</p>
                            <p className="text-xs text-muted-foreground">Leverage</p>
                          </div>
                          <div className="p-2 rounded-lg bg-muted/50">
                            <p className={`text-lg font-bold ${
                              totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}>
                              ${Math.abs(totalPnl).toFixed(2)}
                            </p>
                            <p className="text-xs text-muted-foreground">Net P&L</p>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="lg:col-span-2">
              {selectedBot ? (
                <motion.div
                  key={selectedBot.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-6"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-display font-bold">{selectedBot.name}</h2>
                      <p className="text-muted-foreground">{selectedBot.market} • {selectedBot.leverage}x</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowWebhookDialog(true);
                        }}
                        data-testid="button-view-webhook"
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        View Webhook
                      </Button>
                      <Button
                        variant={selectedBot.isActive ? "outline" : "default"}
                        size="sm"
                        onClick={() => toggleBot(selectedBot.id, !selectedBot.isActive)}
                        className={!selectedBot.isActive ? "bg-gradient-to-r from-primary to-accent" : ""}
                        data-testid="button-toggle-bot"
                      >
                        {selectedBot.isActive ? (
                          <>
                            <Pause className="w-4 h-4 mr-1" />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="w-4 h-4 mr-1" />
                            Activate
                          </>
                        )}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteBot(selectedBot.id)}
                        data-testid="button-delete-bot"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <Tabs defaultValue="webhook" className="w-full">
                    <TabsList>
                      <TabsTrigger value="webhook">Webhook Setup</TabsTrigger>
                      <TabsTrigger value="trades">Trade History</TabsTrigger>
                      <TabsTrigger value="stats">Stats</TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="webhook" className="space-y-4 mt-4">
                      <div className="p-4 rounded-xl border bg-card/50">
                        <h3 className="font-semibold mb-3 flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-primary text-white text-xs flex items-center justify-center">1</span>
                          Webhook URL
                        </h3>
                        <div className="relative">
                          <div className="p-3 bg-muted/50 rounded-lg font-mono text-sm break-all">
                            {getWebhookUrl(selectedBot)}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="absolute top-2 right-2"
                            onClick={() => copyToClipboard(getWebhookUrl(selectedBot), 'Webhook URL')}
                          >
                            {copiedField === 'Webhook URL' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl border bg-card/50">
                        <h3 className="font-semibold mb-3 flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-primary text-white text-xs flex items-center justify-center">2</span>
                          Alert Message
                        </h3>
                        <div className="relative">
                          <pre className="p-3 bg-muted/50 rounded-lg font-mono text-sm overflow-x-auto">
{getMessageTemplate()}
                          </pre>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="absolute top-2 right-2"
                            onClick={() => copyToClipboard(getMessageTemplate(), 'Message')}
                          >
                            {copiedField === 'Message' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl border border-dashed bg-muted/20">
                        <h3 className="font-semibold mb-2 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-primary" />
                          TradingView Placeholders
                        </h3>
                        <div className="grid sm:grid-cols-2 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <code className="px-2 py-1 bg-background rounded text-xs">{"{{strategy.order.action}}"}</code>
                            <span className="text-muted-foreground">→ buy/sell</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="px-2 py-1 bg-background rounded text-xs">{"{{close}}"}</code>
                            <span className="text-muted-foreground">→ current price</span>
                          </div>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="trades" className="mt-4">
                      {botTrades.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                          <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-50" />
                          <p>No trades yet</p>
                          <p className="text-sm">Trades will appear here when your TradingView strategy sends signals</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {botTrades.map((trade) => (
                            <div 
                              key={trade.id} 
                              className="p-3 rounded-lg border bg-card/50 flex items-center justify-between"
                              data-testid={`trade-${trade.id}`}
                            >
                              <div className="flex items-center gap-3">
                                <span className={`px-2 py-1 rounded text-xs font-medium ${
                                  trade.side === 'long' 
                                    ? 'bg-emerald-500/20 text-emerald-400' 
                                    : 'bg-red-500/20 text-red-400'
                                }`}>
                                  {trade.side.toUpperCase()}
                                </span>
                                <div>
                                  <p className="font-mono text-sm">{trade.market}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {new Date(trade.executedAt).toLocaleString()}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="font-mono">${trade.size}</p>
                                <p className="text-xs text-muted-foreground">@ ${trade.price}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="stats" className="mt-4">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-4 rounded-xl border bg-card/50 text-center">
                          <p className="text-2xl font-bold font-mono">{(selectedBot as any).actualTradeCount ?? selectedBot.stats?.totalTrades ?? 0}</p>
                          <p className="text-sm text-muted-foreground">Total Trades</p>
                        </div>
                        <div className="p-4 rounded-xl border bg-card/50 text-center">
                          <p className="text-2xl font-bold font-mono text-emerald-400">{selectedBot.stats?.winningTrades || 0}</p>
                          <p className="text-sm text-muted-foreground">Winning</p>
                        </div>
                        <div className="p-4 rounded-xl border bg-card/50 text-center">
                          <p className="text-2xl font-bold font-mono text-red-400">{selectedBot.stats?.losingTrades || 0}</p>
                          <p className="text-sm text-muted-foreground">Losing</p>
                        </div>
                        <div className="p-4 rounded-xl border bg-card/50 text-center">
                          <p className={`text-2xl font-bold font-mono ${
                            parseFloat((selectedBot as any).realizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}>
                            ${parseFloat((selectedBot as any).realizedPnl ?? 0).toFixed(2)}
                          </p>
                          <p className="text-sm text-muted-foreground">Realized PnL</p>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </motion.div>
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  <div className="text-center">
                    <Settings className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>Select a bot to view details</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
