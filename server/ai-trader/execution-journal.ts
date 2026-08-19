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

type ExecutionJournalDb = (typeof import("../db"))["db"];
export type ExecutionJournalTransaction = Parameters<Parameters<ExecutionJournalDb["transaction"]>[0]>[0];

export type PreparedExecutionJournalAppend = {
  status: "pending" | "replayed";
  insert(): Promise<void>;
};

export function isExecutionJournalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("execution_journal_invalid_")
    || error.message === "execution_journal_mixed_attempt_batch"
    || error.message === "execution_journal_command_phase_conflict"
    || error.message === "execution_journal_atomic_replay_conflict"
    || error.message === "execution_journal_entry_command_lineage_conflict";
}

export function isConfirmedCloseReplayIdentityConflict(error: unknown): boolean {
  return error instanceof Error
    && error.message === "execution_journal_close_replay_identity_conflict";
}

export type ConfirmedCloseJournalBatchExpectation = {
  botId: string;
  decisionId: string;
  side: "long" | "short";
  sizeBase: number;
  close: {
    exitPrice: number | null;
    realizedPnl: number | null;
    feesPaid: number | null;
    closedAt: Date;
  };
};

/**
 * Strict shape check for a journal batch which accompanies an already-confirmed
 * close. This is deliberately pure: callers can degrade the journal without
 * allowing malformed evidence to veto the authoritative close transition.
 */
export function isExactConfirmedCloseJournalBatch(
  inputs: readonly JournalEventInput[],
  expected: ConfirmedCloseJournalBatchExpectation,
): boolean {
  if (inputs.length === 0
      || !Number.isFinite(expected.sizeBase) || expected.sizeBase <= 0
      || !(expected.close.closedAt instanceof Date)
      || !Number.isFinite(expected.close.closedAt.getTime())) return false;
  const first = inputs[0];
  const allowedCause = first.cause === "paper" || first.cause === "protective"
    || first.cause === "user_requested" || first.cause === "venue_detected";
  if (!allowedCause || first.action !== "close") return false;
  const expectedTypes = first.cause === "paper" || first.cause === "venue_detected"
    ? ["attempt_claimed", "fill_observed", "close_terminal_confirmed"]
    : ["attempt_claimed", "broadcast_attempted", "broadcast_result", "fill_observed", "close_terminal_confirmed"];
  if (inputs.length !== expectedTypes.length
      || inputs.some((event, index) => event.eventType !== expectedTypes[index])) return false;
  const sameNullable = (left: unknown, right: unknown) => (left ?? null) === (right ?? null);
  for (const event of inputs) {
    if (event.attemptId !== first.attemptId
        || event.botId !== expected.botId
        || event.decisionId !== expected.decisionId
        || event.action !== "close"
        || event.cause !== first.cause
        || event.protocol !== first.protocol
        || event.accountScope !== first.accountScope
        || !sameNullable(event.accountRef, first.accountRef)
        || event.market !== first.market
        || event.side !== expected.side
        || !(event.observedAt instanceof Date)
        || event.observedAt.getTime() !== expected.close.closedAt.getTime()) return false;
  }
  const terminals = inputs.filter((event) => event.eventType === "close_terminal_confirmed");
  if (terminals.length !== 1 || inputs.some((event) => event.eventType === "close_terminal_failed")) return false;
  const terminal = terminals[0];
  const fill = inputs.find((event) => event.eventType === "fill_observed");
  if (!fill) return false;
  for (const event of [fill, terminal]) {
    if (!sameNullable(event.price, expected.close.exitPrice)
        || Number(event.sizeBase) !== expected.sizeBase
        || !sameNullable(event.fee, expected.close.feesPaid)
        || !sameNullable(event.realizedPnl, expected.close.realizedPnl)
        || (event.failureCode ?? null) !== null) return false;
  }
  return true;
}

/**
 * Replay is rooted in the decision's retained close terminal, not the advisory
 * lock keyed by the caller's attempt. A missing or different retained terminal
 * cannot prove identity and is therefore a typed replay conflict.
 */
export async function prepareConfirmedCloseJournalReplayInTransaction(
  tx: ExecutionJournalTransaction,
  inputs: readonly JournalEventInput[],
): Promise<PreparedExecutionJournalAppend> {
  const first = inputs[0];
  if (!first || first.decisionId === null) {
    throw new Error("execution_journal_close_replay_identity_conflict");
  }
  const terminals = await tx.select({ attemptId: aiTraderExecutionEvents.attemptId })
    .from(aiTraderExecutionEvents)
    .where(and(
      eq(aiTraderExecutionEvents.decisionId, first.decisionId),
      eq(aiTraderExecutionEvents.action, "close"),
      eq(aiTraderExecutionEvents.eventType, "close_terminal_confirmed"),
    ))
    .limit(2);
  if (terminals.length !== 1 || terminals[0].attemptId !== first.attemptId) {
    throw new Error("execution_journal_close_replay_identity_conflict");
  }
  return prepareExecutionJournalEventsInTransaction(
    tx,
    inputs,
    { requireExactBatchReplay: true },
  );
}

/**
 * Validate and lock one journal batch inside a caller-owned transaction.
 * The returned insert step deliberately runs after the caller's row predicates,
 * while the advisory lock remains held for the whole transaction.
 */
export async function prepareExecutionJournalEventsInTransaction(
  tx: ExecutionJournalTransaction,
  inputs: readonly JournalEventInput[],
  options: { requireExactBatchReplay?: boolean; requireEntryCommandLineage?: boolean } = {},
): Promise<PreparedExecutionJournalAppend> {
  if (inputs.length === 0) {
    return { status: "replayed", insert: async () => undefined };
  }
  const attemptId = inputs[0].attemptId;
  if (inputs.some((input) => input.attemptId !== attemptId)) throw new Error("execution_journal_mixed_attempt_batch");
  const values = inputs.map((input) => rowValues(canonicalize(input), input.observedAt ?? new Date()));
  if (options.requireExactBatchReplay
      && new Set(values.map((value) => value.eventIdentity)).size !== values.length) {
    throw new Error("execution_journal_atomic_replay_conflict");
  }

  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_TRADER_EXECUTION_JOURNAL_LOCK_NAMESPACE}, hashtext(${attemptId}))`);
  const existing = await tx.select({
    eventIdentity: aiTraderExecutionEvents.eventIdentity,
    attemptId: aiTraderExecutionEvents.attemptId,
    botId: aiTraderExecutionEvents.botId,
    decisionId: aiTraderExecutionEvents.decisionId,
    action: aiTraderExecutionEvents.action,
    cause: aiTraderExecutionEvents.cause,
    eventType: aiTraderExecutionEvents.eventType,
    phase: aiTraderExecutionEvents.phase,
    protocol: aiTraderExecutionEvents.protocol,
    accountScope: aiTraderExecutionEvents.accountScope,
    accountRef: aiTraderExecutionEvents.accountRef,
    market: aiTraderExecutionEvents.market,
  }).from(aiTraderExecutionEvents).where(eq(aiTraderExecutionEvents.attemptId, attemptId));
  const identities = new Set(existing.map((row) => row.eventIdentity));

  if (options.requireEntryCommandLineage) {
    const expected = values[0];
    const phase0 = existing.filter((row) => row.phase === 0);
    const phase10 = existing.filter((row) => row.phase === 10);
    const valid = expected.action === "entry"
      && expected.cause === "decision"
      && phase0.length === 1
      && phase10.length === 1
      && phase0[0].eventType === "attempt_claimed"
      && phase10[0].eventType === "prebroadcast_authorized"
      && sameRecoveryIdentity(phase0[0], expected)
      && sameRecoveryIdentity(phase10[0], expected);
    if (!valid) throw new Error("execution_journal_entry_command_lineage_conflict");
  }

  if (options.requireExactBatchReplay && existing.length > 0) {
    const exactReplay = existing.length === values.length
      && values.every((value) => identities.has(value.eventIdentity));
    if (!exactReplay) throw new Error("execution_journal_atomic_replay_conflict");
    return { status: "replayed", insert: async () => undefined };
  }

  let maxPhase = existing.reduce<number>((max, row) => row.phase === null ? max : Math.max(max, row.phase), -1);
  const pending: typeof values = [];

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
    pending.push(value);
    identities.add(value.eventIdentity);
    if (value.phase !== null) maxPhase = value.phase;
  }

  return {
    status: pending.length === 0 ? "replayed" : "pending",
    insert: async () => {
      for (const value of pending) {
        await tx.insert(aiTraderExecutionEvents).values(value).onConflictDoNothing({ target: aiTraderExecutionEvents.eventIdentity });
      }
    },
  };
}

export async function appendExecutionEvents(inputs: readonly JournalEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const { db } = await import("../db");
  await db.transaction(async (tx) => {
    const prepared = await prepareExecutionJournalEventsInTransaction(tx, inputs);
    await prepared.insert();
  });
}

type EntryReconciliationTerminalArgs = {
  base: ReturnType<typeof journalBase>;
  attemptId: string;
  observedAt?: Date;
} & (
  | {
      terminal: "entry_terminal_open";
      proof: { kind: "landed_position"; side: "long" | "short"; price: number; sizeBase: number };
    }
  | {
      terminal: "entry_terminal_unwound";
      proof: { kind: "landed_then_unwound"; side: "long" | "short"; price: number; sizeBase: number };
    }
  | {
      terminal: "entry_terminal_no_land";
      proof: { kind: "flat_after_landing_window" };
    }
);

function sameRecoveryIdentity(
  row: Pick<AiTraderExecutionEvent,
    "attemptId" | "botId" | "decisionId" | "action" | "cause" | "protocol" |
    "accountScope" | "accountRef" | "market">,
  expected: CanonicalEvent,
): boolean {
  return row.attemptId === expected.attemptId
    && row.botId === expected.botId
    && row.decisionId === expected.decisionId
    && row.action === expected.action
    && row.cause === expected.cause
    && row.protocol === expected.protocol
    && row.accountScope === expected.accountScope
    && row.accountRef === expected.accountRef
    && row.market === expected.market;
}

/**
 * Journal A: atomically append one conclusive reconciliation fact and its
 * phase-90 entry terminal when the durable command lineage is exactly 0,10.
 * This never reconstructs phase 20 and never authorizes a venue mutation.
 */
export async function appendEntryReconciliationTerminal(args: EntryReconciliationTerminalArgs): Promise<void> {
  if (!args.base.decisionId || args.attemptId !== entryAttemptId(args.base.decisionId)) {
    throw new Error("execution_journal_recovery_identity_mismatch");
  }
  const observedAt = args.observedAt ?? new Date();
  let evidence: JournalEventInput;
  let terminal: JournalEventInput;
  if (args.proof.kind === "flat_after_landing_window") {
    if (args.terminal !== "entry_terminal_no_land") {
      throw new Error("execution_journal_recovery_ambiguous_evidence");
    }
    evidence = {
      ...args.base, attemptId: args.attemptId, action: "entry", cause: "decision",
      eventType: "reconciliation_observed", failureCode: "position_not_confirmed", observedAt,
    };
    terminal = {
      ...args.base, attemptId: args.attemptId, action: "entry", cause: "decision",
      eventType: "entry_terminal_no_land", failureCode: "position_not_confirmed",
      recordedAfterBroadcast: false, observedAt,
    };
  } else {
    if (args.terminal === "entry_terminal_no_land"
        || !Number.isFinite(args.proof.price) || args.proof.price <= 0
        || !Number.isFinite(args.proof.sizeBase) || args.proof.sizeBase <= 0) {
      throw new Error("execution_journal_recovery_ambiguous_evidence");
    }
    evidence = {
      ...args.base, attemptId: args.attemptId, action: "entry", cause: "decision",
      eventType: "reconciliation_observed", side: args.proof.side,
      price: args.proof.price, sizeBase: args.proof.sizeBase, observedAt,
    };
    terminal = {
      ...args.base, attemptId: args.attemptId, action: "entry", cause: "decision",
      eventType: args.terminal, side: args.proof.side,
      price: args.proof.price, sizeBase: args.proof.sizeBase,
      recordedAfterBroadcast: true, observedAt,
    };
  }
  const values = [evidence, terminal].map((input) => rowValues(canonicalize(input), observedAt));
  const { db } = await import("../db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_TRADER_EXECUTION_JOURNAL_LOCK_NAMESPACE}, hashtext(${args.attemptId}))`);
    const existing = await tx.select({
      eventIdentity: aiTraderExecutionEvents.eventIdentity,
      attemptId: aiTraderExecutionEvents.attemptId,
      botId: aiTraderExecutionEvents.botId,
      decisionId: aiTraderExecutionEvents.decisionId,
      action: aiTraderExecutionEvents.action,
      cause: aiTraderExecutionEvents.cause,
      eventType: aiTraderExecutionEvents.eventType,
      phase: aiTraderExecutionEvents.phase,
      protocol: aiTraderExecutionEvents.protocol,
      accountScope: aiTraderExecutionEvents.accountScope,
      accountRef: aiTraderExecutionEvents.accountRef,
      market: aiTraderExecutionEvents.market,
    }).from(aiTraderExecutionEvents).where(eq(aiTraderExecutionEvents.attemptId, args.attemptId));

    const requestedIdentities = values.map((value) => value.eventIdentity);
    const alreadyPresent = requestedIdentities.filter((identity) =>
      existing.some((row) => row.eventIdentity === identity));
    const phase0 = existing.filter((row) => row.phase === 0);
    const phase10 = existing.filter((row) => row.phase === 10);
    if (phase0.length !== 1 || phase10.length !== 1) {
      throw new Error("execution_journal_recovery_missing_command_lineage");
    }
    if (!sameRecoveryIdentity(phase0[0], values[0]) || !sameRecoveryIdentity(phase10[0], values[0])) {
      throw new Error("execution_journal_recovery_identity_mismatch");
    }
    if (phase0[0].eventType !== "attempt_claimed" || phase10[0].eventType !== "prebroadcast_authorized") {
      throw new Error("execution_journal_recovery_missing_command_lineage");
    }
    if (existing.some((row) => row.phase === 20)) {
      throw new Error("execution_journal_recovery_phase20_present");
    }
    const phase90 = existing.filter((row) => row.phase === 90);
    if (alreadyPresent.length === requestedIdentities.length) {
      if (phase90.length === 1 && phase90[0].eventIdentity === values[1].eventIdentity) return;
      throw new Error("execution_journal_recovery_terminal_present");
    }
    if (alreadyPresent.length !== 0) throw new Error("execution_journal_recovery_partial_transaction");
    if (phase90.length !== 0) {
      throw new Error("execution_journal_recovery_terminal_present");
    }

    for (const value of values) {
      await tx.insert(aiTraderExecutionEvents).values(value);
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

function enqueueBestEffort(
  attemptId: string,
  action: JournalAction,
  eventType: JournalEventType,
  append: () => Promise<void>,
): void {
  const previous = bestEffortTails.get(attemptId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(append)
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

export function safeAppendExecutionEvents(inputs: readonly JournalEventInput[]): void {
  if (inputs.length === 0) return;
  const attemptId = inputs[0].attemptId;
  const action = inputs[0].action;
  const eventType = inputs[inputs.length - 1].eventType;
  // Preserve call-site order without awaiting the money path. This prevents a
  // fast terminal append overtaking its own broadcast-result append while the
  // database lock still protects cross-process ordering.
  enqueueBestEffort(attemptId, action, eventType, () => appendExecutionEvents(inputs));
}

export function safeAppendEntryReconciliationTerminal(args: EntryReconciliationTerminalArgs): void {
  enqueueBestEffort(args.attemptId, "entry", args.terminal, () => appendEntryReconciliationTerminal(args));
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
