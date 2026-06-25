import { safeResponseJson } from "@/lib/safe-fetch";
import { walletAuthHeaders } from "@/lib/queryClient";
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useWallet } from '@/hooks/useWallet';
import { useTokenBalance } from '@/hooks/useTokenBalance';
import { useToast } from '@/hooks/use-toast';
import {
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
  RotateCcw,
  Coins,
  Fuel,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import { EquityHistory } from '@/components/EquityHistory';
import { DepositDialog } from '@/components/DepositDialog';

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

// Launch borrow collateral config (server-derived from the on-chain vault). The
// client NEVER supplies a vault id or mint — it only reads these to render the
// form and convert typed amounts to base units.
interface BorrowCollateral {
  vaultId: number;
  collateralMint: string;
  collateralSymbol: string;
  collateralDecimals: number;
  debtMint: string;
  debtSymbol: string;
  debtDecimals: number;
  maxLtv: number;
  liquidationThreshold: number;
  borrowApr: number;
  minimumBorrowingRaw: string;
  borrowableUsdcRaw: string;
  oraclePriceLiquidateUsd: number;
  marketPriceUsd: number;
}

interface BorrowConfigResponse {
  eligible: boolean;
  collaterals: BorrowCollateral[];
}

// Read-only projection from the server risk gate. `allowed` reflects the FULL
// enforced gate (incl. the owner/allowlist check); it is advisory on the client.
interface BorrowPreviewResult {
  ok: boolean;
  allowed: boolean;
  projection: {
    collateralValueUsd: number | null;
    projectedLtv: number | null;
    projectedHealthFactor: number | null;
    effectiveMaxLtv: number | null;
    projectedDebtUsd: number | null;
    maxAllowedAdditionalDebtRaw: string | null;
  } | null;
  reasons: { code: string; severity: string; message: string }[];
}

interface WalletContentProps {
  initialTab?: 'deposit' | 'withdraw' | 'gas';
}

// Collateral-asset color hierarchy (ported from the approved mockup). Governs the
// lending split bar, its legend and the per-pool avatars ONLY. Gas, health and
// copied-state colors keep their own meanings elsewhere.
const LENDING_ASSET_COLORS = [
  'bg-teal-400', 'bg-violet-400', 'bg-pink-400', 'bg-blue-400',
  'bg-teal-300', 'bg-purple-400', 'bg-pink-500', 'bg-sky-400',
  'bg-cyan-400', 'bg-indigo-400',
] as const;
const lendingAssetColor = (i: number): string => LENDING_ASSET_COLORS[i % LENDING_ASSET_COLORS.length];

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

// Convert a user-typed decimal amount into a base-unit integer STRING for a money
// path. String math only (never parseFloat): rejects empty, negatives, scientific
// notation, commas, and over-precision (more fraction digits than `decimals`).
// Returns null on any invalid input so callers fail closed.
function toRawBaseUnits(amount: string, decimals: number): string | null {
  const s = (amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > decimals) return null;
  const combined = intPart + fracPart.padEnd(decimals, '0');
  try {
    return BigInt(combined).toString();
  } catch {
    return null;
  }
}

type KpiTone = 'primary' | 'accent' | 'neutral' | 'emerald';

// Headline figure in the KPI strip. Shows a spinner while its source is loading
// and an em dash (never a fake $0.00) when the value failed to load.
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
  const { connected, shortenedAddress, publicKeyString } = useWallet();
  const { usdcBalance, usdcLoading, fetchUsdcBalance } = useTokenBalance();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [depositDialogTab, setDepositDialogTab] = useState<'usdc' | 'token'>('usdc');
  const [copiedAddress, setCopiedAddress] = useState(false);

  // Money-action dialogs (replaces the old 5-tab strip).
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [gasDialogOpen, setGasDialogOpen] = useState(false);
  const [borrowDialogOpen, setBorrowDialogOpen] = useState(false);
  const [poolsOpen, setPoolsOpen] = useState(false);

  const [withdrawToWalletAmount, setWithdrawToWalletAmount] = useState('');
  const [isWithdrawingToWallet, setIsWithdrawingToWallet] = useState(false);

  const [capitalPool, setCapitalPool] = useState<CapitalPool | null>(null);
  const [capitalLoading, setCapitalLoading] = useState(false);

  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [borrow, setBorrow] = useState<BorrowPositionsResponse | null>(null);
  const [closingLoanId, setClosingLoanId] = useState<string | null>(null);
  // Loan data is real-money state: never show "$0 / no loans" until we have a
  // SUCCESSFUL positions response for the CURRENT wallet. Until then show a
  // spinner; on failure show an em-dash + honest hint (never a fabricated zero).
  const [borrowPositionsLoaded, setBorrowPositionsLoaded] = useState(false);
  const [borrowPositionsError, setBorrowPositionsError] = useState(false);
  // Always holds the latest connected wallet. Every async wallet-scoped fetch
  // captures the wallet it started for and bails before setState if this has
  // changed — so a slow in-flight response can never repaint another wallet's
  // financial data (cross-wallet leak guard).
  const currentWalletRef = useRef<string | null>(null);

  const [borrowConfig, setBorrowConfig] = useState<BorrowConfigResponse | null>(null);
  const [borrowConfigLoading, setBorrowConfigLoading] = useState(false);
  const [borrowCollateralAmount, setBorrowCollateralAmount] = useState('');
  const [borrowDebtAmount, setBorrowDebtAmount] = useState('');
  const [borrowPreview, setBorrowPreview] = useState<BorrowPreviewResult | null>(null);
  const [borrowPreviewLoading, setBorrowPreviewLoading] = useState(false);
  const [isOpeningBorrow, setIsOpeningBorrow] = useState(false);
  const borrowPreviewSeqRef = useRef(0);

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
    const w = publicKeyString;
    if (!w) return;
    setBorrowPositionsError(false);
    try {
      const res = await fetch('/api/vault/borrow/positions', {
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (currentWalletRef.current !== w) return; // wallet switched mid-flight
      if (!res.ok) { setBorrowPositionsError(true); return; }
      const data = await safeResponseJson(res);
      if (currentWalletRef.current !== w) return;
      setBorrow(data);
      setBorrowPositionsLoaded(true);
    } catch (error) {
      console.error('Error fetching borrow positions:', error);
      if (currentWalletRef.current === w) setBorrowPositionsError(true);
    }
  };

  // Read the launch borrow config (allowlisted collateral + live vault facts) and
  // whether the owner-gated money path is open for this wallet. Read-only.
  const fetchBorrowConfig = async () => {
    const w = publicKeyString;
    if (!w) return;
    setBorrowConfigLoading(true);
    try {
      const res = await fetch('/api/vault/borrow/config', {
        credentials: 'include',
        headers: walletAuthHeaders(),
      });
      if (currentWalletRef.current !== w) return; // wallet switched mid-flight
      if (!res.ok) { setBorrowConfig(null); return; }
      const data = await safeResponseJson(res);
      if (currentWalletRef.current !== w) return;
      setBorrowConfig(data);
    } catch (error) {
      console.error('Error fetching borrow config:', error);
      if (currentWalletRef.current === w) setBorrowConfig(null);
    } finally {
      if (currentWalletRef.current === w) setBorrowConfigLoading(false);
    }
  };

  useEffect(() => {
    // Pin the active wallet synchronously BEFORE any fetch starts, so an in-flight
    // response from the previous wallet bails out at its guard instead of
    // repainting this wallet's view.
    currentWalletRef.current = publicKeyString ?? null;
    // Clear any prior loan data immediately on wallet switch/disconnect so a stale
    // (other-wallet) loan card can never flash if the refetch is slow or fails.
    setBorrow(null);
    setBorrowConfig(null);
    setBorrowPreview(null);
    setBorrowCollateralAmount('');
    setBorrowDebtAmount('');
    setBorrowPositionsLoaded(false);
    setBorrowPositionsError(false);
    if (connected && publicKeyString) {
      fetchCapitalPool();
      fetchAgentBalance();
      fetchUserSolBalance();
      fetchBorrowPositions();
      fetchBorrowConfig();
    }
  }, [connected, publicKeyString]);

  // Deep-link entry points. App.tsx sets initialTab='gas' for the "Add SOL" CTA
  // and 'withdraw' for a direct-withdraw entry; auto-open the matching dialog.
  // 'deposit' is the nav default, so it must NOT auto-open anything.
  useEffect(() => {
    if (initialTab === 'gas') setGasDialogOpen(true);
    else if (initialTab === 'withdraw') setWithdrawDialogOpen(true);
  }, [initialTab]);

  // Debounced, race-guarded live borrow projection. Read-only: asks the server
  // risk gate what a hypothetical borrow would look like (LTV/health) and whether
  // it would be allowed. The `allowed` shown here is ADVISORY — the open route
  // re-runs the full gate immediately before signing.
  useEffect(() => {
    // Invalidate any in-flight preview on EVERY input change (incl. clear/invalid),
    // so a slow prior request can't write a stale projection back after the user
    // has already changed or cleared the amount.
    const seq = ++borrowPreviewSeqRef.current;
    const cfg = borrowConfig?.collaterals?.[0];
    if (!cfg) { setBorrowPreview(null); setBorrowPreviewLoading(false); return; }
    const collRaw = toRawBaseUnits(borrowCollateralAmount, cfg.collateralDecimals);
    const debtRaw = toRawBaseUnits(borrowDebtAmount || '0', cfg.debtDecimals);
    if (collRaw === null || debtRaw === null || BigInt(collRaw) <= 0n) {
      setBorrowPreview(null);
      setBorrowPreviewLoading(false);
      return;
    }
    setBorrowPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/vault/borrow/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
          body: JSON.stringify({ collateralMint: cfg.collateralMint, collateralRaw: collRaw, requestedDebtRaw: debtRaw }),
          credentials: 'include',
        });
        const data = await safeResponseJson(res);
        if (seq !== borrowPreviewSeqRef.current) return;
        setBorrowPreview(res.ok ? data : null);
      } catch {
        if (seq === borrowPreviewSeqRef.current) setBorrowPreview(null);
      } finally {
        if (seq === borrowPreviewSeqRef.current) setBorrowPreviewLoading(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [borrowCollateralAmount, borrowDebtAmount, borrowConfig]);

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchCapitalPool(), fetchAgentBalance(), fetchUserSolBalance(), fetchBorrowPositions(), fetchBorrowConfig()]);
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

  // Withdraw USDC from the trading agent back to the user's wallet. Returns true
  // only on a confirmed success so the dialog can auto-close (logic unchanged).
  const handleWithdrawToWallet = async (): Promise<boolean> => {
    const amount = parseFloat(withdrawToWalletAmount);
    if (!amount || amount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return false;
    }

    if (agentWallet && amount > agentWallet.balance) {
      toast({ title: 'Insufficient Agent Wallet balance', variant: 'destructive' });
      return false;
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
      return true;
    } catch (error: any) {
      console.error('Withdraw to wallet error:', error);
      toast({
        title: 'Withdrawal Failed',
        description: error.message || 'Please try again',
        variant: 'destructive'
      });
      return false;
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
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to close loan');
      const warn = data.verifyWarning || data.dbWarning;
      if (data.finalized === true) {
        toast({ title: 'Loan closed', description: warn || 'Your debt was repaid and your collateral returned.' });
      } else {
        // Repayment tx landed but on-chain verification is still pending. Do NOT
        // claim the loan is closed; keep the liability visible until reconciled.
        toast({ title: 'Repayment sent \u2014 verifying', description: warn || 'The repayment landed on-chain and we\u2019re confirming it. Your loan stays listed until it\u2019s verified closed.' });
      }
      await Promise.all([fetchBorrowPositions(), fetchAgentBalance(), fetchUsdcBalance(), fetchCapitalPool()]);
    } catch (error: any) {
      console.error('Close loan error:', error);
      toast({ title: 'Could not close loan', description: error.message || 'Please try again', variant: 'destructive' });
    } finally {
      setClosingLoanId(null);
    }
  };

  // Open a borrow: lock collateral + borrow USDC. THE money path on the client.
  // Amounts are parsed to base-unit strings (never floats); the server re-runs the
  // full risk gate before signing. Treat ONLY response.ok && data.success as
  // success — a signature can be present on a failed attempt. Returns true on a
  // confirmed success so the dialog can auto-close.
  const handleOpenBorrow = async (): Promise<boolean> => {
    const cfg = borrowConfig?.collaterals?.[0];
    if (!cfg) return false;
    const collRaw = toRawBaseUnits(borrowCollateralAmount, cfg.collateralDecimals);
    const debtRaw = toRawBaseUnits(borrowDebtAmount, cfg.debtDecimals);
    if (collRaw === null || debtRaw === null || BigInt(collRaw) <= 0n || BigInt(debtRaw) <= 0n) {
      toast({ title: 'Enter valid amounts', description: 'Check the collateral and borrow amounts.', variant: 'destructive' });
      return false;
    }
    setIsOpeningBorrow(true);
    try {
      const sessionId = await getSessionId();
      const response = await fetch('/api/vault/borrow/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
        body: JSON.stringify({ collateralMint: cfg.collateralMint, collateralRaw: collRaw, requestedDebtRaw: debtRaw, sessionId }),
        credentials: 'include',
      });
      const data = await safeResponseJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'Borrow failed');
      const warn = data.verifyWarning || data.dbWarning;
      toast({
        title: 'Borrow complete',
        description: warn || 'Your USDC loan is open. Borrowed USDC is a liability you owe.',
      });
      setBorrowCollateralAmount('');
      setBorrowDebtAmount('');
      setBorrowPreview(null);
      await Promise.all([fetchBorrowPositions(), fetchBorrowConfig(), fetchAgentBalance(), fetchUsdcBalance(), fetchCapitalPool()]);
      return true;
    } catch (error: any) {
      console.error('Open borrow error:', error);
      toast({ title: 'Could not borrow', description: error.message || 'Please try again', variant: 'destructive' });
      // Refresh advisory config/eligibility so the UI reflects server truth.
      fetchBorrowConfig();
      return false;
    } finally {
      setIsOpeningBorrow(false);
    }
  };

  if (!connected) {
    return null;
  }

  const isLoading = usdcLoading || capitalLoading || agentLoading || solLoading;

  const borrowCol = borrowConfig?.collaterals?.[0] ?? null;
  const borrowProj = borrowPreview?.projection ?? null;
  const borrowCollRaw = borrowCol ? toRawBaseUnits(borrowCollateralAmount, borrowCol.collateralDecimals) : null;
  const borrowDebtRaw = borrowCol ? toRawBaseUnits(borrowDebtAmount, borrowCol.debtDecimals) : null;
  const borrowAmountsValid = !!borrowCollRaw && !!borrowDebtRaw && BigInt(borrowCollRaw) > 0n && BigInt(borrowDebtRaw) > 0n;
  const borrowBlockReasons = borrowPreview && !borrowPreview.allowed
    ? borrowPreview.reasons.filter((r) => r.severity !== 'info')
    : [];
  const canBorrow = !!borrowConfig?.eligible && !!borrowPreview?.allowed && borrowAmountsValid && !borrowPreviewLoading && !isOpeningBorrow;
  const fmtPct = (f: number | null | undefined) => (f == null || !Number.isFinite(f) ? '\u2014' : `${(f * 100).toFixed(1)}%`);
  const fmtUsd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '\u2014' : `$${n.toFixed(2)}`);

  // ── Lending (collateral + loans) — REAL data only ─────────────────────────
  // A "pool" is one real borrow position. We never invent supplied-collateral
  // rows: a row renders only when an actual loan exists. Every figure is sourced
  // from the position + its matching config; anything unvaluable becomes an em
  // dash (never a fabricated number).
  const positions = borrow?.positions ?? [];
  const lendingVisible = !!borrowConfig?.eligible || positions.length > 0;
  const cfgForMint = (mint: string | null) =>
    mint ? (borrowConfig?.collaterals?.find((c) => c.collateralMint === mint) ?? null) : null;

  const pools = positions.map((p) => {
    const cfg = cfgForMint(p.collateralMint);
    const collTokens =
      p.collateralAmountRaw && cfg ? Number(p.collateralAmountRaw) / 10 ** cfg.collateralDecimals : null;
    const collTokensValid = collTokens != null && Number.isFinite(collTokens);
    const collateralUsd =
      collTokensValid && cfg && Number.isFinite(cfg.marketPriceUsd) ? (collTokens as number) * cfg.marketPriceUsd : null;
    const debt = p.debtAmountRaw ? Number(p.debtAmountRaw) / 1e6 : null;
    const debtUsd = debt != null && Number.isFinite(debt) ? debt : null;
    return {
      id: p.id,
      status: p.status,
      symbol: cfg?.collateralSymbol ?? null,
      collateralLabel:
        collTokensValid && cfg
          ? `${(collTokens as number).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${cfg.collateralSymbol}`
          : null,
      collateralUsd,
      debtUsd,
      liquidatable: p.liveHealth?.liquidatable === true,
      healthIsLive: p.healthIsLive,
    };
  });

  const loanPools = pools.filter((p) => (p.debtUsd ?? 0) > 0);
  const allCollateralValued = pools.length > 0 && pools.every((p) => p.collateralUsd != null);
  // A true $0 is only honest once positions have SUCCESSFULLY loaded for this
  // wallet. While loading or on failure (and we have no pools) totals are null
  // → spinner / em-dash, never a fabricated zero.
  const totalCollateralUsd =
    pools.length === 0
      ? (borrowPositionsLoaded ? 0 : null)
      : allCollateralValued ? pools.reduce((a, p) => a + (p.collateralUsd as number), 0) : null;
  const allDebtValued = pools.length === 0 || pools.every((p) => p.debtUsd != null);
  const totalBorrowedUsd =
    pools.length === 0
      ? (borrowPositionsLoaded ? 0 : null)
      : allDebtValued ? pools.reduce((a, p) => a + (p.debtUsd ?? 0), 0) : null;
  // Positions not yet known for this wallet (still fetching) — show a spinner in
  // the headboard instead of "$0 / no loans".
  const loansPending = !borrowPositionsLoaded && !borrowPositionsError && pools.length === 0;
  // Fetch failed and we have nothing to show — honest "couldn't load", not "$0".
  const loansLoadError = borrowPositionsError && pools.length === 0;

  // Split bar + per-pool avatar colors keyed off collateral USD rank (only when
  // every pool is valued and the basket is non-zero).
  const splitPools =
    totalCollateralUsd != null && totalCollateralUsd > 0
      ? [...pools].sort((a, b) => (b.collateralUsd as number) - (a.collateralUsd as number))
      : [];
  const poolColor = new Map<string, string>();
  splitPools.forEach((p, i) => poolColor.set(p.id, lendingAssetColor(i)));

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

      {/* Wallet + Trading Agent — real addresses & balances, with the money
          actions attached directly to the agent that holds the funds. */}
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
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-orange-500/70 mb-1 flex items-center gap-1">
                      <Fuel className="w-3 h-3" /> Gas (SOL)
                    </p>
                    <button
                      onClick={() => setGasDialogOpen(true)}
                      className="text-[11px] text-orange-500 hover:text-orange-400 underline underline-offset-2"
                      data-testid="button-gas-topup"
                    >
                      Top up
                    </button>
                  </div>
                  <p className="text-xl font-mono font-semibold text-orange-500" data-testid="text-agent-sol-balance">
                    {agentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : agentWallet == null ? '\u2014' : `${agentWallet.solBalance.toFixed(4)}`}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-4">
                <Button
                  className="h-10"
                  onClick={() => { setDepositDialogTab('usdc'); setDepositDialogOpen(true); }}
                  data-testid="button-open-deposit"
                >
                  <ArrowDownToLine className="w-4 h-4 mr-2" /> Deposit
                </Button>
                <Button
                  variant="outline"
                  className="h-10"
                  onClick={() => setWithdrawDialogOpen(true)}
                  data-testid="button-open-withdraw"
                >
                  <ArrowUpFromLine className="w-4 h-4 mr-2" /> Withdraw
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lending collateral — owner-gated. Rendered when the wallet is eligible OR
          a real loan exists. Each pool is one real borrow position (collateral
          locked + USDC owed); pools are ISOLATED, so health is per-pool, never a
          single blended number. */}
      {lendingVisible && (
        <Card className="border-teal-500/20 bg-card" data-testid="card-lending">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-teal-500/10 flex items-center justify-center">
                  <Coins className="w-4.5 h-4.5 text-teal-300" />
                </div>
                <div>
                  <h2 className="font-semibold leading-tight">Lending collateral</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Held as collateral · borrow USDC against it</p>
                </div>
              </div>
              <Button
                size="sm"
                className="bg-teal-500 hover:bg-teal-500/90 text-background shrink-0"
                onClick={() => setBorrowDialogOpen(true)}
                disabled={!borrowConfig?.eligible || !borrowCol}
                data-testid="button-open-borrow"
              >
                <Landmark className="w-4 h-4 mr-2" /> Borrow
              </Button>
            </div>

            <p className="text-xs text-muted-foreground -mt-1">
              Borrowed USDC is money you owe — a liability, not a deposit.
            </p>

            {/* HEADBOARD: fixed-height summary. Per-pool rows stay hidden behind
                the toggle so page length is constant regardless of loan count. */}
            <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-muted-foreground">Collateral</p>
                  <p className="text-base font-semibold tabular-nums mt-0.5 text-sky-400" data-testid="text-lending-collateral">
                    {loansPending ? <Loader2 className="w-4 h-4 animate-spin" /> : fmtUsd(totalCollateralUsd)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {loansPending ? 'loading' : pools.length === 0 ? 'none locked' : `${pools.length} pool${pools.length > 1 ? 's' : ''}`}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Borrowed</p>
                  <p className="text-base font-semibold tabular-nums mt-0.5 text-accent" data-testid="text-lending-borrowed">
                    {loansPending ? <Loader2 className="w-4 h-4 animate-spin" /> : fmtUsd(totalBorrowedUsd)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">a liability</p>
                </div>
              </div>

              {/* Supplied-collateral split bar — widths from real collateral USD,
                  shown only when every pool is valued and the basket is > 0. */}
              {splitPools.length > 0 && totalCollateralUsd != null && totalCollateralUsd > 0 && (
                <div className="space-y-2">
                  <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted">
                    {splitPools.map((p) => (
                      <div
                        key={p.id}
                        className={poolColor.get(p.id)}
                        style={{ width: `${((p.collateralUsd as number) / totalCollateralUsd) * 100}%` }}
                        title={`${p.symbol ?? '\u2014'} ${Math.round(((p.collateralUsd as number) / totalCollateralUsd) * 100)}%`}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {splitPools.slice(0, 5).map((p) => (
                      <div key={p.id} className="flex items-center gap-1.5 rounded-full border border-border bg-background/40 pl-2 pr-2.5 py-0.5">
                        <span className={`w-2 h-2 rounded-full ${poolColor.get(p.id)}`} />
                        <span className="text-[11px] font-medium">{p.symbol ?? '\u2014'}</span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">{fmtUsd(p.collateralUsd)}</span>
                      </div>
                    ))}
                    {splitPools.length > 5 && (
                      <div className="flex items-center rounded-full border border-border/60 bg-background/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                        +{splitPools.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              {loanPools.length > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground border-t border-border/50 pt-2.5">
                  <HeartPulse className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>{loanPools.length} pool{loanPools.length > 1 ? 's have' : ' has'} an active loan — open to check each one&rsquo;s health.</span>
                </div>
              )}

              {pools.length > 0 && (
                <button
                  onClick={() => setPoolsOpen((o) => !o)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-lg border border-border/60 hover:bg-muted/30 transition-colors"
                  data-testid="button-toggle-pools"
                >
                  {poolsOpen ? 'Hide loans' : `View ${pools.length} loan${pools.length > 1 ? 's' : ''}`}
                  {poolsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              )}

              {loansLoadError ? (
                <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground text-center pt-1" data-testid="text-loans-load-error">
                  <span>Couldn&rsquo;t load your loans.</span>
                  <button onClick={fetchBorrowPositions} className="underline hover:text-foreground" data-testid="button-retry-loans">Retry</button>
                </div>
              ) : (
                pools.length === 0 && borrowPositionsLoaded && borrowConfig?.eligible && (
                  <p className="text-xs text-muted-foreground text-center pt-1" data-testid="text-no-loans">
                    You have no open loans. Lock collateral to borrow USDC.
                  </p>
                )
              )}
            </div>

            {/* Each open loan = one isolated pool with its own collateral & health.
                Hidden until the user opens the headboard. */}
            {poolsOpen && pools.length > 0 && (
              <div className="space-y-2.5">
                {pools.map((p, i) => {
                  const atRisk = p.liquidatable;
                  const health = atRisk
                    ? { label: 'At risk', cls: 'text-red-400', Icon: AlertTriangle }
                    : p.healthIsLive
                      ? { label: 'Safe', cls: 'text-emerald-300', Icon: ShieldCheck }
                      : { label: 'Health unavailable', cls: 'text-muted-foreground', Icon: HeartPulse };
                  const dot = poolColor.get(p.id) ?? lendingAssetColor(i);
                  return (
                    <div key={p.id} className="rounded-xl border border-border bg-background/40 p-4" data-testid={`card-loan-${p.id}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-background shrink-0 ${dot}`}>
                            {p.symbol ? p.symbol.slice(0, 2) : '\u2014'}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-tight">{p.symbol ?? '\u2014'}</p>
                            <p className="text-xs text-muted-foreground truncate">{p.collateralLabel ?? 'Collateral \u2014'}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold tabular-nums" data-testid={`text-loan-collateral-${p.id}`}>{fmtUsd(p.collateralUsd)}</p>
                          <p className="text-[11px] text-muted-foreground">collateral</p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Outstanding debt</span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-accent" data-testid={`text-loan-debt-${p.id}`}>{fmtUsd(p.debtUsd)} USDC</span>
                          <span className={`flex items-center gap-1 ${health.cls}`} data-testid={`text-loan-risk-${p.id}`}>
                            <health.Icon className="w-3.5 h-3.5" />{health.label}
                          </span>
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="h-8 px-3 text-xs bg-gradient-to-r from-accent to-primary text-white"
                          onClick={() => setBorrowDialogOpen(true)}
                          disabled={!borrowConfig?.eligible || !borrowCol}
                          data-testid={`button-borrow-more-${p.id}`}
                        >
                          <Landmark className="w-3.5 h-3.5 mr-1.5" /> Borrow more
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 text-xs border-accent/40 text-accent hover:bg-accent/10"
                          onClick={() => handleCloseLoan(p.id)}
                          disabled={closingLoanId === p.id}
                          data-testid={`button-close-loan-${p.id}`}
                        >
                          {closingLoanId === p.id ? (
                            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Repaying...</>
                          ) : (
                            <><RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Repay in full</>
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* Withdraw USDC — trading agent → your wallet. */}
      <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Withdraw USDC</DialogTitle>
            <DialogDescription>Move USDC from your trading agent back to your wallet.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3 py-1">
              <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
                <Bot className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-primary">Trading Agent</span>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground" />
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
              onClick={async () => { const ok = await handleWithdrawToWallet(); if (ok) setWithdrawDialogOpen(false); }}
              disabled={isWithdrawingToWallet || !withdrawToWalletAmount || parseFloat(withdrawToWalletAmount) <= 0}
              data-testid="button-withdraw-wallet"
            >
              {isWithdrawingToWallet ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Processing...</>
              ) : (
                <><ArrowUpFromLine className="w-5 h-5 mr-2" /> Withdraw USDC</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Gas (SOL) — fund or recover the agent's network-fee reserve. */}
      <Dialog open={gasDialogOpen} onOpenChange={setGasDialogOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Network fees (SOL)</DialogTitle>
            <DialogDescription>Keep SOL in your agent so it can pay Solana network fees for trades and transfers.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl space-y-2">
              <div className="flex items-center gap-2 text-orange-500">
                <Fuel className="w-5 h-5" />
                <h3 className="font-semibold">About gas fees</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                SOL pays transaction fees on Solana. Your trading agent needs SOL to execute trades, deposits, and withdrawals.
              </p>
              <p className="text-sm font-medium text-orange-500/90">
                Recommended: keep at least 0.1 SOL for smooth operations.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-muted/30 rounded-xl">
                <p className="text-xs text-muted-foreground mb-2">Your wallet SOL</p>
                <p className="font-mono text-xl font-semibold" data-testid="text-gas-user-sol">
                  {solLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : userSolBalance == null ? '\u2014' : `${userSolBalance.toFixed(4)}`}
                </p>
              </div>
              <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl">
                <p className="text-xs text-orange-500/70 mb-2">Agent gas balance</p>
                <p className="font-mono text-xl font-semibold text-orange-500" data-testid="text-gas-agent-sol">
                  {agentLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : agentWallet == null ? '\u2014' : `${agentWallet.solBalance.toFixed(4)}`}
                </p>
              </div>
            </div>

            <div className="p-4 bg-muted/30 rounded-xl space-y-4">
              <div className="flex items-center justify-center gap-3 py-1">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                  <Wallet className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Your SOL</span>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
                <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                  <Fuel className="w-4 h-4 text-orange-500" />
                  <span className="text-sm font-medium text-orange-500">Agent gas</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">Deposit amount (SOL)</label>
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
                  <Button variant="outline" onClick={setMaxSolDeposit} data-testid="button-sol-deposit-max">Max</Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">Keeps 0.01 SOL in your wallet for transaction fees</p>
              </div>

              <Button
                className="w-full bg-gradient-to-r from-orange-500 to-orange-600 h-11"
                onClick={handleSolDeposit}
                disabled={isDepositingSol || !solDepositAmount || parseFloat(solDepositAmount) <= 0}
                data-testid="button-sol-deposit"
              >
                {isDepositingSol ? (
                  <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Processing...</>
                ) : (
                  <><Fuel className="w-5 h-5 mr-2" /> Fund agent gas</>
                )}
              </Button>
            </div>

            <div className="p-4 bg-muted/30 rounded-xl space-y-4">
              <div className="flex items-center justify-center gap-3 py-1">
                <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                  <Fuel className="w-4 h-4 text-orange-500" />
                  <span className="text-sm font-medium text-orange-500">Agent gas</span>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                  <Wallet className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Your Wallet</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">Withdraw amount (SOL)</label>
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
                  <Button variant="outline" onClick={setMaxSolWithdraw} data-testid="button-sol-withdraw-max">Max</Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">Keep at least 0.005 SOL for agent transaction fees</p>
              </div>

              <Button
                variant="outline"
                className="w-full border-orange-500/50 text-orange-500 hover:bg-orange-500/10 h-11"
                onClick={handleSolWithdraw}
                disabled={solWithdrawing || !solWithdrawAmount || parseFloat(solWithdrawAmount) <= 0}
                data-testid="button-sol-withdraw"
              >
                {solWithdrawing ? (
                  <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Processing...</>
                ) : (
                  <><ArrowUpFromLine className="w-5 h-5 mr-2" /> Withdraw SOL</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Borrow USDC against collateral — owner-gated money path. */}
      <Dialog open={borrowDialogOpen} onOpenChange={setBorrowDialogOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Borrow USDC</DialogTitle>
            <DialogDescription>
              {borrowCol
                ? `Lock ${borrowCol.collateralSymbol} as collateral and borrow USDC against it.`
                : 'Lock collateral and borrow USDC against it.'}
            </DialogDescription>
          </DialogHeader>

          {borrowConfigLoading && !borrowConfig ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : !borrowCol ? (
            <div className="p-5 bg-muted/30 rounded-xl text-sm text-muted-foreground text-center" data-testid="text-borrow-unavailable">
              Borrowing is unavailable right now. Please try again shortly.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-3 py-1">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg">
                  <Coins className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{borrowCol.collateralSymbol} collateral</span>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
                <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border border-accent/20 rounded-lg">
                  <Landmark className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-accent">Borrow USDC</span>
                </div>
              </div>

              <div className="flex items-start gap-2 p-3 rounded-lg bg-accent/10 border border-accent/20">
                <AlertTriangle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Borrowing locks your {borrowCol.collateralSymbol} as collateral and creates a USDC loan you owe. If {borrowCol.collateralSymbol} falls in value, your collateral can be liquidated. Borrowed USDC is a liability, not a deposit.
                </p>
              </div>

              <div>
                <label className="text-sm font-medium">Collateral ({borrowCol.collateralSymbol})</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={borrowCollateralAmount}
                  onChange={(e) => setBorrowCollateralAmount(e.target.value)}
                  className="mt-2 text-lg"
                  data-testid="input-borrow-collateral"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  The {borrowCol.collateralSymbol} must already be held by your trading agent. It is locked while the loan is open.
                </p>
              </div>

              <div>
                <label className="text-sm font-medium">Borrow (USDC)</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={borrowDebtAmount}
                  onChange={(e) => setBorrowDebtAmount(e.target.value)}
                  className="mt-2 text-lg"
                  data-testid="input-borrow-debt"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Max loan-to-value {fmtPct(borrowCol.maxLtv)} · Borrow APR {fmtPct(borrowCol.borrowApr)}
                </p>
              </div>

              {borrowAmountsValid && (
                <div className="rounded-lg border border-border bg-background/40 p-4 space-y-2" data-testid="panel-borrow-projection">
                  {borrowPreviewLoading ? (
                    <div className="flex items-center justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                  ) : borrowProj ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Collateral value</span>
                        <span className="tabular-nums" data-testid="text-borrow-collateral-value">{fmtUsd(borrowProj.collateralValueUsd)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Projected loan-to-value</span>
                        <span className="tabular-nums" data-testid="text-borrow-ltv">{fmtPct(borrowProj.projectedLtv)} <span className="text-muted-foreground">/ {fmtPct(borrowProj.effectiveMaxLtv)} max</span></span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Health factor</span>
                        <span className="tabular-nums" data-testid="text-borrow-health">{borrowProj.projectedHealthFactor == null || !Number.isFinite(borrowProj.projectedHealthFactor) ? '\u2014' : borrowProj.projectedHealthFactor.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Liquidation reference price</span>
                        <span className="tabular-nums" data-testid="text-borrow-liq-price">{fmtUsd(borrowCol.oraclePriceLiquidateUsd)} <span className="text-muted-foreground">/ {borrowCol.collateralSymbol}</span></span>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center">Projection unavailable right now.</p>
                  )}
                </div>
              )}

              {borrowBlockReasons.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1" data-testid="panel-borrow-reasons">
                  {borrowBlockReasons.map((r, i) => (
                    <p key={i} className="text-xs text-destructive flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {r.message}
                    </p>
                  ))}
                </div>
              )}

              {!borrowConfig?.eligible && (
                <p className="text-xs text-muted-foreground text-center" data-testid="text-borrow-not-enabled">
                  Borrowing isn&rsquo;t enabled for your wallet yet.
                </p>
              )}

              <Button
                className="w-full bg-gradient-to-r from-accent to-primary h-12 text-base"
                onClick={async () => { const ok = await handleOpenBorrow(); if (ok) setBorrowDialogOpen(false); }}
                disabled={!canBorrow}
                data-testid="button-borrow"
              >
                {isOpeningBorrow ? (
                  <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Processing...</>
                ) : (
                  <><Landmark className="w-5 h-5 mr-2" /> Borrow USDC</>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
