import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  Info,
  AlertTriangle,
  Wallet,
  ShieldCheck,
  HelpCircle,
  ChevronRight,
  ArrowLeft,
  Landmark,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
  /** Approximate APY label (carries a "~" qualifier). */
  apyLabel: string;
  tag: string;
  /** Longer plain-language note for the detail dialog. */
  riskNote: string;
  defaultEligible: boolean;
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
  wouldReject: boolean;
  reason?: string;
}

export interface VaultSettings {
  vaultEnabled: boolean;
  vaultDefaultAsset: string | null;
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
            impactPct !== null && impactPct > cap * 100
              ? "text-destructive font-medium tabular-nums"
              : "font-medium tabular-nums"
          }
          data-testid="text-preview-impact"
        >
          {impactPct === null ? "unknown" : `${impactPct.toFixed(2)}%`}
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
 * Vaults: earn on idle funds, one tap in and out.
 *
 * The account tab shows a single "Earn" product card; tapping it opens the list
 * of yield destinations. A future "Auto" mode slots in as a second product card.
 * Each destination is a tappable card (name, APY, risk, held balance + P/L) that
 * opens a detail sheet with two automatic actions and NO amount inputs:
 *   - "Park all spare USDC"  -> the server parks the full on-chain spare balance.
 *   - "Unpark all to USDC"   -> the server pulls the full held balance back.
 *
 * `active` gates the data queries (the host passes active) so the module mounts
 * lazily. When `botId` is passed (embedded in the bot drawer) it runs in per-bot
 * mode: the account-level master toggle is hidden, the product-card layer is
 * skipped (it is already scoped to one bot), and all reads/writes carry `botId`.
 */
export default function VaultIdleFunds({ active = true, botId }: { active?: boolean; botId?: string }) {
  const { publicKeyString, sessionConnected } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connected = !!publicKeyString && sessionConnected;
  const embedded = !!botId;

  // Persisted vault settings (master enable).
  const settingsQuery = useQuery<VaultSettings>({
    queryKey: ["vault-settings", publicKeyString],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/settings`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load settings");
      return { vaultEnabled: !!data.vaultEnabled, vaultDefaultAsset: data.vaultDefaultAsset ?? null };
    },
    enabled: active && connected && !embedded,
  });

  // In embedded mode the drawer toggle is the gate, so the vault UI is always "on".
  const vaultOn = embedded ? true : (settingsQuery.data?.vaultEnabled ?? false);
  const [savingSettings, setSavingSettings] = useState(false);

  const saveVaultSettings = async (patch: Partial<VaultSettings>) => {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/wallet/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to save");
      queryClient.setQueryData<VaultSettings>(["vault-settings", publicKeyString], {
        vaultEnabled: !!data.vaultEnabled,
        vaultDefaultAsset: data.vaultDefaultAsset ?? null,
      });
    } catch (e: any) {
      toast({ title: "Could not save", description: e.message || "Please try again.", variant: "destructive" });
      settingsQuery.refetch();
    } finally {
      setSavingSettings(false);
    }
  };

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
    enabled: active && connected && vaultOn,
  });

  const positionsQuery = useQuery<{ positions: PositionView[]; scope?: "account" | "bot" }>({
    queryKey: ["vault-positions", publicKeyString, botId ?? null],
    queryFn: async () => {
      const res = await fetch(`/api/vault/positions${botQuery}`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load positions");
      return data as { positions: PositionView[]; scope?: "account" | "bot" };
    },
    enabled: active && connected,
  });

  const spareUsdc = assetsQuery.data?.spareUsdc ?? 0;
  const maxImpact = assetsQuery.data?.maxPriceImpactPct ?? 0.005;
  const assets = assetsQuery.data?.assets ?? [];
  const positions = positionsQuery.data?.positions ?? [];
  // Which wallet the server actually acted on. A Flash bot → its own per-bot wallet
  // ("bot"); a Pacifica/Drift bot shares the main account wallet ("account").
  const scope = assetsQuery.data?.scope ?? positionsQuery.data?.scope ?? null;

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["vault-assets", publicKeyString, botId ?? null] });
    queryClient.invalidateQueries({ queryKey: ["vault-positions", publicKeyString, botId ?? null] });
  };

  const positionByKey = useMemo(() => {
    const m = new Map<string, PositionView>();
    for (const p of positions) m.set(p.assetKey, p);
    return m;
  }, [positions]);

  const totalParked = useMemo(
    () => positions.reduce((sum, p) => sum + (p.currentValueUsdc ?? 0), 0),
    [positions],
  );
  const hasPositions = positions.length > 0;

  // Account mode: whether the "Earn" product card is expanded into the list.
  const [productOpen, setProductOpen] = useState(false);
  // The destination whose detail sheet is open (drives both park-all + unpark-all).
  const [detailAsset, setDetailAsset] = useState<YieldAssetInfo | null>(null);
  // Confirm sheet for unparking a holding that has no parkable asset row.
  const [unparkConfirm, setUnparkConfirm] = useState<{ assetKey: string; displayName: string } | null>(null);
  const [parking, setParking] = useState(false);
  const [unparking, setUnparking] = useState(false);
  const [showHow, setShowHow] = useState(false);

  const detailHeld = detailAsset ? positionByKey.get(detailAsset.key)?.onChainAmount ?? 0 : 0;
  const detailPosition = detailAsset ? positionByKey.get(detailAsset.key) ?? null : null;

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

  // Reset the expanded/detail state when the tab is hidden or the vault is off.
  useEffect(() => {
    if (!active || !vaultOn) {
      setProductOpen(false);
      setDetailAsset(null);
    }
  }, [active, vaultOn]);

  const handleParkAll = async () => {
    if (!detailAsset) return;
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
        body: JSON.stringify({ assetKey: detailAsset.key, all: true, sessionId, botId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Park failed");
      toast({
        title: "Parked",
        description: `Put ${usd(data.usdcSpent)} to work in ${detailAsset.displayName}.${data.dbWarning ? ` ${data.dbWarning}` : ""}`,
      });
      setDetailAsset(null);
      refetchAll();
    } catch (e: any) {
      toast({ title: "Park failed", description: e.message || "Something went wrong.", variant: "destructive" });
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
      setUnparkConfirm(null);
      refetchAll();
    } catch (e: any) {
      toast({ title: "Unpark failed", description: e.message || "Something went wrong.", variant: "destructive" });
    } finally {
      setUnparking(false);
    }
  };

  // --- Reusable pieces -------------------------------------------------------

  const spareStat = (
    <div className="bg-muted/30 rounded-lg border border-border/50 p-3 flex items-center gap-2">
      <Wallet className="w-4 h-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">USDC available to earn</span>
      <span className="ml-auto text-lg font-bold tabular-nums" data-testid="text-spare-usdc">
        {assetsQuery.isLoading ? "..." : usd(spareUsdc)}
      </span>
    </div>
  );

  const renderAssetCard = (a: YieldAssetInfo) => {
    const pos = positionByKey.get(a.key);
    const held = pos?.onChainAmount ?? 0;
    const value = pos?.currentValueUsdc ?? null;
    const pnl = pos?.unrealizedPnl ?? null;
    const pnlPositive = (pnl ?? 0) >= 0;
    return (
      <button
        key={a.key}
        type="button"
        onClick={() => setDetailAsset(a)}
        className="w-full text-left rounded-lg border border-border/50 hover:border-primary/50 hover:bg-muted/40 transition-colors p-3 flex items-center justify-between gap-3"
        data-testid={`card-asset-${a.key}`}
      >
        <div className="min-w-0 space-y-1">
          <div className="font-medium flex flex-wrap items-center gap-2">
            {a.displayName}
            <span className="text-xs text-muted-foreground tabular-nums">{a.apyLabel} APY</span>
            <RiskChip riskClass={a.riskClass} />
          </div>
          {a.mayLoseValue && (
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" /> Can lose value.
            </p>
          )}
          {held > 0 ? (
            <div className="text-xs tabular-nums text-muted-foreground" data-testid={`text-card-holding-${a.key}`}>
              Earning {usd(value)}
              {pnl !== null && (
                <span className={pnlPositive ? "text-emerald-500 ml-1" : "text-destructive ml-1"}>
                  ({pnlPositive ? "+" : ""}
                  {usd(pnl)})
                </span>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">{a.tag}</div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
    );
  };

  const renderHoldingCard = (p: PositionView) => {
    const pnl = p.unrealizedPnl;
    const pnlPositive = (pnl ?? 0) >= 0;
    return (
      <div key={p.assetKey} className="rounded-lg border border-border/50 p-3 space-y-2" data-testid={`row-position-${p.assetKey}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium truncate">{p.displayName}</div>
            <div className="text-xs text-muted-foreground tabular-nums">{tok(p.onChainAmount)} held</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setUnparkConfirm({ assetKey: p.assetKey, displayName: p.displayName })}
            data-testid={`button-unpark-${p.assetKey}`}
          >
            Unpark all
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Value</div>
            <div className="font-medium tabular-nums" data-testid={`text-value-${p.assetKey}`}>{usd(p.currentValueUsdc)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Cost</div>
            <div className="font-medium tabular-nums" data-testid={`text-basis-${p.assetKey}`}>
              {p.costBasisMissing ? "unknown" : usd(p.costBasisUsdc)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">P/L</div>
            <div
              className={`font-medium flex items-center gap-1 tabular-nums ${
                pnl === null ? "" : pnlPositive ? "text-emerald-500" : "text-destructive"
              }`}
              data-testid={`text-pnl-${p.assetKey}`}
            >
              {pnl === null ? (
                "n/a"
              ) : (
                <>
                  {pnlPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {pnlPositive ? "+" : ""}
                  {usd(pnl)}
                </>
              )}
            </div>
          </div>
        </div>
        {p.costBasisMissing && (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            We found this token in your wallet but have no record of its cost, so P/L is unavailable.
          </p>
        )}
      </div>
    );
  };

  // The destination list (shared by account-expanded and embedded modes).
  const destinationList = (
    <div className="space-y-3">
      {spareStat}
      <section data-testid="section-vault-assets" className="space-y-2">
        <h4 className="text-sm font-semibold">Where to earn</h4>
        {assetsQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : assets.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="text-no-assets">
            No yield destinations are available right now.
          </p>
        ) : (
          <div className="space-y-2">{assets.map(renderAssetCard)}</div>
        )}
      </section>
    </div>
  );

  // --- Render ----------------------------------------------------------------

  let body: ReactNode;

  if (!connected) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="text-vault-disconnected">
        Connect and sign in to use Vaults.
      </p>
    );
  } else if (embedded) {
    // -------- Per-bot mode: destinations directly, no product-card layer. --------
    body = (
      <div className="space-y-3" data-testid="vault-embedded">
        {scope && (
          <p className="text-xs text-muted-foreground" data-testid="text-vault-scope-note">
            {scope === "account"
              ? "This bot shares your main account wallet, so earning uses your shared account vault."
              : "Earning uses this bot's own wallet (its spare USDC)."}
          </p>
        )}
        {destinationList}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowHow(true)}
          data-testid="link-how-it-works"
        >
          <HelpCircle className="w-3.5 h-3.5" /> How Vaults work
        </button>
      </div>
    );
  } else if (!vaultOn) {
    // -------- Account mode, vault off: offer to turn on; never hide funds. --------
    body = (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 bg-muted/30 rounded-lg border border-border/50 p-4">
          <div className="flex-1">
            <p className="font-medium">Enable Vaults</p>
            <p className="text-sm text-muted-foreground mt-1">
              Earn on idle USDC. One tap in, one tap out. Your funds always stay in your own wallet.
            </p>
          </div>
          <Switch
            checked={vaultOn}
            disabled={!connected || settingsQuery.isLoading || savingSettings}
            onCheckedChange={(checked) => saveVaultSettings({ vaultEnabled: checked })}
            data-testid="switch-vault-enabled"
          />
        </div>
        {hasPositions && (
          <div className="space-y-2">
            <p className="text-xs text-amber-500 flex items-start gap-1.5" data-testid="text-vault-off-positions">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Vaults are off, so you cannot add new funds. You can still pull back what you already have.
            </p>
            {positions.map(renderHoldingCard)}
          </div>
        )}
      </div>
    );
  } else if (productOpen) {
    // -------- Account mode, vault on, product opened: destinations. --------
    body = (
      <div className="space-y-4">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setProductOpen(false)}
          data-testid="button-vault-back"
        >
          <ArrowLeft className="w-4 h-4" /> Vaults
        </button>
        {destinationList}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowHow(true)}
          data-testid="link-how-it-works"
        >
          <HelpCircle className="w-3.5 h-3.5" /> How Vaults work
        </button>
      </div>
    );
  } else {
    // -------- Account mode, vault on: the product home (one card for now). --------
    body = (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 bg-muted/30 rounded-lg border border-border/50 p-4">
          <div className="flex-1">
            <p className="font-medium">Vaults on</p>
            <p className="text-sm text-muted-foreground mt-1">
              Earn on idle USDC. One tap in, one tap out. Your funds always stay in your own wallet.
            </p>
          </div>
          <Switch
            checked={vaultOn}
            disabled={!connected || settingsQuery.isLoading || savingSettings}
            onCheckedChange={(checked) => saveVaultSettings({ vaultEnabled: checked })}
            data-testid="switch-vault-enabled"
          />
        </div>

        {/* Product cards. One today; a future "Auto" mode slots in beside it. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setProductOpen(true)}
            className="text-left rounded-xl border border-border/60 hover:border-primary/50 hover:bg-muted/40 transition-colors p-4 flex flex-col gap-3"
            data-testid="card-product-earn"
          >
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-primary/15">
                <Landmark className="w-5 h-5 text-primary" />
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
            <div>
              <div className="font-semibold">Earn</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Put idle USDC to work. One tap in, one tap out.
              </p>
            </div>
            <div className="mt-auto pt-2 border-t border-border/40 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Currently earning</div>
                <div className="font-semibold tabular-nums" data-testid="text-product-earning">
                  {positionsQuery.isLoading ? "..." : usd(totalParked)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Available to add</div>
                <div className="font-semibold tabular-nums" data-testid="text-product-available">
                  {assetsQuery.isLoading ? "..." : usd(spareUsdc)}
                </div>
              </div>
            </div>
          </button>
        </div>
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
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{detailAsset.apyLabel} APY</span>
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
                    onClick={handleParkAll}
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

      {/* Confirm unpark for an "other holding" (no parkable asset row). */}
      <Dialog open={!!unparkConfirm} onOpenChange={(o) => { if (!o) setUnparkConfirm(null); }}>
        <DialogContent data-testid="dialog-unpark-confirm">
          <DialogHeader>
            <DialogTitle>Unpark {unparkConfirm?.displayName} to USDC</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This pulls your full {unparkConfirm?.displayName} balance back to USDC, using the live on-chain amount.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnparkConfirm(null)} disabled={unparking} data-testid="button-unpark-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => unparkConfirm && handleUnparkAll(unparkConfirm.assetKey, unparkConfirm.displayName)}
              disabled={unparking}
              data-testid="button-unpark-confirm"
            >
              {unparking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Unparking
                </>
              ) : (
                "Unpark all"
              )}
            </Button>
          </DialogFooter>
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
