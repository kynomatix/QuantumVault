// Agentic Trader Plan §Part B, WO-4. One decision cycle: force the model to call
// the `decide` tool through the WO-1 gateway, zod-validate the arguments, apply
// the pure guardrail layer (guardrails.ts, G1–G5), and record EVERYTHING to
// aiTraderDecisions — raw decision, clamped decision, violations, LLM cost and
// latency. No prose parsing on the money path (§4).
//
// Failure semantics (binding, §4 + G12):
// - Malformed output → exactly ONE corrective retry feeding the validation error
//   back as a user turn (the Tier-0.5 pattern); a second failure aborts the cycle
//   with an `aborted_malformed` audit row. Never a degraded guess on the money path.
// - Provider 400 mentioning "temperature" → one retry with the temperature field
//   omitted entirely (some providers reject any explicit value).
// - Timeout (G12, 60s) / gateway errors → abort with NO decision row (nothing was
//   decided; the monitor simply retries at the next candle close).
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fromZodError } from "zod-validation-error";
import {
  callOpenRouterWithUsage,
  LlmGatewayError,
  type LlmMessage,
  type LlmUsage,
} from "../ai-assistant/router";
import { estimateCallCostUsd } from "../ai-assistant/models-catalog";
import { storage } from "../storage";
import type { ProtocolAdapter } from "../protocol/adapter";
import type { AiTraderBot } from "@shared/schema";
import {
  applyGuardrails,
  type ClampedDecision,
  type GuardrailTimeframe,
  type GuardrailViolation,
} from "./guardrails";

// Platform-wide taker fee convention — mirrors EXCHANGE_TAKER_FEE_RATE in
// context-builder.ts (itself mirroring routes.ts DEFAULT_EXCHANGE_FEE_RATE);
// no ProtocolAdapter method exposes a numeric fee rate today.
const GUARDRAIL_TAKER_FEE_RATE = 0.0004;

// --- Decision contract (§4) — the zod schema is the single source of truth. ------
// Trade-level fields are structurally optional (flat/close carry none) and made
// required for long/short via superRefine, so one schema serves all four actions.
export const tradeDecisionSchema = z
  .object({
    action: z
      .enum(["long", "short", "flat", "close"])
      .describe("Trade action. 'close' is only valid while a position is open."),
    entryType: z
      .enum(["market"])
      .optional()
      .describe("Entry order type. Required for long/short. MVP: market only."),
    leverage: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Requested leverage, integer 1-5. Required for long/short."),
    sizePct: z
      .number()
      .min(10)
      .max(90)
      .optional()
      .describe("Percent of allocated collateral to commit as margin (10-90). Required for long/short."),
    stopLossPrice: z
      .number()
      .positive()
      .optional()
      .describe("Stop-loss price. Required for long/short."),
    takeProfitPrice: z
      .number()
      .positive()
      .optional()
      .describe("Take-profit price. Required for long/short."),
    confidence: z.number().int().min(1).max(10).describe("Conviction, integer 1-10."),
    invalidation: z.string().max(200).describe("What would prove this decision wrong."),
    rationale: z.string().max(600).describe("Concise reasoning for the decision."),
  })
  .superRefine((d, ctx) => {
    if (d.action === "long" || d.action === "short") {
      for (const field of [
        "entryType",
        "leverage",
        "sizePct",
        "stopLossPrice",
        "takeProfitPrice",
      ] as const) {
        if (d[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when action is '${d.action}'`,
          });
        }
      }
    }
  });

export type TradeDecision = z.infer<typeof tradeDecisionSchema>;

// JSON Schema for the native tool definition — generated from the SAME zod schema
// (single source; zod-to-json-schema per WO-4 step 1). $refStrategy:'none' inlines
// everything (providers don't resolve $ref), and the draft-07 $schema marker is
// stripped since OpenAI-shape `parameters` expects a bare schema object.
const generated = zodToJsonSchema(tradeDecisionSchema, {
  $refStrategy: "none",
  target: "jsonSchema7",
}) as Record<string, unknown>;
delete generated.$schema;
export const DECISION_JSON_SCHEMA: Record<string, unknown> = generated;

const DECIDE_TOOL = {
  type: "function",
  function: {
    name: "decide",
    description:
      "Submit your trading decision for this cycle. You MUST call this tool exactly once with your decision.",
    parameters: DECISION_JSON_SCHEMA,
  },
} as const;

// --- runDecision -----------------------------------------------------------------

export interface RunDecisionInput {
  bot: AiTraderBot;
  apiKey: string;
  /** Output of buildMarketContext (WO-3) — non-stale by contract. */
  context: { system: string; user: string; contextDigest: Record<string, any> };
  /**
   * Adapter for the bot's protocol — supplies getMaintenanceMarginWeight and
   * quantizeOrderSize to the guardrail layer. (Additive to the plan's WO-4
   * signature sketch, which omitted where those two inputs come from.)
   */
  adapter: ProtocolAdapter;
}

export type RunDecisionResult =
  | {
      ok: true;
      /** aiTraderDecisions row id (audit trail / later outcome updates). */
      decisionId: string;
      /** The zod-validated decision exactly as the model returned it. */
      decision: TradeDecision;
      /** Post-guardrail decision that may execute; null when the cycle was rejected. */
      clamped: ClampedDecision | null;
      /** true ⇒ guardrails rejected the cycle (outcome 'rejected_guardrails'). */
      rejected: boolean;
      violations: GuardrailViolation[];
      usage?: LlmUsage;
      latencyMs: number;
    }
  | { ok: false; reason: "malformed" | "timeout" | "gateway"; detail: string };

type ParsedAttempt =
  | { ok: true; decision: TradeDecision; raw: string }
  | { ok: false; detail: string; raw: string };

function parseDecisionResponse(res: {
  content: string;
  toolCalls?: { name: string; arguments: string }[];
}): ParsedAttempt {
  const call = res.toolCalls?.[0];
  if (!call) {
    return {
      ok: false,
      detail: "no `decide` tool call was returned (the model answered in prose instead)",
      raw: (res.content ?? "").slice(0, 2000),
    };
  }
  if (call.name !== "decide") {
    return {
      ok: false,
      detail: `tool call was named '${call.name}', expected 'decide'`,
      raw: call.arguments.slice(0, 4000),
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return {
      ok: false,
      detail: "tool call arguments were not valid JSON",
      raw: call.arguments.slice(0, 4000),
    };
  }
  const result = tradeDecisionSchema.safeParse(args);
  if (!result.success) {
    return {
      ok: false,
      detail: fromZodError(result.error).message,
      raw: call.arguments.slice(0, 4000),
    };
  }
  return { ok: true, decision: result.data, raw: call.arguments.slice(0, 4000) };
}

function finiteOrNaN(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

export async function runDecision(input: RunDecisionInput): Promise<RunDecisionResult> {
  const { bot, apiKey, context, adapter } = input;

  const messages: LlmMessage[] = [
    { role: "system", content: context.system },
    { role: "user", content: context.user },
  ];

  const started = Date.now();
  const usageTotal: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;
  let omitTemperature = false;

  // Sum spend across ALL calls in the cycle (initial + temperature retry +
  // corrective retry) — the user pays for every one of them.
  const addUsage = (u?: LlmUsage) => {
    if (!u) return;
    sawUsage = true;
    usageTotal.promptTokens += u.promptTokens;
    usageTotal.completionTokens += u.completionTokens;
    usageTotal.totalTokens += u.totalTokens;
  };

  const computeCostUsd = async (): Promise<string | null> => {
    if (!sawUsage) return null;
    try {
      const cost = await estimateCallCostUsd(
        bot.model,
        usageTotal.promptTokens,
        usageTotal.completionTokens
      );
      return cost == null ? null : cost.toFixed(6);
    } catch {
      return null; // record "unknown spend" rather than guess
    }
  };

  // One gateway call with the forced `decide` tool (WO-4 step 1: toolChoice
  // 'required', requireParameters, 60s G12 timeout, temperature 0.2). Handles the
  // provider temperature quirk inline: a 400 flagged temperatureUnsupported gets
  // exactly one retry with the field omitted; the flag is sticky for later calls
  // in the same cycle.
  const callGateway = async () => {
    const opts = {
      apiKey,
      model: bot.model,
      messages,
      temperature: 0.2,
      timeoutMs: 60_000,
      tools: [DECIDE_TOOL],
      toolChoice: "required" as const,
      requireParameters: true,
      ...(omitTemperature ? { omitTemperature: true } : {}),
    };
    try {
      return await callOpenRouterWithUsage(opts);
    } catch (err) {
      if (
        err instanceof LlmGatewayError &&
        err.status === 400 &&
        err.temperatureUnsupported &&
        !omitTemperature
      ) {
        omitTemperature = true;
        return await callOpenRouterWithUsage({ ...opts, omitTemperature: true });
      }
      throw err;
    }
  };

  // §4: initial attempt + exactly ONE corrective retry on malformed output.
  let lastDetail = "";
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<typeof callGateway>>;
    try {
      res = await callGateway();
    } catch (err) {
      // Nothing was decided — no audit row (there is no outcome enum for a call
      // that never produced output); the monitor retries at the next candle close.
      if (err instanceof LlmGatewayError) {
        return {
          ok: false,
          reason: err.status === 408 ? "timeout" : "gateway",
          detail: err.message,
        };
      }
      return { ok: false, reason: "gateway", detail: "Unexpected error calling the model provider." };
    }
    addUsage(res.usage);

    const parsed = parseDecisionResponse(res);
    if (parsed.ok) {
      return finalizeDecision({
        bot,
        adapter,
        context,
        decision: parsed.decision,
        usage: sawUsage ? { ...usageTotal } : undefined,
        latencyMs: Date.now() - started,
        llmCostUsd: await computeCostUsd(),
      });
    }

    lastDetail = parsed.detail;
    lastRaw = parsed.raw;
    if (attempt === 0) {
      // Tier-0.5 corrective retry: show the model its own output and the exact
      // validation error, then force the tool call again.
      messages.push(
        {
          role: "assistant",
          content: parsed.raw.length > 0 ? parsed.raw : "(no decide tool call was returned)",
        },
        {
          role: "user",
          content: `Your decision failed validation: ${parsed.detail}. Call decide again with corrected arguments.`,
        }
      );
    }
  }

  // Second failure → abort the cycle with a full audit row (§4: never a degraded
  // guess on the money path; auto mode stays flat and retries next candle close).
  const latencyMs = Date.now() - started;
  await storage.insertAiTraderDecision({
    botId: bot.id,
    contextDigest: context.contextDigest,
    rawDecision: { malformed: true, raw: lastRaw, validationError: lastDetail.slice(0, 2000) },
    clampedDecision: null,
    guardrailViolations: null,
    outcome: "aborted_malformed",
    llmCostUsd: await computeCostUsd(),
    llmLatencyMs: latencyMs,
  });
  return { ok: false, reason: "malformed", detail: lastDetail };
}

// --- Guardrails + audit record (WO-4 steps 4-5) ------------------------------------

async function finalizeDecision(args: {
  bot: AiTraderBot;
  adapter: ProtocolAdapter;
  context: RunDecisionInput["context"];
  decision: TradeDecision;
  usage?: LlmUsage;
  latencyMs: number;
  llmCostUsd: string | null;
}): Promise<RunDecisionResult> {
  const { bot, adapter, context, decision, usage, latencyMs, llmCostUsd } = args;
  const digest = context.contextDigest ?? {};

  const guardrailResult = applyGuardrails(decision, {
    entryPrice: finiteOrNaN(digest?.price),
    atr14: finiteOrNaN(digest?.indicators?.atr14?.value),
    botMaxLeverage: bot.maxLeverage,
    timeframe: bot.timeframe as GuardrailTimeframe,
    takerFeeRate: GUARDRAIL_TAKER_FEE_RATE,
    maintenanceMarginWeight: adapter.getMaintenanceMarginWeight(bot.market),
    allocatedUsdc: parseFloat(bot.allocatedUsdc),
    hasOpenPosition: digest?.account?.hasPosition === true,
    quantizeOrderSize: (sizeBase: number) => adapter.quantizeOrderSize(bot.market, sizeBase),
  });

  // Outcome: 'flat' is terminal immediately; a guardrail reject is terminal as
  // 'rejected_guardrails'; a passing long/short/close leaves outcome null — the
  // executor (WO-5) / suggest-mode user later sets executed/user_skipped/expired.
  const outcome =
    decision.action === "flat" ? "flat" : guardrailResult.ok ? null : "rejected_guardrails";

  // WO-9 observability: every guardrail rejection is logged with the RAW decision
  // ("you cannot tune what you can't see"). The DB audit row carries the same
  // facts; this line makes rejections greppable in server logs without a DB query.
  if (outcome === "rejected_guardrails") {
    console.warn(
      `[AiTraderDecide] guardrails REJECTED bot=${bot.id.slice(0, 8)} market=${bot.market} ` +
        `violations=${guardrailResult.violations.map((v) => v.code).join(",")} ` +
        `rawDecision=${JSON.stringify(decision)}`,
    );
  }

  const row = await storage.insertAiTraderDecision({
    botId: bot.id,
    contextDigest: digest,
    rawDecision: decision,
    clampedDecision: guardrailResult.ok ? guardrailResult.clamped : null,
    guardrailViolations: guardrailResult.violations.length > 0 ? guardrailResult.violations : null,
    outcome,
    llmCostUsd,
    llmLatencyMs: latencyMs,
  });

  return {
    ok: true,
    decisionId: row.id,
    decision,
    clamped: guardrailResult.ok ? guardrailResult.clamped : null,
    rejected: !guardrailResult.ok,
    violations: guardrailResult.violations,
    usage,
    latencyMs,
  };
}
