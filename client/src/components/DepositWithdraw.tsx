import { useState, useEffect } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, AlertCircle, Wallet, Bot, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/hooks/use-toast';
import { useTradingBots } from '@/hooks/useApi';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TradingBot {
  id: string;
  name: string;
  market: string;
  driftSubaccountId: number | null;
}

interface CapitalPool {
  mainAccountBalance: number;
  allocatedToBot: number;
  totalEquity: number;
  botAllocations: Array<{
    botId: string;
    botName: string;
    subaccountId: number;
    balance: number;
  }>;
  warning?: string;
}

export function DepositWithdraw() {
  const { connected, publicKeyString } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const { data: bots, isLoading: botsLoading, refetch: refetchBots } = useTradingBots();
  
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [botBalance, setBotBalance] = useState<number>(0);
  const [hasFetchedBalance, setHasFetchedBalance] = useState(false);
  const [botBalanceLoading, setBotBalanceLoading] = useState(false);
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [subaccountExists, setSubaccountExists] = useState(false);
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  const tradingBots = (bots as TradingBot[]) || [];
  const selectedBot = tradingBots.find(b => b.id === selectedBotId);

  useEffect(() => {
    if (tradingBots.length > 0 && !selectedBotId) {
      setSelectedBotId(tradingBots[0].id);
    }
  }, [tradingBots, selectedBotId]);

  const fetchCapitalPool = async () => {
    if (!publicKeyString) return;
    
    setCapitalLoading(true);
    try {
      const res = await fetch('/api/wallet/capital', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch capital pool');
      const data = await res.json();
      setCapitalPool(data);
    } catch (error) {
      console.error('Error fetching capital pool:', error);
    } finally {
      setCapitalLoading(false);
    }
  };

  useEffect(() => {
    if (connected && publicKeyString) {
      fetchCapitalPool();
    }
  }, [connected, publicKeyString]);

  const fetchBotBalance = async () => {
    if (!selectedBotId || !publicKeyString) return;
    
    setBotBalanceLoading(true);
    try {
      const res = await fetch(`/api/bot/${selectedBotId}/balance`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch balance');
      const data = await res.json();
      setBotBalance(data.usdcBalance ?? 0);
      setSubaccountExists(data.subaccountExists ?? false);
      setHasFetchedBalance(true);
    } catch (error) {
      console.error('Error fetching bot balance:', error);
    } finally {
      setBotBalanceLoading(false);
    }
  };

  useEffect(() => {
    if (selectedBotId && publicKeyString) {
      setHasFetchedBalance(false);
      setBotBalance(0);
      fetchBotBalance();
    }
  }, [selectedBotId, publicKeyString]);

  const handleRefresh = () => {
    refetchBots();
    fetchBotBalance();
    fetchCapitalPool();
  };

  const handleAction = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!selectedBotId) {
      toast({ title: 'Select a bot first', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    setIsProcessing(true);
    try {
      const endpoint = mode === 'deposit' 
        ? `/api/bot/${selectedBotId}/deposit` 
        : `/api/bot/${selectedBotId}/withdraw`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-wallet-address': solanaWallet.publicKey.toString(),
        },
        body: JSON.stringify({ amount: parseFloat(amount) }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Transaction failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      
      if (!solanaWallet.signTransaction) {
        throw new Error('Wallet does not support signing');
      }
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: `${mode === 'deposit' ? 'Allocation' : 'Deallocation'} Successful!`, 
        description: message 
      });
      
      setAmount('');
      await Promise.all([fetchBotBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error(`${mode} error:`, error);
      toast({ 
        title: `${mode === 'deposit' ? 'Allocation' : 'Deallocation'} Failed`, 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const hasNoBots = !botsLoading && tradingBots.length === 0;
  const selectedBotHasSubaccount = selectedBot && selectedBot.driftSubaccountId !== null;

  return (
    <div className="gradient-border p-6 noise space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold">Capital Pool</h3>
        <button 
          onClick={handleRefresh}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-refresh-balance"
        >
          Refresh
        </button>
      </div>

      {connected && (
        <>
          <div className="bg-gradient-to-r from-primary/10 to-primary/5 rounded-xl p-4 border border-primary/20">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium text-muted-foreground">Total Equity</span>
            </div>
            {capitalLoading && !capitalPool ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Loading...</span>
              </div>
            ) : (
              <p className="text-3xl font-mono font-bold text-primary" data-testid="text-total-equity">
                ${(capitalPool?.totalEquity ?? 0).toFixed(2)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-muted-foreground">Main Account</span>
              </div>
              <p className="text-lg font-mono font-semibold" data-testid="text-main-balance">
                ${(capitalPool?.mainAccountBalance ?? 0).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Available to allocate</p>
            </div>
            <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="w-4 h-4 text-green-400" />
                <span className="text-xs text-muted-foreground">Allocated to Bots</span>
              </div>
              <p className="text-lg font-mono font-semibold" data-testid="text-allocated-balance">
                ${(capitalPool?.allocatedToBot ?? 0).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{capitalPool?.botAllocations?.length ?? 0} active bots</p>
            </div>
          </div>

          {capitalPool?.warning && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-500">{capitalPool.warning}</p>
              </div>
            </div>
          )}

          <div className="border-t border-border/50 pt-4">
            <h4 className="text-sm font-medium mb-3">Allocate Funds to Bot</h4>
            
            {hasNoBots ? (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-yellow-500">No Trading Bots</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Create a trading bot first to allocate funds for automated trading.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">Select Bot</label>
                  <Select value={selectedBotId} onValueChange={setSelectedBotId}>
                    <SelectTrigger className="w-full" data-testid="select-bot">
                      <SelectValue placeholder="Select a bot" />
                    </SelectTrigger>
                    <SelectContent>
                      {tradingBots.map((bot) => (
                        <SelectItem key={bot.id} value={bot.id}>
                          {bot.name} ({bot.market})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {!selectedBotHasSubaccount ? (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mt-3">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-yellow-500">Legacy Bot</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          This bot was created before the subaccount system. Create a new bot to use isolated trading accounts.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="bg-primary/5 rounded-xl p-4 border border-primary/30 mt-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm text-muted-foreground">Subaccount #{selectedBot?.driftSubaccountId}</p>
                        {!subaccountExists && hasFetchedBalance && (
                          <span className="text-xs text-yellow-500">Not initialized</span>
                        )}
                      </div>
                      {!hasFetchedBalance && botBalanceLoading ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                          <span className="text-muted-foreground">Loading...</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <p className="text-2xl font-mono font-bold text-primary" data-testid="text-bot-balance">
                            ${botBalance.toFixed(2)}
                          </p>
                          <span className="text-sm text-muted-foreground">USDC</span>
                          {botBalanceLoading && (
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex rounded-xl bg-muted/30 p-1 mt-3">
                      <button
                        onClick={() => setMode('deposit')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all ${
                          mode === 'deposit'
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        data-testid="button-mode-deposit"
                      >
                        <ArrowDownToLine className="w-4 h-4" />
                        Allocate
                      </button>
                      <button
                        onClick={() => setMode('withdraw')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all ${
                          mode === 'withdraw'
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        data-testid="button-mode-withdraw"
                      >
                        <ArrowUpFromLine className="w-4 h-4" />
                        Deallocate
                      </button>
                    </div>

                    <div className="space-y-3 mt-3">
                      <div>
                        <label className="text-sm text-muted-foreground mb-1 block">
                          Amount (USDC)
                        </label>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            className="font-mono flex-1"
                            data-testid="input-amount"
                          />
                          {mode === 'deposit' && (capitalPool?.mainAccountBalance ?? 0) > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAmount((capitalPool?.mainAccountBalance ?? 0).toString())}
                              className="px-3"
                              data-testid="button-max-deposit"
                            >
                              Max
                            </Button>
                          )}
                          {mode === 'withdraw' && botBalance > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAmount(botBalance.toString())}
                              className="px-3"
                              data-testid="button-max-withdraw"
                            >
                              Max
                            </Button>
                          )}
                        </div>
                        {mode === 'deposit' && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Available in Main Account: ${(capitalPool?.mainAccountBalance ?? 0).toFixed(2)} USDC
                          </p>
                        )}
                        {mode === 'withdraw' && botBalance > 0 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Available in Bot: ${botBalance.toFixed(2)} USDC
                          </p>
                        )}
                      </div>

                      <Button
                        className="w-full"
                        onClick={handleAction}
                        disabled={!amount || !selectedBotId || isProcessing}
                        data-testid={`button-${mode}`}
                      >
                        {isProcessing ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Processing...
                          </>
                        ) : mode === 'deposit' ? (
                          <>
                            <ArrowDownToLine className="w-4 h-4 mr-2" />
                            Allocate to Bot
                          </>
                        ) : (
                          <>
                            <ArrowUpFromLine className="w-4 h-4 mr-2" />
                            Return to Main Account
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="text-xs text-muted-foreground text-center mt-3 space-y-1">
                      <p>{selectedBot?.name ? `Managing: ${selectedBot.name} (Subaccount #${selectedBot.driftSubaccountId})` : 'Select a bot to manage funds'}</p>
                      <p className="opacity-70">
                        {mode === 'deposit' 
                          ? 'Main Account → Bot Subaccount' 
                          : 'Bot Subaccount → Main Account'}
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {!connected && (
        <div className="text-center py-8 text-muted-foreground">
          Connect your wallet to manage capital
        </div>
      )}
    </div>
  );
}
