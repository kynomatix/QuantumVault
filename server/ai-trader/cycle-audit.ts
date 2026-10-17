import { createHash, randomUUID } from "node:crypto";
import type { AiTraderBot } from "@shared/schema";
import { outcomeForCycleReason, type CycleFinish, type CyclePhase, type CycleReason, type CycleStart } from "@shared/ai-trader-cycle";
import { usesFixedPaperDecisionV2 } from "@shared/ai-trader-flat-reasons";
import { storage } from "../storage";
import { SERVER_BOOT_ID } from "../boot-id";
import { appendTelemetry } from "../telemetry";
import type { RunDecisionResult } from "./decide";

// Receipts contain allowlisted metadata only. A database/process outage can lose
// coverage; observation failure never becomes execution admission or order replay.
const pending = new Map<string, { start: CycleStart; finish: CycleFinish }>();
const unavailable = new Map<string, true>();
const active = new Set<string>();
const MAX_PENDING = 128;
function coverageGap(botId: string, code = "audit_write_failed"): void {
  unavailable.delete(botId);
  unavailable.set(botId, true);
  if (unavailable.size > 1024) unavailable.delete(unavailable.keys().next().value!);
  try { appendTelemetry(`[AIT-CYCLE] ${code} bot=${botId.slice(0, 8)} coverage=unavailable`); } catch { /* observational only */ }
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
  private candidateCount = 0;
  private modelCallCount = 0;
  private decisionIds: string[] = [];
  private details: Record<string, unknown>;
  private promptVersionHash: string | null = null;
  private contextVersionHash: string | null = null;
  readonly start: CycleStart;

  constructor(bot: AiTraderBot, plannedBoundary: Date, startedAt = new Date()) {
    this.details = { mode: bot.mode, status: bot.status, autoNext: bot.autoNext,
      decisionContractVersion: usesFixedPaperDecisionV2(bot) ? 2 : 1 };
    this.start = { id: this.id, botId: bot.id, plannedBoundary, startedAt,
      botUpdatedAt: bot.updatedAt ? new Date(bot.updatedAt) : null,
      protocol: bot.protocol, market: bot.market, timeframe: bot.timeframe,
      marketSource: bot.marketSource ?? "fixed", paperMode: bot.paperMode, model: bot.model,
      ownerBootId: SERVER_BOOT_ID, details: { ...this.details } };
  }
  async begin(): Promise<void> {
    active.add(this.id);
    await retryPending();
    this.started = await twice(() => storage.startAiTraderCycle(this.start));
    if (!this.started) coverageGap(this.start.botId);
  }
  set(reason: CycleReason, phase?: CyclePhase): void {
    this.reason = reason;
    if (phase) this.phase = phase;
  }
  gatewayCall = (): void => { this.modelCallCount++; };
  candidate(): void { this.candidateCount++; }
  context(context: { system: string; contextDigest: Record<string, any> }): void {
    this.promptVersionHash = createHash("sha256").update(context.system).digest("hex");
    this.contextVersionHash = createHash("sha256").update(JSON.stringify(context.contextDigest)).digest("hex");
    const quality = context.contextDigest.contextQuality;
    if (quality && typeof quality === "object") this.details.contextQuality = {
      selectedRequested: quality.selectedRequested, selectedActual: quality.selectedActual,
      parentRequested: quality.parentRequested, parentActual: quality.parentActual,
      selectedCoverage: quality.selectedCoverage, selectedNewestAgeMs: quality.selectedNewestAgeMs,
      parentUnavailable: quality.parentUnavailable,
    };
    const provenance = context.contextDigest.candleProvenance;
    if (provenance && typeof provenance === "object") {
      const safe = (value: any) => value ? Object.fromEntries(["source", "venue", "basis", "proxy", "finality", "timeSemantic", "aggregation", "finalized"]
        .filter(key => typeof value[key] === "boolean" || (typeof value[key] === "string" && value[key].length < 64))
        .map(key => [key, value[key]])) : null;
      this.details.provenance = { selected: safe(provenance.selected), parent: safe(provenance.parent) };
    }
  }
  decision(result: RunDecisionResult): void {
    if (result.decisionId && !this.decisionIds.includes(result.decisionId)) this.decisionIds.push(result.decisionId);
    this.set(!result.ok ? result.reason === "timeout" ? "gateway_timeout" : result.reason === "gateway" ? "gateway_error" : "model_malformed"
      : result.rejected ? "guardrail_rejected"
      : result.decision.action === "flat" ? "model_flat"
      : result.decision.action === "close" ? "close_without_position" : "model_entry", "model");
    const codes = result.ok ? (result.violations ?? []).map(value => value.code).slice(0, 4) : [];
    const candidates = (this.details.candidates as unknown[] | undefined) ?? [];
    this.details.candidates = [...candidates, { reasonCode: this.reason, decisionId: result.decisionId ?? null, codes }].slice(0, 2);
    this.details.detailCodes = codes;
  }
  execution(code: string | null, ok: boolean): void {
    this.set(ok ? "entry_executed" : "execution_rejected", "execution");
    if (code && /^[a-z0-9_]{1,80}$/.test(code)) this.details.detailCodes = [code];
  }
  async finish(nextBoundary: Date | null): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    active.delete(this.id); // This closure has ended; foreign/old boots are never inferred dead by age.
    const finish: CycleFinish = { phase: this.phase, reasonCode: this.reason,
      outcome: outcomeForCycleReason(this.reason), finishedAt: new Date(), rearmed: nextBoundary !== null,
      nextPlannedBoundary: nextBoundary, candidateCount: this.candidateCount, modelCallCount: this.modelCallCount,
      decisionIds: this.decisionIds, promptVersionHash: this.promptVersionHash, contextVersionHash: this.contextVersionHash,
      details: { ...this.details, auditStatus: "complete" } };
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
    } else if (![...pending.values()].some(value => value.start.botId === this.start.botId)) unavailable.delete(this.start.botId);
  }
}

export function reportOrphanCycle(botId: string): void {
  coverageGap(botId, "orphan_callback");
}
