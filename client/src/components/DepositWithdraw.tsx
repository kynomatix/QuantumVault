import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/hooks/use-toast';

export function DepositWithdraw() {
  const { balance } = useWallet();
  const { toast } = useToast();
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');

  const handleAction = () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    toast({ 
      title: `${mode === 'deposit' ? 'Deposit' : 'Withdraw'} coming soon`, 
      description: 'Drift Protocol integration in progress' 
    });
  };

  return (
    <div className="gradient-border p-6 noise space-y-4">
      <h3 className="text-lg font-display font-semibold">Wallet & Deposits</h3>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
          <p className="text-sm text-muted-foreground">SOL Balance</p>
          <p className="text-2xl font-mono font-bold" data-testid="text-sol-balance">
            {balance?.toFixed(4) ?? '0'} SOL
          </p>
        </div>
        <div className="bg-muted/30 rounded-xl p-4 border border-border/30">
          <p className="text-sm text-muted-foreground">USDC Balance</p>
          <p className="text-2xl font-mono font-bold" data-testid="text-usdc-balance">
            0.00 USDC
          </p>
        </div>
      </div>

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
          disabled={!amount}
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
        Full Drift Protocol deposit/withdraw integration coming soon.
      </div>
    </div>
  );
}
