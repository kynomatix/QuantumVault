import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RefreshCw, Repeat } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { getSessionId, toRawBaseUnits, rawToDecimalString } from "@/lib/lending-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Owner-only SOL Loop vault card (P2 exit-gate surface). Renders as one more
// card in the account Vaults grid, matching the look of the other vault cards;
// clicking it opens a dialog with the loop controls (open / unwind / close).
// Self-gating: the server returns 401/403 for non-owner wallets and the card
// renders nothing in that case, so no other user ever sees it.

const LOOP_VAULTS: Array<{ id: number; symbol: string }> = [
  { id: 4, symbol: "JupSOL" },
  { id: 47, symbol: "mSOL" },
];

interface LoopLive {
  collateralRaw: string;
  debtRaw: string;
  liquidatable: boolean;
  oraclePriceUsd: number | null;
}

interface LoopRow {
  id: string;
  status: string;
  venueVaultId: string | null;
  venuePositionId: string | null;
  collateralAssetKey: string;
  collateralAmountRaw: string;
  debtAmountRaw: string;
  live: LoopLive | null;
}

const fmtSol = (raw: string | null | undefined, dp = 4): string => {
  if (!raw) return "—";
  try {
    return Number(rawToDecimalString(raw, 9)).toFixed(dp);
  } catch {
    return "—";
  }
};

const vaultSymbol = (venueVaultId: string | null): string => {
  const v = LOOP_VAULTS.find((x) => String(x.id) === String(venueVaultId ?? ""));
  return v?.symbol ?? `vault ${venueVaultId ?? "?"}`;
};

export default function LoopVaultControls({ active }: { active: boolean }) {
  const { toast } = useToast();
  const { retryAuth } = useWallet();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [vaultId, setVaultId] = useState<string>("4");
  const [amountSol, setAmountSol] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);

  const statusQuery = useQuery<{ positions: LoopRow[] } | null>({
    queryKey: ["/api/vault/loop/status"],
    enabled: active,
    refetchInterval: active ? 20000 : false,
    queryFn: async () => {
      const res = await fetch("/api/vault/loop/status", {
        credentials: "include",
        headers: walletAuthHeaders(),
      });
      if (res.status === 403 || res.status === 401) return null; // not the owner / signed out -> hide
      if (!res.ok) throw new Error("Loop status failed");
      return await safeResponseJson(res);
    },
  });

  // Hide entirely unless the server confirms this wallet may see the loop.
  if (!statusQuery.data) return null;
  const rows = statusQuery.data.positions ?? [];
  const activeRows = rows.filter((r) => r.status === "open" || r.status === "pending");
  const isActive = activeRows.length > 0;
  const totalDebtLamports = activeRows.reduce((acc, r) => {
    try {
      return acc + BigInt(r.live?.debtRaw ?? r.debtAmountRaw ?? "0");
    } catch {
      return acc;
    }
  }, 0n);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/vault/loop/status"] });

  const doOp = async (key: string, path: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(key);
    try {
      const sessionId = await getSessionId();
      const res = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ ...body, sessionId }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Operation failed");
      }
      toast({ title: okMsg, description: data.signature ? `Tx: ${String(data.signature).slice(0, 16)}…` : undefined });
      setAmountSol("");
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({
          toast,
          retryAuth,
          title: "Loop operation failed",
          retry: () => void doOp(key, path, body, okMsg),
        });
      } else {
        toast({ title: "Loop operation failed", description: e?.message || String(e), variant: "destructive" });
      }
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const runMoneyOp = (key: string, path: string, body: Record<string, unknown>, okMsg: string) => {
    if (confirmAction !== key) {
      setConfirmAction(key);
      setTimeout(() => setConfirmAction((c) => (c === key ? null : c)), 5000);
      return;
    }
    setConfirmAction(null);
    void doOp(key, path, body, okMsg);
  };

  const principalLamports = toRawBaseUnits(amountSol, 9);
  const openDisabled = !!busy || !principalLamports || BigInt(principalLamports) <= 0n;
  const label = (key: string, normal: string) => (confirmAction === key ? "Confirm?" : normal);

  return (
    <>
      {/* --- Card (matches the other vault destination cards) --- */}
      <div
        role="button"
        tabIndex={0}
        aria-label="SOL Loop vault"
        className="gradient-border p-5 noise hover:scale-[1.01] transition-transform cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        data-testid="card-asset-sol-loop"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                isActive ? "bg-gradient-to-br from-primary to-accent" : "bg-gradient-to-br from-primary/30 to-accent/30"
              }`}
            >
              <Repeat className={`w-6 h-6 ${isActive ? "text-white" : "text-primary"}`} />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base truncate">SOL Loop</h3>
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="tabular-nums">2x staking loop</span>
                <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-500">
                  Owner test
                </span>
              </p>
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${
              isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"
            }`}
            data-testid="status-loop-card"
          >
            {isActive ? "Active" : "Idle"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums">2x</p>
            <p className="text-xs text-muted-foreground">Leverage</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums" data-testid="stat-loop-positions">
              {activeRows.length}
            </p>
            <p className="text-xs text-muted-foreground">Positions</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums" data-testid="stat-loop-debt">
              {isActive ? fmtSol(totalDebtLamports.toString(), 3) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Debt (SOL)</p>
          </div>
        </div>

        {activeRows.some((r) => r.live?.liquidatable) && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-red-500">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> A position is liquidatable.
          </p>
        )}
      </div>

      {/* --- Detail dialog with the loop controls --- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-loop-controls">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat className="w-4 h-4 text-primary" /> SOL Loop
            </DialogTitle>
            <DialogDescription>
              Leveraged LST staking loop on Jupiter Lend Multiply. Fixed 2x. Owner-only test surface — dust amounts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-end gap-2">
                <div className="w-32">
                  <p className="text-xs text-muted-foreground mb-1">Vault</p>
                  <Select
                    value={vaultId}
                    onValueChange={(v) => {
                      setVaultId(v);
                      setConfirmAction(null);
                    }}
                  >
                    <SelectTrigger data-testid="select-loop-vault">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOOP_VAULTS.map((v) => (
                        <SelectItem key={v.id} value={String(v.id)}>
                          {v.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground mb-1">Principal (SOL)</p>
                  <Input
                    inputMode="decimal"
                    placeholder="0.02"
                    value={amountSol}
                    onChange={(e) => {
                      setAmountSol(e.target.value);
                      setConfirmAction(null);
                    }}
                    data-testid="input-loop-principal"
                  />
                </div>
              </div>
              <Button
                className="w-full"
                disabled={openDisabled}
                onClick={() =>
                  runMoneyOp("open", "/api/vault/loop/open", { vaultId: Number(vaultId), principalLamports }, "Loop opened")
                }
                data-testid="button-loop-open"
              >
                {busy === "open" ? <Loader2 className="h-4 w-4 animate-spin" /> : label("open", "Open 2x Loop")}
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">Positions</p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={refresh}
                  disabled={statusQuery.isFetching}
                  data-testid="button-loop-refresh"
                >
                  {statusQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </Button>
              </div>

              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No loop positions yet.</p>
              ) : (
                rows.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5"
                    data-testid={`row-loop-${r.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{vaultSymbol(r.venueVaultId)}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          r.status === "open"
                            ? "bg-emerald-500/15 text-emerald-500"
                            : r.status === "pending"
                              ? "bg-amber-500/15 text-amber-500"
                              : "bg-muted text-muted-foreground"
                        }`}
                        data-testid={`status-loop-${r.id}`}
                      >
                        {r.status}
                      </span>
                      {r.live?.liquidatable && (
                        <span className="flex items-center gap-1 text-red-500">
                          <AlertTriangle className="h-3 w-3" /> liquidatable
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Collateral: {fmtSol(r.live?.collateralRaw ?? r.collateralAmountRaw)} {vaultSymbol(r.venueVaultId)}
                      {" · "}Debt: {fmtSol(r.live?.debtRaw ?? r.debtAmountRaw)} SOL
                      {r.live ? " (live)" : " (last known)"}
                    </p>
                    {(r.status === "open" || r.status === "pending") && (
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!busy || r.status !== "open"}
                          onClick={() =>
                            runMoneyOp(
                              `unwind-${r.id}`,
                              "/api/vault/loop/unwind",
                              { borrowPositionId: r.id, unwindBps: 3000 },
                              "Unwound 30%",
                            )
                          }
                          data-testid={`button-loop-unwind-${r.id}`}
                        >
                          {busy === `unwind-${r.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            label(`unwind-${r.id}`, "Unwind 30%")
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!!busy || r.status !== "open"}
                          onClick={() =>
                            runMoneyOp(
                              `close-${r.id}`,
                              "/api/vault/loop/close",
                              { borrowPositionId: r.id },
                              "Loop closed",
                            )
                          }
                          data-testid={`button-loop-close-${r.id}`}
                        >
                          {busy === `close-${r.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            label(`close-${r.id}`, "Close Loop")
                          )}
                        </Button>
                      </div>
                    )}
                    {r.status === "pending" && (
                      <p className="text-[11px] text-amber-500">
                        Pending — confirmation unresolved; new opens on this vault are blocked until reconciled.
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
