import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { Loader2, Landmark, Check, AlertCircle, AlertTriangle, RotateCcw, TrendingUp, TrendingDown, Info } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import {
  getSessionId,
  newRequestId,
  fmtUsd,
  getLtvBarModel,
} from "@/lib/lending-format";
import { LtvBar } from "@/components/LtvBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  collateralValueUsd: number | null;
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
  collateralSymbol: string | null;
  collateralDecimals: number | null;
  // Conservative (never-under-read) debt for DISPLAY — see server seam.
  debtAmountRaw: string | null;
  // Raw components surfaced for transparency (not used for the headline).
  liveDebtRaw: string | null;
  principalUsdcRaw: string | null;
  maxLtv: number | null;
  // Liquidation-threshold LTV (fraction, e.g. 0.80) — the danger line on the loan
  // bar. Sits above maxLtv (the borrow cap). null when the vault is unreadable.
  liquidationThreshold: number | null;
  collateralLogoURI: string | null;
  // The collateral's OWN native staking APY (PERCENT), e.g. INF's SOL staking
  // yield. Display-only "yield bracket" badge; null for non-yield collateral.
  stakingApyPct?: number | null;
  // "Defend this loan" default: how much collateral to add to restore a safe LTV,
  // from the SAME liquidation-oracle facts as `health`. null = unreadable (fail
  // closed) or already safe. Amounts are in COLLATERAL units/USD.
  topUpSuggestion?: {
    suggestedCollateralRaw: string;
    suggestedCollateralTokens: number;
    suggestedCollateralUsd: number;
    targetLtv: number;
  } | null;
  health: PerbotPositionHealth;
}

interface PerbotCarrySource {
  available: boolean;
  collateralMint: string;
  collateralAssetKey: string | null;
  collateralSymbol: string | null;
  collateralDecimals: number;
  debtDecimals: number;
  maxCarveRaw: string;
  maxBorrowRaw: string;
  collateralLogoURI: string | null;
  // The collateral's OWN native staking APY (PERCENT); null for non-yield.
  stakingApyPct?: number | null;
  oraclePriceUsd?: number | null;
  targetLtv?: number | null;
  suggestLtv?: number | null;
  // The vault's current borrow rate (PERCENT), shown before reopening a loan.
  borrowAprPct?: number | null;
}

interface PerbotPositionsResponse {
  eligible?: boolean;
  applicable: boolean;
  positions: PerbotBorrowPosition[];
  carrySources: PerbotCarrySource[];
  // The bot's opt-in auto-defend flag (Flash per-bot). Drives the modal's Auto toggle.
  autoCollateralTopUp?: boolean;
  // Free USDC (raw, 6dp) in the bot wallet — a read-only sizing hint for the modal's
  // partial pay-DOWN waterfall (bot cash first). null when the read failed.
  botWalletUsdcRaw?: string | null;
}

interface ParkedPositionView {
  assetKey: string;
  displayName?: string;
  // Raw on-chain token balance. We unpark based on THIS, not the valued
  // currentValueUsdc, so a held-but-unvalued (unquotable) balance is still
  // brought back before the repay rather than silently skipped.
  onChainAmountRaw?: string;
}

// A trimmed view of the carry-trade advisor response, folded INTO the loan card
// (one card, not two). The drawer owns the fetch; we only render.
interface CarryAdvisorView {
  applicable?: boolean;
  recommendation: {
    action: "park" | "repay" | "hold" | "move_vault" | "unavailable";
    message: string;
    netSpreadPct: number | null;
    bestAsset: { displayName: string; apyPct: number } | null;
    // Set only when action is "move_vault": the higher-yield vault to relocate to.
    moveTo?: { assetKey: string; displayName: string; apyPct: number } | null;
    // The vault the carry is JUDGED on: the bot's actual parked vault when it has
    // funds parked, otherwise the best-ranked destination. `apyPct` is null when
    // the active vault's yield could not be measured.
    activeAsset: { assetKey: string; displayName: string; apyPct: number | null; isParked: boolean } | null;
  } | null;
  borrowAprPct?: number | null;
}

// Loan-health chip. Brand rule: green is reserved for the Bot Balance number, so
// "Healthy" is a quiet neutral with a check (nothing to do); risk escalates amber
// → red. No orange anywhere. Liquidatable is always red.
const HEALTH_CHIP: Record<
  string,
  { label: string; cls: string; Icon: ElementType }
> = {
  healthy: { label: "Healthy", cls: "border-border bg-muted/50 text-muted-foreground", Icon: Check },
  nudge: { label: "Watch", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-500", Icon: AlertCircle },
  urgent: { label: "At Risk", cls: "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-500", Icon: AlertTriangle },
  liquidation: { label: "Critical", cls: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-500", Icon: AlertTriangle },
};

// Real collateral icon (Helius DAS metadata), with a graceful fallback to the
// symbol's first two letters when the mint has no icon or the image URL is dead.
// Mirrors the Wallet-tab CollateralAvatar so both lending surfaces look identical.
function CollateralAvatar({ logoURI, symbol, testId }: {
  logoURI: string | null;
  symbol: string | null;
  testId?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (logoURI && !errored) {
    return (
      <img
        src={logoURI}
        alt={symbol ?? "collateral"}
        className="w-8 h-8 rounded-full shrink-0 object-cover"
        onError={() => setErrored(true)}
        data-testid={testId}
      />
    );
  }
  return (
    <span
      className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-background shrink-0 bg-primary"
      data-testid={testId}
    >
      {symbol ? symbol.slice(0, 2) : "\u2014"}
    </span>
  );
}

// "Yield bracket" badge — a small chip showing a yield-bearing collateral's OWN
// native staking APY (e.g. INF earns SOL staking yield just by being held). Pure
// info; renders nothing for non-yield collateral (null APY). Quiet neutral styling
// (green is reserved for the Bot Balance number per the brand rule).
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

/**
 * "Manage Loan" modal (per-bot Flash loans). Three tools in one compact place, with
 * a live health bar that previews where the amounts being typed will land:
 *   - Borrow More — borrow additional USDC, backed by freshly-carved collateral so
 *     the loan stays at its safe target ratio (sized + executed by the parent).
 *   - Repay — pay the loan DOWN (it stays open). The parent runs a waterfall: the
 *     bot's own USDC first, then this bot's parked savings.
 *   - Defend This Loan — the Auto top-up flag: the server automatically adds
 *     collateral if the loan drifts toward liquidation.
 *
 * Money-safety: amounts are re-read/re-capped on-chain by the parent handlers; the
 * Borrow More and Repay ops are resumable (a persisted key finishes the SAME op).
 */
/** Small tap-to-open info icon — keeps explanatory copy out of the dialog body. */
function InfoTip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0"
          data-testid={testId}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3 text-[11px] leading-relaxed text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function DefendLoanDialog({
  open,
  onOpenChange,
  bot,
  walletAddress,
  position,
  initialAuto,
  collSym,
  onChanged,
  growMaxUsd,
  growAllowed,
  targetLtvPct,
  hasInflightGrow,
  growBusy,
  onGrow,
  growTargetLtv,
  onRepayPartial,
  repayBusy,
  hasInflightRepay,
  addCollMaxTokens,
  addCollMaxUsd,
  addCollOraclePriceUsd,
  hasInflightAddColl,
  addCollBusy,
  onAddCollateral,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bot: { id: string };
  walletAddress: string;
  position: PerbotBorrowPosition;
  initialAuto: boolean;
  collSym: string | null;
  onChanged: () => Promise<void> | void;
  // Grow ("borrow more") — sized + executed by the parent. growMaxUsd is the most
  // extra USDC this loan can safely take on; growAllowed is false when the loan is
  // above its safe ratio (the user must Defend first). onGrow resolves true only on a
  // fully-confirmed grow.
  growMaxUsd: number;
  growAllowed: boolean;
  targetLtvPct: number | null;
  hasInflightGrow: boolean;
  growBusy: boolean;
  onGrow: (amountUsd: number) => Promise<boolean>;
  // Repay ("pay down") — the parent runs the bot-cash → parked-savings waterfall.
  growTargetLtv: number;
  onRepayPartial: (target: "max" | { usd: number }) => Promise<boolean>;
  repayBusy: boolean;
  hasInflightRepay: boolean;
  // Add Collateral (manual carve top-up, NO new debt) — sized + executed by the
  // parent. addCollMaxTokens is the most collateral the ACCOUNT loan can release
  // while staying at its safe limit; NO bot-LTV gate (adding collateral only makes
  // this loan safer). onAddCollateral resolves true only on confirmed success.
  addCollMaxTokens: number;
  addCollMaxUsd: number;
  addCollOraclePriceUsd: number | null;
  hasInflightAddColl: boolean;
  addCollBusy: boolean;
  onAddCollateral: (amountTokens: number) => Promise<boolean>;
}) {
  const { retryAuth } = useWallet();
  const { toast } = useToast();

  const [auto, setAuto] = useState(initialAuto);
  const [savingAuto, setSavingAuto] = useState(false);
  // How much of the loan to pay DOWN (free text → parsed). Empty = nothing yet.
  const [repayAmount, setRepayAmount] = useState("");
  // How much extra USDC to borrow (free text → parsed). Prefilled to the safe max on
  // open (default-over-choice: the primary path is "grow to the max").
  const [growAmount, setGrowAmount] = useState("");
  // How much collateral (tokens) to move into this loan (free text → parsed).
  const [addCollAmount, setAddCollAmount] = useState("");

  // Keep the toggle synced to the server value whenever the modal (re)opens.
  useEffect(() => {
    if (open) setAuto(initialAuto);
  }, [open, initialAuto]);

  // Prefill the Grow amount to the safe max whenever the modal opens (default over
  // choice). Cleared when growing isn't currently allowed so a stale figure can't sit
  // in a disabled field. An in-flight grow resumes from storage, so a blank input is
  // fine there.
  useEffect(() => {
    if (!open) return;
    if (growAllowed && growMaxUsd > 0) {
      setGrowAmount((Math.floor(growMaxUsd * 100) / 100).toFixed(2));
    } else {
      setGrowAmount("");
    }
  }, [open, growAllowed, growMaxUsd]);

  // Start the Add Collateral input blank on every open (it's the corrective lever,
  // not the headline action — Grow keeps the prefilled default).
  useEffect(() => {
    if (open) setAddCollAmount("");
  }, [open]);

  // Grow ("borrow more") derived values. Max is floored to the cent so it can never
  // round ABOVE the true on-chain headroom. The Grow button is live with a valid
  // amount (and growing allowed), OR whenever an op is mid-flight to resume.
  const growMaxStr = growMaxUsd > 0 ? (Math.floor(growMaxUsd * 100) / 100).toFixed(2) : "0";
  const growEntered = parseFloat(growAmount);
  const growTooHigh = Number.isFinite(growEntered) && growEntered > growMaxUsd + 0.0001;
  const growAmtValid = Number.isFinite(growEntered) && growEntered > 0 && !growTooHigh;
  const canGrow = ((growAmtValid && growAllowed) || hasInflightGrow) && !growBusy && !repayBusy && !addCollBusy;

  const handleGrowClick = async () => {
    const ok = await onGrow(growEntered);
    if (ok) {
      setGrowAmount("");
      onOpenChange(false);
    }
  };

  // ADD COLLATERAL derived values. Max is floored (4 dp) so the display can never
  // round ABOVE the true carve headroom; typing at/near the max snaps to the exact
  // raw max in the parent. Available even when the loan sits ABOVE its safe ratio —
  // this is the fix-it direction.
  const addCollMaxStr = addCollMaxTokens > 0 ? (Math.floor(addCollMaxTokens * 10000) / 10000).toFixed(4) : "0";
  const addCollEntered = parseFloat(addCollAmount);
  const addCollTooHigh = Number.isFinite(addCollEntered) && addCollEntered > addCollMaxTokens + addCollMaxTokens * 1e-6 + 1e-9;
  const addCollValid = Number.isFinite(addCollEntered) && addCollEntered > 0 && !addCollTooHigh;
  const canAddColl = (addCollValid || hasInflightAddColl) && !addCollBusy && !growBusy && !repayBusy;

  const handleAddCollClick = async () => {
    const ok = await onAddCollateral(addCollEntered);
    if (ok) {
      setAddCollAmount("");
      onOpenChange(false);
    }
  };

  const handleToggleAuto = async (next: boolean) => {
    if (savingAuto) return;
    const prev = auto;
    setAuto(next);
    setSavingAuto(true);
    try {
      const res = await fetch(`/api/trading-bots/${bot.id}?wallet=${walletAddress}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ autoCollateralTopUp: next }),
      });
      const d = await safeResponseJson(res);
      if (!res.ok) throw new Error(d.error || "Could not update auto top-up.");
      toast({
        title: next ? "Auto Top-Up On" : "Auto Top-Up Off",
        description: next
          ? "This loan will be topped up automatically if it drifts toward liquidation."
          : "Automatic top-ups are off for this loan.",
      });
      await onChanged();
    } catch (e: any) {
      setAuto(prev);
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Update failed", retry: () => handleToggleAuto(next) });
      } else {
        toast({ title: "Update failed", description: e?.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setSavingAuto(false);
    }
  };

  // LIVE health header — same inputs/ramp as the loan card so they never disagree.
  const h = position.health;
  const collValueUsd = h.collateralValueUsd;
  const liveDebtUsd = h.debtUsd;
  const posMaxLtv = position.maxLtv;
  const currentLtv =
    collValueUsd != null && collValueUsd > 0 && liveDebtUsd != null ? liveDebtUsd / collValueUsd : null;
  // Bar geometry (frame to liquidation, Safe / Max Borrow / Liquidation markers) —
  // shared math so this header matches the loan card exactly.
  const barModel = getLtvBarModel({
    currentLtv,
    maxLtv: posMaxLtv,
    liquidationThreshold: position.liquidationThreshold ?? null,
  });
  const band = h.band;
  const chip = band && band !== "unavailable" ? HEALTH_CHIP[band] : null;
  const ChipIcon = chip?.Icon;
  const chipTextCls = chip ? chip.cls.split(" ").filter((c) => c.includes("text-")).join(" ") : "text-muted-foreground";

  // REPAY ("pay down") derived. Max = the full live debt (floored to the cent so it
  // can never round ABOVE it). Repaying is the safe direction, so an over-typed amount
  // just clears the balance. The button is live with a valid amount, OR to FINISH an
  // unfinished pay-down (which resumes toward its persisted target).
  const repayMaxStr = liveDebtUsd != null && liveDebtUsd > 0 ? (Math.floor(liveDebtUsd * 100) / 100).toFixed(2) : "0";
  const repayEntered = parseFloat(repayAmount);
  const repayValid = liveDebtUsd != null && Number.isFinite(repayEntered) && repayEntered > 0;
  const repayTooHigh = liveDebtUsd != null && Number.isFinite(repayEntered) && repayEntered > liveDebtUsd + 0.005;
  const canRepay = (repayValid || hasInflightRepay) && !repayBusy && !growBusy && !addCollBusy;

  const handleRepayClick = async () => {
    let ok: boolean;
    if (hasInflightRepay && !repayValid) {
      // Resume an unfinished pay-down — the parent drives to its persisted target, so
      // the argument here is ignored on a resume.
      ok = await onRepayPartial("max");
    } else {
      // Typing at/above the full balance clears it outright; otherwise pay that much down.
      const full = liveDebtUsd != null && repayEntered >= liveDebtUsd - 0.005;
      ok = await onRepayPartial(full ? "max" : { usd: repayEntered });
    }
    if (ok) {
      setRepayAmount("");
      onOpenChange(false);
    }
  };

  // LIVE PREVIEW — reflect the amounts being typed so the user SEES where this change
  // lands before committing. Borrowing more raises debt AND adds fresh collateral
  // (carved at the target ratio); repaying lowers debt only; adding collateral raises
  // collateral only (debt unchanged → ratio falls). Fail-closed: no preview when the
  // base inputs are unreadable.
  const previewBorrowUsd = growAllowed && growAmtValid ? growEntered : 0;
  const previewRepayUsd = liveDebtUsd != null && repayValid ? Math.min(repayEntered, liveDebtUsd) : 0;
  const previewAddCollUsd =
    addCollValid && addCollOraclePriceUsd != null && addCollOraclePriceUsd > 0
      ? addCollEntered * addCollOraclePriceUsd
      : 0;
  const previewActive =
    collValueUsd != null && liveDebtUsd != null && (previewBorrowUsd > 0 || previewRepayUsd > 0 || previewAddCollUsd > 0);
  const projDebtUsd = liveDebtUsd != null ? Math.max(0, liveDebtUsd + previewBorrowUsd - previewRepayUsd) : null;
  const addedCollUsd = (growTargetLtv > 0 ? previewBorrowUsd / growTargetLtv : 0) + previewAddCollUsd;
  const projCollUsd = collValueUsd != null ? collValueUsd + addedCollUsd : null;
  const projLtv =
    projCollUsd != null && projCollUsd > 0 && projDebtUsd != null ? projDebtUsd / projCollUsd : null;
  const previewBarModel = getLtvBarModel({
    currentLtv: projLtv,
    maxLtv: posMaxLtv,
    liquidationThreshold: position.liquidationThreshold ?? null,
  });
  const showPreview = previewActive && previewBarModel.fillPct != null;
  const shownModel = showPreview ? previewBarModel : barModel;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!repayBusy && !growBusy && !addCollBusy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-defend-loan">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="w-4 h-4 text-primary" />
            Manage Loan
          </DialogTitle>
          <DialogDescription>
            Borrow more, repay, or add collateral.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Health header — mirrors the loan card's live bar, and previews where the
              amounts being typed will land BEFORE the user commits. */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Loan Health</span>
              {chip && ChipIcon && (
                <span className={`inline-flex items-center gap-1 ${chipTextCls}`} data-testid="text-defend-health">
                  <ChipIcon className="w-3.5 h-3.5" />
                  {chip.label}
                </span>
              )}
            </div>
            {shownModel.fillPct != null ? (
              <LtvBar
                model={shownModel}
                currentLtvLabel={
                  showPreview
                    ? (projLtv != null ? `${Math.round(projLtv * 100)}% LTV projected` : null)
                    : (currentLtv != null ? `${Math.round(currentLtv * 100)}% LTV` : null)
                }
                testId="defend-health"
              />
            ) : (
              <p className="text-[11px] text-muted-foreground">Health unavailable right now.</p>
            )}
            {showPreview && currentLtv != null && projLtv != null && (
              <p className="text-[11px] text-primary" data-testid="text-defend-ltv-preview">
                Now {Math.round(currentLtv * 100)}% → {Math.round(projLtv * 100)}% after this change.
              </p>
            )}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
              <span data-testid="text-defend-debt">
                Borrowed {fmtUsd(liveDebtUsd)}
                {showPreview && projDebtUsd != null && Math.abs(projDebtUsd - (liveDebtUsd ?? 0)) > 0.005 ? ` → ${fmtUsd(projDebtUsd)}` : ""}
              </span>
              <span data-testid="text-defend-collateral">
                Backed by {fmtUsd(collValueUsd)}
                {showPreview && projCollUsd != null && Math.abs(projCollUsd - (collValueUsd ?? 0)) > 0.005 ? ` → ${fmtUsd(projCollUsd)}` : ""}
              </span>
            </div>
          </div>

          {/* Borrow More — borrow additional USDC, backed by freshly-carved collateral.
              Sized + executed by the parent; here we only collect the amount. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium">Borrow More</label>
                <InfoTip testId="info-grow">
                  Borrows more USDC into this bot, backed by extra {collSym ?? "collateral"} carved
                  from your vault{targetLtvPct != null ? ` — the loan stays at its ${targetLtvPct}% safe ratio` : ""}.
                </InfoTip>
              </div>
              {growAllowed && growMaxUsd > 0 && (
                <span className="text-[11px] text-muted-foreground" data-testid="text-grow-max">
                  up to {fmtUsd(growMaxUsd)}
                </span>
              )}
            </div>

            {!growAllowed && !hasInflightGrow ? (
              growMaxUsd > 0 ? (
                <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid="text-grow-blocked">
                  Above its safe ratio — repay a little first.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground" data-testid="text-grow-unavailable">
                  No spare {collSym ?? "collateral"} in your vault right now.
                </p>
              )
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={growAmount}
                    onChange={(e) => setGrowAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 min-w-0"
                    data-testid="input-grow-amount"
                  />
                  <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-xs" onClick={() => setGrowAmount(growMaxStr)} disabled={growMaxUsd <= 0} data-testid="button-grow-max">
                    Max
                  </Button>
                  <Button
                    className="h-9 px-3"
                    onClick={handleGrowClick}
                    disabled={!canGrow}
                    data-testid="button-grow-loan"
                  >
                    {growBusy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                    {hasInflightGrow && !growAmtValid ? "Finish" : "Borrow"}
                  </Button>
                </div>
                {growTooHigh && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid="text-grow-amount-hint">
                    Most you can safely borrow now is {fmtUsd(growMaxUsd)}.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Repay — pay this loan DOWN (it stays open). The parent runs the waterfall:
              the bot's own USDC first, then this bot's parked savings. */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium">Repay</label>
                <InfoTip testId="info-repay">
                  Pays this loan down using the bot's own cash first, then its parked savings.
                  Your collateral stays put and the loan stays open.
                </InfoTip>
              </div>
              {liveDebtUsd != null && (
                <span className="text-[11px] text-muted-foreground" data-testid="text-repay-owed">
                  {fmtUsd(liveDebtUsd)} owed
                </span>
              )}
            </div>

            {hasInflightRepay && (
              <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid="text-repay-inflight">
                Unfinished repay — tap Finish to complete it.
              </p>
            )}

            <div className="flex items-center gap-2">
              <Input
                type="text"
                inputMode="decimal"
                value={repayAmount}
                onChange={(e) => setRepayAmount(e.target.value)}
                placeholder="0.00"
                className="flex-1 min-w-0"
                data-testid="input-repay-amount"
              />
              <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-xs" onClick={() => setRepayAmount(repayMaxStr)} disabled={liveDebtUsd == null || liveDebtUsd <= 0} data-testid="button-repay-max">
                Max
              </Button>
              <Button
                variant="outline"
                className="h-9 px-3"
                onClick={handleRepayClick}
                disabled={!canRepay}
                data-testid="button-repay-loan"
              >
                {repayBusy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                {hasInflightRepay && !repayValid ? "Finish" : "Repay"}
              </Button>
            </div>
            {repayTooHigh && (
              <p className="text-[11px] text-muted-foreground" data-testid="text-repay-amount-hint">
                That's more than you owe — we'll just clear the balance.
              </p>
            )}
          </div>

          {/* Add Collateral — move spare collateral from the ACCOUNT loan into THIS
              loan (no new borrowing). Neutral lever: lowers the ratio, which both
              protects the loan AND unlocks room to borrow more — user's call.
              Available even ABOVE the safe ratio. */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium">Add Collateral</label>
                <InfoTip testId="info-addcoll">
                  Moves spare {collSym ?? "collateral"} from your account loan into this bot's loan —
                  nothing new is borrowed. More collateral lowers this loan's ratio, which you can
                  use as extra safety or as room to borrow more against it. If none is spare,
                  repaying your account loan frees some (every $1 repaid frees about $2 of {collSym ?? "collateral"}).
                </InfoTip>
              </div>
              {addCollMaxTokens > 0 && (
                <span className="text-[11px] text-muted-foreground" data-testid="text-addcoll-max">
                  up to {addCollMaxStr} {collSym ?? ""}{addCollMaxUsd > 0 ? ` (~${fmtUsd(addCollMaxUsd)})` : ""}
                </span>
              )}
            </div>

            {hasInflightAddColl && (
              <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid="text-addcoll-inflight">
                Unfinished add — tap Finish to complete it.
              </p>
            )}

            {addCollMaxTokens <= 0 && !hasInflightAddColl ? (
              <p className="text-[11px] text-muted-foreground" data-testid="text-addcoll-unavailable">
                None spare right now — your account loan is at its safe limit.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={addCollAmount}
                    onChange={(e) => setAddCollAmount(e.target.value)}
                    placeholder="0.0000"
                    className="flex-1 min-w-0"
                    data-testid="input-addcoll-amount"
                  />
                  <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-xs" onClick={() => setAddCollAmount(addCollMaxStr)} disabled={addCollMaxTokens <= 0} data-testid="button-addcoll-max">
                    Max
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 px-3"
                    onClick={handleAddCollClick}
                    disabled={!canAddColl}
                    data-testid="button-add-collateral"
                  >
                    {addCollBusy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                    {hasInflightAddColl && !addCollValid ? "Finish" : "Add"}
                  </Button>
                </div>
                {addCollTooHigh && (
                  <p className="text-[11px] text-destructive" data-testid="text-addcoll-amount-hint">
                    More than your account loan can safely release — up to {addCollMaxStr} {collSym ?? ""} right now.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Auto top-up — single compact row (old "Defend This Loan" header merged in). */}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-sm font-medium">Auto Top-Up</p>
              <InfoTip testId="info-auto-topup">
                If this loan drifts toward liquidation, we automatically add {collSym ?? "collateral"} from
                your account to keep it safe.
              </InfoTip>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {savingAuto && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
              <Switch checked={auto} onCheckedChange={handleToggleAuto} disabled={savingAuto} data-testid="switch-defend-auto" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PerbotBorrowControls({
  bot,
  walletAddress,
  active,
  onChanged,
  advisor,
  advisorLoading,
}: {
  bot: { id: string; autoParkIdle?: boolean } | null;
  walletAddress: string;
  active: boolean;
  onChanged: () => void;
  advisor?: CarryAdvisorView | null;
  advisorLoading?: boolean;
}) {
  const { retryAuth } = useWallet();
  const { toast } = useToast();

  const [data, setData] = useState<PerbotPositionsResponse | null>(null);
  const [busy, setBusy] = useState<"borrow" | "repay" | "move" | "grow" | "addcoll" | null>(null);
  const [confirm, setConfirm] = useState<"borrow" | "repay" | null>(null);
  // How much USDC the user wants to borrow (free text → parsed). Empty = nothing yet.
  const [amount, setAmount] = useState("");
  // Which collateral to borrow against, by mint. null = use the safest-ranked
  // default. Only surfaced as a picker when the account has 2+ borrowable
  // collaterals; today only INF is live so this stays invisible until a second one
  // lands. Reset on bot/wallet switch so a pick never carries across bots.
  const [selectedCarryMint, setSelectedCarryMint] = useState<string | null>(null);
  // True when a borrow op for THIS bot is mid-flight (a clientRequestId is persisted
  // but no open position is visible yet, e.g. after a 202). Lets the user RESUME the
  // exact same op — with the exact same persisted amounts — even if the input is blank.
  const [hasInflightBorrow, setHasInflightBorrow] = useState(false);
  // True when a GROW op (borrow MORE against fresh collateral) for THIS bot's open
  // position is mid-flight — same resume semantics as hasInflightBorrow, but keyed by
  // the position id so it can never leak across loans.
  const [hasInflightGrow, setHasInflightGrow] = useState(false);
  // True when a partial pay-DOWN for THIS bot's open position is unfinished — the
  // fixed target final-debt is persisted, so a re-tap / crash-resume converges to the
  // SAME target instead of stacking repays. Keyed by the position id.
  const [hasInflightRepay, setHasInflightRepay] = useState(false);
  // True when a manual ADD-COLLATERAL (carve from the account loan, NO new debt)
  // for THIS bot's open position is mid-flight — same resume semantics as
  // hasInflightGrow, keyed by the position id so it can never leak across loans.
  const [hasInflightAddColl, setHasInflightAddColl] = useState(false);
  // "Manage Loan" modal (Borrow More + Repay + Defend it: Auto top-up).
  const [defendOpen, setDefendOpen] = useState(false);
  // The drawer is a single reused instance: a slow response for a previous
  // bot/wallet must never overwrite the current one.
  const reqRef = useRef(0);

  // Durable loan INTENT (Carry vs Repay). Carry = keep the loan and earn yield on the
  // borrowed cash → persisted as autoParkIdle=true (which also makes future borrows
  // auto-join the park). Repay = plan to clear it → autoParkIdle=false. Optimistic;
  // reverts on failure; re-syncs to the server value whenever the parent refetches the
  // bot. Intent only — selecting a plan NEVER moves money.
  const [selectedIntent, setSelectedIntent] = useState<"carry" | "repay">(
    bot?.autoParkIdle ? "carry" : "repay",
  );
  const [savingIntent, setSavingIntent] = useState(false);
  useEffect(() => {
    setSelectedIntent(bot?.autoParkIdle ? "carry" : "repay");
    // A bot/wallet switch must also clear any in-flight saving state so the new bot
    // never inherits a stuck spinner (a slow PATCH for the old bot is guarded below).
    setSavingIntent(false);
  }, [bot?.id, bot?.autoParkIdle]);

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
  // GROW is keyed by the exact open-position id (borrow-more against fresh collateral
  // on an EXISTING loan), so an in-flight grow can never leak into a different loan.
  const growKey = (positionId: string) => `qv:perbot-borrow:grow:${bot?.id}:${positionId}`;
  const growRawsKey = (positionId: string) => `qv:perbot-borrow:grow-raws:${bot?.id}:${positionId}`;
  // ADD COLLATERAL (manual carve top-up, NO new debt) is keyed by the exact open-
  // position id, same as grow, so an in-flight add can never leak into another loan.
  const addCollKey = (positionId: string) => `qv:perbot-borrow:addcoll:${bot?.id}:${positionId}`;
  const addCollRawsKey = (positionId: string) => `qv:perbot-borrow:addcoll-raws:${bot?.id}:${positionId}`;
  // REPAY (partial pay-DOWN) stores only a FIXED target final-debt (raw), keyed by the
  // exact position id. Re-tapping / resuming drives to this same target, so a double-
  // submit can never repay past the user's intended amount.
  const repayTargetKey = (positionId: string) => `qv:perbot-borrow:repay-target:${bot?.id}:${positionId}`;

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
        // Surface whether a GROW op for THIS open position is still mid-flight so it
        // stays resumable after a reload or bot switch (a 202 may have landed while the
        // tab was closed). Keyed by the position id so it can never leak across loans.
        let growInflight = false;
        try {
          growInflight = !!localStorage.getItem(growKey(next.positions[0].id));
        } catch {
          /* ignore */
        }
        setHasInflightGrow(growInflight);
        // Same for a mid-flight REPAY (pay-down) op on this loan — resumable after a
        // reload or switch. Keyed by position id so it can't leak across loans.
        let repayInflight = false;
        try {
          repayInflight = !!localStorage.getItem(repayTargetKey(next.positions[0].id));
        } catch {
          /* ignore */
        }
        setHasInflightRepay(repayInflight);
        // Same for a mid-flight manual ADD-COLLATERAL on this loan.
        let addCollInflight = false;
        try {
          addCollInflight = !!localStorage.getItem(addCollKey(next.positions[0].id));
        } catch {
          /* ignore */
        }
        setHasInflightAddColl(addCollInflight);
      } else {
        // No open position yet — surface whether a borrow op is still mid-flight so
        // the user can RESUME it (the input may be blank, e.g. after a switch). With
        // no open position there can be no grow, so clear that flag.
        let inflight = false;
        try {
          inflight = !!localStorage.getItem(openKey());
        } catch {
          /* ignore */
        }
        setHasInflightBorrow(inflight);
        setHasInflightGrow(false);
        setHasInflightRepay(false);
        setHasInflightAddColl(false);
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
    setSelectedCarryMint(null);
    if (active && bot && walletAddress) {
      fetchPositions();
    } else {
      reqRef.current++;
      setData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bot?.id, walletAddress]);

  const openPos = data?.positions?.[0] ?? null;

  // All collateral sources this bot's account could borrow against right now.
  const availableSources = (data?.carrySources ?? []).filter((s) => s.available);
  // Rank "safest to borrow against" first: stablecoin-type collateral (no native
  // staking yield → no underlying price volatility against the USDC debt) before
  // yield-bearing LSTs, then the one that lets you borrow the most (largest
  // headroom) as a tie-break. This is the DEFAULT the picker lands on, so a
  // hands-off user always borrows against the least-risky collateral without ever
  // touching a knob. (Ranking confirmed with the owner — see task-220.)
  const rankedSources = [...availableSources].sort((a, b) => {
    const aStable = !(a.stakingApyPct != null && a.stakingApyPct > 0);
    const bStable = !(b.stakingApyPct != null && b.stakingApyPct > 0);
    if (aStable !== bStable) return aStable ? -1 : 1;
    let aMax = 0;
    let bMax = 0;
    try { aMax = Number(BigInt(a.maxBorrowRaw)); } catch { aMax = 0; }
    try { bMax = Number(BigInt(b.maxBorrowRaw)); } catch { bMax = 0; }
    return bMax - aMax;
  });
  // The source actually in play: the user's explicit pick (by collateral mint) when
  // more than one exists, else the safest-ranked default. Never a stale mint — falls
  // back to the default if the chosen collateral is no longer borrowable.
  const carrySrc =
    rankedSources.length === 0
      ? null
      : (selectedCarryMint
          ? rankedSources.find((s) => s.collateralMint === selectedCarryMint) ?? rankedSources[0]
          : rankedSources[0]);

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
      let raws: { carveRaw: string; requestedDebtRaw: string; collateralMint?: string } | null = null;
      // The collateral the borrow is actually opened against. On a FRESH borrow this is
      // the currently-selected source. On a RESUME it MUST be the mint the persisted
      // amounts were computed for — the carve raws are denominated in that collateral —
      // NOT whatever the picker happens to show now. Persisting it makes the mint part
      // of the op identity so a resume can never route stale amounts at a different
      // collateral (e.g. user switches the picker after a failed-but-persisted attempt).
      let postCollateralMint = carrySrc.collateralMint;

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
        // Prefer the mint the amounts were computed for. (Legacy in-flight ops persisted
        // before this field existed fall back to the current source; today that is always
        // the sole collateral, so it stays correct.)
        if (raws.collateralMint) postCollateralMint = raws.collateralMint;
      } else {
        // FRESH: compute from the input, then persist the raws (with the collateral mint)
        // BEFORE the id so we can never end up with an id that has no amounts to resume from.
        const fresh = computeBorrowRaws(parseFloat(amount));
        if (!fresh) {
          toast({ title: "Enter an amount", description: "Enter how much USDC you'd like to borrow.", variant: "destructive" });
          return;
        }
        raws = { ...fresh, collateralMint: postCollateralMint };
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
          collateralMint: postCollateralMint,
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
        // Confirm the EXACT amount the user asked for (the debt raws we sent),
        // not the server's post-settle `suggestedParkAmountUsdc` — that figure can
        // trail the on-chain debt as it settles and would flash a partial (e.g.
        // "$8" then "$10") on the confirmation. `raws.requestedDebtRaw` is the
        // amount actually requested and is present on both the fresh and resume
        // paths. USDC debt = 6 decimals. Falls back to the server figure only if
        // the raws are somehow unreadable.
        let requestedUsd: number | null = null;
        try {
          if (raws?.requestedDebtRaw) {
            const dec = carrySrc.debtDecimals ?? 6;
            requestedUsd = Number(BigInt(raws.requestedDebtRaw)) / 10 ** dec;
          }
        } catch {
          requestedUsd = null;
        }
        const usd =
          requestedUsd != null && Number.isFinite(requestedUsd) && requestedUsd > 0
            ? requestedUsd
            : typeof d.suggestedParkAmountUsdc === "number"
              ? d.suggestedParkAmountUsdc
              : null;
        const sym = carrySrc.collateralSymbol ?? (carrySrc.collateralAssetKey ? carrySrc.collateralAssetKey.toUpperCase() : null);
        const against = sym ? ` against your ${sym}` : "";
        toast({
          title: "USDC Borrowed",
          description: usd != null
            ? `Borrowed ${fmtUsd(usd)} into this bot${against}.`
            : `Borrowed USDC into this bot${against}.`,
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

  // Grow an EXISTING loan: carve MORE collateral from the account vault and borrow
  // MORE USDC into this bot's open position. Mirrors handleBorrow's resume model but
  // is keyed by the position id (growKey/growRawsKey) and hits /perbot/grow. Returns
  // true only on a fully-confirmed grow (so the modal can close + clear its input).
  const handleGrow = async (amountUsd: number): Promise<boolean> => {
    // openPos is required (grow acts on an existing loan); carrySrc is required only
    // for a FRESH grow (to size the carve). A RESUME re-sends the persisted raws, so a
    // consumed/hidden carve source must NOT block finishing an in-flight grow.
    if (!bot || !openPos) return false;
    const positionId = openPos.id;
    setBusy("grow");
    try {
      const sessionId = await getSessionId();
      const storeKey = growKey(positionId);
      const rawsKey = growRawsKey(positionId);
      let clientRequestId = localStorage.getItem(storeKey);
      let raws: { carveRaw: string; requestedDebtRaw: string; collateralMint?: string } | null = null;
      let postCollateralMint = carrySrc?.collateralMint;

      if (clientRequestId) {
        // RESUME: re-send the EXACT amounts the in-flight grow was created with — never
        // recompute from the live input under an existing id. If the persisted amounts
        // are gone, FAIL CLOSED: let the server settle and refresh rather than bind a
        // guessed amount to an in-flight op.
        try {
          const stored = localStorage.getItem(rawsKey);
          if (stored) raws = JSON.parse(stored);
        } catch {
          raws = null;
        }
        if (!raws || !raws.carveRaw || !raws.requestedDebtRaw) {
          toast({
            title: "Finishing your last grow",
            description: "Your previous grow is still settling. Give it a moment — this view will update on its own.",
          });
          fetchPositions();
          return false;
        }
        if (raws.collateralMint) postCollateralMint = raws.collateralMint;
      } else {
        // FRESH: size from the input at the account's proven carve/borrow ratio, then
        // persist the raws (with the collateral mint) BEFORE the id so we can never end
        // up with an id that has no amounts to resume from.
        const fresh = computeBorrowRaws(amountUsd);
        if (!fresh) {
          toast({ title: "Enter an amount", description: "Enter how much more USDC you'd like to borrow.", variant: "destructive" });
          return false;
        }
        raws = { ...fresh, collateralMint: postCollateralMint };
        clientRequestId = newRequestId();
        try {
          localStorage.setItem(rawsKey, JSON.stringify(raws));
          localStorage.setItem(storeKey, clientRequestId);
        } catch {
          /* ignore */
        }
        setHasInflightGrow(true);
      }

      const res = await fetch("/api/vault/borrow/perbot/grow", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({
          botId: bot.id,
          botBorrowPositionId: positionId,
          collateralMint: postCollateralMint,
          carveRaw: raws.carveRaw,
          requestedDebtRaw: raws.requestedDebtRaw,
          sessionId,
          clientRequestId,
        }),
      });
      const d = await safeResponseJson(res);
      if (res.ok && d.ok) {
        try {
          localStorage.removeItem(storeKey);
          localStorage.removeItem(rawsKey);
        } catch {
          /* ignore */
        }
        setHasInflightGrow(false);
        // Confirm the EXACT amount asked for (the debt raws we sent), not the server's
        // post-settle figure (which can trail the on-chain debt as it settles).
        let requestedUsd: number | null = null;
        try {
          if (raws?.requestedDebtRaw) {
            const dec = carrySrc?.debtDecimals ?? 6;
            requestedUsd = Number(BigInt(raws.requestedDebtRaw)) / 10 ** dec;
          }
        } catch {
          requestedUsd = null;
        }
        const usd =
          requestedUsd != null && Number.isFinite(requestedUsd) && requestedUsd > 0
            ? requestedUsd
            : typeof d.suggestedParkAmountUsdc === "number"
              ? d.suggestedParkAmountUsdc
              : null;
        toast({
          title: "Loan Grown",
          description: usd != null
            ? `Borrowed another ${fmtUsd(usd)} into this bot.`
            : `Borrowed more USDC into this bot.`,
        });
        await refreshAll();
        return true;
      } else if (res.status === 202 || d.needsAttention) {
        // Keep the id + amounts so the next tap resumes this exact op.
        setHasInflightGrow(true);
        toast({ title: "Still Finishing", description: "The grow is still settling. Tap Grow Loan again in a moment to finish it." });
        fetchPositions();
        return false;
      } else {
        throw new Error(d.error || "Grow failed");
      }
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Grow failed", retry: () => handleGrow(amountUsd) });
      } else {
        toast({ title: "Grow failed", description: e?.message || "Something went wrong.", variant: "destructive" });
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Size a manual ADD-COLLATERAL carve from a token amount. Floored to raw so it can
  // never round ABOVE what was typed; within a hair of the max (or above) → use the
  // server's proven maxCarveRaw verbatim (mirrors computeBorrowRaws' ~1-cent path).
  const computeAddCollRaw = (amountTokens: number): string | null => {
    if (!carrySrc) return null;
    let maxCarveRaw: bigint;
    try {
      maxCarveRaw = BigInt(carrySrc.maxCarveRaw);
    } catch {
      return null;
    }
    if (maxCarveRaw <= 0n) return null;
    if (!Number.isFinite(amountTokens) || amountTokens <= 0) return null;
    const dec = carrySrc.collateralDecimals;
    const raw = BigInt(Math.floor(amountTokens * 10 ** dec));
    if (raw <= 0n) return null;
    const eps = BigInt(Math.max(1, Math.round(10 ** dec / 1000)));
    if (raw + eps >= maxCarveRaw) return maxCarveRaw.toString();
    return raw.toString();
  };

  // Manual ADD COLLATERAL: carve collateral OUT of the ACCOUNT loan (gated so the
  // account stays at its safe ratio) and supply it into THIS bot's open loan. NO new
  // debt — this only makes the bot's loan safer. Mirrors handleGrow's resume model
  // (persisted id + exact raw amount until confirmed success), keyed by position id.
  const handleAddCollateral = async (amountTokens: number): Promise<boolean> => {
    if (!bot || !openPos) return false;
    const positionId = openPos.id;
    setBusy("addcoll");
    try {
      const sessionId = await getSessionId();
      const storeKey = addCollKey(positionId);
      const rawsKey = addCollRawsKey(positionId);
      let clientRequestId = localStorage.getItem(storeKey);
      let raws: { carveRaw: string } | null = null;

      if (clientRequestId) {
        // RESUME: re-send the EXACT amount the in-flight op was created with — never
        // recompute from the live input under an existing id. Missing amounts → fail
        // closed and let the server settle.
        try {
          const stored = localStorage.getItem(rawsKey);
          if (stored) raws = JSON.parse(stored);
        } catch {
          raws = null;
        }
        if (!raws || !raws.carveRaw) {
          toast({
            title: "Finishing your last add",
            description: "Your previous add-collateral is still settling. Give it a moment — this view will update on its own.",
          });
          fetchPositions();
          return false;
        }
      } else {
        // FRESH: size from the input, persist the raw BEFORE the id so we can never
        // end up with an id that has no amount to resume from.
        const fresh = computeAddCollRaw(amountTokens);
        if (!fresh) {
          toast({ title: "Enter an amount", description: `Enter how much ${collSym ?? "collateral"} to move into this loan.`, variant: "destructive" });
          return false;
        }
        raws = { carveRaw: fresh };
        clientRequestId = newRequestId();
        try {
          localStorage.setItem(rawsKey, JSON.stringify(raws));
          localStorage.setItem(storeKey, clientRequestId);
        } catch {
          /* ignore */
        }
        setHasInflightAddColl(true);
      }

      const res = await fetch("/api/vault/borrow/perbot/add-collateral", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({
          botId: bot.id,
          botBorrowPositionId: positionId,
          carveRaw: raws.carveRaw,
          sessionId,
          clientRequestId,
        }),
      });
      const d = await safeResponseJson(res);
      if (res.ok && d.ok) {
        try {
          localStorage.removeItem(storeKey);
          localStorage.removeItem(rawsKey);
        } catch {
          /* ignore */
        }
        setHasInflightAddColl(false);
        // Confirm the EXACT amount asked for (the raw we sent), in tokens.
        let tokens: number | null = null;
        try {
          const dec = carrySrc?.collateralDecimals ?? 9;
          tokens = Number(BigInt(raws.carveRaw)) / 10 ** dec;
        } catch {
          tokens = null;
        }
        toast({
          title: "Collateral Added",
          description:
            tokens != null && Number.isFinite(tokens) && tokens > 0
              ? `Moved ${tokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${collSym ?? "collateral"} from your account loan into this bot's loan.`
              : `Moved ${collSym ?? "collateral"} from your account loan into this bot's loan.`,
        });
        await refreshAll();
        return true;
      } else if (res.status === 202 || d.needsAttention) {
        // Keep the id + amount so the next tap resumes this exact op.
        setHasInflightAddColl(true);
        toast({ title: "Still Finishing", description: "The add is still settling. Tap Add Collateral again in a moment to finish it." });
        fetchPositions();
        return false;
      } else {
        throw new Error(d.error || "Add collateral failed");
      }
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Add collateral failed", retry: () => handleAddCollateral(amountTokens) });
      } else {
        toast({ title: "Add collateral failed", description: e?.message || "Something went wrong.", variant: "destructive" });
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleRepay = async () => {
    if (!bot || !openPos) return;
    setBusy("repay");
    try {
      const sessionId = await getSessionId();

      // 1. Bring back ONLY enough parked funds to cover the debt, leaving the surplus
      //    earning yield. The close repays the debt from the bot's USDC, so we must
      //    unpark at least the principal — but not the whole vault. All parked yield
      //    assets are USD stablecoins (~$1), and any that appreciate (USD*, ONyc) sell
      //    for >=$1, so sizing the token amount ~= the USDC still needed is safe: the
      //    server clamps every amount to the live balance, and the close route is
      //    fail-closed + retryable if a sale under-delivers, so we can never strand the
      //    loan half-repaid. (Old behavior unparked EVERYTHING, needlessly pulling
      //    funds out of yield to clear a small debt.)
      const pres = await fetch(
        `/api/vault/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
        { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
      );
      const pdata = await safeResponseJson(pres);
      if (!pres.ok) throw new Error(pdata.error || "Could not read parked funds.");
      const parked: ParkedPositionView[] = (pdata.positions ?? []).filter(
        (p: ParkedPositionView) => {
          // Detect by RAW on-chain balance, not the valued USDC — a held-but-
          // unquotable balance must still be considered as a source, not skipped.
          try {
            return BigInt(p.onChainAmountRaw ?? "0") > 0n;
          } catch {
            return false;
          }
        },
      );
      // Conservative (never-under-read) debt + a small buffer for swap slippage and
      // stablecoin price drift, so one pass covers the principal in the common case.
      const debtForRepay = Number(openPos.debtAmountRaw ?? 0) / 1e6;
      const REPAY_UNPARK_BUFFER_MULT = 1.05; // +5% for swap slippage
      const REPAY_UNPARK_BUFFER_FLAT = 0.25; // +$0.25 for rounding / price drift
      const targetUsdc = debtForRepay > 0 ? debtForRepay * REPAY_UNPARK_BUFFER_MULT + REPAY_UNPARK_BUFFER_FLAT : 0;
      let unparkedUsdc = 0;
      for (const p of parked) {
        if (unparkedUsdc >= targetUsdc) break; // enough cash to repay — leave the rest earning
        const remainingUsdc = targetUsdc - unparkedUsdc;
        const ures = await fetch("/api/vault/unpark", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
          credentials: "include",
          // amountToken ~= USDC still needed (stablecoin ~1:1); server clamps to the
          // live balance, so asking for more than is parked just sells all of it.
          body: JSON.stringify({ assetKey: p.assetKey, amountToken: remainingUsdc, sessionId, botId: bot.id }),
        });
        const udata = await safeResponseJson(ures);
        if (!ures.ok) throw new Error(udata.error || `Could not bring back ${p.displayName || p.assetKey}.`);
        unparkedUsdc += Number(udata.usdcReceived ?? 0);
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
        // A full close clears the whole loan, so any lingering partial pay-DOWN target
        // for this position is moot — drop it so it can't resume against a closed loan.
        try { localStorage.removeItem(repayTargetKey(openPos.id)); } catch { /* ignore */ }
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

  // Partial pay-DOWN (keep the loan OPEN, just lower the debt). WATERFALL:
  //   1. the bot's OWN idle USDC first, then
  //   2. this bot's PARKED vault cash (unpark just enough → repay).
  // Account-vault cash and selling the collateral are DEFERRED (each needs its own
  // resumable server op) and surfaced to the owner as follow-ups.
  //
  // Money-safety:
  //  - A FIXED target final-debt is computed ONCE per run and persisted, so a re-tap
  //    or crash-resume drives to the SAME target — never stacking repays past intent.
  //  - We only ever send an EXACT raw amount ≤ a proven lower bound of the bot's USDC
  //    (fresh read + tracked unpark receipts), never "max", so the executor's strict
  //    re-read can't trip the interest-buffer check and fail a leg mid-waterfall.
  //  - The server caps every repay at the LIVE debt (never over-repays) and fails
  //    closed if the bot's USDC is short, and unpark lands funds as bot USDC first —
  //    so an interrupted run always leaves funds safe, never stranded.
  // target: "max" clears the whole balance; { usd } pays that much down.
  const handleRepayPartial = async (target: "max" | { usd: number }): Promise<boolean> => {
    if (!bot || !openPos) return false;
    const positionId = openPos.id;
    setBusy("repay");
    const tKey = repayTargetKey(positionId);
    const DEBT_DEC = 6; // USDC
    const toBig = (v: string | null | undefined): bigint => {
      try { return BigInt(v ?? "0"); } catch { return 0n; }
    };
    try {
      const sessionId = await getSessionId();

      // FRESH authoritative read: this loan's live debt + the bot wallet's free USDC.
      // Fresh (not the cached `data`) so leg sizing is accurate and a retry picks up a
      // changed balance instead of looping on a stale figure.
      const pres0 = await fetch(
        `/api/vault/borrow/perbot/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
        { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
      );
      const pd0: PerbotPositionsResponse & { botWalletUsdcRaw?: string | null } = await safeResponseJson(pres0);
      if (!pres0.ok) throw new Error((pd0 as any)?.error || "Could not read this loan.");
      const row = (pd0.positions ?? []).find((p) => p.id === positionId) ?? null;
      // Money-path sizing REQUIRES a real LIVE debt read. The route returns
      // liveDebtRaw:null on a live-read miss and falls the DISPLAY debt
      // (row.debtAmountRaw) back to a conservative, monotonic-UP figure that can be
      // STALE right after a confirmed-but-unverified leg. Sizing `need` off that
      // stale figure would re-inflate it and over-repay past the fixed target from
      // parked savings. So NEVER size off debtAmountRaw — require liveDebtRaw; if
      // it's missing, keep the target and ask the user to retry in a moment.
      const liveDebtStr = row?.liveDebtRaw ?? null;
      if (liveDebtStr == null) {
        await refreshAll();
        toast({
          title: "Couldn't Read This Loan",
          description: "We couldn't get a live balance just now. Your target is saved — tap Repay again in a moment.",
        });
        return false;
      }
      const liveDebtRaw0 = toBig(liveDebtStr);
      // Bot USDC: an accurate read → used for leg 1 sizing. null (read failed) → treat
      // as 0 so we fall through to unparking (never sends more than we can prove held).
      let botUsdcRaw = toBig(pd0.botWalletUsdcRaw);

      if (liveDebtRaw0 <= 0n) {
        try { localStorage.removeItem(tKey); } catch { /* ignore */ }
        setHasInflightRepay(false);
        toast({ title: "Nothing to repay", description: "This loan has no balance left." });
        await refreshAll();
        return true;
      }

      // Fixed FINAL-debt target for this run. RESUME an unfinished run VERBATIM (never
      // recompute from the live input under an existing target); else compute + persist.
      let targetFinalDebtRaw: bigint;
      const persisted = (() => { try { return localStorage.getItem(tKey); } catch { return null; } })();
      if (persisted != null) {
        targetFinalDebtRaw = toBig(persisted);
      } else {
        if (target === "max") {
          targetFinalDebtRaw = 0n;
        } else {
          const reqRaw = BigInt(Math.max(0, Math.floor(target.usd * 10 ** DEBT_DEC)));
          targetFinalDebtRaw = liveDebtRaw0 > reqRaw ? liveDebtRaw0 - reqRaw : 0n;
        }
        try { localStorage.setItem(tKey, targetFinalDebtRaw.toString()); } catch { /* ignore */ }
        setHasInflightRepay(true);
      }

      let liveDebtRaw = liveDebtRaw0;
      let need = liveDebtRaw > targetFinalDebtRaw ? liveDebtRaw - targetFinalDebtRaw : 0n;

      // One repay leg from the bot's USDC — EXACT raw only. Updates liveDebtRaw from the
      // server's authoritative post-read so the next leg sizes against real remaining
      // debt. Returns { verified }: false means the tx CONFIRMED on-chain but the server
      // could not re-read the position, so `observedDebtRaw` is the stale PRE-repay debt
      // and the caller MUST stop (never size/send another leg off it → double-pay).
      const repayLeg = async (sendRaw: bigint): Promise<{ verified: boolean }> => {
        const res = await fetch("/api/vault/borrow/perbot/repay", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
          credentials: "include",
          body: JSON.stringify({ botId: bot.id, botBorrowPositionId: positionId, amountRaw: sendRaw.toString(), targetFinalDebtRaw: targetFinalDebtRaw.toString(), sessionId }),
        });
        const d = await safeResponseJson(res);
        if (!(res.ok && d.ok)) throw new Error(d?.error || "Repay failed");
        const verified = d.debtRead !== false;
        if (verified && typeof d.observedDebtRaw === "string") liveDebtRaw = toBig(d.observedDebtRaw);
        return { verified };
      };

      // A leg CONFIRMED on-chain but the post-read failed, so we can't size the next leg
      // safely. Keep the FIXED target persisted (do NOT clear it) — a later tap re-reads
      // the true (lower) debt and resumes toward the SAME amount. Repaying again now
      // would over-pay from parked savings.
      const bailUnverified = async (): Promise<boolean> => {
        await refreshAll();
        toast({
          title: "Repay Sent",
          description: "Your payment went through but is still settling. Tap Repay again in a moment to finish.",
        });
        return false;
      };

      // LEG 1 — the bot's own idle USDC.
      if (need > 0n && botUsdcRaw > 0n) {
        const send = botUsdcRaw < need ? botUsdcRaw : need;
        if (send > 0n) {
          const { verified } = await repayLeg(send);
          if (!verified) return bailUnverified();
          botUsdcRaw = botUsdcRaw > send ? botUsdcRaw - send : 0n;
          need = liveDebtRaw > targetFinalDebtRaw ? liveDebtRaw - targetFinalDebtRaw : 0n;
        }
      }

      // LEG 2 — this bot's PARKED vault cash. Unpark ~need (all parked yield assets are
      // USD stablecoins ~$1; the server clamps each amount to the live balance), which
      // lands as bot USDC, then repay from the proven amount actually brought back.
      if (need > 0n) {
        const pres = await fetch(
          `/api/vault/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
          { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
        );
        const pdata = await safeResponseJson(pres);
        if (!pres.ok) throw new Error(pdata?.error || "Could not read parked funds.");
        const parked: ParkedPositionView[] = (pdata.positions ?? []).filter((p: ParkedPositionView) => {
          try { return BigInt(p.onChainAmountRaw ?? "0") > 0n; } catch { return false; }
        });
        const BUFFER_MULT = 1.05; // +5% for swap slippage
        const BUFFER_FLAT = 0.25; // +$0.25 for rounding / price drift
        const needUsd = Number(need) / 10 ** DEBT_DEC;
        const targetUsd = needUsd * BUFFER_MULT + BUFFER_FLAT;
        let unparkedRaw = 0n;
        for (const p of parked) {
          if (Number(unparkedRaw) / 10 ** DEBT_DEC >= targetUsd) break; // enough cash — leave the rest earning
          const remainingUsd = targetUsd - Number(unparkedRaw) / 10 ** DEBT_DEC;
          const ures = await fetch("/api/vault/unpark", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
            credentials: "include",
            body: JSON.stringify({ assetKey: p.assetKey, amountToken: remainingUsd, sessionId, botId: bot.id }),
          });
          const udata = await safeResponseJson(ures);
          if (!ures.ok) throw new Error(udata?.error || `Could not bring back ${p.displayName || p.assetKey}.`);
          const got = Number(udata.usdcReceived ?? 0);
          if (Number.isFinite(got) && got > 0) unparkedRaw += BigInt(Math.floor(got * 10 ** DEBT_DEC));
        }
        // Proven upper bound of spendable bot USDC = leftover from leg 1 (accurate read)
        // + what we just unparked (receipt-based). Sending ≤ this can never trip the
        // executor's fail-closed short-balance check.
        const avail = botUsdcRaw + unparkedRaw;
        const send = avail < need ? avail : need;
        if (send > 0n) {
          const { verified } = await repayLeg(send);
          if (!verified) return bailUnverified();
          botUsdcRaw = avail > send ? avail - send : 0n;
          need = liveDebtRaw > targetFinalDebtRaw ? liveDebtRaw - targetFinalDebtRaw : 0n;
        }
      }

      // Terminal disposition. Dust tolerance ~1 cent (interest can tick the live debt a
      // hair between the size and the repay).
      const oneCent = BigInt(Math.round(10 ** DEBT_DEC / 100));
      if (need <= oneCent) {
        try { localStorage.removeItem(tKey); } catch { /* ignore */ }
        setHasInflightRepay(false);
        const cleared = targetFinalDebtRaw === 0n;
        toast({
          title: cleared ? "Loan Repaid" : "Loan Paid Down",
          description: cleared
            ? "The borrowed USDC was fully repaid. Your collateral stays pledged — use Repay Loan to return it."
            : "Paid this loan down with the bot's cash and its parked savings.",
        });
        await refreshAll();
        return true;
      }

      // Couldn't fully reach the target with the bot's cash + its parked savings (the
      // account vault and selling collateral aren't wired here yet). Keep the target so
      // a later tap resumes toward the SAME amount.
      toast({
        title: "Partly Repaid",
        description: "Used the bot's cash and its parked savings. There wasn't enough to reach your full amount — add funds or tap Repay again.",
      });
      await refreshAll();
      return false;
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Repay failed", retry: () => handleRepayPartial(target) });
      } else {
        toast({ title: "Repay failed", description: e?.message || "Something went wrong.", variant: "destructive" });
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Move the parked carry funds to a higher-yield vault. There is NO direct
  // vault-to-vault transfer, so this is a two-leg round-trip: unpark every current
  // vault back to USDC, then park all that USDC into the target vault (park also
  // persists it as the bot's new auto-park destination). This is a one-tap ACTION,
  // not automation — the user still decides when to move.
  //
  // Money-safety: each leg is fail-closed on the server. If the unpark succeeds but
  // the park is rejected (e.g. a 409 because the bot isn't flat), the funds simply
  // rest as USDC — nothing is stranded — and tapping Move again finishes the job.
  const handleMoveVault = async () => {
    const moveTo = advisorRec?.moveTo;
    if (!bot || !moveTo) return;
    setBusy("move");
    // Tracks whether the FIRST leg turned the old vault into USDC. If the second
    // (park) leg then fails, the funds rest safely as cash — the message + refresh
    // below tell the user exactly that instead of implying nothing happened.
    let movedToCash = false;
    try {
      const sessionId = await getSessionId();
      // 1. Read what's parked now and unpark every vault that ISN'T already the
      //    target, fully back to USDC. Detect by RAW on-chain balance so a held-but-
      //    unquotable balance is still moved, never skipped.
      const pres = await fetch(
        `/api/vault/positions?botId=${bot.id}&wallet=${walletAddress}&_=${Date.now()}`,
        { credentials: "include", cache: "no-store", headers: walletAuthHeaders() },
      );
      const pdata = await safeResponseJson(pres);
      if (!pres.ok) throw new Error(pdata.error || "Could not read parked funds.");
      const parked: ParkedPositionView[] = (pdata.positions ?? []).filter((p: ParkedPositionView) => {
        if (p.assetKey === moveTo.assetKey) return false; // already in the target vault
        try {
          return BigInt(p.onChainAmountRaw ?? "0") > 0n;
        } catch {
          return false;
        }
      });
      for (const p of parked) {
        const ures = await fetch("/api/vault/unpark", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
          credentials: "include",
          body: JSON.stringify({ assetKey: p.assetKey, all: true, sessionId, botId: bot.id }),
        });
        const udata = await safeResponseJson(ures);
        if (!ures.ok) throw new Error(udata.error || `Could not bring back ${p.displayName || p.assetKey}.`);
        movedToCash = true;
      }

      // 2. Park all idle USDC into the higher-yield target vault. A server 409 is
      //    authoritative (e.g. the bot isn't flat) — surface it, don't hide the button.
      const res = await fetch("/api/vault/park", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ assetKey: moveTo.assetKey, all: true, sessionId, botId: bot.id }),
      });
      const d = await safeResponseJson(res);
      if (!res.ok) throw new Error(d.error || "Could not move to the new vault.");
      toast({ title: "Vault Moved", description: `Your parked funds now earn in ${moveTo.displayName}.` });
      await refreshAll();
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Move failed", retry: () => handleMoveVault() });
      } else {
        // An interrupted move may have already turned the old vault into USDC — refresh
        // so the card never shows funds in a vault they've left, then explain the state.
        refreshAll();
        toast({
          title: "Couldn't finish the move",
          description: movedToCash
            ? "Your funds are safe as cash (USDC). Tap Move again to finish moving them into the new vault."
            : e.message || "Something went wrong — your funds were not moved.",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  // Persist the durable loan PLAN (Carry vs Repay). Optimistic with revert-on-fail.
  // Intent only — it never moves money. Selecting Carry turns auto-park ON (borrowed +
  // future idle cash joins the vault); Repay turns it OFF. The actual repay stays the
  // dedicated "Repay Loan" button.
  const handleSelectIntent = async (intent: "carry" | "repay") => {
    if (!bot || savingIntent || intent === selectedIntent) return;
    // Capture the request generation: a bot/wallet switch bumps reqRef (via
    // fetchPositions), so a slow PATCH that resolves AFTER a switch must not revert
    // or clear state that now belongs to a different bot.
    const reqAtStart = reqRef.current;
    const prev = selectedIntent;
    setSelectedIntent(intent);
    setSavingIntent(true);
    try {
      const res = await fetch(`/api/trading-bots/${bot.id}?wallet=${walletAddress}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ autoParkIdle: intent === "carry" }),
      });
      const d = await safeResponseJson(res);
      if (!res.ok) throw new Error(d.error || "Could not update the loan plan.");
      onChanged();
    } catch (e: any) {
      if (reqRef.current === reqAtStart) setSelectedIntent(prev);
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Couldn't update loan plan", retry: () => handleSelectIntent(intent) });
      } else {
        toast({ title: "Couldn't update loan plan", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      if (reqRef.current === reqAtStart) setSavingIntent(false);
    }
  };

  // Owner-gated + Flash-only. Nothing to show otherwise.
  if (!bot || !data || !data.eligible || !data.applicable) return null;
  if (!openPos && !carrySrc) return null;

  const borrowUsd = carrySrc ? Number(carrySrc.maxBorrowRaw) / 10 ** carrySrc.debtDecimals : 0;
  // Headline debt = the CONSERVATIVE (never-under-read) figure from the server, so a
  // $5.00 borrow reads $5.00 — not the protocol's slightly-smaller live debt (which
  // can settle a cent or two lower). Health/LTV below stay on the LIVE on-chain debt.
  const debtUsd = openPos ? Number(openPos.debtAmountRaw ?? 0) / 1e6 : 0;
  const band = openPos?.health?.band;
  const chip = band && band !== "unavailable" ? HEALTH_CHIP[band] : null;
  const ChipIcon = chip?.Icon;
  // The Wallet-tab health label is a plain colored text+icon (no pill), so pull just
  // the text-color classes out of the chip's pill styling.
  const chipTextCls = chip ? chip.cls.split(" ").filter((c) => c.includes("text-")).join(" ") : "text-muted-foreground";

  // LIVE health bar — inherits the Wallet-tab pool-row hierarchy. Fill = share of
  // this position's borrow capacity used (LIVE debt ÷ collateral value × max LTV).
  // Real on-chain inputs only; hidden when either is unreadable (never a fabricated
  // fill). The brand color ramp (sky → pink-purple, deliberately not red/green) is
  // shared with the Wallet page so both encode health identically.
  const collValueUsd = openPos?.health?.collateralValueUsd ?? null;
  const liveDebtUsd = openPos?.health?.debtUsd ?? null;
  const posMaxLtv = openPos?.maxLtv ?? null;
  // Current LTV = live on-chain debt ÷ collateral value. Null when either input is
  // unreadable → the bar hides (fail closed, never a fabricated fill).
  const currentLtvPct =
    collValueUsd != null && collValueUsd > 0 && liveDebtUsd != null
      ? (liveDebtUsd / collValueUsd) * 100
      : null;
  // Bar geometry (frame to liquidation, Safe / Max Borrow / Liquidation markers) —
  // shared math (getLtvBarModel) so all borrow surfaces agree.
  const barModel = getLtvBarModel({
    currentLtv: currentLtvPct != null ? currentLtvPct / 100 : null,
    maxLtv: posMaxLtv,
    liquidationThreshold: openPos?.liquidationThreshold ?? null,
  });

  // Advisor → which of the two action cards to HIGHLIGHT as recommended. park/hold ⇒
  // Carry Trade (keep the loan, earn yield); repay ⇒ Repay. Rendered as clean STATS
  // (vault yield vs borrow APR → net edge), never prose.
  const advisorRec = advisor?.applicable && advisor.recommendation ? advisor.recommendation : null;
  const recCarry = advisorRec != null && (advisorRec.action === "park" || advisorRec.action === "hold" || advisorRec.action === "move_vault");
  const recRepay = advisorRec != null && advisorRec.action === "repay";
  // Which card the user has CHOSEN as the durable plan (separate from the advisor hint).
  const carrySelected = selectedIntent === "carry";
  const repaySelected = selectedIntent === "repay";
  const fmtPct1 = (n: number | null | undefined): string =>
    n == null || !Number.isFinite(n) ? "\u2014" : `${n.toFixed(1)}%`;
  // Net edge: positive stays neutral (green is reserved for the Bot Balance number);
  // negative is amber (a warning — never green/orange).
  const netEdge = advisorRec?.netSpreadPct ?? null;
  const netEdgeCls = netEdge != null && netEdge < 0 ? "text-amber-600 dark:text-amber-500" : "text-foreground";
  const netEdgeStr =
    netEdge == null || !Number.isFinite(netEdge) ? "\u2014" : `${netEdge >= 0 ? "+" : ""}${netEdge.toFixed(1)}%`;
  // The carry stats describe the vault the advisor JUDGED on: the bot's actual
  // parked vault when it has funds parked, else the best-ranked destination. This
  // is why a parked bot's "Vault Yield" can differ from the best vault on offer.
  const activeAsset = advisorRec?.activeAsset ?? null;
  const activeVaultApyPct = activeAsset?.apyPct ?? advisorRec?.bestAsset?.apyPct ?? null;
  const activeVaultLabel = activeAsset
    ? activeAsset.isParked
      ? ` Your vault: ${activeAsset.displayName}.`
      : ` Best vault: ${activeAsset.displayName}.`
    : advisorRec?.bestAsset
      ? ` Best vault: ${advisorRec.bestAsset.displayName}.`
      : "";

  // Which collateral asset the system carved for this loan (e.g. INF). Prefer the
  // canonical cased symbol from the server (honors native ticker casing like jupSOL);
  // fall back to the asset key uppercased.
  const collSym = openPos
    ? (openPos.collateralSymbol ?? (openPos.collateralAssetKey ? openPos.collateralAssetKey.toUpperCase() : null))
    : (carrySrc?.collateralSymbol ?? (carrySrc?.collateralAssetKey ? carrySrc.collateralAssetKey.toUpperCase() : null));
  const collLogoURI = openPos?.collateralLogoURI ?? carrySrc?.collateralLogoURI ?? null;
  // The collateral's OWN native staking APY (e.g. INF earns SOL staking yield just
  // by being held). Display-only "yield bracket" badge; null → no badge.
  const collStakingApyPct = openPos?.stakingApyPct ?? carrySrc?.stakingApyPct ?? null;
  // Safe target LTV for the borrow card's info block (the ratio the bot opens at).
  const targetLtvPct =
    carrySrc?.suggestLtv != null
      ? Math.round(carrySrc.suggestLtv * 100)
      : carrySrc?.targetLtv != null
        ? Math.round(carrySrc.targetLtv * 100)
        : null;

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

  // GROW sizing. The most extra USDC this loan can safely take on = the account's
  // remaining carve headroom (same figure as a fresh borrow's max), since the bot
  // borrows against freshly-carved account collateral. Grow is ALLOWED only when the
  // bot's current LTV is at/under the safe target: we always carve at the target
  // ratio, so the added leg is at target and the loan's TOTAL LTV can only stay at or
  // fall toward target when it already sits there — if it's above target the user must
  // Defend (add collateral) first, so we route them there instead. Null/unreadable
  // health → fail closed (grow disabled). An in-flight grow is always resumable.
  const growMaxUsd = borrowUsd;
  const growTargetLtv = carrySrc?.suggestLtv ?? carrySrc?.targetLtv ?? 0.5;
  const botCurrentLtv =
    collValueUsd != null && collValueUsd > 0 && liveDebtUsd != null ? liveDebtUsd / collValueUsd : null;
  const growAllowed =
    !!carrySrc && growMaxUsd > 0 && botCurrentLtv != null && botCurrentLtv <= growTargetLtv + 0.01;

  // ADD-COLLATERAL sizing: the most collateral (tokens/USD) the account loan can
  // release while staying at its safe limit — the same carve headroom as grow, but
  // with NO bot-LTV gate: adding collateral is always the safe direction (it can
  // only lower this loan's ratio), so it stays available even above target.
  const addCollDecimals = carrySrc?.collateralDecimals ?? 9;
  let addCollMaxTokens = 0;
  try {
    addCollMaxTokens = carrySrc ? Number(BigInt(carrySrc.maxCarveRaw)) / 10 ** addCollDecimals : 0;
  } catch {
    addCollMaxTokens = 0;
  }
  const addCollOraclePriceUsd = carrySrc?.oraclePriceUsd ?? null;
  const addCollMaxUsd = addCollOraclePriceUsd != null ? addCollMaxTokens * addCollOraclePriceUsd : 0;

  return (
    <>
      {openPos ? (
        <div className="rounded-xl border border-border bg-background/40 p-4 space-y-4" data-testid="card-perbot-loan">
          {/* Loan header — collateral avatar + conservative debt headline (Wallet-tab row styling). */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <CollateralAvatar logoURI={collLogoURI} symbol={collSym} testId="img-perbot-loan-collateral" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium leading-tight">{collSym ?? "\u2014"}</p>
                  <StakingApyBadge apyPct={collStakingApyPct} testId="badge-perbot-loan-staking-apy" />
                </div>
                <p className="text-xs text-muted-foreground truncate">Carry Trade Loan</p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold tabular-nums" data-testid="text-perbot-debt">{fmtUsd(debtUsd)}</p>
              <p className="text-[11px] text-muted-foreground">borrowed</p>
            </div>
          </div>

          {/* (g) Why the figure can differ from the live protocol read. */}
          <p className="text-[11px] text-muted-foreground -mt-2" data-testid="text-perbot-debt-note">
            This is the full amount you borrowed. The lender may show a cent or two less as the position settles.
          </p>

          {/* Health — colored bar inherits the Wallet-tab hierarchy (real on-chain inputs only). */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Loan Health</span>
              {chip && ChipIcon && (
                <span className={`inline-flex items-center gap-1 ${chipTextCls}`} data-testid="text-perbot-loan-health">
                  <ChipIcon className="w-3.5 h-3.5" />
                  {chip.label}
                </span>
              )}
            </div>
            {barModel.fillPct != null ? (
              <LtvBar
                model={barModel}
                currentLtvLabel={currentLtvPct != null ? `${Math.round(currentLtvPct)}% LTV` : null}
                testId="perbot-loan"
                barTitle={`Borrow capacity used: ${Math.round(barModel.colorUsagePct ?? 0)}%`}
              />
            ) : (
              <p className="text-[11px] text-muted-foreground" data-testid="text-perbot-health-unavailable">
                Health unavailable right now.
              </p>
            )}
          </div>

          {/* Manage this loan — borrow more, repay, add collateral, auto top-up. */}
          <Button
            variant="outline"
            size="sm"
            className="w-full h-9"
            onClick={() => setDefendOpen(true)}
            data-testid="button-perbot-manage-loan"
          >
            <Landmark className="w-3.5 h-3.5 mr-1.5" />
            Manage
          </Button>

          {/* Loan plan: pick the durable intent. Each card is a selectable button; the
              advisor still HIGHLIGHTS the recommended one as a separate hint. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Loan Plan</p>
              {savingIntent && (
                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" data-testid="spinner-perbot-intent-saving" />
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Carry Trade — keep the loan, earn yield. Advisor stats, not prose. */}
              <div
                role="button"
                tabIndex={0}
                aria-pressed={carrySelected}
                onClick={() => handleSelectIntent("carry")}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    handleSelectIntent("carry");
                  }
                }}
                className={`relative rounded-lg border p-3 space-y-2.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  carrySelected
                    ? "ring-2 ring-primary border-primary bg-primary/10"
                    : "border-border bg-muted/30 hover:border-primary/40"
                }`}
                data-testid="button-perbot-select-carry"
              >
                {recCarry && (
                  <span className="absolute -top-2 left-3 inline-flex items-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm" data-testid="pill-perbot-recommended-carry">
                    Recommended
                  </span>
                )}
                {carrySelected && (
                  <span className="absolute -top-2 right-3 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm" data-testid="badge-perbot-selected-carry">
                    <Check className="w-3 h-3" /> Selected
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-semibold">Carry Trade</h4>
                </div>
                {advisorLoading && !advisorRec ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="text-carry-advisor-loading">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking the best move…
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    <div className="p-1.5 rounded-md bg-background/50">
                      <p className="text-sm font-bold tabular-nums" data-testid="stat-carry-yield">{fmtPct1(activeVaultApyPct)}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Vault Yield</p>
                    </div>
                    <div className="p-1.5 rounded-md bg-background/50">
                      <p className="text-sm font-bold tabular-nums" data-testid="stat-carry-apr">{fmtPct1(advisor?.borrowAprPct ?? null)}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Borrow APR</p>
                    </div>
                    <div className="p-1.5 rounded-md bg-background/50">
                      <p className={`text-sm font-bold tabular-nums ${netEdgeCls}`} data-testid="stat-carry-net-edge">{netEdgeStr}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Net Edge</p>
                    </div>
                  </div>
                )}
                {advisorRec?.action === "move_vault" && advisorRec.moveTo ? (
                  <div className="space-y-2" data-testid="carry-move-vault">
                    <p className="text-[11px] text-muted-foreground" data-testid="text-carry-move-hint">
                      A higher-yield vault is available. Move your parked funds to{" "}
                      <span className="font-medium text-foreground">{advisorRec.moveTo.displayName}</span> to earn{" "}
                      <span className="font-medium text-foreground tabular-nums">{fmtPct1(advisorRec.moveTo.apyPct)}</span>.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-8 px-3 text-xs border-primary/40 text-primary hover:bg-primary/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMoveVault();
                      }}
                      disabled={busy !== null}
                      data-testid="button-perbot-move-vault"
                    >
                      {busy === "move" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <TrendingUp className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Move to {advisorRec.moveTo.displayName}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Keep the loan and earn yield on the borrowed cash.
                    {activeVaultLabel}
                  </p>
                )}
              </div>

              {/* Repay — clear the loan, return collateral. */}
              <div
                role="button"
                tabIndex={0}
                aria-pressed={repaySelected}
                onClick={() => handleSelectIntent("repay")}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    handleSelectIntent("repay");
                  }
                }}
                className={`relative rounded-lg border p-3 space-y-2.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  repaySelected
                    ? "ring-2 ring-primary border-primary bg-primary/10"
                    : "border-border bg-muted/30 hover:border-primary/40"
                }`}
                data-testid="button-perbot-select-repay"
              >
                {recRepay && (
                  <span className="absolute -top-2 left-3 inline-flex items-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm" data-testid="pill-perbot-recommended-repay">
                    Recommended
                  </span>
                )}
                {repaySelected && (
                  <span className="absolute -top-2 right-3 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm" data-testid="badge-perbot-selected-repay">
                    <Check className="w-3 h-3" /> Selected
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-semibold">Repay</h4>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Brings any parked funds back to cash, clears the loan, and returns your {collSym ?? "collateral"} to your account.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 px-3 text-xs border-accent/40 text-accent hover:bg-accent/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirm("repay");
                  }}
                  disabled={busy !== null}
                  data-testid="button-perbot-repay"
                >
                  {busy === "repay" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                  Repay Loan
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        carrySrc && (
          <div className="rounded-xl border border-border bg-background/40 p-4 space-y-3" data-testid="card-perbot-borrow">
            {/* Borrow header — collateral avatar + symbol (Wallet-tab borrow styling). */}
            <div className="flex items-center gap-2.5">
              <CollateralAvatar logoURI={collLogoURI} symbol={collSym} testId="img-perbot-borrow-collateral" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold leading-tight">Borrow Against Collateral</h3>
                <p className="text-xs text-muted-foreground truncate">Backed by your {collSym ?? "account"} collateral</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Borrow extra USDC against your {collSym ? `${collSym} ` : "account "}collateral and add it to this bot's trading balance. Choose how much, up to a safe limit. Your account stays at a safe level, and you can repay anytime.
            </p>
            {/* Collateral picker — only when the account has 2+ borrowable collaterals.
                Defaults to the safest-ranked source; invisible while only one exists. */}
            {rankedSources.length >= 2 && (
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">Borrow against</span>
                <Select value={carrySrc?.collateralMint ?? ""} onValueChange={setSelectedCarryMint}>
                  <SelectTrigger className="h-9" data-testid="select-perbot-carry-source">
                    <SelectValue placeholder="Choose collateral" />
                  </SelectTrigger>
                  <SelectContent>
                    {rankedSources.map((s, i) => {
                      const sym = s.collateralSymbol ?? (s.collateralAssetKey ? s.collateralAssetKey.toUpperCase() : "Collateral");
                      return (
                        <SelectItem key={s.collateralMint} value={s.collateralMint} data-testid={`option-perbot-carry-${s.collateralMint}`}>
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{sym}</span>
                            {i === 0 && <span className="text-[10px] text-muted-foreground">Safest</span>}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
            {/* What you're borrowing against — small sectioned info blocks. */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-lg bg-muted/30">
                <div className="flex items-center justify-center gap-1">
                  <p className="text-sm font-bold tabular-nums" data-testid="stat-borrow-collateral">{collSym ?? "\u2014"}</p>
                  <StakingApyBadge apyPct={collStakingApyPct} testId="badge-perbot-borrow-staking-apy" />
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">Collateral</p>
              </div>
              <div className="p-2.5 rounded-lg bg-muted/30">
                <p className="text-sm font-bold tabular-nums" data-testid="stat-borrow-max">{fmtUsd(borrowUsd)}</p>
                <p className="text-[10px] text-muted-foreground leading-tight">Max Borrow</p>
              </div>
              <div className="p-2.5 rounded-lg bg-muted/30">
                <p className="text-sm font-bold tabular-nums" data-testid="stat-borrow-ltv">{targetLtvPct != null ? `${targetLtvPct}%` : "\u2014"}</p>
                <p className="text-[10px] text-muted-foreground leading-tight">Target LTV</p>
              </div>
            </div>
            {carrySrc?.borrowAprPct != null && (
              <p className="text-[11px] text-muted-foreground" data-testid="text-perbot-reopen-borrow-apr">
                Current borrow rate: <span className="font-semibold text-foreground tabular-nums">{fmtPct1(carrySrc.borrowAprPct)}</span> APR
              </p>
            )}
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
              className="w-full bg-gradient-to-r from-accent to-primary text-white"
              onClick={() => setConfirm("borrow")}
              disabled={busy !== null || !canBorrow}
              data-testid="button-perbot-borrow"
            >
              {busy === "borrow" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : hasInflightBorrow && !amtValid ? (
                <><Landmark className="w-4 h-4 mr-1.5" /> Finish Borrow</>
              ) : (
                <><Landmark className="w-4 h-4 mr-1.5" /> Borrow {amtValid ? fmtUsd(enteredUsd) : "USDC"}</>
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
                      This borrows about {fmtUsd(enteredUsd)} in USDC against your {collSym ? `${collSym} ` : "account "}collateral and adds it to this bot's
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

      {openPos && bot && (
        <DefendLoanDialog
          open={defendOpen}
          onOpenChange={setDefendOpen}
          bot={bot}
          walletAddress={walletAddress}
          position={openPos}
          initialAuto={data.autoCollateralTopUp ?? false}
          collSym={collSym}
          onChanged={onChanged}
          growMaxUsd={growMaxUsd}
          growAllowed={growAllowed}
          targetLtvPct={targetLtvPct}
          hasInflightGrow={hasInflightGrow}
          growBusy={busy === "grow"}
          onGrow={handleGrow}
          growTargetLtv={growTargetLtv}
          onRepayPartial={handleRepayPartial}
          repayBusy={busy === "repay"}
          hasInflightRepay={hasInflightRepay}
          addCollMaxTokens={addCollMaxTokens}
          addCollMaxUsd={addCollMaxUsd}
          addCollOraclePriceUsd={addCollOraclePriceUsd}
          hasInflightAddColl={hasInflightAddColl}
          addCollBusy={busy === "addcoll"}
          onAddCollateral={handleAddCollateral}
        />
      )}
    </>
  );
}
