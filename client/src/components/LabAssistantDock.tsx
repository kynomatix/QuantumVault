// QuantumLab Lab Assistant — Phase B chat dock.
//
// A collapsed Sparkles button (bottom-right) expands into a persisted chat panel.
// Phase B is a conversational SHELL: messages persist server-side and the
// assistant offers clickable option bubbles, but there is NO LLM and NO toolkit
// call yet (that's Phase C/D). Replies come back synchronously from the server,
// so there is no polling. All authenticated reads go through apiRequest, which
// stamps the x-wallet-address header so a stale session fails closed.

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Sparkles, Send, X, Bot, Loader2, Wallet } from "lucide-react";
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

interface MessagesResponse {
  messages: ChatMessage[];
}

const messagesKey = (taskId: number | null, wallet: string | null) =>
  ["lab-assistant-messages", taskId, wallet] as const;

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
  // Stale-session reconnect (re-sign): busy flag + last error for the button.
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
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
  });

  const send = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/lab/agent/chat/${taskId}/messages`, { content });
      return (await res.json()) as MessagesResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: messagesKey(taskId, walletAddress) });
    },
  });

  const messages = messagesQuery.data?.messages ?? [];
  const signedIn = !!walletAddress && sessionConnected;
  const canChat = signedIn && taskId !== null;

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, open, send.isPending]);

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
    } finally {
      setReconnectBusy(false);
    }
  }

  function submitDraft() {
    const content = draft.trim();
    if (!content || !canChat || send.isPending) return;
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

  function handleAction(action: AgentSuggestedAction) {
    // Navigation never needs a session; "send" chips do.
    if (action.kind === "navigate" && action.tab) {
      onNavigate(action.tab);
    } else if (action.kind === "send" && action.message && canChat && !send.isPending) {
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
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{m.content}</p>
                </div>
              </div>
            );
          })}

          {send.isPending && (
            <div className="flex justify-start" data-testid="lab-assistant-sending">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-white/[0.06] px-3 py-2 text-xs text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
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
                disabled={send.isPending || (a.kind === "send" && !canChat)}
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
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (notice) setNotice(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder={
              canChat
                ? "Ask the assistant…"
                : signedIn
                  ? "Starting chat…"
                  : walletAddress
                    ? "Finish signing in to chat"
                    : "Connect your wallet to chat"
            }
            maxLength={4000}
            disabled={!canChat}
            data-testid="input-lab-assistant"
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-indigo-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            type="button"
            size="icon"
            onClick={submitDraft}
            disabled={!draft.trim() || send.isPending || !canChat}
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
