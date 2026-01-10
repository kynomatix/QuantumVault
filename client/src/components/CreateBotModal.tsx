import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { 
  Zap, 
  Loader2, 
  Check, 
  Copy, 
  Wallet, 
  ExternalLink, 
  AlertCircle, 
  Sparkles,
  Bot,
  Settings
} from 'lucide-react';

interface TradingBot {
  id: string;
  name: string;
  market: string;
  webhookSecret: string;
  leverage: number;
}

interface CreateBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onBotCreated: () => void;
}

const MARKETS = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

export function CreateBotModal({ isOpen, onClose, walletAddress, onBotCreated }: CreateBotModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [step, setStep] = useState<'create' | 'success' | 'equity'>('create');
  const [createdBot, setCreatedBot] = useState<TradingBot | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [equityAmount, setEquityAmount] = useState('');
  const [isProcessingEquity, setIsProcessingEquity] = useState(false);
  const [agentBalance, setAgentBalance] = useState<string | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [userWebhookUrl, setUserWebhookUrl] = useState<string | null>(null);
  const [isLoadingWebhookUrl, setIsLoadingWebhookUrl] = useState(false);
  const [editLeverage, setEditLeverage] = useState(10);
  const [editMaxPositionSize, setEditMaxPositionSize] = useState('100');
  
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    leverage: 1,
    totalInvestment: '100',
  });

  const resetState = () => {
    setStep('create');
    setCreatedBot(null);
    setCopiedField(null);
    setEquityAmount('');
    setAgentBalance(null);
    setUserWebhookUrl(null);
    setEditLeverage(10);
    setEditMaxPositionSize('100');
    setNewBot({
      name: '',
      market: 'SOL-PERP',
      leverage: 1,
      totalInvestment: '100',
    });
  };

  const createBot = async () => {
    if (!walletAddress || !newBot.name) {
      toast({ title: 'Please enter a bot name', variant: 'destructive' });
      return;
    }
    
    setIsCreating(true);
    try {
      const res = await fetch('/api/trading-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          name: newBot.name,
          market: newBot.market,
          leverage: newBot.leverage,
          totalInvestment: newBot.totalInvestment || '100',
        }),
      });
      
      if (res.ok) {
        const bot = await res.json();
        setCreatedBot(bot);
        setStep('success');
        fetchUserWebhookUrl();
        toast({ title: 'Bot created! Copy your webhook details below.' });
        onBotCreated();
      } else {
        const error = await res.json();
        toast({ title: 'Failed to create bot', description: error.error, variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to create bot', variant: 'destructive' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetState();
      onClose();
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast({ title: `${field} copied to clipboard` });
    setTimeout(() => setCopiedField(null), 2000);
  };

  const fetchUserWebhookUrl = async () => {
    setIsLoadingWebhookUrl(true);
    try {
      const res = await fetch(`/api/user/webhook-url?wallet=${walletAddress}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUserWebhookUrl(data.webhookUrl);
      }
    } catch (error) {
      console.error('Failed to fetch user webhook URL:', error);
    } finally {
      setIsLoadingWebhookUrl(false);
    }
  };

  const getMessageTemplate = (botId: string) => {
    return `{
  "botId": "${botId}",
  "action": "{{strategy.order.action}}",
  "contracts": "{{strategy.order.contracts}}",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{timenow}}",
  "position_size": "{{strategy.position_size}}"
}`;
  };

  const fetchAgentBalance = async () => {
    setIsLoadingBalance(true);
    try {
      const res = await fetch(`/api/agent/balance?wallet=${walletAddress}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAgentBalance(data.balance?.toString() || '0');
      }
    } catch (error) {
      console.error('Failed to fetch balance:', error);
    } finally {
      setIsLoadingBalance(false);
    }
  };

  const handleAddEquity = async () => {
    if (!createdBot) {
      toast({ title: 'No bot found', variant: 'destructive' });
      return;
    }
    
    if (!editMaxPositionSize || parseFloat(editMaxPositionSize) <= 0) {
      toast({ title: 'Please set a valid Max Position Size', variant: 'destructive' });
      return;
    }

    setIsProcessingEquity(true);
    try {
      // First, save the bot settings (leverage and max position size)
      const settingsRes = await fetch(`/api/trading-bots/${createdBot.id}?wallet=${walletAddress}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          leverage: editLeverage,
          maxPositionSize: parseFloat(editMaxPositionSize),
        }),
      });
      
      if (!settingsRes.ok) {
        const err = await settingsRes.json();
        throw new Error(err.error || 'Failed to save bot settings');
      }

      toast({ 
        title: 'Bot Configured Successfully!', 
        description: `${editLeverage}x leverage, $${editMaxPositionSize} max position` 
      });
      
      onBotCreated();
      handleClose();
    } catch (error: any) {
      console.error('Bot configuration error:', error);
      toast({ 
        title: 'Failed to configure bot', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsProcessingEquity(false);
    }
  };

  const goToEquityStep = () => {
    setStep('equity');
    fetchAgentBalance();
  };

  const renderCreateStep = () => (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          Create Signal Bot
        </DialogTitle>
        <DialogDescription>
          Set up a new TradingView signal bot for automated trading
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
                <SelectItem key={market} value={market}>
                  {market}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="space-y-3">
          <div className="flex justify-between">
            <Label>Leverage</Label>
            <span className="text-sm font-medium text-primary">{newBot.leverage}x</span>
          </div>
          <Slider
            value={[newBot.leverage]}
            onValueChange={(v) => setNewBot({ ...newBot, leverage: v[0] })}
            min={1}
            max={20}
            step={1}
            data-testid="slider-leverage"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>1x (Safe)</span>
            <span>20x (High Risk)</span>
          </div>
        </div>

      </div>

      <DialogFooter>
        <Button variant="outline" onClick={handleClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button 
          onClick={createBot} 
          disabled={isCreating || !newBot.name}
          className="bg-gradient-to-r from-primary to-accent"
          data-testid="button-confirm-create-bot"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            'Create Bot'
          )}
        </Button>
      </DialogFooter>
    </>
  );

  const renderSuccessStep = () => {
    if (!createdBot) return null;

    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Check className="w-6 h-6 text-emerald-500" />
            Bot Created Successfully!
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium">{createdBot.name}</span> • {createdBot.market}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6 py-4 max-h-[60vh] overflow-y-auto">
          <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">1</span>
              Alert Message
            </h3>
            <pre className="p-3 bg-background/80 rounded-lg font-mono text-sm border whitespace-pre-wrap" style={{ wordBreak: 'break-word' }}>
{getMessageTemplate(createdBot.id)}
            </pre>
            <Button
              className="w-full mt-3"
              onClick={() => copyToClipboard(getMessageTemplate(createdBot.id), 'Message')}
              data-testid="button-copy-message"
            >
              {copiedField === 'Message' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
              {copiedField === 'Message' ? 'Copied!' : 'Copy Alert Message'}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Paste this in TradingView Alert → Message field. The botId routes signals to this specific bot.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-primary/10 border border-emerald-500/20">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-white text-sm flex items-center justify-center">2</span>
              Webhook URL
            </h3>
            <div className="p-3 bg-background/80 rounded-lg font-mono text-sm border" style={{ wordBreak: 'break-word' }}>
              {isLoadingWebhookUrl ? (
                <span className="text-muted-foreground">Loading...</span>
              ) : (
                userWebhookUrl || 'Loading webhook URL...'
              )}
            </div>
            <Button
              className="w-full mt-3"
              onClick={() => userWebhookUrl && copyToClipboard(userWebhookUrl, 'Webhook URL')}
              disabled={!userWebhookUrl}
              data-testid="button-copy-webhook"
            >
              {copiedField === 'Webhook URL' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
              {copiedField === 'Webhook URL' ? 'Copied!' : 'Copy Webhook URL'}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              This is your universal webhook URL - same for all bots! Paste in TradingView Alert → Notifications → Webhook URL
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
                <span className="text-muted-foreground">Set to <strong>100</strong> (represents 100%)</span>
              </div>
              <div className="flex items-center justify-between p-2 bg-background/50 rounded-lg">
                <span className="font-medium">Default Order Size</span>
                <span className="text-muted-foreground">% per entry (33.33 for 3 entries, 100 for 1 entry)</span>
              </div>
              <div className="flex items-center justify-between p-2 bg-background/50 rounded-lg">
                <span className="font-medium">Pyramiding</span>
                <span className="text-muted-foreground">Number of entries allowed (e.g. 3)</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              TradingView sends a % value → Platform trades that % of your bot's Max Position Size
            </p>
          </div>

          <div className="p-4 rounded-xl bg-muted/50 border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              How It Works
            </h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p><strong>1.</strong> Set your bot's <strong>Max Position Size</strong> (e.g. $100)</p>
              <p><strong>2.</strong> In TradingView, set <strong>Initial Capital: 100</strong> and <strong>Order Size: 33.33</strong> (for 3 entries)</p>
              <p><strong>3.</strong> TradingView sends 33.33 → Platform trades 33.33% of your Max Position Size</p>
              <div className="pt-2 border-t mt-2">
                <p className="font-medium text-foreground mb-1">Key placeholders:</p>
                <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.contracts}}"}</code> → % of your capital (33.33 = 33.33%)</p>
                <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.order.action}}"}</code> → "buy" or "sell"</p>
                <p><code className="px-1 py-0.5 bg-background rounded text-xs">{"{{strategy.position_size}}"}</code> → Detects SL/TP closes (0 = close)</p>
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
              <li>• Make sure your bot is activated before proceeding</li>
            </ul>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-green-500/10 to-emerald-500/10 border border-green-500/20">
            <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-green-500 text-white text-sm flex items-center justify-center">4</span>
              Configure Trading Settings
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Set your leverage and max position size to complete the bot setup.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600"
                onClick={goToEquityStep}
                data-testid="button-add-equity-now"
              >
                <Settings className="w-4 h-4 mr-2" />
                Configure Now
              </Button>
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={handleClose}
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
              onClick={handleClose}
              data-testid="button-done-setup"
            >
              Done
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderEquityStep = () => {
    if (!createdBot) return null;

    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" />
            Configure Your Bot
          </DialogTitle>
          <DialogDescription>
            Set your trading parameters to complete the setup.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="font-semibold">{createdBot.name}</p>
                <p className="text-sm text-muted-foreground">{createdBot.market}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-position-size">Max Position Size (USDC)</Label>
            <Input
              id="max-position-size"
              type="number"
              placeholder="100"
              value={editMaxPositionSize}
              onChange={(e) => setEditMaxPositionSize(e.target.value)}
              className="font-mono"
              data-testid="input-max-position-size"
            />
            <p className="text-xs text-muted-foreground">
              Maximum capital for this bot. TradingView sends a % of this amount per trade.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between">
              <Label>Leverage</Label>
              <span className="text-sm font-medium text-primary">{editLeverage}x</span>
            </div>
            <Slider
              value={[editLeverage]}
              onValueChange={(v) => setEditLeverage(v[0])}
              min={1}
              max={20}
              step={1}
              data-testid="slider-leverage-equity"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1x (Safe)</span>
              <span>20x (High Risk)</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <p className="text-xs text-blue-600">
              <strong>Example:</strong> $100 max position × 33.33% signal × {editLeverage}x leverage = ${(100 * 0.3333 * editLeverage).toFixed(2)} position
            </p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="w-full bg-gradient-to-r from-green-500 to-emerald-500"
            onClick={handleAddEquity}
            disabled={!editMaxPositionSize || parseFloat(editMaxPositionSize) <= 0 || isProcessingEquity}
            data-testid="button-confirm-equity"
          >
            {isProcessingEquity ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Complete Setup'
            )}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => setStep('success')}
          >
            Back
          </Button>
        </DialogFooter>
      </>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className={step === 'success' ? "sm:max-w-[600px]" : "sm:max-w-[450px]"}>
        {step === 'create' && renderCreateStep()}
        {step === 'success' && renderSuccessStep()}
        {step === 'equity' && renderEquityStep()}
      </DialogContent>
    </Dialog>
  );
}
