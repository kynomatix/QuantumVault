import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, AlertCircle, Plus, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/hooks/useWallet';
import { useTokenBalance } from '@/hooks/useTokenBalance';
import { useToast } from '@/hooks/use-toast';

export function DepositWithdraw() {
  const { balance, connected } = useWallet();
  const { 
    usdcBalance, 
    usdcLoading, 
    tokenAccountExists, 
    creatingAccount, 
    createTokenAccount,
    fetchUsdcBalance 
  } = useTokenBalance();
  const { toast } = useToast();
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');

  const handleCreateTokenAccount = async () => {
    try {
      await createTokenAccount();
      toast({ 
        title: 'Token Account Created!', 
        description: 'Your USDC token account is ready for deposits.' 
      });
    } catch (error: any) {
      toast({ 
        title: 'Failed to create token account', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    }
  };

  const handleAction = () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    
    if (!tokenAccountExists) {
      toast({ 
        title: 'Create Token Account First', 
        description: 'You need a USDC token account before depositing',
        variant: 'destructive' 
      });
      return;
    }

    toast({ 
      title: `${mode === 'deposit' ? 'Deposit' : 'Withdraw'} coming soon`, 
      description: 'Drift Protocol integration in progress' 
    });
  };

  return (
    <div className="gradient-border p-6 noise space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold">Wallet & Deposits</h3>
        <button 
          onClick={fetchUsdcBalance}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-refresh-balance"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
          <p className="text-sm text-muted-foreground">SOL Balance</p>
          <p className="text-2xl font-mono font-bold" data-testid="text-sol-balance">
            {balance?.toFixed(4) ?? '0'} SOL
          </p>
        </div>
        <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
          <p className="text-sm text-muted-foreground">USDC Balance</p>
          {usdcLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          ) : (
            <p className="text-2xl font-mono font-bold" data-testid="text-usdc-balance">
              {usdcBalance?.toFixed(2) ?? '0.00'} USDC
            </p>
          )}
        </div>
      </div>

      {connected && tokenAccountExists === false && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-500">No USDC Token Account</p>
              <p className="text-xs text-muted-foreground mt-1">
                You need to create a USDC token account to receive testnet USDC. This is a one-time setup.
              </p>
              <Button
                size="sm"
                className="mt-3"
                onClick={handleCreateTokenAccount}
                disabled={creatingAccount}
                data-testid="button-create-token-account"
              >
                {creatingAccount ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Token Account
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {connected && tokenAccountExists && usdcBalance === 0 && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-400">Get Testnet USDC</p>
              <p className="text-xs text-muted-foreground mt-1">
                Your token account is ready! Get testnet USDC from the Drift faucet to start trading.
              </p>
              <a
                href="https://app.drift.trade/devnet"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2"
              >
                Open Drift Testnet <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>
      )}

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
          disabled={!amount || !tokenAccountExists}
          data-testid={`button-${mode}`}
        >
          {mode === 'deposit' ? (
            <>
              <ArrowDownToLine className="w-4 h-4 mr-2" />
              Deposit to Drift
            </>
          ) : (
            <>
              <ArrowUpFromLine className="w-4 h-4 mr-2" />
              Withdraw from Drift
            </>
          )}
        </Button>
      </div>

      <div className="text-xs text-muted-foreground text-center">
        Connected to Drift Protocol Testnet (Devnet)
      </div>
    </div>
  );
}
