import { useState, useEffect } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, AlertCircle } from 'lucide-react';
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
  agentPublicKey: string | null;
}

export function DepositWithdraw() {
  const { balance, connected, publicKeyString } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const { data: bots, isLoading: botsLoading, refetch: refetchBots } = useTradingBots();
  
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [botBalance, setBotBalance] = useState<number | null>(null);
  const [botBalanceLoading, setBotBalanceLoading] = useState(false);
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [initializingWallet, setInitializingWallet] = useState(false);

  const tradingBots = (bots as TradingBot[]) || [];
  const selectedBot = tradingBots.find(b => b.id === selectedBotId);

  useEffect(() => {
    if (tradingBots.length > 0 && !selectedBotId) {
      setSelectedBotId(tradingBots[0].id);
    }
  }, [tradingBots, selectedBotId]);

  const fetchBotBalance = async () => {
    if (!selectedBotId || !publicKeyString) return;
    
    setBotBalanceLoading(true);
    try {
      const res = await fetch(`/api/bot/${selectedBotId}/balance`, {
        headers: { 'x-wallet-address': publicKeyString },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch balance');
      const data = await res.json();
      setBotBalance(data.usdcBalance);
    } catch (error) {
      console.error('Error fetching bot balance:', error);
      setBotBalance(null);
    } finally {
      setBotBalanceLoading(false);
    }
  };

  useEffect(() => {
    if (selectedBotId && publicKeyString) {
      fetchBotBalance();
    }
  }, [selectedBotId, publicKeyString]);

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
      
      let signature: string;
      
      if (mode === 'deposit') {
        if (!solanaWallet.signTransaction) {
          throw new Error('Wallet does not support signing');
        }
        const signedTx = await solanaWallet.signTransaction(transaction);
        signature = await connection.sendRawTransaction(signedTx.serialize());
      } else {
        signature = await connection.sendRawTransaction(transaction.serialize());
      }
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: `${mode === 'deposit' ? 'Deposit' : 'Withdrawal'} Successful!`, 
        description: message 
      });
      
      setAmount('');
      await fetchBotBalance();
    } catch (error: any) {
      console.error(`${mode} error:`, error);
      toast({ 
        title: `${mode === 'deposit' ? 'Deposit' : 'Withdrawal'} Failed`, 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const hasNoBots = !botsLoading && tradingBots.length === 0;
  const selectedBotNeedsWallet = selectedBot && !selectedBot.agentPublicKey;

  const initializeAgentWallet = async () => {
    if (!selectedBotId || !publicKeyString) return;
    
    setInitializingWallet(true);
    try {
      const res = await fetch(`/api/trading-bots/${selectedBotId}/init-wallet`, {
        method: 'POST',
        headers: { 'x-wallet-address': publicKeyString },
        credentials: 'include',
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to initialize wallet');
      }
      
      toast({ 
        title: 'Agent Wallet Created!', 
        description: 'Your bot now has its own wallet for trading.' 
      });
      await refetchBots();
      await fetchBotBalance();
    } catch (error: any) {
      console.error('Init wallet error:', error);
      toast({ 
        title: 'Failed to initialize wallet', 
        description: error.message,
        variant: 'destructive' 
      });
    } finally {
      setInitializingWallet(false);
    }
  };

  return (
    <div className="gradient-border p-6 noise space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold">Bot Wallet</h3>
        <button 
          onClick={() => { refetchBots(); fetchBotBalance(); }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-refresh-balance"
        >
          Refresh
        </button>
      </div>

      {connected && hasNoBots && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-500">No Trading Bots</p>
              <p className="text-xs text-muted-foreground mt-1">
                Create a trading bot first to deposit funds for automated trading.
              </p>
            </div>
          </div>
        </div>
      )}

      {connected && tradingBots.length > 0 && (
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

          {selectedBotNeedsWallet ? (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-yellow-500">Bot Wallet Not Initialized</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    This bot needs a wallet to hold trading funds. Initialize it to start depositing.
                  </p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={initializeAgentWallet}
                    disabled={initializingWallet}
                    data-testid="button-init-wallet"
                  >
                    {initializingWallet ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Initializing...
                      </>
                    ) : (
                      'Initialize Bot Wallet'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
                <p className="text-sm text-muted-foreground">Wallet SOL</p>
                <p className="text-2xl font-mono font-bold" data-testid="text-sol-balance">
                  {balance?.toFixed(4) ?? '0'} SOL
                </p>
              </div>
              <div className="bg-primary/5 rounded-xl p-4 border border-primary/30">
                <p className="text-sm text-muted-foreground">Trading Capital</p>
                {botBalanceLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                ) : (
                  <p className="text-2xl font-mono font-bold text-primary" data-testid="text-bot-balance">
                    {botBalance?.toFixed(2) ?? '0.00'} USDC
                  </p>
                )}
              </div>
            </div>
          )}

          {!selectedBotNeedsWallet && (
            <>
              <div className="flex rounded-xl bg-muted/30 p-1">
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
                  Deposit
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
                  Withdraw
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">
                    Amount (USDC)
                  </label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="font-mono"
                    data-testid="input-amount"
                  />
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
                      Deposit to Bot
                    </>
                  ) : (
                    <>
                      <ArrowUpFromLine className="w-4 h-4 mr-2" />
                      Withdraw from Bot
                    </>
                  )}
                </Button>
              </div>

              <div className="text-xs text-muted-foreground text-center">
                {selectedBot?.name ? `Managing: ${selectedBot.name}` : 'Select a bot to manage funds'}
              </div>
            </>
          )}
        </>
      )}

      {!connected && (
        <div className="text-center py-8 text-muted-foreground">
          Connect your wallet to manage bot funds
        </div>
      )}
    </div>
  );
}
