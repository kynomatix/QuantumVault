import { useState, useEffect, useRef, useMemo } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  Loader2,
  Landmark,
  RotateCcw,
  ArrowUpFromLine,
  ArrowLeftRight,
  Wallet,
  Bot,
  Coins,
  Layers,
  AlertTriangle,
  Lock,
  RefreshCw,
  Fuel,
  Info,
  PiggyBank,
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
  healthBarColor,
  RECOMMENDED_MAX_LTV,
  safeLtvMarkerPct,
  type BorrowCollateral,
  type BorrowPreviewResult,
  type LendingPool,
  type UserToken,
} from '@/lib/lending-format';
import { useWallet } from '@/hooks/useWallet';
import { isSessionError, showReconnectToast } from '@/lib/reconnect-toast';
import { SolGasShortfallDialog } from '@/components/SolGasShortfallDialog';

const USDC_DECIMALS = 6;
// RECOMMENDED_MAX_LTV (the safe borrow level) + safeLtvMarkerPct now live in
// '@/lib/lending-format' so this dialog and the live Wallet page agree on the
// exact safe threshold and where to mark it on the protocol-framed usage bar.
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
  const { retryAuth } = useWallet();
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
  // Set when the supply failed purely on SOL gas — drives the inline top-up
  // popup, with retry rerunning the (already-transferred) lock step.
  const [gasShortfall, setGasShortfall] = useState<{
    requiredSol: number;
    heldSol: number;
    retry: () => Promise<void>;
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
        // SOL-gas-only failure: the asset is already locked-ready in the agent,
        // so offer an inline top-up of just the shortfall, then retry the lock.
        const gs = data.gasShortfall;
        if (gs && Number.isFinite(gs.requiredLamports) && Number.isFinite(gs.heldLamports)) {
          setGasShortfall({
            requiredSol: gs.requiredLamports / 1e9,
            heldSol: gs.heldLamports / 1e9,
            retry: () => runSupply(cfg, raw, symbol, amountStr),
          });
          return;
        }
        if (isSessionError(data.error)) {
          showReconnectToast({
            toast,
            retryAuth,
            title: 'Collateral Not Locked',
            retry: () => runSupply(cfg, raw, symbol, amountStr),
          });
        } else {
          toast({
            title: 'Collateral Not Locked',
            description:
              data.error || `Your ${symbol} is safe in your trading agent — tap "Retry" to lock it as collateral.`,
            variant: 'destructive',
          });
        }
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
      if (isSessionError(e)) {
        showReconnectToast({
          toast,
          retryAuth,
          title: 'Collateral Not Locked',
          retry: () => runSupply(cfg, raw, symbol, amountStr),
        });
      } else {
        toast({ title: 'Collateral Not Locked', description: e.message || 'Please try again', variant: 'destructive' });
      }
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
      // FAILSAFE — verify the session is LIVE before any money moves. Step 1 below
      // transfers the asset into the trading agent; if the session were already
      // stale, the lock (Step 2) would fail and strand the asset there. getSessionId()
      // hits the server and fails closed on a stale/missing session, so we catch it
      // HERE — before the transfer — and route to the reconnect toast. On retry this
      // pre-flight runs again, so no transfer happens until the session is valid.
      setStatusText('Checking your session…');
      await getSessionId();

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
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: 'Could not supply collateral', retry: () => handleSupply() });
      } else {
        toast({ title: 'Could not supply collateral', description: e.message || 'Please try again', variant: 'destructive' });
      }
    } finally {
      setSubmitting(false);
      setStatusText('');
    }
  };

  return (
    <>
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
    {gasShortfall && (
      <SolGasShortfallDialog
        open={!!gasShortfall}
        onOpenChange={(o) => { if (!o) setGasShortfall(null); }}
        requiredSol={gasShortfall.requiredSol}
        heldSol={gasShortfall.heldSol}
        reason="to lock your collateral"
        onDeposited={async () => {
          const retry = gasShortfall.retry;
          setGasShortfall(null);
          await retry();
        }}
      />
    )}
    </>
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
  const { retryAuth } = useWallet();
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
  // Split strictly by severity. DENY reasons gate the borrow (red callout); WARN
  // reasons never gate (amber callout) — they encourage caution but the borrow is
  // still allowed. Filtering by severity (not by `allowed`) ensures a warning can
  // never land in the red "blocked" box even when a separate deny is also present.
  const blockReasons = preview ? preview.reasons.filter((r) => r.severity === 'deny') : [];
  const warnReasons = preview ? preview.reasons.filter((r) => r.severity === 'warn') : [];
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
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: 'Could not borrow', retry: () => handleBorrowMore() });
      } else {
        toast({ title: 'Could not borrow', description: e.message || 'Please try again', variant: 'destructive' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const symbol = pool?.symbol ?? cfg?.collateralSymbol ?? 'collateral';

  // Truthful borrow-capacity math. "Available to borrow" and the one-tap Max
  // both target the RECOMMENDED safe LTV (not the protocol's higher max), so Max
  // stays safe and never overstates capacity. A user can still type a larger
  // amount — up to the protocol max — and the server risk gate (which re-checks
  // every borrow and is authoritative) will allow it with a warning. This is a
  // conservative DISPLAY estimate (LTV headroom only). null inputs render as
  // em-dash. (The usage bar below intentionally uses the PROTOCOL max as its
  // frame so its health color is honest — see the next block.)
  const protocolMaxLtv = cfg?.maxLtv ?? pool?.maxLtv ?? null;
  const effMaxLtv = protocolMaxLtv == null ? null : Math.min(RECOMMENDED_MAX_LTV, protocolMaxLtv);
  const collateralValueUsd = pool?.collateralUsd ?? proj?.collateralValueUsd ?? null;
  // A supplied-but-unborrowed pool has zero debt; only a still-loading on-chain
  // read is genuinely unknown (null → fail closed to em-dash, never fabricate).
  const currentDebtUsd = pool?.debtUsd ?? (pool && pool.hasLoan === false ? 0 : null);
  const borrowLimitUsd =
    collateralValueUsd != null && effMaxLtv != null ? collateralValueUsd * effMaxLtv : null;
  const availableToBorrowUsd =
    borrowLimitUsd != null && currentDebtUsd != null ? Math.max(0, borrowLimitUsd - currentDebtUsd) : null;

  // PROJECTED health bar. The usage bar is measured against the PROTOCOL max
  // borrow limit (collateral * protocol max LTV), NOT the recommended safe limit
  // — that is the only frame in which the bar's COLOR honestly encodes risk (a
  // full bar = at the protocol borrow ceiling = highest risk / closest to
  // liquidation). It mirrors the pool-row health bar's frame so both surfaces
  // read identically, and it matches the "/ {max} max" figure in the projection
  // section below. As the user types an amount the bar PROJECTS where this pool
  // will land (current debt + entered USDC, treated 1:1 with USD); an empty/
  // invalid field falls back to the CURRENT debt. null inputs render as em-dash /
  // 0-width.
  const protocolBorrowLimitUsd =
    collateralValueUsd != null && protocolMaxLtv != null ? collateralValueUsd * protocolMaxLtv : null;
  // Parse exactly as toRawBaseUnits validates (plain decimal, no grouping
  // separators), so the bar never projects an amount that cannot be submitted: a
  // "1,000" entry stays invalid here and falls back to the current debt, matching
  // the disabled submit/preview.
  const enteredDebtUsd = (() => {
    const p = Number(debtAmount);
    return Number.isFinite(p) && p > 0 ? p : 0;
  })();
  const projectedDebtUsd = currentDebtUsd != null ? currentDebtUsd + enteredDebtUsd : null;
  const healthUsagePct =
    protocolBorrowLimitUsd != null && protocolBorrowLimitUsd > 0 && projectedDebtUsd != null
      ? Math.min(100, Math.max(0, (projectedDebtUsd / protocolBorrowLimitUsd) * 100))
      : 0;
  // Where the SAFE limit (recommended LTV) sits on this PROTOCOL-framed bar. null
  // when the whole bar is already within the safe zone (protocol max <= safe).
  const safeMarkerPct = safeLtvMarkerPct(protocolMaxLtv);

  const setMaxBorrow = () => {
    if (availableToBorrowUsd == null || !(availableToBorrowUsd > 0)) return;
    // Floor to the debt's decimals so Max can never round UP past the cap.
    const factor = 10 ** debtDecimals;
    const floored = Math.floor(availableToBorrowUsd * factor) / factor;
    if (!(floored > 0)) {
      setDebtAmount('');
      return;
    }
    let s = floored.toFixed(debtDecimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    setDebtAmount(s);
  };

  const maxDisabled = submitting || availableToBorrowUsd == null || !(availableToBorrowUsd > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-borrow-more">
        <DialogHeader>
          <DialogTitle>Borrow against {symbol}</DialogTitle>
          <DialogDescription>
            Borrow USDC against your {symbol} — it stays supplied as collateral the whole time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Liability callout — borrowing is a debt, never framed as income. */}
          <div className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/10 p-3">
            <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Borrowed USDC is a <span className="text-accent font-medium">liability you owe</span>, not a deposit. Your{' '}
              {symbol} stays locked while the loan is open and can be liquidated if it falls in value.
            </p>
          </div>

          {/* Amount + Max (capped at your real borrow headroom). */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Amount</span>
              <span data-testid="text-borrow-more-available">Available to borrow {fmtUsd(availableToBorrowUsd)}</span>
            </div>
            <div className="relative">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={debtAmount}
                onChange={(e) => setDebtAmount(e.target.value)}
                disabled={submitting}
                className="h-12 pr-24 text-lg font-medium"
                data-testid="input-borrow-more-amount"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">USDC</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-xs"
                  onClick={setMaxBorrow}
                  disabled={maxDisabled}
                  data-testid="button-borrow-more-max"
                >
                  Max
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1">
              <Info className="w-3 h-3 mt-0.5 shrink-0" />
              <span>Max targets a safe {Math.round(RECOMMENDED_MAX_LTV * 100)}% of your {symbol} value. You can borrow more — up to the protocol's limit — but it raises liquidation risk.</span>
            </p>
          </div>

          {/* This pool's borrow usage, against the protocol/liquidation limit so
              the bar's COLOR reads as health. As the user types it PROJECTS where
              the pool will land; an empty field shows the CURRENT usage. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{enteredDebtUsd > 0 ? `Borrow used on ${symbol} after this` : `Borrow used on ${symbol}`}</span>
              <span className="tabular-nums" data-testid="text-borrow-more-usage">
                {fmtUsd(projectedDebtUsd)} / {fmtUsd(protocolBorrowLimitUsd)} protocol limit
              </span>
            </div>
            <div className="relative">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full transition-all duration-200" style={{ width: `${healthUsagePct}%`, backgroundColor: healthBarColor(healthUsagePct) }} />
              </div>
              {/* Safe-limit marker. The bar is framed to the PROTOCOL max LTV, so the
                  safe 50%-LTV point is NOT the midpoint — it sits at safeMarkerPct%. */}
              {safeMarkerPct != null && (
                <div
                  className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
                  style={{ left: `${safeMarkerPct}%` }}
                  title={`Safe limit (${Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)`}
                  data-testid="marker-safe-limit-borrow-more"
                />
              )}
            </div>
            {safeMarkerPct != null && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground" data-testid="legend-safe-limit-borrow-more">
                <span className="inline-block h-2.5 w-px bg-foreground/70 shrink-0" />
                <span>Safe limit ({Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV) — borrowing past it raises liquidation risk</span>
              </div>
            )}
          </div>

          {/* Pool facts. */}
          <div className="rounded-lg border border-border bg-background/40 p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Collateral value</span>
              <span className="tabular-nums" data-testid="text-borrow-more-collateral-value">{fmtUsd(collateralValueUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Max loan-to-value</span>
              <span className="tabular-nums" data-testid="text-borrow-more-maxltv">{fmtPct(effMaxLtv)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Borrow APR</span>
              <span className="tabular-nums" data-testid="text-borrow-more-apr">{fmtPct(cfg?.borrowApr ?? null)}</span>
            </div>
          </div>

          {/* Live projection (when an amount is entered) — money-safety detail kept
              from the original dialog so the user sees the POST-borrow LTV, health
              and liquidation price before they commit. */}
          {newDebtValid && (
            <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2 text-sm">
              {previewLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Checking…
                </div>
              ) : proj ? (
                <>
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

          {warnReasons.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1" data-testid="callout-borrow-more-warnings">
              {warnReasons.map((r, i) => (
                <p key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5" data-testid={`text-borrow-more-warn-${i}`}>
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {r.message}
                </p>
              ))}
            </div>
          )}

          {/* Network-fee note (same copy as the other lending dialogs). */}
          <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
            <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
            <span>You'll need a little SOL in your wallet for the network fee (~0.005 SOL).</span>
          </div>

          <Button
            className="w-full h-11 bg-gradient-to-r from-accent to-primary text-white hover:opacity-90"
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
  const { retryAuth } = useWallet();
  const [amount, setAmount] = useState('');
  const [useMax, setUseMax] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Crash-safe idempotency key: reused verbatim across retries so a crash between
  // the on-chain withdraw and the delivery to the user's wallet resumes delivery
  // instead of re-withdrawing. Cleared on a fully delivered success / dialog open.
  const reqIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount('');
      setUseMax(false);
      setSubmitting(false);
      reqIdRef.current = null;
    }
  }, [open]);

  const decimals = pool?.collateralDecimals ?? cfg?.collateralDecimals ?? null;
  const fullCollateralDisplay =
    pool?.collateralAmountRaw && decimals != null
      ? rawToDecimalString(pool.collateralAmountRaw, decimals)
      : null;
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
      // Reuse the SAME request id across retries (resume, never re-withdraw).
      if (!reqIdRef.current) reqIdRef.current = newRequestId();
      const res = await fetch(
        '/api/vault/borrow/withdraw-collateral',
        POST_JSON({ borrowPositionId: pool.id, amountRaw, clientRequestId: reqIdRef.current, sessionId }),
      );
      const data = await safeResponseJson(res);

      // A resumable outcome (withdraw still settling / unconfirmed) comes back as a
      // 400 with requiresRetry. This is NOT a dead error: KEEP the dialog open and
      // the SAME reqId so the next tap resumes (never a second withdraw). Funds are
      // safe meanwhile. Check this BEFORE the hard-failure throw below.
      if (data.requiresRetry) {
        toast({
          title: 'Almost there',
          description: data.error || data.verifyWarning || 'Your withdrawal is still confirming. Your funds are safe — tap Withdraw again in a moment.',
        });
        await onSuccess();
        return;
      }

      if (!res.ok || !data.success) throw new Error(data.error || 'Withdraw failed');

      // Withdraw landed but the on-send to the wallet did not finish: keep the
      // dialog OPEN and let the user tap Withdraw again (same id finishes
      // delivery, never a second withdraw). Funds are SAFE in the agent meanwhile.
      if (data.deliveryStatus === 'pending') {
        toast({
          title: 'Almost there',
          description: data.verifyWarning || 'Your collateral was withdrawn safely. Tap Withdraw again to finish sending it to your wallet.',
        });
        await onSuccess();
        return;
      }

      reqIdRef.current = null;
      toast({
        title: 'Sent to Your Wallet',
        description:
          data.deliveryStatus === 'agent'
            ? (data.verifyWarning || 'Your collateral was withdrawn to your trading agent.')
            : (data.verifyWarning || 'Your collateral was sent to your wallet.'),
      });
      await onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: 'Could not withdraw', retry: () => handleWithdraw() });
      } else {
        toast({ title: 'Could not withdraw', description: e.message || 'Please try again', variant: 'destructive' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-withdraw-collateral">
        <DialogHeader>
          <DialogTitle>Withdraw Collateral</DialogTitle>
          <DialogDescription>Send {symbol} collateral back to your wallet.</DialogDescription>
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
                  // No loan -> we know the exact full collateral, so SHOW it in
                  // the field (still sent as the "max" full-sweep sentinel). With
                  // a loan, the safe max is server-computed; leave the hint text.
                  setAmount(!pool?.hasLoan && fullCollateralDisplay ? fullCollateralDisplay : '');
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
              value={amount}
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
            {submitting ? 'Withdrawing…' : 'Withdraw to Wallet'}
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
type RepaySource = 'agent' | 'wallet-usdc' | 'deleverage' | 'wallet-token' | 'vault-savings';
type RepayMode = 'usdc' | 'asset';

// Each repay source belongs to a "mode" = what you pay WITH: USDC you already
// hold, or an asset that's converted to USDC. This two-level grouping is the
// owner-approved canvas structure (RepayDialog) — it de-confuses the old flat
// 4-way picker WITHOUT dropping any money path (all four sources stay, each with
// its crash-proof resume logic intact).
const REPAY_SOURCES_BY_MODE: Record<RepayMode, RepaySource[]> = {
  usdc: ['agent', 'wallet-usdc'],
  asset: ['deleverage', 'wallet-token', 'vault-savings'],
};
const modeForSource = (s: RepaySource): RepayMode =>
  s === 'agent' || s === 'wallet-usdc' ? 'usdc' : 'asset';

const SOURCE_LABELS: Record<RepaySource, { label: string; sub: string; icon: typeof Bot }> = {
  agent: { label: 'From Trading Agent', sub: 'Pay with your trading USDC', icon: Bot },
  'wallet-usdc': { label: 'From Your Wallet', sub: 'Pay with wallet USDC', icon: Wallet },
  deleverage: { label: 'Supplied collateral', sub: 'Sell some of your locked collateral', icon: Coins },
  'wallet-token': { label: 'Your Wallet', sub: 'Swap a wallet token to USDC', icon: Wallet },
  'vault-savings': { label: 'From Vault Savings', sub: 'Unpark your Earn savings to repay', icon: PiggyBank },
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

// A small cushion so a "Max" repay reliably CLEARS the debt despite swap
// slippage + price drift. Over-shooting is money-safe: the server caps every
// repay at the true on-chain debt, and any leftover USDC stays as recoverable
// trading-wallet USDC (deleverage) / agent USDC (wallet token) — never lost.
const REPAY_MAX_BUFFER = 0.02;

// Given the USD debt, a per-unit USD price, and the user's balance, return the
// token amount whose USDC value clears the debt (+buffer), capped at the
// balance, plus whether it fully clears. Returns null when the price/debt are
// unknown so the caller falls back to a full-balance Max. Purely a CLIENT-side
// estimate — the server stays the money authority (caps the repay at true debt).
function debtClearingFill(
  debtUsd: number | null,
  priceUsd: number | null,
  balanceUi: number,
  decimals: number,
  balanceRaw: string,
): { fillStr: string; clears: boolean } | null {
  if (debtUsd == null || !(debtUsd > 0) || priceUsd == null || !(priceUsd > 0)) return null;
  const exactNeeded = debtUsd / priceUsd;
  if (balanceUi < exactNeeded) {
    // Balance can't cover the full debt → use the whole balance (partial
    // paydown). Use the exact raw balance so it never rounds above the holding.
    return { fillStr: rawToDecimalString(balanceRaw, decimals), clears: false };
  }
  const withBuffer = exactNeeded * (1 + REPAY_MAX_BUFFER);
  if (withBuffer >= balanceUi) {
    // The cushion would exceed the balance → use the exact full balance.
    return { fillStr: rawToDecimalString(balanceRaw, decimals), clears: true };
  }
  // Convert to raw units by FLOORing (never round UP past the balance — the
  // submit validation rejects amount > balance) and defensively cap at the raw
  // balance in case float precision inflates the product. Flooring drops < 1
  // base unit, far less than the 2% cushion, so it still clears the debt.
  const balRaw = BigInt(balanceRaw);
  let fillRaw = BigInt(Math.floor(withBuffer * 10 ** decimals));
  if (fillRaw > balRaw) fillRaw = balRaw;
  if (fillRaw <= 0n) return { fillStr: rawToDecimalString(balanceRaw, decimals), clears: true };
  return { fillStr: rawToDecimalString(fillRaw.toString(), decimals), clears: true };
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
  const { retryAuth } = useWallet();
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();

  const [source, setSource] = useState<RepaySource>('agent');
  const [mode, setMode] = useState<RepayMode>('usdc');
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
    setMode('usdc');
    const resume = pool ? loadRepayResume(pool.id) : null;
    if (resume) {
      setSource(resume.source);
      setMode(modeForSource(resume.source));
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

  // Switching the pay-with MODE selects that mode's first source. Same
  // money-safety gate as switchSource: blocked unless fully idle, because
  // changing the source mid-flight would orphan the in-flight request id +
  // transfer proof (double-spend risk) instead of resuming via Retry.
  const switchMode = (m: RepayMode) => {
    if (phase !== 'idle') return;
    if (m === mode) return;
    setMode(m);
    setSource(REPAY_SOURCES_BY_MODE[m][0]);
    resetFlow();
  };

  const debtUi = pool?.debtAmountRaw ? rawToDecimalString(pool.debtAmountRaw, USDC_DECIMALS) : null;
  const debtUsd = pool?.debtUsd ?? null;

  // One clean numeric view of the outstanding debt (USD value ≈ USDC owed), used
  // by both "Max" fills below so they show whole cents instead of the raw 6-dp
  // on-chain figure (which accrues interest and looks confusing, e.g. 4.068061).
  // The agent path still sends the 'max' sentinel (server clears the EXACT
  // on-chain debt), so the rounded display never under/over-pays there.
  const debtNum =
    debtUsd != null && Number.isFinite(debtUsd)
      ? debtUsd
      : debtUi != null
      ? Number(debtUi)
      : null;

  // "Max" estimate for the supplied-collateral (deleverage) source: how much of
  // the one locked collateral to sell to clear the debt. CLIENT estimate only —
  // the server LTV-gates the withdraw and caps the repay at true debt.
  const collateralUi =
    pool?.collateralAmountRaw && pool?.collateralDecimals != null
      ? Number(pool.collateralAmountRaw) / 10 ** pool.collateralDecimals
      : null;
  const collateralPriceUsd =
    pool?.collateralUsd != null && collateralUi != null && collateralUi > 0
      ? pool.collateralUsd / collateralUi
      : null;
  const deleverageMax =
    pool?.collateralAmountRaw != null && pool?.collateralDecimals != null && collateralUi != null
      ? debtClearingFill(debtUsd, collateralPriceUsd, collateralUi, pool.collateralDecimals, pool.collateralAmountRaw)
      : null;

  // "Max" estimate for the wallet-token (deposit any asset) source: how much of
  // the SELECTED token to send so its USDC swap value clears the debt.
  const tokenPriceUsd =
    selectedToken && selectedToken.usdValue != null && selectedToken.amountUi > 0
      ? selectedToken.usdValue / selectedToken.amountUi
      : null;
  const walletTokenMax = selectedToken
    ? debtClearingFill(debtUsd, tokenPriceUsd, selectedToken.amountUi, selectedToken.decimals, selectedToken.amountRaw)
    : null;

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
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: 'Could not repay', retry: () => repayFromAgent() });
      } else {
        toast({ title: 'Could not repay', description: e.message || 'Please try again', variant: 'destructive' });
      }
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

  // #5 — From parked Vault savings (Earn). ONE-TAP: the server reads the on-chain
  // balance itself, unparks JUST ENOUGH of the largest holding to USDC, then
  // repays (capped at debt). No amount input. Resumable via the persisted request
  // id — the server is the resume authority (recorded unpark proceeds), so a crash
  // mid-flow re-POSTs the SAME id and never double-unparks.
  const repayFromVaultSavings = async () => {
    if (!pool) return;
    if (!reqIdRef.current) reqIdRef.current = newRequestId();
    // Persist BEFORE acting so a crash mid-flow resumes the same request id.
    saveRepayResume(pool.id, {
      source: 'vault-savings',
      clientRequestId: reqIdRef.current,
    });
    setPhase('working');
    setStatusText('Unparking your savings and repaying…');
    try {
      const sessionId = await getSessionId();
      const res = await fetch(
        '/api/vault/borrow/repay/vault-savings',
        POST_JSON({ borrowPositionId: pool.id, clientRequestId: reqIdRef.current, sessionId }),
      );
      const data = await safeResponseJson(res);
      await handleResult(res, data, false, '');
    } catch (e: any) {
      setPhase('needs_retry');
      setStatusText('The repayment may be mid-flight. Tap Retry to finish safely.');
      toast({ title: "Repayment didn't finish", description: e.message || 'Tap Retry to finish.', variant: 'destructive' });
    }
  };

  const submit = () => {
    if (source === 'agent') return repayFromAgent();
    if (source === 'wallet-usdc') return repayFromWalletUsdc();
    if (source === 'deleverage') return repayFromDeleverage();
    if (source === 'vault-savings') return repayFromVaultSavings();
    return repayFromWalletToken();
  };

  const symbol = pool?.symbol ?? null;
  const debtStr = fmtUsd(pool?.debtUsd ?? null);
  const ctaLabel = working
    ? 'Working…'
    : needsRetry
    ? 'Retry'
    : source === 'deleverage'
    ? `Repay with ${symbol ?? 'collateral'}`
    : source === 'wallet-token'
    ? 'Repay & Convert to USDC'
    : source === 'vault-savings'
    ? 'Repay from Savings'
    : 'Repay debt';
  // The user only needs SOL in THEIR wallet when THEY sign a transfer (wallet
  // USDC / wallet token). Agent USDC and deleverage are signed server-side, so a
  // "you need SOL" note there would be misleading — gate it to the signed paths.
  const userSignsTx = source === 'wallet-usdc' || source === 'wallet-token';

  return (
    <Dialog open={open} onOpenChange={(o) => !working && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-repay-loan">
        <DialogHeader>
          <DialogTitle>{symbol ? `Repay ${symbol} loan` : 'Repay loan'}</DialogTitle>
          <DialogDescription>
            Pay down the USDC you borrowed{symbol ? ` against ${symbol}` : ''} — from wherever's easiest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Outstanding debt — accent (liability); the figure Max caps at. */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm">
            <span className="text-muted-foreground">Outstanding debt</span>
            <span className="font-semibold tabular-nums text-accent" data-testid="text-repay-outstanding">{debtStr}</span>
          </div>

          {/* Pay-with MODE: USDC you already hold, or an asset converted to USDC. */}
          <div className="grid grid-cols-2 gap-2">
            {(['usdc', 'asset'] as RepayMode[]).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  disabled={working || needsRetry}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                    active ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50'
                  }`}
                  data-testid={`button-repay-mode-${m}`}
                >
                  {m === 'usdc' ? 'Pay with USDC' : 'Pay with an asset'}
                </button>
              );
            })}
          </div>

          {/* SOURCE within the chosen mode (two options). */}
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Pay from</span>
            <div className="flex gap-2">
              {REPAY_SOURCES_BY_MODE[mode].map((s) => {
                const active = source === s;
                const Icon = SOURCE_LABELS[s].icon;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => switchSource(s)}
                    aria-pressed={active}
                    disabled={working || needsRetry}
                    className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      active ? 'border-primary/50 bg-primary/10' : 'border-border bg-background/40 hover:bg-muted/50'
                    }`}
                    data-testid={`button-repay-source-${s}`}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{SOURCE_LABELS[s].label}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{SOURCE_LABELS[s].sub}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* #1 Agent USDC — single-tx, server-signed. Max sends the 'max'
              sentinel so the server clears the FULL on-chain debt (never more). */}
          {source === 'agent' && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Amount</span>
                  <span>In trading agent {fmtUsd(agentUsdcBalance)}</span>
                </div>
                <div className="relative">
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={usdcAmount}
                    onChange={(e) => {
                      setUseMaxAgent(false);
                      setUsdcAmount(e.target.value);
                    }}
                    disabled={working}
                    className="h-12 pr-24 text-lg font-medium"
                    data-testid="input-repay-agent-amount"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">USDC</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        if (debtNum == null) return;
                        if (agentUsdcBalance != null && agentUsdcBalance < debtNum) {
                          // Trading agent can't cover the full debt → repay everything
                          // it holds, as a clean cents amount (never the 'max' sentinel,
                          // which would ask the server to clear more than is available).
                          setUseMaxAgent(false);
                          setUsdcAmount((Math.floor(agentUsdcBalance * 100) / 100).toFixed(2));
                        } else {
                          // Agent covers the debt → show the debt to the cent, but send
                          // the 'max' sentinel so the server clears the EXACT on-chain
                          // debt (never more, no leftover dust from rounding).
                          setUseMaxAgent(true);
                          setUsdcAmount(debtNum.toFixed(2));
                        }
                      }}
                      disabled={working}
                      data-testid="button-repay-agent-max"
                    >
                      Max
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>Max caps at your {debtStr} outstanding debt, never more.</span>
                </p>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                <span>Paid straight from your trading agent's USDC — your profits clear the debt with no transfer to your wallet first.</span>
              </p>
            </>
          )}

          {/* #2 Wallet USDC — user-signed transfer then repay (resumable). Max
              fills the corrected outstanding debt (true on-chain debt, T001). */}
          {source === 'wallet-usdc' && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Amount</span>
                  <span>In your wallet {fmtUsd(walletUsdcBalance)}</span>
                </div>
                <div className="relative">
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={usdcAmount}
                    onChange={(e) => setUsdcAmount(e.target.value)}
                    disabled={working || needsRetry}
                    className="h-12 pr-24 text-lg font-medium"
                    data-testid="input-repay-wallet-usdc-amount"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">USDC</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        if (debtNum == null) return;
                        let amt: number;
                        if (walletUsdcBalance != null && walletUsdcBalance < debtNum) {
                          // Wallet is the binding cap → pay everything it holds (floored
                          // to cents so we never exceed the real balance).
                          amt = Math.floor(walletUsdcBalance * 100) / 100;
                        } else {
                          // Debt is the binding cap → clear it fully (round the cents UP
                          // so no dust is left; any sub-cent excess lands in the agent,
                          // still the user's funds). Clamp to the wallet just in case.
                          amt = Math.ceil(debtNum * 100) / 100;
                          if (walletUsdcBalance != null && amt > walletUsdcBalance) {
                            amt = Math.floor(walletUsdcBalance * 100) / 100;
                          }
                        }
                        setUsdcAmount(amt.toFixed(2));
                      }}
                      disabled={working || needsRetry || debtNum == null}
                      data-testid="button-repay-wallet-usdc-max"
                    >
                      Max
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>Max caps at your {debtStr} outstanding debt, never more.</span>
                </p>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                <span>Paid from the USDC in your connected wallet — you'll approve a transfer to your trading agent first.</span>
              </p>
            </>
          )}

          {/* #3 Deleverage (supplied collateral) — server-signed sell→repay.
              One collateral per position, shown as a (single-row) picker for
              parity with the wallet-token list. Max sells just enough to clear
              the debt (client estimate; server LTV-gates + caps at true debt). */}
          {source === 'deleverage' && (
            <>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Use which collateral</span>
                <div className="rounded-lg border border-border divide-y divide-border/60">
                  <div
                    className="flex w-full items-center gap-3 px-3 py-2.5 bg-primary/10"
                    data-testid={`row-repay-collateral-${symbol ?? 'asset'}`}
                  >
                    {pool?.collateralLogoURI ? (
                      <img src={pool.collateralLogoURI} alt={symbol ?? 'collateral'} className="w-7 h-7 rounded-full" />
                    ) : (
                      <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold">
                        {(symbol ?? '?').slice(0, 2)}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{symbol ?? 'Collateral'}</p>
                      <p className="text-xs text-muted-foreground truncate">Locked {pool?.collateralLabel ?? '\u2014'}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-mono">{fmtUsd(pool?.collateralUsd ?? null)}</p>
                      <p className="text-[11px] text-muted-foreground">supplied</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Collateral to sell</span>
                <div className="relative">
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={collateralAmount}
                    onChange={(e) => setCollateralAmount(e.target.value)}
                    disabled={working || needsRetry}
                    className="h-12 pr-28 text-lg font-medium"
                    data-testid="input-repay-deleverage-amount"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">{symbol ?? 'collateral'}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        if (deleverageMax) setCollateralAmount(deleverageMax.fillStr);
                        else if (pool?.collateralAmountRaw != null && pool?.collateralDecimals != null)
                          setCollateralAmount(rawToDecimalString(pool.collateralAmountRaw, pool.collateralDecimals));
                      }}
                      disabled={
                        working ||
                        needsRetry ||
                        (deleverageMax == null && (pool?.collateralAmountRaw == null || pool?.collateralDecimals == null))
                      }
                      data-testid="button-repay-deleverage-max"
                    >
                      Max
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    {deleverageMax?.clears
                      ? `Max sells ~${deleverageMax.fillStr} ${symbol ?? 'collateral'}, enough to clear your ${debtStr} debt.`
                      : deleverageMax
                      ? `Max sells your full ${pool?.collateralLabel ?? 'collateral'}, paying down part of your ${debtStr} debt.`
                      : `Max sells your full locked ${symbol ?? 'collateral'}.`}
                  </span>
                </p>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2.5">
                <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Repaying with supplied collateral <span className="text-foreground font-medium">reduces both your loan and that collateral</span> — we sell it for USDC to clear the debt.
                </p>
              </div>
            </>
          )}

          {/* #4 Any wallet token — user-signed transfer → Jupiter swap → repay
              (resumable). Active row uses primary (selection), not teal. */}
          {source === 'wallet-token' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Pay with which token</span>
                {tokensLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading your tokens…
                  </div>
                ) : walletTokens.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No eligible tokens in your wallet.</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
                    {walletTokens.map((t) => (
                      <button
                        key={t.mint}
                        type="button"
                        onClick={() => {
                          setSelectedToken(t);
                          setTokenAmount('');
                        }}
                        disabled={working || needsRetry}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors disabled:opacity-50 hover:bg-muted/50 ${
                          selectedToken?.mint === t.mint ? 'bg-primary/10' : ''
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
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Amount</span>
                    <span>Wallet {selectedToken.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} {selectedToken.symbol}</span>
                  </div>
                  <div className="relative">
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={tokenAmount}
                      onChange={(e) => setTokenAmount(e.target.value)}
                      disabled={working || needsRetry}
                      className="h-12 pr-20 text-lg font-medium"
                      data-testid="input-repay-token-amount"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                      <span className="text-sm font-medium text-muted-foreground">{selectedToken.symbol}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => {
                          if (walletTokenMax) setTokenAmount(walletTokenMax.fillStr);
                          else setTokenAmount(rawToDecimalString(selectedToken.amountRaw, selectedToken.decimals));
                        }}
                        disabled={working || needsRetry}
                        data-testid="button-repay-token-max"
                      >
                        Max
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>
                      {walletTokenMax?.clears
                        ? `Max sends ~${walletTokenMax.fillStr} ${selectedToken.symbol}, enough to clear your ${debtStr} debt.`
                        : walletTokenMax
                        ? `Max sends your full ${selectedToken.amountUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${selectedToken.symbol}, paying down part of your ${debtStr} debt.`
                        : `Max sends your full ${selectedToken.symbol} balance.`}
                    </span>
                  </p>
                </div>
              )}
              <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
                <ArrowLeftRight className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Your {selectedToken?.symbol ?? 'token'} is <span className="text-foreground font-medium">swapped to USDC</span> via Jupiter, then used to pay down the loan.
                </p>
              </div>
            </div>
          )}

          {/* #5 Vault savings — ONE-TAP, fully server-side. No amount input: the
              server reads the on-chain balance, unparks JUST ENOUGH of the
              largest holding to USDC, then repays (capped at debt). Leftover stays
              parked. This is the carry-trade unwind (savings locked in a yield
              token) made into a single safe action. */}
          {source === 'vault-savings' && (
            <div className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2.5">
              <PiggyBank className="w-4 h-4 text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                One tap: we unpark <span className="text-foreground font-medium">just enough of your Vault savings</span>, swap it to USDC, and clear your {debtStr} debt. Anything left over stays in your savings.
              </p>
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

          {/* Gas note only when the USER signs a transfer (wallet sources), and
              only pre-submit — during a needs_retry the transfer may already be
              confirmed and the finish is server-side, so the note would mislead. */}
          {userSignsTx && phase === 'idle' && (
            <div className="text-xs text-amber-500/80 bg-amber-500/10 rounded-lg p-2.5 flex items-start gap-2">
              <Fuel className="w-4 h-4 shrink-0 mt-0.5" />
              <span>You'll need a little SOL in your wallet for the network fee (~0.005 SOL).</span>
            </div>
          )}

          <Button
            className="w-full h-11"
            onClick={submit}
            disabled={working}
            data-testid="button-submit-repay"
          >
            {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
            {ctaLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
