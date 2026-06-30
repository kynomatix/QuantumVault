import { useEffect, useRef, useState } from "react";
import { Loader2, ArrowDownCircle, Landmark, ShieldCheck } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { getSessionId, newRequestId, fmtUsd } from "@/lib/lending-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Actionable per-bot borrow controls (Flash / independent_trader bots only).
 *
 * Lives in the bot drawer's Equity tab. Two mutually-exclusive states:
 *
 *   - No open borrow + a usable carry source → "Borrow Against Collateral" card.
 *     The user CHOOSES how much USDC to borrow (up to the server-computed safe max).
 *     The carve (collateral slice taken out of the ACCOUNT position) is scaled to the
 *     requested borrow at the same safe ratio, so the bot opens at the same target LTV.
 *     The borrowed USDC lands as idle USDC in the bot wallet.
 *   - An open borrow → "Collateral Loan" manage card (live debt + health chip +
 *     Repay). Repay first brings ANY parked funds in this bot back to cash (the close
 *     repays from the bot's USDC), then closes the position: repay the debt + return
 *     the collateral to the account. Leftover (incl. the bot's own spare) stays as
 *     idle USDC in the bot.
 *
 * Server-gated (eligible:false ⇒ this renders nothing) — open to every borrow-eligible
 * wallet, same as the account engine. Both money ops are resumable: the client persists
 * a clientRequestId AND the exact computed amounts until the op completes, so a retry
 * after a partial run FINISHES the SAME op with identical amounts (never a new one).
 */

type HealthBand = "healthy" | "nudge" | "urgent" | "liquidation" | "unavailable";

interface PerbotPositionHealth {
  debtUsd: number | null;
  ltv: number | null;
  healthFactor: number | null;
  band: HealthBand;
}

interface PerbotBorrowPosition {
  id: string;
  status: string;
  collateralAssetKey: string | null;
  collateralMint: string | null;
  debtAmountRaw: string | null;
  health: PerbotPositionHealth;
}

interface PerbotCarrySource {
  available: boolean;
  collateralMint: string;
  collateralAssetKey: string | null;
  collateralDecimals: number;
  debtDecimals: number;
  maxCarveRaw: string;
  maxBorrowRaw: string;
}

interface PerbotPositionsResponse {
  eligible?: boolean;
  applicable: boolean;
  positions: PerbotBorrowPosition[];
  carrySources: PerbotCarrySource[];
}

interface ParkedPositionView {
  assetKey: string;
  displayName?: string;
  // Raw on-chain token balance. We unpark based on THIS, not the valued
  // currentValueUsdc, so a held-but-unvalued (unquotable) balance is still
  // brought back before the repay rather than silently skipped.
  onChainAmountRaw?: string;
}

const HEALTH_CHIP: Record<string, { label: string; cls: string }> = {
  healthy: { label: "Healthy", cls: "text-emerald-500" },
  nudge: { label: "Watch", cls: "text-yellow-500" },
  urgent: { label: "At Risk", cls: "text-orange-500" },
  liquidation: { label: "Critical", cls: "text-red-500" },
};

export default function PerbotBorrowControls({
  bot,
  walletAddress,
  active,
  onChanged,
}: {
  bot: { id: string } | null;
  walletAddress: string;
  active: boolean;
  onChanged: () => void;
}) {
  const { retryAuth } = useWallet();
  const { toast } = useToast();

  const [data, setData] = useState<PerbotPositionsResponse | null>(null);
  const [busy, setBusy] = useState<"borrow" | "repay" | null>(null);
  const [confirm, setConfirm] = useState<"borrow" | "repay" | null>(null);
  // How much USDC the user wants to borrow (free text → parsed). Empty = nothing yet.
  const [amount, setAmount] = useState("");
  // True when a borrow op for THIS bot is mid-flight (a clientRequestId is persisted
  // but no open position is visible yet, e.g. after a 202). Lets the user RESUME the
  // exact same op — with the exact same persisted amounts — even if the input is blank.
  const [hasInflightBorrow, setHasInflightBorrow] = useState(false);
  // The drawer is a single reused instance: a slow response for a previous
  // bot/wallet must never overwrite the current one.
  const reqRef = useRef(0);

  // Idempotency keys. OPEN has no position id yet, so it's keyed by bot — but it is
  // CLEARED the moment an open position becomes visible (see fetchPositions) so a
  // stale open id can never leak into a future loan. CLOSE is keyed by the exact
  // position id, so a stale close id can never match a different (later) position.
  const openKey = () => `qv:perbot-borrow:open:${bot?.id}`;
  // The exact carve/debt raws the in-flight open op was created with — persisted next
  // to the clientRequestId so a resume re-sends IDENTICAL amounts (never the live input,
  // which the user could have changed between a partial failure and the retry).
  const openRawsKey = () => `qv:perbot-borrow:open-raws:${bot?.id}`;
  const closeKey = (positionId: string) => `qv:perbot-borrow:close:${bot?.id}:${positionId}`;

  const clearOpenOp = () => {
    try {
      localStorage.removeItem(openKey());
      localStorage.removeItem(openRawsKey());
    } catch {
      /* ignore */
    }
    setHasInflightBorrow(false);
  };

  const fetchPositions = async () => {
    if (!bot || !walletAddress) return;
    const reqId = ++reqRef.current;
    // Blank any previous bot/wallet's data immediately so a switch never shows
    // (or lets the user act on) stale controls for the wrong bot.
    setData(null);
    try {
      const res = await fetch(
        `/api/vault/borrow/perbot/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
        { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
      );
      if (reqId !== reqRef.current) return;
      const d = await safeResponseJson(res);
      if (reqId !== reqRef.current) return;
      const next = res.ok ? (d as PerbotPositionsResponse) : null;
      setData(next);
      // Once an open position is visible the open op has completed — drop any
      // persisted open idempotency id + amounts so they can't be reused for a future
      // loan (the dangerous lost-response window the architect flagged).
      if (next?.positions?.[0]) {
        clearOpenOp();
      } else {
        // No open position yet — surface whether a borrow op is still mid-flight so
        // the user can RESUME it (the input may be blank, e.g. after a switch).
        let inflight = false;
        try {
          inflight = !!localStorage.getItem(openKey());
        } catch {
          /* ignore */
        }
        setHasInflightBorrow(inflight);
      }
    } catch {
      if (reqId === reqRef.current) setData(null);
    }
  };

  // Lazy read: only when the Equity tab is in view (no poller). Re-runs on
  // bot/wallet switch; clears immediately so a switch never flashes stale data.
  useEffect(() => {
    // Any bot/wallet/visibility change closes an open confirm dialog so a pending
    // Borrow/Repay can never fire against a bot the user is no longer looking at,
    // and clears the typed amount so it can't carry over to a different bot.
    setConfirm(null);
    setAmount("");
    if (active && bot && walletAddress) {
      fetchPositions();
    } else {
      reqRef.current++;
      setData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bot?.id, walletAddress]);

  const openPos = data?.positions?.[0] ?? null;
  const carrySrc = (data?.carrySources ?? []).find((s) => s.available) ?? null;

  // Refresh both the drawer balances/advisor and this card's own state.
  const refreshAll = async () => {
    try {
      await Promise.resolve(onChanged());
    } finally {
      fetchPositions();
    }
  };

  // Convert a requested USDC borrow amount into the exact { carveRaw, requestedDebtRaw }
  // to send. Near/at the max → send the server's proven all-in raws verbatim. Otherwise
  // scale the carve to the requested borrow at the SAME ratio, rounding the carve UP
  // (more collateral backing = lower LTV = safer), capped at the server max. The server
  // re-validates every amount under the target LTV regardless.
  const computeBorrowRaws = (
    amountUsd: number,
  ): { carveRaw: string; requestedDebtRaw: string } | null => {
    if (!carrySrc) return null;
    let maxBorrowRaw: bigint;
    let maxCarveRaw: bigint;
    try {
      maxBorrowRaw = BigInt(carrySrc.maxBorrowRaw);
      maxCarveRaw = BigInt(carrySrc.maxCarveRaw);
    } catch {
      return null;
    }
    if (maxBorrowRaw <= 0n || maxCarveRaw <= 0n) return null;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
    const debtDec = carrySrc.debtDecimals;
    let debtRaw = BigInt(Math.floor(amountUsd * 10 ** debtDec));
    if (debtRaw <= 0n) return null;
    // Within ~1 cent of the max (or above) → use the server's proven all-in raws verbatim.
    const oneCent = BigInt(Math.max(1, Math.round(10 ** debtDec / 100)));
    if (debtRaw + oneCent >= maxBorrowRaw) {
      return { carveRaw: maxCarveRaw.toString(), requestedDebtRaw: maxBorrowRaw.toString() };
    }
    const fraction = Number(debtRaw) / Number(maxBorrowRaw);
    let carveRaw = BigInt(Math.ceil(Number(maxCarveRaw) * fraction));
    if (carveRaw > maxCarveRaw) carveRaw = maxCarveRaw;
    if (carveRaw <= 0n) carveRaw = 1n;
    return { carveRaw: carveRaw.toString(), requestedDebtRaw: debtRaw.toString() };
  };

  const handleBorrow = async () => {
    if (!bot || !carrySrc) return;
    setBusy("borrow");
    try {
      const sessionId = await getSessionId();
      const storeKey = openKey();
      const rawsKey = openRawsKey();
      let clientRequestId = localStorage.getItem(storeKey);
      let raws: { carveRaw: string; requestedDebtRaw: string } | null = null;

      if (clientRequestId) {
        // RESUME: an op is already in flight → re-send the EXACT amounts it was created
        // with. NEVER compute from the live input under an existing id (the user could
        // have changed it). If the persisted amounts are somehow gone, FAIL CLOSED:
        // don't bind a guessed amount to an in-flight op — let the server settle and
        // refresh, rather than risk a mismatched resume.
        try {
          const stored = localStorage.getItem(rawsKey);
          if (stored) raws = JSON.parse(stored);
        } catch {
          raws = null;
        }
        if (!raws || !raws.carveRaw || !raws.requestedDebtRaw) {
          toast({
            title: "Finishing your last borrow",
            description: "Your previous borrow is still settling. Give it a moment — this view will update on its own.",
          });
          fetchPositions();
          return;
        }
      } else {
        // FRESH: compute from the input, then persist the raws BEFORE the id so we can
        // never end up with an id that has no amounts to resume from.
        raws = computeBorrowRaws(parseFloat(amount));
        if (!raws) {
          toast({ title: "Enter an amount", description: "Enter how much USDC you'd like to borrow.", variant: "destructive" });
          return;
        }
        clientRequestId = newRequestId();
        try {
          localStorage.setItem(rawsKey, JSON.stringify(raws));
          localStorage.setItem(storeKey, clientRequestId);
        } catch {
          /* ignore */
        }
        setHasInflightBorrow(true);
      }

      const res = await fetch("/api/vault/borrow/perbot/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({
          botId: bot.id,
          collateralMint: carrySrc.collateralMint,
          carveRaw: raws.carveRaw,
          requestedDebtRaw: raws.requestedDebtRaw,
          sessionId,
          clientRequestId,
        }),
      });
      const d = await safeResponseJson(res);
      if (res.ok && d.ok) {
        clearOpenOp();
        setAmount("");
        const usd = typeof d.suggestedParkAmountUsdc === "number" ? d.suggestedParkAmountUsdc : null;
        toast({
          title: "USDC Borrowed",
          description: usd != null ? `Borrowed ${fmtUsd(usd)} into this bot.` : "Borrowed USDC into this bot.",
        });
        await refreshAll();
      } else if (res.status === 202 || d.needsAttention) {
        // Keep the clientRequestId + amounts so the next tap resumes this exact op.
        setHasInflightBorrow(true);
        toast({ title: "Still Finishing", description: "The borrow is still settling. Tap Borrow again in a moment to finish it." });
        fetchPositions();
      } else {
        throw new Error(d.error || "Borrow failed");
      }
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Borrow failed", retry: () => handleBorrow() });
      } else {
        toast({ title: "Borrow failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleRepay = async () => {
    if (!bot || !openPos) return;
    setBusy("repay");
    try {
      const sessionId = await getSessionId();

      // 1. Bring any parked funds in this bot back to cash FIRST. The close repays
      //    the debt from the bot's USDC, so borrowed funds parked for yield must be
      //    unparked or the repay can't cover the principal. All-out per asset.
      const pres = await fetch(
        `/api/vault/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
        { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
      );
      const pdata = await safeResponseJson(pres);
      if (!pres.ok) throw new Error(pdata.error || "Could not read parked funds.");
      const parked: ParkedPositionView[] = (pdata.positions ?? []).filter(
        (p: ParkedPositionView) => {
          // Detect by RAW on-chain balance, not the valued USDC — a held-but-
          // unquotable balance must still be brought back, not silently skipped.
          try {
            return BigInt(p.onChainAmountRaw ?? "0") > 0n;
          } catch {
            return false;
          }
        },
      );
      for (const p of parked) {
        const ures = await fetch("/api/vault/unpark", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
          credentials: "include",
          body: JSON.stringify({ assetKey: p.assetKey, all: true, sessionId, botId: bot.id }),
        });
        const udata = await safeResponseJson(ures);
        if (!ures.ok) throw new Error(udata.error || `Could not bring back ${p.displayName || p.assetKey}.`);
      }

      // 2. Close: repay the debt + return the collateral to the account position.
      //    Keyed by the EXACT position id so a stale close id can never be reused
      //    against a different (later) loan.
      const storeKey = closeKey(openPos.id);
      let clientRequestId = localStorage.getItem(storeKey);
      if (!clientRequestId) {
        clientRequestId = newRequestId();
        localStorage.setItem(storeKey, clientRequestId);
      }
      const res = await fetch("/api/vault/borrow/perbot/close", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ botId: bot.id, botBorrowPositionId: openPos.id, sessionId, clientRequestId }),
      });
      const d = await safeResponseJson(res);
      if (res.ok && d.ok) {
        localStorage.removeItem(storeKey);
        toast({ title: "Loan Repaid", description: "The borrowed USDC was repaid and your collateral returned." });
        await refreshAll();
      } else if (res.status === 202 || d.needsAttention) {
        toast({ title: "Still Finishing", description: "The repay is still settling. Tap Repay again in a moment to finish it." });
        fetchPositions();
      } else {
        throw new Error(d.error || "Repay failed");
      }
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Repay failed", retry: () => handleRepay() });
      } else {
        toast({ title: "Repay failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
  };

  // Owner-gated + Flash-only. Nothing to show otherwise.
  if (!bot || !data || !data.eligible || !data.applicable) return null;
  if (!openPos && !carrySrc) return null;

  const borrowUsd = carrySrc ? Number(carrySrc.maxBorrowRaw) / 10 ** carrySrc.debtDecimals : 0;
  const debtUsd = openPos
    ? openPos.health?.debtUsd ?? Number(openPos.debtAmountRaw ?? 0) / 1e6
    : 0;
  const band = openPos?.health?.band;
  const chip = band && band !== "unavailable" ? HEALTH_CHIP[band] : null;

  // Max borrowable in friendly dollars (floored to the cent so it can never round
  // ABOVE the true on-chain max). Entering it lands in the ~1-cent verbatim path.
  const maxStr = borrowUsd > 0 ? (Math.floor(borrowUsd * 100) / 100).toFixed(2) : "0";
  const enteredUsd = parseFloat(amount);
  const amtTooHigh = Number.isFinite(enteredUsd) && enteredUsd > borrowUsd + 0.0001;
  const amtValid = Number.isFinite(enteredUsd) && enteredUsd > 0 && !amtTooHigh;
  // The Borrow button is live when there's a valid amount, OR an op is mid-flight to
  // resume (its amounts come from storage, so a blank input is fine), OR — as a final
  // safety net for a resume whose stored amounts vanished — the input holds a value.
  const canBorrow = amtValid || hasInflightBorrow;

  return (
    <>
      {openPos ? (
        <div className="p-4 rounded-xl border border-orange-500/30 bg-orange-500/5 space-y-3" data-testid="card-perbot-loan">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Landmark className="w-4 h-4 text-muted-foreground" />
              <h3 className="font-semibold text-sm">Collateral Loan</h3>
            </div>
            {chip && (
              <span className="text-xs" data-testid="text-perbot-loan-health">
                <span className="text-muted-foreground">Health: </span>
                <span className={`font-medium ${chip.cls}`}>{chip.label}</span>
              </span>
            )}
          </div>
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Amount Borrowed</p>
              <p className="text-2xl font-bold tabular-nums" data-testid="text-perbot-debt">
                {fmtUsd(debtUsd)}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setConfirm("repay")}
              disabled={busy !== null}
              data-testid="button-perbot-repay"
            >
              {busy === "repay" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownCircle className="w-4 h-4 mr-1.5" />}
              Repay Loan
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Repaying brings any parked funds in this bot back to cash, clears the loan, and returns your collateral to your account.
          </p>
        </div>
      ) : (
        carrySrc && (
          <div className="p-4 rounded-xl border border-primary/30 bg-primary/5 space-y-3" data-testid="card-perbot-borrow">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm">Borrow Against Collateral</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Borrow extra USDC against your account collateral and add it to this bot's trading balance. Choose how much, up to a safe limit. Your account stays at a safe level, and you can repay anytime.
            </p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Amount to Borrow (USDC)</span>
                <span data-testid="text-perbot-borrow-max">Max {fmtUsd(borrowUsd)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={busy !== null}
                  data-testid="input-perbot-borrow-amount"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAmount(maxStr)}
                  disabled={busy !== null || !(borrowUsd > 0)}
                  data-testid="button-perbot-borrow-max"
                >
                  Max
                </Button>
              </div>
              {amtTooHigh && (
                <p className="text-xs text-destructive" data-testid="text-perbot-borrow-error">
                  That's above the safe limit of {fmtUsd(borrowUsd)}.
                </p>
              )}
              {hasInflightBorrow && !amtValid && (
                <p className="text-xs text-muted-foreground" data-testid="text-perbot-borrow-resume">
                  A borrow is still finishing. Tap Borrow to complete it.
                </p>
              )}
            </div>
            <Button
              className="w-full"
              onClick={() => setConfirm("borrow")}
              disabled={busy !== null || !canBorrow}
              data-testid="button-perbot-borrow"
            >
              {busy === "borrow" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : hasInflightBorrow && !amtValid ? (
                <>Finish Borrow</>
              ) : (
                <>Borrow {amtValid ? fmtUsd(enteredUsd) : "USDC"}</>
              )}
            </Button>
          </div>
        )
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent data-testid="dialog-perbot-confirm">
          {confirm === "borrow" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Borrow Against Collateral?</AlertDialogTitle>
                <AlertDialogDescription>
                  {amtValid ? (
                    <>
                      This borrows about {fmtUsd(enteredUsd)} in USDC against your account collateral and adds it to this bot's
                      trading balance. Your account stays at a safe level. You can repay it at any time.
                    </>
                  ) : (
                    <>
                      This finishes the borrow that's still settling and adds the USDC to this bot's trading balance.
                      Your account stays at a safe level. You can repay it at any time.
                    </>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-perbot-borrow-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleBorrow} data-testid="button-perbot-borrow-confirm">
                  {amtValid ? <>Borrow {fmtUsd(enteredUsd)}</> : <>Finish Borrow</>}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Repay this loan?</AlertDialogTitle>
                <AlertDialogDescription>
                  This brings any parked funds in this bot back to cash, repays the borrowed USDC, and returns your
                  collateral to your account. Any leftover cash stays in the bot.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-perbot-repay-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRepay} data-testid="button-perbot-repay-confirm">
                  Repay Loan
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
