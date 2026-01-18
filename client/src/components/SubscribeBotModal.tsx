import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSubscribeToPublishedBot, type PublishedBot } from '@/hooks/useApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { 
  Loader2, 
  Bot,
  AlertTriangle,
  TrendingUp,
  Users,
  DollarSign,
  Info,
  Wallet,
  ChevronDown
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const MARKET_MAX_LEVERAGE: Record<string, number> = {
  'SOL-PERP': 20,
  'BTC-PERP': 20,
  'ETH-PERP': 20,
  'APT-PERP': 20,
  'ARB-PERP': 20,
  'AVAX-PERP': 20,
  'BNB-PERP': 20,
  'DOGE-PERP': 20,
  'LINK-PERP': 20,
  'OP-PERP': 20,
  'POL-PERP': 20,
  'SUI-PERP': 20,
  'XRP-PERP': 20,
  'LTC-PERP': 10,
  'BCH-PERP': 10,
  'DOT-PERP': 10,
  'ATOM-PERP': 10,
  'NEAR-PERP': 10,
  'FTM-PERP': 10,
  'INJ-PERP': 10,
  'SEI-PERP': 10,
  'TIA-PERP': 10,
  'JTO-PERP': 10,
  'JUP-PERP': 10,
  'PYTH-PERP': 10,
  'RENDER-PERP': 10,
  'WIF-PERP': 10,
  'BONK-PERP': 10,
  '1MBONK-PERP': 10,
  'PEPE-PERP': 10,
  '1MPEPE-PERP': 10,
  'TRUMP-PERP': 10,
  'HYPE-PERP': 10,
  'TAO-PERP': 10,
  'FARTCOIN-PERP': 5,
  'AI16Z-PERP': 5,
  'PENGU-PERP': 5,
  'MELANIA-PERP': 5,
  'BERA-PERP': 5,
  'KAITO-PERP': 5,
  'IP-PERP': 5,
  'ZEC-PERP': 5,
  'ADA-PERP': 5,
  'PAXG-PERP': 5,
  'PUMP-PERP': 5,
  'GOAT-PERP': 5,
  'MOODENG-PERP': 5,
  'POPCAT-PERP': 5,
  'MEW-PERP': 5,
  '1KMEW-PERP': 5,
  'MOTHER-PERP': 5,
  'W-PERP': 3,
  'TNSR-PERP': 5,
  'DRIFT-PERP': 5,
  'CLOUD-PERP': 5,
  'IO-PERP': 5,
  'ME-PERP': 5,
  'RAY-PERP': 5,
  'PNUT-PERP': 5,
  'MICHI-PERP': 5,
  'FWOG-PERP': 5,
  'TON-PERP': 5,
  'HNT-PERP': 5,
  'RLB-PERP': 5,
  'DYM-PERP': 5,
  'KMNO-PERP': 5,
  'ZEX-PERP': 5,
  '1KWEN-PERP': 5,
  'DBR-PERP': 5,
  'WLD-PERP': 5,
  'ASTER-PERP': 10,
  'XPL-PERP': 5,
  '2Z-PERP': 5,
  'MNT-PERP': 5,
  '1KPUMP-PERP': 5,
  'MET-PERP': 5,
  '1KMON-PERP': 5,
  'LIT-PERP': 5,
  'LAUNCHCOIN-PERP': 3,
};

interface SubscribeBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  bot: PublishedBot;
  onSubscribed?: () => void;
}

export function SubscribeBotModal({ isOpen, onClose, bot, onSubscribed }: SubscribeBotModalProps) {
  const { toast } = useToast();
  const subscribe = useSubscribeToPublishedBot();
  
  const [capitalInvested, setCapitalInvested] = useState('');
  const [leverage, setLeverage] = useState(1);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  const maxLeverage = MARKET_MAX_LEVERAGE[bot.market] || 20;
  
  useEffect(() => {
    if (isOpen) {
      setBalanceLoading(true);
      fetch('/api/total-equity', { credentials: 'include' })
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => setAvailableBalance(data.agentBalance ?? 0))
        .catch(() => setAvailableBalance(null))
        .finally(() => setBalanceLoading(false));
    }
  }, [isOpen]);
  
  const handleMax = () => {
    if (availableBalance !== null && availableBalance > 0) {
      setCapitalInvested(availableBalance.toFixed(2));
    }
  };

  const handleClose = () => {
    setCapitalInvested('');
    setLeverage(1);
    setRiskAccepted(false);
    onClose();
  };

  const handleSubscribe = async () => {
    const capital = parseFloat(capitalInvested);
    
    if (!capital || capital <= 0) {
      toast({ title: 'Please enter a valid investment amount', variant: 'destructive' });
      return;
    }
    
    if (!riskAccepted) {
      toast({ title: 'Please accept the risk disclaimer', variant: 'destructive' });
      return;
    }

    try {
      await subscribe.mutateAsync({
        publishedBotId: bot.id,
        data: {
          capitalInvested: capital,
          leverage: leverage,
        },
      });
      
      toast({ title: 'Successfully subscribed to bot!' });
      onSubscribed?.();
      handleClose();
    } catch (error: any) {
      toast({ 
        title: 'Failed to subscribe', 
        description: error.message,
        variant: 'destructive' 
      });
    }
  };

  const winRate = bot.totalTrades > 0 
    ? ((bot.winningTrades / bot.totalTrades) * 100).toFixed(1) 
    : '0';

  const getPnlDisplay = () => {
    const pnl = bot.pnlPercentAllTime ?? bot.pnlPercent30d ?? bot.pnlPercent7d;
    if (!pnl) return null;
    const value = parseFloat(pnl);
    return {
      value,
      display: `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
      isPositive: value >= 0,
    };
  };

  const pnlInfo = getPnlDisplay();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Bot className="w-5 h-5 text-primary" />
            Subscribe to Bot
          </DialogTitle>
          <DialogDescription>
            Copy trades from this strategy automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="p-4 rounded-xl bg-muted/30 border border-border/50">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold">{bot.name}</h3>
                <p className="text-sm text-muted-foreground">{bot.market}</p>
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-2 rounded-lg bg-background/50">
                <div className="flex items-center justify-center gap-1 text-sm font-semibold">
                  <TrendingUp className="w-3 h-3" />
                  {winRate}%
                </div>
                <p className="text-xs text-muted-foreground">Win Rate</p>
              </div>
              <div className="p-2 rounded-lg bg-background/50">
                <div className="flex items-center justify-center gap-1 text-sm font-semibold">
                  <Users className="w-3 h-3" />
                  {bot.subscriberCount}
                </div>
                <p className="text-xs text-muted-foreground">Subscribers</p>
              </div>
              <div className="p-2 rounded-lg bg-background/50">
                {pnlInfo ? (
                  <div className={`text-sm font-semibold ${pnlInfo.isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pnlInfo.display}
                  </div>
                ) : (
                  <div className="text-sm font-semibold text-muted-foreground">--</div>
                )}
                <p className="text-xs text-muted-foreground">All-Time</p>
              </div>
            </div>
            
            {bot.creator.displayName && (
              <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Created by</span>
                <span className="font-medium">
                  {bot.creator.displayName}
                  {bot.creator.xUsername && (
                    <a
                      href={`https://x.com/${bot.creator.xUsername}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline ml-1"
                    >
                      @{bot.creator.xUsername}
                    </a>
                  )}
                </span>
              </div>
            )}
            
            {bot.description && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <p className="text-sm text-muted-foreground">{bot.description}</p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="capital">Capital Investment (USDC)</Label>
              <div className="flex items-center gap-2 text-xs">
                <Wallet className="w-3 h-3 text-muted-foreground" />
                <span className="text-muted-foreground">Available:</span>
                {balanceLoading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                ) : (
                  <span className="font-mono text-primary">
                    ${availableBalance?.toFixed(2) ?? '0.00'}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-5 px-2 text-xs"
                  onClick={handleMax}
                  disabled={!availableBalance || availableBalance <= 0}
                  data-testid="button-max"
                >
                  MAX
                </Button>
              </div>
            </div>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                id="capital"
                type="number"
                min="1"
                step="0.01"
                value={capitalInvested}
                onChange={(e) => setCapitalInvested(e.target.value)}
                placeholder="Enter amount"
                className="pl-9"
                data-testid="input-capital"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This is the amount that will be used for copy trading
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between">
              <Label className="flex items-center gap-1.5">
                Leverage
                {maxLeverage < 10 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                    Max {maxLeverage}x
                  </span>
                )}
              </Label>
              <span className="text-sm font-medium text-primary">{leverage}x</span>
            </div>
            <Slider
              value={[Math.min(leverage, maxLeverage)]}
              onValueChange={(v) => setLeverage(v[0])}
              min={1}
              max={maxLeverage}
              step={1}
              data-testid="slider-leverage"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1x (Safe)</span>
              <span>{maxLeverage}x (Max for {bot.market.replace('-PERP', '')})</span>
            </div>
            {maxLeverage < 10 && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
                <Info className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <p className="text-muted-foreground">
                  {bot.market.replace('-PERP', '')} has a max leverage of {maxLeverage}x on Drift. 
                  Trades exceeding this will fail with "insufficient margin".
                </p>
              </div>
            )}
          </div>

          <Collapsible open={disclaimerOpen} onOpenChange={setDisclaimerOpen}>
            <CollapsibleTrigger asChild>
              <button className="w-full p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <span className="text-sm font-medium text-amber-400">Risk Disclaimer</span>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-amber-400 transition-transform ${disclaimerOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>By subscribing to this signal bot, you acknowledge that:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Past performance does not guarantee future results</li>
                  <li>You may lose some or all of your invested capital</li>
                  <li>Signal bots depend on the creator's TradingView setup — if their signals stop or have issues, your trades will be affected</li>
                  <li>You are solely responsible for your investment decisions</li>
                </ul>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="subscribe-risk-accept"
              checked={riskAccepted}
              onCheckedChange={(checked) => setRiskAccepted(checked === true)}
              data-testid="checkbox-subscribe-risk"
            />
            <Label htmlFor="subscribe-risk-accept" className="text-sm cursor-pointer">
              I understand and accept the risks of copy trading
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-cancel-subscribe">
            Cancel
          </Button>
          <Button
            onClick={handleSubscribe}
            disabled={!riskAccepted || !capitalInvested || subscribe.isPending}
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
            data-testid="button-confirm-subscribe"
          >
            {subscribe.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Subscribing...
              </>
            ) : (
              'Subscribe'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
