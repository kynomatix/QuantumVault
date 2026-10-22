import type { LatestCycle } from "@shared/ai-trader-cycle";
import { sanitizeGatewayFailure } from "@shared/ai-gateway-failure";
import { readFlatReasons } from "@shared/ai-trader-flat-reasons";
import { storage } from "../storage";
import { cycleAuditUnavailable, cycleIsActive } from "./cycle-audit";
import { SERVER_BOOT_ID } from "../boot-id";

/** Called only after the detail route has authorized the bot. */
export async function readLatestCycle(botId: string): Promise<LatestCycle> {
  try {
    if (cycleAuditUnavailable(botId)) return { status: "unavailable", cycle: null };
    const row = await storage.getLatestAiTraderCycle(botId);
    if (!row) return { status: "available", cycle: null };
    let flatReasons: ReturnType<typeof readFlatReasons> = null;
    let rationale: string | null = null;
    if (row.reasonCode === "model_flat" && Array.isArray(row.decisionIds)) {
      for (const id of [...row.decisionIds].reverse()) {
        if (typeof id !== "string") continue;
        const decision = await storage.getAiTraderDecision(id);
        if (!decision || decision.botId !== botId) continue;
        const raw = decision.rawDecision as Record<string, unknown> | null;
        if (raw?.action !== "flat") continue;
        flatReasons = readFlatReasons(raw);
        const text = raw.rationale ?? raw.rationaleExcerpt;
        rationale = typeof text === "string" ? text.slice(0, 600) : null;
        break;
      }
    }
    const details = row.details as Record<string, unknown> | null;
    return { status: "available", cycle: {
      id: row.id, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
      outcome: row.outcome as NonNullable<LatestCycle["cycle"]>["outcome"],
      reasonCode: row.reasonCode as NonNullable<LatestCycle["cycle"]>["reasonCode"],
      rearmed: row.rearmed, nextPlannedBoundary: row.nextPlannedBoundary?.toISOString() ?? null,
      completionUnknown: row.outcome === "running" && !(row.ownerBootId === SERVER_BOOT_ID && cycleIsActive(row.id)),
      flatReasons, rationale,
      gatewayFailure: row.reasonCode === "gateway_error" || row.reasonCode === "gateway_timeout"
        ? sanitizeGatewayFailure(details?.gatewayFailure) : null,
      availableAt: row.reasonCode === "cooldown" && typeof details?.availableAt === "string" && Number.isFinite(Date.parse(details.availableAt))
        ? new Date(details.availableAt).toISOString() : null,
      detailCodes: Array.isArray(details?.detailCodes) ? details.detailCodes.filter((value): value is string => typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value)).slice(0, 4) : [],
    } };
  } catch { return { status: "unavailable", cycle: null }; }
}
