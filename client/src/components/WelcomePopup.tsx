import { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { motion } from 'framer-motion';
import { Loader2, Copy, Check, Fuel, Wallet, CheckCircle2, User, Zap, Shield, DollarSign } from 'lucide-react';
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
import { useTokenBalance } from '@/hooks/useTokenBalance';
import { useExecutionAuthorization } from '@/hooks/useExecutionAuthorization';

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
  const { usdcBalance, usdcLoading, fetchUsdcBalance } = useTokenBalance();
  const { executionEnabled, executionLoading, enableExecution, refetchStatus } = useExecutionAuthorization();

  const [displayName, setDisplayName] = useState('');
  const [solDepositAmount, setSolDepositAmount] = useState('0.1');
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositSuccess, setDepositSuccess] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [userSolBalance, setUserSolBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [processingStep, setProcessingStep] = useState<'idle' | 'preparing' | 'signing' | 'confirming' | 'finalizing'>('idle');
  
  // Step 2: USDC deposit, Step 3: Execution authorization
  const [currentStep, setCurrentStep] = useState<'sol' | 'usdc' | 'execution' | 'complete'>('sol');
  const [usdcDepositAmount, setUsdcDepositAmount] = useState('');
  const [isDepositingUsdc, setIsDepositingUsdc] = useState(false);
  const [usdcProcessingStep, setUsdcProcessingStep] = useState<'idle' | 'preparing' | 'signing' | 'confirming' | 'finalizing'>('idle');
  const [usdcFunded, setUsdcFunded] = useState(false);

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

  // Fetch balances when popup opens or wallet changes
  useEffect(() => {
    if (isOpen && wallet.publicKey) {
      fetchUserSolBalance();
      fetchUsdcBalance();
    }
  }, [isOpen, wallet.publicKey]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !isDepositing && !isDepositingUsdc && !executionLoading) {
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
    setProcessingStep('preparing');
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
      
      setProcessingStep('signing');
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await wallet.signTransaction(transaction);
      
      setProcessingStep('confirming');
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      setProcessingStep('finalizing');
      
      // Record SOL deposit in transaction history
      try {
        await fetch('/api/agent/confirm-sol-deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, txSignature: signature }),
          credentials: 'include',
        });
      } catch (err) {
        console.error('Failed to record SOL deposit:', err);
      }
      
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
      
      toast({ 
        title: 'SOL Deposit Complete!', 
        description: message || `Deposited ${amount} SOL for transaction fees`
      });
      
      // Mark basic setup as complete (agent wallet funded for gas)
      // This ensures popup won't reopen if user closes without completing USDC
      onDepositComplete();
      
      // Move to USDC deposit step
      setCurrentStep('usdc');
      await fetchUsdcBalance();
    } catch (error: any) {
      console.error('SOL deposit error:', error);
      toast({ 
        title: 'SOL Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositing(false);
      setProcessingStep('idle');
    }
  };

  const setMaxDeposit = () => {
    if (userSolBalance !== null && userSolBalance > 0.01) {
      setSolDepositAmount((userSolBalance - 0.01).toFixed(4));
    }
  };

  const setMaxUsdcDeposit = () => {
    if (usdcBalance !== null) {
      setUsdcDepositAmount(usdcBalance.toString());
    }
  };

  const handleUsdcDeposit = async () => {
    const amount = parseFloat(usdcDepositAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    if (usdcBalance !== null && amount > usdcBalance) {
      toast({ title: 'Insufficient USDC balance', variant: 'destructive' });
      return;
    }

    setIsDepositingUsdc(true);
    setUsdcProcessingStep('preparing');
    try {
      const response = await fetch('/api/agent/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'USDC deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      setUsdcProcessingStep('signing');
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await wallet.signTransaction(transaction);
      
      setUsdcProcessingStep('confirming');
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      setUsdcProcessingStep('finalizing');
      
      // Confirm deposit on backend
      await fetch('/api/agent/confirm-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });
      
      toast({ 
        title: 'USDC Deposit Complete!', 
        description: message || `Deposited ${amount} USDC to your trading account`
      });
      
      setUsdcFunded(true);
      const status = await refetchStatus();
      if (!status?.executionEnabled) {
        setCurrentStep('execution');
      } else {
        setCurrentStep('complete');
        setDepositSuccess(true);
      }
    } catch (error: any) {
      console.error('USDC deposit error:', error);
      toast({ 
        title: 'USDC Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositingUsdc(false);
      setUsdcProcessingStep('idle');
    }
  };

  const handleSkipUsdc = async () => {
    const status = await refetchStatus();
    if (!status?.executionEnabled) {
      setCurrentStep('execution');
    } else {
      setCurrentStep('complete');
      setDepositSuccess(true);
      onDepositComplete();
    }
  };

  const handleEnableExecution = async () => {
    const success = await enableExecution();
    if (success) {
      setCurrentStep('complete');
      setDepositSuccess(true);
      onDepositComplete();
    }
  };

  const handleSkipExecution = () => {
    setCurrentStep('complete');
    setDepositSuccess(true);
    onDepositComplete();
  };

  const getUsdcStepStatus = (stepId: string) => {
    const stepOrder = ['preparing', 'signing', 'confirming', 'finalizing'];
    const currentIndex = stepOrder.indexOf(usdcProcessingStep);
    const stepIndex = stepOrder.indexOf(stepId);
    if (stepIndex < currentIndex) return 'complete';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  const processingSteps = [
    { id: 'preparing', label: 'Preparing transaction', icon: Shield },
    { id: 'signing', label: 'Sign with your wallet', icon: Wallet },
    { id: 'confirming', label: 'Confirming on Solana', icon: Zap },
    { id: 'finalizing', label: 'Finalizing setup', icon: CheckCircle2 },
  ];

  const getStepStatus = (stepId: string) => {
    const stepOrder = ['preparing', 'signing', 'confirming', 'finalizing'];
    const currentIndex = stepOrder.indexOf(processingStep);
    const stepIndex = stepOrder.indexOf(stepId);
    if (stepIndex < currentIndex) return 'complete';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  if (isDepositing) {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-welcome-processing">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-primary" />
              Setting Up Your Account
            </DialogTitle>
            <DialogDescription>
              Please wait while we set up your trading agent...
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 space-y-4">
            {processingSteps.map((step, index) => {
              const status = getStepStatus(step.id);
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${
                    status === 'active' 
                      ? 'bg-primary/10 border border-primary/30' 
                      : status === 'complete'
                        ? 'bg-green-500/10 border border-green-500/30'
                        : 'bg-muted/30'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    status === 'active'
                      ? 'bg-primary/20'
                      : status === 'complete'
                        ? 'bg-green-500/20'
                        : 'bg-muted/50'
                  }`}>
                    {status === 'active' ? (
                      <Loader2 className="w-5 h-5 text-primary animate-spin" />
                    ) : status === 'complete' ? (
                      <Check className="w-5 h-5 text-green-500" />
                    ) : (
                      <Icon className={`w-5 h-5 ${status === 'pending' ? 'text-muted-foreground' : 'text-primary'}`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${
                      status === 'active' 
                        ? 'text-primary' 
                        : status === 'complete'
                          ? 'text-green-500'
                          : 'text-muted-foreground'
                    }`}>
                      {step.label}
                    </p>
                  </div>
                  {status === 'active' && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-1"
                    >
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>

          <div className="text-center text-xs text-muted-foreground">
            <p>This may take up to 30 seconds. Please don't close this window.</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // USDC Deposit Processing Screen
  if (isDepositingUsdc) {
    const usdcProcessingSteps = [
      { id: 'preparing', label: 'Preparing USDC transfer', icon: Shield },
      { id: 'signing', label: 'Sign with your wallet', icon: Wallet },
      { id: 'confirming', label: 'Confirming on Solana', icon: Zap },
      { id: 'finalizing', label: 'Finalizing deposit', icon: CheckCircle2 },
    ];
    
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-usdc-processing">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-primary" />
              Depositing USDC
            </DialogTitle>
            <DialogDescription>
              Please wait while we transfer USDC to your trading account...
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 space-y-4">
            {usdcProcessingSteps.map((step, index) => {
              const status = getUsdcStepStatus(step.id);
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${
                    status === 'active' 
                      ? 'bg-primary/10 border border-primary/30' 
                      : status === 'complete'
                        ? 'bg-green-500/10 border border-green-500/30'
                        : 'bg-muted/30'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    status === 'active'
                      ? 'bg-primary/20'
                      : status === 'complete'
                        ? 'bg-green-500/20'
                        : 'bg-muted/50'
                  }`}>
                    {status === 'active' ? (
                      <Loader2 className="w-5 h-5 text-primary animate-spin" />
                    ) : status === 'complete' ? (
                      <Check className="w-5 h-5 text-green-500" />
                    ) : (
                      <Icon className={`w-5 h-5 ${status === 'pending' ? 'text-muted-foreground' : 'text-primary'}`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${
                      status === 'active' 
                        ? 'text-primary' 
                        : status === 'complete'
                          ? 'text-green-500'
                          : 'text-muted-foreground'
                    }`}>
                      {step.label}
                    </p>
                  </div>
                  {status === 'active' && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-1"
                    >
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>

          <div className="text-center text-xs text-muted-foreground">
            <p>This may take up to 30 seconds. Please don't close this window.</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // USDC Deposit Form Screen (Step 2)
  if (currentStep === 'usdc') {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-usdc-deposit">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-primary" />
              Fund Your Trading Account
            </DialogTitle>
            <DialogDescription>
              Deposit USDC to start trading. Your SOL deposit for transaction fees is complete.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Card className="border-green-500/30 bg-green-500/10">
              <CardContent className="pt-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center">
                    <Check className="w-4 h-4 text-green-500" />
                  </div>
                  <div className="text-sm">
                    <p className="font-medium text-green-500">SOL Deposit Complete</p>
                    <p className="text-muted-foreground text-xs">Transaction fees are ready</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <DollarSign className="w-5 h-5 text-primary mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-primary mb-1">Deposit USDC for Trading</p>
                    <p className="text-muted-foreground">
                      USDC is used as collateral for your perpetual futures trading. Deposit funds to start trading.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Deposit USDC</label>
                <span className="text-xs text-muted-foreground">
                  Available: {usdcLoading ? '...' : `${(usdcBalance ?? 0).toFixed(2)} USDC`}
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="100"
                  value={usdcDepositAmount}
                  onChange={(e) => setUsdcDepositAmount(e.target.value)}
                  className="flex-1"
                  data-testid="input-usdc-amount"
                />
                <Button 
                  variant="outline" 
                  onClick={setMaxUsdcDeposit}
                  disabled={!usdcBalance || usdcBalance <= 0}
                  data-testid="button-max-usdc"
                >
                  Max
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum recommended: 10 USDC for testing strategies
              </p>
            </div>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              onClick={handleUsdcDeposit}
              disabled={isDepositingUsdc || !usdcDepositAmount || parseFloat(usdcDepositAmount) <= 0}
              className="w-full bg-gradient-to-r from-primary to-accent"
              data-testid="button-deposit-usdc"
            >
              <DollarSign className="w-4 h-4 mr-2" />
              Deposit USDC
            </Button>
            <Button
              variant="ghost"
              onClick={handleSkipUsdc}
              disabled={isDepositingUsdc}
              className="w-full"
              data-testid="button-skip-usdc"
            >
              Skip for now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (currentStep === 'execution') {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-execution-auth">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Enable Automated Trading
            </DialogTitle>
            <DialogDescription>
              One final step: authorize your trading agent to execute trades on your behalf.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Card className="border-green-500/30 bg-green-500/10">
              <CardContent className="pt-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center">
                    <Check className="w-4 h-4 text-green-500" />
                  </div>
                  <div className="text-sm">
                    <p className="font-medium text-green-500">Deposits Complete</p>
                    <p className="text-muted-foreground text-xs">
                      {usdcFunded ? 'SOL and USDC funded' : 'SOL funded for transaction fees'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-primary mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-primary mb-1">Why Enable Execution?</p>
                    <p className="text-muted-foreground">
                      Enabling execution authorization allows your trading bots to automatically execute trades based on webhook signals. This requires signing a message with your wallet.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              onClick={handleEnableExecution}
              disabled={executionLoading}
              className="w-full bg-gradient-to-r from-primary to-accent"
              data-testid="button-enable-execution"
            >
              {executionLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enabling...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  Enable Automated Trading
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={handleSkipExecution}
              disabled={executionLoading}
              className="w-full"
              data-testid="button-skip-execution"
            >
              Skip for now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

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
              {usdcFunded 
                ? 'Your trading account is fully funded and ready to go.'
                : 'Your agent wallet is funded for transaction fees.'
              }
            </DialogDescription>
          </DialogHeader>
          
          <div className="p-6 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 200, damping: 15 }}
              className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4"
            >
              <CheckCircle2 className="w-8 h-8 text-green-500" />
            </motion.div>
            <p className="text-muted-foreground">
              {usdcFunded 
                ? 'Your trading agent is ready to execute trades on the Solana blockchain.'
                : 'You can deposit USDC anytime from the Wallet tab to start trading.'
              }
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
