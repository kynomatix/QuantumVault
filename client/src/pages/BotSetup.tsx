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
  Eye
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
  const [showWebhookDialog, setShowWebhookDialog] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    side: 'both',
    leverage: 1,
    maxPositionSize: '100',
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
          side: 'both',
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

  const getMessageTemplate = (bot: TradingBot) => {
    return JSON.stringify({
      action: "{{strategy.order.action}}",
      contracts: "{{strategy.order.contracts}}",
      price: "{{close}}",
      position_size: bot.maxPositionSize || "100"
    }, null, 2);
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
                <div className="relative">
                  <div className="p-3 bg-background/80 rounded-lg font-mono text-sm break-all border">
                    {getWebhookUrl(selectedBot)}
                  </div>
                  <Button
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={() => copyToClipboard(getWebhookUrl(selectedBot), 'Webhook URL')}
                    data-testid="button-copy-webhook"
                  >
                    {copiedField === 'Webhook URL' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Paste this in TradingView Alert → Notifications → Webhook URL
                </p>
              </div>

              <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
                <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">2</span>
                  Alert Message
                </h3>
                <div className="relative">
                  <pre className="p-3 bg-background/80 rounded-lg font-mono text-sm overflow-x-auto border">
{getMessageTemplate(selectedBot)}
                  </pre>
                  <Button
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={() => copyToClipboard(getMessageTemplate(selectedBot), 'Message')}
                    data-testid="button-copy-message"
                  >
                    {copiedField === 'Message' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Paste this in TradingView Alert → Message field (replace all existing content)
                </p>
              </div>

              <div className="p-4 rounded-xl bg-muted/50 border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  How TradingView Placeholders Work
                </h3>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.action}}"}</code> → Automatically becomes "buy" or "sell"</p>
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.contracts}}"}</code> → Strategy's position size</p>
                  <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{close}}"}</code> → Current price when alert fires</p>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/5">
                <h3 className="font-semibold mb-2 flex items-center gap-2 text-yellow-600">
                  <AlertCircle className="w-4 h-4" />
                  Important
                </h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Your TradingView strategy must use <code className="px-1 py-0.5 bg-background rounded text-xs">strategy()</code> not <code className="px-1 py-0.5 bg-background rounded text-xs">indicator()</code></li>
                  <li>• Webhook alerts require TradingView Essential plan or higher</li>
                  <li>• Make sure your bot is activated before testing</li>
                </ul>
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
                  className="flex-1 bg-gradient-to-r from-primary to-accent"
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
                <div className="space-y-3">
                  {bots.map((bot) => (
                    <motion.div
                      key={bot.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${
                        selectedBot?.id === bot.id 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border/50 bg-card/50 hover:border-primary/50'
                      }`}
                      onClick={() => selectBot(bot)}
                      data-testid={`bot-card-${bot.id}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                            bot.isActive 
                              ? 'bg-gradient-to-br from-primary to-accent' 
                              : 'bg-muted'
                          }`}>
                            <Bot className={`w-5 h-5 ${bot.isActive ? 'text-white' : 'text-muted-foreground'}`} />
                          </div>
                          <div>
                            <h3 className="font-semibold">{bot.name}</h3>
                            <p className="text-sm text-muted-foreground">{bot.market}</p>
                          </div>
                        </div>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          bot.isActive 
                            ? 'bg-emerald-500/20 text-emerald-400' 
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {bot.isActive ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span>{bot.leverage}x Leverage</span>
                        <span>${bot.maxPositionSize}/trade</span>
                      </div>
                    </motion.div>
                  ))}
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
{getMessageTemplate(selectedBot)}
                          </pre>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="absolute top-2 right-2"
                            onClick={() => copyToClipboard(getMessageTemplate(selectedBot), 'Message')}
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
                          <p className="text-2xl font-bold font-mono">{selectedBot.stats?.totalTrades || 0}</p>
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
                            (selectedBot.stats?.totalPnl || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}>
                            ${(selectedBot.stats?.totalPnl || 0).toFixed(2)}
                          </p>
                          <p className="text-sm text-muted-foreground">Total PnL</p>
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
