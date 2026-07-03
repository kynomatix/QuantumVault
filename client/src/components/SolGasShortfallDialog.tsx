import { useState } from 'react';
import { Buffer } from 'buffer';
import { Transaction } from '@solana/web3.js';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Fuel, Loader2, Wallet } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { safeResponseJson } from '@/lib/safe-fetch';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';

// Headroom over the bare shortfall so tx fees / rent are comfortably covered.
const SOL_GAS_BUFFER = 0.003;

export interface SolGasShortfallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** SOL the agent wallet currently holds. null = unknown (treated as 0). */
  heldSol?: number | null;
  /** SOL required for the action. */
  requiredSol: number;
  /** Friendly context, e.g. "to lock your collateral". */
  reason?: string;
  /** Runs after a confirmed deposit — refresh balances and/or retry the action. */
  onDeposited?: () => void | Promise<void>;
  /**
   * 'gas' (default): small fee top-up framing. 'deposit': the deposit IS the
   * main event (e.g. funding a loop principal from the user's wallet) — same
   * exact-amount plumbing, friendlier title/copy.
   */
  variant?: 'gas' | 'deposit';
  /** Overrides the default title for the chosen variant. */
  title?: string;
  /** Overrides the default description for the chosen variant. */
  description?: string;
}

// A small, reusable "you're a little short on SOL — top up just what you need"
// popup. Deposits the shortfall (plus a little headroom) straight from the
// connected wallet into the agent wallet, instead of bouncing the user to the
// wallet page. The SOL stays in the agent wallet for future network fees.
export function SolGasShortfallDialog({
  open,
  onOpenChange,
  heldSol,
  requiredSol,
  reason,
  onDeposited,
  variant = 'gas',
  title,
  description,
}: SolGasShortfallDialogProps) {
  const { toast } = useToast();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const [depositing, setDepositing] = useState(false);

  const held = heldSol ?? 0;
  const shortfall = Math.max(0, requiredSol - held);
  // Round up to milli-SOL so the wallet shows a clean number.
  const depositAmount = Math.ceil((shortfall + SOL_GAS_BUFFER) * 1000) / 1000;

  const handleDeposit = async () => {
    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }
    setDepositing(true);
    try {
      const res = await fetch('/api/agent/deposit-sol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: depositAmount }),
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await safeResponseJson(res);
        throw new Error(err.error || 'Could not build the SOL deposit');
      }
      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await safeResponseJson(res);
      const tx = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signed = await solanaWallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await confirmTransactionWithFallback(connection, { signature: sig, blockhash, lastValidBlockHeight });
      toast({
        title:
          variant === 'deposit'
            ? `Deposited ${depositAmount.toFixed(3)} SOL`
            : `Added ${depositAmount.toFixed(3)} SOL for gas`,
      });
      onOpenChange(false);
      await onDeposited?.();
    } catch (e: any) {
      toast({ title: 'Could not add SOL', description: e?.message || 'Please try again', variant: 'destructive' });
    } finally {
      setDepositing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !depositing && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm" data-testid="dialog-sol-gas-shortfall">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {variant === 'deposit' ? (
              <Wallet className="w-5 h-5 text-primary" />
            ) : (
              <Fuel className="w-5 h-5 text-orange-500" />
            )}{' '}
            {title || (variant === 'deposit' ? 'Deposit SOL from your wallet' : 'Add a little SOL for gas')}
          </DialogTitle>
          <DialogDescription>
            {description ||
              (variant === 'deposit'
                ? `This deposit comes straight from your connected wallet ${reason || 'to fund this action'}.`
                : `Solana charges a tiny network fee ${reason || 'for this action'}. Your agent wallet is a bit short, so top it up with just what's needed — it stays in your agent wallet for future fees.`)}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{variant === 'deposit' ? 'Already held' : 'You have'}</span>
            <span data-testid="text-gas-held">{held.toFixed(4)} SOL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{variant === 'deposit' ? 'Total needed' : 'Needed'}</span>
            <span data-testid="text-gas-required">{requiredSol.toFixed(4)} SOL</span>
          </div>
          <div className="flex justify-between font-medium border-t border-border/60 pt-1.5">
            <span>Deposit now</span>
            <span data-testid="text-gas-deposit">{depositAmount.toFixed(3)} SOL</span>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={depositing}
            data-testid="button-gas-cancel"
          >
            Cancel
          </Button>
          <Button onClick={handleDeposit} disabled={depositing} data-testid="button-gas-deposit">
            {depositing ? (
              <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> {variant === 'deposit' ? 'Depositing…' : 'Adding…'}</>
            ) : (
              <>
                {variant === 'deposit' ? <Wallet className="w-4 h-4 mr-1" /> : <Fuel className="w-4 h-4 mr-1" />}
                Deposit {depositAmount.toFixed(3)} SOL
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
