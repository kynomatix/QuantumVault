import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useExecutionAuthorization } from '@/hooks/useExecutionAuthorization';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Zap, 
  Loader2, 
  Check, 
  Copy, 
  ExternalLink, 
  AlertCircle, 
  Sparkles,
  ChevronDown,
  Info,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  HelpCircle,
  Shield,
  Fuel
} from 'lucide-react';

interface MarketInfo {
  symbol: string;
  fullName: string;
  marketIndex: number;
  category: string[];
  baseAssetSymbol: string;
  riskTier: 'recommended' | 'caution' | 'high_risk';
  estimatedSlippagePct: number;
  lastPrice: number | null;
  openInterestUsd?: number;
  isActive: boolean;
  warning?: string;
  riskTierInfo: {
    label: string;
    color: string;
    description: string;
  };
}

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
  defaultLeverage?: number;
}

export function CreateBotModal({ isOpen, onClose, walletAddress, onBotCreated, defaultLeverage = 3 }: CreateBotModalProps) {
  const { toast } = useToast();
  const wallet = useWallet();
  const { connection } = useConnection();
  const { executionEnabled, executionLoading, enableExecution, refetchStatus } = useExecutionAuthorization();
  const [isCreating, setIsCreating] = useState(false);
  const [isDepositingSol, setIsDepositingSol] = useState(false);
  const [step, setStep] = useState<'create' | 'success' | 'enable_execution'>('create');
  const [createdBot, setCreatedBot] = useState<TradingBot | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [agentBalance, setAgentBalance] = useState<string | null>(null);
  const [agentSolBalance, setAgentSolBalance] = useState<number | null>(null);
  const [solRequirement, setSolRequirement] = useState<{
    required: number;
    current: number;
    deficit: number;
    canCreate: boolean;
  } | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [userWebhookUrl, setUserWebhookUrl] = useState<string | null>(null);
  const [isLoadingWebhookUrl, setIsLoadingWebhookUrl] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [isLoadingMarkets, setIsLoadingMarkets] = useState(false);
  const [showHighRiskWarning, setShowHighRiskWarning] = useState(false);
  
  const [newBot, setNewBot] = useState({
    name: '',
    market: 'SOL-PERP',
    leverage: defaultLeverage,
    investmentAmount: '',
  });
  
  // Fetch markets on mount
  useEffect(() => {
    const fetchMarkets = async () => {
      if (markets.length > 0) return;
      setIsLoadingMarkets(true);
      try {
        const res = await fetch('/api/drift/markets');
        if (res.ok) {
          const data = await res.json();
          setMarkets(data.markets || []);
        }
      } catch (error) {
        console.error('Failed to fetch markets:', error);
      } finally {
        setIsLoadingMarkets(false);
      }
    };
    fetchMarkets();
  }, []);
  
  // Get selected market info
  const selectedMarket = markets.find(m => m.symbol === newBot.market);
  
  // Check if high-risk market selected
  useEffect(() => {
    if (selectedMarket?.riskTier === 'high_risk') {
      setShowHighRiskWarning(true);
    } else {
      setShowHighRiskWarning(false);
    }
  }, [newBot.market, selectedMarket]);
  
  // Clamp leverage to market's max when market changes
  useEffect(() => {
    const maxLev = MARKET_MAX_LEVERAGE[newBot.market] || 20;
    if (newBot.leverage > maxLev) {
      setNewBot(prev => ({ ...prev, leverage: maxLev }));
    }
  }, [newBot.market]);
  
  // Calculate max position size (investment × leverage)
  const investmentValue = parseFloat(newBot.investmentAmount) || 0;
  const maxPositionSize = investmentValue * newBot.leverage;
  
  // Fetch agent balance when modal opens
  const fetchAgentBalanceOnOpen = async () => {
    if (!walletAddress || agentBalance !== null) return;
    setIsLoadingBalance(true);
    try {
      const res = await fetch(`/api/agent/balance?wallet=${walletAddress}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAgentBalance(data.balance?.toString() || '0');
        setAgentSolBalance(data.solBalance ?? null);
        if (data.botCreationSolRequirement) {
          setSolRequirement(data.botCreationSolRequirement);
        }
      }
    } catch (error) {
      console.error('Failed to fetch balance:', error);
    } finally {
      setIsLoadingBalance(false);
    }
  };
  
  // Fetch balance when modal opens
  if (isOpen && agentBalance === null && !isLoadingBalance) {
    fetchAgentBalanceOnOpen();
  }

  const resetState = () => {
    setStep('create');
    setCreatedBot(null);
    setCopiedField(null);
    setAgentBalance(null);
    setAgentSolBalance(null);
    setSolRequirement(null);
    setUserWebhookUrl(null);
    setInfoOpen(false);
    setNewBot({
      name: '',
      market: 'SOL-PERP',
      leverage: defaultLeverage,
      investmentAmount: '',
    });
  };

  const handleSolDeposit = async () => {
    if (!solRequirement || solRequirement.canCreate) return;
    
    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    const amount = Math.max(solRequirement.deficit + 0.01, 0.05);
    
    setIsDepositingSol(true);
    try {
      const response = await fetch('/api/agent/deposit-sol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'SOL deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await wallet.signTransaction(transaction);
      
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ title: `Deposited ${amount.toFixed(3)} SOL successfully` });
      
      // Refresh balance to check if we can now create bot
      setAgentBalance(null);
      setAgentSolBalance(null);
      setSolRequirement(null);
      
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

  const createBot = async () => {
    if (!walletAddress || !newBot.name) {
      toast({ title: 'Please enter a bot name', variant: 'destructive' });
      return;
    }
    
    // Investment amount is what gets deposited to the bot's subaccount
    const fundingAmount = parseFloat(newBot.investmentAmount) || 0;
    const availableBalance = agentBalance ? parseFloat(agentBalance) : 0;
    
    // Validate funding amount if provided
    if (fundingAmount > 0 && fundingAmount > availableBalance) {
      toast({ 
        title: 'Insufficient balance', 
        description: `You only have $${availableBalance.toFixed(2)} available in your agent wallet`,
        variant: 'destructive' 
      });
      return;
    }
    
    setIsCreating(true);
    try {
      // Step 1: Create the bot
      const res = await fetch('/api/trading-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          name: newBot.name,
          market: newBot.market,
          leverage: newBot.leverage,
          totalInvestment: fundingAmount > 0 ? String(fundingAmount) : '100',
        }),
      });
      
      if (!res.ok) {
        const error = await res.json();
        toast({ title: 'Failed to create bot', description: error.error, variant: 'destructive' });
        return;
      }
      
      const bot = await res.json();
      setCreatedBot(bot);
      
      // Step 2: If funding amount provided, deposit to the bot's subaccount
      if (fundingAmount > 0) {
        // First update bot settings - maxPositionSize = investment × leverage
        const settingsRes = await fetch(`/api/trading-bots/${bot.id}?wallet=${walletAddress}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            leverage: newBot.leverage,
            maxPositionSize: fundingAmount * newBot.leverage,
          }),
        });
        
        if (!settingsRes.ok) {
          console.error('Failed to update bot settings, but bot was created');
        }
        
        // Then deposit the investment amount to the bot's Drift subaccount
        const depositRes = await fetch('/api/agent/drift-deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ amount: fundingAmount, botId: bot.id }),
        });
        
        if (depositRes.ok) {
          toast({ 
            title: 'Bot created and funded!', 
            description: `Invested $${fundingAmount.toFixed(2)} with ${newBot.leverage}x leverage = $${(fundingAmount * newBot.leverage).toFixed(2)} max position` 
          });
        } else {
          const err = await depositRes.json();
          toast({ 
            title: 'Bot created but funding failed', 
            description: err.error || 'You can fund it later from the bot details',
            variant: 'destructive' 
          });
        }
      } else {
        toast({ title: 'Bot created! Copy your webhook details below.' });
      }
      
      setStep('success');
      fetchUserWebhookUrl();
      onBotCreated();
    } catch (error: any) {
      console.error('Bot creation error:', error);
      toast({ title: 'Failed to create bot', description: error.message, variant: 'destructive' });
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
      
      {/* SOL Balance Warning */}
      {solRequirement && !solRequirement.canCreate && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mt-2" data-testid="warning-sol-insufficient">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-yellow-400" data-testid="text-sol-warning-title">
                Insufficient SOL for Bot Setup
              </p>
              <p className="text-xs text-muted-foreground">
                Creating a bot requires {solRequirement.required.toFixed(3)} SOL for subaccount rent and transaction fees. 
                Your agent wallet has {solRequirement.current.toFixed(4)} SOL.
              </p>
              <p className="text-xs text-yellow-400/80" data-testid="text-sol-deficit">
                Please deposit at least <span className="font-semibold">{solRequirement.deficit.toFixed(3)} SOL</span> to your agent wallet before creating a bot.
              </p>
            </div>
          </div>
        </div>
      )}
      
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
          <div className="flex items-center justify-between">
            <Label>Market</Label>
            {selectedMarket && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge 
                      variant={selectedMarket.riskTier === 'recommended' ? 'default' : selectedMarket.riskTier === 'caution' ? 'secondary' : 'destructive'}
                      className={`text-xs cursor-help ${
                        selectedMarket.riskTier === 'recommended' ? 'bg-green-500/20 text-green-400 border-green-500/30' :
                        selectedMarket.riskTier === 'caution' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' :
                        'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}
                    >
                      {selectedMarket.riskTier === 'recommended' && <ShieldCheck className="w-3 h-3 mr-1" />}
                      {selectedMarket.riskTier === 'caution' && <AlertTriangle className="w-3 h-3 mr-1" />}
                      {selectedMarket.riskTier === 'high_risk' && <ShieldAlert className="w-3 h-3 mr-1" />}
                      ~{selectedMarket.estimatedSlippagePct}% slippage
                      <HelpCircle className="w-3 h-3 ml-1 opacity-70" />
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs bg-slate-900 border-slate-700 p-3">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold ${
                          selectedMarket.riskTier === 'recommended' ? 'text-green-400' :
                          selectedMarket.riskTier === 'caution' ? 'text-yellow-400' :
                          'text-red-400'
                        }`}>
                          {selectedMarket.riskTierInfo.label}
                        </span>
                      </div>
                      <p className="text-sm text-slate-300">{selectedMarket.riskTierInfo.description}</p>
                      <div className="border-t border-slate-700 pt-2 mt-2 space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-400">Open Interest:</span>
                          <span className="text-slate-200 font-medium">
                            {selectedMarket.openInterestUsd 
                              ? `$${(selectedMarket.openInterestUsd / 1_000_000).toFixed(2)}M`
                              : 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-400">Est. Slippage:</span>
                          <span className="text-slate-200 font-medium">~{selectedMarket.estimatedSlippagePct}%</span>
                        </div>
                        {selectedMarket.lastPrice && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-400">Price:</span>
                            <span className="text-slate-200 font-medium">${selectedMarket.lastPrice.toLocaleString()}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Select value={newBot.market} onValueChange={(v) => setNewBot({ ...newBot, market: v })}>
            <SelectTrigger data-testid="select-market">
              <SelectValue placeholder={isLoadingMarkets ? "Loading markets..." : "Select market"} />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {isLoadingMarkets ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  <span className="text-sm">Loading markets...</span>
                </div>
              ) : (
                markets.map((market) => (
                  <SelectItem key={market.symbol} value={market.symbol} className="py-2">
                    <div className="flex items-center justify-between w-full gap-3">
                      <span className="font-medium">{market.symbol}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        market.riskTier === 'recommended' ? 'bg-green-500/20 text-green-400' :
                        market.riskTier === 'caution' ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-red-500/20 text-red-400'
                      }`}>
                        {market.riskTier === 'recommended' ? 'Low slip' : 
                         market.riskTier === 'caution' ? 'Med slip' : 'High slip'}
                      </span>
                    </div>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {showHighRiskWarning && selectedMarket && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-red-400">High Slippage Warning</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {selectedMarket.fullName} has ~{selectedMarket.estimatedSlippagePct}% estimated slippage. 
                  Your strategy needs to beat {(selectedMarket.estimatedSlippagePct + 0.05).toFixed(2)}% per trade (slippage + fees) to be profitable.
                  {selectedMarket.warning && ` ${selectedMarket.warning}.`}
                </p>
              </div>
            </div>
          )}
        </div>
        
        <div className="space-y-3">
          <div className="flex justify-between">
            <Label className="flex items-center gap-1.5">
              Leverage
              {(() => {
                const maxLev = MARKET_MAX_LEVERAGE[newBot.market] || 20;
                if (maxLev < 10) {
                  return (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                      Max {maxLev}x
                    </span>
                  );
                }
                return null;
              })()}
            </Label>
            <span className="text-sm font-medium text-primary">{newBot.leverage}x</span>
          </div>
          <Slider
            value={[Math.min(newBot.leverage, MARKET_MAX_LEVERAGE[newBot.market] || 20)]}
            onValueChange={(v) => setNewBot({ ...newBot, leverage: v[0] })}
            min={1}
            max={MARKET_MAX_LEVERAGE[newBot.market] || 20}
            step={1}
            data-testid="slider-leverage"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>1x (Safe)</span>
            <span>{MARKET_MAX_LEVERAGE[newBot.market] || 20}x (Max for {newBot.market.replace('-PERP', '')})</span>
          </div>
          {(MARKET_MAX_LEVERAGE[newBot.market] || 20) < 10 && (
            <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
              <Info className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-muted-foreground">
                {newBot.market.replace('-PERP', '')} has a max leverage of {MARKET_MAX_LEVERAGE[newBot.market]}x on Drift. 
                Trades exceeding this will fail with "insufficient margin".
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="investment-amount">Investment Amount (USDC)</Label>
          <div className="flex gap-2">
            <Input
              id="investment-amount"
              type="number"
              placeholder="100"
              value={newBot.investmentAmount}
              onChange={(e) => setNewBot({ ...newBot, investmentAmount: e.target.value })}
              className="font-mono flex-1"
              data-testid="input-investment-amount"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => agentBalance && setNewBot({ ...newBot, investmentAmount: agentBalance })}
              disabled={!agentBalance || parseFloat(agentBalance) <= 0}
              className="px-3"
              data-testid="button-max-investment"
            >
              Max
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {isLoadingBalance ? (
              'Loading balance...'
            ) : agentBalance && parseFloat(agentBalance) > 0 ? (
              <>Available in agent wallet: <span className="font-medium">${parseFloat(agentBalance).toFixed(2)}</span></>
            ) : (
              <span className="text-yellow-600">No USDC in agent wallet. Fund it from Wallet Management first.</span>
            )}
          </p>
        </div>

        {investmentValue > 0 && (
          <div className="p-3 rounded-lg bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20">
            <div className="flex items-center gap-2 text-sm">
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="text-muted-foreground">Max Position Size:</span>
              <span className="font-bold text-lg text-primary">
                ${maxPositionSize.toFixed(2)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              ${investmentValue.toFixed(2)} investment × {newBot.leverage}x leverage
            </p>
          </div>
        )}

        <Collapsible open={infoOpen} onOpenChange={setInfoOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between text-muted-foreground hover:text-foreground">
              <span className="flex items-center gap-2">
                <Info className="w-4 h-4" />
                How TradingView signals work
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${infoOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {(() => {
              // Use actual max position size if user entered values, otherwise show $500 example
              const exampleMax = maxPositionSize > 0 ? maxPositionSize : 500;
              const isCustom = maxPositionSize > 0;
              
              return (
                <div className="mt-2 p-3 rounded-lg bg-muted/50 text-sm space-y-3">
                  <div>
                    <p className="font-medium mb-1">Signal to Trade Mapping</p>
                    <p className="text-muted-foreground text-xs">
                      TradingView sends a dollar value in its signals. This value is treated as a <span className="font-medium text-foreground">percentage of your Max Position Size</span>.
                    </p>
                  </div>
                  <div className="bg-background/50 p-2 rounded border">
                    <p className="text-xs font-medium mb-1">
                      {isCustom ? (
                        <>With your <span className="text-primary">${exampleMax.toFixed(2)}</span> Max Position:</>
                      ) : (
                        <>Example with $500 Max Position:</>
                      )}
                    </p>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      <li>• Signal sends $33 → Opens <span className="font-medium text-foreground">33%</span> = <span className={isCustom ? "text-primary font-medium" : ""}>${(exampleMax * 0.33).toFixed(2)}</span> position</li>
                      <li>• Signal sends $50 → Opens <span className="font-medium text-foreground">50%</span> = <span className={isCustom ? "text-primary font-medium" : ""}>${(exampleMax * 0.50).toFixed(2)}</span> position</li>
                      <li>• Signal sends $100 → Opens <span className="font-medium text-foreground">100%</span> = <span className={isCustom ? "text-primary font-medium" : ""}>${exampleMax.toFixed(2)}</span> position</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium mb-1">Pyramiding Strategy</p>
                    <p className="text-muted-foreground text-xs">
                      With 3 pyramid orders, set Initial Capital: 100 and Order Size: 33.33 in TradingView. Each signal will add ~33% (${(exampleMax * 0.3333).toFixed(2)}) until fully positioned.
                    </p>
                  </div>
                </div>
              );
            })()}
          </CollapsibleContent>
        </Collapsible>

        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs">
              <p className="font-medium text-yellow-500">Subaccount Rent</p>
              <p className="text-muted-foreground">
                Creating a bot allocates a Drift subaccount which requires ~0.035 SOL rent from your agent wallet's gas balance. This rent is reclaimable when you delete the bot.
              </p>
            </div>
          </div>
        </div>

      </div>

      <DialogFooter>
        <Button variant="outline" onClick={handleClose} disabled={isCreating || isDepositingSol}>
          Cancel
        </Button>
        {solRequirement && !solRequirement.canCreate ? (
          <Button 
            onClick={handleSolDeposit} 
            disabled={isDepositingSol}
            className="bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600"
            data-testid="button-deposit-sol-for-bot"
          >
            {isDepositingSol ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Depositing...
              </>
            ) : (
              <>
                <Fuel className="w-4 h-4 mr-2" />
                Deposit {(solRequirement.deficit + 0.01).toFixed(3)} SOL
              </>
            )}
          </Button>
        ) : (
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
        )}
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
          <DialogDescription className="flex items-center gap-2">
            <span className="font-medium">{createdBot.name}</span>
            <button
              onClick={() => copyToClipboard(createdBot.name, 'Bot Name')}
              className="p-1 rounded hover:bg-muted/50 transition-colors"
              title="Copy bot name for TradingView alert"
              data-testid="button-copy-bot-name"
            >
              {copiedField === 'Bot Name' ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>
            <span className="text-muted-foreground">•</span>
            <span>{createdBot.market}</span>
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
              onClick={async () => {
                // Always refetch to get latest status (user may have enabled in welcome popup)
                const status = await refetchStatus();
                if (status && !status.executionEnabled) {
                  setStep('enable_execution');
                } else {
                  handleClose();
                }
              }}
              data-testid="button-done-setup"
            >
              Done
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderEnableExecutionStep = () => {
    if (!createdBot) return null;

    const handleEnableNow = async () => {
      const success = await enableExecution();
      if (success) {
        handleClose();
      }
    };

    const handleSkip = () => {
      handleClose();
    };

    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Shield className="w-6 h-6 text-primary" />
            Enable Automated Trading
          </DialogTitle>
          <DialogDescription>
            Your bot <span className="font-medium">{createdBot.name}</span> has been created successfully
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div className="p-4 rounded-xl bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-amber-500">Automated Trading Not Enabled</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Your bot is configured, but it cannot execute trades until you enable automated trading authorization. 
                  This requires signing a message with your wallet.
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-muted/50 border">
            <h4 className="font-medium mb-2">What happens when you enable?</h4>
            <ul className="text-sm text-muted-foreground space-y-1.5">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                <span>Your bots can automatically execute trades from TradingView signals</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                <span>You maintain full control and can revoke anytime</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                <span>No funds are transferred - just authorization to trade</span>
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter className="flex gap-3 sm:gap-3">
          <Button
            variant="outline"
            onClick={handleSkip}
            disabled={executionLoading}
            data-testid="button-skip-enable"
          >
            Skip for now
          </Button>
          <Button
            onClick={handleEnableNow}
            disabled={executionLoading}
            className="bg-gradient-to-r from-primary to-accent"
            data-testid="button-enable-execution"
          >
            {executionLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Enabling...
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4 mr-2" />
                Enable Now
              </>
            )}
          </Button>
        </DialogFooter>
      </>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className={`max-h-[85vh] overflow-y-auto ${step === 'success' ? "sm:max-w-[600px]" : "sm:max-w-[450px]"}`}>
        {step === 'create' && renderCreateStep()}
        {step === 'success' && renderSuccessStep()}
        {step === 'enable_execution' && renderEnableExecutionStep()}
      </DialogContent>
    </Dialog>
  );
}
