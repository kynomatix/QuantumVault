import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'wouter';
import { useWallet } from '@/hooks/useWallet';
import { useTokenBalance } from '@/hooks/useTokenBalance';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowLeft,
  Wallet,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  Gift,
  Sparkles
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

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

export default function WalletManagement() {
  const [, navigate] = useLocation();
  const { connected, connecting, shortenedAddress, publicKeyString } = useWallet();
  const { usdcBalance, usdcLoading, fetchUsdcBalance } = useTokenBalance();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  useEffect(() => {
    if (!connecting && !connected) {
      navigate('/');
    }
  }, [connected, connecting, navigate]);

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

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool()]);
    toast({ title: 'Balances refreshed' });
  };

  const copyAddress = async () => {
    if (publicKeyString) {
      await navigator.clipboard.writeText(publicKeyString);
      setCopiedAddress(true);
      toast({ title: 'Address copied to clipboard' });
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    if (usdcBalance !== null && amount > usdcBalance) {
      toast({ title: 'Insufficient USDC balance', variant: 'destructive' });
      return;
    }

    setIsDepositing(true);
    try {
      const response = await fetch('/api/drift/deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          walletAddress: solanaWallet.publicKey.toString(),
          amount 
        }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Deposit Successful!', 
        description: message || `Deposited ${amount} USDC to your agent account`
      });
      
      setDepositAmount('');
      await Promise.all([fetchUsdcBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Deposit error:', error);
      toast({ 
        title: 'Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositing(false);
    }
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    if (capitalPool && amount > capitalPool.mainAccountBalance) {
      toast({ title: 'Insufficient main account balance', variant: 'destructive' });
      return;
    }

    setIsWithdrawing(true);
    try {
      const response = await fetch('/api/drift/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          walletAddress: solanaWallet.publicKey.toString(),
          amount 
        }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Withdrawal Successful!', 
        description: message || `Withdrew ${amount} USDC to your wallet`
      });
      
      setWithdrawAmount('');
      await Promise.all([fetchUsdcBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Withdraw error:', error);
      toast({ 
        title: 'Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsWithdrawing(false);
    }
  };

  const setMaxDeposit = () => {
    if (usdcBalance !== null) {
      setDepositAmount(usdcBalance.toString());
    }
  };

  const setMaxWithdraw = () => {
    if (capitalPool) {
      setWithdrawAmount(capitalPool.mainAccountBalance.toString());
    }
  };

  if (!connected) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-accent/10 rounded-full blur-[120px]" />
      </div>

      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate('/app')}
              data-testid="button-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <Wallet className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="font-display font-bold text-xl">Wallet Management</h1>
                <p className="text-sm text-muted-foreground">Manage your funds for your trading agent</p>
              </div>
            </div>
          </div>
          
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleRefresh}
            disabled={usdcLoading || capitalLoading}
            data-testid="button-refresh"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${(usdcLoading || capitalLoading) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="space-y-6"
        >
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="w-5 h-5 text-primary" />
                Connected Wallet
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between p-4 bg-muted/30 rounded-xl">
                <div>
                  <p className="text-sm text-muted-foreground">Address</p>
                  <p className="font-mono text-lg" data-testid="text-wallet-address">{shortenedAddress}</p>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon"
                  onClick={copyAddress}
                  data-testid="button-copy-address"
                >
                  {copiedAddress ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
            >
              <Card className="border-border/50 bg-card/50 backdrop-blur-sm h-full">
                <CardHeader className="pb-2">
                  <CardDescription>Wallet USDC Balance</CardDescription>
                  <CardTitle className="text-2xl font-mono" data-testid="text-wallet-usdc">
                    {usdcLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      `$${(usdcBalance ?? 0).toFixed(2)}`
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Available in your Phantom wallet</p>
                </CardContent>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
            >
              <Card className="border-border/50 bg-card/50 backdrop-blur-sm h-full">
                <CardHeader className="pb-2">
                  <CardDescription>Agent Account Balance</CardDescription>
                  <CardTitle className="text-2xl font-mono" data-testid="text-drift-balance">
                    {capitalLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      `$${(capitalPool?.mainAccountBalance ?? 0).toFixed(2)}`
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Your agent deposits to Drift Protocol for trading</p>
                </CardContent>
              </Card>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardContent className="pt-6">
                <Tabs defaultValue="deposit" className="w-full">
                  <TabsList className="grid w-full grid-cols-2 mb-6">
                    <TabsTrigger value="deposit" className="flex items-center gap-2" data-testid="tab-deposit">
                      <ArrowDownToLine className="w-4 h-4" />
                      Deposit
                    </TabsTrigger>
                    <TabsTrigger value="withdraw" className="flex items-center gap-2" data-testid="tab-withdraw">
                      <ArrowUpFromLine className="w-4 h-4" />
                      Withdraw
                    </TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="deposit" className="space-y-4">
                    <div className="p-4 bg-muted/30 rounded-xl space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-sm font-medium">Amount (USDC)</label>
                          <span className="text-xs text-muted-foreground">
                            Available: ${(usdcBalance ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            className="flex-1"
                            data-testid="input-deposit-amount"
                          />
                          <Button 
                            variant="outline" 
                            onClick={setMaxDeposit}
                            data-testid="button-deposit-max"
                          >
                            Max
                          </Button>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>From: Wallet</span>
                        <span>To: Agent Account</span>
                      </div>
                      
                      <Button
                        className="w-full bg-gradient-to-r from-primary to-accent"
                        onClick={handleDeposit}
                        disabled={isDepositing || !depositAmount || parseFloat(depositAmount) <= 0}
                        data-testid="button-deposit"
                      >
                        {isDepositing ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>
                            <ArrowDownToLine className="w-4 h-4 mr-2" />
                            Deposit to Agent
                          </>
                        )}
                      </Button>
                    </div>
                  </TabsContent>
                  
                  <TabsContent value="withdraw" className="space-y-4">
                    <div className="p-4 bg-muted/30 rounded-xl space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-sm font-medium">Amount (USDC)</label>
                          <span className="text-xs text-muted-foreground">
                            Available: ${(capitalPool?.mainAccountBalance ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                            className="flex-1"
                            data-testid="input-withdraw-amount"
                          />
                          <Button 
                            variant="outline" 
                            onClick={setMaxWithdraw}
                            data-testid="button-withdraw-max"
                          >
                            Max
                          </Button>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>From: Agent Account</span>
                        <span>To: Wallet</span>
                      </div>
                      
                      <Button
                        className="w-full bg-gradient-to-r from-primary to-accent"
                        onClick={handleWithdraw}
                        disabled={isWithdrawing || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
                        data-testid="button-withdraw"
                      >
                        {isWithdrawing ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>
                            <ArrowUpFromLine className="w-4 h-4 mr-2" />
                            Withdraw to Wallet
                          </>
                        )}
                      </Button>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <Card className="border-border/50 bg-card/50 backdrop-blur-sm border-dashed">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-muted-foreground">
                  <Gift className="w-5 h-5" />
                  Airdrops
                </CardTitle>
                <CardDescription>Claim rewards and airdrops</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                    <Sparkles className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <p className="text-lg font-medium text-muted-foreground">Coming Soon</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Airdrop claims and rewards will be available here
                  </p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </motion.div>
      </main>
    </div>
  );
}
