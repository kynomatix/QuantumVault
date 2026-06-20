import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Vault as VaultIcon, TrendingUp, TrendingDown, Loader2, Info, AlertTriangle, Wallet } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface YieldAssetInfo {
  key: string;
  displayName: string;
  mint: string;
  decimals: number;
  type: string;
  tag: string;
  defaultEligible: boolean;
}

interface AssetsResponse {
  spareUsdc: number;
  maxPriceImpactPct: number;
  assets: YieldAssetInfo[];
}

interface PositionView {
  assetKey: string;
  displayName: string;
  mint: string;
  decimals: number;
  type: string;
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

const usd = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined ? "n/a" : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
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

// Debounced live preview for a park/unpark amount.
function usePreview(args: { open: boolean; assetKey: string | null; direction: "park" | "unpark"; amount: number; wallet: string | null }) {
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

function PreviewBox({ loading, preview, outLabel, cap }: { loading: boolean; preview: PreviewResponse | undefined; outLabel: string; cap: number }) {
  if (loading) {
    return <Skeleton className="h-16 w-full" data-testid="skeleton-preview" />;
  }
  if (!preview) return null;
  const impactPct = preview.priceImpactPct === null ? null : preview.priceImpactPct * 100;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1" data-testid="box-preview">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">You receive (estimated)</span>
        <span className="font-medium" data-testid="text-preview-out">{tok(preview.expectedOut)} {outLabel}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Price impact</span>
        <span className={impactPct !== null && impactPct > cap * 100 ? "text-destructive font-medium" : "font-medium"} data-testid="text-preview-impact">
          {impactPct === null ? "unknown" : `${impactPct.toFixed(2)}%`}
        </span>
      </div>
      {preview.wouldReject && (
        <div className="flex items-start gap-2 text-destructive pt-1" data-testid="text-preview-reject">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{preview.reason || "This swap would be rejected."}</span>
        </div>
      )}
    </div>
  );
}

export default function VaultPage() {
  const { publicKeyString, sessionConnected } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const enabled = !!publicKeyString && sessionConnected;

  const assetsQuery = useQuery<AssetsResponse>({
    queryKey: ["vault-assets", publicKeyString],
    queryFn: async () => {
      const res = await fetch(`/api/vault/assets`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load vault assets");
      return data as AssetsResponse;
    },
    enabled,
  });

  const positionsQuery = useQuery<{ positions: PositionView[] }>({
    queryKey: ["vault-positions", publicKeyString],
    queryFn: async () => {
      const res = await fetch(`/api/vault/positions`, { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load positions");
      return data as { positions: PositionView[] };
    },
    enabled,
  });

  const spareUsdc = assetsQuery.data?.spareUsdc ?? 0;
  const maxImpact = assetsQuery.data?.maxPriceImpactPct ?? 0.005;
  const assets = assetsQuery.data?.assets ?? [];
  const positions = positionsQuery.data?.positions ?? [];

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["vault-assets", publicKeyString] });
    queryClient.invalidateQueries({ queryKey: ["vault-positions", publicKeyString] });
  };

  // --- Park dialog ---
  const [parkAsset, setParkAsset] = useState<YieldAssetInfo | null>(null);
  const [parkAmount, setParkAmount] = useState("");
  const [parking, setParking] = useState(false);
  const parkNum = Number(parkAmount) || 0;
  const parkPreview = usePreview({ open: !!parkAsset, assetKey: parkAsset?.key ?? null, direction: "park", amount: parkNum, wallet: publicKeyString });

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
      toast({ title: "Not enough spare USDC", description: `You have ${usd(spareUsdc)} available to park.`, variant: "destructive" });
      return;
    }
    setParking(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/park", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ assetKey: parkAsset.key, amountUsdc: parkNum, sessionId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Park failed");
      toast({
        title: "Parked",
        description: `Received ${tok(data.tokensReceived)} ${parkAsset.displayName}.${data.dbWarning ? ` ${data.dbWarning}` : ""}`,
      });
      closePark();
      refetchAll();
    } catch (e: any) {
      toast({ title: "Park failed", description: e.message || "Something went wrong.", variant: "destructive" });
    } finally {
      setParking(false);
    }
  };

  // --- Unpark dialog ---
  const [unparkPos, setUnparkPos] = useState<PositionView | null>(null);
  const [unparkAmount, setUnparkAmount] = useState("");
  const [unparkAll, setUnparkAll] = useState(false);
  const [unparking, setUnparking] = useState(false);
  const unparkNum = Number(unparkAmount) || 0;
  const unparkPreview = usePreview({ open: !!unparkPos, assetKey: unparkPos?.assetKey ?? null, direction: "unpark", amount: unparkNum, wallet: publicKeyString });

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
      toast({ title: "Amount too high", description: `You hold ${tok(unparkPos.onChainAmount)} ${unparkPos.displayName}.`, variant: "destructive" });
      return;
    }
    setUnparking(true);
    try {
      const sessionId = await getSessionId();
      const body: Record<string, unknown> = { assetKey: unparkPos.assetKey, sessionId };
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
      const pnl = typeof data.realizedPnl === "number" ? ` Realized P/L: ${data.realizedPnl >= 0 ? "+" : ""}${usd(data.realizedPnl)}.` : "";
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

  if (!enabled) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Header />
        <div className="max-w-3xl mx-auto px-4 py-20 text-center" data-testid="state-disconnected">
          <VaultIcon className="w-10 h-10 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">Connect your wallet</h2>
          <p className="text-muted-foreground">Connect and sign in to view your Vault.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6" data-testid="page-vault">
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card data-testid="card-spare-usdc">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Wallet className="w-4 h-4" /> Spare USDC in bot wallet
              </CardTitle>
            </CardHeader>
            <CardContent>
              {assetsQuery.isLoading ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-spare-usdc">{usd(spareUsdc)}</div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Idle cash not in a trade.</p>
            </CardContent>
          </Card>
          <Card data-testid="card-total-parked">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <VaultIcon className="w-4 h-4" /> Parked value
              </CardTitle>
            </CardHeader>
            <CardContent>
              {positionsQuery.isLoading ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-total-parked">{usd(totalParked)}</div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Current value of parked assets.</p>
            </CardContent>
          </Card>
        </div>

        {/* About */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-start gap-2 text-sm text-muted-foreground" data-testid="box-about">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Park moves idle USDC from your bot wallet into a yield token, held in that same wallet. Your funds stay
            yours and you can unpark back to USDC anytime. Swaps are capped at {(maxImpact * 100).toFixed(2)}% price impact.
          </span>
        </div>

        {/* Available assets */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Available to park</h3>
          {assetsQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : assets.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="text-no-assets">No yield assets are available right now.</p>
          ) : (
            <div className="space-y-3">
              {assets.map((a) => (
                <Card key={a.key} data-testid={`card-asset-${a.key}`}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {a.displayName}
                        <Badge variant="secondary" data-testid={`badge-tag-${a.key}`}>{a.tag}</Badge>
                      </div>
                      {a.type === "floating_nav" && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Value floats with the token price. It can move up or down.
                        </p>
                      )}
                    </div>
                    <Button onClick={() => setParkAsset(a)} disabled={spareUsdc <= 0} data-testid={`button-park-${a.key}`}>
                      Park
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Positions */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Your parked positions</h3>
          {positionsQuery.isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : positions.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="text-no-positions">You have not parked anything yet.</p>
          ) : (
            <div className="space-y-3">
              {positions.map((p) => {
                const pnl = p.unrealizedPnl;
                const pnlPositive = (pnl ?? 0) >= 0;
                return (
                  <Card key={p.assetKey} data-testid={`card-position-${p.assetKey}`}>
                    <CardContent className="py-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{p.displayName}</div>
                        <Button variant="outline" onClick={() => { setUnparkPos(p); setUnparkAll(false); setUnparkAmount(""); }} data-testid={`button-unpark-${p.assetKey}`}>
                          Unpark
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div>
                          <div className="text-muted-foreground text-xs">Holding</div>
                          <div className="font-medium" data-testid={`text-amount-${p.assetKey}`}>{tok(p.onChainAmount)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Value</div>
                          <div className="font-medium" data-testid={`text-value-${p.assetKey}`}>{usd(p.currentValueUsdc)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Cost basis</div>
                          <div className="font-medium" data-testid={`text-basis-${p.assetKey}`}>{p.costBasisMissing ? "unknown" : usd(p.costBasisUsdc)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Unrealized P/L</div>
                          <div className={`font-medium flex items-center gap-1 ${pnl === null ? "" : pnlPositive ? "text-emerald-500" : "text-destructive"}`} data-testid={`text-pnl-${p.assetKey}`}>
                            {pnl === null ? "n/a" : (
                              <>
                                {pnlPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                                {pnlPositive ? "+" : ""}{usd(pnl)}
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
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Park dialog */}
      <Dialog open={!!parkAsset} onOpenChange={(o) => { if (!o) closePark(); }}>
        <DialogContent data-testid="dialog-park">
          <DialogHeader>
            <DialogTitle>Park USDC into {parkAsset?.displayName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor="park-amount">Amount (USDC)</Label>
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => setParkAmount(String(spareUsdc))} data-testid="button-park-max">
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
            {parkAsset?.type === "floating_nav" && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground rounded-lg border border-border bg-muted/30 p-2.5" data-testid="warning-floating-nav-park">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                <span>This token's value floats with its price. It is not a fixed dollar amount and can lose value.</span>
              </div>
            )}
            <PreviewBox loading={parkPreview.isFetching} preview={parkPreview.data} outLabel={parkAsset?.displayName ?? ""} cap={maxImpact} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePark} disabled={parking} data-testid="button-park-cancel">Cancel</Button>
            <Button onClick={handlePark} disabled={parking || (parkPreview.data?.wouldReject ?? false)} data-testid="button-park-confirm">
              {parking ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parking</> : "Confirm park"}
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
                  onClick={() => { setUnparkAll(true); setUnparkAmount(unparkPos ? String(unparkPos.onChainAmount) : ""); }}
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
                onChange={(e) => { setUnparkAmount(e.target.value); setUnparkAll(false); }}
                data-testid="input-unpark-amount"
              />
              {unparkAll && (
                <p className="text-xs text-muted-foreground mt-1" data-testid="text-unpark-all">Unparking your full balance (uses live on-chain amount).</p>
              )}
            </div>
            <PreviewBox loading={unparkPreview.isFetching} preview={unparkPreview.data} outLabel="USDC" cap={maxImpact} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeUnpark} disabled={unparking} data-testid="button-unpark-cancel">Cancel</Button>
            <Button onClick={handleUnpark} disabled={unparking || (unparkPreview.data?.wouldReject ?? false)} data-testid="button-unpark-confirm">
              {unparking ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Unparking</> : "Confirm unpark"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-border">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
        <a href="/app" className="p-2 hover:bg-muted rounded-lg" data-testid="link-back-app" title="Back to app">
          <ArrowLeft className="w-5 h-5" />
        </a>
        <div className="flex items-center gap-2">
          <VaultIcon className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">Vault</h1>
        </div>
      </div>
    </header>
  );
}
