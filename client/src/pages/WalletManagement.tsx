import { safeResponseJson } from "@/lib/safe-fetch";
import { walletAuthHeaders } from "@/lib/queryClient";
import { useState, useEffect, useRef, useCallback } from 'react';
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
  Plus,
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
import {
  getSessionId,
  toRawBaseUnits,
  fmtUsd,
  fmtUsd0,
  fmtPct,
  healthBarColor,
  RECOMMENDED_MAX_LTV,
  safeLtvMarkerPct,
} from '@/lib/lending-format';
import type { BorrowCollateral, LendingPool, UserToken } from '@/lib/lending-format';
import {
  SupplyCollateralDialog,
  BorrowMoreDialog,
  RepayLoanDialog,
  WithdrawCollateralDialog,
} from '@/components/LendingActionDialogs';

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

interface BorrowConfigResponse {
  eligible: boolean;
  collaterals: BorrowCollateral[];
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

// Per-pool health-bar fill color (`healthBarColor`) is shared from
// '@/lib/lending-format' so the pool-row bar and the borrow dialog's projected
// bar encode health identically.

// Real token icon resolved from on-chain metadata (Helius DAS), with a graceful
// fallback: if the mint has no icon OR the metadata image URL is dead, render
// the symbol's first two letters on the pool colour instead of a broken image.
function CollateralAvatar({ logoURI, symbol, colorClass, testId }: {
  logoURI: string | null;
  symbol: string | null;
  colorClass: string;
  testId?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (logoURI && !errored) {
    return (
      <img
        src={logoURI}
        alt={symbol ?? 'collateral'}
        className="w-8 h-8 rounded-full shrink-0 object-cover"
        onError={() => setErrored(true)}
        data-testid={testId}
      />
    );
  }
  return (
    <span
      className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-background shrink-0 ${colorClass}`}
      data-testid={testId}
    >
      {symbol ? symbol.slice(0, 2) : '\u2014'}
    </span>
  );
}

// "Yield bracket" badge — a small chip showing a yield-bearing collateral's OWN
// native staking APY (e.g. INF/JitoSOL/mSOL earn SOL staking yield just by being
// held). Pure info; renders nothing for non-yield collateral (null APY). Quiet
// neutral styling (green is reserved for balance numbers per the brand rule).
function StakingApyBadge({ apyPct, testId }: { apyPct?: number | null; testId?: string }) {
  if (apyPct == null || !Number.isFinite(apyPct) || apyPct <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`This collateral earns about ${apyPct.toFixed(1)}% staking yield on its own`}
      data-testid={testId}
    >
      <TrendingUp className="w-2.5 h-2.5" />
      {apyPct.toFixed(1)}%
    </span>
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
  const [poolsOpen, setPoolsOpen] = useState(false);

  // Lending action dialogs. Each holds the EXACT position it targets (never by
  // mint alone) so multi-position wallets always act on the right loan.
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [borrowMorePool, setBorrowMorePool] = useState<LendingPool | null>(null);
  const [repayPool, setRepayPool] = useState<LendingPool | null>(null);
  const [withdrawPool, setWithdrawPool] = useState<LendingPool | null>(null);

  const [withdrawToWalletAmount, setWithdrawToWalletAmount] = useState('');
  const [isWithdrawingToWallet, setIsWithdrawingToWallet] = useState(false);

  const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [borrow, setBorrow] = useState<BorrowPositionsResponse | null>(null);
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

  // The user's WALLET token holdings (for the Supply Collateral picker). The
  // dialog intersects these with the hooked-up eligible collaterals, so only
  // assets the wallet actually holds AND we support show up. Lazily loaded each
  // time the Supply dialog opens; guarded against cross-wallet repaint.
  const [userTokens, setUserTokens] = useState<UserToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const prevSupplyOpenRef = useRef(false);
  // The wallet that the currently-held userTokens belong to, so a prior wallet's
  // holdings are never shown while the new wallet's tokens load.
  const userTokensWalletRef = useRef<string | null>(null);

  const fetchWalletTokens = useCallback(async () => {
    const w = currentWalletRef.current;
    // Cross-wallet honesty: drop stale holdings immediately when the wallet
    // changed, so the dialog shows a spinner (not another wallet's assets).
    if (userTokensWalletRef.current !== w) {
      setUserTokens([]);
      userTokensWalletRef.current = w;
    }
    setTokensLoading(true);
    try {
      const res = await fetch('/api/wallet/tokens', { credentials: 'include', headers: walletAuthHeaders() });
      if (!res.ok) throw new Error('Failed to load tokens');
      const data = await safeResponseJson(res);
      if (currentWalletRef.current !== w) return; // cross-wallet guard
      setUserTokens((data.tokens || []) as UserToken[]);
      userTokensWalletRef.current = w;
    } catch {
      if (currentWalletRef.current !== w) return;
      setUserTokens([]);
    } finally {
      if (currentWalletRef.current === w) setTokensLoading(false);
    }
  }, []);

  // Fetch fresh wallet balances on the rising edge of the Supply dialog opening.
  useEffect(() => {
    if (supplyOpen && !prevSupplyOpenRef.current) {
      fetchWalletTokens();
    }
    prevSupplyOpenRef.current = supplyOpen;
  }, [supplyOpen, fetchWalletTokens]);

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
    setUserTokens([]);
    setSupplyOpen(false);
    setBorrowMorePool(null);
    setRepayPool(null);
    setWithdrawPool(null);
    setBorrowPositionsLoaded(false);
    setBorrowPositionsError(false);
    if (connected && publicKeyString) {
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

  const handleRefresh = async () => {
    await Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchUserSolBalance(), fetchBorrowPositions(), fetchBorrowConfig()]);
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
      await Promise.all([fetchUsdcBalance(), fetchAgentBalance()]);
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

  // Re-pull every lending-relevant surface after a successful money op. Passed to
  // each action dialog as onSuccess so the page reflects on-chain truth.
  const refetchLending = () =>
    Promise.all([
      fetchBorrowPositions(),
      fetchBorrowConfig(),
      fetchAgentBalance(),
      fetchUsdcBalance(),
    ]).then(() => undefined);

  if (!connected) {
    return null;
  }

  const isLoading = usdcLoading || agentLoading || solLoading;

  const borrowCol = borrowConfig?.collaterals?.[0] ?? null;
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
      collateralMint: p.collateralMint,
      collateralLogoURI: cfg?.collateralLogoURI ?? null,
      collateralDecimals: cfg?.collateralDecimals ?? null,
      collateralAmountRaw: p.collateralAmountRaw,
      debtAmountRaw: p.debtAmountRaw,
      collateralLabel:
        collTokensValid && cfg
          ? `${(collTokens as number).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${cfg.collateralSymbol}`
          : null,
      collateralUsd,
      debtUsd,
      hasLoan: (debtUsd ?? 0) > 0,
      maxLtv: cfg?.maxLtv ?? null,
      oraclePriceLiquidateUsd: cfg?.oraclePriceLiquidateUsd ?? null,
      liquidatable: p.liveHealth?.liquidatable === true,
      healthIsLive: p.healthIsLive,
      // The collateral's OWN native staking APY (display-only yield bracket badge).
      stakingApyPct: cfg?.stakingApyPct ?? null,
    } satisfies LendingPool & { liquidatable: boolean; healthIsLive: boolean; stakingApyPct: number | null };
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

  // Borrow CAPACITY at each pool's protocol max LTV (the hard ceiling, e.g. INF
  // 0.75). null whenever any pool's collateral or maxLtv is unreadable — fail
  // closed, never fabricate a limit. "Available" is what remains under that cap.
  const allLimitValued =
    pools.length === 0 || pools.every((p) => p.collateralUsd != null && p.maxLtv != null);
  const borrowLimitUsd =
    pools.length === 0
      ? (borrowPositionsLoaded ? 0 : null)
      : allLimitValued
        ? pools.reduce((a, p) => a + (p.collateralUsd as number) * (p.maxLtv as number), 0)
        : null;
  const availableToBorrowUsd =
    borrowLimitUsd != null && totalBorrowedUsd != null
      ? Math.max(0, borrowLimitUsd - totalBorrowedUsd)
      : null;
  // The per-pool detail block (split bar, health note, loan list) has content
  // only once we have pools, a load error, or a loaded-but-empty eligible state.
  const showLendingDetail =
    pools.length > 0 || loansLoadError || (borrowPositionsLoaded && borrowConfig?.eligible === true);

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
                onClick={() => setSupplyOpen(true)}
                disabled={!borrowConfig?.eligible || !borrowCol}
                data-testid="button-add-collateral"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Collateral
              </Button>
            </div>

            <p className="text-xs text-muted-foreground -mt-1">
              Borrowed USDC is money you owe — a liability, not a deposit.
            </p>

            {/* HEADLINE CARDS: three standalone KPI boxes — Total Collateral,
                Available to Borrow, Borrowed — per the approved canvas design.
                Available/limit derive from each pool's protocol max LTV; any
                unreadable pool collapses the figure to an em-dash (fail closed). */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-border bg-background/40 p-4" data-testid="card-total-collateral">
                <div className="flex items-center gap-1.5 mb-2">
                  <Coins className="w-3.5 h-3.5 text-sky-400/80" />
                  <p className="text-[11px] text-muted-foreground">Total Collateral</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums leading-none text-sky-400" data-testid="text-lending-collateral">
                  {loansPending ? <Loader2 className="w-5 h-5 animate-spin" /> : fmtUsd0(totalCollateralUsd)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {loansPending ? 'loading' : loansLoadError ? 'couldn\u2019t load' : pools.length === 0 ? 'none supplied' : `${pools.length} asset${pools.length > 1 ? 's' : ''} supplied`}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-background/40 p-4" data-testid="card-available-to-borrow">
                <div className="flex items-center gap-1.5 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-primary/80" />
                  <p className="text-[11px] text-muted-foreground">Available to Borrow</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums leading-none text-primary" data-testid="text-lending-available">
                  {loansPending ? <Loader2 className="w-5 h-5 animate-spin" /> : fmtUsd0(availableToBorrowUsd)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1.5">across all pools</p>
              </div>

              <div className="rounded-xl border border-border bg-background/40 p-4" data-testid="card-borrowed">
                <div className="flex items-center gap-1.5 mb-2">
                  <Landmark className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-[11px] text-muted-foreground">Borrowed</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums leading-none text-foreground" data-testid="text-lending-borrowed">
                  {loansPending ? <Loader2 className="w-5 h-5 animate-spin" /> : fmtUsd0(totalBorrowedUsd)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {borrowLimitUsd != null ? `of ${fmtUsd0(borrowLimitUsd)} limit \u00b7 a liability` : 'a liability'}
                </p>
              </div>
            </div>

            {/* Per-pool detail: supplied-collateral split, loan-health note, and
                the collapsible loan list. Hidden entirely while still loading. */}
            {showLendingDetail && (
            <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
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
            )}

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
                  // Per-pool borrow capacity = collateral value × this asset's max
                  // borrow LTV. The health bar fill = debt ÷ capacity (how much of
                  // your borrowing room this pool has used). Both inputs are real
                  // on-chain figures; if either is unreadable we hide the bar
                  // (fail closed — never a fabricated fill).
                  const poolBorrowLimitUsd =
                    p.collateralUsd != null && p.maxLtv != null ? p.collateralUsd * p.maxLtv : null;
                  const poolUsagePct =
                    poolBorrowLimitUsd != null && poolBorrowLimitUsd > 0 && p.debtUsd != null
                      ? Math.min(100, Math.max(0, (p.debtUsd / poolBorrowLimitUsd) * 100))
                      : null;
                  // Safe-limit (recommended LTV) marker position on this PROTOCOL-
                  // framed bar; null when the whole bar is within the safe zone.
                  const poolSafeMarkerPct = safeLtvMarkerPct(p.maxLtv);
                  // Current LTV = debt ÷ collateral value, shown to the LEFT of the
                  // safe-limit pipe in the legend for consistency with the per-bot
                  // loan card. Null when either input is unreadable.
                  const poolCurrentLtvPct =
                    p.collateralUsd != null && p.collateralUsd > 0 && p.debtUsd != null
                      ? (p.debtUsd / p.collateralUsd) * 100
                      : null;
                  return (
                    <div key={p.id} className="rounded-xl border border-border bg-background/40 p-4" data-testid={`card-loan-${p.id}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <CollateralAvatar
                            logoURI={p.collateralLogoURI}
                            symbol={p.symbol}
                            colorClass={dot}
                            testId={`img-loan-collateral-${p.id}`}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-medium leading-tight">{p.symbol ?? '\u2014'}</p>
                              <StakingApyBadge apyPct={p.stakingApyPct} testId={`badge-loan-staking-apy-${p.id}`} />
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{p.collateralLabel ?? 'Collateral \u2014'}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold tabular-nums" data-testid={`text-loan-collateral-${p.id}`}>{fmtUsd(p.collateralUsd)}</p>
                          <p className="text-[11px] text-muted-foreground">collateral</p>
                        </div>
                      </div>

                      <div className="mt-3 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">Outstanding debt</span>
                          <span className="flex items-center gap-2">
                            <span className="tabular-nums text-accent" data-testid={`text-loan-debt-${p.id}`}>
                              {poolBorrowLimitUsd != null
                                ? `${fmtUsd(p.debtUsd)} / ${fmtUsd(poolBorrowLimitUsd)}`
                                : `${fmtUsd(p.debtUsd)} USDC`}
                            </span>
                            <span className={`flex items-center gap-1 ${health.cls}`} data-testid={`text-loan-risk-${p.id}`}>
                              <health.Icon className="w-3.5 h-3.5" />{health.label}
                            </span>
                          </span>
                        </div>
                        {/* Per-pool health bar — fill = share of this pool's borrow
                            capacity already used. Real on-chain inputs only; hidden
                            entirely when the capacity or debt can't be read. */}
                        {poolUsagePct != null && (
                          <>
                            <div className="relative">
                              <div
                                className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
                                title={`Borrow capacity used: ${Math.round(poolUsagePct)}%`}
                                data-testid={`bar-loan-health-${p.id}`}
                              >
                                <div className="h-full rounded-full" style={{ width: `${poolUsagePct}%`, backgroundColor: healthBarColor(poolUsagePct) }} />
                              </div>
                              {/* Safe-limit marker. Bar is framed to the PROTOCOL max
                                  LTV, so the safe 50%-LTV point sits at poolSafeMarkerPct%. */}
                              {poolSafeMarkerPct != null && (
                                <div
                                  className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
                                  style={{ left: `${poolSafeMarkerPct}%` }}
                                  title={`Safe limit (${Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)`}
                                  data-testid={`marker-safe-limit-${p.id}`}
                                />
                              )}
                            </div>
                            {poolSafeMarkerPct != null && (
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid={`legend-safe-limit-${p.id}`}>
                                {poolCurrentLtvPct != null && (
                                  <>
                                    <span className="tabular-nums text-foreground" data-testid={`text-loan-current-ltv-${p.id}`}>{Math.round(poolCurrentLtvPct)}% LTV</span>
                                    <span aria-hidden="true" className="text-muted-foreground/60">|</span>
                                  </>
                                )}
                                <span className="inline-block h-2.5 w-px bg-foreground/70 shrink-0" />
                                <span>Safe limit ({Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="h-8 px-3 text-xs bg-gradient-to-r from-accent to-primary text-white"
                          onClick={() => setBorrowMorePool(p)}
                          disabled={!borrowConfig?.eligible}
                          data-testid={`button-borrow-more-${p.id}`}
                        >
                          <Landmark className="w-3.5 h-3.5 mr-1.5" /> {p.hasLoan ? 'Borrow More' : 'Borrow'}
                        </Button>
                        {p.hasLoan && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-3 text-xs border-accent/40 text-accent hover:bg-accent/10"
                            onClick={() => setRepayPool(p)}
                            data-testid={`button-repay-loan-${p.id}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Repay
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 text-xs"
                          onClick={() => setWithdrawPool(p)}
                          data-testid={`button-withdraw-collateral-${p.id}`}
                        >
                          <ArrowUpFromLine className="w-3.5 h-3.5 mr-1.5" /> Withdraw
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
          Promise.all([fetchUsdcBalance(), fetchAgentBalance(), fetchUserSolBalance()]);
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

      {/* Lending money paths — owner-gated. Each targets the EXACT position. */}
      <SupplyCollateralDialog
        open={supplyOpen}
        onOpenChange={setSupplyOpen}
        collaterals={borrowConfig?.collaterals ?? []}
        userTokens={userTokens}
        tokensLoading={tokensLoading}
        onRefreshTokens={fetchWalletTokens}
        pool={null}
        onSuccess={refetchLending}
      />

      <BorrowMoreDialog
        open={!!borrowMorePool}
        onOpenChange={(o) => !o && setBorrowMorePool(null)}
        pool={borrowMorePool}
        cfg={cfgForMint(borrowMorePool?.collateralMint ?? null)}
        onSuccess={refetchLending}
      />

      <RepayLoanDialog
        open={!!repayPool}
        onOpenChange={(o) => !o && setRepayPool(null)}
        pool={repayPool}
        agentUsdcBalance={agentWallet?.balance ?? null}
        walletUsdcBalance={usdcBalance}
        onSuccess={refetchLending}
      />

      <WithdrawCollateralDialog
        open={!!withdrawPool}
        onOpenChange={(o) => !o && setWithdrawPool(null)}
        pool={withdrawPool}
        cfg={cfgForMint(withdrawPool?.collateralMint ?? null)}
        onSuccess={refetchLending}
      />
    </motion.div>
  );
}
