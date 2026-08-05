import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { aiTraderExecutionEvents, type AiTraderBot, type AiTraderExecutionEvent } from "@shared/schema";
import { appendTelemetry } from "../telemetry";
import type { OrderResult, OrderStatus } from "../protocol/protocol-types";

// Explicit subsystem namespace; distinct from every storage.ts namespace.
export const AI_TRADER_EXECUTION_JOURNAL_LOCK_NAMESPACE = 927413;

export type JournalAction = "entry" | "close" | "cancel";
export type JournalCause =
  | "decision" | "paper" | "emergency_unwind" | "protective" | "user_requested"
  | "venue_detected" | "unconfirmed_orphan" | "startup_orphan"
  | "pre_close_bracket" | "survivor_leg";
export type JournalEventType =
  | "attempt_claimed" | "prebroadcast_authorized" | "broadcast_attempted" | "broadcast_result"
  | "position_observed" | "fill_observed" | "bracket_verified" | "reconciliation_observed"
  | "entry_terminal_open" | "entry_terminal_no_land" | "entry_terminal_unwound"
  | "close_terminal_confirmed" | "close_terminal_failed"
  | "cancel_terminal_confirmed" | "cancel_terminal_failed";
export type JournalFailureCode =
  | "venue_rejected" | "venue_unconfirmed" | "venue_error" | "identity_mismatch"
  | "signing_unavailable" | "position_not_confirmed" | "bracket_failed" | "unknown";
export type JournalAccountScope = "main" | "bot_subaccount" | "unknown";

const PHASE_BY_EVENT: Readonly<Record<JournalEventType, 0 | 10 | 20 | 90 | null>> = Object.freeze({
  attempt_claimed: 0,
  prebroadcast_authorized: 10,
  broadcast_attempted: 10,
  broadcast_result: 20,
  position_observed: null,
  fill_observed: null,
  bracket_verified: null,
  reconciliation_observed: null,
  entry_terminal_open: 90,
  entry_terminal_no_land: 90,
  entry_terminal_unwound: 90,
  close_terminal_confirmed: 90,
  close_terminal_failed: 90,
  cancel_terminal_confirmed: 90,
  cancel_terminal_failed: 90,
});

const ACTIONS = new Set<JournalAction>(["entry", "close", "cancel"]);
const PROTOCOLS = new Set(["pacifica", "flash", "drift"]);
const CAUSES = new Set<JournalCause>([
  "decision", "paper", "emergency_unwind", "protective", "user_requested",
  "venue_detected", "unconfirmed_orphan", "startup_orphan",
  "pre_close_bracket", "survivor_leg",
]);
const STATUSES = new Set<OrderStatus>([
  "submitted", "acknowledged", "filled", "partial_fill", "canceled", "expired", "rejected", "unknown",
]);
const FAILURE_CODES = new Set<JournalFailureCode>([
  "venue_rejected", "venue_unconfirmed", "venue_error", "identity_mismatch",
  "signing_unavailable", "position_not_confirmed", "bracket_failed", "unknown",
]);
const INTERNAL_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const MARKET = /^[A-Za-z0-9:_-]{1,80}$/;
const PRINTABLE_ID = /^[\x21-\x7E]{1,180}$/;

export interface JournalEventInput {
  attemptId: string;
  botId: string;
  decisionId: string | null;
  action: JournalAction;
  cause: JournalCause;
  eventType: JournalEventType;
  protocol: string;
  accountScope: JournalAccountScope;
  accountRef?: string | null;
  market: string;
  side?: "long" | "short" | null;
  clientOrderId?: string | null;
  venueOrderId?: string | null;
  transactionSignature?: string | null;
  venueStatus?: OrderStatus | null;
  price?: number | null;
  sizeBase?: number | null;
  fee?: number | null;
  realizedPnl?: number | null;
  failureCode?: JournalFailureCode | null;
  recordedAfterBroadcast?: boolean;
  observedAt?: Date;
}

type CanonicalEvent = Omit<JournalEventInput,
  "observedAt" | "accountRef" | "side" | "clientOrderId" | "venueOrderId" |
  "transactionSignature" | "venueStatus" | "price" | "sizeBase" | "fee" |
  "realizedPnl" | "failureCode" | "recordedAfterBroadcast"
> & {
  phase: 0 | 10 | 20 | 90 | null;
  accountRef: string | null;
  side: "long" | "short" | null;
  clientOrderId: string | null;
  venueOrderId: string | null;
  transactionSignature: string | null;
  venueStatus: OrderStatus | null;
  price: string | null;
  sizeBase: string | null;
  fee: string | null;
  realizedPnl: string | null;
  failureCode: JournalFailureCode | null;
  recordedAfterBroadcast: boolean;
};

function bounded(value: string | null | undefined, pattern: RegExp, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (!pattern.test(value)) throw new Error(`execution_journal_invalid_${name}`);
  return value;
}

function finiteDecimal(value: number | null | undefined, name: string, nonnegative = false): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || (nonnegative && value < 0)) throw new Error(`execution_journal_invalid_${name}`);
  return String(value);
}

function canonicalize(input: JournalEventInput): CanonicalEvent {
  if (!ACTIONS.has(input.action) || !CAUSES.has(input.cause) || !(input.eventType in PHASE_BY_EVENT)) {
    throw new Error("execution_journal_invalid_literal");
  }
  if (!INTERNAL_ID.test(input.attemptId) || !INTERNAL_ID.test(input.botId)
      || (input.decisionId !== null && !INTERNAL_ID.test(input.decisionId))) {
    throw new Error("execution_journal_invalid_internal_id");
  }
  if (!INTERNAL_ID.test(input.protocol) || !PROTOCOLS.has(input.protocol) || !MARKET.test(input.market)) {
    throw new Error("execution_journal_invalid_protocol_or_market");
  }
  if (input.side !== undefined && input.side !== null && input.side !== "long" && input.side !== "short") {
    throw new Error("execution_journal_invalid_side");
  }
  if (input.venueStatus !== undefined && input.venueStatus !== null && !STATUSES.has(input.venueStatus)) {
    throw new Error("execution_journal_invalid_venue_status");
  }
  if (input.failureCode !== undefined && input.failureCode !== null && !FAILURE_CODES.has(input.failureCode)) {
    throw new Error("execution_journal_invalid_failure_code");
  }
  const phase = PHASE_BY_EVENT[input.eventType];
  if (input.eventType === "prebroadcast_authorized" && input.action !== "entry") throw new Error("execution_journal_invalid_event_action");
  if (input.eventType === "broadcast_attempted" && input.action === "entry") throw new Error("execution_journal_invalid_event_action");
  if (input.eventType.startsWith("entry_terminal_") && input.action !== "entry") throw new Error("execution_journal_invalid_event_action");
  if (input.eventType.startsWith("close_terminal_") && input.action !== "close") throw new Error("execution_journal_invalid_event_action");
  if (input.eventType.startsWith("cancel_terminal_") && input.action !== "cancel") throw new Error("execution_journal_invalid_event_action");

  return {
    attemptId: input.attemptId,
    botId: input.botId,
    decisionId: input.decisionId,
    action: input.action,
    cause: input.cause,
    eventType: input.eventType,
    phase,
    protocol: input.protocol,
    accountScope: input.accountScope,
    accountRef: bounded(input.accountRef, PRINTABLE_ID, "account_ref"),
    market: input.market,
    side: input.side ?? null,
    clientOrderId: bounded(input.clientOrderId, PRINTABLE_ID, "client_order_id"),
    venueOrderId: bounded(input.venueOrderId, PRINTABLE_ID, "venue_order_id"),
    transactionSignature: bounded(input.transactionSignature, PRINTABLE_ID, "transaction_signature"),
    venueStatus: input.venueStatus ?? null,
    price: finiteDecimal(input.price, "price"),
    sizeBase: finiteDecimal(input.sizeBase, "size_base", true),
    fee: finiteDecimal(input.fee, "fee", true),
    realizedPnl: finiteDecimal(input.realizedPnl, "realized_pnl"),
    failureCode: input.failureCode ?? null,
    recordedAfterBroadcast: input.recordedAfterBroadcast === true,
  };
}

function eventIdentity(event: CanonicalEvent, observedAt: Date): string {
  const ordered = [
    event.attemptId, event.botId, event.decisionId, event.action, event.cause, event.eventType, event.phase,
    event.protocol, event.accountScope, event.accountRef, event.market, event.side, event.clientOrderId,
    event.venueOrderId, event.transactionSignature, event.venueStatus, event.price, event.sizeBase,
    event.fee, event.realizedPnl, event.failureCode, event.recordedAfterBroadcast, observedAt.toISOString(),
  ];
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").toUpperCase();
}

function rowValues(event: CanonicalEvent, observedAt: Date) {
  return { ...event, eventIdentity: eventIdentity(event, observedAt), observedAt };
}

export function entryAttemptId(decisionId: string): string {
  if (!INTERNAL_ID.test(decisionId)) throw new Error("execution_journal_invalid_decision_id");
  return `entry:${decisionId}`;
}

export function newMutationAttemptId(action: "close" | "cancel", decisionId: string | null): string {
  if (decisionId !== null && !INTERNAL_ID.test(decisionId)) throw new Error("execution_journal_invalid_decision_id");
  return `${action}:${decisionId ?? "unattributed"}:${randomUUID()}`;
}

export function journalBase(
  bot: Pick<AiTraderBot, "id" | "protocol" | "protocolSubaccountId" | "walletAddress" | "market">,
  decisionId: string | null,
) {
  return {
    botId: bot.id,
    decisionId,
    protocol: bot.protocol,
    accountScope: bot.protocolSubaccountId ? "bot_subaccount" as const : "main" as const,
    accountRef: bot.protocolSubaccountId ?? bot.walletAddress,
    market: bot.market,
  };
}

export async function appendExecutionEvents(inputs: readonly JournalEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const { db } = await import("../db");
  const attemptId = inputs[0].attemptId;
  if (inputs.some((input) => input.attemptId !== attemptId)) throw new Error("execution_journal_mixed_attempt_batch");
  const values = inputs.map((input) => rowValues(canonicalize(input), input.observedAt ?? new Date()));

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_TRADER_EXECUTION_JOURNAL_LOCK_NAMESPACE}, hashtext(${attemptId}))`);
    const existing = await tx.select({
      eventIdentity: aiTraderExecutionEvents.eventIdentity,
      phase: aiTraderExecutionEvents.phase,
    }).from(aiTraderExecutionEvents).where(eq(aiTraderExecutionEvents.attemptId, attemptId));
    const identities = new Set(existing.map((row) => row.eventIdentity));
    let maxPhase = existing.reduce<number>((max, row) => row.phase === null ? max : Math.max(max, row.phase), -1);

    for (const value of values) {
      if (identities.has(value.eventIdentity)) continue;
      if (value.phase !== null) {
        const sparseNonBroadcastTerminal = value.phase === 90 && maxPhase === 0
          && (value.cause === "paper" || value.cause === "venue_detected");
        const expected = maxPhase < 0 ? 0 : maxPhase === 0 ? 10 : maxPhase === 10 ? 20 : maxPhase === 20 ? 90 : null;
        if (!sparseNonBroadcastTerminal && (expected === null || value.phase !== expected)) {
          throw new Error("execution_journal_command_phase_conflict");
        }
      }
      await tx.insert(aiTraderExecutionEvents).values(value).onConflictDoNothing({ target: aiTraderExecutionEvents.eventIdentity });
      identities.add(value.eventIdentity);
      if (value.phase !== null) maxPhase = value.phase;
    }
  });
}

export async function appendRequiredEntryPrebroadcast(args: {
  bot: Pick<AiTraderBot, "id" | "protocol" | "protocolSubaccountId" | "walletAddress" | "market">;
  decisionId: string;
  side: "long" | "short";
  clientOrderId: string;
  sizeBase: number;
}): Promise<string> {
  const attemptId = entryAttemptId(args.decisionId);
  const base = journalBase(args.bot, args.decisionId);
  await appendExecutionEvents([
    { ...base, attemptId, action: "entry", cause: "decision", eventType: "attempt_claimed", side: args.side },
    { ...base, attemptId, action: "entry", cause: "decision", eventType: "prebroadcast_authorized",
      side: args.side, clientOrderId: args.clientOrderId, sizeBase: args.sizeBase },
  ]);
  return attemptId;
}

const bestEffortTails = new Map<string, Promise<void>>();

export function safeAppendExecutionEvents(inputs: readonly JournalEventInput[]): void {
  if (inputs.length === 0) return;
  const attemptId = inputs[0].attemptId;
  const action = inputs[0].action;
  const eventType = inputs[inputs.length - 1].eventType;
  // Preserve call-site order without awaiting the money path. This prevents a
  // fast terminal append overtaking its own broadcast-result append while the
  // database lock still protects cross-process ordering.
  const previous = bestEffortTails.get(attemptId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => appendExecutionEvents(inputs))
    .catch(() => {
      const line = `[AiTraderExecutionJournal] best-effort append failed action=${action} event=${eventType}`;
      console.warn(line);
      appendTelemetry(line);
    })
    .finally(() => {
      if (bestEffortTails.get(attemptId) === current) bestEffortTails.delete(attemptId);
    });
  bestEffortTails.set(attemptId, current);
}

export function orderResultEvent(args: {
  base: ReturnType<typeof journalBase>;
  attemptId: string;
  action: JournalAction;
  cause: JournalCause;
  order: OrderResult | null;
  clientOrderId?: string | null;
  recordedAfterBroadcast?: boolean;
  failureCode?: JournalFailureCode | null;
}): JournalEventInput {
  const order = args.order;
  return {
    ...args.base,
    attemptId: args.attemptId,
    action: args.action,
    cause: args.cause,
    eventType: "broadcast_result",
    clientOrderId: order?.clientOrderId ?? args.clientOrderId ?? null,
    venueOrderId: order?.orderId ?? null,
    venueStatus: order?.status ?? "unknown",
    price: order?.fillPrice ?? null,
    sizeBase: order?.fillSize ?? null,
    fee: order?.fee ?? null,
    failureCode: args.failureCode ?? (order?.success ? null : order?.status === "rejected" ? "venue_rejected" : "venue_unconfirmed"),
    recordedAfterBroadcast: args.recordedAfterBroadcast === true,
  };
}

export async function readExecutionJournalPage(args: {
  botId: string;
  decisionId?: string;
  limit: number;
  before?: Date;
  beforeId?: string;
}): Promise<{ events: Array<Omit<AiTraderExecutionEvent, "accountRef">>; nextCursor: { before: string; beforeId: string } | null }> {
  const { db } = await import("../db");
  const predicates = [eq(aiTraderExecutionEvents.botId, args.botId)];
  if (args.decisionId) predicates.push(eq(aiTraderExecutionEvents.decisionId, args.decisionId));
  if (args.before && args.beforeId) {
    predicates.push(or(
      lt(aiTraderExecutionEvents.recordedAt, args.before),
      and(eq(aiTraderExecutionEvents.recordedAt, args.before), lt(aiTraderExecutionEvents.id, args.beforeId)),
    )!);
  }
  const rows = await db.select().from(aiTraderExecutionEvents)
    .where(and(...predicates))
    .orderBy(desc(aiTraderExecutionEvents.recordedAt), desc(aiTraderExecutionEvents.id))
    .limit(args.limit + 1);
  const page = rows.slice(0, args.limit);
  const events = page.map(({ accountRef: _accountRef, ...event }) => event);
  const last = page[page.length - 1];
  return {
    events,
    nextCursor: rows.length > args.limit && last
      ? { before: last.recordedAt.toISOString(), beforeId: last.id }
      : null,
  };
}
