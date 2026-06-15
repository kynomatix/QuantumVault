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
import { Sparkles, Send, X, Bot, Loader2, Wallet, Square, Activity, Wand2, ChevronDown } from "lucide-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { AgentSuggestedAction } from "@shared/schema";
import { looksLikeApiKey } from "@shared/api-key-detect";

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

// Render the small slice of markdown the assistant emits — currently just **bold** —
// without pulling in a markdown dependency. We split on the bold delimiter and wrap
// the captured (odd-index) segments in <strong>; everything else stays a plain text
// node. There's no dangerouslySetInnerHTML, so the content remains inert React text
// with no injection surface. Newlines are preserved by whitespace-pre-wrap on the
// parent, and a lone/unmatched ** simply renders literally.
function renderRichText(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((seg, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">
        {seg}
      </strong>
    ) : (
      seg
    ),
  );
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

export function LabAssistantDock({
  walletAddress,
  sessionConnected = false,
  onReconnect,
  reconnecting = false,
  onNavigate,
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
}) {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // Inline notice (e.g. the pasted-API-key guard) shown just above the composer.
  const [notice, setNotice] = useState<string | null>(null);
  // Task 201: hands-off toggle. Only ever offered to admin-whitelisted wallets; the
  // server re-checks eligibility on /auto/start so a stale UI can't force it on.
  const [handsOff, setHandsOff] = useState(false);
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
      // If the reply came back as a "session locked" degrade (it carries a reconnect
      // chip), stash the question so a successful reconnect can auto-resend it — the user
      // shouldn't have to retype what they just asked. Any normal reply clears it.
      const locked = (data.messages ?? []).some(
        (msg) => msg.role === "agent" && msg.suggestedActions?.some((a) => a.kind === "reconnect"),
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

  const messages = messagesQuery.data?.messages ?? [];
  const task = messagesQuery.data?.task ?? null;
  const signedIn = !!walletAddress && sessionConnected;
  const canChat = signedIn && taskId !== null;
  const turnState = task?.turnState ?? "ready";
  const turnActive = turnState === "running_turn" || turnState === "waiting_for_tool";
  // Auto-mode watch state: the banner + Stop control show while mode==="auto".
  const isAuto = task?.mode === "auto";
  const spend = task?.spendEstimateUsd ?? 0;
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
    setNotice(null);
    setDraft("");
    send.mutate(content);
  }

  // Kick off a watched auto-grind run using the composer text as the goal. Same
  // pasted-key guard as a chat send — the goal is persisted + echoed, so a key must
  // never land here (the server rejects it too).
  function startAuto() {
    const goal = draft.trim();
    if (!canChat || autoStart.isPending || turnActive || isAuto) return;
    // Empty composer: explain what Auto is instead of silently no-opping (the button is
    // intentionally clickable while empty so a tap teaches the feature — "what is the
    // Auto button? it doesn't seem to do anything").
    if (!goal) {
      setNotice(
        "Auto-run builds it for you: type what you want (e.g. “a mean-reversion bot for SOL”), then tap Auto — I'll draft, backtest and refine it, pausing to confirm before any paid AI step.",
      );
      return;
    }
    if (looksLikeApiKey(goal)) {
      setDraft("");
      setNotice(
        "That looked like an API key, so I didn't send it. Add your key in the Creator — it's stored encrypted and never shown in this chat.",
      );
      return;
    }
    setNotice(null);
    setDraft("");
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
      void handleReconnect();
    } else if (action.kind === "send" && action.message && canChat && !send.isPending && !turnActive) {
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
  // Signed in, but the chat session couldn't be created (e.g. session expired).
  const sessionProblem = signedIn && ensure.isError;

  return (
    <div
      data-testid="lab-assistant-dock"
      className="fixed bottom-5 right-5 z-[60] w-[min(92vw,380px)]"
    >
      <Card className="flex h-[min(70vh,560px)] flex-col overflow-hidden border-white/10 bg-slate-900/95 backdrop-blur-xl">
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
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{renderRichText(m.content)}</p>
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

        {/* Task 201: hands-off toggle — only rendered for admin-whitelisted wallets. */}
        {handsOffEligible && (
          <label
            className="flex cursor-pointer items-center gap-2 border-t border-white/10 px-3 py-2 text-xs text-white/70"
            data-testid="toggle-lab-assistant-handsoff"
          >
            <input
              type="checkbox"
              checked={handsOff}
              onChange={(e) => setHandsOff(e.target.checked)}
              disabled={isAuto || turnActive}
              className="h-3.5 w-3.5 accent-amber-500"
              data-testid="checkbox-lab-assistant-handsoff"
            />
            <span>
              Hands-off mode
              <span className="ml-1 text-white/40">— auto-approve paid steps (caps still apply)</span>
            </span>
          </label>
        )}

        {/* Composer */}
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-3">
          <input
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
            onClick={startAuto}
            disabled={autoStart.isPending || !canChat || turnActive || isAuto}
            title="Auto-run this as a goal — I'll build, backtest and refine, pausing to confirm before any paid AI step."
            data-testid="button-lab-assistant-auto"
            className="shrink-0 gap-1 border border-indigo-400/40 bg-indigo-500/10 px-2.5 text-xs text-indigo-200 hover:bg-indigo-500/20"
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
