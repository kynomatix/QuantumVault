import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Loader2 } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { isSessionError, showReconnectToast } from "@/lib/reconnect-toast";
import { walletAuthHeaders } from "@/lib/queryClient";
import { safeResponseJson } from "@/lib/safe-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Fixed Yield vault card (Exponent PT markets). Renders in the "Asset Vaults"
// grid next to the SOL Loop card. Open to all wallets (no owner gate — the
// owner explicitly waived it for the dev environment).
//
// The platform auto-picks the best fixed-rate market server-side; the user
// never picks a market (platform philosophy: defaults over choices). The
// deposit is a resumable server op: we persist the request id locally until
// the server confirms success, so an interrupted deposit resumes instead of
// double-spending.

interface FixedYieldBestMarket {
  marketAddress: string;
  vaultAddress: string;
  ptMint: string;
  underlyingMint: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  impliedApy: number;
  maturityTs: number;
  daysToMaturity: number;
  ptPriceInAsset: number | null;
  liquidityNormalized: number;
  platformName: string | null;
}

interface FixedYieldPosition {
  id: string;
  venue: string;
  marketAddress: string;
  ptMint: string;
  underlyingSymbol: string;
  ptAmountUi: number;
  costBasisUsdc: number;
  impliedApyAtEntry: number | null;
  maturityTs: number;
  daysToMaturity: number;
  matured: boolean;
  projectedValueUsdc: number | null;
  status: string;
  createdAt: string;
}

interface FixedYieldStatus {
  rateAvailable: boolean;
  bestMarket: FixedYieldBestMarket | null;
  marketCount: number;
  positions: FixedYieldPosition[];
}

interface PendingDeposit {
  id: string;
  amount: number;
}

const fmtMaturity = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const usd = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined
    ? "n/a"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

async function getSessionId(): Promise<string> {
  const res = await fetch("/api/auth/session", { credentials: "include" });
  if (!res.ok) throw new Error("Could not verify your session. Please reconnect your wallet.");
  const data = await safeResponseJson(res);
  if (!data.hasSession || !data.sessionId) {
    throw new Error("No active session. Please reconnect your wallet.");
  }
  return data.sessionId as string;
}

const pendingKey = (wallet: string) => `qv-fy-deposit-${wallet}`;

function readPending(wallet: string | null): PendingDeposit | null {
  if (!wallet) return null;
  try {
    const raw = localStorage.getItem(pendingKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.id === "string" && typeof parsed?.amount === "number" && parsed.amount > 0) {
      return parsed as PendingDeposit;
    }
  } catch {
    // fall through
  }
  return null;
}

// Exit resume breadcrumb — one per position (a wallet can hold several).
const exitKey = (wallet: string, positionId: string) => `qv-fy-exit-${wallet}-${positionId}`;

function readPendingExits(wallet: string | null, positionIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!wallet) return out;
  for (const pid of positionIds) {
    try {
      const raw = localStorage.getItem(exitKey(wallet, pid));
      if (raw && typeof raw === "string" && raw.length <= 128) out[pid] = raw;
    } catch {
      // ignore
    }
  }
  return out;
}

export default function FixedYieldVault({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [pending, setPending] = useState<PendingDeposit | null>(null);
  const [confirmExitId, setConfirmExitId] = useState<string | null>(null);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [pendingExits, setPendingExits] = useState<Record<string, string>>({});
  const { publicKeyString, retryAuth } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Re-read the resume breadcrumb whenever the dialog opens or wallet changes.
  useEffect(() => {
    setPending(readPending(publicKeyString ?? null));
  }, [open, publicKeyString]);

  const statusQuery = useQuery<FixedYieldStatus | null>({
    queryKey: ["/api/vault/fixed-yield/status"],
    enabled: active,
    refetchInterval: active ? 60000 : false,
    queryFn: async () => {
      const res = await fetch("/api/vault/fixed-yield/status", {
        credentials: "include",
        headers: walletAuthHeaders(),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error("Fixed Yield status failed");
      return await safeResponseJson(res);
    },
  });

  // Spare USDC in the internal wallet — same source the Earn cards use.
  const assetsQuery = useQuery<{ spareUsdc: number }>({
    queryKey: ["fy-vault-assets", publicKeyString],
    enabled: open && !!publicKeyString,
    queryFn: async () => {
      const res = await fetch("/api/vault/assets", { credentials: "include", headers: walletAuthHeaders() });
      const data = await safeResponseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to load balance");
      return data;
    },
  });

  const status = statusQuery.data;
  const best = status?.bestMarket ?? null;
  const rateKnown = !!status?.rateAvailable && !!best;
  const apyPct = best ? (best.impliedApy * 100).toFixed(2) : null;
  const positions = (status?.positions ?? []).filter((p) => p.status === "active");
  const totalLocked = positions.reduce((s, p) => s + p.costBasisUsdc, 0);
  const spareUsdc = assetsQuery.data?.spareUsdc ?? 0;

  // Re-read per-position exit breadcrumbs whenever the dialog opens, the
  // wallet changes, or the position list changes.
  const positionIdsKey = positions.map((p) => p.id).join(",");
  useEffect(() => {
    setPendingExits(readPendingExits(publicKeyString ?? null, positionIdsKey ? positionIdsKey.split(",") : []));
  }, [open, publicKeyString, positionIdsKey]);

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/vault/fixed-yield/status"] });
    queryClient.invalidateQueries({ queryKey: ["fy-vault-assets", publicKeyString] });
    queryClient.invalidateQueries({ queryKey: ["vault-assets", publicKeyString, null] });
  };

  const clearPending = () => {
    if (publicKeyString) localStorage.removeItem(pendingKey(publicKeyString));
    setPending(null);
  };

  const handleDeposit = async (resume?: PendingDeposit) => {
    if (!publicKeyString) return;
    const amount = resume ? resume.amount : parseFloat(amountInput);
    if (!Number.isFinite(amount) || amount < 1) {
      toast({ title: "Amount too small", description: "The minimum deposit is 1 USDC.", variant: "destructive" });
      return;
    }
    // One request id per logical deposit, persisted until the server confirms.
    // A retry with the SAME id resumes the server-side operation safely.
    const req: PendingDeposit = resume ?? { id: crypto.randomUUID(), amount };
    localStorage.setItem(pendingKey(publicKeyString), JSON.stringify(req));
    setPending(req);
    setDepositing(true);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/fixed-yield/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ amountUsdc: req.amount, sessionId, clientRequestId: req.id }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok || !data.success) {
        if (data?.resumable) {
          // Keep the breadcrumb — the same id resumes where it stopped.
          throw new Error(`${data.error || "Deposit did not complete."}`);
        }
        clearPending();
        throw new Error(data?.error || "Deposit failed.");
      }
      clearPending();
      setAmountInput("");
      toast({
        title: "Rate Locked",
        description: `Locked ${usd(data.usdcSpent)} at ${((data.impliedApy ?? 0) * 100).toFixed(2)}% until ${fmtMaturity(data.maturityTs)}.`,
      });
      refetchAll();
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Deposit failed", retry: () => handleDeposit(req) });
      } else {
        toast({ title: "Deposit failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setDepositing(false);
    }
  };

  const handleExit = async (p: FixedYieldPosition, resumeId?: string) => {
    if (!publicKeyString) return;
    // One request id per logical exit, persisted until the server confirms.
    // A retry with the SAME id resumes the server-side operation safely.
    const reqId = resumeId ?? crypto.randomUUID();
    localStorage.setItem(exitKey(publicKeyString, p.id), reqId);
    setPendingExits((prev) => ({ ...prev, [p.id]: reqId }));
    setConfirmExitId(null);
    setExitingId(p.id);
    try {
      const sessionId = await getSessionId();
      const res = await fetch("/api/vault/fixed-yield/exit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ positionId: p.id, sessionId, clientRequestId: reqId }),
        credentials: "include",
      });
      const data = await safeResponseJson(res);
      if (!res.ok || !data.success) {
        if (data?.resumable) {
          // Keep the breadcrumb — the same id resumes where it stopped.
          throw new Error(`${data.error || "Exit did not complete."}`);
        }
        clearPendingExit(p.id);
        throw new Error(data?.error || "Exit failed.");
      }
      clearPendingExit(p.id);
      const received = typeof data.usdcReceived === "number" ? data.usdcReceived : null;
      toast({
        title: "Position Exited",
        description: received !== null
          ? `Sold at the market rate for ${usd(received)}. The USDC is back in your spare balance.`
          : "Sold at the market rate. The USDC is back in your spare balance.",
      });
      refetchAll();
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({ toast, retryAuth, title: "Exit failed", retry: () => handleExit(p, reqId) });
      } else {
        toast({ title: "Exit failed", description: e.message || "Something went wrong.", variant: "destructive" });
      }
    } finally {
      setExitingId(null);
    }
  };

  const clearPendingExit = (positionId: string) => {
    if (publicKeyString) localStorage.removeItem(exitKey(publicKeyString, positionId));
    setPendingExits((prev) => {
      const next = { ...prev };
      delete next[positionId];
      return next;
    });
  };

  return (
    <>
      {/* --- Card (matches the other vault destination cards) --- */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Fixed Yield vault"
        className="gradient-border p-5 noise hover:scale-[1.01] transition-transform cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        data-testid="card-asset-fixed-yield"
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
            <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 bg-gradient-to-br from-emerald-500/30 to-teal-500/30">
              <Lock className="w-6 h-6 text-emerald-500" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base truncate">Fixed Yield</h3>
              <p className="text-xs text-muted-foreground truncate">
                Lock in today's rate until a set date
              </p>
            </div>
          </div>
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            Fixed Rate
          </span>
        </div>

        {rateKnown ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400" data-testid="text-fy-apy">
                {apyPct}%
              </p>
              <p className="text-xs text-muted-foreground">Fixed APY</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums" data-testid="text-fy-maturity">
                {fmtMaturity(best!.maturityTs)}
              </p>
              <p className="text-xs text-muted-foreground">
                Unlocks ({best!.daysToMaturity}d)
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-fy-unavailable">
            {statusQuery.isLoading ? "Loading rate…" : "Rate unavailable right now."}
          </p>
        )}
        {positions.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="text-fy-locked-summary">
            <span className="font-medium text-foreground tabular-nums">{usd(totalLocked)}</span> locked in
          </p>
        )}
      </div>

      {/* --- Detail dialog --- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-fixed-yield">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-emerald-500" /> Fixed Yield
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                Fixed Rate
              </span>
            </DialogTitle>
            <DialogDescription>
              Deposit USDC and lock in today's rate until the unlock date. The
              platform automatically picks the best fixed-rate market. Your
              deposit grows to a known amount at the unlock date — no rate
              changes along the way. You can exit early at the market rate if
              you need the funds back sooner.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {rateKnown ? (
              <div className="rounded-lg border border-border/60 p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Fixed APY</span>
                  <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {apyPct}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Unlock Date</span>
                  <span className="font-medium tabular-nums">
                    {fmtMaturity(best!.maturityTs)} ({best!.daysToMaturity} days)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Via</span>
                  <span className="font-medium">
                    Exponent · {best!.underlyingSymbol}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                The rate feed is unavailable right now. Deposits are paused
                until it comes back — existing positions are not affected.
              </p>
            )}

            {/* Resume banner: an earlier deposit didn't finish. Same request id
                resumes it server-side — never a second spend. */}
            {pending && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2" data-testid="banner-fy-resume">
                <p className="text-sm">
                  A deposit of <span className="font-medium tabular-nums">{usd(pending.amount)}</span> didn't
                  finish. Resume it to pick up where it stopped — your funds are safe.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={depositing}
                    onClick={() => handleDeposit(pending)}
                    data-testid="button-fy-resume"
                  >
                    {depositing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Resume Deposit"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={depositing}
                    onClick={clearPending}
                    data-testid="button-fy-dismiss-resume"
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {/* Deposit input */}
            {!pending && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="fy-amount">Amount (USDC)</Label>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setAmountInput(spareUsdc > 0 ? String(Math.floor(spareUsdc * 100) / 100) : "")}
                    data-testid="button-fy-max"
                  >
                    Spare: {assetsQuery.isLoading ? "…" : usd(spareUsdc)} · Max
                  </button>
                </div>
                <Input
                  id="fy-amount"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step="0.01"
                  placeholder="Minimum 1 USDC"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  data-testid="input-fy-amount"
                />
                <Button
                  className="w-full"
                  disabled={!rateKnown || depositing || !(parseFloat(amountInput) >= 1)}
                  onClick={() => handleDeposit()}
                  data-testid="button-fy-deposit"
                >
                  {depositing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Locking Rate…
                    </>
                  ) : rateKnown ? (
                    `Lock ${apyPct}% Fixed`
                  ) : (
                    "Deposits Paused"
                  )}
                </Button>
              </div>
            )}

            {/* Active positions */}
            {positions.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your Positions</p>
                {positions.map((p) => {
                  const pendingExitId = pendingExits[p.id];
                  const isExiting = exitingId === p.id;
                  const isConfirming = confirmExitId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="rounded-lg border border-border/60 p-3 text-sm space-y-2"
                      data-testid={`row-fy-position-${p.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">PT-{p.underlyingSymbol}</span>
                        <span className="tabular-nums font-medium">{usd(p.costBasisUsdc)} locked</span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {p.matured
                            ? "Matured — full fixed rate earned"
                            : `Unlocks ${fmtMaturity(p.maturityTs)} (${Math.ceil(p.daysToMaturity)}d)`}
                        </span>
                        {p.projectedValueUsdc !== null && (
                          <span className="tabular-nums">→ {usd(p.projectedValueUsdc)} est.</span>
                        )}
                      </div>

                      {pendingExitId ? (
                        /* Resume: an earlier exit didn't finish. Same request id
                           resumes it server-side — never a second sale. This
                           banner deliberately WINS over the matured message:
                           the server resumes an in-flight exit even after
                           maturity (the matured gate only applies to NEW
                           exits), and hiding it would strand funds mid-swap. */
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-2" data-testid={`banner-fy-exit-resume-${p.id}`}>
                          <p className="text-xs">
                            An exit didn't finish. Resume it to pick up where it
                            stopped — your funds are safe.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={isExiting}
                              onClick={() => handleExit(p, pendingExitId)}
                              data-testid={`button-fy-exit-resume-${p.id}`}
                            >
                              {isExiting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Resume Exit"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isExiting}
                              onClick={() => clearPendingExit(p.id)}
                              data-testid={`button-fy-exit-dismiss-${p.id}`}
                            >
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      ) : p.matured ? (
                        <p className="text-xs text-muted-foreground" data-testid={`text-fy-matured-${p.id}`}>
                          Redemption back to USDC is being finalized on the platform — your
                          funds remain yours on-chain in the meantime.
                        </p>
                      ) : isConfirming ? (
                        <div className="rounded-md border border-border/60 bg-muted/40 p-2 space-y-2" data-testid={`confirm-fy-exit-${p.id}`}>
                          <p className="text-xs">
                            Exit early at today's market rate? You give up the
                            locked rate for the remaining {Math.ceil(p.daysToMaturity)} days —
                            you may get slightly less than waiting until the unlock date.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isExiting}
                              onClick={() => handleExit(p)}
                              data-testid={`button-fy-exit-confirm-${p.id}`}
                            >
                              {isExiting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Exit Now"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isExiting}
                              onClick={() => setConfirmExitId(null)}
                              data-testid={`button-fy-exit-cancel-${p.id}`}
                            >
                              Keep Position
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          disabled={exitingId !== null}
                          onClick={() => setConfirmExitId(p.id)}
                          data-testid={`button-fy-exit-${p.id}`}
                        >
                          Exit Early
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
