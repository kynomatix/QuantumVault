// AI Trader — Reflection-Playbook service (reflection-playbook-spec.md Phase A).
//
// INJECTION NOT YET ACTIVE. Lessons accumulate and are readable in the drawer
// immediately. Injection into the context-builder briefing is gated behind two
// preconditions that have not yet been met:
//
//   1. Calibration precondition — confidence-calibration win-rate by bucket
//      must show a statistically meaningful sample (≥10 trades in at least
//      3 buckets) before the playbook's influence on model confidence is
//      measurable. Surface: Track Record → Confidence Calibration panel.
//
//   2. Structure-bricks keep-gate review — the injection PR must be read
//      against the current context-builder.ts to confirm system-prompt block
//      size and lesson-text invariants (plain text, length-capped at Zod
//      boundary) before live injection proceeds.
//
// Until both gates are cleared, context-builder.ts MUST NOT be modified by
// this module. The accumulate-only phase is deliberate: "claim what is in the
// docs, announce learning after 2 weeks".
//
// Curation rules (enforced via prompt instructions; verified by tests):
//   • Every lesson is phrased as a TENDENCY WITH SAMPLE SIZE.
//   • Failure lessons retired ONLY by contrary evidence, never for win lessons.
//   • Win lessons retire weakest-first at the 12-entry cap.
//   • Malformed output after one corrective retry → keep old playbook unchanged.
//   • No key → skip silently (fail-open, never blocks close-out).

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fromZodError } from "zod-validation-error";
import {
  callOpenRouterWithUsage,
  LlmGatewayError,
  type LlmMessage,
} from "../ai-assistant/router";
import { storage } from "../storage";
import {
  getSessionByWalletAddress,
  restoreWalletSecurityFromStorage,
  decryptLlmApiKeyV3,
} from "../session-v3";
import type { AiTraderBot } from "@shared/schema";

// --- Zod contract for update_playbook tool ------------------------------------

export const playbookEntrySchema = z.object({
  lesson: z
    .string()
    .max(200)
    .describe(
      'Tendency with sample size, e.g. "range longs 1-for-4 in chop". Max 200 chars. Plain text only.'
    ),
  regime: z
    .enum(["trending", "ranging", "transitional", "any"])
    .describe("Market regime this lesson applies to."),
  evidence: z
    .string()
    .max(40)
    .describe('Compact evidence string, e.g. "3 of 4" or "2 wins, 5 losses". Max 40 chars.'),
});

export type PlaybookEntry = z.infer<typeof playbookEntrySchema>;

export const updatePlaybookSchema = z.object({
  entries: z
    .array(playbookEntrySchema)
    .max(12)
    .describe("Full replacement of the playbook (maximum 12 entries)."),
});

export type UpdatePlaybook = z.infer<typeof updatePlaybookSchema>;

// JSON Schema for the tool definition — generated from the same zod schema
// ($refStrategy:'none' inlines all refs; draft-07 $schema stripped per
// OpenAI-shape parameters convention — same pattern as decide.ts).
const generated = zodToJsonSchema(updatePlaybookSchema, {
  $refStrategy: "none",
  target: "jsonSchema7",
}) as Record<string, unknown>;
delete generated.$schema;

const UPDATE_PLAYBOOK_TOOL = {
  type: "function",
  function: {
    name: "update_playbook",
    description:
      "Submit the revised playbook after reflecting on this trade. Call this exactly once.",
    parameters: generated,
  },
} as const;

const REFLECTION_MODEL = "deepseek/deepseek-v4-flash";
const REFLECTION_TIMEOUT_MS = 45_000;

// --- In-flight guard: one reflection per bot at a time -----------------------

const inFlight = new Set<string>();

// --- Key resolution: BYO key only, no free trial ----------------------------
// Mirrors the analyze path but simpler: no HTTP response object needed since
// this runs async after close-out. Skip silently on any failure.

async function resolveKeyForReflection(
  walletAddress: string
): Promise<{ apiKey: string; cleanup: () => void } | null> {
  try {
    const ciphertext = await storage.getWalletLlmApiKeyCiphertext(walletAddress);
    if (!ciphertext) return null;

    // Try in-memory session UMK first; restore from storage-backed copy if absent.
    if (!getSessionByWalletAddress(walletAddress)?.session?.umk) {
      await restoreWalletSecurityFromStorage(walletAddress).catch(() => {});
    }
    const umk = getSessionByWalletAddress(walletAddress)?.session?.umk ?? null;
    if (!umk) return null;

    const keyBuf = decryptLlmApiKeyV3(umk, ciphertext, walletAddress);
    const apiKey = keyBuf.toString("utf8");
    return { apiKey, cleanup: () => keyBuf.fill(0) };
  } catch {
    return null;
  }
}

// --- Prompt -------------------------------------------------------------------

function buildReflectionMessages(
  bot: AiTraderBot,
  closedDecision: {
    rawDecision: unknown;
    clampedDecision: unknown;
    realizedPnl: string | null;
    contextDigest: unknown;
  }
): LlmMessage[] {
  const raw = closedDecision.rawDecision as Record<string, unknown> | null;
  const clamped = closedDecision.clampedDecision as Record<string, unknown> | null;
  const digest = closedDecision.contextDigest as Record<string, unknown> | null;

  const action = String(clamped?.action ?? raw?.action ?? "unknown");
  const rationale = String(raw?.rationale ?? clamped?.rationale ?? "");
  const invalidation = String(raw?.invalidation ?? clamped?.invalidation ?? "");
  const exitReason = String(clamped?.exitReason ?? raw?.exitReason ?? "unknown");
  const pnl = closedDecision.realizedPnl ?? "0";

  const dowStructure = digest?.dowStructure;
  const participation = digest?.participation;
  const cotSignal = digest?.cotSignal;
  const sessionCtx = digest?.sessionContext;

  const currentPlaybook = bot.playbook as PlaybookEntry[] | null;
  const playbookSection =
    currentPlaybook && currentPlaybook.length > 0
      ? `Current playbook (${currentPlaybook.length} entr${currentPlaybook.length === 1 ? "y" : "ies"}):\n` +
        currentPlaybook
          .map((e, i) => `${i + 1}. [${e.regime}] ${e.lesson} | evidence: ${e.evidence}`)
          .join("\n")
      : "Current playbook: empty (first lesson may be added if the trade is clearly instructive)";

  const system: LlmMessage = {
    role: "system",
    content: `You are the reflection module for an AI trading bot. Review this closed trade against the original decision rationale, then update the bot's playbook — a compact set of durable lessons it will carry into future decisions.

CURATION RULES (binding):
1. Every lesson MUST be phrased as a TENDENCY WITH SAMPLE SIZE ("range longs 1-for-4 in chop"). Never a certainty. Never a rule. Plain text only.
2. FAILURE lessons are highest-value entries. They may ONLY be retired when contrary evidence accumulates (the counter moving against them). Never remove a failure lesson to make room for a win lesson.
3. WIN lessons retire weakest-first (lowest evidence count) when at the 12-entry cap.
4. Update evidence counters on existing lessons when this trade bears on them.
5. Add a lesson ONLY when the trade reveals a durable, regime-specific pattern — not noise.
6. The output replaces the full playbook. Omit any lesson that has lost its entire evidence base.
7. Plain text only in lesson and evidence fields. No markdown, no special characters.

Call update_playbook exactly once with the revised playbook (maximum 12 entries).`,
  };

  const user: LlmMessage = {
    role: "user",
    content: `## Closed trade
Market: ${bot.market} | Side: ${action} | Outcome: ${exitReason} | Realized PnL: $${pnl}

## Original decision rationale
${rationale || "(none recorded)"}

## Invalidation written at entry
${invalidation || "(none recorded)"}

## Market context at entry
Session: ${JSON.stringify(sessionCtx ?? {})}
Dow structure: ${JSON.stringify(dowStructure ?? {})}
Participation/OI: ${JSON.stringify(participation ?? {})}
COT signal: ${JSON.stringify(cotSignal ?? {})}

## ${playbookSection}

Review this trade. Update evidence on any existing lessons it touches. Add a new lesson only if this trade clearly reveals a durable pattern. Follow the curation rules above.`,
  };

  return [system, user];
}

// --- Parse tool-call response ------------------------------------------------

type ParsedUpdate =
  | { ok: true; entries: PlaybookEntry[] }
  | { ok: false; detail: string; raw: string };

function parseUpdatePlaybookResponse(res: {
  content: string;
  toolCalls?: { name: string; arguments: string }[];
}): ParsedUpdate {
  const call = res.toolCalls?.[0];
  if (!call) {
    return {
      ok: false,
      detail: "no `update_playbook` tool call returned (model answered in prose)",
      raw: (res.content ?? "").slice(0, 2000),
    };
  }
  if (call.name !== "update_playbook") {
    return {
      ok: false,
      detail: `tool call named '${call.name}', expected 'update_playbook'`,
      raw: call.arguments.slice(0, 4000),
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return {
      ok: false,
      detail: "tool arguments were not valid JSON",
      raw: call.arguments.slice(0, 4000),
    };
  }
  const result = updatePlaybookSchema.safeParse(args);
  if (!result.success) {
    return {
      ok: false,
      detail: fromZodError(result.error).message,
      raw: call.arguments.slice(0, 4000),
    };
  }
  return { ok: true, entries: result.data.entries };
}

// --- Core LLM call (exported for testing) ------------------------------------

export type ReflectionLlmResult =
  | { ok: true; entries: PlaybookEntry[] }
  | { ok: false; reason: "malformed" | "gateway"; detail?: string };

export async function callReflectionLlm(
  apiKey: string,
  bot: AiTraderBot,
  closedDecision: {
    rawDecision: unknown;
    clampedDecision: unknown;
    realizedPnl: string | null;
    contextDigest: unknown;
  }
): Promise<ReflectionLlmResult> {
  const messages = buildReflectionMessages(bot, closedDecision);

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<typeof callOpenRouterWithUsage>>;
    try {
      res = await callOpenRouterWithUsage({
        apiKey,
        model: REFLECTION_MODEL,
        messages,
        temperature: 0.1,
        timeoutMs: REFLECTION_TIMEOUT_MS,
        tools: [UPDATE_PLAYBOOK_TOOL],
        toolChoice: "required" as const,
        requireParameters: true,
      });
    } catch (err) {
      const detail = err instanceof LlmGatewayError ? err.message : String(err);
      return { ok: false, reason: "gateway", detail };
    }

    const parsed = parseUpdatePlaybookResponse(res);
    if (parsed.ok) return { ok: true, entries: parsed.entries };

    if (attempt === 0) {
      // Tier-0.5 corrective retry: show model its own output + the exact
      // validation error, then force the tool call again.
      messages.push(
        {
          role: "assistant",
          content:
            parsed.raw.length > 0
              ? parsed.raw
              : "(no update_playbook tool call was returned)",
        },
        {
          role: "user",
          content: `Your response failed validation: ${parsed.detail}. Call update_playbook again with corrected arguments.`,
        }
      );
    }
  }

  // Both attempts failed → caller keeps old playbook unchanged.
  return { ok: false, reason: "malformed", detail: "Two consecutive malformed responses" };
}

// --- Internal async runner ---------------------------------------------------

async function runReflectionInternal(bot: AiTraderBot): Promise<void> {
  // Fetch the most recently closed decision for this bot (needs full row).
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 1);
  if (!recentClosed.length) return;
  const closedDecision = recentClosed[0];
  // Only reflect on decisions that have a recorded PnL outcome.
  if (closedDecision.realizedPnl === null) return;

  // Resolve BYO key — skip silently if unavailable (no free trial for reflection).
  const keyResult = await resolveKeyForReflection(bot.walletAddress);
  if (!keyResult) return;

  let entries: PlaybookEntry[];
  try {
    const result = await callReflectionLlm(keyResult.apiKey, bot, {
      rawDecision: closedDecision.rawDecision,
      clampedDecision: closedDecision.clampedDecision,
      realizedPnl: closedDecision.realizedPnl,
      contextDigest: closedDecision.contextDigest,
    });
    if (!result.ok) {
      // Keep old playbook unchanged on any failure.
      console.warn(
        `[Reflection] Bot ${bot.id.slice(0, 8)} skipped (${result.reason}): ${result.detail ?? ""}`
      );
      return;
    }
    entries = result.entries;
  } finally {
    keyResult.cleanup();
  }

  const nextVersion = (bot.playbookVersion ?? 0) + 1;
  await storage.updateAiTraderBot(bot.id, {
    playbook: entries,
    playbookVersion: nextVersion,
    playbookUpdatedAt: new Date(),
  } as any);
  console.log(
    `[Reflection] Bot ${bot.id.slice(0, 8)} playbook updated to v${nextVersion}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
  );
}

// --- Public entry point (fire-and-forget) ------------------------------------

/**
 * Schedule a reflection call for a bot after it closes a trade.
 * Returns immediately — never blocks afterClose processing.
 * One in-flight reflection per bot (skips if already running).
 *
 * NOTE: Injection of the resulting lessons into context-builder.ts is NOT yet
 * active. See the module header for the two gates that must clear first.
 */
export function fireReflection(bot: AiTraderBot): void {
  if (inFlight.has(bot.id)) return;
  inFlight.add(bot.id);
  runReflectionInternal(bot)
    .catch((err) => {
      console.error(`[Reflection] Bot ${bot.id.slice(0, 8)} uncaught error:`, err);
    })
    .finally(() => {
      inFlight.delete(bot.id);
    });
}
