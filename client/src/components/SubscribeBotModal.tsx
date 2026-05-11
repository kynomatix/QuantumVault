import { safeResponseJson } from "@/lib/safe-fetch";
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
  ChevronDown,
  Fuel,
  Shield,
  CheckCircle2,
  BarChart3,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { useLeverageLimits } from '@/hooks/useLeverageLimits';

interface SubscribeBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  bot: PublishedBot;
  onSubscribed?: () => void;
}

interface RiskAnalysis {
  winRate: number | null;
  totalTrades: number;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
  dataPoints: number;
  suggestedLeverage: number;
  suggestedEquityPct: number;
  hasEnoughData: boolean;
}

function SharpeTag({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const color = value >= 1 ? 'text-emerald-400' : value >= 0 ? 'text-yellow-400' : 'text-red-400';
  const label = value >= 2 ? 'Excellent' : value >= 1 ? 'Good' : value >= 0 ? 'Marginal' : 'Poor';
  return <span className={color}>{value.toFixed(2)} <span className="text-xs opacity-70">({label})</span></span>;
}

function DrawdownTag({ value }: { value: number }) {
  const color = value <= 10 ? 'text-emerald-400' : value <= 25 ? 'text-yellow-400' : 'text-red-400';
  const label = value <= 10 ? 'Low' : value <= 25 ? 'Medium' : 'High';
  return <span className={color}>{value.toFixed(1)}% <span className="text-xs opacity-70">({label})</span></span>;
}

export function SubscribeBotModal({ isOpen, onClose, bot, onSubscribed }: SubscribeBotModalProps) {
  const { toast } = useToast();
  const subscribe = useSubscribeToPublishedBot();
  const wallet = useWallet();
  const { connection } = useConnection();
  const { getMaxLeverage } = useLeverageLimits();
  
  const [capitalInvested, setCapitalInvested] = useState('');
  const [leverage, setLeverage] = useState(1);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [solRequirement, setSolRequirement] = useState<{
    required: number;
    current: number;
    deficit: number;
    canCreate: boolean;
  } | null>(null);
  const [isDepositingSol, setIsDepositingSol] = useState(false);

  const [riskOpen, setRiskOpen] = useState(false);
  const [riskData, setRiskData] = useState<RiskAnalysis | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);

  const maxLeverage = getMaxLeverage(bot.market);
  
  useEffect(() => {
    if (isOpen) {
      setBalanceLoading(true);
      Promise.all([
        fetch('/api/total-equity', { credentials: 'include' }).then(res => res.ok ? safeResponseJson(res) : Promise.reject()),
        fetch('/api/agent/balance', { credentials: 'include' }).then(res => res.ok ? safeResponseJson(res) : Promise.reject())
      ])
        .then(([equityData, balanceData]) => {
          setAvailableBalance(equityData.agentBalance ?? 0);
          if (balanceData.botCreationSolRequirement) {
            setSolRequirement(balanceData.botCreationSolRequirement);
          }
        })
        .catch(() => {
          setAvailableBalance(null);
          setSolRequirement(null);
        })
        .finally(() => setBalanceLoading(false));
    }
  }, [isOpen]);

  const handleRiskToggle = async () => {
    if (riskOpen) {
      setRiskOpen(false);
      return;
    }
    setRiskOpen(true);
    if (riskData) return;
    setRiskLoading(true);
    try {
      const res = await fetch(`/api/marketplace/${bot.id}/risk-analysis`, { credentials: 'include' });
      if (res.ok) {
        setRiskData(await safeResponseJson(res));
      }
    } catch {
    } finally {
      setRiskLoading(false);
    }
  };

  const enteredCapital = parseFloat(capitalInvested);
  const baseAmount = enteredCapital > 0 ? enteredCapital : (availableBalance ?? 0);
  const baseLabel = enteredCapital > 0 ? 'entered amount' : 'available balance';

  const handleApplySuggestions = () => {
    if (!riskData) return;
    const suggested = baseAmount * riskData.suggestedEquityPct;
    if (suggested >= 10) {
      setCapitalInvested(suggested.toFixed(2));
    } else if (suggested > 0) {
      setCapitalInvested('10');
    }
    setLeverage(Math.min(riskData.suggestedLeverage, maxLeverage));
    toast({ title: 'Risk settings applied', description: 'Capital and leverage updated to conservative suggestions.' });
  };

  const handleSolDeposit = async () => {
    if (!solRequirement || solRequirement.canCreate) return;
    
    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    const amount = solRequirement.deficit;
    
    setIsDepositingSol(true);
    try {
      const response = await fetch('/api/agent/deposit-sol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'SOL deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await safeResponseJson(response);
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await wallet.signTransaction(transaction);
      
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ title: 'SOL deposited successfully!' });
      
      const balanceRes = await fetch('/api/agent/balance', { credentials: 'include' });
      if (balanceRes.ok) {
        const data = await safeResponseJson(balanceRes);
        if (data.botCreationSolRequirement) {
          setSolRequirement(data.botCreationSolRequirement);
        }
      }
      
    } catch (error: any) {
      console.error('SOL deposit failed:', error);
      toast({ 
        title: 'SOL Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositingSol(false);
    }
  };
  
  const handleMax = () => {
    if (availableBalance !== null && availableBalance > 0) {
      setCapitalInvested(availableBalance.toFixed(2));
    }
  };

  const handleClose = () => {
    setCapitalInvested('');
    setLeverage(1);
    setRiskAccepted(false);
    setRiskOpen(false);
    setRiskData(null);
    onClose();
  };

  const handleSubscribe = async () => {
    const capital = parseFloat(capitalInvested);
    
    if (!capital || capital <= 0) {
      toast({ title: 'Please enter a valid investment amount', variant: 'destructive' });
      return;
    }

    const MIN_SUBSCRIPTION_USDC = 10;
    if (capital < MIN_SUBSCRIPTION_USDC) {
      toast({
        title: 'Minimum subscription is $10',
        description: `Pacifica enforces a $10 USDC minimum. You entered $${capital.toFixed(2)}.`,
        variant: 'destructive',
      });
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

        {/* SOL Balance Warning */}
        {solRequirement && !solRequirement.canCreate && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mt-2" data-testid="warning-sol-insufficient-subscribe">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-yellow-400">
                  Insufficient SOL for Transaction Fees
                </p>
                <p className="text-xs text-muted-foreground">
                  Subscribing requires {solRequirement.required.toFixed(3)} SOL for transaction fees. 
                  Your agent wallet has {solRequirement.current.toFixed(4)} SOL.
                </p>
                <p className="text-xs text-yellow-400/80">
                  Please deposit at least <span className="font-semibold">{solRequirement.deficit.toFixed(3)} SOL</span> to your agent wallet.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Bot info card */}
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

          {/* Investment Amount (mirrors Create Bot terminology) */}
          <div className="space-y-2">
            <Label htmlFor="capital">Investment Amount (USDC)</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="capital"
                  type="number"
                  min="10"
                  step="0.01"
                  value={capitalInvested}
                  onChange={(e) => setCapitalInvested(e.target.value)}
                  placeholder="Min $10"
                  className="pl-9 font-mono"
                  data-testid="input-capital"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleMax}
                disabled={!availableBalance || availableBalance <= 0}
                className="px-3"
                data-testid="button-max"
              >
                Max
              </Button>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Wallet className="w-3 h-3" />
              {balanceLoading ? 'Loading balance...' : (
                <>Available in agent wallet: <span className="font-medium">${availableBalance?.toFixed(2) ?? '0.00'}</span></>
              )}
            </p>
          </div>

          {/* Leverage */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <Label className="flex items-center gap-1.5">
                Leverage
                {maxLeverage < 10 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                    Max {maxLeverage}x
                  </span>
                )}
              </Label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRiskToggle}
                  className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors"
                  data-testid="button-risk-analysis"
                >
                  <Shield className="w-3 h-3" />
                  {riskOpen ? 'Hide' : 'Suggest safe settings'}
                </button>
                <span className="text-sm font-medium text-primary">{leverage}x</span>
              </div>
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
                  {bot.market.replace('-PERP', '')} has a max leverage of {maxLeverage}x. 
                  Trades exceeding this will fail with "insufficient margin".
                </p>
              </div>
            )}
          </div>

          {/* Max Position Size preview — mirrors Create Bot modal */}
          {enteredCapital > 0 && (
            <div className="p-3 rounded-lg bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20" data-testid="display-max-position-size">
              <div className="flex items-center gap-2 text-sm">
                <TrendingUp className="w-4 h-4 text-primary" />
                <span className="text-muted-foreground">Max Position Size:</span>
                <span className="font-bold text-lg text-primary font-mono">
                  ${(enteredCapital * Math.min(leverage, maxLeverage)).toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                ${enteredCapital.toFixed(2)} investment × {Math.min(leverage, maxLeverage)}x leverage
              </p>
            </div>
          )}

          {/* Risk analysis panel */}
          {riskOpen && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="risk-analysis-panel">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">Risk Analysis</span>
                <span className="text-xs text-muted-foreground ml-auto">Based on live trading history</span>
              </div>

              {riskLoading ? (
                <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Analysing strategy...</span>
                </div>
              ) : riskData ? (
                <>
                  {!riskData.hasEnoughData && (
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
                      <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span>Limited data ({riskData.dataPoints} days). Suggestions are estimates — treat with caution.</span>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Max Drawdown</p>
                      <p className="text-sm font-mono font-medium">
                        <DrawdownTag value={riskData.maxDrawdownPct} />
                      </p>
                    </div>
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Sharpe Ratio</p>
                      <p className="text-sm font-mono font-medium">
                        <SharpeTag value={riskData.sharpeRatio} />
                      </p>
                    </div>
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Win Rate</p>
                      <p className="text-sm font-mono font-medium">
                        {riskData.winRate !== null ? `${riskData.winRate.toFixed(1)}%` : '—'}
                        <span className="text-[10px] text-muted-foreground ml-1">({riskData.totalTrades} trades)</span>
                      </p>
                    </div>
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Data Points</p>
                      <p className="text-sm font-mono font-medium text-muted-foreground">{riskData.dataPoints} days</p>
                    </div>
                  </div>

                  {(() => {
                    const suggestedLev = Math.min(riskData.suggestedLeverage, maxLeverage);
                    const suggestedInvestment = baseAmount * riskData.suggestedEquityPct;
                    const suggestedMaxPos = suggestedInvestment * suggestedLev;
                    return (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 space-y-1.5">
                        <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <Shield className="w-3 h-3" />
                          Conservative suggestion
                        </p>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Investment Amount</span>
                          <span className="font-mono font-medium">
                            {baseAmount > 0 ? `$${suggestedInvestment.toFixed(2)}` : '—'}
                            <span className="text-muted-foreground ml-1">({Math.round(riskData.suggestedEquityPct * 100)}%)</span>
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Leverage</span>
                          <span className="font-mono font-medium">{suggestedLev}x</span>
                        </div>
                        <div className="flex justify-between text-xs pt-1 border-t border-emerald-500/20">
                          <span className="text-muted-foreground">Resulting Max Position</span>
                          <span className="font-mono font-semibold text-emerald-400">
                            {baseAmount > 0 ? `$${suggestedMaxPos.toFixed(2)}` : '—'}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground pt-1">
                          Based on your {baseLabel}. A repeat of the worst observed drawdown would cost roughly 20% of this investment amount.
                        </p>
                      </div>
                    );
                  })()}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 border-primary/30 text-primary hover:bg-primary/10"
                    onClick={handleApplySuggestions}
                    data-testid="button-apply-risk-suggestions"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Apply suggestions
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-2">Could not load risk data for this bot.</p>
              )}
            </div>
          )}

          {/* Risk disclaimer */}
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
          <Button variant="outline" onClick={handleClose} disabled={isDepositingSol} data-testid="button-cancel-subscribe">
            Cancel
          </Button>
          {solRequirement && !solRequirement.canCreate ? (
            <Button 
              onClick={handleSolDeposit} 
              disabled={isDepositingSol}
              className="bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600"
              data-testid="button-deposit-sol-for-subscribe"
            >
              {isDepositingSol ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Depositing...
                </>
              ) : (
                <>
                  <Fuel className="w-4 h-4 mr-2" />
                  Deposit {solRequirement.deficit.toFixed(3)} SOL
                </>
              )}
            </Button>
          ) : (
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
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
