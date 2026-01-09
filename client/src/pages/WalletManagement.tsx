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
  Bot,
  ArrowRight
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

interface AgentWallet {
  agentPublicKey: string;
  balance: number;
}

export function WalletContent() {
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
  
  const [agentToDriftAmount, setAgentToDriftAmount] = useState('');
  const [isAgentToDrift, setIsAgentToDrift] = useState(false);
  
  const [driftToAgentAmount, setDriftToAgentAmount] = useState('');
  const [isDriftToAgent, setIsDriftToAgent] = useState(false);
  
  const [withdrawToWalletAmount, setWithdrawToWalletAmount] = useState('');
  const [isWithdrawingToWallet, setIsWithdrawingToWallet] = useState(false);
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [copiedAgentAddress, setCopiedAgentAddress] = useState(false);

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

  const fetchAgentBalance = async () => {
    if (!publicKeyString) return;
    setAgentLoading(true);
    try {
      const res = await fetch('/api/agent/balance', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch agent balance');
      const data = await res.json();
      setAgentWallet(data);
    } catch (error) {
      console.error('Error fetching agent balance:', error);
    } finally {
      setAgentLoading(false);
    }
  };

  useEffect(() => {
    if (connected && publicKeyString) {
      fetchCapitalPool();
      fetchAgentBalance();
    }
  }, [connected, publicKeyString]);

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool(), fetchAgentBalance()]);
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

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const copyAgentAddress = async () => {
    if (agentWallet?.agentPublicKey) {
      await navigator.clipboard.writeText(agentWallet.agentPublicKey);
      setCopiedAgentAddress(true);
      toast({ title: 'Agent wallet address copied' });
      setTimeout(() => setCopiedAgentAddress(false), 2000);
    }
  };

  const handleDepositToAgent = async () => {
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
      const response = await fetch('/api/agent/deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
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
        description: message || `Deposited ${amount} USDC to Agent Wallet`
      });
      
      setDepositAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance()]);
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

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsWithdrawing(true);
    try {
      const response = await fetch('/api/agent/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
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
    if (agentWallet) {
      setWithdrawAmount(agentWallet.balance.toString());
    }
  };

  const setMaxAgentToDrift = () => {
    if (agentWallet?.balance) {
      setAgentToDriftAmount(agentWallet.balance.toString());
    }
  };

  const setMaxDriftToAgent = () => {
    if (capitalPool?.mainAccountBalance) {
      setDriftToAgentAmount(capitalPool.mainAccountBalance.toString());
    }
  };

  const setMaxWithdrawToWallet = () => {
    if (agentWallet?.balance) {
      setWithdrawToWalletAmount(agentWallet.balance.toString());
    }
  };

  const handleAgentToDrift = async () => {
    const amount = parseFloat(agentToDriftAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsAgentToDrift(true);
    try {
      const response = await fetch('/api/agent/drift-deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Drift deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Deposit Successful!', 
        description: message || `Deposited ${amount} USDC to Drift Protocol`
      });
      
      setAgentToDriftAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Agent to Drift error:', error);
      toast({ 
        title: 'Drift Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsAgentToDrift(false);
    }
  };

  const handleDriftToAgent = async () => {
    const amount = parseFloat(driftToAgentAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (capitalPool && amount > capitalPool.mainAccountBalance) {
      toast({ title: 'Insufficient Drift balance', variant: 'destructive' });
      return;
    }

    setIsDriftToAgent(true);
    try {
      const response = await fetch('/api/agent/drift-withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Drift withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Withdrawal Successful!', 
        description: message || `Withdrew ${amount} USDC from Drift to Agent Wallet`
      });
      
      setDriftToAgentAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Drift to Agent error:', error);
      toast({ 
        title: 'Drift Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDriftToAgent(false);
    }
  };

  const handleWithdrawToWallet = async () => {
    const amount = parseFloat(withdrawToWalletAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsWithdrawingToWallet(true);
    try {
      const response = await fetch('/api/agent/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Withdrawal Successful!', 
        description: message || `Withdrew ${amount} USDC to your wallet`
      });
      
      setWithdrawToWalletAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Withdraw to wallet error:', error);
      toast({ 
        title: 'Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsWithdrawingToWallet(false);
    }
  };

  if (!connected) {
    return null;
  }

  return (
    <motion.div
      key="wallet"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold">Wallet Management</h1>
          <p className="text-muted-foreground">Manage your funds for your trading agent</p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRefresh}
          disabled={usdcLoading || capitalLoading || agentLoading}
          data-testid="button-refresh"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${(usdcLoading || capitalLoading || agentLoading) ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

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

      <Card className="border-primary/30 bg-card/50 backdrop-blur-sm border-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            Agent Wallet (Trading Account)
          </CardTitle>
          <CardDescription>Server-managed wallet for automated trading operations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 bg-muted/30 rounded-xl">
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">Agent Address</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-lg" data-testid="text-agent-wallet-address">
                  {agentWallet?.agentPublicKey ? shortenAddress(agentWallet.agentPublicKey) : 'Loading...'}
                </p>
                <Button 
                  variant="ghost" 
                  size="icon"
                  onClick={copyAgentAddress}
                  disabled={!agentWallet?.agentPublicKey}
                  data-testid="button-copy-agent-address"
                >
                  {copiedAgentAddress ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Balance</p>
              <p className="font-mono text-lg font-semibold text-primary" data-testid="text-agent-wallet-balance">
                {agentLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin inline" />
                ) : (
                  `$${(agentWallet?.balance ?? 0).toFixed(2)} USDC`
                )}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm h-full">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="w-4 h-4" />
              Phantom Wallet
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="text-wallet-usdc">
              {usdcLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                `$${(usdcBalance ?? 0).toFixed(2)}`
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Your personal USDC balance</p>
          </CardContent>
        </Card>

        <Card className="border-primary/30 bg-card/50 backdrop-blur-sm h-full border-2">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              Agent Wallet
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="text-agent-balance">
              {agentLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                `$${(agentWallet?.balance ?? 0).toFixed(2)}`
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Server-managed trading wallet
              {agentWallet?.agentPublicKey && (
                <span className="block font-mono text-primary/70 mt-1">
                  {shortenAddress(agentWallet.agentPublicKey)}
                </span>
              )}
            </p>
          </CardContent>
        </Card>

      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="pt-6">
          <Tabs defaultValue="deposit" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="deposit" className="flex items-center gap-1 text-xs sm:text-sm" data-testid="tab-deposit">
                <ArrowDownToLine className="w-3 h-3 sm:w-4 sm:h-4" />
                Deposit
              </TabsTrigger>
              <TabsTrigger value="withdraw" className="flex items-center gap-1 text-xs sm:text-sm" data-testid="tab-withdraw">
                <ArrowUpFromLine className="w-3 h-3 sm:w-4 sm:h-4" />
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
                  <span>From: Phantom Wallet</span>
                  <ArrowRight className="w-4 h-4" />
                  <span>To: Agent Wallet</span>
                </div>
                
                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent"
                  onClick={handleDepositToAgent}
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
                      Available: ${(agentWallet?.balance ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={withdrawToWalletAmount}
                      onChange={(e) => setWithdrawToWalletAmount(e.target.value)}
                      className="flex-1"
                      data-testid="input-withdraw-wallet-amount"
                    />
                    <Button 
                      variant="outline" 
                      onClick={setMaxWithdrawToWallet}
                      data-testid="button-withdraw-wallet-max"
                    >
                      Max
                    </Button>
                  </div>
                </div>
                
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>From: Agent Wallet</span>
                  <ArrowRight className="w-4 h-4" />
                  <span>To: Phantom Wallet</span>
                </div>
                
                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent"
                  onClick={handleWithdrawToWallet}
                  disabled={isWithdrawingToWallet || !withdrawToWalletAmount || parseFloat(withdrawToWalletAmount) <= 0}
                  data-testid="button-withdraw-wallet"
                >
                  {isWithdrawingToWallet ? (
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
  );
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
  
  const [agentToDriftAmount, setAgentToDriftAmount] = useState('');
  const [isAgentToDrift, setIsAgentToDrift] = useState(false);
  
  const [driftToAgentAmount, setDriftToAgentAmount] = useState('');
  const [isDriftToAgent, setIsDriftToAgent] = useState(false);
  
  const [withdrawToWalletAmount, setWithdrawToWalletAmount] = useState('');
  const [isWithdrawingToWallet, setIsWithdrawingToWallet] = useState(false);
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [copiedAgentAddress, setCopiedAgentAddress] = useState(false);

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

  const fetchAgentBalance = async () => {
    if (!publicKeyString) return;
    setAgentLoading(true);
    try {
      const res = await fetch('/api/agent/balance', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch agent balance');
      const data = await res.json();
      setAgentWallet(data);
    } catch (error) {
      console.error('Error fetching agent balance:', error);
    } finally {
      setAgentLoading(false);
    }
  };

  useEffect(() => {
    if (connected && publicKeyString) {
      fetchCapitalPool();
      fetchAgentBalance();
    }
  }, [connected, publicKeyString]);

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool(), fetchAgentBalance()]);
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

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const copyAgentAddress = async () => {
    if (agentWallet?.agentPublicKey) {
      await navigator.clipboard.writeText(agentWallet.agentPublicKey);
      setCopiedAgentAddress(true);
      toast({ title: 'Agent wallet address copied' });
      setTimeout(() => setCopiedAgentAddress(false), 2000);
    }
  };

  const handleDepositToAgent = async () => {
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
      const response = await fetch('/api/agent/deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
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
        description: message || `Deposited ${amount} USDC to Agent Wallet`
      });
      
      setDepositAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance()]);
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

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsWithdrawing(true);
    try {
      const response = await fetch('/api/agent/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
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
    if (agentWallet) {
      setWithdrawAmount(agentWallet.balance.toString());
    }
  };

  const setMaxAgentToDrift = () => {
    if (agentWallet?.balance) {
      setAgentToDriftAmount(agentWallet.balance.toString());
    }
  };

  const setMaxDriftToAgent = () => {
    if (capitalPool?.mainAccountBalance) {
      setDriftToAgentAmount(capitalPool.mainAccountBalance.toString());
    }
  };

  const setMaxWithdrawToWallet = () => {
    if (agentWallet?.balance) {
      setWithdrawToWalletAmount(agentWallet.balance.toString());
    }
  };

  const handleAgentToDrift = async () => {
    const amount = parseFloat(agentToDriftAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsAgentToDrift(true);
    try {
      const response = await fetch('/api/agent/drift-deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Drift deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Deposit Successful!', 
        description: message || `Deposited ${amount} USDC to Drift Protocol`
      });
      
      setAgentToDriftAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Agent to Drift error:', error);
      toast({ 
        title: 'Drift Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsAgentToDrift(false);
    }
  };

  const handleDriftToAgent = async () => {
    const amount = parseFloat(driftToAgentAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (capitalPool && amount > capitalPool.mainAccountBalance) {
      toast({ title: 'Insufficient Drift balance', variant: 'destructive' });
      return;
    }

    setIsDriftToAgent(true);
    try {
      const response = await fetch('/api/agent/drift-withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Drift withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Withdrawal Successful!', 
        description: message || `Withdrew ${amount} USDC from Drift to Agent Wallet`
      });
      
      setDriftToAgentAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Drift to Agent error:', error);
      toast({ 
        title: 'Drift Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDriftToAgent(false);
    }
  };

  const handleWithdrawToWallet = async () => {
    const amount = parseFloat(withdrawToWalletAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return;
    }

    setIsWithdrawingToWallet(true);
    try {
      const response = await fetch('/api/agent/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Withdrawal Successful!', 
        description: message || `Withdrew ${amount} USDC to your wallet`
      });
      
      setWithdrawToWalletAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Withdraw to wallet error:', error);
      toast({ 
        title: 'Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsWithdrawingToWallet(false);
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
            disabled={usdcLoading || capitalLoading || agentLoading}
            data-testid="button-refresh"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${(usdcLoading || capitalLoading || agentLoading) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-5xl">
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

          <Card className="border-primary/30 bg-card/50 backdrop-blur-sm border-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="w-5 h-5 text-primary" />
                Agent Wallet (Trading Account)
              </CardTitle>
              <CardDescription>Server-managed wallet for automated trading operations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 bg-muted/30 rounded-xl">
                <div className="flex-1">
                  <p className="text-sm text-muted-foreground">Agent Address</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-lg" data-testid="text-agent-wallet-address">
                      {agentWallet?.agentPublicKey ? shortenAddress(agentWallet.agentPublicKey) : 'Loading...'}
                    </p>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={copyAgentAddress}
                      disabled={!agentWallet?.agentPublicKey}
                      data-testid="button-copy-agent-address"
                    >
                      {copiedAgentAddress ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Balance</p>
                  <p className="font-mono text-lg font-semibold text-primary" data-testid="text-agent-wallet-balance">
                    {agentLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin inline" />
                    ) : (
                      `$${(agentWallet?.balance ?? 0).toFixed(2)} USDC`
                    )}
                  </p>
                </div>
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
                  <CardDescription className="flex items-center gap-2">
                    <Wallet className="w-4 h-4" />
                    Phantom Wallet
                  </CardDescription>
                  <CardTitle className="text-2xl font-mono" data-testid="text-wallet-usdc">
                    {usdcLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      `$${(usdcBalance ?? 0).toFixed(2)}`
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Your personal USDC balance</p>
                </CardContent>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
            >
              <Card className="border-primary/30 bg-card/50 backdrop-blur-sm h-full border-2">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <Bot className="w-4 h-4 text-primary" />
                    Agent Wallet
                  </CardDescription>
                  <CardTitle className="text-2xl font-mono" data-testid="text-agent-balance">
                    {agentLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      `$${(agentWallet?.balance ?? 0).toFixed(2)}`
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    Server-managed trading wallet
                    {agentWallet?.agentPublicKey && (
                      <span className="block font-mono text-primary/70 mt-1">
                        {shortenAddress(agentWallet.agentPublicKey)}
                      </span>
                    )}
                  </p>
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
                    <TabsTrigger value="deposit" className="flex items-center gap-1 text-xs sm:text-sm" data-testid="tab-deposit">
                      <ArrowDownToLine className="w-3 h-3 sm:w-4 sm:h-4" />
                      Deposit
                    </TabsTrigger>
                    <TabsTrigger value="withdraw" className="flex items-center gap-1 text-xs sm:text-sm" data-testid="tab-withdraw">
                      <ArrowUpFromLine className="w-3 h-3 sm:w-4 sm:h-4" />
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
                        <span>From: Phantom Wallet</span>
                        <ArrowRight className="w-4 h-4" />
                        <span>To: Agent Wallet</span>
                      </div>
                      
                      <Button
                        className="w-full bg-gradient-to-r from-primary to-accent"
                        onClick={handleDepositToAgent}
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
                            Available: ${(agentWallet?.balance ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={withdrawToWalletAmount}
                            onChange={(e) => setWithdrawToWalletAmount(e.target.value)}
                            className="flex-1"
                            data-testid="input-withdraw-wallet-amount"
                          />
                          <Button 
                            variant="outline" 
                            onClick={setMaxWithdrawToWallet}
                            data-testid="button-withdraw-wallet-max"
                          >
                            Max
                          </Button>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>From: Agent Wallet</span>
                        <ArrowRight className="w-4 h-4" />
                        <span>To: Phantom Wallet</span>
                      </div>
                      
                      <Button
                        className="w-full bg-gradient-to-r from-primary to-accent"
                        onClick={handleWithdrawToWallet}
                        disabled={isWithdrawingToWallet || !withdrawToWalletAmount || parseFloat(withdrawToWalletAmount) <= 0}
                        data-testid="button-withdraw-wallet"
                      >
                        {isWithdrawingToWallet ? (
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
        </motion.div>
      </main>
    </div>
  );
}
