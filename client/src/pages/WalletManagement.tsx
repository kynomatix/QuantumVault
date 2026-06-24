import { safeResponseJson } from "@/lib/safe-fetch";
import { walletAuthHeaders } from "@/lib/queryClient";
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
  ExternalLink,
  TrendingUp,
  Landmark,
  HeartPulse,
  AlertTriangle,
  RotateCcw
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
import { DepositDialog } from '@/components/DepositDialog';
import { Coins } from 'lucide-react';

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

interface BorrowPosition {
  id: string;
  status: string;
  debtAmountRaw: string | null;
  collateralAmountRaw: string | null;
  collateralMint: string | null;
  liveHealth: { liquidatable?: boolean } | null;
  healthIsLive: boolean;
}

interface BorrowPositionsResponse {
  eligible: boolean;
  positions: BorrowPosition[];
}

interface WalletContentProps {
  initialTab?: 'deposit' | 'withdraw' | 'gas';
}

// Fetch the active interactive session id for money-moving actions (mirrors the
// Vault park/unpark pattern). Throws a user-facing message if there's no session.
async function getSessionId(): Promise<string> {
  const res = await fetch('/api/auth/session', { credentials: 'include' });
  if (!res.ok) throw new Error('Could not verify your session. Please reconnect your wallet.');
  const data = await safeResponseJson(res);
  if (!data.hasSession || !data.sessionId) {
    throw new Error('No active session. Please reconnect your wallet.');
  }
  return data.sessionId as string;
}

type KpiTone = 'primary' | 'accent' | 'neutral' | 'emerald';

// Headline figure in the Variant D KPI strip. Shows a spinner while its source
// is loading and an em dash (never a fake $0.00) when the value failed to load.
function Kpi({ icon: Icon, label, value, loading, tone, testId }: {
  icon: typeof Wallet;
  label: string;
  value: number | null;
  loading: boolean;
  tone: KpiTone;
  testId: string;
}) {
  const cardCls = {
    primary: 'border-primary/20 bg-primary/5',
    accent: 'border-accent/20 bg-accent/5',
    neutral: 'border-border bg-card',
    emerald: 'border-emerald-500/20 bg-emerald-500/5',
  }[tone];
  const iconCls = {
    primary: 'text-primary',
    accent: 'text-accent',
    neutral: 'text-muted-foreground',
    emerald: 'text-emerald-400',
  }[tone];
  const valueCls = {
    primary: 'text-primary',
    accent: 'text-accent',
    neutral: '',
    emerald: 'text-emerald-400',
  }[tone];
  return (
    <Card className={cardCls}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className={`w-3.5 h-3.5 ${iconCls}`} /> {label}
        </div>
        <div className={`text-2xl font-semibold tabular-nums mt-1.5 ${valueCls}`} data-testid={testId}>
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : value === null ? (
            '\u2014'
          ) : (
            `$${value.toFixed(2)}`
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function WalletContent({ initialTab = 'deposit' }: WalletContentProps) {
  const { connected, connecting, shortenedAddress, publicKeyString } = useWallet();
  const { usdcBalance, usdcLoading, fetchUsdcBalance } = useTokenBalance();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [depositDialogTab, setDepositDialogTab] = useState<'usdc' | 'token'>('usdc');
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  
  const [agentToExchangeAmount, setAgentToExchangeAmount] = useState('');
  const [isAgentToDrift, setIsAgentToDrift] = useState(false);
  
  const [exchangeToAgentAmount, setExchangeToAgentAmount] = useState('');
  const [isDriftToAgent, setIsDriftToAgent] = useState(false);
  
  const [withdrawToWalletAmount, setWithdrawToWalletAmount] = useState('');
  const [isWithdrawingToWallet, setIsWithdrawingToWallet] = useState(false);
  
  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [borrow, setBorrow] = useState<BorrowPositionsResponse | null>(null);
  const [closingLoanId, setClosingLoanId] = useState<string | null>(null);

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
      const data = await safeResponseJson(res);
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
      const data = await safeResponseJson(res);
      setAgentWallet(data);
    } catch (error) {
      console.error('Error fetching agent balance:', error);
    } finally {
      setAgentLoading(false);
    }
  };

  // Read any standing borrow positions. Borrow is an owner-gated MVP, so this is
  // empty for non-eligible wallets and (today) for everyone, since no position
  // exists yet. Loan surfaces render only when eligible AND a position is present.
  const fetchBorrowPositions = async () => {
    if (!publicKeyString) return;
    try {
      const res = await fetch('/api/vault/borrow/positions', {
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (!res.ok) return;
      const data = await safeResponseJson(res);
      setBorrow(data);
    } catch (error) {
      console.error('Error fetching borrow positions:', error);
    }
  };

  useEffect(() => {
    // Clear any prior loan data immediately on wallet switch/disconnect so a stale
    // (other-wallet) loan card can never flash if the refetch is slow or fails.
    setBorrow(null);
    if (connected && publicKeyString) {
      fetchCapitalPool();
      fetchAgentBalance();
      fetchUserSolBalance();
      fetchBorrowPositions();
    }
  }, [connected, publicKeyString]);

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool(), fetchAgentBalance(), fetchUserSolBalance(), fetchBorrowPositions()]);
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
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
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

  const setMaxWithdraw = () => {
    if (agentWallet) {
      setWithdrawAmount(agentWallet.balance.toString());
    }
  };

  const setMaxAgentToDrift = () => {
    if (agentWallet?.balance) {
      setAgentToExchangeAmount(agentWallet.balance.toString());
    }
  };

  const setMaxDriftToAgent = () => {
    if (capitalPool?.mainAccountBalance) {
      setExchangeToAgentAmount(capitalPool.mainAccountBalance.toString());
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
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'SOL withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
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
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'SOL deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
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
    const amount = parseFloat(agentToExchangeAmount);
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
      const response = await fetch('/api/exchange/deposit', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'Trading account deposit failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming trading account deposit...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Deposit Confirmed!', 
        description: message || `Deposited ${amount} USDC to Trading Account`
      });
      
      setAgentToExchangeAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Agent to trading account error:', error);
      toast({ 
        title: 'Deposit Failed', 
        description: error.message || 'Please try again',
        variant: 'destructive' 
      });
    } finally {
      setIsAgentToDrift(false);
    }
  };

  const handleDriftToAgent = async () => {
    const amount = parseFloat(exchangeToAgentAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }

    if (capitalPool && amount > capitalPool.mainAccountBalance) {
      toast({ title: 'Insufficient trading account balance', variant: 'destructive' });
      return;
    }

    setIsDriftToAgent(true);
    try {
      const response = await fetch('/api/exchange/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'Trading account withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
      const txBytes = Uint8Array.from(atob(serializedTx), c => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      
      toast({ 
        title: 'Transaction Submitted', 
        description: 'Confirming trading account withdrawal...'
      });
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      toast({ 
        title: 'Withdrawal Confirmed!', 
        description: message || `Withdrew ${amount} USDC from Trading Account to Agent Wallet`
      });
      
      setExchangeToAgentAmount('');
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Trading account to Agent error:', error);
      toast({ 
        title: 'Withdrawal Failed', 
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
        const error = await safeResponseJson(response);
        throw new Error(error.error || 'Withdrawal failed');
      }

      const { transaction: serializedTx, blockhash, lastValidBlockHeight, message } = await safeResponseJson(response);
      
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

  // Close an open loan in full: repay all debt and return collateral. This is a
  // destructive money action, so it requires an interactive session. Borrow is an
  // owner-gated MVP with full-close only (no partial repay yet).
  const handleCloseLoan = async (positionId: string) => {
    setClosingLoanId(positionId);
    try {
      const sessionId = await getSessionId();
      const response = await fetch('/api/vault/borrow/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({ borrowPositionId: positionId, sessionId }),
        credentials: 'include',
      });
      const data = await safeResponseJson(response);
      if (!response.ok) throw new Error(data.error || 'Failed to close loan');
      toast({ title: 'Loan closed', description: 'Your debt was repaid and your collateral returned.' });
      await Promise.all([fetchBorrowPositions(), fetchAgentBalance(), fetchUsdcBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Close loan error:', error);
      toast({ title: 'Could not close loan', description: error.message || 'Please try again', variant: 'destructive' });
    } finally {
      setClosingLoanId(null);
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

      {/* KPI strip — real headline figures only. No borrow / credit-limit numbers
          are shown because no endpoint exposes them honestly today. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={TrendingUp} label="Total Equity" tone="primary" loading={capitalLoading} value={capitalPool ? capitalPool.totalEquity : null} testId="text-kpi-total-equity" />
        <Kpi icon={Bot} label="Allocated to Bots" tone="accent" loading={capitalLoading} value={capitalPool ? capitalPool.allocatedToBot : null} testId="text-kpi-allocated" />
        <Kpi icon={Coins} label="In Trading Agent" tone="neutral" loading={agentLoading} value={agentWallet ? agentWallet.balance : null} testId="text-kpi-agent-usdc" />
        <Kpi icon={Wallet} label="In Your Wallet" tone="emerald" loading={usdcLoading} value={usdcBalance ?? null} testId="text-kpi-wallet-usdc" />
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
                    {usdcLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : usdcBalance == null ? '\u2014' : `$${usdcBalance.toFixed(2)}`}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <p className="text-xs text-muted-foreground mb-1">SOL</p>
                  <p className="text-xl font-mono font-semibold" data-testid="text-user-sol-balance">
                    {solLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : userSolBalance == null ? '\u2014' : `${userSolBalance.toFixed(4)}`}
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
                        onClick={() => window.open(`https://app.pacifica.fi/portfolio/${agentWallet?.agentPublicKey}`, '_blank')}
                        disabled={!agentWallet?.agentPublicKey}
                        title="View on Exchange"
                        data-testid="button-view-on-exchange"
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
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : agentWallet == null ? '\u2014' : `$${agentWallet.balance.toFixed(2)}`}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
                  <p className="text-xs text-orange-500/70 mb-1 flex items-center gap-1">
                    <Fuel className="w-3 h-3" /> Gas (SOL)
                  </p>
                  <p className="text-xl font-mono font-semibold text-orange-500" data-testid="text-agent-sol-balance">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : agentWallet == null ? '\u2014' : `${agentWallet.solBalance.toFixed(4)}`}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Your loan — liability card. Owner-gated (eligible) and only rendered when
          a real borrow position exists. A loan is DEBT, never a green deposit. */}
      {borrow?.eligible && borrow.positions.length > 0 && (
        <Card className="border-accent/30 bg-accent/5" data-testid="card-loans">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Landmark className="w-4 h-4 text-accent" />
              <h2 className="font-semibold leading-tight">Your loan</h2>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Borrowed USDC is money you owe — a liability, not a deposit.
            </p>
            {borrow.positions.map((p) => {
              const rawDebt = p.debtAmountRaw ? Number(p.debtAmountRaw) / 1e6 : null;
              const debtUsd = rawDebt != null && Number.isFinite(rawDebt) ? rawDebt : null;
              const atRisk = p.liveHealth?.liquidatable === true;
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border bg-background/40 p-4 space-y-3"
                  data-testid={`card-loan-${p.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Outstanding debt</p>
                      <p className="text-2xl font-semibold tabular-nums text-accent" data-testid={`text-loan-debt-${p.id}`}>
                        {debtUsd === null ? '\u2014' : `$${debtUsd.toFixed(2)}`}
                        <span className="text-sm font-normal text-muted-foreground ml-1">USDC</span>
                      </p>
                    </div>
                    <div className="text-right">
                      {atRisk ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive" data-testid={`text-loan-risk-${p.id}`}>
                          <AlertTriangle className="w-3.5 h-3.5" /> At liquidation risk
                        </span>
                      ) : p.healthIsLive ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid={`text-loan-risk-${p.id}`}>
                          <HeartPulse className="w-3.5 h-3.5" /> Healthy
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`text-loan-risk-${p.id}`}>
                          <HeartPulse className="w-3.5 h-3.5" /> Health unavailable
                        </span>
                      )}
                      <p className="text-[11px] text-muted-foreground mt-1 capitalize">{p.status}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full border-accent/40 text-accent hover:bg-accent/10"
                    onClick={() => handleCloseLoan(p.id)}
                    disabled={closingLoanId === p.id}
                    data-testid={`button-close-loan-${p.id}`}
                  >
                    {closingLoanId === p.id ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Closing...
                      </>
                    ) : (
                      <>
                        <RotateCcw className="w-4 h-4 mr-2" /> Close loan in full
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

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
              <div className="flex items-center justify-center gap-4 py-1">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                  <Wallet className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Your Wallet</span>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
                <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
                  <Bot className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-primary">Trading Agent</span>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => { setDepositDialogTab('usdc'); setDepositDialogOpen(true); }}
                  className="group text-left p-4 rounded-xl border border-border/50 bg-muted/30 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  data-testid="button-open-deposit-usdc"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <Wallet className="w-4 h-4 text-primary" />
                    </div>
                    <span className="font-medium">Deposit USDC</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Move USDC straight from your wallet into the trading agent.</p>
                </button>

                <button
                  onClick={() => { setDepositDialogTab('token'); setDepositDialogOpen(true); }}
                  className="group text-left p-4 rounded-xl border border-border/50 bg-muted/30 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  data-testid="button-open-deposit-token"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <Coins className="w-4 h-4 text-primary" />
                    </div>
                    <span className="font-medium">Deposit any asset</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Deposit SOL, BONK, or any token — we auto-swap it to USDC.</p>
                </button>
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
                      Available: {agentWallet == null ? '\u2014' : `$${agentWallet.balance.toFixed(2)}`}
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
                    {solLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : userSolBalance == null ? '\u2014' : `${userSolBalance.toFixed(4)}`}
                  </p>
                </div>
                <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl">
                  <p className="text-xs text-orange-500/70 mb-2">Agent Gas Balance</p>
                  <p className="font-mono text-xl font-semibold text-orange-500" data-testid="text-gas-agent-sol">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : agentWallet == null ? '\u2014' : `${agentWallet.solBalance.toFixed(4)}`}
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
                      Available: {userSolBalance == null ? '\u2014' : userSolBalance.toFixed(4)} SOL
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
                      Available: {agentWallet == null ? '\u2014' : Math.max(0, agentWallet.solBalance - 0.005).toFixed(4)} SOL
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

      <DepositDialog
        open={depositDialogOpen}
        onOpenChange={setDepositDialogOpen}
        usdcBalance={usdcBalance ?? null}
        initialTab={depositDialogTab}
        onComplete={() => {
          Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchCapitalPool(), fetchUserSolBalance()]);
        }}
      />
    </motion.div>
  );
}
