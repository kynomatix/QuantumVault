// QuantumLab Lab Assistant — Phase C chat dock.
//
// A collapsed Sparkles button (bottom-right) expands into a persisted chat panel.
// With no saved OpenRouter key the dock is still a deterministic SHELL: messages
// persist server-side and the assistant offers clickable option bubbles, replying
// synchronously. With a saved key, POST .../messages starts a BACKGROUND turn
// (202) that drives the lab toolkit on the user's key; the dock then polls GET
// .../messages on turn_state and POSTs .../step to resume a turn parked on a
// long async run. All authenticated reads go through apiRequest, which stamps the
// x-wallet-address header so a stale session fails closed.

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Sparkles, Send, X, Bot, Loader2, Wallet, Square, Activity, Wand2, ChevronDown, ShieldCheck, ShieldAlert, TrendingUp, Rocket, Settings2 } from "lucide-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { AgentSuggestedAction, LabTradeRecord } from "@shared/schema";
import { looksLikeApiKey } from "@shared/api-key-detect";
import QuantAgentChecklist, { type AutoChecklistDto } from "@/components/QuantAgentChecklist";
import { calculateRiskAnalysis } from "@/lib/risk-analysis";

type ChatRole = "user" | "agent" | "tool";

interface ChatMessage {
  id: number;
  taskId: number;
  role: ChatRole;
  content: string;
  suggestedActions: AgentSuggestedAction[];
  createdAt: string;
}

interface EnsureResponse {
  task: { id: number; status: string; mode: string; createdAt: string };
  messages: ChatMessage[];
}

// The turn-loop view the server attaches to every messages read. turn_state drives
// the client poll loop: running_turn (a background LLM/tool step is advancing) and
// waiting_for_tool (parked on an async lab run) both mean "keep polling"; ready
// means the turn is done.
interface TurnTask {
  id: number;
  status: string;
  turnState: string;
  activeRunId: number | null;
  // Auto-mode (Task #200): mode==="auto" surfaces the watch banner + Stop control;
  // spendEstimateUsd is the running approved-spend total; cancelRequested reflects a
  // stop that's winding a live segment down.
  mode?: string;
  spendEstimateUsd?: number;
  cancelRequested?: boolean;
  // The quant-agent checklist slice (present only while an Auto run is live or finished).
  auto?: AutoChecklistDto | null;
}

interface MessagesResponse {
  messages: ChatMessage[];
  task?: TurnTask | null;
}

const messagesKey = (taskId: number | null, wallet: string | null) =>
  ["lab-assistant-messages", taskId, wallet] as const;

// Merge a server reply (its messages + latest turn task) into the cached transcript,
// de-duping by id and keeping ascending order. Used by every mutation that returns a
// MessagesResponse so the new line + turn_state show instantly before the poll catches up.
const mergeMessages = (
  prev: MessagesResponse | undefined,
  data: MessagesResponse,
): MessagesResponse => {
  const byId = new Map<number, ChatMessage>((prev?.messages ?? []).map((m) => [m.id, m]));
  for (const m of data.messages) byId.set(m.id, m);
  return {
    messages: Array.from(byId.values()).sort((a, b) => a.id - b.id),
    task: data.task ?? prev?.task ?? null,
  };
};

// apiRequest throws Error("<status>: <body>"); the body is usually JSON {error:"…"}.
// Pull out the human-readable message for an inline notice so a failed mutation
// (e.g. a locked session on /auto/start) surfaces the real reason instead of nothing.
function apiErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const body = raw.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    /* body wasn't JSON — fall through */
  }
  return body || fallback;
}

// Inline formatting within a single line: **bold** spans only, no markdown dependency.
// We split on the bold delimiter and wrap the captured (odd-index) segments in <strong>;
// everything else stays a plain text node. There's no dangerouslySetInnerHTML, so the
// content stays inert React text with no injection surface, and a lone/unmatched **
// renders literally. Multi-space metric columns survive because the parent line keeps
// whitespace-pre-wrap.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((seg, i) =>
    i % 2 === 1 ? (
      <strong key={`${keyPrefix}-b${i}`} className="font-semibold">
        {seg}
      </strong>
    ) : (
      <span key={`${keyPrefix}-t${i}`}>{seg}</span>
    ),
  );
}

// Light markdown for chat replies: **bold**, bullet lines ("- ", "* ", or "• "),
// horizontal dividers (a line of only dashes), and blank-line spacers. This lets the
// assistant stack result "cards" with a one-line verdict on top, divided by a rule,
// and stay scannable in a narrow dock. Output is block-level, so the caller wraps it
// in a <div> (a <p> cannot legally hold block children).
function renderRichText(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    // Divider: a whole line of 3+ dashes. Never matches "-50%" or "Net: -5%".
    if (/^-{3,}$/.test(trimmed)) {
      out.push(<hr key={`hr-${idx}`} className="my-2 border-white/10" />);
      return;
    }
    // Bullet: a dash/star/dot FOLLOWED BY a space (the space keeps negative numbers
    // like "-3%" from being read as bullets).
    const bullet = /^([-*•])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      out.push(
        <div key={`li-${idx}`} className="flex gap-1.5">
          <span className="mt-[0.1em] shrink-0 text-indigo-300/70">•</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {renderInline(bullet[2], `li-${idx}`)}
          </span>
        </div>,
      );
      return;
    }
    // Blank line: a small vertical gap between cards/paragraphs.
    if (trimmed === "") {
      out.push(<div key={`sp-${idx}`} className="h-1.5" />);
      return;
    }
    // Regular line: keep whitespace-pre-wrap so multi-space metric columns
    // ("Win rate: X   Trades: Y") do not collapse.
    out.push(
      <div key={`ln-${idx}`} className="whitespace-pre-wrap break-words">
        {renderInline(line, `ln-${idx}`)}
      </div>,
    );
  });
  return out;
}

// Friendly one-line labels for the agent's tool steps, so a collapsed step reads like
// "Read your top backtest results" instead of a raw "getTopResults result: {…}" blob.
const TOOL_STEP_LABELS: Record<string, string> = {
  listStrategies: "Checked your strategies",
  findStrategy: "Looked up a strategy",
  getTopResults: "Read your top backtest results",
  getHeatmap: "Read the parameter heatmap",
  getInsightsReport: "Reviewed your insights report",
  generateInsights: "Computed fresh insights",
  getRunStatus: "Checked run status",
  getQueuePosition: "Checked the run queue",
  createStrategyFromText: "Drafted a strategy",
  runOptimization: "Queued a backtest",
  refineFrom: "Queued a refine",
  improve: "Queued an improvement",
  cancelRun: "Cancelled a run",
};

// A tool message shaped "<toolName> result: <payload>" is the agent's raw working data —
// useful for trust, noisy in the flow. Collapse it behind a one-line "what it did" label
// the user can expand (like Replit/ChatGPT folding tool/thinking steps), so the answer
// isn't buried under JSON "garble". Friendly progress lines (no "result:" payload, e.g.
// the auto-run step feed) keep rendering as a plain inline log line.
function ToolStep({ id, content }: { id: number; content: string }) {
  const match = /^(\w+)\s+result:/.exec(content);
  const [expanded, setExpanded] = useState(false);
  if (!match) {
    return (
      <div
        data-testid={`message-lab-assistant-${id}`}
        className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-white/45"
      >
        <Activity className="mt-0.5 h-3 w-3 shrink-0 text-indigo-300/70" />
        <span className="whitespace-pre-wrap break-words">{content}</span>
      </div>
    );
  }
  const label = TOOL_STEP_LABELS[match[1]] ?? "Checked lab data";
  return (
    <div data-testid={`message-lab-assistant-${id}`} className="px-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`toggle-lab-assistant-tool-${id}`}
        className="flex w-full items-center gap-1.5 text-left text-[11px] leading-relaxed text-white/45 transition-colors hover:text-white/70"
      >
        <Activity className="h-3 w-3 shrink-0 text-indigo-300/70" />
        <span className="flex-1">{label}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <pre
          data-testid={`detail-lab-assistant-tool-${id}`}
          className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 px-2 py-1.5 text-[10px] leading-relaxed text-white/50"
        >
          {content}
        </pre>
      )}
    </div>
  );
}

// What the dock hands the parent when the user taps Deploy on the agent result card.
// RAW (1x) backtest numbers plus the computed recommended leverage; the parent fetches
// the strategy (pineScript + name) by strategyId and opens the existing deploy modal,
// which re-applies the leverage internally. The dock NEVER deploys; it only opens the
// modal (money path).
export interface AgentDeployTarget {
  strategyId: number;
  resultId: number;
  leverage: number;
  drawdownPercent: number;
  streakDrawdownPercent: number;
  profitPercent: number;
  winRatePercent: number;
  ticker?: string;
  timeframe?: string;
  params?: Record<string, any>;
}

// Shape of GET /api/lab/results/:resultId (a lab_optimization_results row). trades /
// equityCurve are jsonb and can be null on legacy rows; everything else is required.
interface FullLabResult {
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  params: Record<string, any>;
  trades?: LabTradeRecord[] | null;
  equityCurve?: { time: string; equity: number }[] | null;
  ticker: string;
  timeframe: string;
}

// The real, post-leverage result card the agent surfaces once it has a deployable
// result. Fetches the full result row, runs the SAME risk math the QuantumLab deploy
// flow uses (calculateRiskAnalysis -> recommendedLeverage), and shows the numbers the
// user will actually trade at. The Deploy button only OPENS the deploy modal; it never
// deploys on its own (money path).
function AgentDeployCard({
  deployable,
  walletAddress,
  onDeploy,
}: {
  deployable: NonNullable<AutoChecklistDto["deployableResult"]>;
  walletAddress: string | null;
  onDeploy?: (target: AgentDeployTarget) => void;
}) {
  const ready = deployable.status === "ready" && deployable.bestResultId != null;
  const enabled = ready && !!walletAddress;
  const { data, isLoading, isError } = useQuery({
    queryKey: ["lab-deploy-result", deployable.bestResultId, walletAddress],
    enabled,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/lab/results/${deployable.bestResultId}`);
      return (await res.json()) as FullLabResult;
    },
  });

  // Pending / unavailable: a small honest line, no fake numbers.
  if (!ready) {
    return (
      <div
        data-testid="agent-deploy-card-empty"
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px] text-white/55"
      >
        <Activity className="h-3.5 w-3.5 shrink-0 text-indigo-300/70" />
        {deployable.status === "pending"
          ? "Backtest running. Your deployable result will appear here when it lands."
          : "No deployable result yet."}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        data-testid="agent-deploy-card-loading"
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px] text-white/55"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-300" />
        Analyzing risk and recommended leverage...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div
        data-testid="agent-deploy-card-error"
        className="flex items-center gap-2 rounded-xl border border-yellow-400/25 bg-yellow-400/[0.06] px-3 py-2.5 text-[12px] text-yellow-200/80"
      >
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        Couldn't load the result to deploy. Open the result in QuantumLab to deploy it.
      </div>
    );
  }

  const trades = (data.trades ?? []) as LabTradeRecord[];
  const analysis = calculateRiskAnalysis(
    trades,
    data.netProfitPercent,
    data.maxDrawdownPercent,
    data.winRatePercent,
    data.equityCurve ?? undefined,
    data.ticker,
  );
  const recLev = analysis.recommendedLeverage;
  // Post-leverage figures: the numbers people actually trade at, not the 1x backtest.
  const postLevReturn = data.netProfitPercent * recLev;
  const postLevDD = data.maxDrawdownPercent * recLev;
  const robust = deployable.oosSharpe != null && deployable.oosSharpe > 0;

  const stats: { k: string; v: string; c: string }[] = [
    {
      k: `Net return (${recLev}x)`,
      v: `${postLevReturn >= 0 ? "+" : ""}${Math.round(postLevReturn)}%`,
      c: postLevReturn >= 0 ? "text-emerald-300" : "text-red-300",
    },
    { k: "Win rate", v: `${Math.round(data.winRatePercent)}%`, c: "text-white" },
    { k: `Max drawdown (${recLev}x)`, v: `-${Math.round(postLevDD)}%`, c: "text-white/80" },
  ];

  const handleDeploy = () => {
    onDeploy?.({
      strategyId: deployable.strategyId,
      resultId: deployable.bestResultId!,
      leverage: recLev,
      drawdownPercent: data.maxDrawdownPercent,
      streakDrawdownPercent: analysis.streakDrawdownPercent,
      profitPercent: data.netProfitPercent,
      winRatePercent: data.winRatePercent,
      ticker: data.ticker,
      timeframe: data.timeframe,
      params: data.params,
    });
  };

  return (
    <div
      data-testid="agent-deploy-card"
      className="w-full overflow-hidden rounded-xl border border-emerald-400/25 bg-gradient-to-br from-emerald-400/[0.07] to-card/60"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <span className="text-sm font-semibold text-white" data-testid="text-agent-deploy-title">
          {data.ticker} · {data.timeframe}
        </span>
        <span
          data-testid="badge-agent-deploy-robustness"
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            robust
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
              : "border-yellow-400/30 bg-yellow-400/10 text-yellow-200",
          )}
        >
          {robust ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
          {robust
            ? `Holds up out-of-sample (Sharpe ${deployable.oosSharpe!.toFixed(2)})`
            : "Unvalidated (no out-of-sample holdout)"}
        </span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-white/10">
        {stats.map((m) => (
          <div key={m.k} className="px-2 py-3 text-center">
            <div className={cn("font-mono text-lg font-bold", m.c)} data-testid={`text-agent-deploy-${m.k}`}>
              {m.v}
            </div>
            <div className="mt-0.5 text-[11px] text-white/45">{m.k}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
        <span className="text-[11.5px] leading-snug text-white/55">
          Shown at {recLev}x, the leverage the risk math recommends for this strategy.
        </span>
        <Button
          type="button"
          size="sm"
          onClick={handleDeploy}
          data-testid="button-agent-deploy"
          className="ml-auto h-8 shrink-0 gap-1.5 bg-gradient-to-r from-primary to-accent text-[12.5px] font-semibold text-white shadow-lg shadow-primary/30"
        >
          <Rocket className="h-3.5 w-3.5" />
          Deploy
        </Button>
      </div>
    </div>
  );
}

export function LabAssistantDock({
  walletAddress,
  sessionConnected = false,
  onReconnect,
  reconnecting = false,
  onNavigate,
  open,
  onOpenChange,
  onDeploy,
}: {
  walletAddress: string | null;
  sessionConnected?: boolean;
  // Re-establish a stale server session in place (re-sign), mirroring the
  // Creator's re-auth flow. Resolves true once the session is live again.
  onReconnect?: () => Promise<boolean>;
  // True while the parent's auto sign-in is mid-flight, so we don't offer a
  // premature "Reconnect" tap over an in-progress signature.
  reconnecting?: boolean;
  onNavigate: (tab: string) => void;
  // Whether the panel is open. The page owns this state (controlled) so the dock can
  // stay mounted on every lab tab while the page docks it to the side (reflows the
  // content narrower) and keeps only one right-side panel (this or the run queue) open.
  open: boolean;
  // Open/close requests from inside the dock (the FAB, the close button, the deploy
  // handoff). The page applies them and reflows its content to match.
  onOpenChange: (open: boolean) => void;
  // Tapped Deploy on the agent result card. The dock passes RAW backtest numbers +
  // recommended leverage; the parent opens the existing deploy modal pre-filled. The
  // dock NEVER deploys on its own (money path).
  onDeploy?: (target: AgentDeployTarget) => void;
}) {
  // Controlled open: every internal toggle routes through the page's setter.
  const setOpen = (next: boolean) => onOpenChange(next);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // Inline notice (e.g. the pasted-API-key guard) shown just above the composer.
  const [notice, setNotice] = useState<string | null>(null);
  // Task 201: hands-off toggle. Only ever offered to admin-whitelisted wallets; the
  // server re-checks eligibility on /auto/start so a stale UI can't force it on.
  const [handsOff, setHandsOff] = useState(false);
  // Inline settings panel that wipes down inside the dock. Replaces the old portal
  // dropdown, which locked page scroll while open.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Auto button "armed" state: tapping Auto with an empty composer lights it up and
  // waits for the goal text, so the user gets instant feedback that Auto is engaged.
  const [autoArmed, setAutoArmed] = useState(false);
  // Stale-session reconnect (re-sign): busy flag + last error for the button.
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  // Auto-resend after reconnect: the question that hit a locked-session reply, plus a
  // one-shot arm flag set ONLY by a successful reconnect — so the resend can't loop on
  // canChat (the session may already read "connected" at lock time).
  const pendingResendRef = useRef<string | null>(null);
  const [resendArmed, setResendArmed] = useState(false);
  // Always-current snapshots of the active wallet + task. A mutation that resolves AFTER
  // the user switches wallet/task reads these (NOT its closure, which can be stale) to
  // detect it's orphaned and drop its response — so wallet A's reply, or A's resend
  // question, can never land in wallet B's conversation. Updated every render (refs only).
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const qc = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Opens the Solana wallet-adapter picker so a fully signed-out user can connect
  // right from the chat. Once a wallet connects, useWallet auto-runs sign-in and
  // the open effect starts the chat task — no extra wiring is needed here.
  const { setVisible: setWalletModalVisible } = useWalletModal();

  // Open → make sure there's an active chat task (created or reused), seeded with
  // the greeting. The response already carries the messages, so prime the cache.
  const ensure = useMutation({
    mutationFn: async (forWallet: string) => {
      const res = await apiRequest("POST", "/api/lab/agent/chat/ensure");
      return { data: (await res.json()) as EnsureResponse, forWallet };
    },
    onSuccess: ({ data, forWallet }) => {
      // Ignore a response for a wallet we've since switched away from, so a slow
      // ensure for wallet A can't pin the dock to A's task after switching to B.
      if (forWallet !== walletAddress) return;
      setTaskId(data.task.id);
      qc.setQueryData<MessagesResponse>(messagesKey(data.task.id, forWallet), {
        messages: data.messages,
      });
    },
  });

  // A wallet switch must drop the previous wallet's conversation handle so the
  // open effect re-ensures a task for the new wallet. (Messages are cached per
  // wallet anyway, so nothing leaks across wallets — this is a UX correctness.)
  useEffect(() => {
    setTaskId(null);
    setReconnectError(null);
    setReconnectBusy(false);
    // Drop any pending auto-resend so wallet A's locked question can never be sent into
    // wallet B's conversation after a switch + reconnect.
    pendingResendRef.current = null;
    setResendArmed(false);
  }, [walletAddress]);

  // Don't let a stale reconnect error linger once the session is healthy again.
  useEffect(() => {
    if (sessionConnected) setReconnectError(null);
  }, [sessionConnected]);

  // Only start a chat once the wallet is connected AND the server session is
  // authenticated — firing ensure before the session is ready would 401 and
  // flash a spurious error during the sign-in handshake.
  useEffect(() => {
    if (open && walletAddress && sessionConnected && taskId === null && !ensure.isPending) {
      ensure.mutate(walletAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, walletAddress, sessionConnected, taskId]);

  const messagesQuery = useQuery({
    queryKey: messagesKey(taskId, walletAddress),
    enabled: open && !!taskId && !!walletAddress,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/lab/agent/chat/${taskId}/messages`);
      return (await res.json()) as MessagesResponse;
    },
    // While a turn is live the background job mutates the transcript out-of-band, so
    // poll to surface new tool/agent messages + the latest turn_state. Polling stops
    // the moment the turn returns to "ready" (or errors out to ready).
    refetchInterval: (query) => {
      const ts = query.state.data?.task?.turnState;
      return ts === "running_turn" || ts === "waiting_for_tool" ? 2500 : false;
    },
  });

  // Task 201: is THIS wallet allowed to run hands-off? Drives whether the toggle shows
  // at all. Cached for the session (whitelist rarely changes); the server re-checks on
  // /auto/start regardless, so a stale "eligible" can never actually force hands-off on.
  const handsOffEligibilityQuery = useQuery({
    queryKey: ["lab-handsoff-eligibility", walletAddress],
    enabled: open && !!walletAddress,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/lab/agent/handsoff-eligibility");
      return (await res.json()) as { eligible: boolean };
    },
  });
  const handsOffEligible = handsOffEligibilityQuery.data?.eligible === true;

  // Remember the hands-off choice per wallet so it survives a refresh, instead of
  // resetting to off every page load. The eligibility query is disabled until the dock
  // opens, so we wait for isSuccess (not merely !isLoading, since a disabled query is
  // not "loading") before restoring. Otherwise we'd mark the wallet restored too early,
  // see "not eligible", and never read the saved value. Restored ONCE per wallet, and
  // only if still eligible (the server re-checks on /auto/start too). Saved on toggle below.
  const handsOffRestoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!walletAddress || !handsOffEligibilityQuery.isSuccess) return;
    if (handsOffRestoredFor.current === walletAddress) return;
    handsOffRestoredFor.current = walletAddress;
    if (!handsOffEligible) {
      setHandsOff(false);
      return;
    }
    try {
      setHandsOff(localStorage.getItem(`qv-lab-handsoff:${walletAddress}`) === "1");
    } catch {
      /* localStorage unavailable (private mode etc.); just leave it off. */
    }
  }, [walletAddress, handsOffEligible, handsOffEligibilityQuery.isSuccess]);

  const send = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/messages`, { content });
      return (await res.json()) as MessagesResponse;
    },
    // Snapshot which wallet + task this send belongs to, captured synchronously at send
    // time. onSuccess compares it to the live wallet/task to drop a stale response.
    onMutate: (content) => ({ wallet: walletAddress, taskId, content }),
    onSuccess: (data, _content, ctx) => {
      // Stale-response guard: if the user switched wallet (or task) while this POST was
      // in flight, drop the response entirely — don't write wallet A's reply into wallet
      // B's cache, and (critically) don't stash A's question into the shared resend ref.
      if (!ctx || ctx.wallet !== walletRef.current || ctx.taskId !== taskIdRef.current) return;
      // Merge the returned message(s) + task so the user's line and the running_turn
      // state show instantly; the poll loop (driven by turn_state) then takes over
      // and surfaces the assistant's tool/agent messages as the turn advances.
      qc.setQueryData<MessagesResponse>(messagesKey(taskId, walletAddress), (prev) =>
        mergeMessages(prev, data),
      );
      // If the reply came back as a "session locked" degrade (it carries the plain
      // reconnect-session chip), stash the question so a successful reconnect can auto-resend
      // it — the user shouldn't have to retype what they just asked. Any normal reply clears
      // it. Only the plain chip arms resend: the auto-run reauth chips (reauth-continue /
      // reauth-fresh) resume the pipeline, they don't re-send a typed question.
      const locked = (data.messages ?? []).some(
        (msg) =>
          msg.role === "agent" &&
          msg.suggestedActions?.some((a) => a.kind === "reconnect" && a.id === "reconnect-session"),
      );
      pendingResendRef.current = locked ? ctx.content : null;
    },
    onError: (err) => {
      // Don't swallow a hard send failure — show why (the normal degrade path returns
      // 200 with a shell reply, so this only fires on a true error).
      setNotice(apiErrorMessage(err, "Couldn't send your message. Try again."));
    },
  });

  // Resume a parked turn after an async lab run. One in-flight at a time (the
  // !isPending guard in the effect below); the server is also a safe no-op if the
  // run hasn't finished or a step is already advancing, so an extra /step never
  // double-spends or re-enqueues.
  const step = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/step`);
      return (await res.json()) as { task?: TurnTask | null; resumed: boolean; messages?: ChatMessage[] };
    },
    onSuccess: (data) => {
      // Only touch the cache when /step actually carries a message (the locked-session
      // note when a turn loses its key mid-flight). A normal /step is a no-op that returns
      // just the task with NO transcript. Writing the cache then would (a) bump
      // messagesQuery.dataUpdatedAt and re-fire the /step effect in a tight loop, and
      // (b) let /step's task flip turn_state→ready and STOP the GET poll BEFORE it fetches
      // the agent reply — exactly "the reply only shows after I refresh." The GET poll owns
      // turn_state + the transcript (it always returns them together); a /step must only
      // ever ADD its own message, never the turn_state, so polling keeps running until the
      // poll itself sees ready alongside the new reply.
      if (!data.messages || data.messages.length === 0) return;
      qc.setQueryData<MessagesResponse>(messagesKey(taskId, walletAddress), (prev) =>
        mergeMessages(prev, { messages: data.messages! }),
      );
    },
  });

  // Start the watched auto-grind pipeline (Task #200). The composer draft becomes the
  // goal; the server resets the spend/leash budget, flips mode→auto and kicks the first
  // deterministic tick. The poll loop + /step effect then drive it forward, parking with
  // confirm chips (cost in the label) before each PAID step.
  const autoStart = useMutation({
    mutationFn: async ({ goal, handsOff }: { goal: string; handsOff: boolean }) => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/auto/start`, { goal, handsOff });
      return (await res.json()) as MessagesResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData<MessagesResponse>(messagesKey(taskId, walletAddress), (prev) =>
        mergeMessages(prev, data),
      );
    },
    onError: (err) => {
      // Surface the real reason (e.g. a locked session) instead of the button silently
      // doing nothing — the #1 reason "the Auto button doesn't do anything."
      setNotice(apiErrorMessage(err, "Couldn't start the auto run. Try again."));
    },
  });

  // Instant Stop (Task #200): cancels agent-owned queued backtests, signals a live
  // segment to wind down, clears any confirm gate, and drops back to chat. The server is
  // idempotent, so a stray tap after the run already ended is a harmless no-op.
  const stop = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/auto/stop`);
      return (await res.json()) as MessagesResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData<MessagesResponse>(messagesKey(taskId, walletAddress), (prev) =>
        mergeMessages(prev, data),
      );
    },
  });

  // Resume a PARKED auto run after the 30-min session expired mid-run and the user re-signed.
  // The server re-enters the orchestrator from the preserved step (or re-parks / drops to chat
  // if the key is still locked / was deleted). Merges the returned messages + task so the
  // checklist flips back to "working" without a manual refresh.
  const resume = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/auto/resume`);
      return (await res.json()) as MessagesResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData<MessagesResponse>(messagesKey(taskId, walletAddress), (prev) =>
        mergeMessages(prev, data),
      );
    },
    onError: (err) => {
      setNotice(apiErrorMessage(err, "Couldn't resume the run. Try again."));
    },
  });

  const messages = messagesQuery.data?.messages ?? [];
  const task = messagesQuery.data?.task ?? null;
  const signedIn = !!walletAddress && sessionConnected;
  const canChat = signedIn && taskId !== null;
  const turnState = task?.turnState ?? "ready";
  const turnActive = turnState === "running_turn" || turnState === "waiting_for_tool";
  // Auto-mode watch state: the banner + Stop control show while mode==="auto".
  const isAuto = task?.mode === "auto";
  const spend = task?.spendEstimateUsd ?? 0;

  // Quant-agent checklist collapse. The checklist sits pinned above the chat while a run
  // drives it. Once the run finishes it would otherwise stay fully expanded and eat most
  // of the panel, so we fold it down to its one-line header on completion. The user can
  // re-open it any time with the header chevron, and a fresh run re-opens it so live
  // progress stays visible. The deploy result card below is left untouched either way.
  const autoPhase = task?.auto?.phase ?? null;
  const autoRunActive = autoPhase != null && autoPhase !== "done";
  const [autoChecklistCollapsed, setAutoChecklistCollapsed] = useState(false);
  const autoWasActive = useRef(false);
  useEffect(() => {
    if (autoPhase === "done") {
      setAutoChecklistCollapsed(true);
    } else if (autoRunActive && !autoWasActive.current) {
      // A run just (re)started: show the steps. Only on the inactive->active edge, so a
      // manual collapse mid-run isn't fought by the next phase tick.
      setAutoChecklistCollapsed(false);
    }
    autoWasActive.current = autoRunActive;
  }, [autoPhase, autoRunActive]);
  const stopPending = stop.isPending || task?.cancelRequested === true;
  // Auto mode that's parked (not actively working) means the planner is waiting on a
  // paid-step confirm chip — finalReply/degrade flip mode→chat on every other ending, so
  // ready+auto only ever means "awaiting your OK". Steer the user to the chips by
  // disabling freeform input here (typing would re-drive the planner and strand text).
  const awaitingConfirm = isAuto && !turnActive;
  const workingLabel =
    turnState === "waiting_for_tool"
      ? isAuto
        ? "Running backtests — your manual runs go first…"
        : "Running your backtest…"
      : "Thinking…";

  // Client-driven resume (§7): while a turn is live, POST /step once per poll tick
  // (gated to one in-flight). This drives BOTH live states:
  //   • waiting_for_tool — advances the turn once the async run finishes.
  //   • running_turn      — re-drives a DB-persisted turn whose background job is
  //                         gone after a crash/restart (without this, the client
  //                         would GET-poll a stuck turn forever and never resume).
  // During a NORMAL running_turn the live background job owns the advance, so the
  // server no-ops cheaply via isLabTurnRunning — this never double-spends or
  // re-enqueues. Keyed off the poll's dataUpdatedAt so it re-fires each refetch
  // until turn_state returns to ready. Interactive by design — closing the tab
  // simply pauses the turn until it's reopened.
  useEffect(() => {
    if (turnActive && canChat && !step.isPending) {
      step.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState, messagesQuery.dataUpdatedAt, canChat]);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, open, send.isPending, turnActive]);

  // After a successful reconnect, auto-resend the question that hit the locked-session
  // reply so the user doesn't have to retype it. Gated on resendArmed (set ONLY by
  // handleReconnect) so it can't loop, then waits for the session + task to be live and
  // the chat to be idle. A still-locked resend re-stashes the question but leaves the arm
  // off, so it stops cleanly instead of looping.
  useEffect(() => {
    if (!resendArmed) return;
    const pending = pendingResendRef.current;
    if (!pending) {
      setResendArmed(false);
      return;
    }
    if (canChat && !turnActive && !send.isPending && !reconnectBusy) {
      pendingResendRef.current = null;
      setResendArmed(false);
      setNotice(null);
      send.mutate(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resendArmed, canChat, turnActive, send.isPending, reconnectBusy]);

  // Re-establish a stale server session in place (re-sign in the wallet),
  // mirroring the Creator's re-auth flow, so a user whose session went idle can
  // get back to chatting without leaving the assistant. Must be gesture-driven:
  // the wallet's signMessage has to fire inside a real user tap.
  async function handleReconnect() {
    if (!onReconnect || reconnectBusy) return;
    setReconnectBusy(true);
    setReconnectError(null);
    try {
      const ok = await onReconnect();
      if (!ok) {
        setReconnectError(
          "Sign-in didn’t finish. Approve the request in your wallet, then try again.",
        );
        return;
      }
      // Session is live again. If there's still no chat task, start one now —
      // when the session was already "connected" (an expired ensure), the
      // sessionConnected prop won't change, so the auto-effect can't re-fire.
      if (walletAddress && taskId === null && !ensure.isPending) {
        ensure.mutate(walletAddress);
      }
      // Arm the auto-resend of the question that hit the locked-session reply. The effect
      // below fires it once the session + task are live and the chat is idle. Armed here
      // (after a real reconnect) — never off canChat alone, which could loop.
      if (pendingResendRef.current) setResendArmed(true);
    } finally {
      setReconnectBusy(false);
    }
  }

  // Re-sign, then either RESUME the parked auto run from where it left off ("continue") or
  // STOP it and drop back to chat ("fresh"). Used by the two chips on the auto-run pause
  // notice. Unlike handleReconnect this never arms a resend: a parked run has no typed
  // question waiting, so we clear any stale stash first so the resend effect can't fire.
  async function handleReauth(mode: "continue" | "fresh") {
    if (!onReconnect || reconnectBusy) return;
    pendingResendRef.current = null;
    setResendArmed(false);
    setReconnectBusy(true);
    setReconnectError(null);
    try {
      const ok = await onReconnect();
      if (!ok) {
        setReconnectError(
          "Sign-in didn’t finish. Approve the request in your wallet, then try again.",
        );
        return;
      }
      setNotice(null);
      if (mode === "continue") {
        resume.mutate();
      } else {
        stop.mutate();
      }
    } finally {
      setReconnectBusy(false);
    }
  }

  function submitDraft() {
    const content = draft.trim();
    if (!content || !canChat || send.isPending || turnActive || awaitingConfirm) return;
    // Never let a pasted API key leave the browser or hit the transcript. The
    // server rejects it too (defense in depth), but stop it here for instant,
    // key-free feedback — the key belongs in the Creator's encrypted store.
    if (looksLikeApiKey(content)) {
      setDraft("");
      setNotice(
        "That looked like an API key, so I didn't send it. Add your key in the Creator — it's stored encrypted and never shown in this chat.",
      );
      return;
    }
    // When Auto is armed, Enter / Send launches the auto-run with this text as the
    // goal instead of sending a one-off chat message.
    if (autoArmed) {
      launchAuto(content);
      return;
    }
    setNotice(null);
    setDraft("");
    send.mutate(content);
  }

  // Auto button handler. Tap with an EMPTY composer to "arm" it (the button lights up
  // and the placeholder asks for the goal); tap again to cancel, or type the goal and
  // press Enter / Send to launch. Tapping WITH text already typed launches immediately.
  function toggleAuto() {
    if (!canChat || autoStart.isPending || turnActive || isAuto) return;
    const goal = draft.trim();
    if (autoArmed) {
      if (!goal) {
        setAutoArmed(false); // armed but still empty: tapping again cancels
        return;
      }
      if (looksLikeApiKey(goal)) {
        setDraft("");
        setNotice(
          "That looked like an API key, so I didn't send it. Add your key in the Creator — it's stored encrypted and never shown in this chat.",
        );
        return;
      }
      launchAuto(goal);
      return;
    }
    if (!goal) {
      setAutoArmed(true); // empty: arm + show it's engaged, then focus the input
      inputRef.current?.focus();
      return;
    }
    if (looksLikeApiKey(goal)) {
      setDraft("");
      setNotice(
        "That looked like an API key, so I didn't send it. Add your key in the Creator — it's stored encrypted and never shown in this chat.",
      );
      return;
    }
    launchAuto(goal);
  }

  // Kick off the watched auto-grind run. The goal is persisted + echoed, so the same
  // pasted-key guard as a chat send runs before we reach here.
  function launchAuto(goal: string) {
    setNotice(null);
    setDraft("");
    setAutoArmed(false);
    // Only request hands-off when the wallet is actually eligible; the server re-checks.
    autoStart.mutate({ goal, handsOff: handsOff && handsOffEligible });
  }

  function handleAction(action: AgentSuggestedAction) {
    // Navigation never needs a session; "send" chips do; "reconnect" re-signs in place
    // to reload the session UMK (the fix for a saved-but-locked key — a plain wallet
    // reconnect won't restore it, only a re-sign does).
    if (action.kind === "navigate" && action.tab) {
      onNavigate(action.tab);
    } else if (action.kind === "reconnect") {
      // The auto-run pause notice carries two re-sign chips: "Continue session" resumes the
      // parked run from where it left off; "Start a new one" re-signs then stops it back to
      // chat. Any other reconnect chip is the plain locked-session re-sign.
      if (action.id === "reauth-continue") void handleReauth("continue");
      else if (action.id === "reauth-fresh") void handleReauth("fresh");
      else void handleReconnect();
    } else if (action.kind === "send" && action.message && canChat && !send.isPending && !turnActive) {
      // A chip is a normal chat send, not an Auto goal: disarm first so a
      // lingering armed state can't hijack the user's next typed message.
      setAutoArmed(false);
      send.mutate(action.message);
    }
  }

  // The FAB stays discoverable even when signed out so it never silently
  // vanishes (on mobile the wallet adapter's publicKey is often transiently
  // null even when the user feels signed in). Chatting still needs a connected
  // wallet + server session; when that's missing we show a prompt and disable
  // the composer instead of hiding the button.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="button-lab-assistant-open"
        className="fixed bottom-5 right-5 z-[60] flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-900/40 transition-colors hover:bg-indigo-500"
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden sm:inline">Assistant</span>
      </button>
    );
  }

  // Chips ride the most recent assistant message.
  const lastAgent = [...messages].reverse().find((m) => m.role === "agent");
  const chips = lastAgent?.suggestedActions ?? [];
  const isLoading = ensure.isPending || (messagesQuery.isLoading && messages.length === 0);
  // Auto button "engaged" look: lit while armed, while a run is live, or while starting.
  const autoActive = autoArmed || isAuto || autoStart.isPending;
  // Signed in, but the chat session couldn't be created (e.g. session expired).
  const sessionProblem = signedIn && ensure.isError;

  return (
    <div
      data-testid="lab-assistant-dock"
      className="fixed inset-y-0 right-0 z-[60] w-full animate-in slide-in-from-right duration-300 sm:w-[400px]"
    >
      <Card className="flex h-full flex-col overflow-hidden rounded-none border-y-0 border-r-0 border-l border-white/10 bg-slate-900/95 shadow-2xl shadow-black/50 backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-white">Lab Assistant</p>
              <p className="text-[10px] text-white/40">Guides you around QuantumLab</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Task 201: hands-off lives in a small options menu next to the X, only for
                admin-whitelisted wallets. Keeps the chat area free of a big checkbox row. */}
            {handsOffEligible && (
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                data-testid="button-lab-assistant-options"
                aria-expanded={settingsOpen}
                aria-controls="lab-assistant-settings-panel"
                aria-label="Assistant settings"
                className={cn(
                  "rounded-md p-1 transition-colors",
                  settingsOpen
                    ? "bg-white/10 text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white",
                )}
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              data-testid="button-lab-assistant-close"
              className="rounded-md p-1 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
              aria-label="Close assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Settings: wipes down INSIDE the dock (no portal, so it never locks page
            scroll the way the old dropdown did). The header gear opens/closes it. */}
        {handsOffEligible && (
          <div
            id="lab-assistant-settings-panel"
            role="region"
            aria-label="Assistant settings"
            data-testid="lab-assistant-settings-panel"
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-in-out",
              settingsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              <div className="space-y-3 border-b border-white/10 bg-white/[0.02] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                  Assistant settings
                </p>
                <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
                  <input
                    type="checkbox"
                    checked={handsOff}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setHandsOff(next);
                      if (walletAddress) {
                        try {
                          localStorage.setItem(`qv-lab-handsoff:${walletAddress}`, next ? "1" : "0");
                        } catch {
                          /* localStorage unavailable; choice just won't persist. */
                        }
                      }
                    }}
                    disabled={isAuto || turnActive}
                    data-testid="checkbox-lab-assistant-handsoff"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500 disabled:opacity-50"
                  />
                  <span>
                    Hands-off mode
                    <span className="block text-white/40">
                      Auto-approve paid steps; caps still apply.
                    </span>
                  </span>
                </label>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSettingsOpen(false)}
                    data-testid="button-lab-assistant-settings-done"
                    className="h-7 border border-white/10 px-3 text-xs text-white/80 hover:bg-white/5"
                  >
                    Done
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Auto-run watch banner (Task #200): always visible while mode==="auto" —
            shows live status + approved spend so far, and the always-available Stop. */}
        {isAuto && (
          <div
            data-testid="lab-assistant-auto-banner"
            className="flex items-center justify-between gap-2 border-b border-indigo-400/20 bg-indigo-500/10 px-4 py-2"
          >
            <div className="flex min-w-0 items-center gap-2 text-xs text-indigo-100">
              <Loader2
                className={cn("h-3.5 w-3.5 shrink-0", (turnActive || stop.isPending) && "animate-spin")}
              />
              <span className="font-medium" data-testid="text-lab-assistant-auto-status">
                {stopPending ? "Stopping…" : turnActive ? "Auto-run active" : "Waiting for your OK"}
              </span>
              <span className="truncate text-indigo-200/70" data-testid="text-lab-assistant-spend">
                · ~${spend.toFixed(2)} spent
              </span>
            </div>
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stopPending || !canChat}
              data-testid="button-lab-assistant-stop"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          </div>
        )}

        {/* Quant-agent checklist: the live task list the Auto run drives. Present whenever
            the task carries an `auto` slice (a live run, or a finished one we still show).
            Purely additive: derived from the polled DTO, never touches the turn loop. */}
        {task?.auto && (
          <div className="space-y-2.5 border-b border-white/10 px-3 py-2.5">
            <QuantAgentChecklist
              auto={task.auto}
              collapsed={autoChecklistCollapsed}
              onToggleCollapsed={() => setAutoChecklistCollapsed((v) => !v)}
            />
            {task.auto.deployableResult && (
              <AgentDeployCard
                deployable={task.auto.deployableResult}
                walletAddress={walletAddress}
                onDeploy={(target) => {
                  // Close the docked panel before the deploy modal opens. The dock sits
                  // at z-[60] (above the shadcn modal's z-50) and is full-width on phones,
                  // so leaving it open would cover the modal. Closing also un-pushes the
                  // page so the modal is centred in the full viewport.
                  setOpen(false);
                  onDeploy?.(target);
                }}
              />
            )}
          </div>
        )}

        {/* Transcript */}
        <div
          ref={listRef}
          data-testid="lab-assistant-messages"
          className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
        >
          {!signedIn && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center" data-testid="lab-assistant-connect-prompt">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300">
                <Sparkles className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-white">
                {walletAddress ? "Reconnect to chat" : "Connect your wallet to chat"}
              </p>
              <p className="max-w-[240px] text-xs text-white/40">
                {walletAddress
                  ? "Your session went idle. Re-sign in your wallet to pick up where you left off — no need to leave this chat."
                  : "Connect your wallet to start — then the assistant can guide you around QuantumLab."}
              </p>
              {walletAddress && onReconnect && (
                <>
                  <button
                    type="button"
                    onClick={handleReconnect}
                    disabled={reconnectBusy || reconnecting}
                    data-testid="button-lab-assistant-reconnect"
                    className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3.5 py-1.5 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {(reconnectBusy || reconnecting) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {reconnectBusy || reconnecting ? "Reconnecting…" : "Reconnect"}
                  </button>
                  {reconnectError && (
                    <p className="max-w-[240px] text-xs text-amber-300/90" data-testid="text-lab-assistant-reconnect-error">
                      {reconnectError}
                    </p>
                  )}
                </>
              )}
              {!walletAddress && (
                <button
                  type="button"
                  onClick={() => setWalletModalVisible(true)}
                  data-testid="button-lab-assistant-connect"
                  className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3.5 py-1.5 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/20"
                >
                  <Wallet className="h-3.5 w-3.5" />
                  Connect wallet
                </button>
              )}
            </div>
          )}

          {sessionProblem && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center" data-testid="lab-assistant-session-error">
              <p className="text-sm font-medium text-white">Couldn’t start a chat</p>
              <p className="max-w-[240px] text-xs text-white/40">
                Your session may have gone idle. Reconnect to refresh it, or try again.
              </p>
              <div className="mt-1 flex items-center gap-2">
                {onReconnect && (
                  <button
                    type="button"
                    onClick={handleReconnect}
                    disabled={reconnectBusy || reconnecting || ensure.isPending}
                    data-testid="button-lab-assistant-reconnect-session"
                    className="inline-flex items-center gap-1.5 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {(reconnectBusy || reconnecting) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {reconnectBusy || reconnecting ? "Reconnecting…" : "Reconnect"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => walletAddress && ensure.mutate(walletAddress)}
                  disabled={ensure.isPending || reconnectBusy}
                  data-testid="button-lab-assistant-retry"
                  className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/70 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  Try again
                </button>
              </div>
              {reconnectError && (
                <p className="max-w-[240px] text-xs text-amber-300/90" data-testid="text-lab-assistant-reconnect-error">
                  {reconnectError}
                </p>
              )}
            </div>
          )}

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-white/40" data-testid="lab-assistant-loading">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}

          {messages.map((m) => {
            // Tool messages are the agent's working steps. ToolStep collapses raw
            // "<tool> result: <payload>" blobs behind an expandable one-line label and
            // renders friendly progress lines (the auto-run step feed) inline as before.
            if (m.role === "tool") {
              return <ToolStep key={m.id} id={m.id} content={m.content} />;
            }
            const isUser = m.role === "user";
            return (
              <div
                key={m.id}
                data-testid={`message-lab-assistant-${m.id}`}
                className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                    isUser
                      ? "rounded-br-sm bg-indigo-600 text-white"
                      : "rounded-bl-sm bg-white/[0.06] text-white/90",
                  )}
                >
                  {!isUser && (
                    <span className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-indigo-300/80">
                      <Bot className="h-3 w-3" /> Assistant
                    </span>
                  )}
                  <div className="break-words leading-relaxed">{renderRichText(m.content)}</div>
                </div>
              </div>
            );
          })}

          {(send.isPending || turnActive) && (
            <div className="flex justify-start" data-testid="lab-assistant-sending">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-white/[0.06] px-3 py-2 text-xs text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {workingLabel}
              </div>
            </div>
          )}
        </div>

        {/* Option bubbles */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-white/10 px-4 py-2.5">
            {chips.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => handleAction(a)}
                disabled={
                  send.isPending ||
                  turnActive ||
                  (a.kind === "send" && !canChat) ||
                  (a.kind === "reconnect" && (reconnectBusy || reconnecting))
                }
                data-testid={`chip-lab-assistant-${a.id}`}
                className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {notice && (
          <div
            data-testid="text-lab-assistant-notice"
            className="border-t border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/90"
          >
            {notice}
          </div>
        )}

        {/* Composer */}
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-3">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (notice) setNotice(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder={
              turnActive
                ? "Assistant is working…"
                : awaitingConfirm
                  ? "Use the buttons above to continue…"
                  : autoArmed
                    ? "Type your goal, then press Enter to start Auto…"
                    : canChat
                      ? "Ask the assistant…"
                      : signedIn
                      ? "Starting chat…"
                      : walletAddress
                        ? "Finish signing in to chat"
                        : "Connect your wallet to chat"
            }
            maxLength={4000}
            disabled={!canChat || turnActive || awaitingConfirm}
            data-testid="input-lab-assistant"
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-indigo-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={toggleAuto}
            disabled={autoStart.isPending || !canChat || turnActive || isAuto}
            title="Auto-run this as a goal — I'll build, backtest and refine, pausing to confirm before any paid AI step."
            data-testid="button-lab-assistant-auto"
            aria-pressed={autoActive}
            className={cn(
              "shrink-0 gap-1 border px-2.5 text-xs transition-all active:scale-95",
              autoActive
                ? "border-transparent bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/30 disabled:opacity-100"
                : "border-indigo-400/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20",
            )}
          >
            {autoStart.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            Auto
          </Button>
          <Button
            type="button"
            size="icon"
            onClick={submitDraft}
            disabled={!draft.trim() || send.isPending || !canChat || turnActive || awaitingConfirm}
            data-testid="button-lab-assistant-send"
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </Card>
    </div>
  );
}
