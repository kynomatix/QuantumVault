import { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  /** Longer plain-language note for the detail popover. */
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

function usePreview(args: {
  open: boolean;
  assetKey: string | null;
  direction: "park" | "unpark";
  amount: number;
  wallet: string | null;
}) {
  const { open, assetKey, direction, amount, wallet } = args;
  const [debounced, setDebounced] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amount), 350);
    return () => clearTimeout(id);
  }, [amount]);

  return useQuery<PreviewResponse>({
    queryKey: ["vault-preview", assetKey, direction, debounced, wallet],
    queryFn: async () => {
      const res = await fetch(
        `/api/vault/preview?assetKey=${encodeURIComponent(assetKey!)}&direction=${direction}&amount=${debounced}`,
        { credentials: "include", headers: walletAuthHeaders() },
      );
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Preview failed");
      return data as PreviewResponse;
    },
    enabled: open && !!assetKey && !!wallet && debounced > 0,
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
          <span>{preview.reason || "This swap would move the price too much. Try a smaller amount."}</span>
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
 * The full Idle Funds (Vault) module: master toggle, spare-USDC stat, parked
 * positions, parkable assets, default-asset override, and the park/unpark
 * dialogs. Rendered inline by the "Vault" tab in the app sidebar (App.tsx).
 * `active` gates the data queries (the host passes active); it lets the module
 * mount lazily without firing its queries until the tab is shown.
 *
 * When `botId` is passed (embedded in the bot drawer), it runs in per-bot mode:
 * the account-level master toggle and default-asset setting are hidden, all
 * reads/writes carry `?botId=`/`botId`, and a scope note explains whether this
 * acts on the bot's own wallet (Flash) or the shared account vault (Pacifica/Drift).
 */
export default function VaultIdleFunds({ active = true, botId }: { active?: boolean; botId?: string }) {
  const { publicKeyString, sessionConnected } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connected = !!publicKeyString && sessionConnected;
  // Embedded (per-bot) mode: rendered inside a bot drawer for a single bot. The
  // drawer's own reveal toggle gates this, so we skip the account-level master
  // toggle and default-asset setting, and scope all reads/writes to ?botId=.
  const embedded = !!botId;

  // Persisted vault settings (enable + default asset).
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

  // In embedded mode the drawer toggle is the gate, so the park UI is always "on".
  const vaultOn = embedded ? true : (settingsQuery.data?.vaultEnabled ?? false);
  const defaultAsset = settingsQuery.data?.vaultDefaultAsset ?? null;
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

  // --- Park dialog / embedded inline form ---
  // parkAsset doubles as the embedded dropdown selection (no dialog in that mode).
  const [parkAsset, setParkAsset] = useState<YieldAssetInfo | null>(null);
  const [parkAmount, setParkAmount] = useState("");
  const [parking, setParking] = useState(false);
  // "How parking works" dialog (embedded/per-bot mode only).
  const [showHow, setShowHow] = useState(false);
  const parkNum = Number(parkAmount) || 0;
  const parkPreview = usePreview({
    open: !!parkAsset,
    assetKey: parkAsset?.key ?? null,
    direction: "park",
    amount: parkNum,
    wallet: publicKeyString,
  });

  const closePark = () => {
    setParkAsset(null);
    setParkAmount("");
  };

  const handlePark = async () => {
    if (!parkAsset) return;
    if (!(parkNum > 0)) {
      toast({ title: "Enter an amount", description: "Type how much USDC to park.", variant: "destructive" });
      return;
    }
    if (parkNum > spareUsdc + 1e-9) {
      toast({
        title: "Not enough spare USDC",
        description: `You have ${usd(spareUsdc)} available to park.`,
        variant: "destructive",
      });
      return;
    }
    setParking(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/park", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ assetKey: parkAsset.key, amountUsdc: parkNum, sessionId, botId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Park failed");
      toast({
        title: "Parked",
        description: `Received ${tok(data.tokensReceived)} ${parkAsset.displayName}.${data.dbWarning ? ` ${data.dbWarning}` : ""}`,
      });
      // Embedded keeps the token selected (only clears the amount); account closes the dialog.
      if (embedded) setParkAmount("");
      else closePark();
      refetchAll();
    } catch (e: any) {
      toast({ title: "Park failed", description: e.message || "Something went wrong.", variant: "destructive" });
    } finally {
      setParking(false);
    }
  };

  // Embedded mode: auto-select a sensible default token so the dropdown isn't empty.
  useEffect(() => {
    if (!embedded || parkAsset || assets.length === 0) return;
    setParkAsset(assets.find((a) => a.defaultEligible) ?? assets[0]);
  }, [embedded, assets, parkAsset]);

  // --- Unpark dialog ---
  const [unparkPos, setUnparkPos] = useState<PositionView | null>(null);
  const [unparkAmount, setUnparkAmount] = useState("");
  const [unparkAll, setUnparkAll] = useState(false);
  const [unparking, setUnparking] = useState(false);
  const unparkNum = Number(unparkAmount) || 0;
  const unparkPreview = usePreview({
    open: !!unparkPos,
    assetKey: unparkPos?.assetKey ?? null,
    direction: "unpark",
    amount: unparkNum,
    wallet: publicKeyString,
  });

  const closeUnpark = () => {
    setUnparkPos(null);
    setUnparkAmount("");
    setUnparkAll(false);
  };

  const handleUnpark = async () => {
    if (!unparkPos) return;
    if (!unparkAll && !(unparkNum > 0)) {
      toast({ title: "Enter an amount", description: "Type how much to unpark, or choose Max.", variant: "destructive" });
      return;
    }
    if (!unparkAll && unparkNum > unparkPos.onChainAmount + 1e-9) {
      toast({
        title: "Amount too high",
        description: `You hold ${tok(unparkPos.onChainAmount)} ${unparkPos.displayName}.`,
        variant: "destructive",
      });
      return;
    }
    setUnparking(true);
    try {
      const sessionId = await getSessionId();
      const body: Record<string, unknown> = { assetKey: unparkPos.assetKey, sessionId, botId };
      if (unparkAll) body.all = true;
      else body.amountToken = unparkNum;
      const res = await fetch("/api/vault/unpark", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify(body),
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
      closeUnpark();
      refetchAll();
    } catch (e: any) {
      toast({ title: "Unpark failed", description: e.message || "Something went wrong.", variant: "destructive" });
    } finally {
      setUnparking(false);
    }
  };

  const totalParked = useMemo(
    () => positions.reduce((sum, p) => sum + (p.currentValueUsdc ?? 0), 0),
    [positions],
  );

  const hasPositions = positions.length > 0;

  const positionsBlock = (
    <section data-testid="section-vault-positions">
      <h4 className="text-sm font-semibold mb-2">Your parked positions</h4>
      {positionsQuery.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : !hasPositions ? (
        <p className="text-muted-foreground text-sm" data-testid="text-no-positions">
          You have not parked anything yet.
        </p>
      ) : (
        <div className="rounded-lg border border-border/50 divide-y divide-border/40 max-h-72 overflow-y-auto">
          {positions.map((p) => {
            const pnl = p.unrealizedPnl;
            const pnlPositive = (pnl ?? 0) >= 0;
            return (
              <div key={p.assetKey} className="p-3" data-testid={`row-position-${p.assetKey}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{p.displayName}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {tok(p.onChainAmount)} held
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setUnparkPos(p);
                      setUnparkAll(false);
                      setUnparkAmount("");
                    }}
                    data-testid={`button-unpark-${p.assetKey}`}
                  >
                    Unpark
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Value</div>
                    <div className="font-medium tabular-nums" data-testid={`text-value-${p.assetKey}`}>
                      {usd(p.currentValueUsdc)}
                    </div>
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
                  <p className="text-xs text-muted-foreground flex items-start gap-1.5 mt-2">
                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    We found this token in your wallet but have no record of its cost, so P/L is unavailable.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <>
      <div className="space-y-4">
        {/* Master toggle (account-level only; the bot drawer has its own reveal toggle) */}
        {!embedded && (
          <div className="flex items-start justify-between gap-3 bg-muted/30 rounded-lg border border-border/50 p-4">
            <div className="flex-1">
              <p className="font-medium">Enable Vault</p>
              <p className="text-sm text-muted-foreground mt-1">
                Put idle USDC to work by parking it in a yield token. Your funds always stay in your own wallet.
              </p>
            </div>
            <Switch
              checked={vaultOn}
              disabled={!connected || settingsQuery.isLoading || savingSettings}
              onCheckedChange={(checked) => saveVaultSettings({ vaultEnabled: checked })}
              data-testid="switch-vault-enabled"
            />
          </div>
        )}

        {!connected ? (
          <p className="text-sm text-muted-foreground" data-testid="text-vault-disconnected">
            Connect and sign in to use the Vault.
          </p>
        ) : !vaultOn ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-vault-off-hint">
              Turn on to see your options for earning yield on spare USDC.
            </p>
            {/* Even when off, never hide existing parked funds. */}
            {hasPositions && (
              <div className="space-y-2">
                <p className="text-xs text-amber-500 flex items-start gap-1.5" data-testid="text-vault-off-positions">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Vault is off, so you cannot park new funds. You can still unpark what you already have.
                </p>
                {positionsBlock}
              </div>
            )}
          </>
        ) : embedded ? (
          /* ---------- Compact per-bot dropdown form ---------- */
          <div className="space-y-3" data-testid="vault-embedded">
            {scope && (
              <p className="text-xs text-muted-foreground" data-testid="text-vault-scope-note">
                {scope === "account"
                  ? "This bot shares your main account wallet, so parking uses your shared account vault."
                  : "Parking uses this bot's own wallet (its spare USDC)."}
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
                  <Label className="text-xs text-muted-foreground mb-1 block">Token</Label>
                  <Select
                    value={parkAsset?.key ?? ""}
                    onValueChange={(k) => {
                      setParkAsset(assets.find((a) => a.key === k) ?? null);
                      setParkAmount("");
                    }}
                  >
                    <SelectTrigger className="h-9" data-testid="select-park-asset">
                      <SelectValue placeholder="Choose a token" />
                    </SelectTrigger>
                    <SelectContent>
                      {assets.map((a) => (
                        <SelectItem key={a.key} value={a.key} data-testid={`option-park-${a.key}`}>
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{a.displayName}</span>
                            <span className="text-xs text-muted-foreground">{a.apyLabel}</span>
                            <RiskChip riskClass={a.riskClass} />
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {parkAsset && (
                  <>
                    <div
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                      data-testid="text-selected-meta"
                    >
                      <span className="text-muted-foreground tabular-nums">{parkAsset.apyLabel} APY</span>
                      <RiskChip riskClass={parkAsset.riskClass} />
                      {parkAsset.mayLoseValue && (
                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="w-3 h-3" /> may lose value
                        </span>
                      )}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <Label htmlFor="park-amount" className="text-xs text-muted-foreground">
                          Amount (USDC)
                        </Label>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline disabled:opacity-50"
                          onClick={() => setParkAmount(String(spareUsdc))}
                          disabled={spareUsdc <= 0}
                          data-testid="button-park-max"
                        >
                          Max {usd(spareUsdc)}
                        </button>
                      </div>
                      <Input
                        id="park-amount"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={parkAmount}
                        onChange={(e) => setParkAmount(e.target.value)}
                        data-testid="input-park-amount"
                      />
                    </div>

                    {parkNum > 0 && (
                      <PreviewBox
                        loading={parkPreview.isFetching}
                        preview={parkPreview.data}
                        outLabel={parkAsset.displayName}
                        cap={maxImpact}
                      />
                    )}

                    <Button
                      onClick={handlePark}
                      disabled={parking || !(parkNum > 0) || (parkPreview.data?.wouldReject ?? false)}
                      className="w-full"
                      data-testid="button-park-confirm"
                    >
                      {parking ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parking
                        </>
                      ) : (
                        "Park"
                      )}
                    </Button>
                  </>
                )}
              </div>
            )}

            {hasPositions && positionsBlock}

            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowHow(true)}
              data-testid="link-how-it-works"
            >
              <HelpCircle className="w-3.5 h-3.5" /> How parking works
            </button>
          </div>
        ) : (
          /* ---------- Account-level full module (teaching home) ---------- */
          <>
            <div
              className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm"
              data-testid="box-vault-about"
            >
              <div className="flex items-start gap-2 text-muted-foreground">
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                <span>
                  Park idle USDC into a yield token to earn while it waits. Your funds never leave your
                  wallet; we only handle the swap, and each park or unpark is capped at{" "}
                  {(maxImpact * 100).toFixed(2)}% price impact.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <RiskChip riskClass="stable" /> trades near $1, earns yield
                </span>
                <span className="flex items-center gap-1.5">
                  <RiskChip riskClass="float" /> price can move
                </span>
              </div>
            </div>

            {/* Spare USDC stat */}
            <div className="bg-muted/30 rounded-lg border border-border/50 p-3 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">USDC available to park</span>
              <span className="ml-auto text-lg font-bold tabular-nums" data-testid="text-spare-usdc">
                {assetsQuery.isLoading ? "..." : usd(spareUsdc)}
              </span>
            </div>

            {hasPositions && positionsBlock}

            {/* Parkable assets table */}
            <section data-testid="section-vault-assets">
              <h4 className="text-sm font-semibold mb-2">Available to park</h4>
              {assetsQuery.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : assets.length === 0 ? (
                <p className="text-muted-foreground text-sm" data-testid="text-no-assets">
                  No yield assets are available right now.
                </p>
              ) : (
                <div className="rounded-lg border border-border/50 divide-y divide-border/40">
                  {assets.map((a) => (
                    <div
                      key={a.key}
                      className="p-3 flex items-center justify-between gap-3"
                      data-testid={`row-asset-${a.key}`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium flex flex-wrap items-center gap-2">
                          {a.displayName}
                          <span className="text-xs text-muted-foreground tabular-nums">{a.apyLabel} APY</span>
                          <RiskChip riskClass={a.riskClass} />
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`About ${a.displayName}`}
                                data-testid={`button-detail-${a.key}`}
                              >
                                <Info className="w-3.5 h-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="max-w-xs text-xs leading-relaxed"
                              data-testid={`popover-detail-${a.key}`}
                            >
                              {a.riskNote}
                            </PopoverContent>
                          </Popover>
                        </div>
                        {a.mayLoseValue && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3" /> Can lose value.
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => {
                          setParkAsset(a);
                          setParkAmount("");
                        }}
                        disabled={spareUsdc <= 0}
                        data-testid={`button-park-${a.key}`}
                      >
                        Park
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Default asset override (subtle footer; account-level only) */}
            {assets.length > 0 && (
              <div className="flex items-center gap-2 pt-1" data-testid="row-default-asset">
                <span className="text-xs text-muted-foreground">Default for new parks</span>
                <Select
                  value={defaultAsset ?? ""}
                  disabled={savingSettings}
                  onValueChange={(v) => saveVaultSettings({ vaultDefaultAsset: v })}
                >
                  <SelectTrigger className="h-8 w-44 text-xs ml-auto" data-testid="select-default-asset">
                    <SelectValue placeholder="Choose a token" />
                  </SelectTrigger>
                  <SelectContent>
                    {assets.map((a) => (
                      <SelectItem key={a.key} value={a.key} data-testid={`option-default-${a.key}`}>
                        {a.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}
      </div>

      {/* Park dialog (account mode only; embedded mode parks inline). */}
      <Dialog open={!embedded && !!parkAsset} onOpenChange={(o) => { if (!o) closePark(); }}>
        <DialogContent data-testid="dialog-park">
          <DialogHeader>
            <DialogTitle>Park USDC into {parkAsset?.displayName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor="park-amount">Amount (USDC)</Label>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setParkAmount(String(spareUsdc))}
                  data-testid="button-park-max"
                >
                  Max {usd(spareUsdc)}
                </button>
              </div>
              <Input
                id="park-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={parkAmount}
                onChange={(e) => setParkAmount(e.target.value)}
                data-testid="input-park-amount"
              />
            </div>
            {parkAsset?.priceFloats && (
              <div
                className="flex items-start gap-2 text-xs text-muted-foreground rounded-lg border border-border bg-muted/30 p-2.5"
                data-testid="warning-floating-nav-park"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                <span>
                  This token's value goes up and down with the market. You may get back more or less than you put in.
                </span>
              </div>
            )}
            <PreviewBox
              loading={parkPreview.isFetching}
              preview={parkPreview.data}
              outLabel={parkAsset?.displayName ?? ""}
              cap={maxImpact}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePark} disabled={parking} data-testid="button-park-cancel">
              Cancel
            </Button>
            <Button
              onClick={handlePark}
              disabled={parking || (parkPreview.data?.wouldReject ?? false)}
              data-testid="button-park-confirm"
            >
              {parking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parking
                </>
              ) : (
                "Confirm park"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unpark dialog */}
      <Dialog open={!!unparkPos} onOpenChange={(o) => { if (!o) closeUnpark(); }}>
        <DialogContent data-testid="dialog-unpark">
          <DialogHeader>
            <DialogTitle>Unpark {unparkPos?.displayName} to USDC</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor="unpark-amount">Amount ({unparkPos?.displayName})</Label>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    setUnparkAll(true);
                    setUnparkAmount(unparkPos ? String(unparkPos.onChainAmount) : "");
                  }}
                  data-testid="button-unpark-max"
                >
                  Max {tok(unparkPos?.onChainAmount)}
                </button>
              </div>
              <Input
                id="unpark-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={unparkAmount}
                onChange={(e) => {
                  setUnparkAmount(e.target.value);
                  setUnparkAll(false);
                }}
                data-testid="input-unpark-amount"
              />
              {unparkAll && (
                <p className="text-xs text-muted-foreground mt-1" data-testid="text-unpark-all">
                  Unparking your full balance (uses live on-chain amount).
                </p>
              )}
            </div>
            <PreviewBox loading={unparkPreview.isFetching} preview={unparkPreview.data} outLabel="USDC" cap={maxImpact} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeUnpark} disabled={unparking} data-testid="button-unpark-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleUnpark}
              disabled={unparking || (unparkPreview.data?.wouldReject ?? false)}
              data-testid="button-unpark-confirm"
            >
              {unparking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Unparking
                </>
              ) : (
                "Confirm unpark"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* How parking works (embedded/per-bot mode link) */}
      <Dialog open={showHow} onOpenChange={setShowHow}>
        <DialogContent data-testid="dialog-how-it-works">
          <DialogHeader>
            <DialogTitle>How parking works</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Parking puts idle USDC into a yield token so it earns while it waits. Your funds stay in
              this wallet; we only do the swap.
            </p>
            <p>
              Each park or unpark is capped at {(maxImpact * 100).toFixed(2)}% price impact, so a thin
              market cannot move your money at a bad price.
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              <RiskChip riskClass="stable" /> tokens trade near $1 and earn yield.
              <RiskChip riskClass="float" /> tokens can move in price, and one (OnRe ONyc) can lose value.
            </p>
            <p>See the Vault tab in the sidebar for full details on each token.</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
