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
  maxDrawdownPct: number;        // 1x-equivalent baseline (% units)
  observedDrawdownPct?: number;  // actual observed DD at creator's leverage (% units)
  creatorLeverage?: number;
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
  const [isDepositingUsdc, setIsDepositingUsdc] = useState(false);

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
  const baseLabel = enteredCapital > 0 ? 'entered capital' : 'available balance';

  // USDC capital top-up: when user enters more capital than their agent wallet has,
  // surface the shortfall so they can deposit it in one click instead of failing on
  // submit. Mirrors the SOL gas top-up flow above.
  const usdcDeficit = enteredCapital > 0 && availableBalance !== null
    ? Math.max(0, enteredCapital - availableBalance)
    : 0;
  const needsUsdcDeposit = usdcDeficit > 0 && enteredCapital >= 10;

  // QuantumLab-style two-part allocation: split Capital into Investment + Equity Buffer.
  // worstCase = max(observedDD, baseDD × subscriberLev). The max() guard means we never
  // promise a subscriber LESS risk than the bot has historically shown, even if they pick
  // lower leverage than the creator — a 100% drawdown bot stays a 100% drawdown bot.
  // tradeSize = capital / (1 + worstCase × 1.5), matching QuantumLab's bufferMultiplier.
  const effLeverage = Math.min(leverage, maxLeverage);
  const baseDrawdownPct = riskData?.maxDrawdownPct ?? 15;
  const observedDD = riskData?.observedDrawdownPct ?? 0;
  const scaledDD = baseDrawdownPct * effLeverage;
  const worstCaseLossPct = Math.max(scaledDD, observedDD);
  const bufferMultiplier = 1.5;
  const tradeSizeRaw = enteredCapital > 0
    ? enteredCapital / (1 + (worstCaseLossPct / 100) * bufferMultiplier)
    : 0;
  const investmentAmount = Math.floor(tradeSizeRaw);
  const equityBuffer = enteredCapital > 0 ? Math.ceil(enteredCapital - tradeSizeRaw) : 0;
  const tradingPercent = enteredCapital > 0 ? (investmentAmount / enteredCapital) * 100 : 0;
  const bufferPercent = enteredCapital > 0 ? (equityBuffer / enteredCapital) * 100 : 0;
  const projectedLoss = (worstCaseLossPct / 100) * investmentAmount;
  const survivable = worstCaseLossPct < 80;

  // Auto Top-Up should only be recommended for *high-confidence* bots. A bot with
  // 90% drawdown should NEVER auto-replenish — it'd just chew through the user's
  // agent wallet. Gate by quality: known + low DD AND positive risk-adjusted perf.
  const sharpeForGate = riskData?.sharpeRatio ?? null;
  const winRateForGate = riskData?.winRate ?? null;
  // Bucket DD into unknown / healthy / tooHigh so the UI copy can be honest about
  // each case (instead of conflating "no data" with "very risky").
  const ddBucket: 'unknown' | 'healthy' | 'tooHigh' =
    !riskData || !riskData.hasEnoughData || observedDD <= 0
      ? 'unknown'
      : observedDD < 30
      ? 'healthy'
      : 'tooHigh';
  const performanceIsHealthy =
    (sharpeForGate !== null && sharpeForGate >= 0.5) ||
    (winRateForGate !== null && winRateForGate >= 55);
  const recommendAutoTopUp =
    bufferPercent > 30 && ddBucket === 'healthy' && performanceIsHealthy;

  const handleApplySuggestions = () => {
    if (!riskData) return;
    // Suggestion sets Capital to the FULL base amount (so the buffer absorbs DD)
    // and applies the suggested leverage. The split is then derived automatically.
    if (baseAmount >= 10) {
      setCapitalInvested(baseAmount.toFixed(2));
    } else {
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
  
  const handleUsdcDeposit = async () => {
    if (usdcDeficit <= 0) return;

    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    // Round to 2 decimals to keep the on-chain transfer amount in sync with what
    // the button label shows ("Deposit $X.XX USDC"). USDC supports 6 decimals, so
    // this is well within precision and avoids float-drift mismatches.
    const amount = Math.ceil(usdcDeficit * 100) / 100;

    setIsDepositingUsdc(true);
    try {
      const response = await fetch('/api/agent/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'USDC deposit failed');
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

      toast({ title: `Deposited $${amount.toFixed(2)} USDC successfully` });

      // Refresh both balance sources in parallel so SOL gating and USDC gating
      // stay coherent (the user's main wallet just paid SOL fees for this tx).
      const [equityRes, balanceRes] = await Promise.all([
        fetch('/api/total-equity', { credentials: 'include' }),
        fetch('/api/agent/balance', { credentials: 'include' }),
      ]);
      if (equityRes.ok) {
        const data = await safeResponseJson(equityRes);
        setAvailableBalance(data.agentBalance ?? 0);
      }
      if (balanceRes.ok) {
        const data = await safeResponseJson(balanceRes);
        if (data.botCreationSolRequirement) {
          setSolRequirement(data.botCreationSolRequirement);
        }
      }
    } catch (error: any) {
      console.error('USDC deposit failed:', error);
      toast({
        title: 'USDC Deposit Failed',
        description: error.message || 'Please try again',
        variant: 'destructive',
      });
    } finally {
      setIsDepositingUsdc(false);
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

    // The Investment + Buffer split only applies when the user opted into the
    // suggest-safe-settings flow. In the default flow the full capital is the
    // sizing baseline — no buffer carve-out, no extra validation.
    if (riskOpen && investmentAmount < 10) {
      toast({
        title: 'Investment amount too small',
        description: `After reserving the equity buffer, only $${investmentAmount} would trade. Increase capital or lower leverage.`,
        variant: 'destructive',
      });
      return;
    }

    try {
      await subscribe.mutateAsync({
        publishedBotId: bot.id,
        data: {
          capitalInvested: capital,
          leverage: leverage,
          // Only send the carve-out when the user actively used the safe-settings
          // panel; otherwise let the server use the full capital as sizing.
          ...(riskOpen ? { investmentAmount } : {}),
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
      <DialogContent className="sm:max-w-[500px] bg-card border-border max-h-[90vh] overflow-y-auto">
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

        {/* USDC Capital Shortfall Warning */}
        {needsUsdcDeposit && (!solRequirement || solRequirement.canCreate) && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mt-2" data-testid="warning-usdc-insufficient-subscribe">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-yellow-400">
                  Insufficient USDC for Capital
                </p>
                <p className="text-xs text-muted-foreground">
                  This subscription needs ${enteredCapital.toFixed(2)} USDC.
                  Your agent wallet has ${(availableBalance ?? 0).toFixed(2)} USDC.
                </p>
                <p className="text-xs text-yellow-400/80" data-testid="text-usdc-deficit">
                  Please deposit at least <span className="font-semibold">${usdcDeficit.toFixed(2)} USDC</span> to your agent wallet.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Bot info card — collapses to a compact header when the risk panel is open
              so the form fits the viewport without aggressive scrolling. */}
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

            {!riskOpen && (
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
            )}

            {!riskOpen && bot.creator.displayName && (
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

            {!riskOpen && bot.description && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <p className="text-sm text-muted-foreground">{bot.description}</p>
              </div>
            )}
          </div>

          {/* Capital — total deposit. Splits into Investment + Equity Buffer below (matches QuantumLab). */}
          <div className="space-y-2">
            <Label htmlFor="capital">Capital (USDC)</Label>
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

          {/* Two-part allocation — mirrors QuantumLab "Create Bot from Backtest" UX.
              Only shown when the user has explicitly opted into safe-settings,
              so the default flow stays a simple Capital + Leverage form. */}
          {riskOpen && enteredCapital > 0 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="allocation-panel">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Investment Amount</span>
                  <span className="text-sm font-bold tabular-nums" data-testid="text-investment-amount">
                    ${investmentAmount.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Equity Buffer</span>
                  <span className="text-sm font-bold text-indigo-400 tabular-nums" data-testid="text-equity-buffer">
                    +${equityBuffer.toLocaleString()}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${Math.min(100, tradingPercent)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{tradingPercent.toFixed(0)}% trading</span>
                  <span>{bufferPercent.toFixed(0)}% buffer</span>
                </div>
              </div>

              <div className="border-t border-border/50 pt-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Set Leverage</span>
                  <span className="text-sm font-semibold text-primary">{effLeverage}x</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Max Position Size</span>
                  <span className="text-sm font-semibold text-primary tabular-nums" data-testid="text-max-position-size">
                    ${(investmentAmount * effLeverage).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Worst-Case Loss</span>
                  <span className="text-sm font-semibold text-red-400 tabular-nums" data-testid="text-worst-case-loss">
                    -${projectedLoss.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="border-t border-border/50 pt-3 space-y-1.5">
                <p className="text-[10px] text-muted-foreground font-medium mb-1.5">Recommended Settings</p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Auto Top-Up</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${recommendAutoTopUp ? 'bg-sky-500/10 text-sky-400 border-sky-500/30' : 'bg-muted text-muted-foreground border-border'}`}>
                    {recommendAutoTopUp ? 'ON' : 'OFF'}
                  </span>
                </div>
                {!recommendAutoTopUp && riskData && (
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {ddBucket === 'tooHigh'
                      ? `Off — historic drawdown is ${observedDD.toFixed(1)}%. Auto top-up on a high-risk bot would chew through your agent wallet on every loss streak.`
                      : ddBucket === 'unknown'
                      ? 'Off — not enough trading history to confirm this bot is safe to auto-replenish. Enable manually only if you trust the strategy.'
                      : !performanceIsHealthy
                      ? 'Off — risk-adjusted performance (Sharpe / win rate) is too weak to justify replenishing automatically.'
                      : 'Off — buffer is already sized to absorb the projected drawdown.'}
                  </p>
                )}
              </div>

              {/* Explain WHY the buffer ended up where it did so users don't have to guess. */}
              {enteredCapital > 0 && riskData && (
                <p className="text-[10px] text-muted-foreground leading-relaxed pt-1">
                  Buffer = capital × worst-case loss × 1.5 safety factor.
                  Worst-case at {effLeverage}x ≈ {worstCaseLossPct.toFixed(1)}%
                  {observedDD > 0 && ` (historic max: ${observedDD.toFixed(1)}% at ${riskData.creatorLeverage ?? 1}x)`}.
                </p>
              )}

              {!survivable && (
                <div className="flex items-start gap-2 p-2.5 rounded bg-red-500/10 border border-red-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-300 leading-relaxed">
                    Drawdown at {effLeverage}x exceeds 80%. High liquidation risk — consider lower leverage.
                  </p>
                </div>
              )}
              {survivable && equityBuffer > 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded bg-indigo-500/10 border border-indigo-500/20">
                  <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-indigo-300 leading-relaxed">
                    Deposit full ${enteredCapital.toLocaleString()} into the bot. The ${equityBuffer.toLocaleString()} buffer absorbs drawdowns before recovery.
                  </p>
                </div>
              )}
              {!riskData && (
                <p className="text-[10px] text-muted-foreground italic">
                  Allocation uses a default 15% drawdown estimate. Tap "Suggest safe settings" above to load this bot's actual risk profile.
                </p>
              )}
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
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                        Max Drawdown
                        {riskData.creatorLeverage && riskData.creatorLeverage > 1 && (
                          <span className="ml-1 normal-case opacity-60">(at {riskData.creatorLeverage}x)</span>
                        )}
                      </p>
                      <p className="text-sm font-mono font-medium">
                        <DrawdownTag value={riskData.observedDrawdownPct ?? riskData.maxDrawdownPct} />
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
                    const suggestedCapital = baseAmount;
                    const suggestedWorstCasePct = riskData.maxDrawdownPct * suggestedLev;
                    const suggestedTradeRaw = suggestedCapital > 0
                      ? suggestedCapital / (1 + (suggestedWorstCasePct / 100) * 1.5)
                      : 0;
                    const suggestedInv = Math.floor(suggestedTradeRaw);
                    const suggestedBuf = suggestedCapital > 0 ? Math.ceil(suggestedCapital - suggestedTradeRaw) : 0;
                    return (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 space-y-1.5">
                        <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <Shield className="w-3 h-3" />
                          Conservative suggestion
                        </p>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Capital</span>
                          <span className="font-mono font-medium">
                            {suggestedCapital > 0 ? `$${suggestedCapital.toFixed(2)}` : '—'}
                            <span className="text-muted-foreground ml-1">(your {baseLabel})</span>
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">→ Investment</span>
                          <span className="font-mono font-medium">
                            {suggestedCapital > 0 ? `$${suggestedInv.toLocaleString()}` : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">→ Equity Buffer</span>
                          <span className="font-mono font-medium text-indigo-400">
                            {suggestedCapital > 0 ? `+$${suggestedBuf.toLocaleString()}` : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Leverage</span>
                          <span className="font-mono font-medium">{suggestedLev}x</span>
                        </div>
                        <div className="flex justify-between text-xs pt-1 border-t border-emerald-500/20">
                          <span className="text-muted-foreground">Resulting Max Position</span>
                          <span className="font-mono font-semibold text-emerald-400">
                            {suggestedCapital > 0 ? `$${(suggestedInv * suggestedLev).toLocaleString()}` : '—'}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground pt-1">
                          The buffer stays in your bot's account untraded — it absorbs drawdowns so the strategy can recover before liquidation.
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
          <Button variant="outline" onClick={handleClose} disabled={isDepositingSol || isDepositingUsdc} data-testid="button-cancel-subscribe">
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
          ) : needsUsdcDeposit ? (
            <Button
              onClick={handleUsdcDeposit}
              disabled={isDepositingUsdc}
              className="bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600"
              data-testid="button-deposit-usdc-for-subscribe"
            >
              {isDepositingUsdc ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Depositing...
                </>
              ) : (
                <>
                  <DollarSign className="w-4 h-4 mr-2" />
                  Deposit ${usdcDeficit.toFixed(2)} USDC
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleSubscribe}
              disabled={!riskAccepted || !capitalInvested || subscribe.isPending || balanceLoading || (enteredCapital > 0 && availableBalance === null)}
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
