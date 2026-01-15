import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSubscribeToPublishedBot, type PublishedBot } from '@/hooks/useApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import { 
  Loader2, 
  Bot,
  AlertTriangle,
  TrendingUp,
  Users,
  DollarSign
} from 'lucide-react';

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
  const [leverage, setLeverage] = useState('1');
  const [riskAccepted, setRiskAccepted] = useState(false);

  const handleClose = () => {
    setCapitalInvested('');
    setLeverage('1');
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
          leverage: parseInt(leverage),
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="capital">Capital Investment (USDC)</Label>
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

          <div className="space-y-2">
            <Label htmlFor="leverage">Leverage</Label>
            <Select value={leverage} onValueChange={setLeverage}>
              <SelectTrigger id="leverage" data-testid="select-leverage">
                <SelectValue placeholder="Select leverage" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 20 }, (_, i) => i + 1).map((lev) => (
                  <SelectItem key={lev} value={lev.toString()}>
                    {lev}x
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Higher leverage increases both potential profits and losses
            </p>
          </div>

          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-2">
                <p className="text-sm font-medium text-amber-400">Risk Disclaimer</p>
                <p className="text-xs text-muted-foreground">
                  By subscribing to this bot, you acknowledge that:
                </p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                  <li>Past performance does not guarantee future results</li>
                  <li>You may lose some or all of your invested capital</li>
                  <li>Trading involves substantial risk</li>
                  <li>You are making your own investment decisions</li>
                </ul>
              </div>
            </div>
          </div>

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
