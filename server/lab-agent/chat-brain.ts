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

import { z } from "zod";
import { callOpenRouterWithUsage, type LlmMessage, type LlmUsage } from "../ai-assistant/router";
import type { LabAgentToolkitMethod } from "@shared/lab-agent-contract";
import { LAB_AVAILABLE_TICKERS } from "@shared/schema";

// The exact set of tickers the lab can backtest, from the single source of truth in
// shared/schema.ts. Injected into the brain's system prompt every turn so the model
// knows the real universe and never hallucinates that a valid ticker (e.g. HYPE) is
// unavailable. Rendered once at module load; the list is static.
const LAB_BACKTEST_SYMBOLS = LAB_AVAILABLE_TICKERS.map((t) => t.name).join(", ");

/** The "AVAILABLE BACKTEST SYMBOLS" block appended to both system prompts. */
function availableSymbolsBlock(): string {
  return (
    "AVAILABLE BACKTEST SYMBOLS (the ONLY tickers the lab can backtest, use the exact name as written):\n" +
    LAB_BACKTEST_SYMBOLS
  );
}

// Available-ticker names that are also common English words; only count them when the
// user typed them in uppercase (ticker convention), so "near the top" or "that's lit"
// are not mistaken for the NEAR / LIT markets.
const AMBIGUOUS_LOWER_TICKERS = new Set(["near", "lit", "mon", "mega", "pump", "trump"]);

// Available tickers the user named verbatim in a message. Whole-word matches against the
// schema's ticker list; case-insensitive EXCEPT for the ambiguous English-word names
// above, which require an exact uppercase match. Used to tell the brain plainly that a
// named ticker IS backtestable, fixing the first-ask "that's unavailable" refusal.
export function namedAvailableTickers(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const { name } of LAB_AVAILABLE_TICKERS) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = AMBIGUOUS_LOWER_TICKERS.has(name.toLowerCase()) ? "" : "i";
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, flags);
    if (re.test(text)) out.push(name);
  }
  return out;
}

// Strong "these named tickers ARE available" line built from the latest user message,
// or "" when none were named. Appended to BOTH prompt builders.
function namedAvailableTickersLine(
  recent: ReadonlyArray<{ role: string; content: string }>,
): string {
  const lastUser = [...recent].reverse().find((m) => m.role === "user");
  const named = namedAvailableTickers(lastUser?.content ?? "");
  if (named.length === 0) return "";
  return (
    `\n\nThe user just named these tickers, which ARE in the available list above and ARE ` +
    `backtestable here: ${named.join(", ")}. Use them exactly as named; do NOT tell the user ` +
    `they are unavailable.`
  );
}

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
  const base = goal
    ? `${SYSTEM_PROMPT}\n\nThe user's current focus for this conversation: ${goal.slice(0, MAX_GOAL_CHARS)}`
    : SYSTEM_PROMPT;
  const system = `${base}\n\n${availableSymbolsBlock()}${namedAvailableTickersLine(input.recentMessages)}`;

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

// ===========================================================================
// Phase C — turn-loop brain (decideTurnAction)
// ===========================================================================
//
// C0 (above) only TALKS. C1's brain decides, each turn, ONE of three things:
//   - call a working toolkit tool (read a result, queue/refine/cancel a run), or
//   - record a short plan checklist (update_plan), or
//   - finish the turn with a natural-language reply (final).
//
// The orchestrator (server/lab-agent/orchestrator.ts) drives the loop; this
// module only turns context -> a single, validated decision. It is the ONLY place
// the user's key is used for a decision. The decision is STRICT, single-JSON: the
// model authors prose and tool calls, NEVER client chips (those stay deterministic
// in chat-replies.ts, attached by the orchestrator).

// The tools the agent may actually invoke today. This is a strict subset of the
// full contract registry — the still-unimplemented methods (templates) are
// deliberately EXCLUDED so the brain can never pick a tool that returns
// `not_implemented`. The allowlist is enforced by the zod enum below, not by the
// prompt alone. The LLM-backed tools (createStrategyFromText / improve) ARE wired:
// they spend the user's BYO OpenRouter key, so the operating rules below tell the
// brain to exhaust the free deterministic pipeline before reaching for `improve`.
export const WORKING_TOOLS = [
  "listStrategies",
  "findStrategy",
  "getTopResults",
  "getHeatmap",
  "getInsightsReport",
  "generateInsights",
  "getRunStatus",
  "getQueuePosition",
  "createStrategyFromText",
  "runOptimization",
  "refineFrom",
  "improve",
  "cancelRun",
] as const satisfies readonly LabAgentToolkitMethod[];

export type WorkingTool = (typeof WORKING_TOOLS)[number];

/** Async tools that QUEUE a run; the orchestrator pauses the turn until they finish. */
export const ASYNC_TOOLS: ReadonlySet<WorkingTool> = new Set<WorkingTool>([
  "runOptimization",
  "refineFrom",
  "improve",
]);

/**
 * PAID tools — they spend the user's BYO OpenRouter key (the AI drafts/rewrites a
 * strategy). In auto mode (Task #200) these are GATED behind an explicit user
 * confirmation (action:"await_confirm"); free tools (backtests, reads, insights)
 * flow automatically.
 */
export const PAID_TOOLS = ["createStrategyFromText", "improve"] as const satisfies readonly WorkingTool[];
export type PaidTool = (typeof PAID_TOOLS)[number];

// One decision = one of three discriminated actions. `args` for a tool is whatever
// the contract input schema for that tool requires MINUS idempotencyKey (which the
// orchestrator injects deterministically — the model must never author it, so a
// resumed turn re-derives the same key and can't double-enqueue).
export type BrainDecision =
  | { action: "tool"; tool: WorkingTool; args: Record<string, unknown> }
  | { action: "final"; message: string }
  | { action: "update_plan"; plan: string[]; note?: string }
  // Backend-only (Task #200 auto mode): the DETERMINISTIC auto-planner emits this to
  // STOP before a PAID tool and ask the user to approve the spend. The LLM chat brain
  // NEVER emits it — it is deliberately absent from `brainDecisionSchema`, so a model
  // can never trigger a paid step unprompted.
  | { action: "await_confirm"; tool: PaidTool; args: Record<string, unknown>; estCostUsd: number; reason: string };

const toolDecisionSchema = z.object({
  action: z.literal("tool"),
  tool: z.enum(WORKING_TOOLS),
  args: z.record(z.string(), z.unknown()).default({}),
});
const finalDecisionSchema = z.object({
  action: z.literal("final"),
  message: z.string().min(1),
});
const updatePlanDecisionSchema = z.object({
  action: z.literal("update_plan"),
  plan: z.array(z.string().min(1)).min(1).max(12),
  note: z.string().optional(),
});
const brainDecisionSchema = z.discriminatedUnion("action", [
  toolDecisionSchema,
  finalDecisionSchema,
  updatePlanDecisionSchema,
]);

/** Raised when the model's output cannot be parsed into a valid single decision. */
export class MalformedDecisionError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = "MalformedDecisionError";
  }
}

// ===========================================================================
// Task #200 — deterministic auto-pipeline state (persisted in task.memory.auto)
// ===========================================================================

/** Where the deterministic pipeline currently is. */
export type AutoPhase = "create" | "backtest" | "evaluate" | "insights" | "improve" | "done";

/** A paid step parked awaiting the user's spend approval. */
export interface AutoPendingConfirm {
  tool: PaidTool;
  /** Opaque token the confirm/decline route must echo back (set by the orchestrator). */
  token: string;
  estCostUsd: number;
  args: Record<string, unknown>;
}

/**
 * The auto-loop's small typed working state — persisted as `task.memory.auto` (no
 * migration; it rides the existing jsonb column). Owned by the planner: each tick the
 * planner returns the NEXT AutoMemory and the orchestrator persists it verbatim. The
 * orchestrator only sets `pendingConfirm` (it mints the token); the confirm route
 * sets `confirmedToken`.
 */
export interface AutoMemory {
  phase: AutoPhase;
  /** Total planner ticks this task — bounds the pipeline (maxAutoSteps). */
  autoStepCount: number;
  /** Paid `improve` rewrites used so far (cap ~3). */
  improveCount: number;
  /** Backtests this task has queued (max-queued guard, Phase 3). */
  enqueuedBatchCount: number;
  /** The asset basket the pipeline evaluates in one multi-symbol run. */
  symbols: string[];
  pendingConfirm?: AutoPendingConfirm | null;
  confirmedToken?: string | null;
  /**
   * Task 201: the user's hands-off INTENT for this run, captured at /auto/start and
   * only ever set true for an admin-whitelisted wallet. When true, the orchestrator
   * AUTO-APPROVES paid steps (no confirm chip) — but ONLY after it re-checks the live
   * whitelist (fail-closed). A non-whitelisted run leaves this false → watched mode.
   */
  handsOff?: boolean;
  /**
   * SOL-first graduation gate. False/undefined = still PROVING on the primary symbol
   * (symbols[0], normally SOL). Set true once a robust out-of-sample result holds up on
   * the primary and the pipeline has graduated to backtesting the remaining symbols.
   */
  graduated?: boolean;
}

// The auto-pipeline's target basket. SOL is the PROVING symbol (proved first); the rest
// are the GRADUATION set it widens to once SOL holds up out-of-sample (see auto-planner.ts
// + docs/LAB_AGENT_SANDBOX_PLAN.md §6b). ⚠️ ETH/ARB are PLACEHOLDER graduation tickers —
// swap them here for better candidates whenever we pick them; keep SOL first as the prover.
export const DEFAULT_AUTO_SYMBOLS = ["SOL", "ETH", "ARB"];

/** The zero-value AutoMemory for a fresh auto task. */
export function defaultAutoMemory(): AutoMemory {
  return {
    phase: "create",
    autoStepCount: 0,
    improveCount: 0,
    enqueuedBatchCount: 0,
    symbols: [...DEFAULT_AUTO_SYMBOLS],
    pendingConfirm: null,
    confirmedToken: null,
    handsOff: false,
    graduated: false,
  };
}

/**
 * Everything the PURE auto-planner needs each tick. The orchestrator assembles it
 * from the persisted memory + live task fields. Present on BrainTurnContext only for
 * auto-mode tasks.
 */
export interface AutoTurnContext {
  memory: AutoMemory;
  goal: string | null;
  currentStrategyId: number | null;
  lastFinishedRunId: number | null;
  /** Structured result of the most recent SYNC tool, so the planner can branch on
   *  robustness without parsing transcript text. */
  lastToolResult?: { tool: string; data: unknown } | null;
  /** Spend accounting for the pre-paid 90% guard. */
  spendSoFarUsd: number;
  hardSpendCapUsd: number;
}

// Context the orchestrator hands the brain each iteration. Carries NO key (the job
// wires the key into the BrainFn closure) so the orchestrator stays key-agnostic.
export interface BrainTurnContext {
  goal: string | null;
  recentMessages: { role: "user" | "agent" | "tool"; content: string }[];
  // Compact, orchestrator-rendered working memory (current strategy, recent tool
  // results, plan) — already bounded so the brain prompt stays small/cheap.
  memoryDigest?: string;
  // Present only for auto-mode tasks — drives the deterministic auto-planner.
  auto?: AutoTurnContext;
}

export interface BrainTurnResult {
  decision: BrainDecision;
  usage?: LlmUsage;
  model: string;
  // The planner's NEXT persisted auto state (auto mode only). The orchestrator writes
  // it into task.memory.auto. Undefined for the LLM chat brain.
  auto?: AutoMemory;
}

/** The brain seam the orchestrator depends on. The job binds the key + model. */
export type BrainFn = (ctx: BrainTurnContext) => Promise<BrainTurnResult>;

const DECIDE_MAX_TOKENS = 900; // a single JSON decision is small; bounds spend/latency
const DECIDE_TIMEOUT_MS = 30_000; // a decision turn may reason briefly; stays under proxy reap
const DECIDE_TEMPERATURE = 0.1; // near-deterministic: we want a clean, parseable action

// The decision contract + §6 operating rules, baked into the system prompt. The
// rules mirror docs/LAB_AGENT_SANDBOX_PLAN.md §6 and the contract DTO comments.
const DECIDE_SYSTEM_PROMPT = [
  "You are the QuantumLab Lab Assistant operating as an autonomous turn agent inside a",
  "Solana perpetual-futures bot-trading platform's backtesting lab.",
  "",
  "WHO YOU ARE: you are NOT a passive guide that just points the user at tabs. You",
  "DIRECTLY operate the lab on the user's behalf with the tools below — you draft new",
  "strategies from a plain-English idea, queue and run backtests and optimizations across",
  "assets, refine around a run's best params, read and robustness-rank results, generate",
  "insights, check run status, improve a weak strategy, and cancel runs. These are things",
  "you DO NOW, not later. NEVER tell the user a capability is 'coming soon' or 'in a later",
  "phase', and NEVER say they have to do it themselves in the Creator or Backtest tab — if",
  "they ask for something you have a tool for, DO it (or take the first step toward it).",
  "",
  "Each turn you output EXACTLY ONE JSON object and NOTHING else — no prose, no markdown,",
  "no code fences.",
  "",
  "The JSON must be one of these three shapes:",
  '1. {"action":"tool","tool":"<toolName>","args":{...}} — call one toolkit tool.',
  '2. {"action":"update_plan","plan":["step 1","step 2"],"note":"optional"} — record a short checklist.',
  '3. {"action":"final","message":"<your reply to the user>"} — finish the turn and reply.',
  "",
  "Available tools and their args (call NOTHING else):",
  '- listStrategies {} — the user\'s strategies.',
  '- findStrategy {"query":"name"} — fuzzy-find a strategy by name.',
  '- getTopResults {"strategyId":N,"limit":N?,"timeframe":"4h"?,"ticker":"HYPE"?} — ROBUSTNESS-ranked backtest results (rank 1 = most robust). Pass timeframe and/or ticker to get the best result for EXACTLY that combo (use this whenever the user asks about a specific timeframe or asset so the freshest matching result is returned). Each carries a resultId you can pass to refineFrom to quick-hone THAT exact result.',
  '- getHeatmap {"strategyId":N} — ticker×timeframe grid of avg Sharpe across the strategy\'s runs.',
  '- getInsightsReport {"strategyId":N} — the latest saved insights report, if any.',
  '- generateInsights {"strategyId":N} — compute FRESH insights (which params drive profit + a robustness read) from existing results. Free, no key.',
  '- getRunStatus {"runId":N} — status/progress of a run.',
  '- getQueuePosition {} — jobs ahead + whether you already hold an active run.',
  '- createStrategyFromText {"prompt":"plain-English strategy idea","name":"optional"} — the AI DRAFTS a new Pine strategy from a description. Spends the user\'s key. Returns the new strategyId; backtest it next.',
  '- runOptimization {"strategyId":N,"symbols":["SOL","ETH"],"timeframes":["1h","4h"],"stages":["random","refine","deep"]?,"outOfSampleFraction":0.2?} — QUEUE a backtest/optimization (async).',
  '- refineFrom {"resultId":N} — QUICK targeted hone of ONE specific result (the resultId from getTopResults): re-seeds that result\'s EXACT saved params and coordinate-tunes with deep search OFF. Repeatable — refine, read the new top result, refine again; stop after ~3 if it stops improving. Or refineFrom {"runId":N} for the heavier whole-run refine (deep search on). Provide EXACTLY ONE of resultId or runId. (async)',
  '- improve {"strategyId":N,"insightsOrWeaknesses":"what to fix"} — the AI rewrites the strategy\'s LOGIC from its weaknesses into a NEW strategy and QUEUES a fresh backtest for it (async). Spends the user\'s key; requires existing results.',
  '- cancelRun {"runId":N} — cancel a queued/running run.',
  "",
  "Do NOT include an idempotencyKey — the system adds it. Do NOT invent strategy ids,",
  "run ids, or numbers: discover them with listStrategies / findStrategy / getTopResults first.",
  "",
  "Operating rules (§6):",
  "- You can backtest ONLY the tickers in the AVAILABLE BACKTEST SYMBOLS list below, using the",
  "  exact name as written. That list is the source of truth: if a ticker is in it, it IS",
  "  available, so NEVER tell the user it is unavailable or unsupported. Only if a requested",
  "  ticker is genuinely absent from the list do you say so plainly, then name the closest",
  "  tickers that ARE in the list. Never guess or assume which tickers exist.",
  "- When the user names specific ticker(s) to backtest, use EXACTLY those. A single named",
  "  ticker is fine; honor the request. Only when the user names NONE do you pick a few liquid",
  "  majors for breadth, since robustness across assets beats a single spike.",
  "- If the user asks to backtest EVERY ticker, or a long list of many tickers at once (more",
  "  than about 6 to 8), do NOT queue them all in one run. There is a single shared backtest",
  "  worker, so a giant matrix would take a very long time. Briefly say so, then propose a",
  "  sensible SUBSET (a handful of liquid majors, or a few representative names that fit what",
  "  they asked for) on their preferred timeframe(s), run THAT, and offer to queue more",
  "  afterward if they want. Do NOT split the request into many jobs yourself; run one",
  "  reasonable batch and let the user ask for more.",
  "- Use 1H timeframes or higher; sub-hour bars overfit and waste data budget.",
  "- Exhaust the cheap deterministic pipeline (random -> refine -> deep) before suggesting any paid improve.",
  "- RANK and recommend by ROBUSTNESS, not headline profit: a result validated out-of-sample with steady Sharpe/drawdown beats a bigger in-sample return. getTopResults is already robustness-ranked.",
  "- KEEP a result only if it holds up out-of-sample (oos sufficient AND its Sharpe doesn't collapse vs in-sample); otherwise treat it as a curve-fit to KILL or re-test, never as a win.",
  "- A result with NO out-of-sample (oos:null) is UNVALIDATED, not good — say so; never present it as proven.",
  "- Never fabricate PnL, win rate, or parameter values you were not given by a tool.",
  "- After you queue a run you will be resumed when it finishes; read its results then.",
  "- When you have answered the user or have nothing left to do, use action:final.",
  "- If the user asks what you can do, who you are, how you work, or poses a hypothetical",
  "  that needs no lookup, do NOT call a tool — answer DIRECTLY with",
  '  {"action":"final","message":"..."} that describes your real, current abilities',
  "  (drafting, backtesting across assets, refining, robustness-ranking results, insights,",
  "  improving) in plain, confident language, and offer to actually do one of them next.",
  "- SCOPE, be honest about limits: your tools work ONLY inside this backtesting lab",
  "  (drafting, backtesting, refining, robustness-ranking, insights, run status for the",
  "  user's lab strategies). You CANNOT see a live or deployed bot's real trades or PnL,",
  "  you CANNOT read or change the user's TradingView account or its alert limits, and you",
  "  do NOT operate the live trading dashboard. If the user asks about any of those, say so",
  "  plainly in one sentence (do not pretend, do not deflect to a menu), then offer what",
  "  you CAN do, such as backtesting or stress-testing that strategy here before they rely",
  "  on it live.",
  '- After a tool returns data, your NEXT output MUST be a {"action":"final","message":"..."}',
  "  JSON object that answers the user directly in plain language — name the strategy,",
  "  numbers, or finding you read. Do NOT reply as bare prose; the JSON envelope is required.",
  "- When you report a backtest RESULT, format it as clean SEPARATE LINES (the chat keeps",
  "  line breaks and renders **bold**), never one long comma-separated sentence. Lead with",
  "  the ticker + timeframe, then one metric per line. ALWAYS include the number of trades",
  "  and a leverage line. Use this exact shape, filling in the real numbers:",
  "    **<TICKER> <timeframe>** (rank <n>)",
  "    **Net:** +<net>%  (about +<leveraged>% at <lev>x suggested leverage)",
  "    **Win rate:** <win>%   **Trades:** <trades>",
  "    **Max drawdown:** <dd>%   **Sharpe:** <sharpe>",
  "    **Out of sample:** <oos net / win / Sharpe, or 'none, so unvalidated'>",
  "  For the leverage line use the tool's suggestedLeverage and leveragedNetProfitPercent",
  "  fields (leverage is sized from the result's max drawdown); never invent them, and omit",
  "  that line only if those fields are missing. Use plain punctuation, no em dashes.",
  "- If the user asked about SPECIFIC timeframe(s) or asset(s), report the best result FOR",
  "  EACH one they asked about by reading the timeframe and ticker fields, even if a",
  "  different combo is the global rank 1. Call getTopResults with the timeframe (and ticker)",
  "  filter set to each requested combo so the freshest matching result is returned, and",
  "  NEVER substitute an older run's result for the one they just asked you to test.",
].join("\n");

// Extract the first balanced top-level JSON object from a model response. Models
// sometimes wrap JSON in prose or ``` fences even when told not to; this scans for
// the first '{' and brace-matches (string-aware) to its close. Returns null when
// no balanced object is found.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse a raw model response into a validated BrainDecision (exported for tests). */
export function parseBrainDecision(raw: string): BrainDecision {
  const json = extractFirstJsonObject(raw ?? "");
  if (!json) {
    throw new MalformedDecisionError("No JSON object found in the model response.", raw);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new MalformedDecisionError("The model response was not valid JSON.", raw);
  }
  const parsed = brainDecisionSchema.safeParse(obj);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".");
    throw new MalformedDecisionError(
      `Decision failed validation${where ? ` at ${where}` : ""}: ${issue?.message ?? "unknown shape"}.`,
      raw,
    );
  }
  return parsed.data;
}

// Salvage bounds for a prose-as-final fallback (see coerceProseToFinal).
const MIN_PROSE_FINAL_CHARS = 16;
const MAX_PROSE_FINAL_CHARS = 2000;

// Did a tool actually run THIS turn? True when at least one role:"tool" message
// follows the most-recent user turn in the bounded transcript. Gates the prose
// salvage so it only ever rescues a post-tool answer, never a fresh no-tool turn.
function toolRanThisTurn(
  recentMessages: { role: "user" | "agent" | "tool"; content: string }[],
): boolean {
  let lastUser = -1;
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    if (recentMessages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return false;
  for (let i = lastUser + 1; i < recentMessages.length; i++) {
    if (recentMessages[i].role === "tool") return true;
  }
  return false;
}

/**
 * Rescue a post-tool answer the model wrote as plain prose instead of the required
 * {"action":"final",...} envelope. Without this, that prose fails parseBrainDecision,
 * burns the malformed-retry budget, and degrades to a CANNED reply — throwing away the
 * tool data the model just gathered (the "it ran the tools but gave a useless answer"
 * bug). Deliberately conservative: only fires when a tool ran this turn AND the output
 * is clean natural-language prose — never half-JSON, code fences, or reasoning/thinking
 * markers (so we never surface a broken decision or chain-of-thought to the user).
 * Exported for unit testing.
 */
export function coerceProseToFinal(
  raw: string,
  recentMessages: { role: "user" | "agent" | "tool"; content: string }[],
  opts?: { requireToolRan?: boolean },
): { action: "final"; message: string } | null {
  // By default only a POST-TOOL prose answer is rescued (the in-loop decideTurnAction
  // path). The orchestrator's LAST-RESORT chat salvage passes requireToolRan:false to
  // also rescue a clean no-tool conversational answer once the model has burned its
  // retry budget writing prose instead of the JSON envelope (gated upstream by
  // isSafeDirectAnswerTurn so a data/action ask can never surface fabricated prose).
  const requireToolRan = opts?.requireToolRan ?? true;
  if (requireToolRan && !toolRanThisTurn(recentMessages)) return null;
  const text = (raw ?? "").trim();
  if (text.length < MIN_PROSE_FINAL_CHARS) return null;
  // Reject anything that isn't clean prose: brace/bracket fragments (a half or broken
  // object/array decision), code fences, or model reasoning/thinking markers — either as
  // XML-like tags or as plain "Reasoning:"/"Thinking -" line prefixes.
  if (/[{}[\]]/.test(text)) return null;
  if (text.includes("```")) return null;
  if (/<\s*\/?\s*(think|thinking|reason|reasoning|scratchpad)\b/i.test(text)) return null;
  if (/^\s*(thinking|reasoning|scratchpad|thought)\b\s*[:\-—]/im.test(text)) return null;
  const message = text.slice(0, MAX_PROSE_FINAL_CHARS).trim();
  if (message.length < MIN_PROSE_FINAL_CHARS) return null;
  return { action: "final", message };
}

/**
 * Is this user turn one we can safely answer DIRECTLY from the model's own prose if it
 * fails to emit the JSON envelope? True for conversational / scope / how-it-works /
 * capability questions. FALSE for any in-scope lab DATA or metric ask (best result, PnL,
 * win rate, drawdown, rankings, "my results") and for clear lab ACTION asks (backtest,
 * optimize, refine, improve, cancel, "draft me a strategy") because those must go through
 * a tool, so salvaging prose there risks a fabricated number or a falsely claimed action.
 * Used ONLY for the orchestrator's last-resort salvage. Exported for unit testing.
 */
export function isSafeDirectAnswerTurn(userText: string): boolean {
  const t = (userText ?? "").trim();
  if (!t) return false;
  // In-scope lab DATA / metrics / rankings / performance a tool should supply (a
  // salvaged prose answer here could fabricate a number).
  if (
    /\b(pnl|p&l|win[\s-]?rate|draw\s?down|sharpe|profit|returns?|equity|perform\w*|best result|top results?|leaderboard|ranked|ranking|my (results?|runs?|backtests?|numbers?|stats?))\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\b(best|top)\s+(runs?|results?|configs?|strateg\w*)\b/i.test(t)) return false;
  if (/\bwhich\b[^.?!]*\bbest\b/i.test(t)) return false;
  // Clear lab ACTIONS the model should perform via a tool, not describe in prose.
  if (/\b(backtest|back-test|optimi[sz]e|optimi[sz]ation|refine|improve|cancel)\b/i.test(t)) {
    return false;
  }
  // A request to make a NEW strategy ("draft me a momentum bot", "can you create a Pine
  // bot?") must call the create tool, not salvage prose, even when phrased politely as a
  // question. Allow ONLY a genuine how/why/what-is explanation of the mechanism
  // ("how does it create strategies under the hood?").
  const explanatory =
    /\b(how|why|under the hood|explain)\b/i.test(t) || /\bwhat (is|are|does|do)\b/i.test(t);
  if (
    !explanatory &&
    /\b(draft|create|build|make|generate|write)\b[^.?!]*\b(strateg\w*|bots?|scripts?|pine)\b/i.test(t)
  ) {
    return false;
  }
  return true;
}

/**
 * Make ONE turn decision on the user's key. Throws MalformedDecisionError when the
 * model's output can't be parsed/validated (the orchestrator retries within a
 * bounded repair budget, then degrades). Throws LlmGatewayError on transport
 * failures. Never throws a raw provider error.
 */
export async function decideTurnAction(
  input: BrainTurnContext & { apiKey: string; model?: string },
): Promise<BrainTurnResult> {
  const model = input.model || DEFAULT_CHAT_MODEL;
  const messages = buildDecisionMessages(input);
  const { content, usage } = await callOpenRouterWithUsage({
    apiKey: input.apiKey,
    model,
    messages,
    maxTokens: DECIDE_MAX_TOKENS,
    temperature: DECIDE_TEMPERATURE,
    timeoutMs: DECIDE_TIMEOUT_MS,
  });
  let decision: BrainDecision;
  try {
    decision = parseBrainDecision(content);
  } catch (err) {
    // The model wrote a post-tool answer as plain prose instead of the JSON envelope.
    // Salvage it (gated on a tool having run this turn) rather than degrade to a canned
    // reply that discards the data it just gathered. Usage is still billed (the call
    // happened) — we only reinterpret the SAME response.
    if (err instanceof MalformedDecisionError) {
      const salvaged = coerceProseToFinal(content, input.recentMessages);
      if (salvaged) return { decision: salvaged, usage, model };
    }
    throw err;
  }
  return { decision, usage, model };
}

// Assemble the decision prompt: system contract+rules, optional goal + memory
// digest, then the bounded recent transcript (same bounding as the chat path).
// Exported for unit testing.
export function buildDecisionMessages(input: BrainTurnContext): LlmMessage[] {
  const goal = (input.goal ?? "").trim();
  const digest = (input.memoryDigest ?? "").trim();
  let system = DECIDE_SYSTEM_PROMPT;
  system += `\n\n${availableSymbolsBlock()}`;
  system += namedAvailableTickersLine(input.recentMessages);
  if (goal) system += `\n\nThe user's stated goal: ${goal.slice(0, MAX_GOAL_CHARS)}`;
  if (digest) system += `\n\nWorking memory so far:\n${digest.slice(0, MAX_CONTEXT_CHARS)}`;

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
