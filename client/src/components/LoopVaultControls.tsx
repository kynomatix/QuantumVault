import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { Loader2, AlertTriangle, RefreshCw, Repeat, ArrowUpFromLine } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { getSessionId, toRawBaseUnits, rawToDecimalString } from "@/lib/lending-format";
import { confirmTransactionWithFallback } from "@/lib/solana-utils";
import { SolGasShortfallDialog } from "@/components/SolGasShortfallDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Owner-only SOL Loop vault card (P2 exit-gate surface). Renders as one more
// card in the account Vaults grid, matching the look of the other vault cards;
// clicking it opens a dialog with the loop controls (open / unwind / close).
// Self-gating: the server returns 401/403 for non-owner wallets and the card
// renders nothing in that case, so no other user ever sees it.
//
// OWNER UI RULES (plan §4.5 — re-read it before touching this surface):
// - The user NEVER picks the LST. The platform auto-picks the best pair
//   server-side; the dialog only SHOWS which LST is in use.
// - The agent wallet is GAS PLUMBING, never a user-facing balance, and its
//   SOL is NEVER touched in either direction:
//   * OPEN is deposit-first: preflight the exact bar, collect the FULL bar
//     from the USER's wallet, then open — pre-existing agent SOL is never
//     consumed as principal.
//   * CLOSE/UNWIND auto-return EXACTLY the server-reported proceeds
//     (solReturnedLamports) to the USER's wallet — never a balance sweep
//     that would drain the agent's gas float.
//   The only agent-wallet surface allowed is a recovery row for tracked
//   proceeds whose auto-return failed (never derived from wallet balance).

// Display names for position rows only (venueVaultId -> symbol). NOT a picker.
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
  const { retryAuth, publicKeyString } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amountSol, setAmountSol] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  // Set when a loop op needs SOL from the user's wallet: exact server numbers
  // + a retry closure. For OPEN this IS the primary deposit step (principal +
  // rent + fees, deposit-framed); for close/unwind it's a small gas top-up.
  const [shortfall, setShortfall] = useState<{ requiredSol: number; heldSol: number; reason: string; kind: "open" | "fees"; retry: () => void } | null>(null);

  const statusQuery = useQuery<{
    positions: LoopRow[];
    recommended?: {
      vaultId: number;
      symbol: string;
      targetLeverage: number | null;
      netCarryAtTarget: number | null;
      netCarry2x: number | null;
    } | null;
  } | null>({
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

  // Internal gas-wallet SOL — plumbing only, never a user-facing balance.
  // Read so close/unwind proceeds can be auto-returned to the user's wallet
  // and so the recovery row can appear if any SOL ever strands there.
  // Only polled while the dialog is open.
  const balanceQuery = useQuery<{ solBalance: number } | null>({
    queryKey: ["/api/agent/balance", "loop-dialog"],
    enabled: active && open,
    queryFn: async () => {
      const res = await fetch("/api/agent/balance", {
        credentials: "include",
        headers: walletAuthHeaders(),
      });
      if (!res.ok) return null;
      return await safeResponseJson(res);
    },
  });

  // Stranded-proceeds tracker (wallet-scoped, survives reloads). ONLY SOL that
  // a close/unwind actually returned — as reported by the server — may ever be
  // offered back to the user. Never derived from the wallet balance, so the
  // agent's own gas float can never show up here.
  const pendingKey = `qv-loop-pending-return:${publicKeyString ?? "unknown"}`;
  const [pendingReturnSol, setPendingReturnSol] = useState(0);
  // Ref (not state) guard: closes the sub-second window where an auto-return
  // is in flight but `busy` reads stale in a manual click's closure — a
  // double-send would eat the agent's gas float. MUST be declared BEFORE the
  // `!statusQuery.data` early return below — a hook after a conditional
  // return crashes the whole page ("Rendered more hooks than during the
  // previous render") the moment the status query resolves.
  const returningRef = useRef(false);
  const readStoredPending = () => {
    try {
      const v = Number(localStorage.getItem(pendingKey) ?? "0");
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  };
  useEffect(() => {
    setPendingReturnSol(readStoredPending());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);
  const updatePendingReturn = (sol: number) => {
    const v = Math.max(0, Math.round(sol * 1e4) / 1e4);
    setPendingReturnSol(v);
    try {
      if (v > 0) localStorage.setItem(pendingKey, String(v));
      else localStorage.removeItem(pendingKey);
    } catch {
      /* storage unavailable — state still shows it this session */
    }
  };

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

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/vault/loop/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/agent/balance", "loop-dialog"] });
  };

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
        // Exact SOL shortfall from the server -> open the deposit popup instead
        // of a dead-end error toast. After the deposit confirms, retry this op.
        const gs = data?.gasShortfall;
        if (gs && typeof gs.requiredLamports === "number") {
          setShortfall({
            requiredSol: gs.requiredLamports / 1e9,
            heldSol: (typeof gs.heldLamports === "number" ? gs.heldLamports : 0) / 1e9,
            reason:
              key === "open"
                ? "to fund your loop deposit, one-time account rent and network fees"
                : "to cover this loop operation's network fees",
            kind: key === "open" ? "open" : "fees",
            retry: () => void doOp(key, path, body, okMsg),
          });
          return;
        }
        throw new Error(data?.error || "Operation failed");
      }
      toast({ title: okMsg, description: data.signature ? `Tx: ${String(data.signature).slice(0, 16)}…` : undefined });
      setAmountSol("");
      // Close/unwind proceeds land as SOL in the internal gas wallet — send
      // EXACTLY the amount the server says the op credited straight back to
      // the user's wallet. Never a balance sweep: SOL the agent wallet holds
      // for other operations stays put. If this leg fails, nothing is lost:
      // the tracked amount shows in the recovery row.
      if (key.startsWith("close-") || key.startsWith("unwind-")) {
        void autoReturnProceeds(typeof data.solReturnedLamports === "string" ? data.solReturnedLamports : undefined);
      }
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

  // Send loop proceeds sitting in the internal gas wallet back to the user's
  // wallet. The tx is agent-signed server-side; the client just submits +
  // confirms it, then records the equity event (same flow as the wallet page).
  // Amounts are ALWAYS the exact tracked proceeds — never a balance sweep, so
  // SOL the agent wallet holds for other operations is never touched.
  const agentSol = balanceQuery.data?.solBalance ?? null;
  const round4 = (n: number) => Math.floor(n * 1e4) / 1e4;
  // The withdraw route keeps a 0.005 SOL reserve; leave a hair extra for fees.
  const maxSendable = (sol: number | null) => (sol !== null ? Math.max(0, round4(sol - 0.006)) : 0);
  const returnSpareSol = async (amount: number, opts: { auto?: boolean; pendingOnSuccess: number }) => {
    if (amount <= 0) return;
    if (returningRef.current) return;
    returningRef.current = true;
    setBusy("withdraw-sol");
    try {
      const res = await fetch("/api/agent/withdraw-sol", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ amount }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data?.error || "SOL return failed");
      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = data;
      const txBytes = Uint8Array.from(atob(serializedTx), (c) => c.charCodeAt(0));
      const signature = await connection.sendRawTransaction(txBytes);
      await confirmTransactionWithFallback(connection, { signature, blockhash, lastValidBlockHeight });
      await fetch("/api/agent/confirm-sol-withdraw", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ amount, txSignature: signature }),
      });
      toast({ title: `Returned ${amount.toFixed(4)} SOL to your wallet` });
      updatePendingReturn(opts.pendingOnSuccess);
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({
          toast,
          retryAuth,
          title: "SOL return failed",
          retry: () => void returnSpareSol(amount, opts),
        });
      } else if (opts.auto) {
        // The close itself succeeded — don't scare the user. The recovery
        // row shows the SOL with a Return to Wallet button.
        toast({
          title: "SOL is waiting to return",
          description: "Sending the proceeds to your wallet didn't go through — use Return to Wallet below.",
        });
      } else {
        toast({ title: "SOL return failed", description: e?.message || String(e), variant: "destructive" });
      }
    } finally {
      returningRef.current = false;
      setBusy(null);
      refresh();
    }
  };
  // Auto-return EXACTLY what the close/unwind reported it credited
  // (solReturnedLamports). No proceeds -> nothing moves; the agent wallet's
  // own gas float is invisible to this path by construction.
  const autoReturnProceeds = async (proceedsLamports?: string) => {
    let proceeds = 0;
    try {
      proceeds = Number(BigInt(proceedsLamports ?? "0")) / 1e9;
    } catch {
      proceeds = 0;
    }
    const tracked = round4(proceeds);
    if (tracked <= 0) return;
    // ACCUMULATE onto any prior stranded proceeds (read from storage, not the
    // possibly-stale state closure) — overwriting would invisibly strand the
    // earlier failed return. Track BEFORE sending so a failed send still shows.
    const newPending = Math.round((readStoredPending() + tracked) * 1e4) / 1e4;
    updatePendingReturn(newPending);
    const fresh = await balanceQuery.refetch();
    const amount = Math.min(newPending, maxSendable(fresh.data?.solBalance ?? null));
    if (amount <= 0) return; // stays tracked; the recovery row offers it
    await returnSpareSol(amount, { auto: true, pendingOnSuccess: newPending - amount });
  };
  // Manual recovery send: capped by what the withdraw route will allow now.
  const manualReturnSol = Math.min(pendingReturnSol, maxSendable(agentSol));

  const runConfirmed = (key: string, fn: () => void) => {
    if (confirmAction !== key) {
      setConfirmAction(key);
      setTimeout(() => setConfirmAction((c) => (c === key ? null : c)), 5000);
      return;
    }
    setConfirmAction(null);
    fn();
  };
  const runMoneyOp = (key: string, path: string, body: Record<string, unknown>, okMsg: string) =>
    runConfirmed(key, () => void doOp(key, path, body, okMsg));

  // OPEN is deposit-first: preflight the exact bar (principal + rent + fees),
  // collect the FULL bar from the USER's wallet (heldSol=0 — SOL already in
  // the agent wallet is gas plumbing and is never counted toward the deposit),
  // then run the real open. Pre-existing agent gas survives untouched.
  const startOpen = async () => {
    setBusy("open");
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/loop/open", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ principalLamports, preflight: true, sessionId }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok || !data?.success || typeof data?.preflight?.requiredLamports !== "number") {
        throw new Error(data?.error || "Could not prepare the loop deposit");
      }
      setShortfall({
        requiredSol: data.preflight.requiredLamports / 1e9,
        heldSol: 0,
        reason: "to fund your loop deposit, one-time account rent and network fees",
        kind: "open",
        retry: () => void doOp("open", "/api/vault/loop/open", { principalLamports }, "Loop opened"),
      });
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({
          toast,
          retryAuth,
          title: "Loop open failed",
          retry: () => void startOpen(),
        });
      } else {
        toast({ title: "Loop open failed", description: e?.message || String(e), variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
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
                <span className="tabular-nums">Auto-leverage staking loop</span>
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-cyan-500/15 text-cyan-600 dark:text-cyan-400"
                  data-testid="chip-risk-loop"
                >
                  Loop
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
            <p className="text-lg font-bold tabular-nums" data-testid="stat-loop-target-leverage">
              {typeof statusQuery.data?.recommended?.targetLeverage === "number"
                ? `${statusQuery.data.recommended.targetLeverage.toFixed(1)}x`
                : "Auto"}
            </p>
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
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">
                Loop
              </span>
            </DialogTitle>
            <DialogDescription>
              Deposit SOL from your wallet — the platform puts it into the best staked SOL token and loops it
              for boosted staking yield. Leverage is set automatically from the vault's live limits with a
              safety buffer, and only while the yield beats the borrow cost. Leveraged: it can be liquidated
              if rates move sharply against it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Deposit (SOL)</p>
                <Input
                  inputMode="decimal"
                  placeholder="0.5"
                  value={amountSol}
                  onChange={(e) => {
                    setAmountSol(e.target.value);
                    setConfirmAction(null);
                  }}
                  data-testid="input-loop-principal"
                />
              </div>
              <Button
                className="w-full"
                disabled={openDisabled}
                onClick={() => runConfirmed("open", () => void startOpen())}
                data-testid="button-loop-open"
              >
                {busy === "open" ? <Loader2 className="h-4 w-4 animate-spin" /> : label("open", "Deposit & Open Loop")}
              </Button>
              <p className="text-[11px] text-muted-foreground" data-testid="text-loop-auto-pick">
                Comes straight from your connected wallet. The platform picks the best staked SOL token
                automatically{statusQuery.data.recommended ? (
                  <> — currently <span className="font-medium text-foreground">{statusQuery.data.recommended.symbol}</span></>
                ) : null}.
              </p>
            </div>

            {/* --- Recovery row: only appears when TRACKED loop proceeds are
                stranded in the gas wallet (an auto-return after close/unwind
                failed). Never balance-derived — the agent wallet's own gas
                float must never look like a user balance. --- */}
            {pendingReturnSol > 0 && (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground flex-1" data-testid="text-loop-spare-sol">
                  <span className="font-medium text-foreground tabular-nums">{pendingReturnSol.toFixed(4)} SOL</span> from loop
                  operations is ready to go back to your wallet.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={!!busy || manualReturnSol <= 0}
                  onClick={() =>
                    void returnSpareSol(manualReturnSol, {
                      pendingOnSuccess: pendingReturnSol - manualReturnSol,
                    })
                  }
                  data-testid="button-loop-withdraw-sol"
                >
                  {busy === "withdraw-sol" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <ArrowUpFromLine className="h-3.5 w-3.5 mr-1" />
                      Return to Wallet
                    </>
                  )}
                </Button>
              </div>
            )}

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

      {/* Exact-amount SOL deposit popup: user wallet -> agent wallet, then the
          op auto-retries. For OPEN this is the primary deposit step. */}
      <SolGasShortfallDialog
        open={!!shortfall}
        onOpenChange={(o) => {
          if (!o) setShortfall(null);
        }}
        heldSol={shortfall?.heldSol}
        requiredSol={shortfall?.requiredSol ?? 0}
        reason={shortfall?.reason}
        variant={shortfall?.kind === "open" ? "deposit" : "gas"}
        title={shortfall?.kind === "open" ? "Deposit SOL to open your loop" : undefined}
        description={
          shortfall?.kind === "open"
            ? "This comes straight from your connected wallet. It covers your deposit plus one-time account rent and network fees — after you approve it, the loop opens automatically."
            : undefined
        }
        onDeposited={async () => {
          const retry = shortfall?.retry;
          setShortfall(null);
          refresh();
          await retry?.();
        }}
      />
    </>
  );
}
