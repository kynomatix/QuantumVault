import { useEffect, useRef, useState, type ElementType } from "react";
import { Loader2, Landmark, Check, AlertCircle, AlertTriangle, RotateCcw, TrendingUp } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import {
  getSessionId,
  newRequestId,
  fmtUsd,
  healthBarColor,
  safeLtvMarkerPct,
  RECOMMENDED_MAX_LTV,
} from "@/lib/lending-format";
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
  collateralLogoURI: string | null;
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
  oraclePriceUsd?: number | null;
  targetLtv?: number | null;
  suggestLtv?: number | null;
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

// A trimmed view of the carry-trade advisor response, folded INTO the loan card
// (one card, not two). The drawer owns the fetch; we only render.
interface CarryAdvisorView {
  applicable?: boolean;
  recommendation: {
    action: "park" | "repay" | "hold" | "unavailable";
    message: string;
    netSpreadPct: number | null;
    bestAsset: { displayName: string; apyPct: number } | null;
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
  const borrowLimitUsd = collValueUsd != null && posMaxLtv != null ? collValueUsd * posMaxLtv : null;
  const usagePct =
    borrowLimitUsd != null && borrowLimitUsd > 0 && liveDebtUsd != null
      ? Math.min(100, Math.max(0, (liveDebtUsd / borrowLimitUsd) * 100))
      : null;
  const safeMarkerPct = safeLtvMarkerPct(posMaxLtv);

  // Advisor → which of the two action cards to HIGHLIGHT as recommended. park/hold ⇒
  // Carry Trade (keep the loan, earn yield); repay ⇒ Repay. Rendered as clean STATS
  // (vault yield vs borrow APR → net edge), never prose.
  const advisorRec = advisor?.applicable && advisor.recommendation ? advisor.recommendation : null;
  const recCarry = advisorRec != null && (advisorRec.action === "park" || advisorRec.action === "hold");
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

  // Which collateral asset the system carved for this loan (e.g. INF). Prefer the
  // canonical cased symbol from the server (honors native ticker casing like jupSOL);
  // fall back to the asset key uppercased.
  const collSym = openPos
    ? (openPos.collateralSymbol ?? (openPos.collateralAssetKey ? openPos.collateralAssetKey.toUpperCase() : null))
    : (carrySrc?.collateralSymbol ?? (carrySrc?.collateralAssetKey ? carrySrc.collateralAssetKey.toUpperCase() : null));
  const collLogoURI = openPos?.collateralLogoURI ?? carrySrc?.collateralLogoURI ?? null;
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

  return (
    <>
      {openPos ? (
        <div className="rounded-xl border border-border bg-background/40 p-4 space-y-4" data-testid="card-perbot-loan">
          {/* Loan header — collateral avatar + conservative debt headline (Wallet-tab row styling). */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <CollateralAvatar logoURI={collLogoURI} symbol={collSym} testId="img-perbot-loan-collateral" />
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">{collSym ?? "\u2014"}</p>
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
            {usagePct != null ? (
              <>
                <div className="relative">
                  <div
                    className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
                    title={`Borrow capacity used: ${Math.round(usagePct)}%`}
                    data-testid="bar-perbot-health"
                  >
                    <div className="h-full rounded-full" style={{ width: `${usagePct}%`, backgroundColor: healthBarColor(usagePct) }} />
                  </div>
                  {safeMarkerPct != null && (
                    <div
                      className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
                      style={{ left: `${safeMarkerPct}%` }}
                      title={`Safe limit (${Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)`}
                      data-testid="marker-perbot-safe-limit"
                    />
                  )}
                </div>
                {safeMarkerPct != null && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground" data-testid="legend-perbot-safe-limit">
                    <span className="inline-block h-2.5 w-px bg-foreground/70 shrink-0" />
                    <span>Safe limit ({Math.round(RECOMMENDED_MAX_LTV * 100)}% LTV)</span>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground" data-testid="text-perbot-health-unavailable">
                Health unavailable right now.
              </p>
            )}
          </div>

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
                      <p className="text-sm font-bold tabular-nums" data-testid="stat-carry-yield">{fmtPct1(advisorRec?.bestAsset?.apyPct ?? null)}</p>
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
                <p className="text-[11px] text-muted-foreground">
                  Keep the loan and earn yield on the borrowed cash.
                  {advisorRec?.bestAsset ? ` Best vault: ${advisorRec.bestAsset.displayName}.` : ""}
                </p>
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
            {/* What you're borrowing against — small sectioned info blocks. */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-lg bg-muted/30">
                <p className="text-sm font-bold tabular-nums" data-testid="stat-borrow-collateral">{collSym ?? "\u2014"}</p>
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
    </>
  );
}
