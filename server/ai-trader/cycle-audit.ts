import { createHash, randomUUID } from "node:crypto";
import type { AiTraderBot } from "@shared/schema";
import { CYCLE_REASONS, outcomeForCycleReason, type CycleFinish, type CyclePhase, type CycleReason, type CycleStart } from "@shared/ai-trader-cycle";
import { usesFixedPaperDecisionV2 } from "@shared/ai-trader-flat-reasons";
import { storage } from "../storage";
import { SERVER_BOOT_ID } from "../boot-id";
import { appendTelemetry } from "../telemetry";

// Receipts contain allowlisted metadata only. A database/process outage can lose
// coverage; observation failure never becomes execution admission or order replay.
const pending = new Map<string, { start: CycleStart; finish: CycleFinish }>();
const unavailable = new Map<string, true>();
const active = new Set<string>();
const MAX_PENDING = 128;
function coverageGap(botId: string, code = "audit_write_failed"): void {
  try {
  unavailable.delete(botId);
  unavailable.set(botId, true);
  if (unavailable.size > 1024) unavailable.delete(unavailable.keys().next().value!);
  try { appendTelemetry(`[AIT-CYCLE] ${code} bot=${botId.slice(0, 8)} coverage=unavailable`); } catch { /* observational only */ }
  } catch { /* Even coverage reporting must never affect trading. */ }
}
export function cycleIsActive(id: string): boolean { return active.has(id); }
export function cycleAuditUnavailable(botId: string): boolean { return unavailable.has(botId); }

async function twice(operation: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); return true; } catch { /* one bounded recorder retry */ }
  }
  return false;
}
async function retryPending(): Promise<void> {
  for (const [id, receipt] of [...pending].slice(0, 1)) {
    if (await twice(async () => {
      await storage.startAiTraderCycle(receipt.start);
      await storage.finishAiTraderCycle(id, receipt.start.botId, SERVER_BOOT_ID, receipt.finish);
    })) {
      pending.delete(id);
      if (![...pending.values()].some(value => value.start.botId === receipt.start.botId)) unavailable.delete(receipt.start.botId);
    }
  }
}

export class CycleAudit {
  readonly id = randomUUID();
  phase: CyclePhase = "initial";
  reason: CycleReason = "internal_error";
  private started = false;
  private finished = false;
  private beginTask?: Promise<void>;
  private incomplete = false;
  private candidateCount = 0;
  private modelCallCount = 0;
  private decisionIds: string[] = [];
  private details: Record<string, unknown>;
  private promptVersionHash: string | null = null;
  private contextVersionHash: string | null = null;
  readonly start: CycleStart;

  markUnavailable(): void {
    this.incomplete = true;
    this.reason = "internal_error";
    coverageGap(this.start.botId, "audit_internal_error");
  }
  private observe(operation: () => void): void {
    try { operation(); } catch { this.markUnavailable(); }
  }

  constructor(bot: AiTraderBot, plannedBoundary: Date, startedAt = new Date()) {
    this.details = { mode: bot.mode, status: bot.status, autoNext: bot.autoNext,
      decisionContractVersion: usesFixedPaperDecisionV2(bot) ? 2 : 1 };
    this.start = { id: this.id, botId: bot.id, plannedBoundary, startedAt,
      botUpdatedAt: bot.updatedAt ? new Date(bot.updatedAt) : null,
      protocol: bot.protocol, market: bot.market, timeframe: bot.timeframe,
      marketSource: bot.marketSource ?? "fixed", paperMode: bot.paperMode, model: bot.model,
      ownerBootId: SERVER_BOOT_ID, details: { ...this.details } };
  }
  begin(): Promise<void> {
    if (this.beginTask) return this.beginTask;
    active.add(this.id);
    this.beginTask = (async () => {
      await retryPending();
      this.started = await twice(() => storage.startAiTraderCycle(this.start));
      if (!this.started) coverageGap(this.start.botId);
    })().catch(() => { this.observe(() => { throw new Error("audit_begin_failed"); }); });
    return this.beginTask;
  }
  set(reason: CycleReason, phase?: CyclePhase): void {
    this.observe(() => {
      if (!CYCLE_REASONS.includes(reason)) throw new Error("audit_reason_unknown");
      this.reason = this.incomplete ? "internal_error" : reason;
      if (phase) this.phase = phase;
    });
  }
  gatewayCall = (): void => { this.observe(() => { this.modelCallCount++; }); };
  candidate(): void { this.observe(() => { this.candidateCount++; }); }
  context(context: unknown): void {
    this.observe(() => {
    if (!context || typeof context !== "object" || !("system" in context) || typeof context.system !== "string"
        || !("contextDigest" in context) || !context.contextDigest || typeof context.contextDigest !== "object") {
      throw new Error("audit_context_unknown");
    }
    this.promptVersionHash = createHash("sha256").update(context.system).digest("hex");
    this.contextVersionHash = createHash("sha256").update(JSON.stringify(context.contextDigest)).digest("hex");
    const digest = context.contextDigest as Record<string, any>;
    const quality = digest.contextQuality;
    if (quality && typeof quality === "object") this.details.contextQuality = {
      selectedRequested: quality.selectedRequested, selectedActual: quality.selectedActual,
      parentRequested: quality.parentRequested, parentActual: quality.parentActual,
      selectedCoverage: quality.selectedCoverage, selectedNewestAgeMs: quality.selectedNewestAgeMs,
      parentUnavailable: quality.parentUnavailable,
    };
    const provenance = digest.candleProvenance;
    if (provenance && typeof provenance === "object") {
      const safe = (value: any) => value ? Object.fromEntries(["source", "venue", "basis", "proxy", "finality", "timeSemantic", "aggregation", "finalized"]
        .filter(key => typeof value[key] === "boolean" || (typeof value[key] === "string" && value[key].length < 64))
        .map(key => [key, value[key]])) : null;
      this.details.provenance = { selected: safe(provenance.selected), parent: safe(provenance.parent) };
    }
    });
  }
  decision(result: unknown): void {
    this.observe(() => {
    if (!result || typeof result !== "object" || !("ok" in result)) throw new Error("audit_decision_unknown");
    const value = result as Record<string, any>;
    if (value.ok !== true && value.ok !== false) throw new Error("audit_decision_unknown");
    if (value.ok && !["flat", "close", "long", "short"].includes(value.decision?.action)) throw new Error("audit_decision_unknown");
    if (!value.ok && !["timeout", "gateway", "malformed"].includes(value.reason)) throw new Error("audit_decision_unknown");
    if (value.violations != null && !Array.isArray(value.violations)) throw new Error("audit_violations_unknown");
    if (typeof value.decisionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.decisionId)
        && !this.decisionIds.includes(value.decisionId) && this.decisionIds.length < 2) this.decisionIds.push(value.decisionId);
    this.set(!value.ok ? value.reason === "timeout" ? "gateway_timeout" : value.reason === "gateway" ? "gateway_error" : "model_malformed"
      : value.rejected ? "guardrail_rejected"
      : value.decision.action === "flat" ? "model_flat"
      : value.decision.action === "close" ? "close_without_position" : "model_entry", "model");
    const codes = value.ok ? (value.violations ?? []).map((violation: any) => violation?.code)
      .filter((code: unknown) => typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code)).slice(0, 4) : [];
    const candidates = (this.details.candidates as unknown[] | undefined) ?? [];
    this.details.candidates = [...candidates, { reasonCode: this.reason, decisionId: this.decisionIds.includes(value.decisionId) ? value.decisionId : null, codes }].slice(0, 2);
    this.details.detailCodes = codes;
    });
  }
  execution(code: string | null, ok: boolean): void {
    this.observe(() => {
    if (typeof ok !== "boolean" || (code !== null && typeof code !== "string")) throw new Error("audit_execution_unknown");
    this.set(ok ? "entry_executed" : "execution_rejected", "execution");
    if (code && /^[a-z0-9_]{1,80}$/.test(code)) this.details.detailCodes = [code];
    });
  }
  async finish(nextBoundary: Date | null, finishedAt = new Date()): Promise<void> {
    try {
    if (this.finished) return;
    this.finished = true;
    active.delete(this.id); // This closure has ended; foreign/old boots are never inferred dead by age.
    const finish: CycleFinish = { phase: this.phase, reasonCode: this.reason,
      outcome: outcomeForCycleReason(this.reason), finishedAt, rearmed: nextBoundary !== null,
      nextPlannedBoundary: nextBoundary, candidateCount: this.candidateCount, modelCallCount: this.modelCallCount,
      decisionIds: this.decisionIds, promptVersionHash: this.promptVersionHash, contextVersionHash: this.contextVersionHash,
      details: { ...this.details, auditStatus: this.incomplete ? "unavailable" : "complete" } };
    // Persistence stays ordered even though monitor/scanner callers never await it.
    await this.beginTask;
    const saved = await twice(async () => {
      if (!this.started) { await storage.startAiTraderCycle(this.start); this.started = true; }
      await storage.finishAiTraderCycle(this.id, this.start.botId, SERVER_BOOT_ID, finish);
    });
    if (!saved) {
      coverageGap(this.start.botId);
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value!;
        coverageGap(pending.get(oldest)!.start.botId, "audit_receipt_lost");
        pending.delete(oldest);
      }
      pending.set(this.id, { start: this.start, finish });
    } else if (!this.incomplete && ![...pending.values()].some(value => value.start.botId === this.start.botId)) unavailable.delete(this.start.botId);
    } catch { this.observe(() => { throw new Error("audit_finish_failed"); }); }
  }
}

/** A second boundary protects trading even if a recorder implementation throws. */
export function safeCycleAudit(botId: string, create: () => CycleAudit): CycleAudit {
  let audit: CycleAudit | undefined;
  const failed = () => {
    try { audit?.markUnavailable(); } catch { /* A broken recorder cannot report itself. */ }
    coverageGap(botId, "audit_internal_error");
  };
  try { audit = create(); } catch { failed(); return new Proxy({} as CycleAudit, {
    get: (_target, key) => key === "reason" ? "internal_error" : key === "phase" ? "initial" : () => undefined,
    set: () => true,
  }); }
  // An independent facade also contains failures from frozen recorder properties.
  return new Proxy({} as CycleAudit, {
    get(_target, key) {
      try {
        const target = audit!;
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          try {
            const result = Reflect.apply(value, target, args);
            return result instanceof Promise ? result.catch(failed) : result;
          } catch { failed(); }
        };
      } catch { failed(); return () => undefined; }
    },
    set(_target, key, value) {
      try { if (!Reflect.set(audit!, key, value)) failed(); } catch { failed(); }
      return true;
    },
  });
}

/** Buffer passive observations while the audit-only snapshot loads off the trading path. */
export function deferredCycleAudit(botId: string, create: () => Promise<CycleAudit>): CycleAudit {
  let audit: CycleAudit | undefined;
  let failed = false;
  const queued: ((recorder: CycleAudit) => void)[] = [];
  const state = { phase: "initial" as CyclePhase, reason: "internal_error" as CycleReason };
  const enqueue = (operation: (recorder: CycleAudit) => void): void => {
    if (audit) { operation(audit); return; }
    if (failed) return;
    if (queued.length >= 256) {
      failed = true;
      queued.length = 0;
      coverageGap(botId, "audit_receipt_lost");
      return;
    }
    queued.push(operation);
  };
  void Promise.resolve().then(create).then(value => {
    if (failed) return;
    audit = safeCycleAudit(botId, () => value);
    for (const operation of queued.splice(0)) operation(audit);
  }).catch(() => {
    failed = true;
    queued.length = 0;
    coverageGap(botId, "audit_internal_error");
  });
  return new Proxy({} as CycleAudit, {
    get(_target, key) {
      if (key === "phase" || key === "reason") return audit?.[key] ?? state[key];
      return (...args: unknown[]) => {
        if (key === "set") {
          state.reason = CYCLE_REASONS.includes(args[0] as CycleReason) ? args[0] as CycleReason : "internal_error";
          if (args[1]) state.phase = args[1] as CyclePhase;
        }
        // A slow snapshot must not turn its eventual write time into cycle duration.
        if (key === "finish" && args.length < 2) args.push(new Date());
        enqueue(recorder => {
          const method = Reflect.get(recorder, key);
          if (typeof method === "function") Reflect.apply(method, recorder, args);
        });
      };
    },
    set(_target, key, value) {
      if (key === "phase") state.phase = value;
      if (key === "reason") state.reason = value;
      enqueue(recorder => { Reflect.set(recorder, key, value); });
      return true;
    },
  });
}

export function reportOrphanCycle(botId: string): void {
  coverageGap(botId, "orphan_callback");
}
