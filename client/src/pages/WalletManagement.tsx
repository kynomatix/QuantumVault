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
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { Fuel } from 'lucide-react';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { EquityHistory } from '@/components/EquityHistory';

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
  solBalance: number;
}

interface WalletContentProps {
  initialTab?: 'deposit' | 'withdraw' | 'gas';
}

export function WalletContent({ initialTab = 'deposit' }: WalletContentProps) {
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

  const [solDepositAmount, setSolDepositAmount] = useState('');
  const [isDepositingSol, setIsDepositingSol] = useState(false);
  const [userSolBalance, setUserSolBalance] = useState<number | null>(null);
  const [solLoading, setSolLoading] = useState(false);
  
  const [solWithdrawAmount, setSolWithdrawAmount] = useState('');
  const [solWithdrawing, setSolWithdrawing] = useState(false);

  const fetchUserSolBalance = async () => {
    if (!solanaWallet.publicKey) return;
    setSolLoading(true);
    try {
      const balance = await connection.getBalance(solanaWallet.publicKey);
      setUserSolBalance(balance / LAMPORTS_PER_SOL);
    } catch (error) {
      console.error('Error fetching SOL balance:', error);
    } finally {
      setSolLoading(false);
    }
  };

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
      fetchUserSolBalance();
    }
  }, [connected, publicKeyString]);

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool(), fetchAgentBalance(), fetchUserSolBalance()]);
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
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming deposit...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      await fetch('/api/agent/confirm-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ 
        title: 'Deposit Confirmed!', 
        description: message || `Deposited ${amount} USDC to Agent Wallet`
      });
      
      setDepositAmount('');
      
      await new Promise(resolve => setTimeout(resolve, 2000));
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
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming withdrawal...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      await fetch('/api/agent/confirm-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ 
        title: 'Withdrawal Confirmed!', 
        description: message || `Withdrew ${amount} USDC to your wallet`
      });
      
      setWithdrawAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
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

  const setMaxSolDeposit = () => {
    if (userSolBalance !== null && userSolBalance > 0.01) {
      setSolDepositAmount((userSolBalance - 0.01).toFixed(4));
    }
  };

  const setMaxSolWithdraw = () => {
    if (agentWallet?.solBalance !== undefined && agentWallet.solBalance > 0.005) {
      setSolWithdrawAmount((agentWallet.solBalance - 0.005).toFixed(4));
    }
  };

  const handleSolWithdraw = async () => {
    const amount = parseFloat(solWithdrawAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (agentWallet && amount > (agentWallet.solBalance - 0.005)) {
      toast({ title: 'Insufficient SOL (keep 0.005 SOL for gas)', variant: 'destructive' });
      return;
    }

    setSolWithdrawing(true);
    try {
      const response = await fetch('/api/agent/withdraw-sol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'SOL withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await response.json();
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming SOL withdrawal...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      await fetch('/api/agent/confirm-sol-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ 
        title: 'SOL Withdrawal Confirmed!', 
        description: message || `Withdrew ${amount} SOL to your wallet`
      });
      
      setSolWithdrawAmount('');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await Promise.all([fetchUserSolBalance(), fetchAgentBalance()]);
    } catch (error: any) {
      console.error('SOL withdraw error:', error);
      toast({ 
        title: 'SOL Withdrawal Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setSolWithdrawing(false);
    }
  };

  const handleSolDeposit = async () => {
    const amount = parseFloat(solDepositAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.publicKey) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }

    if (!solanaWallet.signTransaction) {
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

    setIsDepositingSol(true);
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
      const signedTx = await solanaWallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming SOL deposit...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      await fetch('/api/agent/confirm-sol-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ 
        title: 'SOL Deposit Confirmed!', 
        description: message || `Deposited ${amount} SOL to Agent Wallet for gas fees`
      });
      
      setSolDepositAmount('');
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      await Promise.all([fetchUserSolBalance(), fetchAgentBalance()]);
    } catch (error: any) {
      console.error('SOL deposit error:', error);
      toast({ 
        title: 'SOL Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsDepositingSol(false);
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
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming Drift deposit...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Deposit Confirmed!', 
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
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming Drift withdrawal...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Drift Withdrawal Confirmed!', 
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
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming withdrawal...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      await fetch('/api/agent/confirm-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, txSignature: signature }),
        credentials: 'include',
      });

      toast({ 
        title: 'Withdrawal Confirmed!', 
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

  const isLoading = usdcLoading || capitalLoading || agentLoading || solLoading;

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
          <p className="text-muted-foreground">Manage your trading funds</p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRefresh}
          disabled={isLoading}
          data-testid="button-refresh"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card className="border-border/50 bg-gradient-to-br from-card/80 to-card/40 backdrop-blur-sm overflow-hidden">
        <CardContent className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border/50">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-muted/50">
                  <Wallet className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Your Wallet</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm" data-testid="text-wallet-address">{shortenedAddress}</p>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      className="h-6 w-6"
                      onClick={copyAddress}
                      data-testid="button-copy-address"
                    >
                      {copiedAddress ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 rounded-lg bg-muted/30">
                  <p className="text-xs text-muted-foreground mb-1">USDC</p>
                  <p className="text-xl font-mono font-semibold" data-testid="text-wallet-usdc">
                    {usdcLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : `$${(usdcBalance ?? 0).toFixed(2)}`}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <p className="text-xs text-muted-foreground mb-1">SOL</p>
                  <p className="text-xl font-mono font-semibold" data-testid="text-user-sol-balance">
                    {solLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : `${(userSolBalance ?? 0).toFixed(4)}`}
                  </p>
                </div>
              </div>
            </div>
            
            <div className="p-6 bg-primary/5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/20">
                    <Bot className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary">Trading Agent</p>
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-sm" data-testid="text-agent-wallet-address">
                        {agentWallet?.agentPublicKey ? shortenAddress(agentWallet.agentPublicKey) : '...'}
                      </p>
                      <Button 
                        variant="ghost" 
                        size="icon"
                        className="h-6 w-6"
                        onClick={copyAgentAddress}
                        disabled={!agentWallet?.agentPublicKey}
                        data-testid="button-copy-agent-address"
                      >
                        {copiedAgentAddress ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => window.open(`https://app.drift.trade/portfolio/accounts?authority=${agentWallet?.agentPublicKey}`, '_blank')}
                        disabled={!agentWallet?.agentPublicKey}
                        title="View on Drift"
                        data-testid="button-view-on-drift"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <p className="text-xs text-primary/70 mb-1">USDC Balance</p>
                  <p className="text-xl font-mono font-semibold text-primary" data-testid="text-agent-balance">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : `$${(agentWallet?.balance ?? 0).toFixed(2)}`}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
                  <p className="text-xs text-orange-500/70 mb-1 flex items-center gap-1">
                    <Fuel className="w-3 h-3" /> Gas (SOL)
                  </p>
                  <p className="text-xl font-mono font-semibold text-orange-500" data-testid="text-agent-sol-balance">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : `${(agentWallet?.solBalance ?? 0).toFixed(4)}`}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="pt-6">
          <Tabs defaultValue={initialTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-6">
              <TabsTrigger value="deposit" className="flex items-center gap-2" data-testid="tab-deposit">
                <ArrowDownToLine className="w-4 h-4" />
                <span className="hidden sm:inline">Deposit</span>
              </TabsTrigger>
              <TabsTrigger value="withdraw" className="flex items-center gap-2" data-testid="tab-withdraw">
                <ArrowUpFromLine className="w-4 h-4" />
                <span className="hidden sm:inline">Withdraw</span>
              </TabsTrigger>
              <TabsTrigger value="gas" className="flex items-center gap-2" data-testid="tab-gas">
                <Fuel className="w-4 h-4" />
                <span className="hidden sm:inline">Gas (SOL)</span>
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="deposit" className="space-y-4">
              <div className="p-5 bg-muted/30 rounded-xl space-y-5">
                <div className="flex items-center justify-center gap-4 py-2">
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                    <Wallet className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Your Wallet</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
                    <Bot className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-primary">Trading Agent</span>
                  </div>
                </div>

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
                      className="flex-1 text-lg"
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

                <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-3 flex items-start gap-2">
                  <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>You'll need SOL in your wallet for the transaction fee (~0.005 SOL)</span>
                </div>
                
                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent h-12 text-base"
                  onClick={handleDepositToAgent}
                  disabled={isDepositing || !depositAmount || parseFloat(depositAmount) <= 0}
                  data-testid="button-deposit"
                >
                  {isDepositing ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ArrowDownToLine className="w-5 h-5 mr-2" />
                      Deposit USDC
                    </>
                  )}
                </Button>
              </div>
            </TabsContent>
            
            <TabsContent value="withdraw" className="space-y-4">
              <div className="p-5 bg-muted/30 rounded-xl space-y-5">
                <div className="flex items-center justify-center gap-4 py-2">
                  <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
                    <Bot className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-primary">Trading Agent</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                    <Wallet className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Your Wallet</span>
                  </div>
                </div>

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
                      className="flex-1 text-lg"
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
                
                <Button
                  className="w-full bg-gradient-to-r from-primary to-accent h-12 text-base"
                  onClick={handleWithdrawToWallet}
                  disabled={isWithdrawingToWallet || !withdrawToWalletAmount || parseFloat(withdrawToWalletAmount) <= 0}
                  data-testid="button-withdraw-wallet"
                >
                  {isWithdrawingToWallet ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ArrowUpFromLine className="w-5 h-5 mr-2" />
                      Withdraw USDC
                    </>
                  )}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="gas" className="space-y-4">
              <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl space-y-3">
                <div className="flex items-center gap-2 text-orange-500">
                  <Fuel className="w-5 h-5" />
                  <h3 className="font-semibold">About Gas Fees</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  SOL is required to pay transaction fees on Solana. Your trading agent needs SOL to execute trades, deposits, and withdrawals.
                </p>
                <p className="text-sm font-medium text-orange-500/90">
                  Recommended: Keep at least 0.1 SOL for smooth operations
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-muted/30 rounded-xl">
                  <p className="text-xs text-muted-foreground mb-2">Your Wallet SOL</p>
                  <p className="font-mono text-xl font-semibold" data-testid="text-gas-user-sol">
                    {solLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : `${(userSolBalance ?? 0).toFixed(4)}`}
                  </p>
                </div>
                <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl">
                  <p className="text-xs text-orange-500/70 mb-2">Agent Gas Balance</p>
                  <p className="font-mono text-xl font-semibold text-orange-500" data-testid="text-gas-agent-sol">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : `${(agentWallet?.solBalance ?? 0).toFixed(4)}`}
                  </p>
                </div>
              </div>

              <div className="p-5 bg-muted/30 rounded-xl space-y-5">
                <div className="flex items-center justify-center gap-4 py-2">
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                    <Wallet className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Your SOL</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <Fuel className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-medium text-orange-500">Agent Gas</span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Deposit Amount (SOL)</label>
                    <span className="text-xs text-muted-foreground">
                      Available: {(userSolBalance ?? 0).toFixed(4)} SOL
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      step="0.001"
                      value={solDepositAmount}
                      onChange={(e) => setSolDepositAmount(e.target.value)}
                      className="flex-1 text-lg"
                      data-testid="input-sol-deposit-amount"
                    />
                    <Button 
                      variant="outline" 
                      onClick={setMaxSolDeposit}
                      data-testid="button-sol-deposit-max"
                    >
                      Max
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Keeps 0.01 SOL in your wallet for transaction fees
                  </p>
                </div>
                
                <Button
                  className="w-full bg-gradient-to-r from-orange-500 to-orange-600 h-12 text-base"
                  onClick={handleSolDeposit}
                  disabled={isDepositingSol || !solDepositAmount || parseFloat(solDepositAmount) <= 0}
                  data-testid="button-sol-deposit"
                >
                  {isDepositingSol ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Fuel className="w-5 h-5 mr-2" />
                      Fund Agent Gas
                    </>
                  )}
                </Button>
              </div>

              <div className="p-5 bg-muted/30 rounded-xl space-y-5">
                <div className="flex items-center justify-center gap-4 py-2">
                  <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                    <Fuel className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-medium text-orange-500">Agent Gas</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                    <Wallet className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Your Wallet</span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Withdraw Amount (SOL)</label>
                    <span className="text-xs text-muted-foreground">
                      Available: {Math.max(0, (agentWallet?.solBalance ?? 0) - 0.005).toFixed(4)} SOL
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      step="0.001"
                      value={solWithdrawAmount}
                      onChange={(e) => setSolWithdrawAmount(e.target.value)}
                      className="flex-1 text-lg"
                      data-testid="input-sol-withdraw-amount"
                    />
                    <Button 
                      variant="outline" 
                      onClick={setMaxSolWithdraw}
                      data-testid="button-sol-withdraw-max"
                    >
                      Max
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Keep at least 0.005 SOL for agent transaction fees
                  </p>
                </div>
                
                <Button
                  variant="outline"
                  className="w-full border-orange-500/50 text-orange-500 hover:bg-orange-500/10 h-12 text-base"
                  onClick={handleSolWithdraw}
                  disabled={solWithdrawing || !solWithdrawAmount || parseFloat(solWithdrawAmount) <= 0}
                  data-testid="button-sol-withdraw"
                >
                  {solWithdrawing ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ArrowUpFromLine className="w-5 h-5 mr-2" />
                      Withdraw SOL
                    </>
                  )}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <EquityHistory walletAddress={publicKeyString ?? undefined} />
    </motion.div>
  );
}
