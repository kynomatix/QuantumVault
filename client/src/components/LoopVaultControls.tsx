import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Transaction, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Loader2, AlertTriangle, RefreshCw, Repeat, ArrowUpFromLine, Table2 } from "lucide-react";
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
  { id: 5, symbol: "JitoSOL" },
  { id: 42, symbol: "INF" },
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
  solView: LoopSolView | null;
}

// Server-computed per-position card stats (display only, fail-closed nulls).
interface LoopSolView {
  leverage: number | null;
  balanceSol: number | null;
  balanceLive: boolean;
  pnlSol: number | null;
  pnlPct: number | null;
  principalSol: number | null;
  returnedSol: number;
}

const fmtSolNum = (n: number | null | undefined, dp = 4): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(dp) : "—";

const fmtLeverage = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(2)}x` : "—";

const fmtPnlSol = (n: number | null | undefined, dp = 4): string =>
  typeof n === "number" && Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(dp)}` : "—";

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

// One LST the loop accepts as a DEPOSIT (server-provided; never hardcoded).
interface LoopDepositAsset {
  vaultId: number;
  symbol: string;
  mint: string;
  decimals: number;
}

// One row of the live LST rate table (display only — the server picks).
interface LoopRateRow {
  vaultId: number;
  symbol: string;
  allowlisted: boolean;
  stakingApy: number | null;
  borrowApr: number | null;
  targetLeverage: number | null;
  /** True when leverage/net-yield is the if-enabled estimate for a watch-only token. */
  hypothetical?: boolean;
  noTargetReason: string | null;
  netCarryAtTarget: number | null;
  asOf: string | null;
}

/** Cross-venue SOL borrow watch row — display only, from DeFiLlama. */
interface VenueWatchRow {
  venue: string;
  borrowApy: number | null;
  supplyUsd: number | null;
  utilization: number | null;
  maxLtv: number | null;
  asOf: string;
}

const fmtUsdM = (v: number | null): string =>
  typeof v === "number" && Number.isFinite(v) ? `$${(v / 1e6).toFixed(0)}M` : "—";

/** One-line verdict vs our current (Jupiter) SOL borrow cost. */
const venueVerdict = (row: VenueWatchRow, ourBorrow: number | null): { text: string; tone: "good" | "warn" | "bad" | "muted" } => {
  if (row.borrowApy === null) return { text: "No data", tone: "muted" };
  if (row.utilization !== null && row.utilization >= 0.9)
    return { text: "Pool nearly full — exits risky", tone: "bad" };
  if (ourBorrow === null) return { text: "", tone: "muted" };
  if (row.borrowApy < ourBorrow - 0.002) return { text: "Cheaper than our venue", tone: "good" };
  if (row.borrowApy <= ourBorrow + 0.002) return { text: "On par with our venue", tone: "muted" };
  return { text: "More expensive than our venue", tone: "warn" };
};

const fmtPct = (f: number | null | undefined): string =>
  typeof f === "number" && Number.isFinite(f) ? `${(f * 100).toFixed(2)}%` : "—";

const fmtAgo = (iso: string | null): string | null => {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

export default function LoopVaultControls({ active, gridClass }: { active: boolean; gridClass?: string }) {
  const { toast } = useToast();
  const { retryAuth, publicKeyString } = useWallet();
  const { connection } = useConnection();
  const solanaWallet = useSolanaWallet();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amountSol, setAmountSol] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  // Which asset the deposit input is denominated in: "SOL" or an LST mint.
  const [depositMint, setDepositMint] = useState<string>("SOL");
  // Retry handle for an LST deposit whose transfer already landed in the
  // internal wallet: the SAME clientRequestId resumes the server op (the
  // conversion never runs twice). Persisted per-wallet in localStorage so a
  // reload can't strand the funds; cleared ONLY on confirmed success.
  const [lstPending, setLstPendingState] = useState<{ id: string; mint: string; amountRaw: string; symbol: string } | null>(null);
  // Set when a loop op needs SOL from the user's wallet: exact server numbers
  // + a retry closure. For OPEN this IS the primary deposit step (principal +
  // rent + fees, deposit-framed); for close/unwind it's a small gas top-up.
  const [shortfall, setShortfall] = useState<{ requiredSol: number; heldSol: number; reason: string; kind: "open" | "fees"; retry: () => void } | null>(null);
  const [ratesOpen, setRatesOpen] = useState(false);

  // Live LST rate table — display only, fetched when the rates dialog opens.
  const ratesQuery = useQuery<{ rates: LoopRateRow[]; recommendedVaultId: number | null; venues?: VenueWatchRow[] } | null>({
    queryKey: ["/api/vault/loop/rates"],
    enabled: active && ratesOpen,
    refetchInterval: ratesOpen ? 60000 : false,
    queryFn: async () => {
      const res = await fetch("/api/vault/loop/rates", {
        credentials: "include",
        headers: walletAuthHeaders(),
      });
      if (res.status === 403 || res.status === 401) return null;
      if (!res.ok) throw new Error("Loop rates failed");
      return await safeResponseJson(res);
    },
  });

  const statusQuery = useQuery<{
    positions: LoopRow[];
    recommended?: {
      vaultId: number;
      symbol: string;
      targetLeverage: number | null;
      netCarryAtTarget: number | null;
      netCarry2x: number | null;
    } | null;
    depositAssets?: LoopDepositAsset[];
    /** Lifetime P/L across ALL historical positions (server-computed, fail-closed nulls). */
    lifetime?: {
      pnlSol: number | null;
      principalSol: number | null;
      returnedSol: number;
      equitySol: number | null;
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

  // Connected-wallet balances for the deposit input: SOL plus each deposit
  // LST the server lists. Read-only display + input caps; polled only while
  // the dialog is open.
  const depositAssetsList = statusQuery.data?.depositAssets ?? [];
  const depositMintsKey = depositAssetsList.map((a) => a.mint).join(",");
  const walletBalQuery = useQuery<{ sol: number; tokens: Record<string, { raw: string; ui: number }> } | null>({
    queryKey: ["loop-wallet-balances", publicKeyString, depositMintsKey],
    enabled: active && open && !!publicKeyString,
    refetchInterval: open ? 30000 : false,
    queryFn: async () => {
      if (!publicKeyString) return null;
      const owner = new PublicKey(publicKeyString);
      const lamports = await connection.getBalance(owner);
      const tokens: Record<string, { raw: string; ui: number }> = {};
      for (const a of depositAssetsList) {
        try {
          const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(a.mint) });
          let raw = 0n;
          for (const acc of resp.value) {
            raw += BigInt(acc.account.data.parsed?.info?.tokenAmount?.amount ?? "0");
          }
          tokens[a.mint] = { raw: raw.toString(), ui: Number(rawToDecimalString(raw.toString(), a.decimals)) };
        } catch {
          /* unreadable token: just don't offer it this round */
        }
      }
      return { sol: lamports / 1e9, tokens };
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

  // LST retry handle persistence (wallet-scoped, survives reloads). Once the
  // user's LST transfer lands in the internal wallet, this handle is the ONLY
  // client-side link to the resumable server op — losing it would strand the
  // funds until a manual recovery. So it is stored immediately and cleared
  // only on confirmed success.
  const lstPendingKey = `qv-loop-lst-pending:${publicKeyString ?? "unknown"}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lstPendingKey);
      const v = raw ? JSON.parse(raw) : null;
      if (
        v &&
        typeof v.id === "string" &&
        typeof v.mint === "string" &&
        typeof v.amountRaw === "string" &&
        typeof v.symbol === "string"
      ) {
        setLstPendingState(v);
        setDepositMint(v.mint);
      } else {
        setLstPendingState(null);
      }
    } catch {
      setLstPendingState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lstPendingKey]);
  const updateLstPending = (v: { id: string; mint: string; amountRaw: string; symbol: string } | null) => {
    setLstPendingState(v);
    if (v) setDepositMint(v.mint);
    try {
      if (v) localStorage.setItem(lstPendingKey, JSON.stringify(v));
      else localStorage.removeItem(lstPendingKey);
    } catch {
      /* storage unavailable — state still covers this session */
    }
  };

  // Hide entirely unless the server confirms this wallet may see the loop.
  if (!statusQuery.data) return null;
  const rows = statusQuery.data.positions ?? [];
  const activeRows = rows.filter((r) => r.status === "open" || r.status === "pending");
  const isActive = activeRows.length > 0;
  // Card stats: actual leverage of the live position (fallback: the auto
  // target), total balance in SOL (fail-closed — one unreadable row -> "—"),
  // and lifetime P/L across all historical positions (server-computed).
  const cardLeverage: number | null = isActive ? activeRows[0]?.solView?.leverage ?? null : null;
  const cardBalanceSol: number | null = isActive
    ? activeRows.reduce<number | null>((acc, r) => {
        if (acc === null) return null;
        const b = r.solView?.balanceSol;
        return typeof b === "number" && Number.isFinite(b) ? acc + b : null;
      }, 0)
    : null;
  const lifetimePnlSol = statusQuery.data.lifetime?.pnlSol ?? null;

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
          description: "Sending the proceeds to your wallet didn't go through. Use Return to Wallet below.",
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

  // --- LST deposit path: user-signed transfer of the LST into the internal
  // wallet, then a server op that converts it to SOL and opens the loop into
  // the best vault. Everything after the transfer is retryable with the SAME
  // clientRequestId, so the conversion can never run twice.
  const selectedAsset = depositAssetsList.find((a) => a.mint === depositMint) ?? null;
  const walletSol = walletBalQuery.data?.sol ?? null;
  const heldFor = (mint: string) => walletBalQuery.data?.tokens[mint] ?? null;
  // Max leaves 0.04 SOL behind for rent + network fees on the deposit tx.
  const maxDepositSol = walletSol !== null ? Math.max(0, Math.floor((walletSol - 0.04) * 1e4) / 1e4) : null;

  const runLstServerOpen = async (asset: LoopDepositAsset, amountRaw: string, requestId: string) => {
    const sessionId = await getSessionId();
    const res = await fetch("/api/vault/loop/deposit-lst-open", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
      body: JSON.stringify({ mint: asset.mint, amountRaw, clientRequestId: requestId, sessionId }),
    });
    const data = await safeResponseJson(res);
    if (!res.ok || !data?.success) {
      if (data?.terminal) {
        // The server says this request id can NEVER succeed (op row failed
        // terminally). Drop the handle so the UI unlocks; a fresh deposit
        // sweeps any tokens still sitting in the internal wallet.
        updateLstPending(null);
        throw new Error(data?.error || "That deposit attempt failed. Start a new deposit.");
      }
      // Otherwise the transfer already landed, so the retry handle is kept:
      // retrying with the SAME id is always safe (the server op is idempotent
      // on clientRequestId) and dropping it would strand funds.
      updateLstPending({ id: requestId, mint: asset.mint, amountRaw, symbol: asset.symbol });
      throw new Error(
        data?.error || `The deposit didn't finish. Your ${asset.symbol} is safe. Tap Retry to continue.`,
      );
    }
    updateLstPending(null);
    setAmountSol("");
    setDepositMint("SOL");
    toast({
      title: "Loop opened",
      description: `Converted your ${asset.symbol} to SOL and opened the loop.`,
    });
  };

  const startLstOpen = async () => {
    const asset = selectedAsset;
    if (!asset) return;
    setBusy("open");
    try {
      // Resume path: the transfer already landed. Re-run only the server op.
      if (lstPending && lstPending.mint === asset.mint) {
        await runLstServerOpen(asset, lstPending.amountRaw, lstPending.id);
        return;
      }
      // Never start a NEW deposit while another one is unfinished: that
      // would overwrite the retry handle and strand the earlier transfer.
      if (lstPending) {
        throw new Error(`Finish your pending ${lstPending.symbol} deposit first.`);
      }
      const amountRaw = toRawBaseUnits(amountSol, asset.decimals);
      if (!amountRaw || BigInt(amountRaw) <= 0n) throw new Error("Enter a valid amount");
      const held = heldFor(asset.mint);
      if (held && BigInt(amountRaw) > BigInt(held.raw)) {
        throw new Error(`You only hold ${held.ui} ${asset.symbol}.`);
      }
      if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
        throw new Error("Wallet not connected");
      }

      // Step 1: user-signed transfer of the LST into the internal wallet.
      const depRes = await fetch("/api/agent/deposit-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...walletAuthHeaders() },
        body: JSON.stringify({ mint: asset.mint, amountRaw }),
      });
      const depData = await safeResponseJson(depRes);
      if (!depRes.ok) throw new Error(depData?.error || "Could not build the deposit transaction");
      const { transaction: serializedTx, blockhash, lastValidBlockHeight } = depData;
      const transaction = Transaction.from(Buffer.from(serializedTx, "base64"));
      const signedTx = await solanaWallet.signTransaction(transaction);

      // Pin the retry handle (state + localStorage) BEFORE broadcast: a
      // reload or crash during the confirm wait can no longer lose track of
      // an in-flight transfer. If the tx never actually lands, the retry is
      // still safe: the server op reads a zero balance, fails the op
      // terminally, and the terminal response clears this handle.
      const requestId = crypto.randomUUID();
      updateLstPending({ id: requestId, mint: asset.mint, amountRaw, symbol: asset.symbol });

      const depositSig = await connection.sendRawTransaction(signedTx.serialize());
      await confirmTransactionWithFallback(connection, { signature: depositSig, blockhash, lastValidBlockHeight });

      // Step 2: server converts the LST to SOL and opens the loop.
      await runLstServerOpen(asset, amountRaw, requestId);
    } catch (e: any) {
      if (isSessionError(e)) {
        showReconnectToast({
          toast,
          retryAuth,
          title: "Loop deposit failed",
          retry: () => void startLstOpen(),
        });
      } else {
        toast({ title: "Loop deposit failed", description: e?.message || String(e), variant: "destructive" });
      }
    } finally {
      setBusy(null);
      refresh();
      void walletBalQuery.refetch();
    }
  };

  const principalLamports = toRawBaseUnits(amountSol, 9);
  const lstResumeReady = !!(lstPending && depositMint === lstPending.mint);
  const depositRaw =
    depositMint === "SOL" ? principalLamports : toRawBaseUnits(amountSol, selectedAsset?.decimals ?? 9);
  const openDisabled =
    !!busy || (!lstResumeReady && (!depositRaw || BigInt(depositRaw) <= 0n));
  const label = (key: string, normal: string) => (confirmAction === key ? "Confirm?" : normal);

  return (
    <>
      {/* --- Owner-only "Asset Vaults" section. This component owns the
          section heading + grid so non-owners (who get null above) never see
          an orphaned heading. --- */}
      <div data-testid="section-asset-vaults">
      <h3 className="text-sm font-semibold text-muted-foreground mb-3">Asset Vaults</h3>
      <div className={gridClass ?? ""}>
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
            <p className="text-lg font-bold tabular-nums" data-testid="stat-loop-leverage">
              {isActive
                ? fmtLeverage(cardLeverage)
                : typeof statusQuery.data?.recommended?.targetLeverage === "number"
                  ? `${statusQuery.data.recommended.targetLeverage.toFixed(1)}x`
                  : "Auto"}
            </p>
            <p className="text-xs text-muted-foreground">Leverage</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p className="text-lg font-bold tabular-nums" data-testid="stat-loop-balance">
              {isActive ? fmtSolNum(cardBalanceSol, 3) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Balance (SOL)</p>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <p
              className={`text-lg font-bold tabular-nums ${
                lifetimePnlSol === null ? "" : lifetimePnlSol >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
              data-testid="stat-loop-pnl"
            >
              {fmtPnlSol(lifetimePnlSol, 3)}
            </p>
            <p className="text-xs text-muted-foreground">P/L (SOL)</p>
          </div>
        </div>

        {activeRows.some((r) => r.live?.liquidatable) && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-red-500">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> A position is liquidatable.
          </p>
        )}
      </div>
      </div>
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
              Deposit SOL or a staked SOL token from your wallet. The platform puts it into the best staked
              SOL token and loops it for boosted staking yield. Leverage is set automatically from the
              vault's live limits with a safety buffer, and only while the yield beats the borrow cost.
              Leveraged: it can be liquidated if rates move sharply against it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-muted-foreground">
                    Deposit ({selectedAsset ? selectedAsset.symbol : "SOL"})
                  </p>
                  {depositMint === "SOL" && walletSol !== null && (
                    <p className="text-[11px] text-muted-foreground tabular-nums" data-testid="text-loop-wallet-sol">
                      Balance: {walletSol.toFixed(4)} SOL
                      <button
                        type="button"
                        className="ml-2 text-primary font-medium hover:underline disabled:opacity-50"
                        disabled={!!busy || !maxDepositSol}
                        onClick={() => {
                          setAmountSol(maxDepositSol ? String(maxDepositSol) : "");
                          setConfirmAction(null);
                        }}
                        data-testid="button-loop-max-sol"
                      >
                        Max
                      </button>
                    </p>
                  )}
                  {selectedAsset && heldFor(selectedAsset.mint) && (
                    <p className="text-[11px] text-muted-foreground tabular-nums" data-testid="text-loop-wallet-lst">
                      Balance: {heldFor(selectedAsset.mint)!.ui} {selectedAsset.symbol}
                      <button
                        type="button"
                        className="ml-2 text-primary font-medium hover:underline disabled:opacity-50"
                        disabled={!!busy}
                        onClick={() => {
                          setAmountSol(rawToDecimalString(heldFor(selectedAsset.mint)!.raw, selectedAsset.decimals));
                          setConfirmAction(null);
                        }}
                        data-testid="button-loop-max-lst"
                      >
                        Max
                      </button>
                    </p>
                  )}
                </div>
                {(depositAssetsList.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {["SOL", ...depositAssetsList.map((a) => a.mint)].map((m) => {
                      const asset = depositAssetsList.find((a) => a.mint === m);
                      const sym = m === "SOL" ? "SOL" : asset?.symbol ?? "?";
                      const held = m === "SOL" ? null : heldFor(m);
                      const hasBalance = m === "SOL" || (held !== null && Number(held.ui) > 0);
                      if (!hasBalance && !(lstPending && lstPending.mint === m)) return null;
                      return (
                        <button
                          key={m}
                          type="button"
                          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                            depositMint === m
                              ? "bg-primary/15 border-primary/50 text-primary"
                              : "bg-muted/30 border-border/60 text-muted-foreground hover:text-foreground"
                          }`}
                          disabled={!!busy || (!!lstPending && lstPending.mint !== m)}
                          onClick={() => {
                            setDepositMint(m);
                            setAmountSol("");
                            setConfirmAction(null);
                          }}
                          data-testid={`chip-loop-asset-${sym}`}
                        >
                          {sym}
                        </button>
                      );
                    })}
                  </div>
                )}
                <Input
                  inputMode="decimal"
                  placeholder={depositMint === "SOL" ? "0.5" : `Amount in ${selectedAsset?.symbol ?? ""}`}
                  value={amountSol}
                  disabled={lstResumeReady}
                  onChange={(e) => {
                    setAmountSol(e.target.value);
                    setConfirmAction(null);
                  }}
                  data-testid="input-loop-principal"
                />
              </div>
              {lstResumeReady && (
                <p className="text-[11px] text-amber-500" data-testid="text-loop-lst-pending">
                  Your {lstPending!.symbol} is already in the internal wallet and is safe. Tap the button to
                  finish converting it and open the loop.
                </p>
              )}
              <Button
                className="w-full"
                disabled={openDisabled}
                onClick={() =>
                  depositMint === "SOL"
                    ? runConfirmed("open", () => void startOpen())
                    : runConfirmed("open", () => void startLstOpen())
                }
                data-testid="button-loop-open"
              >
                {busy === "open" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  label("open", lstResumeReady ? "Retry: Finish Deposit" : "Deposit & Open Loop")
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground" data-testid="text-loop-auto-pick">
                Comes straight from your connected wallet. The platform picks the best staked SOL token
                automatically{statusQuery.data.recommended ? (
                  <> (currently <span className="font-medium text-foreground">{statusQuery.data.recommended.symbol}</span>)</>
                ) : null}.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setRatesOpen(true)}
                data-testid="button-loop-rates"
              >
                <Table2 className="w-3.5 h-3.5 mr-1.5" /> Compare live rates
              </Button>
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
                    <div className="grid grid-cols-3 gap-2 py-1">
                      <div>
                        <p className="text-[11px] text-muted-foreground">Leverage</p>
                        <p className="text-sm font-semibold" data-testid={`text-loop-leverage-${r.id}`}>
                          {fmtLeverage(r.solView?.leverage)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Balance</p>
                        <p className="text-sm font-semibold" data-testid={`text-loop-balance-${r.id}`}>
                          {fmtSolNum(r.solView?.balanceSol)}
                          {typeof r.solView?.balanceSol === "number" && <span className="font-normal text-muted-foreground"> SOL</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">PnL</p>
                        <p
                          className={`text-sm font-semibold ${
                            typeof r.solView?.pnlSol === "number"
                              ? r.solView.pnlSol >= 0
                                ? "text-emerald-500"
                                : "text-red-500"
                              : ""
                          }`}
                          data-testid={`text-loop-pnl-${r.id}`}
                        >
                          {fmtPnlSol(r.solView?.pnlSol)}
                          {typeof r.solView?.pnlPct === "number" && (
                            <span className="font-normal"> ({(r.solView.pnlPct * 100).toFixed(2)}%)</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Collateral: {fmtSol(r.live?.collateralRaw ?? r.collateralAmountRaw)} {vaultSymbol(r.venueVaultId)}
                      {" · "}Debt: {fmtSol(r.live?.debtRaw ?? r.debtAmountRaw)} SOL
                      {r.live ? " (live)" : " (last known)"}
                    </p>
                    {(r.solView?.returnedSol ?? 0) > 0 && (
                      <p className="text-[11px] text-muted-foreground" data-testid={`text-loop-returned-${r.id}`}>
                        Includes {fmtSolNum(r.solView?.returnedSol)} SOL already returned to your wallet.
                      </p>
                    )}
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
                        Pending: confirmation unresolved. New opens on this vault are blocked until reconciled.
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* --- Live LST rate table: display only. Same rate table + target
          function the brain uses server-side — never a picker. --- */}
      <Dialog open={ratesOpen} onOpenChange={setRatesOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-loop-rates">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Table2 className="w-4 h-4 text-primary" /> Live loop rates
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">
                Loop
              </span>
            </DialogTitle>
            <DialogDescription>
              Every staked SOL token the platform tracks, with its staking yield and what it costs to
              borrow SOL against it. The loop always uses the best one automatically.
            </DialogDescription>
          </DialogHeader>

          {ratesQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !ratesQuery.data?.rates?.length ? (
            <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-loop-rates-empty">
              Live rates are unavailable right now. Try again in a minute.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>Token</span>
                <span className="text-right w-16">Staking</span>
                <span className="text-right w-16">Borrow</span>
                <span className="text-right w-20">Net yield</span>
              </div>
              {[...ratesQuery.data.rates]
                .sort((a, b) => {
                  if (a.allowlisted !== b.allowlisted) return a.allowlisted ? -1 : 1;
                  return (b.netCarryAtTarget ?? -Infinity) - (a.netCarryAtTarget ?? -Infinity);
                })
                .map((r) => {
                  const isBest = r.vaultId === ratesQuery.data?.recommendedVaultId;
                  return (
                    <div
                      key={r.vaultId}
                      className={`grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center rounded-lg px-3 py-2.5 ${
                        isBest
                          ? "bg-cyan-500/10 ring-1 ring-cyan-500/40"
                          : r.allowlisted
                            ? "bg-muted/30"
                            : "bg-muted/20 opacity-60"
                      }`}
                      data-testid={`row-loop-rate-${r.symbol}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                            isBest ? "bg-gradient-to-br from-primary to-accent text-white" : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {r.symbol.slice(0, 2)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-tight truncate">{r.symbol}</p>
                          <p className="text-[10px] leading-tight text-muted-foreground">
                            {isBest ? (
                              <span className="text-cyan-600 dark:text-cyan-400 font-medium">Best right now</span>
                            ) : !r.allowlisted ? (
                              "Watch only"
                            ) : r.noTargetReason === "carry_nonpositive" ? (
                              <span className="text-amber-500">Paused: yield below borrow cost</span>
                            ) : r.targetLeverage === null ? (
                              "No data"
                            ) : (
                              "Loop-ready"
                            )}
                          </p>
                        </div>
                      </div>
                      <span className="text-right w-16 text-sm tabular-nums text-emerald-500" data-testid={`text-rate-staking-${r.symbol}`}>
                        {fmtPct(r.stakingApy)}
                      </span>
                      <span className="text-right w-16 text-sm tabular-nums text-amber-500" data-testid={`text-rate-borrow-${r.symbol}`}>
                        {fmtPct(r.borrowApr)}
                      </span>
                      <span className="text-right w-20 text-sm tabular-nums font-semibold" data-testid={`text-rate-net-${r.symbol}`}>
                        {r.targetLeverage !== null && r.netCarryAtTarget !== null ? (
                          <>
                            {fmtPct(r.netCarryAtTarget)}
                            <span className="block text-[10px] font-normal text-muted-foreground">
                              {r.hypothetical ? `if enabled · at ${r.targetLeverage.toFixed(1)}x` : `at ${r.targetLeverage.toFixed(1)}x`}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </div>
                  );
                })}
              <p className="text-[11px] text-muted-foreground px-1 pt-1" data-testid="text-loop-rates-footnote">
                Net yield = staking yield on the whole looped position minus borrow cost on the debt, at the
                safe auto-leverage for that token. Every pool borrows SOL from Jupiter&apos;s one shared
                liquidity pool, so the borrow cost is the same across tokens. Tokens whose staking yield
                is below the borrow cost sit out — looping them would lose money.
                {(() => {
                  const ago = fmtAgo(ratesQuery.data?.rates?.find((r) => r.asOf)?.asOf ?? null);
                  return ago ? <> Updated {ago}.</> : null;
                })()}
              </p>
              {!!ratesQuery.data?.venues?.length && (
                <div className="pt-2 space-y-1.5" data-testid="section-loop-venue-watch">
                  <p className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Other venues — SOL borrow cost (watch list)
                  </p>
                  {(() => {
                    const ourBorrow = ratesQuery.data.rates
                      .map((r) => r.borrowApr)
                      .filter((v): v is number => typeof v === "number")
                      .reduce<number | null>((min, v) => (min === null || v < min ? v : min), null);
                    return ratesQuery.data.venues.map((v) => {
                      const verdict = venueVerdict(v, ourBorrow);
                      return (
                        <div
                          key={v.venue}
                          className="flex items-center justify-between gap-3 rounded-lg bg-muted/20 px-3 py-2"
                          data-testid={`row-venue-watch-${v.venue}`}
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-tight">{v.venue}</p>
                            {verdict.text && (
                              <p
                                className={`text-[10px] leading-tight ${
                                  verdict.tone === "good"
                                    ? "text-emerald-500"
                                    : verdict.tone === "bad"
                                      ? "text-red-500"
                                      : verdict.tone === "warn"
                                        ? "text-amber-500"
                                        : "text-muted-foreground"
                                }`}
                              >
                                {verdict.text}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm tabular-nums text-amber-500" data-testid={`text-venue-borrow-${v.venue}`}>
                              {fmtPct(v.borrowApy)}
                            </p>
                            <p className="text-[10px] tabular-nums text-muted-foreground">
                              {fmtUsdM(v.supplyUsd)} pool
                              {v.utilization !== null ? ` · ${Math.round(v.utilization * 100)}% used` : ""}
                            </p>
                          </div>
                        </div>
                      );
                    });
                  })()}
                  <p className="px-1 text-[11px] text-muted-foreground">
                    Watch list only — loops can&apos;t open on these venues yet. P0 and Drift don&apos;t publish
                    rates publicly; reading them directly is the next step.
                    {(() => {
                      const ago = fmtAgo(ratesQuery.data?.venues?.[0]?.asOf ?? null);
                      return ago ? <> Sampled {ago}.</> : null;
                    })()}
                  </p>
                </div>
              )}
            </div>
          )}
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
            ? "This comes straight from your connected wallet. It covers your deposit plus one-time account rent and network fees. After you approve it, the loop opens automatically."
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
