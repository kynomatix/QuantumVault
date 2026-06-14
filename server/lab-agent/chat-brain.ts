// QuantumLab Sandbox Agent — Phase C0 conversational brain.
//
// C0 makes the Lab Assistant ACTUALLY talk: it turns the user's message plus a
// small, bounded context (the task goal and recent transcript) into a natural-
// language reply using the user's OWN OpenRouter key. It does NOT call tools, run
// backtests, draft strategies, or trade — that is C1 (the tool-driving loop).
//
// Kept in its own module (no Express, no DB, no key storage) so the prompt logic
// is unit-testable in isolation and so C1 can swap generateLabChatReply() for a
// turn runner without touching the HTTP/client shapes (a clean seam).
//
// SECURITY: the plaintext key is passed in by the route (decrypted transiently),
// used for the single call, and never logged or persisted here.

import { callOpenRouterWithUsage, type LlmMessage, type LlmUsage } from "../ai-assistant/router";

// Default chat model: "cheapest capable" per docs/LAB_AGENT_SANDBOX_PLAN.md §5.
// DeepSeek V4 Pro is the catalog's value/capability pick; an override may pass a
// different selectable model (validated in the route, not here).
export const DEFAULT_CHAT_MODEL = "deepseek/deepseek-v4-pro";

// Bounded context (§5/§7): keep the prompt small so the turn stays fast and cheap.
const MAX_CONTEXT_MESSAGES = 10; // most-recent turns included as chat history
const MAX_CONTEXT_CHARS = 6000; // hard ceiling on assembled transcript text
const MAX_GOAL_CHARS = 600;
const CHAT_MAX_TOKENS = 700; // short conversational answers; bounds spend + latency
const CHAT_TIMEOUT_MS = 18_000; // stay well inside the ~60s proxy-reap window
const CHAT_TEMPERATURE = 0.4;

const SYSTEM_PROMPT = [
  "You are the QuantumLab Lab Assistant, a friendly guide inside QuantumLab — the backtesting",
  "and strategy-optimization lab of a Solana perpetual-futures bot-trading platform.",
  "",
  "What you do RIGHT NOW: you TALK and GUIDE only. You explain how the lab works, help the user",
  "reason about strategies, backtests, results, and why a strategy wins or loses, and you point",
  "them to the right tab (Creator, Backtest Setup, Results, Heatmap, Insights).",
  "",
  "Hard limits — be honest about these, never pretend otherwise:",
  "- You CANNOT yet run backtests, draft or edit strategies, place trades, or change anything in",
  "  the app. The user does those in the lab today; you will be able to do them directly later.",
  "- Never invent specific numbers (PnL, win rate, parameter values) you were not given. If you",
  "  don't have the data, say so and tell the user where in the lab they can see it.",
  "- Never ask the user to paste an API key into the chat. Keys are added securely in the Creator.",
  "- This is not financial advice; the user is responsible for their own trading decisions.",
  "",
  "Style: concise, plain everyday language, encouraging. A few sentences is usually enough.",
  "Avoid markdown headings and code fences unless the user explicitly asks for code.",
].join("\n");

export interface ChatBrainInput {
  // The task's free-text focus/goal, if set. Used as light steering context.
  goal?: string | null;
  // Recent transcript in chronological order, ENDING with the user's newest turn
  // (the route persists the user message before calling the brain).
  recentMessages: { role: "user" | "agent" | "tool"; content: string }[];
  apiKey: string;
  model?: string;
}

export interface ChatBrainResult {
  content: string;
  usage?: LlmUsage;
  model: string;
}

// Map stored transcript roles to OpenRouter roles. "tool" turns (none in C0) fold
// into assistant context so the history stays coherent.
function toLlmRole(role: "user" | "agent" | "tool"): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

// Assemble the LLM message list: a system prompt (plus optional goal steering) and
// the most-recent transcript turns under both a count and a char budget. Selection
// runs newest-first (so the user's latest question is always kept) and is then
// restored to chronological order. Exported for unit testing.
export function buildChatMessages(input: ChatBrainInput): LlmMessage[] {
  const goal = (input.goal ?? "").trim();
  const system = goal
    ? `${SYSTEM_PROMPT}\n\nThe user's current focus for this conversation: ${goal.slice(0, MAX_GOAL_CHARS)}`
    : SYSTEM_PROMPT;

  const history = input.recentMessages
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-MAX_CONTEXT_MESSAGES);

  const picked: LlmMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i].content.trim();
    if (used + text.length > MAX_CONTEXT_CHARS && picked.length > 0) break;
    used += text.length;
    picked.push({ role: toLlmRole(history[i].role), content: text });
  }
  picked.reverse();

  return [{ role: "system", content: system }, ...picked];
}

// Generate one conversational reply. Throws LlmGatewayError on any failure; the
// route catches it and falls back to the deterministic composeAgentReply shell (§7c).
export async function generateLabChatReply(input: ChatBrainInput): Promise<ChatBrainResult> {
  const model = input.model || DEFAULT_CHAT_MODEL;
  const messages = buildChatMessages(input);
  const { content, usage } = await callOpenRouterWithUsage({
    apiKey: input.apiKey,
    model,
    messages,
    maxTokens: CHAT_MAX_TOKENS,
    temperature: CHAT_TEMPERATURE,
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  return { content: content.trim(), usage, model };
}
