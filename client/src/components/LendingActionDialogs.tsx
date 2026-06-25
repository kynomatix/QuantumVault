import { useState, useEffect, useRef, useMemo } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  Loader2,
  Landmark,
  RotateCcw,
  ArrowUpFromLine,
  Wallet,
  Bot,
  Coins,
  Layers,
  AlertTriangle,
  Lock,
  RefreshCw,
  Fuel,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { safeResponseJson } from '@/lib/safe-fetch';
import { walletAuthHeaders } from '@/lib/queryClient';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';
import {
  getSessionId,
  toRawBaseUnits,
  rawToDecimalString,
  newRequestId,
  fmtUsd,
  fmtPct,
  type BorrowCollateral,
  type BorrowPreviewResult,
  type LendingPool,
  type UserToken,
} from '@/lib/lending-format';

const USDC_DECIMALS = 6;
const POST_JSON = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...walletAuthHeaders() },
  body: JSON.stringify(body),
  credentials: 'include',
});

// ---------------------------------------------------------------------------
// SUPPLY COLLATERAL — pick an asset you HOLD IN YOUR WALLET that we support as
// collateral, then lock it. Structured like the "deposit any asset" flow but
// WITHOUT the Jupiter swap: the asset is user-sign-transferred into the trading
// agent as itself, then supplied as collateral so it can back a USDC loan.
//
// The asset list is the intersection of (a) what the wallet holds — /api/wallet/
// tokens — and (b) the hooked-up eligible collaterals — borrowConfig.collaterals.
// If only INF is hooked up and held, only INF shows.
//
// Two on-chain steps. Step 1 (transfer) lands first; if step 2 (supply) fails the
// asset is safe in the trading agent and retryable WITHOUT a second transfer —
// same recoverable shape as the deposit→swap path. positionId:null is safe: the
// executor prefers add-to-existing for the same wallet+vault.
// ---------------------------------------------------------------------------
type SupplyAsset = {
  mint: string;
  symbol: string;
  name: string;
  logoURI: string | null;
  decimals: number;
  amountUi: number;
  maxLtv: number;
  isNativeSol: boolean;
  cfg: BorrowCollateral;
};

export function SupplyCollateralDialog({
  open,
  onOpenChange,
  collaterals,
  userTokens,
  tokensLoading = false,
  onRefreshTokens,
  pool,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collaterals: BorrowCollateral[];
  userTokens: UserToken[];
  tokensLoading?: boolean;
  onRefreshTokens?: () => void;
  pool: LendingPool | null;
  onSuccess: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const [selectedMint, setSelectedMint] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [statusText, setStatusText] = useState('');
  // Set when step 1 (transfer) lands but step 2 (supply) fails: the asset is now
  // in the trading agent, so the user can retry just the supply step.
  const [pendingSupply, setPendingSupply] = useState<{
    cfg: BorrowCollateral;
    collateralRaw: string;
    symbol: string;
    amount: string;
  } | null>(null);

  const lockedMint = pool?.collateralMint ?? null;

  // The list: eligible collaterals the user actually HOLDS in their wallet. When a
  // pool is passed, restrict to that pool's collateral mint. Memoized so the
  // selection effect doesn't re-run every render on a fresh array identity.
  const assets: SupplyAsset[] = useMemo(
    () =>
      collaterals
        .filter((c) => !lockedMint || c.collateralMint === lockedMint)
        .map((c) => {
          const tok = userTokens.find((t) => t.mint === c.collateralMint);
          if (!tok || tok.amountUi <= 0) return null;
          return {
            mint: c.collateralMint,
            symbol: c.collateralSymbol,
            name: tok.name || c.collateralSymbol,
            logoURI: c.collateralLogoURI ?? tok.logoURI,
            decimals: c.collateralDecimals,
            amountUi: tok.amountUi,
            maxLtv: c.maxLtv,
            isNativeSol: tok.isNativeSol,
            cfg: c,
          } as SupplyAsset;
        })
        .filter((a): a is SupplyAsset => a !== null),
    [collaterals, userTokens, lockedMint],
  );

  useEffect(() => {
    if (open) {
      setAmount('');
      setSubmitting(false);
      setStatusText('');
      setPendingSupply(null);
    }
  }, [open]);

  // Keep a valid selection as the asset list resolves (tokens load async).
  useEffect(() => {
    if (!open) return;
    if (assets.length === 0) {
      if (selectedMint) setSelectedMint('');
      return;
    }
    if (!assets.some((a) => a.mint === selectedMint)) {
      setSelectedMint(lockedMint && assets.some((a) => a.mint === lockedMint) ? lockedMint : assets[0].mint);
    }
  }, [open, assets, selectedMint, lockedMint]);

  const selected = assets.find((a) => a.mint === selectedMint) ?? null;
  const collateralRaw = selected ? toRawBaseUnits(amount, selected.decimals) : null;
  const amt = parseFloat(amount);
  const overBalance = !!selected && Number.isFinite(amt) && amt > selected.amountUi;
  const valid = !!selected && !!collateralRaw && BigInt(collateralRaw) > 0n && !overBalance;

  const setMax = () => {
    if (!selected) return;
    // Leave a little native SOL for the transfer fee if SOL is ever a collateral.
    const max = selected.isNativeSol ? Math.max(0, selected.amountUi - 0.01) : selected.amountUi;
    if (!(max > 0)) {
      setAmount('');
      return;
    }
    // Plain decimal string (never scientific notation) so tiny balances still
    // parse to a valid raw amount. Trim trailing zeros only in the fraction.
    let s = max.toFixed(selected.decimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    setAmount(s);
  };

  // Step 2 (or retry): lock the asset — now sitting in the trading agent — as
  // collateral. A failure parks it for a retry that needs no second transfer.
  const runSupply = async (cfg: BorrowCollateral, raw: string, symbol: string, amountStr: string) => {
    setSubmitting(true);
    setStatusText('Locking as collateral…');
    try {
      const sessionId = await getSessionId();
      const res = await fetch(
        '/api/vault/borrow/supply',
        POST_JSON({ collateralMint: cfg.collateralMint, collateralRaw: raw, borrowPositionId: pool?.id ?? null, sessionId }),
      );
      const data = await safeResponseJson(res);
      if (!res.ok || !data.success) {
        setPendingSupply({ cfg, collateralRaw: raw, symbol, amount: amountStr });
        toast({
          title: 'Collateral Not Locked',
          description:
            data.error || `Your ${symbol} is safe in your trading agent — tap "Retry" to lock it as collateral.`,
          variant: 'destructive',
        });
        return;
      }
      setPendingSupply(null);
      toast({ title: 'Collateral Supplied', description: `Supplied ${amountStr} ${symbol} as collateral.` });
      setAmount('');
      onRefreshTokens?.();
      await onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      setPendingSupply({ cfg, collateralRaw: raw, symbol, amount: amountStr });
      toast({ title: 'Collateral Not Locked', description: e.message || 'Please try again', variant: 'destructive' });
    } finally {
      setSubmitting(false);
      setStatusText('');
    }
  };

  const handleSupply = async () => {
    if (!selected || !collateralRaw) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    if (overBalance) {
      toast({ title: `Insufficient ${selected.symbol} balance`, variant: 'destructive' });
      return;
    }
    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      // Step 1: user-signed transfer of the asset into the trading agent (NO swap).
      setStatusText('Building transfer…');
      const depRes = await fetch(
        '/api/agent/deposit-token',
        POST_JSON({ mint: selected.mint, amountRaw: collateralRaw }),
      );
      const depData = await safeResponseJson(depRes);
      if (!depRes.ok) throw new Error(depData.error || 'Could not build the transfer');
      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = depData;

      setStatusText(`Approve the ${selected.symbol} transfer in your wallet…`);
      const tx = Transaction.from(Buffer.from(serializedTx, 'base64'));
      const signed = await solanaWallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());

      setStatusText('Confirming transfer…');
      await confirmTransactionWithFallback(connection, { signature: sig, blockhash, lastValidBlockHeight });

      // Step 2: lock as collateral. From here the asset is in the agent, so a
      // failure is retryable without re-transferring.
      await runSupply(selected.cfg, collateralRaw, selected.symbol, amount);
    } catch (e: any) {
      toast({ title: 'Could not supply collateral', description: e.message || 'Please try again', variant: 'destructive' });
    } finally {
      setSubmitting(false);
      setStatusText('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-supply-collateral">
        <DialogHeader>
          <DialogTitle>Supply Collateral</DialogTitle>
          <DialogDescription>Hold an asset as collateral so you can borrow USDC against it.</DialogDescription>
        </DialogHeader>

        {/* The one thing that must be unmistakable: this is the LENDING path. */}
        <div className="flex items-start gap-2 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2.5">
          <Lock className="w-4 h-4 text-teal-300 mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            This goes to the <span className="text-teal-300 font-medium">lending system</span>, not trading. Your asset
            stays as itself — <span className="text-foreground font-medium">it is never swapped to USDC</span> — and is
            locked as collateral you can borrow against.
          </p>
        </div>

        {pendingSupply ? (
          // Step 1 (transfer) landed but step 2 (supply) failed — the asset is now
          // in the trading agent, so this retries ONLY the supply (no second
          // transfer). Rendered independent of the wallet asset list because the
          // asset may no longer appear there once it has left the wallet.
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500/90">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Your {pendingSupply.symbol} is safe in your trading agent but isn't locked as collateral yet. Tap
                Retry — no second transfer is needed.
              </span>
            </div>
            <Button
              className="w-full h-11 bg-teal-500 hover:bg-teal-500/90 text-background"
              onClick={() =>
                runSupply(pendingSupply.cfg, pendingSupply.collateralRaw, pendingSupply.symbol, pendingSupply.amount)
              }
              disabled={submitting}
              data-testid="button-retry-supply"
            >
              {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Coins className="w-4 h-4 mr-2" />}
              {submitting ? statusText || 'Working…' : `Retry — Lock ${pendingSupply.symbol} as Collateral`}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Select an asset</span>
              <button
                type="button"
                onClick={() => onRefreshTokens?.()}
                disabled={tokensLoading}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                data-testid="button-refresh-supply-tokens"
              >
                <RefreshCw className={`w-3 h-3 ${tokensLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>

            <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {tokensLoading && assets.length === 0 ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading your assets…
                </div>
              ) : assets.length === 0 ? (
                <div className="text-center py-6 px-4 text-muted-foreground text-sm" data-testid="text-supply-empty">
                  You don't hold any assets we currently support as collateral.
                </div>
              ) : (
                assets.map((a) => (
                  <button
                    key={a.mint}
                    type="button"
                    onClick={() => {
                      setSelectedMint(a.mint);
                      setAmount('');
                    }}
                    aria-pressed={a.mint === selectedMint}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${
                      a.mint === selectedMint ? 'bg-teal-500/10' : ''
                    }`}
                    data-testid={`button-supply-asset-${a.symbol}`}
                  >
                    {a.logoURI ? (
                      <img src={a.logoURI} alt={a.symbol} className="w-7 h-7 rounded-full" />
                    ) : (
                      <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold">
                        {a.symbol.slice(0, 2)}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.symbol}</p>
                      <p className="text-xs text-muted-foreground truncate">{a.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-mono">
                        {a.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      </p>
                      <p className="text-[11px] text-muted-foreground">up to {(a.maxLtv * 100).toFixed(0)}% LTV</p>
                    </div>
                  </button>
                ))
              )}
            </div>

            {selected && (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Amount</span>
                    <span data-testid="text-supply-wallet-balance">
                      Wallet {selected.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} {selected.symbol}
                    </span>
                  </div>
                  <div className="relative">
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={submitting}
                      className="h-12 pr-24 text-lg font-medium"
                      data-testid="input-supply-amount"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                      <span className="text-sm font-medium text-muted-foreground">{selected.symbol}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-xs"
                        onClick={setMax}
                        disabled={submitting}
                        data-testid="button-supply-max"
                      >
                        Max
                      </Button>
                    </div>
                  </div>
                  {overBalance && <p className="text-[11px] text-amber-500">More than your wallet balance.</p>}
                </div>

                <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1.5">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Held as</span>
                    <span className="font-medium text-foreground">{selected.symbol} (no swap)</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Unlocks borrow up to</span>
                    <span className="font-medium text-accent">{(selected.maxLtv * 100).toFixed(0)}% of value</span>
                  </div>
                </div>

                <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
                  <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>You'll need a little SOL in your wallet for the network fee (~0.005 SOL).</span>
                </div>

                <Button
                  className="w-full h-11 bg-teal-500 hover:bg-teal-500/90 text-background"
                  onClick={handleSupply}
                  disabled={!valid || submitting}
                  data-testid="button-submit-supply"
                >
                  {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Coins className="w-4 h-4 mr-2" />}
                  {submitting ? statusText || 'Working…' : `Supply ${selected.symbol} as Collateral`}
                </Button>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// BORROW MORE — single-tx, debt-increasing. Borrows additional USDC against an
// existing position. Live advisory preview reflects the POST-OP state (existing
// collateral + existing debt + new debt); the executor re-runs the authoritative
// risk gate with live numbers before signing.
// ---------------------------------------------------------------------------
export function BorrowMoreDialog({
  open,
  onOpenChange,
  pool,
  cfg,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pool: LendingPool | null;
  cfg: BorrowCollateral | null;
  onSuccess: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [debtAmount, setDebtAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<BorrowPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (open) {
      setDebtAmount('');
      setSubmitting(false);
      setPreview(null);
      setPreviewLoading(false);
    }
  }, [open]);

  const debtDecimals = cfg?.debtDecimals ?? USDC_DECIMALS;
  const newDebtRaw = toRawBaseUnits(debtAmount, debtDecimals);
  const newDebtValid = !!newDebtRaw && BigInt(newDebtRaw) > 0n;

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!open || !pool || !cfg || !pool.collateralMint || !pool.collateralAmountRaw || !newDebtValid || !newDebtRaw) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        // Send ADDITIONAL debt only. The preview route sums this wallet's
        // existing debt for this collateral from the cache and adds it to
        // requestedDebtRaw; sending the running total would double-count the
        // existing debt (existing + existing + new). Matches the borrow-more
        // executor, which passes additional debt + a live existingDebtRawOverride.
        const res = await fetch(
          '/api/vault/borrow/preview',
          POST_JSON({ collateralMint: pool.collateralMint, collateralRaw: pool.collateralAmountRaw, requestedDebtRaw: newDebtRaw }),
        );
        const data = await safeResponseJson(res);
        if (seq !== seqRef.current) return;
        setPreview(res.ok ? data : null);
      } catch {
        if (seq === seqRef.current) setPreview(null);
      } finally {
        if (seq === seqRef.current) setPreviewLoading(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [open, pool, cfg, debtAmount, newDebtValid, newDebtRaw]);

  const proj = preview?.projection ?? null;
  const blockReasons = preview && !preview.allowed ? preview.reasons.filter((r) => r.severity !== 'info') : [];
  const canBorrow = newDebtValid && !!preview?.allowed && !previewLoading && !submitting;

  const handleBorrowMore = async () => {
    if (!pool || !newDebtRaw) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch(
        '/api/vault/borrow/borrow-more',
        POST_JSON({ borrowPositionId: pool.id, requestedDebtRaw: newDebtRaw, sessionId }),
      );
      const data = await safeResponseJson(res);
      if (!res.ok || !data.success) throw new Error(data.error || 'Borrow failed');
      toast({
        title: 'Borrow Complete',
        description: data.verifyWarning || 'Your USDC loan increased. Borrowed USDC is a liability you owe.',
      });
      await onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Could not borrow', description: e.message || 'Please try again', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const symbol = pool?.symbol ?? cfg?.collateralSymbol ?? 'collateral';

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-borrow-more">
        <DialogHeader>
          <DialogTitle>Borrow USDC</DialogTitle>
          <DialogDescription>Borrow USDC against your {symbol} collateral.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90">
            Borrowed USDC is a loan you owe — a liability, not a deposit. If {symbol} falls in value, your collateral can be
            liquidated.
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Borrow amount (USDC)</label>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              value={debtAmount}
              onChange={(e) => setDebtAmount(e.target.value)}
              disabled={submitting}
              data-testid="input-borrow-more-amount"
            />
            {cfg && (
              <p className="text-xs text-muted-foreground">
                Max loan-to-value {fmtPct(cfg.maxLtv)} · Borrow APR {fmtPct(cfg.borrowApr)}
              </p>
            )}
          </div>

          {newDebtValid && (
            <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2 text-sm">
              {previewLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Checking…
                </div>
              ) : proj ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Collateral value</span>
                    <span className="tabular-nums" data-testid="text-borrow-more-collateral-value">{fmtUsd(proj.collateralValueUsd)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Projected loan-to-value</span>
                    <span className="tabular-nums" data-testid="text-borrow-more-ltv">
                      {fmtPct(proj.projectedLtv)} <span className="text-muted-foreground">/ {fmtPct(proj.effectiveMaxLtv)} max</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Projected health</span>
                    <span className="tabular-nums" data-testid="text-borrow-more-health">
                      {proj.projectedHealthFactor == null || !Number.isFinite(proj.projectedHealthFactor)
                        ? '\u2014'
                        : proj.projectedHealthFactor.toFixed(2)}
                    </span>
                  </div>
                  {cfg && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Liquidation price</span>
                      <span className="tabular-nums" data-testid="text-borrow-more-liq-price">
                        {fmtUsd(cfg.oraclePriceLiquidateUsd)} <span className="text-muted-foreground">/ {symbol}</span>
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">Couldn't check this amount. You can still try — the server re-checks before borrowing.</p>
              )}
            </div>
          )}

          {blockReasons.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1">
              {blockReasons.map((r, i) => (
                <p key={i} className="text-xs text-destructive flex items-start gap-1.5" data-testid={`text-borrow-more-block-${i}`}>
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {r.message}
                </p>
              ))}
            </div>
          )}

          <Button
            className="w-full bg-teal-500 hover:bg-teal-500/90 text-background"
            onClick={handleBorrowMore}
            disabled={!canBorrow}
            data-testid="button-submit-borrow-more"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Landmark className="w-4 h-4 mr-2" />}
            {submitting ? 'Borrowing…' : 'Borrow USDC'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// WITHDRAW COLLATERAL — single-tx. Removes collateral (debt unchanged). The
// server gate caps the safe amount; "Max" defers to the server-computed maximum.
// ---------------------------------------------------------------------------
export function WithdrawCollateralDialog({
  open,
  onOpenChange,
  pool,
  cfg,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pool: LendingPool | null;
  cfg: BorrowCollateral | null;
  onSuccess: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [useMax, setUseMax] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount('');
      setUseMax(false);
      setSubmitting(false);
    }
  }, [open]);

  const decimals = pool?.collateralDecimals ?? cfg?.collateralDecimals ?? null;
  const amountRaw = useMax ? 'max' : decimals != null ? toRawBaseUnits(amount, decimals) : null;
  const valid = amountRaw === 'max' || (!!amountRaw && BigInt(amountRaw) > 0n);
  const symbol = pool?.symbol ?? cfg?.collateralSymbol ?? 'collateral';

  const handleWithdraw = async () => {
    if (!pool || !valid || !amountRaw) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch(
        '/api/vault/borrow/withdraw-collateral',
        POST_JSON({ borrowPositionId: pool.id, amountRaw, sessionId }),
      );
      const data = await safeResponseJson(res);
      if (!res.ok || !data.success) throw new Error(data.error || 'Withdraw failed');
      toast({ title: 'Collateral Withdrawn', description: data.verifyWarning || 'Your collateral was returned to your trading agent.' });
      await onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Could not withdraw', description: e.message || 'Please try again', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-withdraw-collateral">
        <DialogHeader>
          <DialogTitle>Withdraw Collateral</DialogTitle>
          <DialogDescription>Return {symbol} collateral to your trading agent.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-background/40 p-3 text-sm flex items-center justify-between">
            <span className="text-muted-foreground">Locked collateral</span>
            <span className="tabular-nums" data-testid="text-withdraw-locked">{pool?.collateralLabel ?? '\u2014'}</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Amount ({symbol})</label>
              <button
                type="button"
                className="text-xs text-teal-300 hover:text-teal-200"
                onClick={() => {
                  setUseMax(true);
                  setAmount('');
                }}
                disabled={submitting}
                data-testid="button-withdraw-max"
              >
                Max
              </button>
            </div>
            <Input
              inputMode="decimal"
              placeholder={useMax ? 'Maximum safe amount' : '0.00'}
              value={useMax ? '' : amount}
              onChange={(e) => {
                setUseMax(false);
                setAmount(e.target.value);
              }}
              disabled={submitting}
              data-testid="input-withdraw-amount"
            />
            <p className="text-xs text-muted-foreground">
              {pool?.hasLoan
                ? 'Only the amount that keeps your loan safe can be withdrawn — the server caps "Max" to a safe level.'
                : 'No loan against this collateral, so you can withdraw all of it.'}
            </p>
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleWithdraw}
            disabled={!valid || submitting}
            data-testid="button-submit-withdraw"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowUpFromLine className="w-4 h-4 mr-2" />}
            {submitting ? 'Withdrawing…' : 'Withdraw'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// REPAY LOAN — four sources. #1 (agent USDC) is single-tx. #2/#3/#4 are
// multi-hop and resumable via a client request id reused verbatim on retry, so
// a crash mid-flow resumes server-side instead of double-spending. Once funds
// have moved into the agent (#2/#4 transfer confirmed), the flow only ever
// re-POSTs the repay leg — it never re-transfers.
// ---------------------------------------------------------------------------
type RepaySource = 'agent' | 'wallet-usdc' | 'deleverage' | 'wallet-token';

const SOURCE_LABELS: Record<RepaySource, { label: string; icon: typeof Bot }> = {
  agent: { label: 'Trading Agent USDC', icon: Bot },
  'wallet-usdc': { label: 'Your Wallet USDC', icon: Wallet },
  deleverage: { label: 'Sell Collateral', icon: Layers },
  'wallet-token': { label: 'Any SPL Token', icon: Coins },
};

// ---------------------------------------------------------------------------
// Crash-proof resume state for the MULTI-STEP repay sources (#2 wallet USDC,
// #3 deleverage, #4 wallet token). The money already left the user's wallet
// once the transfer confirms, so the clientRequestId + transfer proof MUST
// survive a refresh/tab-crash — otherwise a re-run would build a SECOND
// transfer (double-spend) instead of resuming the server-side state machine
// from its last confirmed step. Persisted in localStorage, keyed per position,
// cleared on success. A short TTL guards against acting on very stale state.
// ---------------------------------------------------------------------------
type RepayResumeState = {
  source: RepaySource;
  clientRequestId: string;
  transferSignature?: string; // #2
  tokenTransferred?: boolean; // #4
  tokenMint?: string; // #4
  collateralRaw?: string; // #3 — re-sent verbatim so the server resumes the same sell
  at: number;
};
const REPAY_RESUME_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const repayResumeKey = (positionId: string) => `qv:repay-resume:${positionId}`;
function loadRepayResume(positionId: string): RepayResumeState | null {
  try {
    const raw = localStorage.getItem(repayResumeKey(positionId));
    if (!raw) return null;
    const s = JSON.parse(raw) as RepayResumeState;
    if (!s || typeof s.clientRequestId !== 'string' || typeof s.source !== 'string') return null;
    if (Date.now() - (s.at || 0) > REPAY_RESUME_TTL_MS) {
      localStorage.removeItem(repayResumeKey(positionId));
      return null;
    }
    return s;
  } catch {
    return null;
  }
}
function saveRepayResume(positionId: string, s: Omit<RepayResumeState, 'at'>) {
  try {
    localStorage.setItem(repayResumeKey(positionId), JSON.stringify({ ...s, at: Date.now() }));
  } catch {
    /* localStorage unavailable (private mode) — retry still works in-tab via refs */
  }
}
function clearRepayResume(positionId: string) {
  try {
    localStorage.removeItem(repayResumeKey(positionId));
  } catch {
    /* ignore */
  }
}

export function RepayLoanDialog({
  open,
  onOpenChange,
  pool,
  agentUsdcBalance,
  walletUsdcBalance,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pool: LendingPool | null;
  agentUsdcBalance: number | null;
  walletUsdcBalance: number | null;
  onSuccess: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();

  const [source, setSource] = useState<RepaySource>('agent');
  const [usdcAmount, setUsdcAmount] = useState('');
  const [useMaxAgent, setUseMaxAgent] = useState(false);
  const [collateralAmount, setCollateralAmount] = useState('');
  const [tokenAmount, setTokenAmount] = useState('');
  const [walletTokens, setWalletTokens] = useState<UserToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [selectedToken, setSelectedToken] = useState<UserToken | null>(null);
  const [phase, setPhase] = useState<'idle' | 'working' | 'needs_retry'>('idle');
  const [statusText, setStatusText] = useState('');

  const reqIdRef = useRef<string | null>(null);
  const transferSigRef = useRef<string | null>(null); // #2
  const tokenTransferredRef = useRef(false); // #4
  const tokenMintRef = useRef<string | null>(null); // #4 — survives resume w/o the full token row
  const collateralRawRef = useRef<string | null>(null); // #3 — re-sent verbatim on resume

  // Clear the in-memory flow. `clearPersist` also drops the crash-proof resume
  // record (only safe once the op succeeded — never mid-flight, or a refresh
  // would lose the transfer proof and re-transfer).
  const resetFlow = (clearPersist = false) => {
    if (clearPersist && pool) clearRepayResume(pool.id);
    reqIdRef.current = null;
    transferSigRef.current = null;
    tokenTransferredRef.current = false;
    tokenMintRef.current = null;
    collateralRawRef.current = null;
    setPhase('idle');
    setStatusText('');
  };

  useEffect(() => {
    if (!open) return;
    setUsdcAmount('');
    setUseMaxAgent(false);
    setCollateralAmount('');
    setTokenAmount('');
    setSelectedToken(null);
    // Default to a clean idle flow, then rehydrate a crash-proof resume if one
    // exists for this exact position (e.g. the tab was refreshed after a
    // wallet transfer confirmed but before the repay leg completed).
    reqIdRef.current = null;
    transferSigRef.current = null;
    tokenTransferredRef.current = false;
    tokenMintRef.current = null;
    collateralRawRef.current = null;
    setStatusText('');
    setPhase('idle');
    setSource('agent');
    const resume = pool ? loadRepayResume(pool.id) : null;
    if (resume) {
      setSource(resume.source);
      reqIdRef.current = resume.clientRequestId;
      if (resume.transferSignature) transferSigRef.current = resume.transferSignature;
      if (resume.collateralRaw) collateralRawRef.current = resume.collateralRaw;
      if (resume.tokenTransferred) {
        tokenTransferredRef.current = true;
        tokenMintRef.current = resume.tokenMint ?? null;
        if (resume.tokenMint) {
          // Minimal stub so the submit path has a mint; amount/balance are
          // irrelevant on resume (the repay leg swaps the already-transferred
          // balance, capped at outstanding debt).
          setSelectedToken({
            mint: resume.tokenMint,
            symbol: 'token',
            name: 'token',
            logoURI: null,
            decimals: 0,
            amountRaw: '0',
            amountUi: 0,
            usdValue: null,
            isNativeSol: false,
            isUsdc: false,
          });
        }
      }
      setPhase('needs_retry');
      setStatusText('You have an unfinished repayment — your funds are safe in your trading agent. Tap Retry to finish.');
    }
  }, [open]);

  // Load the user's wallet tokens lazily when source #4 is selected.
  useEffect(() => {
    if (!open || source !== 'wallet-token') return;
    let cancelled = false;
    (async () => {
      setTokensLoading(true);
      try {
        const res = await fetch('/api/wallet/tokens', { credentials: 'include', headers: walletAuthHeaders() });
        const data = await safeResponseJson(res);
        if (cancelled) return;
        const list: UserToken[] = (data.tokens || []).filter((t: UserToken) => !t.isUsdc && !t.isNativeSol && t.amountUi > 0);
        setWalletTokens(list);
      } catch {
        if (!cancelled) setWalletTokens([]);
      } finally {
        if (!cancelled) setTokensLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, source]);

  const switchSource = (s: RepaySource) => {
    // Block switching unless fully idle. While 'working' the op is in flight;
    // while 'needs_retry' a transfer/sell has already moved funds and switching
    // would orphan the in-memory request id + transfer proof, forcing a
    // re-transfer (double-spend) instead of resuming. No mid-flight reset is
    // safe — the user finishes via Retry (resumes) or closes and reopens to
    // resume later (the crash-proof record persists for 2h).
    if (phase !== 'idle') return;
    if (s === source) return;
    setSource(s);
    resetFlow();
  };

  const debtUi = pool?.debtAmountRaw ? rawToDecimalString(pool.debtAmountRaw, USDC_DECIMALS) : null;
  const working = phase === 'working';
  const needsRetry = phase === 'needs_retry';

  // Shared result interpreter. movedFunds=true means the user's funds already
  // reached the agent (a hard failure is then retryable, not lost).
  const handleResult = async (res: Response, data: any, movedFunds: boolean, fundsNote: string) => {
    if (res.ok && data.success) {
      toast({ title: 'Repayment Complete', description: data.verifyWarning || data.dbWarning || 'Your loan balance was reduced.' });
      await onSuccess();
      resetFlow(true); // success — safe to drop the crash-proof resume record
      onOpenChange(false);
      return;
    }
    if (res.status === 202 || data.needsAttention) {
      setPhase('needs_retry');
      setStatusText('Almost done — your funds are safe. Tap Retry to finish.');
      toast({ title: 'Finishing up', description: 'Your funds are safe. Tap Retry to complete the repayment.' });
      return;
    }
    if (movedFunds) {
      setPhase('needs_retry');
      setStatusText(fundsNote);
      toast({ title: "Repayment didn't finish", description: fundsNote, variant: 'destructive' });
    } else {
      // Hard failure with NO money moved (e.g. a deleverage whose withdraw never
      // landed). Drop the crash-proof resume record + request id so the next
      // attempt is a clean, fresh op that respects any edited amount. (The server
      // also treats a no-money withdraw_failed as restartable, so even a refresh
      // before this clear cannot wedge.)
      resetFlow(true);
      toast({ title: 'Could not repay', description: data.error || 'Please try again', variant: 'destructive' });
    }
  };

  // #1 — Trading Agent USDC (single-tx).
  const repayFromAgent = async () => {
    if (!pool) return;
    const amountRaw = useMaxAgent ? 'max' : toRawBaseUnits(usdcAmount, USDC_DECIMALS);
    if (amountRaw !== 'max' && (!amountRaw || BigInt(amountRaw) <= 0n)) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    setPhase('working');
    setStatusText('Repaying from your trading agent…');
    try {
      const sessionId = await getSessionId();
      const res = await fetch('/api/vault/borrow/repay', POST_JSON({ borrowPositionId: pool.id, amountRaw, sessionId }));
      const data = await safeResponseJson(res);
      await handleResult(res, data, false, '');
    } catch (e: any) {
      setPhase('idle');
      setStatusText('');
      toast({ title: 'Could not repay', description: e.message || 'Please try again', variant: 'destructive' });
    }
  };

  // #2 — Your Wallet USDC (user-signed transfer -> repay). Resumable.
  const repayFromWalletUsdc = async () => {
    if (!pool) return;
    // RESUME: the transfer already confirmed (this tab earlier, or a prior tab
    // before a refresh) — skip wallet/amount validation and the transfer leg
    // entirely; only re-POST the repay with the SAME request id + signature.
    const resuming = !!transferSigRef.current;
    let repayRaw: string | null = null;
    if (!resuming) {
      if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
        toast({ title: 'Wallet not connected', variant: 'destructive' });
        return;
      }
      const amount = parseFloat(usdcAmount);
      if (!amount || amount <= 0) {
        toast({ title: 'Enter a valid amount', variant: 'destructive' });
        return;
      }
      if (walletUsdcBalance != null && amount > walletUsdcBalance) {
        toast({ title: 'Insufficient wallet USDC', variant: 'destructive' });
        return;
      }
      repayRaw = toRawBaseUnits(usdcAmount, USDC_DECIMALS);
      if (!repayRaw) {
        toast({ title: 'Enter a valid amount', variant: 'destructive' });
        return;
      }
      if (!reqIdRef.current) reqIdRef.current = newRequestId();
      setPhase('working');
      try {
        const sessionId = await getSessionId();
        setStatusText('Building transfer…');
        const txRes = await fetch('/api/agent/deposit', POST_JSON({ amount }));
        if (!txRes.ok) {
          const err = await safeResponseJson(txRes);
          throw new Error(err.error || 'Could not build transfer');
        }
        const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await safeResponseJson(txRes);
        setStatusText('Approve the USDC transfer in your wallet…');
        const tx = Transaction.from(Buffer.from(serializedTx, 'base64'));
        const signed = await solanaWallet.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        // Persist the INSTANT the tx is broadcast — BEFORE awaiting confirmation.
        // Broadcast is the irreversible point; a refresh during the confirm wait
        // must resume (re-POST repay), never re-transfer. The server keys the
        // repay on the realized inbound USDC delta of this signature, so a
        // never-landed transfer simply repays nothing (no double-spend).
        transferSigRef.current = sig;
        saveRepayResume(pool.id, {
          source: 'wallet-usdc',
          clientRequestId: reqIdRef.current!,
          transferSignature: sig,
        });
        setStatusText('Confirming transfer…');
        await confirmTransactionWithFallback(connection, { signature: sig, blockhash, lastValidBlockHeight });
      } catch (e: any) {
        if (transferSigRef.current) {
          // The transfer was already broadcast (e.g. confirmation timed out).
          // Funds may be in flight; the resume record is persisted -> needs_retry,
          // NOT a reset (a reset would risk a second transfer).
          setPhase('needs_retry');
          setStatusText('Your USDC transfer was sent. Tap Retry to finish the repayment.');
          toast({ title: "Repayment didn't finish", description: 'Your USDC transfer was sent. Tap Retry to complete it.', variant: 'destructive' });
        } else {
          // Build/sign failed before broadcast -> nothing moved -> safe to reset.
          setPhase('idle');
          setStatusText('');
          toast({ title: 'Could not repay', description: e.message || 'Please try again', variant: 'destructive' });
        }
        return;
      }
    }
    // REPAY LEG (first run after transfer, or a resume/retry).
    setPhase('working');
    try {
      const sessionId = await getSessionId();
      setStatusText('Repaying your loan…');
      const res = await fetch(
        '/api/vault/borrow/repay/wallet-usdc',
        POST_JSON({
          borrowPositionId: pool.id,
          clientRequestId: reqIdRef.current,
          transferSignature: transferSigRef.current,
          // Optional cap; omitted on resume (the server caps at the realized
          // inbound USDC delta and outstanding debt either way).
          ...(repayRaw ? { requestedRepayRaw: repayRaw } : {}),
          sessionId,
        }),
      );
      const data = await safeResponseJson(res);
      await handleResult(res, data, true, "Your USDC reached your trading agent but the repay didn't finish. Tap Retry to complete it.");
    } catch (e: any) {
      setPhase('needs_retry');
      setStatusText('Your USDC reached your trading agent. Tap Retry to finish the repayment.');
      toast({ title: "Repayment didn't finish", description: e.message || 'Tap Retry to complete it.', variant: 'destructive' });
    }
  };

  // #3 — Sell deposited collateral (server-side deleverage). Resumable.
  // No user transfer leg (the agent sells its OWN collateral), but the sell can
  // partially complete, so retries MUST reuse the same request id + collateral
  // amount or a re-run could double-sell. Both persist for crash-proof resume.
  const repayFromDeleverage = async () => {
    if (!pool) return;
    // RESUME: re-send the persisted request id + collateral amount verbatim.
    let collateralRaw = collateralRawRef.current;
    if (!collateralRaw) {
      const decimals = pool.collateralDecimals;
      if (decimals == null) {
        toast({ title: 'Collateral details unavailable', variant: 'destructive' });
        return;
      }
      collateralRaw = toRawBaseUnits(collateralAmount, decimals);
      if (!collateralRaw || BigInt(collateralRaw) <= 0n) {
        toast({ title: 'Enter a valid amount', variant: 'destructive' });
        return;
      }
      collateralRawRef.current = collateralRaw;
    }
    if (!reqIdRef.current) reqIdRef.current = newRequestId();
    // Persist BEFORE the sell so a crash mid-sell resumes the same request.
    saveRepayResume(pool.id, {
      source: 'deleverage',
      clientRequestId: reqIdRef.current,
      collateralRaw,
    });
    setPhase('working');
    setStatusText('Selling collateral and repaying…');
    try {
      const sessionId = await getSessionId();
      const res = await fetch(
        '/api/vault/borrow/repay/deleverage',
        POST_JSON({ borrowPositionId: pool.id, clientRequestId: reqIdRef.current, collateralRaw, sessionId }),
      );
      const data = await safeResponseJson(res);
      await handleResult(res, data, false, '');
    } catch (e: any) {
      setPhase('needs_retry');
      setStatusText('The deleverage may be mid-flight. Tap Retry to finish safely.');
      toast({ title: "Repayment didn't finish", description: e.message || 'Tap Retry to finish.', variant: 'destructive' });
    }
  };

  // #4 — Any wallet token (user-signed transfer -> swap -> repay). Resumable.
  const repayFromWalletToken = async () => {
    if (!pool) return;
    // RESUME: the token already reached the agent — skip selection/amount
    // validation and the transfer leg; only re-POST swap+repay with the SAME
    // request id + mint. The mint comes from the ref (survives refresh).
    const resuming = tokenTransferredRef.current;
    const mint = resuming ? tokenMintRef.current ?? selectedToken?.mint ?? null : selectedToken?.mint ?? null;
    const symbol = selectedToken?.symbol ?? 'token';
    if (!resuming) {
      if (!selectedToken) {
        toast({ title: 'Select a token', variant: 'destructive' });
        return;
      }
      if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
        toast({ title: 'Wallet not connected', variant: 'destructive' });
        return;
      }
      const amt = parseFloat(tokenAmount);
      if (!amt || amt <= 0) {
        toast({ title: 'Enter a valid amount', variant: 'destructive' });
        return;
      }
      if (amt > selectedToken.amountUi) {
        toast({ title: `Insufficient ${selectedToken.symbol}`, variant: 'destructive' });
        return;
      }
      const amountRaw = toRawBaseUnits(tokenAmount, selectedToken.decimals);
      if (!amountRaw || BigInt(amountRaw) <= 0n) {
        toast({ title: 'Amount too small', variant: 'destructive' });
        return;
      }
      if (!reqIdRef.current) reqIdRef.current = newRequestId();
      setPhase('working');
      try {
        const sessionId = await getSessionId();
        setStatusText(`Building ${selectedToken.symbol} transfer…`);
        const txRes = await fetch('/api/agent/deposit-token', POST_JSON({ mint: selectedToken.mint, amountRaw }));
        if (!txRes.ok) {
          const err = await safeResponseJson(txRes);
          throw new Error(err.error || 'Could not build transfer');
        }
        const { transaction: serializedTx, blockhash, lastValidBlockHeight } = await safeResponseJson(txRes);
        setStatusText(`Approve the ${selectedToken.symbol} transfer in your wallet…`);
        const tx = Transaction.from(Buffer.from(serializedTx, 'base64'));
        const signed = await solanaWallet.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        // Persist the INSTANT the tx is broadcast — BEFORE awaiting confirmation.
        // Broadcast is the irreversible point; a refresh during the confirm wait
        // must resume (re-POST swap+repay), never re-transfer.
        tokenTransferredRef.current = true;
        tokenMintRef.current = selectedToken.mint;
        saveRepayResume(pool.id, {
          source: 'wallet-token',
          clientRequestId: reqIdRef.current!,
          tokenTransferred: true,
          tokenMint: selectedToken.mint,
        });
        setStatusText('Confirming transfer…');
        await confirmTransactionWithFallback(connection, { signature: sig, blockhash, lastValidBlockHeight });
      } catch (e: any) {
        if (tokenTransferredRef.current) {
          // The transfer was already broadcast (e.g. confirmation timed out).
          // Funds may be in flight; the resume record is persisted -> needs_retry,
          // NOT a reset (a reset would risk a second transfer).
          setPhase('needs_retry');
          setStatusText('Your token was sent. Tap Retry to finish the swap & repay.');
          toast({ title: "Repayment didn't finish", description: 'Your token was sent. Tap Retry to complete it.', variant: 'destructive' });
        } else {
          // Build/sign failed before broadcast -> nothing moved -> safe to reset.
          setPhase('idle');
          setStatusText('');
          toast({ title: 'Could not repay', description: e.message || 'Please try again', variant: 'destructive' });
        }
        return;
      }
    }
    if (!mint) {
      toast({ title: 'Token unavailable', description: 'Could not resolve the token to swap. Please reopen and try again.', variant: 'destructive' });
      return;
    }
    // SWAP + REPAY LEG (first run after transfer, or a resume/retry).
    setPhase('working');
    try {
      const sessionId = await getSessionId();
      setStatusText(`Swapping ${symbol} → USDC and repaying…`);
      const res = await fetch(
        '/api/vault/borrow/repay/wallet-token',
        POST_JSON({ borrowPositionId: pool.id, clientRequestId: reqIdRef.current, tokenMint: mint, sessionId }),
      );
      const data = await safeResponseJson(res);
      await handleResult(res, data, true, `Your ${symbol} reached your trading agent. Tap Retry to finish the swap & repay.`);
    } catch (e: any) {
      setPhase('needs_retry');
      setStatusText('Your token reached your trading agent. Tap Retry to finish.');
      toast({ title: "Repayment didn't finish", description: e.message || 'Tap Retry to finish.', variant: 'destructive' });
    }
  };

  const submit = () => {
    if (source === 'agent') return repayFromAgent();
    if (source === 'wallet-usdc') return repayFromWalletUsdc();
    if (source === 'deleverage') return repayFromDeleverage();
    return repayFromWalletToken();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !working && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-repay-loan">
        <DialogHeader>
          <DialogTitle>Repay Loan</DialogTitle>
          <DialogDescription>
            You owe <span className="font-medium text-foreground tabular-nums" data-testid="text-repay-outstanding">{fmtUsd(pool?.debtUsd ?? null)}</span>. Choose where to repay from.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(SOURCE_LABELS) as RepaySource[]).map((s) => {
              const Icon = SOURCE_LABELS[s].icon;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => switchSource(s)}
                  disabled={working || needsRetry}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 ${
                    source === s ? 'border-teal-500 bg-teal-500/10 text-teal-200' : 'border-border'
                  }`}
                  data-testid={`button-repay-source-${s}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{SOURCE_LABELS[s].label}</span>
                </button>
              );
            })}
          </div>

          {/* #1 Agent USDC */}
          {source === 'agent' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Amount (USDC)</label>
                <button
                  type="button"
                  className="text-xs text-teal-300 hover:text-teal-200"
                  onClick={() => {
                    setUseMaxAgent(true);
                    setUsdcAmount('');
                  }}
                  disabled={working}
                  data-testid="button-repay-agent-max"
                >
                  Max (clear all)
                </button>
              </div>
              <Input
                inputMode="decimal"
                placeholder={useMaxAgent ? 'All outstanding debt' : '0.00'}
                value={useMaxAgent ? '' : usdcAmount}
                onChange={(e) => {
                  setUseMaxAgent(false);
                  setUsdcAmount(e.target.value);
                }}
                disabled={working}
                data-testid="input-repay-agent-amount"
              />
              <p className="text-xs text-muted-foreground">In trading agent: {fmtUsd(agentUsdcBalance)}</p>
            </div>
          )}

          {/* #2 Wallet USDC */}
          {source === 'wallet-usdc' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Amount (USDC)</label>
                <button
                  type="button"
                  className="text-xs text-teal-300 hover:text-teal-200"
                  onClick={() => debtUi && setUsdcAmount(debtUi)}
                  disabled={working || !debtUi}
                  data-testid="button-repay-wallet-usdc-max"
                >
                  Pay off ({fmtUsd(pool?.debtUsd ?? null)})
                </button>
              </div>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={usdcAmount}
                onChange={(e) => setUsdcAmount(e.target.value)}
                disabled={working || needsRetry}
                data-testid="input-repay-wallet-usdc-amount"
              />
              <p className="text-xs text-muted-foreground">In your wallet: {fmtUsd(walletUsdcBalance)} · you'll approve a transfer to your trading agent first.</p>
            </div>
          )}

          {/* #3 Deleverage */}
          {source === 'deleverage' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Collateral to sell ({pool?.symbol ?? 'collateral'})</label>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={collateralAmount}
                onChange={(e) => setCollateralAmount(e.target.value)}
                disabled={working || needsRetry}
                data-testid="input-repay-deleverage-amount"
              />
              <p className="text-xs text-muted-foreground">
                Locked: {pool?.collateralLabel ?? '\u2014'} · we sell this collateral for USDC and repay your loan.
              </p>
            </div>
          )}

          {/* #4 Any wallet token */}
          {source === 'wallet-token' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Token</label>
                {tokensLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading your tokens…
                  </div>
                ) : walletTokens.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No eligible tokens in your wallet.</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                    {walletTokens.map((t) => (
                      <button
                        key={t.mint}
                        type="button"
                        onClick={() => {
                          setSelectedToken(t);
                          setTokenAmount('');
                        }}
                        disabled={working || needsRetry}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                          selectedToken?.mint === t.mint ? 'bg-teal-500/10' : ''
                        }`}
                        data-testid={`button-repay-token-${t.symbol}`}
                      >
                        {t.logoURI ? (
                          <img src={t.logoURI} alt={t.symbol} className="w-6 h-6 rounded-full" />
                        ) : (
                          <span className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px]">{t.symbol.slice(0, 2)}</span>
                        )}
                        <span className="flex-1 text-sm font-medium truncate">{t.symbol}</span>
                        <span className="text-xs font-mono text-muted-foreground">{t.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {selectedToken && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Amount ({selectedToken.symbol})</label>
                    <button
                      type="button"
                      className="text-xs text-teal-300 hover:text-teal-200"
                      onClick={() => setTokenAmount(rawToDecimalString(selectedToken.amountRaw, selectedToken.decimals))}
                      disabled={working || needsRetry}
                      data-testid="button-repay-token-max"
                    >
                      Max
                    </button>
                  </div>
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={tokenAmount}
                    onChange={(e) => setTokenAmount(e.target.value)}
                    disabled={working || needsRetry}
                    data-testid="input-repay-token-amount"
                  />
                  <p className="text-xs text-muted-foreground">We swap this token to USDC and repay your loan.</p>
                </div>
              )}
            </div>
          )}

          {(working || needsRetry) && statusText && (
            <div
              className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${
                needsRetry ? 'border-amber-500/40 bg-amber-500/5 text-amber-200' : 'border-border bg-background/40 text-muted-foreground'
              }`}
              data-testid="text-repay-status"
            >
              {working ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              {statusText}
            </div>
          )}

          <Button
            className="w-full bg-teal-500 hover:bg-teal-500/90 text-background"
            onClick={submit}
            disabled={working}
            data-testid="button-submit-repay"
          >
            {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
            {working ? 'Working…' : needsRetry ? 'Retry' : 'Repay'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
