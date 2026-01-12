import { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { Loader2, Copy, Check, Fuel, Wallet, CheckCircle2, User } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

interface WelcomePopupProps {
  isOpen: boolean;
  onClose: () => void;
  agentPublicKey: string;
  onDepositComplete: () => void;
}

export function WelcomePopup({ isOpen, onClose, agentPublicKey, onDepositComplete }: WelcomePopupProps) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState('');
  const [solDepositAmount, setSolDepositAmount] = useState('0.1');
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositSuccess, setDepositSuccess] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [userSolBalance, setUserSolBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const fetchUserSolBalance = async () => {
    if (!wallet.publicKey) return;
    setBalanceLoading(true);
    try {
      const balance = await connection.getBalance(wallet.publicKey);
      setUserSolBalance(balance / LAMPORTS_PER_SOL);
    } catch (error) {
      console.error('Error fetching SOL balance:', error);
    } finally {
      setBalanceLoading(false);
    }
  };

  // Fetch balance when popup opens or wallet changes
  useEffect(() => {
    if (isOpen && wallet.publicKey) {
      fetchUserSolBalance();
    }
  }, [isOpen, wallet.publicKey]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !isDepositing) {
      onClose();
    }
  };

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const copyAgentAddress = async () => {
    if (agentPublicKey) {
      await navigator.clipboard.writeText(agentPublicKey);
      setCopiedAddress(true);
      toast({ title: 'Agent wallet address copied' });
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  };

  const handleSolDeposit = async () => {
    const amount = parseFloat(solDepositAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!wallet.publicKey) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    if (!wallet.signTransaction) {
      toast({ 
        title: 'Wallet not supported', 
        description: 'Please use a wallet that supports signing transactions (e.g., Phantom, Solflare)',
        variant: 'destructive' 
      });
      return;
    }

    if (userSolBalance !== null && amount > userSolBalance - 0.01) {
      toast({ title: 'Insufficient SOL balance (keep 0.01 for fees)', variant: 'destructive' });
      return;
    }

    setIsDepositing(true);
    try {
      const response = await fetch('/api/agent/deposit-sol', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'SOL deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await wallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'SOL Deposit Successful!', 
        description: message || `Deposited ${amount} SOL to Agent Wallet for gas fees`
      });

      if (displayName.trim()) {
        try {
          await fetch('/api/wallet/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: displayName.trim() }),
            credentials: 'include',
          });
        } catch (err) {
          console.error('Failed to save display name:', err);
        }
      }
      
      setDepositSuccess(true);
      onDepositComplete();
    } catch (error: any) {
      console.error('SOL deposit error:', error);
      toast({ 
        title: 'SOL Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositing(false);
    }
  };

  const setMaxDeposit = () => {
    if (userSolBalance !== null && userSolBalance > 0.01) {
      setSolDepositAmount((userSolBalance - 0.01).toFixed(4));
    }
  };

  if (depositSuccess) {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-welcome-success">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-500">
              <CheckCircle2 className="w-6 h-6" />
              You're All Set!
            </DialogTitle>
            <DialogDescription>
              Your agent wallet is now funded with SOL for transaction fees.
            </DialogDescription>
          </DialogHeader>
          
          <div className="p-6 text-center">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
            </div>
            <p className="text-muted-foreground">
              Your trading agent is ready to execute trades on the Solana blockchain.
            </p>
          </div>

          <DialogFooter>
            <Button 
              onClick={onClose} 
              className="w-full bg-gradient-to-r from-primary to-accent"
              data-testid="button-get-started"
            >
              Get Started
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-welcome">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" />
            Welcome to QuantumVault
          </DialogTitle>
          <DialogDescription>
            To enable automated trading, your agent wallet needs SOL for transaction fees on Solana.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-primary" />
              <label className="text-sm font-medium">Display Name</label>
              <span className="text-xs text-muted-foreground">(optional)</span>
            </div>
            <Input
              type="text"
              placeholder="Enter your display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={32}
              data-testid="input-display-name"
            />
            <p className="text-xs text-muted-foreground">
              Your display name will appear on the leaderboard. You can change it later in settings.
            </p>
          </div>

          <Card className="border-orange-500/30 bg-orange-500/10">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <Fuel className="w-5 h-5 text-orange-500 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-orange-500 mb-1">Why SOL is Required</p>
                  <p className="text-muted-foreground">
                    SOL is used to pay transaction fees (gas) on Solana. Without it, your trading agent cannot execute trades, deposits, or withdrawals.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            <label className="text-sm font-medium">Agent Wallet Address</label>
            <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg">
              <code className="flex-1 text-sm font-mono" data-testid="text-agent-address">
                {shortenAddress(agentPublicKey)}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={copyAgentAddress}
                data-testid="button-copy-agent-address"
              >
                {copiedAddress ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              You can also send SOL to this address from any external wallet.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Deposit SOL</label>
              <span className="text-xs text-muted-foreground">
                Available: {balanceLoading ? '...' : `${(userSolBalance ?? 0).toFixed(4)} SOL`}
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.1"
                value={solDepositAmount}
                onChange={(e) => setSolDepositAmount(e.target.value)}
                className="flex-1"
                data-testid="input-sol-amount"
              />
              <Button 
                variant="outline" 
                onClick={setMaxDeposit}
                disabled={!userSolBalance || userSolBalance <= 0.01}
                data-testid="button-max-sol"
              >
                Max
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Recommended: 0.1 SOL (covers ~1000+ transactions)
            </p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            onClick={handleSolDeposit}
            disabled={isDepositing || !solDepositAmount || parseFloat(solDepositAmount) <= 0}
            className="w-full bg-gradient-to-r from-primary to-accent"
            data-testid="button-deposit-sol"
          >
            {isDepositing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Fuel className="w-4 h-4 mr-2" />
                Deposit SOL
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isDepositing}
            className="w-full"
            data-testid="button-later"
          >
            I'll do this later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
