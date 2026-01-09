import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Wallet, Bot, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/hooks/useWallet';

interface CapitalPool {
  mainAccountBalance: number;
  allocatedToBot: number;
  totalEquity: number;
}

export function DepositWithdraw() {
  const [, navigate] = useLocation();
  const { connected, publicKeyString } = useWallet();
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

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

  return (
    <div className="gradient-border p-4 noise space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold">Capital Pool</h3>
        <button 
          onClick={fetchCapitalPool}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-refresh-balance"
        >
          Refresh
        </button>
      </div>

      {connected ? (
        <>
          <div className="bg-gradient-to-r from-primary/10 to-primary/5 rounded-lg p-3 border border-primary/20">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">Total Equity</span>
            </div>
            {capitalLoading && !capitalPool ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            ) : (
              <p className="text-2xl font-mono font-bold text-primary" data-testid="text-total-equity">
                ${(capitalPool?.totalEquity ?? 0).toFixed(2)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-muted/30 rounded-lg p-2.5 border border-border/50">
              <div className="flex items-center gap-1.5 mb-1">
                <Wallet className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs text-muted-foreground">Main Account</span>
              </div>
              <p className="text-base font-mono font-semibold" data-testid="text-main-balance">
                ${(capitalPool?.mainAccountBalance ?? 0).toFixed(2)}
              </p>
            </div>
            <div className="bg-muted/30 rounded-lg p-2.5 border border-border/50">
              <div className="flex items-center gap-1.5 mb-1">
                <Bot className="w-3.5 h-3.5 text-green-400" />
                <span className="text-xs text-muted-foreground">Allocated to Bots</span>
              </div>
              <p className="text-base font-mono font-semibold" data-testid="text-allocated-balance">
                ${(capitalPool?.allocatedToBot ?? 0).toFixed(2)}
              </p>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => navigate('/wallet')}
              data-testid="button-deposit"
            >
              <ArrowDownToLine className="w-4 h-4 mr-2" />
              Deposit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => navigate('/wallet')}
              data-testid="button-withdraw"
            >
              <ArrowUpFromLine className="w-4 h-4 mr-2" />
              Withdraw
            </Button>
          </div>
        </>
      ) : (
        <div className="text-center py-6 text-muted-foreground text-sm">
          Connect your wallet to manage capital
        </div>
      )}
    </div>
  );
}
