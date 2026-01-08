import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'wouter';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/hooks/use-toast';
import { 
  Bot, 
  Plus, 
  Settings, 
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
  RefreshCw
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
import { Switch } from "@/components/ui/switch";

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
  signalConfig: {
    longKeyword?: string;
    shortKeyword?: string;
    exitKeyword?: string;
  } | null;
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
  const { toast } = useToast();
  
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [selectedBot, setSelectedBot] = useState<TradingBot | null>(null);
  const [botTrades, setBotTrades] = useState<BotTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    side: 'both',
    leverage: 1,
    maxPositionSize: '',
    longKeyword: 'LONG',
    shortKeyword: 'SHORT',
    exitKeyword: 'CLOSE',
  });

  useEffect(() => {
    if (!connected) {
      navigate('/');
      return;
    }
    fetchBots();
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
          side: newBot.side,
          leverage: newBot.leverage,
          maxPositionSize: newBot.maxPositionSize || null,
          signalConfig: {
            longKeyword: newBot.longKeyword,
            shortKeyword: newBot.shortKeyword,
            exitKeyword: newBot.exitKeyword,
          },
        }),
      });
      
      if (res.ok) {
        const bot = await res.json();
        setBots([bot, ...bots]);
        setSelectedBot(bot);
        setShowCreateDialog(false);
        setNewBot({
          name: '',
          market: 'SOL-PERP',
          side: 'both',
          leverage: 1,
          maxPositionSize: '',
          longKeyword: 'LONG',
          shortKeyword: 'SHORT',
          exitKeyword: 'CLOSE',
        });
        toast({ title: 'Bot created successfully!' });
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

  const copyWebhookUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    toast({ title: 'Webhook URL copied to clipboard' });
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const selectBot = (bot: TradingBot) => {
    setSelectedBot(bot);
    fetchBotTrades(bot.id);
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
                <h1 className="font-display font-bold text-xl">TradingView Bots</h1>
                <p className="text-sm text-muted-foreground">Configure automated trading</p>
              </div>
            </div>
          </div>
          
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-primary to-accent" data-testid="button-create-bot">
                <Plus className="w-4 h-4 mr-2" />
                Create Bot
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create TradingView Bot</DialogTitle>
                <DialogDescription>
                  Set up a bot to execute trades based on TradingView alerts
                </DialogDescription>
              </DialogHeader>
              
              <div className="grid gap-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Bot Name</Label>
                  <Input
                    id="name"
                    placeholder="My SOL Scalper"
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

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Trade Direction</Label>
                    <Select value={newBot.side} onValueChange={(v) => setNewBot({ ...newBot, side: v })}>
                      <SelectTrigger data-testid="select-side">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Long & Short</SelectItem>
                        <SelectItem value="long">Long Only</SelectItem>
                        <SelectItem value="short">Short Only</SelectItem>
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
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxSize">Max Position Size (USDC)</Label>
                  <Input
                    id="maxSize"
                    type="number"
                    placeholder="100"
                    value={newBot.maxPositionSize}
                    onChange={(e) => setNewBot({ ...newBot, maxPositionSize: e.target.value })}
                    data-testid="input-max-size"
                  />
                </div>

                <div className="p-4 rounded-lg bg-muted/50 space-y-3">
                  <Label className="text-sm font-medium">TradingView Alert Keywords</Label>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Long</Label>
                      <Input
                        value={newBot.longKeyword}
                        onChange={(e) => setNewBot({ ...newBot, longKeyword: e.target.value })}
                        className="h-8 text-sm"
                        data-testid="input-long-keyword"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Short</Label>
                      <Input
                        value={newBot.shortKeyword}
                        onChange={(e) => setNewBot({ ...newBot, shortKeyword: e.target.value })}
                        className="h-8 text-sm"
                        data-testid="input-short-keyword"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Close</Label>
                      <Input
                        value={newBot.exitKeyword}
                        onChange={(e) => setNewBot({ ...newBot, exitKeyword: e.target.value })}
                        className="h-8 text-sm"
                        data-testid="input-exit-keyword"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
                <Button 
                  onClick={createBot} 
                  disabled={!newBot.name}
                  className="bg-gradient-to-r from-primary to-accent"
                  data-testid="button-confirm-create"
                >
                  Create Bot
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-4">
            <h2 className="font-semibold text-lg flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              Your Bots ({bots.length})
            </h2>
            
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="gradient-border p-4 animate-pulse">
                    <div className="h-5 bg-muted rounded w-2/3 mb-2" />
                    <div className="h-4 bg-muted rounded w-1/2" />
                  </div>
                ))}
              </div>
            ) : bots.length === 0 ? (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="gradient-border p-8 text-center"
              >
                <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="font-semibold mb-2">No bots yet</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Create your first TradingView bot to start automated trading
                </p>
                <Button 
                  onClick={() => setShowCreateDialog(true)}
                  className="bg-gradient-to-r from-primary to-accent"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create Bot
                </Button>
              </motion.div>
            ) : (
              <div className="space-y-3">
                {bots.map((bot) => (
                  <motion.div
                    key={bot.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`gradient-border p-4 cursor-pointer transition-all hover:border-primary/50 ${
                      selectedBot?.id === bot.id ? 'border-primary ring-1 ring-primary/20' : ''
                    }`}
                    onClick={() => selectBot(bot)}
                    data-testid={`card-bot-${bot.id}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          bot.isActive ? 'bg-green-500/20' : 'bg-muted'
                        }`}>
                          <Bot className={`w-5 h-5 ${bot.isActive ? 'text-green-400' : 'text-muted-foreground'}`} />
                        </div>
                        <div>
                          <h3 className="font-medium">{bot.name}</h3>
                          <p className="text-sm text-muted-foreground">{bot.market}</p>
                        </div>
                      </div>
                      <div className={`px-2 py-1 rounded text-xs font-medium ${
                        bot.isActive ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground'
                      }`}>
                        {bot.isActive ? 'Active' : 'Paused'}
                      </div>
                    </div>
                    
                    {bot.stats && (
                      <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-4 text-sm">
                        <span className="text-muted-foreground">
                          Trades: <span className="text-foreground">{bot.stats.totalTrades}</span>
                        </span>
                        <span className={bot.stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          PnL: ${bot.stats.totalPnl.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-2">
            {selectedBot ? (
              <motion.div
                key={selectedBot.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-6"
              >
                <div className="gradient-border p-6">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h2 className="text-2xl font-display font-bold">{selectedBot.name}</h2>
                      <p className="text-muted-foreground">{selectedBot.market} • {selectedBot.leverage}x leverage</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => toggleBot(selectedBot.id, !selectedBot.isActive)}
                        data-testid="button-toggle-bot"
                      >
                        {selectedBot.isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => deleteBot(selectedBot.id)}
                        data-testid="button-delete-bot"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg bg-muted/50 mb-6">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <ExternalLink className="w-4 h-4" />
                        TradingView Webhook URL
                      </Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyWebhookUrl(selectedBot.webhookUrl || '')}
                        data-testid="button-copy-webhook"
                      >
                        {copiedUrl ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                        {copiedUrl ? 'Copied!' : 'Copy'}
                      </Button>
                    </div>
                    <code className="text-xs text-muted-foreground break-all block p-2 bg-background rounded">
                      {selectedBot.webhookUrl || 'Generating...'}
                    </code>
                    <p className="text-xs text-muted-foreground mt-2">
                      Use this URL in your TradingView alert webhook settings
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="p-4 rounded-lg bg-muted/30 text-center">
                      <div className="text-2xl font-bold">{selectedBot.stats?.totalTrades || 0}</div>
                      <div className="text-sm text-muted-foreground">Total Trades</div>
                    </div>
                    <div className="p-4 rounded-lg bg-muted/30 text-center">
                      <div className="text-2xl font-bold text-green-400">
                        {selectedBot.stats?.winningTrades || 0}
                      </div>
                      <div className="text-sm text-muted-foreground">Winning</div>
                    </div>
                    <div className="p-4 rounded-lg bg-muted/30 text-center">
                      <div className={`text-2xl font-bold ${
                        (selectedBot.stats?.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}>
                        ${(selectedBot.stats?.totalPnl || 0).toFixed(2)}
                      </div>
                      <div className="text-sm text-muted-foreground">Total PnL</div>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Settings className="w-4 h-4" />
                      Signal Configuration
                    </h4>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Long Keyword:</span>
                        <span className="ml-2 font-mono text-green-400">
                          {selectedBot.signalConfig?.longKeyword || 'LONG'}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Short Keyword:</span>
                        <span className="ml-2 font-mono text-red-400">
                          {selectedBot.signalConfig?.shortKeyword || 'SHORT'}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Close Keyword:</span>
                        <span className="ml-2 font-mono text-yellow-400">
                          {selectedBot.signalConfig?.exitKeyword || 'CLOSE'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="gradient-border p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-primary" />
                      Recent Trades
                    </h3>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => fetchBotTrades(selectedBot.id)}
                      data-testid="button-refresh-trades"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Refresh
                    </Button>
                  </div>

                  {botTrades.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p>No trades yet</p>
                      <p className="text-sm">Trades will appear here when your bot executes</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {botTrades.map((trade) => (
                        <div 
                          key={trade.id} 
                          className="flex items-center justify-between p-3 rounded-lg bg-muted/30"
                          data-testid={`trade-${trade.id}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`px-2 py-1 rounded text-xs font-medium ${
                              trade.side === 'LONG' ? 'bg-green-500/20 text-green-400' :
                              trade.side === 'SHORT' ? 'bg-red-500/20 text-red-400' :
                              'bg-yellow-500/20 text-yellow-400'
                            }`}>
                              {trade.side}
                            </div>
                            <div>
                              <div className="font-medium">{trade.market}</div>
                              <div className="text-xs text-muted-foreground">
                                Size: {trade.size} @ ${parseFloat(trade.price).toFixed(2)}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`text-sm font-medium ${
                              trade.status === 'executed' ? 'text-green-400' :
                              trade.status === 'pending' ? 'text-yellow-400' :
                              'text-red-400'
                            }`}>
                              {trade.status}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(trade.executedAt).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="gradient-border p-12 text-center"
              >
                <Sparkles className="w-16 h-16 mx-auto mb-4 text-primary/50" />
                <h3 className="text-xl font-semibold mb-2">Select a Bot</h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Choose a bot from the list to view its configuration, webhook URL, and trading history
                </p>
              </motion.div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
