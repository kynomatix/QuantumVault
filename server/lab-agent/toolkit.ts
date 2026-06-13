// QuantumLab Sandbox Agent — toolkit harness (Phase A, T4).
//
// The modernization-proof seam between the agent and the lab. EVERYTHING the
// agent can do flows through `LabAgentToolkit.call(...)`, which:
//   1. capability-bounds the method against the closed contract registry (§8) —
//      the agent can invoke nothing outside the menu;
//   2. binds + enforces the caller's wallet scope (cross-wallet-leak guard, §8);
//   3. validates the agent's INPUT against the contract zod schema;
//   4. dispatches to the pluggable adapter (today: current-lab-adapter);
//   5. validates the adapter's OUTPUT against the contract zod schema — a
//      mismatch is OUR bug and becomes a typed `internal` error, never a leaked
//      raw / raw-shaped value;
//   6. returns a typed ToolkitResult — a success DTO or a typed ToolkitErrorDto.
//      It NEVER throws.
//
// The adapter is the only swappable, lab-coupled part. Replacing today's lab
// plumbing means writing a new adapter; this harness and the contract stay put.

import { z } from "zod";
import {
  LAB_AGENT_TOOLKIT_IO,
  LAB_AGENT_TOOLKIT_METHODS,
  isLabAgentToolkitMethod,
  type LabAgentToolkitMethod,
  type LabAgentToolkitInput,
  type LabAgentToolkitOutput,
  type ToolkitResult,
  type ToolkitErrorCode,
  type ToolkitErrorDto,
} from "@shared/lab-agent-contract";

/**
 * Caller context. The wallet is bound HERE (never a method argument) and
 * enforced on every call so the agent can only ever touch its owner's data.
 */
export interface ToolkitContext {
  /** Wallet that owns this agent session. Required; all reads/writes scope to it. */
  walletAddress: string;
  /** Capability gate. Both default to allowed when omitted. */
  allow?: { read?: boolean; write?: boolean };
}

/**
 * The single error type adapters throw for KNOWN, typed failures (not_found,
 * conflict, not_implemented, …). The harness maps it to a ToolkitErrorDto.
 * Anything else thrown is treated as a generic, sanitized `internal` error.
 */
export class ToolkitError extends Error {
  constructor(
    readonly code: ToolkitErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolkitError";
  }
}

/**
 * The lab-coupled seam: exactly one handler per contract method. Handlers
 * return the method's DTO or throw a ToolkitError. They must NOT enforce the
 * contract shape themselves — the harness re-validates every output.
 */
export interface LabAgentAdapter {
  // ---- read (lab:read) ----
  listStrategies(ctx: ToolkitContext, input: LabAgentToolkitInput<"listStrategies">): Promise<LabAgentToolkitOutput<"listStrategies">>;
  findStrategy(ctx: ToolkitContext, input: LabAgentToolkitInput<"findStrategy">): Promise<LabAgentToolkitOutput<"findStrategy">>;
  listTemplates(ctx: ToolkitContext, input: LabAgentToolkitInput<"listTemplates">): Promise<LabAgentToolkitOutput<"listTemplates">>;
  getTopResults(ctx: ToolkitContext, input: LabAgentToolkitInput<"getTopResults">): Promise<LabAgentToolkitOutput<"getTopResults">>;
  getHeatmap(ctx: ToolkitContext, input: LabAgentToolkitInput<"getHeatmap">): Promise<LabAgentToolkitOutput<"getHeatmap">>;
  getInsightsReport(ctx: ToolkitContext, input: LabAgentToolkitInput<"getInsightsReport">): Promise<LabAgentToolkitOutput<"getInsightsReport">>;
  getRunStatus(ctx: ToolkitContext, input: LabAgentToolkitInput<"getRunStatus">): Promise<LabAgentToolkitOutput<"getRunStatus">>;
  getQueuePosition(ctx: ToolkitContext, input: LabAgentToolkitInput<"getQueuePosition">): Promise<LabAgentToolkitOutput<"getQueuePosition">>;
  // ---- write (lab:write) ----
  createStrategyFromText(ctx: ToolkitContext, input: LabAgentToolkitInput<"createStrategyFromText">): Promise<LabAgentToolkitOutput<"createStrategyFromText">>;
  createStrategyFromTemplate(ctx: ToolkitContext, input: LabAgentToolkitInput<"createStrategyFromTemplate">): Promise<LabAgentToolkitOutput<"createStrategyFromTemplate">>;
  runOptimization(ctx: ToolkitContext, input: LabAgentToolkitInput<"runOptimization">): Promise<LabAgentToolkitOutput<"runOptimization">>;
  refineFrom(ctx: ToolkitContext, input: LabAgentToolkitInput<"refineFrom">): Promise<LabAgentToolkitOutput<"refineFrom">>;
  generateInsights(ctx: ToolkitContext, input: LabAgentToolkitInput<"generateInsights">): Promise<LabAgentToolkitOutput<"generateInsights">>;
  improve(ctx: ToolkitContext, input: LabAgentToolkitInput<"improve">): Promise<LabAgentToolkitOutput<"improve">>;
  cancelRun(ctx: ToolkitContext, input: LabAgentToolkitInput<"cancelRun">): Promise<LabAgentToolkitOutput<"cancelRun">>;
}

type AnyHandler = (ctx: ToolkitContext, input: unknown) => Promise<unknown>;

const WRITE_METHODS: ReadonlySet<string> = new Set(LAB_AGENT_TOOLKIT_METHODS.write);

function err(code: ToolkitErrorCode, message: string, retryable: boolean): { ok: false; error: ToolkitErrorDto } {
  return { ok: false, error: { code, message, retryable } };
}

/** Compact, human-safe rendering of the first input-validation issue. */
function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export class LabAgentToolkit {
  constructor(private readonly adapter: LabAgentAdapter) {}

  async call<M extends LabAgentToolkitMethod>(
    ctx: ToolkitContext,
    method: M,
    rawInput: unknown,
  ): Promise<ToolkitResult<LabAgentToolkitOutput<M>>> {
    try {
      // 1. capability-bound: the agent's whole world is the closed registry.
      if (!isLabAgentToolkitMethod(method)) {
        return err("forbidden", `Unknown toolkit method: ${String(method)}`, false);
      }
      // 2. wallet binding (cross-wallet-leak guard, §8).
      if (!ctx || !ctx.walletAddress) {
        return err("forbidden", "No wallet bound to the toolkit context.", false);
      }
      const isWrite = WRITE_METHODS.has(method);
      const allowRead = ctx.allow?.read ?? true;
      const allowWrite = ctx.allow?.write ?? true;
      if (isWrite && !allowWrite) return err("forbidden", `Method '${method}' requires the write capability.`, false);
      if (!isWrite && !allowRead) return err("forbidden", `Method '${method}' requires the read capability.`, false);

      const io = LAB_AGENT_TOOLKIT_IO[method];
      // 3. validate INPUT.
      const parsedInput = io.input.safeParse(rawInput);
      if (!parsedInput.success) {
        return err("invalid_input", firstZodIssue(parsedInput.error), false);
      }

      // 4. dispatch to the adapter.
      const handler = (this.adapter as unknown as Record<LabAgentToolkitMethod, AnyHandler>)[method];
      const rawOutput = await handler.call(this.adapter, ctx, parsedInput.data);

      // 5. validate OUTPUT — the contract guarantee. A failure here is our bug;
      //    convert it to a typed internal error rather than leak a bad shape.
      const parsedOutput = io.output.safeParse(rawOutput);
      if (!parsedOutput.success) {
        console.error(
          `[LabAgentToolkit] OUTPUT contract violation in '${method}':`,
          parsedOutput.error.issues,
        );
        return err("internal", "Internal error: result failed contract validation.", false);
      }

      return { ok: true, data: parsedOutput.data as LabAgentToolkitOutput<M> };
    } catch (e) {
      if (e instanceof ToolkitError) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } };
      }
      console.error(`[LabAgentToolkit] Unhandled error in '${String(method)}':`, e);
      return err("internal", "An internal error occurred.", false);
    }
  }
}
