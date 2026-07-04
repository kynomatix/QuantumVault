import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  AlertTriangle,
  Wallet,
  ShieldCheck,
  HelpCircle,
  Landmark,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import LoopVaultControls from "@/components/LoopVaultControls";
import FixedYieldVault from "@/components/FixedYieldVault";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Per-project logos for each yield destination (white marks designed to sit on the
 * card's gradient tile). Keyed by the registry asset key. Any asset without a logo
 * falls back to the generic Landmark glyph. Files: client/public/images/vaults.
 */
const VAULT_LOGOS: Record<string, string> = {
  kamino_usdc: "/images/vaults/kamino_white.webp",
  perena_usd_star: "/images/vaults/perena_white.webp",
  jupiter_lend_usdc: "/images/vaults/jupiter_white.webp",
  jupusd: "/images/vaults/jupiter_white.webp",
  usdy: "/images/vaults/ondo_white.webp",
  onyc: "/images/vaults/onre_white.webp",
};

export interface YieldAssetInfo {
  key: string;
  displayName: string;
  mint: string;
  decimals: number;
  route: string;
  valuation: string;
  /** True when the token's USDC price floats with the market (basis risk). */
  priceFloats: boolean;
  /** User-facing risk tier for the inline chip. */
  riskClass: "stable" | "float";
  /** True only for assets that can actually lose value (drives the "may lose value" hint). */
  mayLoseValue: boolean;
  /** Estimated range (e.g. "~4-9%"). Shown — clearly marked "est." — only as a
   *  fallback until the oracle measures a real `apy`. */
  apyLabel: string;
  /** Realized net APY (percent) from the yield oracle, or null when not measurable. */
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  /** Why apy is / isn't a number. "defillama"/"defillama_cached" = real measured
   *  rate from the DeFiLlama yields index (live / last-good); "trailing" =
   *  self-measured from our own price series; "accruing"/"unavailable" = no number. */
  apyMethod: "defillama" | "defillama_cached" | "trailing" | "accruing" | "unavailable";
  apyAsOf: number | null;
  tag: string;
  /** Longer plain-language note for the detail dialog. */
  riskNote: string;
  defaultEligible: boolean;
}

// --- APY display helpers (yield oracle). When the oracle has measured a real
// realized rate we show that number. Until it populates, we fall back to the
// asset's estimated range, always marked "est." so it can never be mistaken for
// the measured figure.
function fmtApyPct(n: number): string {
  return `${n.toFixed(1)}%`;
}
/** True once the oracle has a real measured rate (vs. the estimated fallback). */
function hasRealApy(a: YieldAssetInfo): boolean {
  return a.apy != null;
}
/** Full inline phrase used where "<rate> APY" used to be shown. */
function apyInline(a: YieldAssetInfo): string {
  if (a.apy != null) return `${fmtApyPct(a.apy)} APY`;
  return `${a.apyLabel} APY (est.)`;
}
/** Compact form for the dropdown row. */
function apyCompact(a: YieldAssetInfo): string {
  if (a.apy != null) return fmtApyPct(a.apy);
  return `${a.apyLabel} est.`;
}
/** Number-only value for the big stat box (the "APY"/"Est. APY" label sits beneath it). */
function apyStat(a: YieldAssetInfo): string {
  if (a.apy != null) return fmtApyPct(a.apy);
  return a.apyLabel;
}

interface AssetsResponse {
  spareUsdc: number;
  maxPriceImpactPct: number;
  assets: YieldAssetInfo[];
  /** Echoed by the server: which wallet this acted on (per-bot vs shared account). */
  scope?: "account" | "bot";
  tradingBotId?: string | null;
}

interface PositionView {
  assetKey: string;
  displayName: string;
  mint: string;
  decimals: number;
  route: string;
  valuation: string;
  tag: string;
  defaultEligible: boolean;
  onChainAmountRaw: string;
  onChainAmount: number;
  currentValueUsdc: number | null;
  costBasisUsdc: number | null;
  unrealizedPnl: number | null;
  costBasisMissing: boolean;
}

interface PreviewResponse {
  expectedOut: number | null;
  priceImpactPct: number | null;
  /** False for direct deposit/mint routes (Kamino, Jupiter Lend) — no market price impact. */
  impactApplies?: boolean;
  wouldReject: boolean;
  reason?: string;
}

/** One bot that has funds parked inside it (independent_trader, e.g. Flash). */
interface VaultBotGroup {
  botId: string;
  botName: string;
  positions: PositionView[];
  /** Sum of this bot's readable parked values (unreadable rows excluded). */
  valueUsdc: number;
  /** True when at least one row couldn't be priced — the total is incomplete. */
  hasUnreadable: boolean;
}

/** Aggregate of every parked balance the wallet owns: account + per-bot. */
interface AllPositionsResponse {
  account: PositionView[];
  bots: VaultBotGroup[];
  /** account + bots, with any balance the server couldn't read left out. */
  totalParkedUsdc: number;
  warnings: string[];
}

const usd = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined
    ? "n/a"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const tok = (n: number | null | undefined) =>
  n === null || n === undefined ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: 6 });

async function getSessionId(): Promise<string> {
  const res = await fetch("/api/auth/session", { credentials: "include" });
  if (!res.ok) throw new Error("Could not verify your session. Please reconnect your wallet.");
  const data = await safeResponseJson(res);
  if (!data.hasSession || !data.sessionId) {
    throw new Error("No active session. Please reconnect your wallet.");
  }
  return data.sessionId as string;
}

/**
 * Preview the result of a full park/unpark. The amount is fixed by the action
 * (all spare USDC in, or the full held balance out) and is passed only so the
 * server can estimate price impact; the user never types it.
 */
function usePreview(args: {
  open: boolean;
  assetKey: string | null;
  direction: "park" | "unpark";
  amount: number;
  wallet: string | null;
}) {
  const { open, assetKey, direction, amount, wallet } = args;
  return useQuery<PreviewResponse>({
    queryKey: ["vault-preview", assetKey, direction, amount, wallet],
    queryFn: async () => {
      const res = await fetch(
        `/api/vault/preview?assetKey=${encodeURIComponent(assetKey!)}&direction=${direction}&amount=${amount}`,
        { credentials: "include", headers: walletAuthHeaders() },
      );
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Preview failed");
      return data as PreviewResponse;
    },
    enabled: open && !!assetKey && !!wallet && amount > 0,
    staleTime: 8000,
    retry: false,
  });
}

function PreviewBox({
  loading,
  preview,
  outLabel,
  cap,
}: {
  loading: boolean;
  preview: PreviewResponse | undefined;
  outLabel: string;
  cap: number;
}) {
  if (loading) {
    return <Skeleton className="h-16 w-full" data-testid="skeleton-preview" />;
  }
  if (!preview) return null;
  const impactPct = preview.priceImpactPct === null ? null : preview.priceImpactPct * 100;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1" data-testid="box-preview">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">You receive (estimated)</span>
        <span className="font-medium tabular-nums" data-testid="text-preview-out">
          {tok(preview.expectedOut)} {outLabel}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Price impact</span>
        <span
          className={
            preview.impactApplies !== false && impactPct !== null && impactPct > cap * 100
              ? "text-destructive font-medium tabular-nums"
              : "font-medium tabular-nums"
          }
          data-testid="text-preview-impact"
        >
          {preview.impactApplies === false
            ? "None"
            : impactPct === null
              ? "unknown"
              : `${impactPct.toFixed(2)}%`}
        </span>
      </div>
      {preview.wouldReject && (
        <div className="flex items-start gap-2 text-destructive pt-1" data-testid="text-preview-reject">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{preview.reason || "This swap would move the price too much. Try again later."}</span>
        </div>
      )}
    </div>
  );
}

/** Small inline risk pill: green "Stable" (trades near $1) or amber "Floats" (price moves). */
function RiskChip({ riskClass }: { riskClass: string }) {
  const isFloat = riskClass === "float";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap",
        isFloat
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      )}
      data-testid={`chip-risk-${isFloat ? "float" : "stable"}`}
    >
      {isFloat ? "Floats" : "Stable"}
    </span>
  );
}

/**
 * Vaults: earn on idle funds, one tap in and out. The component has two modes.
 *
 * Account mode (no `botId`): the teaching home for the /app Vaults tab. Each yield
 * destination is its own card (like a bot card on My Bots): name, APY, risk chip,
 * and, when funds are parked, the held balance and P/L. Tapping a card opens a
 * detail sheet with two automatic actions and NO amount inputs:
 *   - "Park all spare USDC"  -> the server parks the full on-chain spare balance.
 *   - "Unpark all to USDC"   -> the server pulls the full held balance back.
 *
 * Per-bot mode (`botId` passed, embedded in the bot drawer): a deliberately simple
 * form, NOT the card grid. The drawer wrapper already supplies the on/off reveal
 * switch and heading, so here it is just a scope note, a token dropdown, a little
 * info for the selected token, and the same one-tap park-all / unpark-all actions.
 *
 * Either way the money path is identical (all-in / all-out, `{ all: true }`) and all
 * reads/writes carry `botId` in per-bot mode. `active` gates the data queries so the
 * module mounts lazily.
 */
export default function VaultIdleFunds({
  active = true,
  botId,
  selectedAssetKey,
  onSelectedAssetKeyChange,
  onChanged,
}: {
  active?: boolean;
  botId?: string;
  /**
   * Controlled per-bot destination. When provided (drawer edit-state) the picker
   * is CONTROLLED: its value persists on the bot's Save. `undefined` = uncontrolled
   * (the picker keeps its own internal selection — account mode / Pacifica bots).
   */
  selectedAssetKey?: string | null;
  onSelectedAssetKeyChange?: (key: string) => void;
  /**
   * Fired after a successful park/unpark so an embedding surface (e.g. the bot
   * drawer's Equity tab) can refresh its own balance/composition view — our
   * internal query cache is refetched separately via `refetchAll`.
   */
  onChanged?: () => void;
}) {
  const { publicKeyString, sessionConnected, retryAuth } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connected = !!publicKeyString && sessionConnected;
  const embedded = !!botId;

  // Vault data (assets to park, current positions).
  const botQuery = botId ? `?botId=${encodeURIComponent(botId)}` : "";

  const assetsQuery = useQuery<AssetsResponse>({
    queryKey: ["vault-assets", publicKeyString, botId ?? null],
    queryFn: async () => {
      const res = await fetch(`/api/vault/assets${botQuery}`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load vault assets");
      return data as AssetsResponse;
    },
    enabled: active && connected,
    // Realized APY is built async/non-blocking on the server; poll so cold-start
    // numbers and slow APY drift appear without a manual refresh.
    refetchInterval: 60_000,
  });

  const positionsQuery = useQuery<{ positions: PositionView[]; scope?: "account" | "bot" }>({
    queryKey: ["vault-positions", publicKeyString, botId ?? null],
    queryFn: async () => {
      const res = await fetch(`/api/vault/positions${botQuery}`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load positions");
      return data as { positions: PositionView[]; scope?: "account" | "bot" };
    },
    // Account mode reads the aggregate (/positions/all) instead, so this
    // single-scope query only runs inside a per-bot drawer (embedded).
    enabled: active && connected && embedded,
  });

  // Account mode (no botId): the main Vaults tab. Pull the AGGREGATE — the shared
  // account vault PLUS funds parked inside individual bots — so per-bot balances
  // show up here too, not only in each bot's drawer. Embedded (per-bot drawer)
  // mode keeps using the single-scope /positions query above.
  const allPositionsQuery = useQuery<AllPositionsResponse>({
    queryKey: ["vault-positions-all", publicKeyString],
    queryFn: async () => {
      const res = await fetch(`/api/vault/positions/all`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load positions");
      return data as AllPositionsResponse;
    },
    enabled: active && connected && !embedded,
    staleTime: 20_000,
  });

  const spareUsdc = assetsQuery.data?.spareUsdc ?? 0;
  const maxImpact = assetsQuery.data?.maxPriceImpactPct ?? 0.005;
  const assets = assetsQuery.data?.assets ?? [];
  // Account-scope positions that drive the vault cards. Embedded mode reads the
  // single-scope query; account mode reads the aggregate's account slice.
  const positions = embedded
    ? positionsQuery.data?.positions ?? []
    : allPositionsQuery.data?.account ?? [];
  // Funds parked inside individual bots + any read warnings (account mode only).
  const botGroups = embedded ? [] : allPositionsQuery.data?.bots ?? [];
  const vaultWarnings = embedded ? [] : allPositionsQuery.data?.warnings ?? [];
  const positionsLoading = embedded ? positionsQuery.isLoading : allPositionsQuery.isLoading;
  // Which wallet the server actually acted on. A Flash bot → its own per-bot wallet
  // ("bot"); a Pacifica/Drift bot shares the main account wallet ("account").
  const scope = assetsQuery.data?.scope ?? positionsQuery.data?.scope ?? null;

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["vault-assets", publicKeyString, botId ?? null] });
    queryClient.invalidateQueries({ queryKey: ["vault-positions", publicKeyString, botId ?? null] });
    queryClient.invalidateQueries({ queryKey: ["vault-positions-all", publicKeyString] });
  };

  const positionByKey = useMemo(() => {
    const m = new Map<string, PositionView>();
    for (const p of positions) m.set(p.assetKey, p);
    return m;
  }, [positions]);

  // Account mode: the server already sums account + bots (and leaves out any
  // balance it couldn't read). Embedded mode: just this bot's account-scope rows.
  const totalParked = useMemo(() => {
    if (!embedded && allPositionsQuery.data) return allPositionsQuery.data.totalParkedUsdc;
    return positions.reduce((sum, p) => sum + (p.currentValueUsdc ?? 0), 0);
  }, [embedded, allPositionsQuery.data, positions]);

  // The destination whose detail sheet is open (drives both park-all + unpark-all).
  const [detailAsset, setDetailAsset] = useState<YieldAssetInfo | null>(null);
  const [parking, setParking] = useState(false);
  const [unparking, setUnparking] = useState(false);
  const [showHow, setShowHow] = useState(false);
  // Per-bot (embedded) mode: the token chosen in the compact dropdown. When the
  // parent passes `selectedAssetKey` the picker is CONTROLLED (its value lives in
  // the drawer's edit-state and persists on Save); otherwise it falls back to this
  // internal state. The internal value is always kept valid so the dropdown is
  // never empty even before the parent has a saved destination.
  const controlledDestination = selectedAssetKey !== undefined;
  const [internalEmbKey, setInternalEmbKey] = useState<string | null>(null);
  // Effective selection. In controlled mode prefer the parent's value, but fall
  // back to the internal default when it is null OR points at an asset that is no
  // longer enabled/available (a previously-saved destination that got disabled) —
  // otherwise the dropdown would render empty. The persisted value is untouched;
  // this only affects what the picker displays until the user re-picks.
  const controlledKeyIsAvailable =
    selectedAssetKey != null && (assets.length === 0 || assets.some((a) => a.key === selectedAssetKey));
  const embAssetKey = controlledDestination
    ? (controlledKeyIsAvailable ? selectedAssetKey : internalEmbKey)
    : internalEmbKey;
  const handleEmbSelect = (k: string) => {
    if (controlledDestination) onSelectedAssetKeyChange?.(k);
    else setInternalEmbKey(k);
  };

  const detailHeld = detailAsset ? positionByKey.get(detailAsset.key)?.onChainAmount ?? 0 : 0;
  const detailPosition = detailAsset ? positionByKey.get(detailAsset.key) ?? null : null;

  // Embedded selection + its current holding (drives the per-bot dropdown form).
  const embAsset = useMemo(
    () => assets.find((a) => a.key === embAssetKey) ?? null,
    [assets, embAssetKey],
  );
  const embPosition = embAsset ? positionByKey.get(embAsset.key) ?? null : null;
  const embHeld = embPosition?.onChainAmount ?? 0;
  // Where funds ACTUALLY sit right now (any asset with an on-chain balance),
  // independent of the picker's selection. Surfacing this next to the destination
  // picker keeps the two from ever looking contradictory (e.g. picker shows Perena
  // but funds are really in OnRe).
  const heldParked = useMemo(
    () => positions.filter((p) => p.onChainAmount > 0),
    [positions],
  );

  const parkPreview = usePreview({
    open: !!detailAsset,
    assetKey: detailAsset?.key ?? null,
    direction: "park",
    amount: spareUsdc,
    wallet: publicKeyString,
  });
  const unparkPreview = usePreview({
    open: !!detailAsset && detailHeld > 0,
    assetKey: detailAsset?.key ?? null,
    direction: "unpark",
    amount: detailHeld,
    wallet: publicKeyString,
  });

  // Embedded (per-bot) previews, keyed off the dropdown selection.
  const embParkPreview = usePreview({
    open: embedded && !!embAsset && spareUsdc > 0,
    assetKey: embAsset?.key ?? null,
    direction: "park",
    amount: spareUsdc,
    wallet: publicKeyString,
  });
  const embUnparkPreview = usePreview({
    open: embedded && !!embAsset && embHeld > 0,
    assetKey: embAsset?.key ?? null,
    direction: "unpark",
    amount: embHeld,
    wallet: publicKeyString,
  });

  // Close the detail sheet when the tab is hidden.
  useEffect(() => {
    if (!active) setDetailAsset(null);
  }, [active]);

  // Embedded mode: keep a sensible token selected so the dropdown is never empty.
  // Prefer one that is already earning, then the default-eligible asset, then the
  // first available token.
  useEffect(() => {
    if (!embedded || assets.length === 0) return;
    setInternalEmbKey((prev) => {
      if (prev && assets.some((a) => a.key === prev)) return prev;
      const held = positions.find((p) => p.onChainAmount > 0);
      if (held && assets.some((a) => a.key === held.assetKey)) return held.assetKey;
      const def = assets.find((a) => a.defaultEligible);
      return def?.key ?? assets[0].key;
    });
  }, [embedded, assets, positions]);

  const handleParkAll = async (assetArg?: YieldAssetInfo) => {
    const asset = assetArg ?? detailAsset;
    if (!asset) return;
    if (!(spareUsdc > 0)) {
      toast({ title: "No spare USDC", description: "There is no idle USDC to park right now.", variant: "destructive" });
      return;
    }
    setParking(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/park", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ assetKey: asset.key, all: true, sessionId, botId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Park failed");
      toast({
        title: "Parked",
        description: `Put ${usd(data.usdcSpent)} to work in ${asset.displayName}.${data.dbWarning ? ` ${data.dbWarning}` : ""}`,
      });
      setDetailAsset(null);
      refetchAll();
      onChanged?.();
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Park failed", retry: () => handleParkAll(asset) });
      } else {
        toast({ title: "Park failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setParking(false);
    }
  };

  const handleUnparkAll = async (assetKey: string, displayName: string) => {
    setUnparking(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/unpark", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ assetKey, all: true, sessionId, botId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Unpark failed");
      const pnl =
        typeof data.realizedPnl === "number"
          ? ` Realized P/L: ${data.realizedPnl >= 0 ? "+" : ""}${usd(data.realizedPnl)}.`
          : "";
      toast({
        title: "Unparked",
        description: `Received ${usd(data.usdcReceived)} USDC.${pnl}${data.dbWarning ? ` ${data.dbWarning}` : ""}`,
      });
      setDetailAsset(null);
      refetchAll();
      onChanged?.();
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Unpark failed", retry: () => handleUnparkAll(assetKey, displayName) });
      } else {
        toast({ title: "Unpark failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setUnparking(false);
    }
  };

  // --- Reusable pieces -------------------------------------------------------

  const summaryBar = (
    <div className="flex flex-wrap items-center gap-3" data-testid="vault-summary">
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
        <Wallet className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">USDC available to earn</span>
        <span className="ml-1 text-base font-bold tabular-nums" data-testid="text-spare-usdc">
          {assetsQuery.isLoading ? "..." : usd(spareUsdc)}
        </span>
      </div>
      {totalParked > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
          <TrendingUp className="w-4 h-4 text-emerald-500" />
          <span className="text-sm text-muted-foreground">Currently earning</span>
          <span className="ml-1 text-base font-bold tabular-nums" data-testid="text-total-earning">
            {positionsLoading ? "..." : usd(totalParked)}
          </span>
        </div>
      )}
    </div>
  );

  // One vault = one card, mirroring the bot cards on My Bots.
  const renderVaultCard = (a: YieldAssetInfo) => {
    const pos = positionByKey.get(a.key);
    const held = pos?.onChainAmount ?? 0;
    const value = pos?.currentValueUsdc ?? null;
    const pnl = pos?.unrealizedPnl ?? null;
    const isEarning = held > 0;
    const pnlPositive = (pnl ?? 0) >= 0;
    return (
      <div
        key={a.key}
        role="button"
        tabIndex={0}
        aria-label={`${a.displayName} vault`}
        className="gradient-border p-5 noise hover:scale-[1.01] transition-transform cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        data-testid={`card-asset-${a.key}`}
        onClick={() => setDetailAsset(a)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDetailAsset(a);
          }
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                isEarning ? "bg-gradient-to-br from-primary to-accent" : "bg-gradient-to-br from-primary/30 to-accent/30"
              }`}
            >
              {VAULT_LOGOS[a.key] ? (
                <img
                  src={VAULT_LOGOS[a.key]}
                  alt=""
                  aria-hidden="true"
                  className="w-7 h-7 object-contain"
                />
              ) : (
                <Landmark className={`w-6 h-6 ${isEarning ? "text-white" : "text-primary"}`} />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base truncate">{a.displayName}</h3>
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="tabular-nums" data-testid={`text-card-apy-${a.key}`}>{apyInline(a)}</span>
                <RiskChip riskClass={a.riskClass} />
              </p>
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${
              isEarning ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"
            }`}
          >
            {isEarning ? "Earning" : "Idle"}
          </span>
        </div>

        {isEarning && (
          <div
            className={`mb-4 px-3 py-2.5 rounded-lg flex items-center justify-between ${
              pnlPositive ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"
            }`}
            data-testid={`box-card-earning-${a.key}`}
          >
            <span className="text-sm font-medium">Earning {usd(value)}</span>
            {pnl !== null && (
              <span
                className={`text-sm font-semibold flex items-center gap-1 ${
                  pnlPositive ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {pnlPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {pnlPositive ? "+" : ""}
                {usd(pnl)}
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums" data-testid={`stat-card-apy-${a.key}`}>{apyStat(a)}</p>
            <p className="text-xs text-muted-foreground">{hasRealApy(a) ? "APY" : "Est. APY"}</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums" data-testid={`text-card-value-${a.key}`}>
              {isEarning ? usd(value) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Your balance</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p
              className={`text-lg font-bold tabular-nums ${
                pnl === null ? "" : pnlPositive ? "text-emerald-400" : "text-red-400"
              }`}
              data-testid={`text-card-pnl-${a.key}`}
            >
              {pnl === null ? "—" : `${pnlPositive ? "+" : ""}${usd(pnl)}`}
            </p>
            <p className="text-xs text-muted-foreground">P/L</p>
          </div>
        </div>

        {a.mayLoseValue && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Can lose value.
          </p>
        )}
      </div>
    );
  };

  const cardGrid = (gridClass: string) => {
    if (assetsQuery.isLoading) {
      return (
        <div className={gridClass}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      );
    }
    if (assets.length === 0) {
      return (
        <div className="gradient-border p-8 noise text-center" data-testid="text-no-assets">
          <Landmark className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
          <p className="text-muted-foreground">No vaults are available right now.</p>
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <div>
          {!botId && (
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Stablecoin Vaults</h3>
          )}
          <div className={gridClass} data-testid="section-vault-assets">
            {assets.map(renderVaultCard)}
          </div>
        </div>
        {/* Asset Vaults: Fixed Yield (open to all) + owner-only SOL Loop
            (self-gating: renders nothing unless the server's owner gate
            passes). Account-level vault grid only — the section heading
            lives here now that an ungated card shares it. */}
        {!botId && (
          <div data-testid="section-asset-vaults">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Asset Vaults</h3>
            <div className={gridClass}>
              <FixedYieldVault active={active} />
              <LoopVaultControls active={active} />
            </div>
          </div>
        )}
      </div>
    );
  };

  const howLink = (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => setShowHow(true)}
      data-testid="link-how-it-works"
    >
      <HelpCircle className="w-3.5 h-3.5" /> How Vaults work
    </button>
  );

  // Read-only summary of funds parked inside individual bots. Managing them stays
  // in each bot's own panel; here we only surface that the money exists and earns.
  const botParkedSection =
    botGroups.length === 0 ? null : (
      <div className="space-y-3" data-testid="section-bot-vaults">
        <h3 className="text-sm font-semibold text-muted-foreground">Parked inside your bots</h3>
        <div className="space-y-2">
          {botGroups.map((b) => (
            <div
              key={b.botId}
              className="rounded-xl border border-border/50 bg-muted/20 p-4"
              data-testid={`card-bot-vault-${b.botId}`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-medium truncate" data-testid={`text-bot-vault-name-${b.botId}`}>
                  {b.botName}
                </span>
                <span
                  className="flex items-center gap-1 text-sm font-bold tabular-nums"
                  data-testid={`text-bot-vault-total-${b.botId}`}
                >
                  {b.hasUnreadable && b.valueUsdc === 0 ? "—" : usd(b.valueUsdc)}
                  {b.hasUnreadable && (
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-amber-500"
                      data-testid={`icon-bot-vault-partial-${b.botId}`}
                    />
                  )}
                </span>
              </div>
              <div className="space-y-1.5">
                {b.positions.map((p) => {
                  const pnl = p.unrealizedPnl;
                  const pnlPositive = (pnl ?? 0) >= 0;
                  return (
                    <div
                      key={p.assetKey}
                      className="flex items-center justify-between gap-2 text-sm"
                      data-testid={`row-bot-vault-${b.botId}-${p.assetKey}`}
                    >
                      <span className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                        <Landmark className="w-3.5 h-3.5 shrink-0 text-primary" />
                        <span className="truncate">{p.displayName}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0 tabular-nums">
                        <span className="font-medium">
                          {p.currentValueUsdc === null ? "—" : usd(p.currentValueUsdc)}
                        </span>
                        {pnl !== null && (
                          <span className={pnlPositive ? "text-emerald-500" : "text-red-400"}>
                            {pnlPositive ? "+" : ""}
                            {usd(pnl)}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Manage this in the bot's own panel.</p>
            </div>
          ))}
        </div>
      </div>
    );

  const vaultWarningNote =
    vaultWarnings.length === 0 ? null : (
      <p
        className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
        data-testid="text-vault-warning"
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Some bot balances couldn't be refreshed just now.
      </p>
    );

  // --- Render ----------------------------------------------------------------

  let body: ReactNode;

  if (!connected) {
    body = (
      <div className="gradient-border p-8 noise text-center" data-testid="text-vault-disconnected">
        <p className="text-muted-foreground">Connect and sign in to use Vaults.</p>
      </div>
    );
  } else if (embedded) {
    // -------- Per-bot mode: a simple token dropdown + one-tap all-in/all-out. --------
    // The bot drawer supplies the on/off reveal switch and the heading copy, so we
    // stay minimal here: pick a token, see a little info, park or unpark all. No
    // card grid (that look belongs to the account Vaults tab only).
    body = (
      <div className="space-y-3" data-testid="vault-embedded">
        {scope && (
          <p className="text-xs text-muted-foreground" data-testid="text-vault-scope-note">
            {scope === "account"
              ? "This bot shares your main account wallet, so earning uses your shared account vault."
              : "Earning uses this bot's own wallet (its spare USDC)."}
          </p>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Wallet className="w-3.5 h-3.5" /> Spare USDC
          </span>
          <span className="text-sm font-semibold tabular-nums" data-testid="text-spare-usdc">
            {assetsQuery.isLoading ? "..." : usd(spareUsdc)}
          </span>
        </div>

        {assetsQuery.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : assets.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="text-no-assets">
            No yield tokens are available right now.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">
                {controlledDestination ? "Auto-park destination" : "Token"}
              </Label>
              <Select value={embAsset?.key ?? ""} onValueChange={handleEmbSelect}>
                <SelectTrigger className="h-9" data-testid="select-park-asset">
                  <SelectValue placeholder="Choose a token" />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (
                    <SelectItem key={a.key} value={a.key} data-testid={`option-park-${a.key}`}>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{a.displayName}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{apyCompact(a)}</span>
                        <RiskChip riskClass={a.riskClass} />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {heldParked.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1.5" data-testid="text-current-parked-location">
                  Currently earning in {heldParked.map((p) => p.displayName).join(", ")}.
                </p>
              )}
            </div>

            {embAsset && (
              <>
                <div
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  data-testid="text-selected-meta"
                >
                  <span className="text-muted-foreground tabular-nums" data-testid="text-selected-apy">{apyInline(embAsset)}</span>
                  <RiskChip riskClass={embAsset.riskClass} />
                  {embAsset.mayLoseValue && (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="w-3 h-3" /> may lose value
                    </span>
                  )}
                </div>

                {embHeld > 0 && embPosition && (
                  <div
                    className={cn(
                      "rounded-lg px-3 py-2 flex items-center justify-between text-sm border",
                      (embPosition.unrealizedPnl ?? 0) >= 0
                        ? "bg-emerald-500/10 border-emerald-500/20"
                        : "bg-red-500/10 border-red-500/20",
                    )}
                    data-testid="box-embedded-earning"
                  >
                    <span className="font-medium">Earning {usd(embPosition.currentValueUsdc)}</span>
                    {embPosition.unrealizedPnl !== null && (
                      <span
                        className={cn(
                          "font-semibold flex items-center gap-1",
                          (embPosition.unrealizedPnl ?? 0) >= 0 ? "text-emerald-500" : "text-red-500",
                        )}
                      >
                        {(embPosition.unrealizedPnl ?? 0) >= 0 ? (
                          <TrendingUp className="w-3.5 h-3.5" />
                        ) : (
                          <TrendingDown className="w-3.5 h-3.5" />
                        )}
                        {(embPosition.unrealizedPnl ?? 0) >= 0 ? "+" : ""}
                        {usd(embPosition.unrealizedPnl)}
                      </span>
                    )}
                  </div>
                )}

                {spareUsdc > 0 && (
                  <PreviewBox
                    loading={embParkPreview.isFetching}
                    preview={embParkPreview.data}
                    outLabel={embAsset.displayName}
                    cap={maxImpact}
                  />
                )}
                <Button
                  onClick={() => handleParkAll(embAsset)}
                  disabled={parking || !(spareUsdc > 0) || (embParkPreview.data?.wouldReject ?? false)}
                  className="w-full"
                  data-testid="button-embedded-park-all"
                >
                  {parking ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parking
                    </>
                  ) : (
                    "Park all spare USDC"
                  )}
                </Button>
                {!(spareUsdc > 0) && (
                  <p className="text-xs text-muted-foreground text-center">No idle USDC to add right now.</p>
                )}

                {embHeld > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => handleUnparkAll(embAsset.key, embAsset.displayName)}
                    disabled={unparking || (embUnparkPreview.data?.wouldReject ?? false)}
                    className="w-full"
                    data-testid="button-embedded-unpark-all"
                  >
                    {unparking ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Unparking
                      </>
                    ) : (
                      "Unpark all to USDC"
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {howLink}
      </div>
    );
  } else {
    // -------- Account mode: a responsive grid of vault cards. --------
    body = (
      <div className="space-y-5">
        {summaryBar}
        {cardGrid("grid md:grid-cols-2 xl:grid-cols-3 gap-5")}
        {botParkedSection}
        {vaultWarningNote}
        {howLink}
      </div>
    );
  }

  return (
    <>
      {body}

      {/* Destination detail sheet: park all / unpark all, no amount inputs. */}
      <Dialog open={!!detailAsset} onOpenChange={(o) => { if (!o) setDetailAsset(null); }}>
        <DialogContent data-testid="dialog-asset-detail">
          {detailAsset && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {detailAsset.displayName}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{apyInline(detailAsset)}</span>
                  <RiskChip riskClass={detailAsset.riskClass} />
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="flex items-start gap-2 text-sm text-muted-foreground rounded-lg border border-border bg-muted/30 p-3">
                  <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                  <span data-testid="text-detail-note">{detailAsset.riskNote}</span>
                </div>

                {detailAsset.mayLoseValue && (
                  <div
                    className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5"
                    data-testid="warning-detail-may-lose"
                  >
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>This token can lose value. Only add funds you are comfortable putting at risk.</span>
                  </div>
                )}

                {/* Current holding */}
                {detailPosition && detailHeld > 0 && (
                  <div className="rounded-lg border border-border/50 p-3 grid grid-cols-3 gap-2 text-xs" data-testid="box-detail-holding">
                    <div>
                      <div className="text-muted-foreground">Value</div>
                      <div className="font-medium tabular-nums">{usd(detailPosition.currentValueUsdc)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Cost</div>
                      <div className="font-medium tabular-nums">
                        {detailPosition.costBasisMissing ? "unknown" : usd(detailPosition.costBasisUsdc)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">P/L</div>
                      <div
                        className={`font-medium tabular-nums ${
                          detailPosition.unrealizedPnl === null
                            ? ""
                            : (detailPosition.unrealizedPnl ?? 0) >= 0
                              ? "text-emerald-500"
                              : "text-destructive"
                        }`}
                      >
                        {detailPosition.unrealizedPnl === null
                          ? "n/a"
                          : `${(detailPosition.unrealizedPnl ?? 0) >= 0 ? "+" : ""}${usd(detailPosition.unrealizedPnl)}`}
                      </div>
                    </div>
                  </div>
                )}

                {/* Park all */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Spare USDC to add</span>
                    <span className="font-semibold tabular-nums" data-testid="text-detail-spare">{usd(spareUsdc)}</span>
                  </div>
                  {spareUsdc > 0 && (
                    <PreviewBox
                      loading={parkPreview.isFetching}
                      preview={parkPreview.data}
                      outLabel={detailAsset.displayName}
                      cap={maxImpact}
                    />
                  )}
                  <Button
                    onClick={() => handleParkAll()}
                    disabled={parking || !(spareUsdc > 0) || (parkPreview.data?.wouldReject ?? false)}
                    className="w-full"
                    data-testid="button-park-all"
                  >
                    {parking ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parking
                      </>
                    ) : (
                      "Park all spare USDC"
                    )}
                  </Button>
                  {!(spareUsdc > 0) && (
                    <p className="text-xs text-muted-foreground text-center">No idle USDC to add right now.</p>
                  )}
                </div>

                {/* Unpark all */}
                {detailHeld > 0 && (
                  <div className="space-y-2 border-t border-border/40 pt-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Your balance</span>
                      <span className="font-semibold tabular-nums">{tok(detailHeld)}</span>
                    </div>
                    <PreviewBox
                      loading={unparkPreview.isFetching}
                      preview={unparkPreview.data}
                      outLabel="USDC"
                      cap={maxImpact}
                    />
                    <Button
                      variant="outline"
                      onClick={() => handleUnparkAll(detailAsset.key, detailAsset.displayName)}
                      disabled={unparking || (unparkPreview.data?.wouldReject ?? false)}
                      className="w-full"
                      data-testid="button-unpark-all"
                    >
                      {unparking ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Unparking
                        </>
                      ) : (
                        "Unpark all to USDC"
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* How Vaults work */}
      <Dialog open={showHow} onOpenChange={setShowHow}>
        <DialogContent data-testid="dialog-how-it-works">
          <DialogHeader>
            <DialogTitle>How Vaults work</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Vaults put idle USDC into a yield destination so it earns while it waits. Tap in to add all your spare
              USDC; tap out to pull your full balance back. Your funds stay in this wallet; we only handle the move.
            </p>
            <p>
              Each move is capped at {(maxImpact * 100).toFixed(2)}% price impact, so a thin market cannot move your
              money at a bad price.
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              <RiskChip riskClass="stable" /> trades near $1 and earns yield.
              <RiskChip riskClass="float" /> price can move, and one (OnRe ONyc) can lose value.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
