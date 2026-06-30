import { useEffect, useRef, useState } from "react";
import { Loader2, ArrowDownCircle, Landmark, ShieldCheck } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { getSessionId, newRequestId, fmtUsd } from "@/lib/lending-format";
import { Button } from "@/components/ui/button";
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
 * Actionable per-bot Carry Trade controls (Flash / independent_trader bots only).
 *
 * Lives in the bot drawer's Equity tab, directly under the read-only Carry Trade
 * Advisor. Two mutually-exclusive states, both all-in / all-out (no amount inputs,
 * per the Vault philosophy):
 *
 *   - No open borrow + a usable carry source → "Borrow Against Collateral" card.
 *     One tap borrows the server-computed safe max (carve a collateral slice out of
 *     the ACCOUNT position capped at the target LTV, deliver it to the bot, open the
 *     bot's borrow). The borrowed USDC lands as idle USDC in the bot wallet.
 *   - An open borrow → "Carry Trade Loan" manage card (live debt + health chip +
 *     Repay). Repay first brings ANY parked funds in this bot back to cash (the close
 *     repays from the bot's USDC), then closes the position: repay the debt + return
 *     the collateral to the account. Leftover (incl. the bot's own spare) stays as
 *     idle USDC in the bot.
 *
 * Owner-gated server-side (eligible:false ⇒ this renders nothing). Both money ops are
 * resumable: the client persists a clientRequestId until the op completes, so a retry
 * after a partial run FINISHES it instead of starting over.
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
  // The drawer is a single reused instance: a slow response for a previous
  // bot/wallet must never overwrite the current one.
  const reqRef = useRef(0);

  // Idempotency keys. OPEN has no position id yet, so it's keyed by bot — but it is
  // CLEARED the moment an open position becomes visible (see fetchPositions) so a
  // stale open id can never leak into a future loan. CLOSE is keyed by the exact
  // position id, so a stale close id can never match a different (later) position.
  const openKey = () => `qv:perbot-borrow:open:${bot?.id}`;
  const closeKey = (positionId: string) => `qv:perbot-borrow:close:${bot?.id}:${positionId}`;

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
      // persisted open idempotency id so it can't be reused for a future loan
      // (the dangerous lost-response window the architect flagged).
      if (next?.positions?.[0]) {
        try {
          localStorage.removeItem(openKey());
        } catch {
          /* ignore */
        }
      }
    } catch {
      if (reqId === reqRef.current) setData(null);
    }
  };

  // Lazy read: only when the Equity tab is in view (no poller). Re-runs on
  // bot/wallet switch; clears immediately so a switch never flashes stale data.
  useEffect(() => {
    // Any bot/wallet/visibility change closes an open confirm dialog so a pending
    // Borrow/Repay can never fire against a bot the user is no longer looking at.
    setConfirm(null);
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

  const handleBorrow = async () => {
    if (!bot || !carrySrc) return;
    setBusy("borrow");
    try {
      const sessionId = await getSessionId();
      const storeKey = openKey();
      let clientRequestId = localStorage.getItem(storeKey);
      if (!clientRequestId) {
        clientRequestId = newRequestId();
        localStorage.setItem(storeKey, clientRequestId);
      }
      const res = await fetch("/api/vault/borrow/perbot/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({
          botId: bot.id,
          collateralMint: carrySrc.collateralMint,
          carveRaw: carrySrc.maxCarveRaw,
          requestedDebtRaw: carrySrc.maxBorrowRaw,
          sessionId,
          clientRequestId,
        }),
      });
      const d = await safeResponseJson(res);
      if (res.ok && d.ok) {
        localStorage.removeItem(storeKey);
        const usd = typeof d.suggestedParkAmountUsdc === "number" ? d.suggestedParkAmountUsdc : null;
        toast({
          title: "Carry Trade Opened",
          description: usd != null ? `Borrowed ${fmtUsd(usd)} into this bot.` : "Borrowed USDC into this bot.",
        });
        await refreshAll();
      } else if (res.status === 202 || d.needsAttention) {
        // Keep the clientRequestId so the next tap resumes this exact op.
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

  return (
    <>
      {openPos ? (
        <div className="p-4 rounded-xl border border-orange-500/30 bg-orange-500/5 space-y-3" data-testid="card-perbot-loan">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Landmark className="w-4 h-4 text-muted-foreground" />
              <h3 className="font-semibold text-sm">Carry Trade Loan</h3>
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
              Borrow extra USDC against your account collateral and add it to this bot's trading balance. Your account stays at a safe level, and you can repay anytime.
            </p>
            <Button
              className="w-full"
              onClick={() => setConfirm("borrow")}
              disabled={busy !== null || !(borrowUsd > 0)}
              data-testid="button-perbot-borrow"
            >
              {busy === "borrow" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>Borrow {fmtUsd(borrowUsd)}</>
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
                <AlertDialogTitle>Open a Carry Trade?</AlertDialogTitle>
                <AlertDialogDescription>
                  This borrows about {fmtUsd(borrowUsd)} in USDC against your account collateral and adds it to this bot's
                  trading balance. Your account stays at a safe level. You can repay the loan at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-perbot-borrow-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleBorrow} data-testid="button-perbot-borrow-confirm">
                  Borrow {fmtUsd(borrowUsd)}
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
