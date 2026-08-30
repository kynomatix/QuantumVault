import { storage, DatabaseStorage } from "./storage";
import { normalizeMarket } from "./protocol/symbol-registry";
import { getDefaultAdapter, getAdapterForBot } from "./protocol/adapter-registry";
import type { TradeRecord } from "./protocol/protocol-types";
import type { ProtocolAdapter } from "./protocol/adapter";
import type { TradingBot } from "@shared/schema";
import { sendTradeNotification, getCloseReasonLabel, schedulePartialCloseNotification } from "./notification-service";
import { maybeScheduleAutoRepark, cancelAutoRepark } from "./vault/auto-repark";
import {
  PARTIAL_CLOSE_BASE_DUST,
  partialCloseIdentityMatches,
} from "./trading/signal-bot-close-integrity";

export interface RecoveredCloseRoutingSignal {
  action: 'buy' | 'sell';
  contracts: string;
  positionSize: string;
  price: string;
  isCloseSignal: boolean;
  strategyPositionSize: string;
  partialCloseFraction?: number;
}

type RecoveredCloseRoutingCallback = (
  sourceBotId: string,
  signal: RecoveredCloseRoutingSignal,
) => Promise<void>;

let recoveredCloseRoutingCallback: RecoveredCloseRoutingCallback | null = null;

export function registerRecoveredCloseRoutingCallback(callback: RecoveredCloseRoutingCallback): void {
  recoveredCloseRoutingCallback = callback;
}

export function buildRecoveredPartialCloseRoutingSignal(input: {
  preCloseBaseSize: number;
  requestedClosedSize: number;
  residualBaseSize: number;
  price: number;
}): RecoveredCloseRoutingSignal | null {
  if (![input.preCloseBaseSize, input.requestedClosedSize, input.residualBaseSize, input.price].every(Number.isFinite)
      || Math.abs(input.preCloseBaseSize) < PARTIAL_CLOSE_BASE_DUST
      || input.requestedClosedSize < PARTIAL_CLOSE_BASE_DUST
      || input.price <= 0) return null;
  const fraction = input.requestedClosedSize / Math.abs(input.preCloseBaseSize);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return null;
  const residual = String(input.residualBaseSize);
  return {
    action: input.preCloseBaseSize > 0 ? 'sell' : 'buy',
    contracts: String(input.requestedClosedSize),
    positionSize: residual,
    strategyPositionSize: residual,
    price: String(input.price),
    isCloseSignal: false,
    partialCloseFraction: fraction,
  };
}

export function buildRecoveredFullCloseRoutingSignal(input: {
  preCloseBaseSize: number;
  price: number;
}): RecoveredCloseRoutingSignal | null {
  if (!Number.isFinite(input.preCloseBaseSize)
      || Math.abs(input.preCloseBaseSize) < PARTIAL_CLOSE_BASE_DUST
      || !Number.isFinite(input.price)
      || input.price <= 0) return null;
  return {
    action: input.preCloseBaseSize > 0 ? 'sell' : 'buy',
    contracts: String(Math.abs(input.preCloseBaseSize)),
    positionSize: '0',
    strategyPositionSize: '0',
    price: String(input.price),
    isCloseSignal: true,
  };
}

interface PendingPartialCloseTradeLike {
  id: string;
  status: string;
  market: string;
  side: string;
  size: string;
  executedAt?: Date | string | null;
  txSignature?: string | null;
  protocolFillId?: string | null;
  protocol?: string | null;
  webhookPayload?: unknown;
}

interface PartialMarkerPayload {
  partialClose: true;
  partialCloseAccounting: {
    expectedBaseSize: string;
    expectedLastTradeId: string | null;
    requestedClosedSize: number;
  };
  executionAccounting?: {
    price?: number | null;
    priceAuthority?: string | null;
    fee?: number | null;
    pnl?: number | null;
  };
  subscriberRouting?: Record<string, unknown>;
  feeEvidence?: { kind?: string };
}

function partialMarkerPayload(trade: PendingPartialCloseTradeLike): PartialMarkerPayload | null {
  const payload = trade.webhookPayload && typeof trade.webhookPayload === 'object'
    ? trade.webhookPayload as Record<string, unknown>
    : null;
  const accounting = payload?.partialCloseAccounting;
  if (String(trade.status).toLowerCase() !== 'pending'
      || payload?.partialClose !== true
      || !accounting
      || typeof accounting !== 'object') return null;
  return payload as unknown as PartialMarkerPayload;
}

function markerAgeWithinRecoveryHorizon(trade: PendingPartialCloseTradeLike, nowMs: number): boolean {
  const executedAt = trade.executedAt ? new Date(trade.executedAt).getTime() : Number.NaN;
  const ageMs = nowMs - executedAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 60 * 60 * 1000;
}

function markerMatchesLockedEpoch(input: {
  trade: PendingPartialCloseTradeLike;
  payload: PartialMarkerPayload;
  market: string;
  closeSide: 'long' | 'short';
  dbBaseSize: number;
  dbLastTradeId: string | null;
  nowMs: number;
}): boolean {
  const accounting = input.payload.partialCloseAccounting;
  const expectedBaseSize = Number(accounting.expectedBaseSize);
  return normalizeMarket(input.trade.market) === normalizeMarket(input.market)
    && String(input.trade.side).toLowerCase() === input.closeSide
    && Number.isFinite(expectedBaseSize)
    && Math.abs(expectedBaseSize - input.dbBaseSize) <= PARTIAL_CLOSE_BASE_DUST
    && (accounting.expectedLastTradeId ?? null) === input.dbLastTradeId
    && markerAgeWithinRecoveryHorizon(input.trade, input.nowMs);
}

export type PendingPartialMarkerSelection =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string; markerIds: string[] }
  | { kind: 'eligible'; trade: PendingPartialCloseTradeLike; payload: PartialMarkerPayload; matchedFillIds: string[] };

export function selectPendingPartialCloseMarker(input: {
  trades: PendingPartialCloseTradeLike[];
  protocol: string;
  market: string;
  closeSide: 'long' | 'short';
  dbBaseSize: number;
  dbLastTradeId: string | null;
  closedSlice: number;
  closingFills: TradeRecord[];
  nowMs: number;
}): PendingPartialMarkerSelection {
  const pending = input.trades
    .map((trade) => ({ trade, payload: partialMarkerPayload(trade) }))
    .filter((item): item is { trade: PendingPartialCloseTradeLike; payload: PartialMarkerPayload } => item.payload !== null)
    .filter(({ trade }) => normalizeMarket(trade.market) === normalizeMarket(input.market)
      && String(trade.side).toLowerCase() === input.closeSide);
  if (pending.length === 0) return { kind: 'none' };

  const eligible = pending.filter(({ trade, payload }) => {
    const accounting = payload.partialCloseAccounting;
    const requested = Number(accounting.requestedClosedSize);
    const execution = payload.executionAccounting;
    const expectedAuthority = input.protocol.toLowerCase() === 'pacifica'
      ? 'venue_execution'
      : 'adapter_submit_oracle_estimate';
    const moneyValid = execution
      && Number.isFinite(execution.price) && Number(execution.price) > 0
      && execution.priceAuthority === expectedAuthority
      && Number.isFinite(execution.fee) && Number(execution.fee) >= 0
      && Number.isFinite(execution.pnl)
      && payload.feeEvidence?.kind !== 'unavailable';
    if (!markerMatchesLockedEpoch({
      trade,
      payload,
      market: input.market,
      closeSide: input.closeSide,
      dbBaseSize: input.dbBaseSize,
      dbLastTradeId: input.dbLastTradeId,
      nowMs: input.nowMs,
    })
        || !Number.isFinite(requested)
        || Math.abs(requested - input.closedSlice) > PARTIAL_CLOSE_BASE_DUST
        || !moneyValid) return false;
    if (input.protocol.toLowerCase() === 'pacifica') {
      return input.closingFills.some((fill) => partialCloseIdentityMatches({
        transactionSignature: trade.txSignature,
        protocolFillId: trade.protocolFillId,
        orderId: fill.orderId,
        tradeId: fill.tradeId,
      }));
    }
    return typeof trade.txSignature === 'string' && trade.txSignature.trim().length > 0;
  });

  if (eligible.length !== 1) {
    return {
      kind: 'blocked',
      reason: eligible.length === 0
        ? 'pending_partial_marker_identity_or_money_unavailable'
        : 'pending_partial_marker_ambiguous',
      markerIds: pending.map(({ trade }) => trade.id),
    };
  }
  const selected = eligible[0];
  const matchedFillIds = input.closingFills
    .filter((fill) => partialCloseIdentityMatches({
      transactionSignature: selected.trade.txSignature,
      protocolFillId: selected.trade.protocolFillId,
      orderId: fill.orderId,
      tradeId: fill.tradeId,
    }))
    .flatMap((fill) => [fill.orderId, fill.tradeId].filter((value): value is string => Boolean(value)));
  return { kind: 'eligible', ...selected, matchedFillIds };
}

export function selectPendingPartialMarkerForFullClose(input: {
  trades: PendingPartialCloseTradeLike[];
  market: string;
  closeSide: 'long' | 'short';
  dbBaseSize: number;
  dbLastTradeId: string | null;
  fillTradeIds: string[];
  fillOrderIds: string[];
  nowMs: number;
}): PendingPartialMarkerSelection {
  const rawPending = input.trades
    .map((trade) => ({ trade, payload: partialMarkerPayload(trade) }))
    .filter((item): item is { trade: PendingPartialCloseTradeLike; payload: PartialMarkerPayload } => item.payload !== null)
    .filter(({ trade }) => normalizeMarket(trade.market) === normalizeMarket(input.market)
      && String(trade.side).toLowerCase() === input.closeSide);
  if (rawPending.length === 0) return { kind: 'none' };
  const pending = rawPending
    .filter(({ trade, payload }) => markerMatchesLockedEpoch({
      trade,
      payload,
      market: input.market,
      closeSide: input.closeSide,
      dbBaseSize: input.dbBaseSize,
      dbLastTradeId: input.dbLastTradeId,
      nowMs: input.nowMs,
    }));
  if (pending.length === 0) {
    return {
      kind: 'blocked',
      reason: 'liquidation_pending_fill_identity',
      markerIds: rawPending.map(({ trade }) => trade.id),
    };
  }
  const eligible = pending.filter(({ trade }) => {
    const pairs = [
      ...input.fillOrderIds.map((orderId) => ({ orderId, tradeId: undefined })),
      ...input.fillTradeIds.map((tradeId) => ({ orderId: undefined, tradeId })),
    ];
    return pairs.some((pair) => partialCloseIdentityMatches({
      transactionSignature: trade.txSignature,
      protocolFillId: trade.protocolFillId,
      ...pair,
    }));
  });
  if (eligible.length !== 1) {
    return {
      kind: 'blocked',
      reason: eligible.length === 0
        ? 'liquidation_pending_fill_identity'
        : 'pending_partial_full_close_ambiguous',
      markerIds: pending.map(({ trade }) => trade.id),
    };
  }
  return { kind: 'eligible', ...eligible[0], matchedFillIds: [...input.fillOrderIds, ...input.fillTradeIds] };
}

/**
 * Auto-repark scheduling hook. Called at every position-transition return point:
 * when a bot becomes FLAT we arm the debounce deadline (the periodic scanner
 * re-verifies flat on-chain and parks); when it still has (or opens) a position
 * we cancel any pending repark. Storage-only, key-free, and best-effort — it
 * never throws into the close/sync path. Venue + opt-in gating live inside
 * maybeScheduleAutoRepark.
 */
async function applyAutoReparkTransition(
  bot: Pick<TradingBot, "id" | "autoParkIdle" | "activeProtocol" | "parkDestinationAsset">,
  becameFlat: boolean,
): Promise<void> {
  if (becameFlat) {
    await maybeScheduleAutoRepark(bot);
  } else {
    await cancelAutoRepark(bot.id);
  }
}

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

async function fetchPerpPositions(agentPublicKey: string, subaccountId: number, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<{ positions: any[]; fetchFailed: boolean }> {
  try {
    const positions = await adapter.getPositions(agentPublicKey, _subIdStr(subaccountId));
    return { positions: positions.map(p => ({
      marketIndex: 0,
      market: p.internalSymbol,
      baseAssetAmount: p.baseSize,
      side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealizedPnl: p.unrealizedPnl,
      unrealizedPnlPercent: p.entryPrice > 0
        ? ((p.markPrice - p.entryPrice) / p.entryPrice) * 100 * (p.baseSize >= 0 ? 1 : -1)
        : 0,
    })), fetchFailed: false };
  } catch (err) {
    console.log(`[fetchPerpPositions] Failed to fetch positions: ${err instanceof Error ? err.message : err}`);
    return { positions: [], fetchFailed: true };
  }
}

async function fetchMarketPrice(market: string, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<number | null> {
  try {
    return await adapter.getPrice(market);
  } catch {
    return null;
  }
}

const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds
const RECONCILE_INTERVAL_MS = 60 * 1000; // 60 seconds

let reconcileInterval: NodeJS.Timeout | null = null;
let periodicReconciliationCycleInFlight = false;
const lastReconcileTime = new Map<string, number>();

// ── Phantom-close corroboration state ────────────────────────────────────
// A single empty-but-successful getPositions read once booked a phantom
// external_close with a fabricated market-price PnL (the venue read glitched
// while the position was actually still open). Estimation-based closes (no
// fill evidence) now require the position to read empty across at least two
// reconcile ticks spanning ESTIMATION_CORROBORATION_MS, plus a final fresh
// re-read immediately before booking. Fill-backed closes and liquidation
// (equity+balance≈0) remain immediate — they carry their own evidence.
// Key: `${botId}:${normalizedMarket}` → first-empty-sighting epoch ms.
const estimationCloseFirstSeen = new Map<string, number>();
const ESTIMATION_CORROBORATION_MS = 90 * 1000; // ≥2 ticks at 60s cadence
const ESTIMATION_CANDIDATE_TTL_MS = 30 * 60 * 1000;
const ESTIMATION_CANDIDATE_MAX = 500;

function unknownProtocolSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const symbol = value.trim();
  return symbol.toUpperCase().startsWith('UNKNOWN-') ? symbol : null;
}

function estimationCloseKey(botId: string, market: string): string {
  return `${botId}:${normalizeMarket(market)}`;
}

/**
 * Canonical identity for reconciler-detected full closes.
 *
 * A venue fill ID is authoritative when present. A no-fill close must instead
 * bind to the durable entry epoch already stored on bot_positions. Estimate
 * price and observation time are intentionally absent: both changed across
 * the two phantom closes observed for one continuously open BTC position.
 */
export function canonicalReconcilerFullCloseId(input: {
  protocolFillId?: string | null;
  botId: string;
  market: string;
  positionEpochId?: string | null;
}): string | null {
  if (input.protocolFillId) {
    return DatabaseStorage.canonicalCloseFillId({
      signature: input.protocolFillId,
      botId: input.botId,
      side: 'close',
      size: 0,
      market: normalizeMarket(input.market),
    });
  }

  const positionEpochId = input.positionEpochId?.trim();
  if (!positionEpochId) return null;

  const normalizedMarket = normalizeMarket(input.market);
  return DatabaseStorage.canonicalCloseFillId({
    signature: `reconciler-position-epoch|${input.botId}|${normalizedMarket}|${positionEpochId}`,
    botId: input.botId,
    side: 'close',
    size: 0,
    market: normalizedMarket,
  });
}

/** Bounded-cache guard: drop stale candidates so deleted bots can't leak entries. */
function pruneEstimationCandidates(nowMs: number): void {
  if (estimationCloseFirstSeen.size < ESTIMATION_CANDIDATE_MAX) return;
  for (const [key, ts] of estimationCloseFirstSeen) {
    if (nowMs - ts > ESTIMATION_CANDIDATE_TTL_MS) estimationCloseFirstSeen.delete(key);
  }
}

interface CloseDetectionResult {
  detected: boolean;
  reason: 'tpsl' | 'liquidation' | 'external_close';
  fillPrice?: number;
  pnl?: number;
  fee?: number;
  /** First matched protocol fill ID (single canonical identifier — NOT a
   * joined string). Used as the canonical close-event signature input
   * for cross-path dedup with webhook/retry writers. */
  protocolFillId?: string;
  /** Comma-joined matched fill IDs, for diagnostics ONLY. Never use as
   * a dedup key — joined strings are not stable identifiers. */
  matchedFillIdsForDiagnostics?: string;
  /** Comma-joined matched order IDs, retained for exact signed-order recovery matching. */
  matchedOrderIdsForDiagnostics?: string;
  /** Timestamp of the matched closing fill, used for the deterministic
   * nosig fallback hash so repeated reconciler runs against the same
   * close hit the same time bucket. */
  fillTimestampMs?: number;
  /** When `reason === 'tpsl'`, which side was hit (used for notification text). */
  tpslSubtype?: 'TP' | 'SL';
}

function isExpectedClosingTrade(
  trade: TradeRecord,
  openSide: 'long' | 'short',
  closeSide: 'long' | 'short',
): boolean {
  const expectedKind = openSide === 'long' ? 'close_long' : 'close_short';
  return trade.venueEventKind !== undefined
    ? trade.venueEventKind === expectedKind
    : trade.side === closeSide;
}

async function detectOnChainClose(
  botId: string,
  agentPublicKey: string,
  market: string,
  dbPosition: { baseSize: string; avgEntryPrice: string; realizedPnl?: string; totalFees?: string; lastTradeId?: string | null; lastTradeAt?: Date | null },
  botSubaccountPublicKey?: string,
  adapter: ProtocolAdapter = getDefaultAdapter(),
  /** Numeric subaccount ID for the legacy Drift-style path (no botSubaccountPublicKey).
   * Used ONLY by the corroboration confirm re-read so it queries the SAME scope
   * the caller's original positions read used. */
  positionSubAccountId?: number,
): Promise<CloseDetectionResult> {
  const noDetection: CloseDetectionResult = { detected: false, reason: 'external_close' };

  try {
    const normalizedMarket = normalizeMarket(market);
    const corroborationKey = estimationCloseKey(botId, market);
    const dbBaseSize = parseFloat(dbPosition.baseSize);
    const entryPrice = parseFloat(dbPosition.avgEntryPrice);
    const positionSide = dbBaseSize > 0 ? 'long' : 'short';
    const closeSide = positionSide === 'long' ? 'short' : 'long';
    const absSize = Math.abs(dbBaseSize);

    // For Pacifica external_key bots (where each bot has its own subaccount key),
    // the funded "account" on Pacifica IS the bot subaccount key itself — the
    // agent key is just a delegated signer with $0 balance. Querying with the
    // agent key returns 200 with zeros and falsely trips the liquidation
    // classifier. For Drift (no botSubaccountPublicKey) we keep the original
    // agent+subaccountId behavior unchanged.
    const readAccount = botSubaccountPublicKey || agentPublicKey;
    const readSubaccountId = botSubaccountPublicKey ? undefined : undefined; // Pacifica direct-sub mode doesn't need subaccount_id; Drift path also passes undefined here for /account-style reads

    let tradeHistoryFetchFailed = false;
    let unknownTradeSymbol: string | null = null;
    const fetchClosingFills = async (windowMs: number): Promise<TradeRecord[]> => {
      try {
        const startTime = Date.now() - windowMs;
        const trades = await adapter.getTradeHistory(readAccount, {
          limit: 200,
          maxPages: 10,
          internalSymbol: market,
          startTime,
          endTime: Date.now(),
          ...(readSubaccountId ? { subaccountId: readSubaccountId } : {}),
        });
        const unknownTrade = trades.find(t => unknownProtocolSymbol(t.internalSymbol));
        if (unknownTrade) {
          unknownTradeSymbol = unknownProtocolSymbol(unknownTrade.internalSymbol);
          console.error(
            `[Reconcile] Refusing close detection for ${botId} ${market} - ` +
            `trade-history evidence contains unknown protocol symbol "${unknownTradeSymbol}"`,
          );
          return [];
        }
        return trades
          .filter(t =>
            normalizeMarket(t.internalSymbol) === normalizedMarket &&
            isExpectedClosingTrade(t, positionSide, closeSide)
          )
          .sort((a, b) => b.timestamp - a.timestamp);
      } catch (err) {
        tradeHistoryFetchFailed = true;
        console.log(`[Reconcile] Trade history fetch failed for ${botId} (window=${windowMs}ms): ${err instanceof Error ? err.message : err}`);
        return [];
      }
    };

    const sumFillSize = (fills: TradeRecord[]) => fills.reduce((s, f) => s + f.size, 0);

    let closingFills = await fetchClosingFills(5 * 60 * 1000);
    if (unknownTradeSymbol) {
      estimationCloseFirstSeen.delete(corroborationKey);
      return noDetection;
    }
    if (sumFillSize(closingFills) < absSize * 0.80) {
      console.log(`[Reconcile] Closing fills in 5min window insufficient for bot ${botId} (got ${sumFillSize(closingFills).toFixed(6)} of ${absSize.toFixed(6)}), retrying with 60min window`);
      const widerFills = await fetchClosingFills(60 * 60 * 1000);
      if (unknownTradeSymbol) {
        estimationCloseFirstSeen.delete(corroborationKey);
        return noDetection;
      }
      if (sumFillSize(widerFills) > sumFillSize(closingFills)) {
        closingFills = widerFills;
      }
    }
    // Final fallback: 24h window. Catches closes that happened well before the
    // reconciler ran (e.g. when bot was offline, or our previous tick was
    // blocked by a bug). Without this, we'd fall through to the market-price
    // estimate in the account-info path and record an incorrect fill price.
    if (sumFillSize(closingFills) < absSize * 0.80) {
      console.log(`[Reconcile] Closing fills in 60min window still insufficient for bot ${botId}, retrying with 24h window`);
      const widestFills = await fetchClosingFills(24 * 60 * 60 * 1000);
      if (unknownTradeSymbol) {
        estimationCloseFirstSeen.delete(corroborationKey);
        return noDetection;
      }
      if (sumFillSize(widestFills) > sumFillSize(closingFills)) {
        closingFills = widestFills;
      }
    }

    let aggregatedSize = 0;
    let weightedPriceSum = 0;
    let totalFee = 0;
    const matchedTradeIds: string[] = [];
    const matchedOrderIds: string[] = [];

    for (const fill of closingFills) {
      aggregatedSize += fill.size;
      weightedPriceSum += fill.price * fill.size;
      totalFee += fill.fee;
      matchedTradeIds.push(fill.tradeId);
      if (fill.orderId) matchedOrderIds.push(fill.orderId);
      if (aggregatedSize >= absSize * 0.95) break;
    }

    const hasClosingTrades = aggregatedSize >= absSize * 0.80;

    let closeReason: 'tpsl' | 'liquidation' | 'external_close' = 'external_close';
    let tpslSubtype: 'TP' | 'SL' | undefined;

    const bot = await storage.getTradingBotById(botId);
    const riskConfig = bot?.riskConfig as Record<string, unknown> | undefined;

    if (hasClosingTrades) {
      const avgFillPrice = weightedPriceSum / aggregatedSize;

      const tpPriceAbs = Number(riskConfig?.takeProfitPrice || 0);
      const slPriceAbs = Number(riskConfig?.stopLossPrice || 0);
      const tpPct = Number(riskConfig?.takeProfitPercent || 0);
      const slPct = Number(riskConfig?.stopLossPercent || 0);

      const tpPrice = tpPriceAbs > 0 ? tpPriceAbs : (tpPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100))
        : 0);
      const slPrice = slPriceAbs > 0 ? slPriceAbs : (slPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100))
        : 0);

      const hasTpSl = tpPrice > 0 || slPrice > 0;

      if (hasTpSl) {
        const hitTp = tpPrice > 0 && (
          positionSide === 'long'
            ? avgFillPrice >= tpPrice * 0.99
            : avgFillPrice <= tpPrice * 1.01
        );
        const hitSl = slPrice > 0 && (
          positionSide === 'long'
            ? avgFillPrice <= slPrice * 1.01
            : avgFillPrice >= slPrice * 0.99
        );

        if (hitTp || hitSl) {
          closeReason = 'tpsl';
          tpslSubtype = hitTp ? 'TP' : 'SL';
          console.log(`[Reconcile] TP/SL detected for bot ${botId}: ${hitTp ? 'TP' : 'SL'} hit at $${avgFillPrice.toFixed(4)} (entry=$${entryPrice.toFixed(4)}, TP=$${tpPrice.toFixed(4)}, SL=$${slPrice.toFixed(4)})`);
        }
      }

      const pnl = positionSide === 'long'
        ? (avgFillPrice - entryPrice) * absSize
        : (entryPrice - avgFillPrice) * absSize;

      if (closeReason === 'external_close') {
        try {
          const accountInfo = await adapter.getAccountInfo(readAccount, readSubaccountId);
          if (accountInfo.exists !== false && accountInfo.equity < 1 && accountInfo.balance < 1) {
            closeReason = 'liquidation';
            console.log(`[Reconcile] Likely liquidation for bot ${botId}: account equity=$${accountInfo.equity.toFixed(2)}, balance=$${accountInfo.balance.toFixed(2)}`);
          }
        } catch { /* non-critical */ }
      }

      // Fill-backed close: real venue evidence, no corroboration needed.
      estimationCloseFirstSeen.delete(corroborationKey);
      return {
        detected: true,
        reason: closeReason,
        fillPrice: avgFillPrice,
        pnl,
        fee: totalFee,
        // Canonical: FIRST matched protocol fill ID is a single stable
        // identifier suitable as the cross-path dedup key. Joined IDs
        // are diagnostic-only.
        protocolFillId: matchedTradeIds[0],
        matchedFillIdsForDiagnostics: matchedTradeIds.join(','),
        matchedOrderIdsForDiagnostics: matchedOrderIds.join(','),
        fillTimestampMs: closingFills[0]?.timestamp,
        tpslSubtype,
      };
    }

    // No closing fills found via trade history (either the API returned 404
    // for this account, or the fills didn't match). Fall through to the
    // account-info check, which can still detect the close via balance/equity.
    // NOTE: A Pacifica /account/trades 404 is itself meaningful signal —
    // it often means the account was stopped out and has no open trades.
    // Refusing to fall through here (the old CRITICAL GUARD) caused the
    // periodic reconciler to permanently stall on stopped-out positions.
    if (tradeHistoryFetchFailed && botSubaccountPublicKey) {
      console.log(`[Reconcile] Trade history unavailable for Pacifica bot ${botId} ${market} — falling through to account-info check`);
    }

    // No closing fills found. Before falling back to account-info estimation,
    // check position age. If the position was opened within the last 3 minutes,
    // the adapter's positions API may still be propagating (observed: Pacifica
    // shows 0 size for ~10s after an entry fills). Estimating a close price in
    // that window produces phantom trades. Return noDetection and let the next
    // reconcile tick (60s) retry — by then propagation lag has resolved.
    //
    // The 3-minute threshold gives an 18× safety margin over the worst observed
    // Pacifica lag (~10s) while being short enough that real closes (TP/SL,
    // manual) still get estimated fill prices within a couple of reconcile ticks.
    //
    // Liquidation is exempt: equity+balance both near zero is unambiguous signal
    // regardless of position age.
    const positionAgeMs = dbPosition.lastTradeAt
      ? Date.now() - new Date(dbPosition.lastTradeAt).getTime()
      : Infinity;
    const MIN_AGE_FOR_ESTIMATION_MS = 3 * 60 * 1000; // 3 minutes

    try {
      const accountInfo = await adapter.getAccountInfo(readAccount, readSubaccountId);

      if (accountInfo.exists === false) {
        console.log(`[Reconcile] Account info unavailable for bot ${botId} ${market} (exists=false) — preserving DB position`);
        return noDetection;
      }

      // Stable timestamp anchor for the canonical close ID across reconciler ticks.
      const fallbackAnchorMs = dbPosition.lastTradeAt
        ? new Date(dbPosition.lastTradeAt).getTime()
        : undefined;

      if (accountInfo.equity < 1 && accountInfo.balance < 1) {
        console.log(`[Reconcile] Likely liquidation for bot ${botId} (no closing trades): equity=$${accountInfo.equity.toFixed(2)}, balance=$${accountInfo.balance.toFixed(2)}`);
        // Liquidation carries its own evidence (equity AND balance ≈ 0) —
        // it is not gated on the estimation corroboration window.
        estimationCloseFirstSeen.delete(corroborationKey);
        return {
          detected: true,
          reason: 'liquidation',
          fillPrice: entryPrice,
          pnl: 0,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
        };
      }

      if (positionAgeMs < MIN_AGE_FOR_ESTIMATION_MS) {
        console.log(`[Reconcile] No closing fills for bot ${botId} ${market} but position is only ${(positionAgeMs / 1000).toFixed(0)}s old — treating as propagation lag, preserving DB position`);
        return noDetection;
      }

      // ── Phantom-close corroboration gate ─────────────────────────────
      // Everything past this point books a close from ESTIMATION only (no
      // fill evidence, account healthy). A single transient empty-but-
      // successful positions read must never be enough: require the empty
      // state to persist across ≥2 reconcile ticks spanning
      // ESTIMATION_CORROBORATION_MS, then re-read positions one final time
      // immediately before booking. Fail closed on any doubt.
      const nowMs = Date.now();
      const firstEmptySeenAt = estimationCloseFirstSeen.get(corroborationKey);
      if (firstEmptySeenAt === undefined) {
        pruneEstimationCandidates(nowMs);
        estimationCloseFirstSeen.set(corroborationKey, nowMs);
        console.log(`[Reconcile] Estimation-close candidate for bot ${botId} ${market}: first empty sighting recorded — awaiting corroboration (${ESTIMATION_CORROBORATION_MS / 1000}s) before booking`);
        return noDetection;
      }
      if (nowMs - firstEmptySeenAt < ESTIMATION_CORROBORATION_MS) {
        console.log(`[Reconcile] Estimation-close candidate for bot ${botId} ${market}: ${((nowMs - firstEmptySeenAt) / 1000).toFixed(0)}s since first empty sighting — still awaiting corroboration`);
        return noDetection;
      }
      // Final confirm: one more positions re-read before booking. NOTE: on
      // Pacifica this may be served from the adapter's ~10s positions cache
      // (same cache key as the caller's read moments ago), so it is NOT
      // guaranteed independent — the real corroboration is the ≥2 reconcile
      // ticks above (60s apart, each a genuinely fresh venue read). If the
      // position is visible again, the earlier empty reads were transient —
      // reset the candidate. If the re-read throws, fail closed, retry next tick.
      try {
        // Match the caller's read scope exactly: bot-subaccount key reads take
        // no subaccount ID; the legacy Drift path passes the numeric subaccount.
        const confirmPositions = botSubaccountPublicKey
          ? await adapter.getPositions(botSubaccountPublicKey)
          : await adapter.getPositions(agentPublicKey, positionSubAccountId !== undefined ? _subIdStr(positionSubAccountId) : undefined);
        const unknownConfirmPosition = confirmPositions.find(p => unknownProtocolSymbol(p.internalSymbol));
        if (unknownConfirmPosition) {
          const unknownSymbol = unknownProtocolSymbol(unknownConfirmPosition.internalSymbol);
          estimationCloseFirstSeen.delete(corroborationKey);
          console.error(
            `[Reconcile] Refusing estimation close for ${botId} ${market} - ` +
            `confirmation evidence contains unknown protocol symbol "${unknownSymbol}"`,
          );
          return noDetection;
        }
        const stillOpen = confirmPositions.find(p =>
          normalizeMarket(p.internalSymbol) === normalizedMarket && Math.abs(p.baseSize) > 0.0001
        );
        if (stillOpen) {
          estimationCloseFirstSeen.delete(corroborationKey);
          console.warn(`[Reconcile] PHANTOM CLOSE AVERTED for bot ${botId} ${market}: confirm re-read shows position still open (size=${stillOpen.baseSize}) after ${((nowMs - firstEmptySeenAt) / 1000).toFixed(0)}s of empty sightings — earlier reads were transient`);
          return noDetection;
        }
      } catch (confirmErr) {
        console.log(`[Reconcile] Estimation-close confirm re-read failed for bot ${botId} ${market} — failing closed, retrying next tick: ${confirmErr instanceof Error ? confirmErr.message : confirmErr}`);
        return noDetection;
      }
      estimationCloseFirstSeen.delete(corroborationKey);

      const tpPriceAbs = Number(riskConfig?.takeProfitPrice || 0);
      const slPriceAbs = Number(riskConfig?.stopLossPrice || 0);
      const tpPct = Number(riskConfig?.takeProfitPercent || 0);
      const slPct = Number(riskConfig?.stopLossPercent || 0);

      const tpPrice = tpPriceAbs > 0 ? tpPriceAbs : (tpPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100))
        : 0);
      const slPrice = slPriceAbs > 0 ? slPriceAbs : (slPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100))
        : 0);

      const hasTpSlConfig = tpPrice > 0 || slPrice > 0;

      const computePnl = (fillPrice: number): number => positionSide === 'long'
        ? (fillPrice - entryPrice) * absSize
        : (entryPrice - fillPrice) * absSize;

      if (hasTpSlConfig) {
        const marketPrice = await fetchMarketPrice(market, adapter);

        let estimatedFillPrice: number;
        let chosenLabel: string;

        if (tpPrice > 0 && slPrice > 0 && marketPrice && marketPrice > 0) {
          const distToTp = Math.abs(marketPrice - tpPrice);
          const distToSl = Math.abs(marketPrice - slPrice);
          if (distToTp <= distToSl) {
            estimatedFillPrice = tpPrice;
            chosenLabel = 'TP';
          } else {
            estimatedFillPrice = slPrice;
            chosenLabel = 'SL';
          }
        } else if (tpPrice > 0) {
          estimatedFillPrice = tpPrice;
          chosenLabel = 'TP';
        } else {
          estimatedFillPrice = slPrice;
          chosenLabel = 'SL';
        }

        const pnl = computePnl(estimatedFillPrice);
        console.log(`[Reconcile] Position closed for bot ${botId} with TP/SL configured (no trade history, age=${(positionAgeMs / 1000).toFixed(0)}s, balance=$${accountInfo.balance.toFixed(2)}): classified as tpsl, estimated ${chosenLabel} fill=$${estimatedFillPrice.toFixed(4)}, pnl=$${pnl.toFixed(4)}`);
        return {
          detected: true,
          reason: 'tpsl',
          fillPrice: estimatedFillPrice,
          pnl,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
          tpslSubtype: chosenLabel as 'TP' | 'SL',
        };
      }

      if (accountInfo.balance > 1 || accountInfo.equity > 1) {
        const marketPrice = await fetchMarketPrice(market, adapter);
        const fillPrice = marketPrice && marketPrice > 0 ? marketPrice : entryPrice;
        const pnl = marketPrice && marketPrice > 0 ? computePnl(marketPrice) : 0;
        console.log(`[Reconcile] Position closed for bot ${botId} (no trade history, age=${(positionAgeMs / 1000).toFixed(0)}s, balance=$${accountInfo.balance.toFixed(2)}): classified as external_close, estimated fill=$${fillPrice.toFixed(4)} (${marketPrice ? 'market' : 'entry-fallback'}), pnl=$${pnl.toFixed(4)}`);
        return {
          detected: true,
          reason: 'external_close',
          fillPrice,
          pnl,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
        };
      }
    } catch { /* non-critical */ }

    return noDetection;
  } catch (err) {
    console.error(`[Reconcile] detectOnChainClose error for bot ${botId}:`, err);
    return noDetection;
  }
}

/**
 * Force sync position from on-chain Drift to database
 * This should be called AFTER every trade to ensure DB matches on-chain truth
 * Unlike updateBotPositionFromTrade which does client-side math, this queries actual on-chain state
 * 
 * @param tradeFillPrice - Fill price of the trade (for realized PnL calculation)
 * @param tradeSide - 'long' or 'short' for the trade that was just executed
 * @param tradeSize - Size of the trade in base units
 */
export async function syncPositionFromOnChain(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string,
  tradeId: string,
  tradeFee: number,
  tradeFillPrice: number = 0,
  tradeSide: string = '',
  tradeSize: number = 0,
  botSubaccountPublicKey?: string
): Promise<{ success: boolean; position?: any; error?: string; tradePnl?: number; isClosingTrade?: boolean; onChainEntryPrice?: number }> {
  try {
    console.log(`[Sync] Force syncing bot ${botId} from on-chain (market=${market}, subaccount=${subAccountId}${botSubaccountPublicKey ? ', pacifica=' + botSubaccountPublicKey.slice(0,8) + '...' : ''})`);
    
    const botRowForAdapter = await storage.getTradingBotById(botId);
    if (!botRowForAdapter) {
      throw new Error(`Reconciliation: bot ${botId} not found — cannot resolve protocol adapter (fail-closed)`);
    }
    const adapter = getAdapterForBot(botRowForAdapter);
    const fetchOnce = async () => {
      if (botSubaccountPublicKey) {
        try {
          const positions = await adapter.getPositions(botSubaccountPublicKey);
          return { positions: positions.map(p => ({
            marketIndex: 0,
            market: p.internalSymbol,
            baseAssetAmount: p.baseSize,
            side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
            entryPrice: p.entryPrice,
            markPrice: p.markPrice,
            unrealizedPnl: p.unrealizedPnl,
            unrealizedPnlPercent: p.entryPrice > 0 && p.baseSize !== 0
              ? ((p.unrealizedPnl / (Math.abs(p.baseSize) * p.entryPrice)) * 100)
              : 0,
          })), fetchFailed: false };
        } catch (err) {
          console.log(`[Sync] Bot subaccount position fetch failed: ${err instanceof Error ? err.message : err}`);
          return { positions: [], fetchFailed: true };
        }
      } else {
        return await fetchPerpPositions(agentPublicKey, subAccountId, adapter);
      }
    };

    let fetchResult = await fetchOnce();
    const normalizedMarket = normalizeMarket(market);
    let onChainPos = fetchResult.positions.find(p => normalizeMarket(p.market) === normalizedMarket);

    const dbPosition = await storage.getBotPosition(botId, market);
    const existingRealizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
    const existingFees = dbPosition ? parseFloat(dbPosition.totalFees) : 0;
    const previousBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const previousAvgEntry = dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0;

    // STALE-READ GUARD: After a close/reduce trade, the protocol's positions
    // endpoint may still return the pre-close position for a brief window
    // (Pacifica in particular has propagation lag of a few seconds). If we
    // overwrite the DB with that stale read, the next reconcile tick will see
    // DB=full-size, on-chain=empty, and wrongly classify it as a liquidation.
    // So: when the trade is reducing AND on-chain still mirrors the pre-trade
    // size+side, retry the fetch a few times. If it still mirrors, skip the
    // overwrite and let the trade-data fallback path compute the new state.
    const normalizedTradeSide = tradeSide.toLowerCase();
    const isReducingTrade = tradeSize > 0 && Math.abs(previousBaseSize) > 0.0001 && (
      (previousBaseSize > 0 && normalizedTradeSide === 'short') ||
      (previousBaseSize < 0 && normalizedTradeSide === 'long')
    );
    const stillMirrorsPrev = (pos: typeof onChainPos) => {
      if (!pos) return false;
      const sameSign = (previousBaseSize > 0 && pos.baseAssetAmount > 0) ||
                       (previousBaseSize < 0 && pos.baseAssetAmount < 0);
      const sizeRatio = Math.abs(pos.baseAssetAmount) / Math.abs(previousBaseSize);
      return sameSign && sizeRatio >= 0.95;
    };
    if (isReducingTrade && stillMirrorsPrev(onChainPos)) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        const retry = await fetchOnce();
        const retryPos = retry.positions.find(p => normalizeMarket(p.market) === normalizedMarket);
        console.log(`[Sync] Stale-read guard attempt ${attempt}: on-chain size=${retryPos?.baseAssetAmount?.toFixed(4) ?? '0'} (previous=${previousBaseSize.toFixed(4)})`);
        if (!stillMirrorsPrev(retryPos)) {
          fetchResult = retry;
          onChainPos = retryPos;
          break;
        }
      }
      if (stillMirrorsPrev(onChainPos)) {
        console.log(`[Sync] On-chain still mirrors pre-close state after retries — skipping overwrite to prevent stale write. Falling back to trade-data computation.`);
        fetchResult = { positions: [], fetchFailed: true };
        onChainPos = undefined;
      }
    }
    
    if (fetchResult.fetchFailed && tradeSize > 0 && tradeFillPrice > 0) {
      console.log(`[Sync] Position fetch failed — using trade data as fallback`);
      const normalizedSide = tradeSide.toLowerCase();
      const tradeSigned = normalizedSide === 'long' ? tradeSize : -tradeSize;
      const isSameDirection = (previousBaseSize >= 0 && normalizedSide === 'long') ||
                              (previousBaseSize <= 0 && normalizedSide === 'short');
      
      let newBaseSize: number;
      let newAvgEntry: number;
      let tradePnl = 0;
      
      if (Math.abs(previousBaseSize) < 0.0001) {
        newBaseSize = tradeSigned;
        newAvgEntry = tradeFillPrice;
      } else if (isSameDirection) {
        newBaseSize = previousBaseSize + tradeSigned;
        const totalCost = Math.abs(previousBaseSize) * previousAvgEntry + tradeSize * tradeFillPrice;
        newAvgEntry = totalCost / Math.abs(newBaseSize);
      } else {
        const closedSize = Math.min(Math.abs(previousBaseSize), tradeSize);
        const feeRatio = closedSize / tradeSize;
        const closeFee = tradeFee * feeRatio;
        tradePnl = previousBaseSize > 0
          ? (tradeFillPrice - previousAvgEntry) * closedSize - closeFee
          : (previousAvgEntry - tradeFillPrice) * closedSize - closeFee;
        newBaseSize = previousBaseSize + tradeSigned;
        newAvgEntry = Math.abs(newBaseSize) > 0.0001 ? (Math.abs(newBaseSize) > Math.abs(previousBaseSize) ? tradeFillPrice : previousAvgEntry) : 0;
      }
      
      const newRealizedPnl = existingRealizedPnl + tradePnl;
      const newTotalFees = existingFees + tradeFee;
      
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(newBaseSize),
        avgEntryPrice: String(newAvgEntry),
        costBasis: String(Math.abs(newBaseSize) * newAvgEntry),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] Fallback position: ${newBaseSize.toFixed(4)} ${market} @ $${newAvgEntry.toFixed(2)} (fetch failed, used trade data)`);
      // Auto-repark: arm if this computed state is flat, else cancel. The scanner
      // re-verifies flat on-chain before parking, so a wrong fetch-failed guess is safe.
      await applyAutoReparkTransition(botRowForAdapter, Math.abs(newBaseSize) < 0.0001);
      return { success: true, position, tradePnl, isClosingTrade: tradePnl !== 0, onChainEntryPrice: tradeFillPrice };
    }
    
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    
    let tradePnl = 0;
    
    if (Math.abs(previousBaseSize) > 0.0001 && tradeFillPrice > 0 && tradeSize > 0) {
      const normalizedSide = tradeSide.toLowerCase();
      const isReducing = (previousBaseSize > 0 && normalizedSide === 'short') ||
                         (previousBaseSize < 0 && normalizedSide === 'long');
      
      if (isReducing) {
        const closedSize = Math.min(Math.abs(previousBaseSize), tradeSize);
        const feeRatio = closedSize / tradeSize;
        const closeFee = tradeFee * feeRatio;
        
        if (previousBaseSize > 0) {
          tradePnl = (tradeFillPrice - previousAvgEntry) * closedSize - closeFee;
        } else {
          tradePnl = (previousAvgEntry - tradeFillPrice) * closedSize - closeFee;
        }
        
        console.log(`[Sync] Realized PnL from close: $${tradePnl.toFixed(4)} (closed ${closedSize.toFixed(4)} @ $${tradeFillPrice.toFixed(2)}, entry was $${previousAvgEntry.toFixed(2)}, fee prorated: $${closeFee.toFixed(4)})`);
      }
    }
    
    const newRealizedPnl = existingRealizedPnl + tradePnl;
    const newTotalFees = existingFees + tradeFee;
    
    if (onChainPos && Math.abs(onChainBaseSize) > 0.0001) {
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(onChainBaseSize),
        avgEntryPrice: String(onChainPos.entryPrice),
        costBasis: String(Math.abs(onChainBaseSize) * onChainPos.entryPrice),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] On-chain position: ${onChainBaseSize.toFixed(4)} ${market} @ $${onChainPos.entryPrice.toFixed(2)}, cumulative PnL: $${newRealizedPnl.toFixed(4)}`);
      // Position is still open on-chain — cancel any pending repark.
      await applyAutoReparkTransition(botRowForAdapter, false);
      return { success: true, position, tradePnl, isClosingTrade: tradePnl !== 0, onChainEntryPrice: onChainPos.entryPrice };
    } else if (tradeSize > 0 && tradeFillPrice > 0) {
      const normalizedSide = tradeSide.toLowerCase();
      const tradeSigned = normalizedSide === 'long' ? tradeSize : -tradeSize;
      const isSameDirection = (previousBaseSize >= 0 && normalizedSide === 'long') ||
                              (previousBaseSize <= 0 && normalizedSide === 'short');
      
      let newBaseSize: number;
      let newAvgEntry: number;
      
      if (Math.abs(previousBaseSize) < 0.0001) {
        newBaseSize = tradeSigned;
        newAvgEntry = tradeFillPrice;
      } else if (isSameDirection) {
        newBaseSize = previousBaseSize + tradeSigned;
        const totalCost = Math.abs(previousBaseSize) * previousAvgEntry + tradeSize * tradeFillPrice;
        newAvgEntry = totalCost / Math.abs(newBaseSize);
      } else {
        newBaseSize = previousBaseSize + tradeSigned;
        newAvgEntry = Math.abs(newBaseSize) > 0.0001 ? (Math.abs(newBaseSize) > Math.abs(previousBaseSize) ? tradeFillPrice : previousAvgEntry) : 0;
      }
      
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(newBaseSize),
        avgEntryPrice: String(newAvgEntry),
        costBasis: String(Math.abs(newBaseSize) * newAvgEntry),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] On-chain empty — computed from trade data: ${newBaseSize.toFixed(4)} ${market} @ $${newAvgEntry.toFixed(2)}, PnL: $${newRealizedPnl.toFixed(4)}`);
      // Auto-repark: arm if the computed state is flat (full close), else cancel.
      await applyAutoReparkTransition(botRowForAdapter, Math.abs(newBaseSize) < 0.0001);
      return { success: true, position, tradePnl, isClosingTrade: Math.abs(newBaseSize) < 0.0001, onChainEntryPrice: tradeFillPrice };
    } else {
      console.log(`[Sync] On-chain empty and no trade data — preserving DB position (${previousBaseSize} ${market})`);
      return { success: true, tradePnl: 0, isClosingTrade: false };
    }
  } catch (error) {
    console.error(`[Sync] Failed to sync position from on-chain:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}


/**
 * Book realized PnL for a slice of a position that was partially closed
 * on-chain without going through the webhook path (e.g. manual partial TP
 * on the exchange, or an external order manager).
 *
 * Uses the existing `recordCloseEventAtomic` idempotency model:
 * - Key: `partial-<botId>-<market>-<fillId>` (or a deterministic nosig hash)
 * - Safe to re-run: second call hits the unique index and returns isNew=false
 * - The webhook path uses `tx-<sig>` keys so the two paths never collide
 */
async function bookPartialReduction(opts: {
  botId: string;
  walletAddress: string;
  market: string;
  agentPublicKey: string;
  botSubaccountPublicKey?: string;
  dbBaseSize: number;
  dbPosition: { avgEntryPrice: string; realizedPnl: string; totalFees: string; lastTradeId?: string | null; lastTradeAt?: Date | null };
  closedSlice: number;
  onChainBaseSize: number;
  onChainEntryPrice: number;
  adapter: ProtocolAdapter;
  recentTrades: PendingPartialCloseTradeLike[];
  allowExternalAccounting: boolean;
}): Promise<'completed' | 'unknown-symbol-refusal' | 'pending-marker-incomplete' | 'no-pending-marker'> {
  const {
    botId, walletAddress, market, agentPublicKey, botSubaccountPublicKey,
    dbBaseSize, dbPosition, closedSlice, onChainBaseSize, onChainEntryPrice, adapter,
    recentTrades, allowExternalAccounting,
  } = opts;

  const positionSide = dbBaseSize > 0 ? 'long' : 'short';
  const closeSide = positionSide === 'long' ? 'short' : 'long';
  const entryPrice = parseFloat(dbPosition.avgEntryPrice);
  const normalizedMarket = normalizeMarket(market);
  const readAccount = botSubaccountPublicKey || agentPublicKey;

  // Fetch recent closing fills to price the slice.
  let closingFills: TradeRecord[] = [];
  for (const windowMs of [5 * 60 * 1000, 60 * 60 * 1000]) {
    try {
      const startTime = Date.now() - windowMs;
      const trades = await adapter.getTradeHistory(readAccount, {
        limit: 200,
        maxPages: 10,
        internalSymbol: market,
        startTime,
        endTime: Date.now(),
      });
      const unknownTrade = trades.find(t => unknownProtocolSymbol(t.internalSymbol));
      if (unknownTrade) {
        const unknownSymbol = unknownProtocolSymbol(unknownTrade.internalSymbol);
        console.error(
          `[Reconcile] Refusing partial-reduction accounting for ${botId} ${market} - ` +
          `trade-history evidence contains unknown protocol symbol "${unknownSymbol}"`,
        );
        return 'unknown-symbol-refusal';
      }
      closingFills = trades
        .filter(t =>
          normalizeMarket(t.internalSymbol) === normalizedMarket &&
          isExpectedClosingTrade(t, positionSide, closeSide)
        )
        .sort((a, b) => b.timestamp - a.timestamp);

      const sumSize = closingFills.reduce((s, f) => s + f.size, 0);
      if (sumSize >= closedSlice * 0.80) break;
    } catch (err) {
      console.log(`[Reconcile] Partial-reduction fill fetch failed for ${botId}: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }

  const markerSelection = selectPendingPartialCloseMarker({
    trades: recentTrades,
    protocol: String((await storage.getTradingBotById(botId))?.activeProtocol ?? ''),
    market,
    closeSide,
    dbBaseSize,
    dbLastTradeId: dbPosition.lastTradeId ?? null,
    closedSlice,
    closingFills,
    nowMs: Date.now(),
  });
  if (markerSelection.kind === 'blocked') {
    const outcome = {
      protocol: String((await storage.getTradingBotById(botId))?.activeProtocol ?? ''),
      markerIds: markerSelection.markerIds,
      outcome: 'accounting_incomplete',
      attempts: 1,
      elapsedMs: 0,
      identityAuthority: 'recovery_marker_selection',
      incompleteReason: markerSelection.reason,
      promotionPath: 'periodic_reconciler',
      externalEffectsRouted: false,
    };
    for (const markerId of markerSelection.markerIds) {
      const marker = recentTrades.find((trade) => trade.id === markerId);
      const payload = marker?.webhookPayload && typeof marker.webhookPayload === 'object'
        ? marker.webhookPayload as Record<string, unknown>
        : {};
      await storage.updateBotTrade(markerId, {
        webhookPayload: { ...payload, partialCloseAuthorityOutcome: outcome },
        errorMessage: `Partial close accounting incomplete: ${markerSelection.reason}`,
      });
    }
    console.log(`[PartialCloseAuthorityOutcome] ${JSON.stringify(outcome)}`);
    return 'pending-marker-incomplete';
  }
  if (markerSelection.kind === 'none' && !allowExternalAccounting) {
    return 'no-pending-marker';
  }

  // Accumulate fills that cover the slice.
  let aggregatedSize = 0;
  let weightedPriceSum = 0;
  let totalFee = 0;
  const matchedIds: string[] = [];
  for (const fill of closingFills) {
    aggregatedSize += fill.size;
    weightedPriceSum += fill.price * fill.size;
    totalFee += fill.fee;
    matchedIds.push(fill.tradeId);
    if (aggregatedSize >= closedSlice * 0.95) break;
  }

  const hasFills = aggregatedSize >= closedSlice * 0.80;
  const markerExecution = markerSelection.kind === 'eligible'
    ? markerSelection.payload.executionAccounting
    : null;
  const avgFillPrice = markerSelection.kind === 'eligible'
    ? Number(markerExecution?.price)
    : hasFills && aggregatedSize > 0
      ? weightedPriceSum / aggregatedSize
      : entryPrice; // external reduction fallback; never used for a pending signed marker

  // PnL on the closed slice using average-entry semantics.
  if (markerSelection.kind === 'eligible') {
    totalFee = Number(markerExecution?.fee);
  }
  const slicePnl = markerSelection.kind === 'eligible'
    ? Number(markerExecution?.pnl)
    : positionSide === 'long'
      ? (avgFillPrice - entryPrice) * closedSlice - totalFee
      : (entryPrice - avgFillPrice) * closedSlice - totalFee;

  // Classify as partial_tp or partial_sl based on sign of PnL.
  const partialSubtype = slicePnl >= 0 ? 'partial_tp' : 'partial_sl';

  // Canonical dedup key for reconciler-detected partials.
  const dedupKey = markerSelection.kind === 'eligible' && markerSelection.trade.protocolFillId
    ? markerSelection.trade.protocolFillId
    : DatabaseStorage.canonicalCloseFillId({
    signature: matchedIds[0] ? `partial-${matchedIds[0]}` : undefined,
    botId,
    side: closeSide,
    size: closedSlice,
    market,
    fillPrice: avgFillPrice,
    timestampMs: closingFills[0]?.timestamp,
  });

  console.log(`[Reconcile] Partial reduction for bot ${botId} ${market}: slice=${closedSlice.toFixed(4)}, price=$${avgFillPrice.toFixed(4)}, pnl=$${slicePnl.toFixed(4)}, hasFills=${hasFills}, dedup=${dedupKey}`);

  const pendingPartial = markerSelection.kind === 'eligible' ? markerSelection.trade : null;
  const completedPayload = {
    ...(pendingPartial?.webhookPayload && typeof pendingPartial.webhookPayload === 'object'
      ? pendingPartial.webhookPayload as Record<string, unknown>
      : {}),
    reconciled: true,
    closeReason: partialSubtype,
    detectedAt: new Date().toISOString(),
    matchedFillIds: markerSelection.kind === 'eligible'
      ? markerSelection.matchedFillIds.join(',')
      : matchedIds.join(','),
    hasFills,
    priceAuthority: markerSelection.kind === 'eligible'
      ? markerExecution?.priceAuthority
      : hasFills ? 'venue_fill_aggregation' : 'external_reduction_estimate',
    partialCloseAccounting: {
      status: 'complete',
      residualBaseSize: onChainBaseSize,
      residualEntryPrice: onChainEntryPrice,
      recoveredBy: 'periodic_reconciler',
    },
    partialCloseAuthorityOutcome: {
      protocol: String((await storage.getTradingBotById(botId))?.activeProtocol ?? ''),
      markerId: pendingPartial?.id ?? null,
      outcome: 'complete',
      attempts: 1,
      elapsedMs: 0,
      identityAuthority: pendingPartial ? 'signed_marker' : 'external_reduction',
      incompleteReason: null,
      promotionPath: 'periodic_reconciler',
      externalEffectsRouted: false,
    },
  };
  const { isNew } = await storage.recordCloseEventAtomic({
    botId,
    ...(pendingPartial ? {
      update: {
        tradeId: pendingPartial.id,
        fields: {
          status: 'executed',
          price: String(avgFillPrice),
          fee: String(totalFee),
          pnl: String(slicePnl),
          protocolFillId: dedupKey,
          webhookPayload: completedPayload,
          errorMessage: null,
          executionMethod: 'on-chain-detected',
        },
      },
    } : { insert: {
      tradingBotId: botId,
      walletAddress,
      market,
      side: closeSide,
      size: String(closedSlice),
      price: String(avgFillPrice),
      fee: String(totalFee),
      pnl: String(slicePnl),
      status: 'executed',
      protocolFillId: dedupKey,
      webhookPayload: completedPayload,
      executionMethod: 'on-chain-detected',
    } }),
    deltas: {
      totalPnlDelta: slicePnl,
      totalVolumeDelta: closedSlice * avgFillPrice,
      lastTradeAt: new Date().toISOString(),
    },
    confirmedPositionReduction: {
      market,
      expectedBaseSize: String(dbBaseSize),
      expectedLastTradeId: dbPosition.lastTradeId ?? null,
      residualBaseSize: onChainBaseSize,
      residualEntryPrice: onChainEntryPrice,
      realizedPnlDelta: slicePnl,
      feeDelta: totalFee,
    },
  });

  if (!isNew) {
    console.log(`[Reconcile] Partial reduction already booked for ${botId} ${market} (dedupKey=${dedupKey})`);
    if (pendingPartial) {
      console.log(`[PartialCloseAuthorityOutcome] ${JSON.stringify({
        protocol: String((await storage.getTradingBotById(botId))?.activeProtocol ?? ''),
        markerId: pendingPartial.id,
        outcome: 'replay',
        attempts: 1,
        elapsedMs: 0,
        identityAuthority: 'signed_marker',
        incompleteReason: null,
        promotionPath: 'periodic_reconciler',
        externalEffectsRouted: false,
      })}`);
    }
    return 'completed';
  }

  // Fire notification (debounced so multi-stage exits don't spam).
  try {
    const botRow = await storage.getTradingBotById(botId);
    schedulePartialCloseNotification({
      walletAddress,
      botId,
      botName: botRow?.name ?? 'Bot',
      market,
      side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
      closedFraction: closedSlice / Math.abs(dbBaseSize),
      realizedPnl: slicePnl,
      price: avgFillPrice,
    });
  } catch (notifErr) {
    console.error(`[Reconcile] Partial-reduction notification error for ${botId}:`, notifErr);
  }
  if (pendingPartial) {
    const routingSignal = buildRecoveredPartialCloseRoutingSignal({
      preCloseBaseSize: dbBaseSize,
      requestedClosedSize: Number(markerSelection.kind === 'eligible'
        ? markerSelection.payload.partialCloseAccounting.requestedClosedSize
        : closedSlice),
      residualBaseSize: onChainBaseSize,
      price: avgFillPrice,
    });
    let externalEffectsRouted = false;
    let routingReason: string | null = null;
    if (!routingSignal) {
      routingReason = 'invalid_recovered_partial_routing_payload';
    } else if (!recoveredCloseRoutingCallback) {
      routingReason = 'recovered_close_routing_callback_unregistered';
    } else {
      try {
        await recoveredCloseRoutingCallback(botId, routingSignal);
        externalEffectsRouted = true;
      } catch (error) {
        routingReason = error instanceof Error ? error.message : String(error);
      }
    }
    const routedPayload = {
      ...completedPayload,
      partialCloseAuthorityOutcome: {
        ...(completedPayload.partialCloseAuthorityOutcome as Record<string, unknown>),
        externalEffectsRouted,
        routingReason,
      },
    };
    await storage.updateBotTrade(pendingPartial.id, { webhookPayload: routedPayload });
    console.log(`[PartialCloseAuthorityOutcome] ${JSON.stringify(routedPayload.partialCloseAuthorityOutcome)}`);
  }
  return 'completed';
}

async function convergeFlatWithPendingPartialIncomplete(input: {
  botId: string;
  walletAddress: string;
  market: string;
  dbPosition: { avgEntryPrice: string; realizedPnl?: string | null; totalFees?: string | null; lastTradeId?: string | null };
  markerIds: string[];
  recentTrades: PendingPartialCloseTradeLike[];
  protocol: string;
  reason: string;
}): Promise<void> {
  const outcome = {
    protocol: input.protocol,
    markerIds: input.markerIds,
    outcome: 'accounting_incomplete',
    attempts: 1,
    elapsedMs: 0,
    identityAuthority: 'fill_backed_full_close_required',
    incompleteReason: input.reason,
    promotionPath: 'periodic_reconciler_full_close',
    externalEffectsRouted: false,
  };
  for (const markerId of input.markerIds) {
    const marker = input.recentTrades.find((trade) => trade.id === markerId);
    const payload = marker?.webhookPayload && typeof marker.webhookPayload === 'object'
      ? marker.webhookPayload as Record<string, unknown>
      : {};
    await storage.updateBotTrade(markerId, {
      webhookPayload: { ...payload, partialCloseAuthorityOutcome: outcome },
      errorMessage: `Partial close accounting incomplete: ${input.reason}`,
    });
  }
  await storage.upsertBotPosition({
    tradingBotId: input.botId,
    walletAddress: input.walletAddress,
    market: input.market,
    baseSize: '0',
    avgEntryPrice: input.dbPosition.avgEntryPrice,
    costBasis: '0',
    realizedPnl: input.dbPosition.realizedPnl || '0',
    totalFees: input.dbPosition.totalFees || '0',
    lastTradeId: input.dbPosition.lastTradeId ?? null,
    lastTradeAt: new Date(),
  });
  console.log(`[PartialCloseAuthorityOutcome] ${JSON.stringify(outcome)}`);
}

export async function reconcileBotPosition(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string,
  botSubaccountPublicKey?: string
): Promise<{ synced: boolean; discrepancy: boolean; liquidation?: boolean }> {
  try {
    const botRowForAdapter = await storage.getTradingBotById(botId);
    if (!botRowForAdapter) {
      throw new Error(`Reconciliation: bot ${botId} not found — cannot resolve protocol adapter (fail-closed)`);
    }
    const adapter = getAdapterForBot(botRowForAdapter);
    let fetchResult;
    if (botSubaccountPublicKey) {
      try {
        const positions = await adapter.getPositions(botSubaccountPublicKey);
        fetchResult = { positions: positions.map(p => ({
          marketIndex: 0,
          market: p.internalSymbol,
          baseAssetAmount: p.baseSize,
          side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPercent: p.entryPrice > 0 && p.baseSize !== 0
            ? ((p.unrealizedPnl / (Math.abs(p.baseSize) * p.entryPrice)) * 100)
            : 0,
        })), fetchFailed: false };
      } catch (err) {
        console.log(`[Reconcile] Bot subaccount position fetch failed for ${botId}: ${err instanceof Error ? err.message : err}`);
        fetchResult = { positions: [], fetchFailed: true };
      }
    } else {
      fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId, adapter);
    }
    if (fetchResult.fetchFailed) {
      console.log(`[Reconcile] Skipping reconciliation for bot ${botId} — position fetch failed`);
      return { synced: false, discrepancy: false };
    }
    const normalizedMarket = normalizeMarket(market);
    const unknownInitialPosition = fetchResult.positions.find(p => unknownProtocolSymbol(p.market));
    if (unknownInitialPosition) {
      const unknownSymbol = unknownProtocolSymbol(unknownInitialPosition.market);
      estimationCloseFirstSeen.delete(estimationCloseKey(botId, market));
      console.error(
        `[Reconcile] Refusing reconciliation for ${botId} ${market} - ` +
        `position evidence contains unknown protocol symbol "${unknownSymbol}"`,
      );
      return { synced: false, discrepancy: false };
    }
    const onChainPos = fetchResult.positions.find(p => normalizeMarket(p.market) === normalizedMarket);
    const dbPosition = await storage.getBotPosition(botId, market);
    
    const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    const onChainHasRealPosition = onChainPos && Math.abs(onChainBaseSize) > 0.0001;

    if (onChainHasRealPosition) {
      // Position visible on the venue — any pending estimation-close candidate
      // was a transient empty read. Reset so a later real close starts a fresh
      // corroboration window instead of inheriting a stale first-sighting.
      estimationCloseFirstSeen.delete(estimationCloseKey(botId, market));
    }

    if (Math.abs(dbBaseSize) > 0.0001 && !onChainHasRealPosition) {
      const closeDetection = await detectOnChainClose(
        botId, agentPublicKey, market, dbPosition!, botSubaccountPublicKey, adapter, subAccountId
      );

      if (closeDetection.detected) {
        // Auto-repark: the position is gone on-chain (manual TP/SL or other
        // external close the webhook never saw). Arm the debounce in BOTH the
        // already-booked and full-book branches below; the scanner re-verifies
        // flat on-chain before parking.
        await applyAutoReparkTransition(botRowForAdapter, true);

        // A close handler may already have persisted the signed order as
        // confirmation_pending. The canonical-close lookup intentionally
        // excludes pending rows, so locate the exact newest pending candidate
        // first and promote that row rather than inserting a duplicate.
        const positionEpochFloor = dbPosition!.lastTradeAt
          ? new Date(dbPosition!.lastTradeAt).getTime()
          : null;
        const recentCloseTrades = await storage.getBotTrades(botId, 200) as PendingPartialCloseTradeLike[];
        const closeSide = dbBaseSize > 0 ? 'short' : 'long';
        const pendingPartialFullClose = selectPendingPartialMarkerForFullClose({
          trades: recentCloseTrades,
          market,
          closeSide,
          dbBaseSize,
          dbLastTradeId: dbPosition!.lastTradeId ?? null,
          fillTradeIds: (closeDetection.matchedFillIdsForDiagnostics ?? '')
            .split(',').map((value) => value.trim()).filter(Boolean),
          fillOrderIds: (closeDetection.matchedOrderIdsForDiagnostics ?? '')
            .split(',').map((value) => value.trim()).filter(Boolean),
          nowMs: Date.now(),
        });

        if (pendingPartialFullClose.kind !== 'none') {
          const fillBackedMoneyValid = pendingPartialFullClose.kind === 'eligible'
            && Boolean(closeDetection.protocolFillId)
            && Number.isFinite(closeDetection.fillPrice)
            && Number(closeDetection.fillPrice) > 0
            && Number.isFinite(closeDetection.fee)
            && Number(closeDetection.fee) >= 0
            && Number.isFinite(closeDetection.pnl);
          if (!fillBackedMoneyValid || pendingPartialFullClose.kind !== 'eligible') {
            const markerIds = pendingPartialFullClose.kind === 'blocked'
              ? pendingPartialFullClose.markerIds
              : [pendingPartialFullClose.trade.id];
            const reason = pendingPartialFullClose.kind === 'blocked'
              ? pendingPartialFullClose.reason
              : 'pending_partial_full_close_money_unavailable';
            await convergeFlatWithPendingPartialIncomplete({
              botId,
              walletAddress,
              market,
              dbPosition: dbPosition!,
              markerIds,
              recentTrades: recentCloseTrades,
              protocol: String(botRowForAdapter.activeProtocol),
              reason,
            });
            if (botRowForAdapter.riskConfig) {
              const rc = botRowForAdapter.riskConfig as Record<string, unknown>;
              delete rc.takeProfitPercent;
              delete rc.stopLossPercent;
              delete rc.takeProfitPrice;
              delete rc.stopLossPrice;
              await storage.updateTradingBot(botId, { riskConfig: rc } as any);
            }
            lastReconcileTime.set(botId, Date.now());
            return { synced: true, discrepancy: true, liquidation: closeDetection.reason === 'liquidation' };
          }

          const closeFee = Number(closeDetection.fee);
          const closePnl = Number(closeDetection.pnl) - closeFee;
          const closeFillPrice = Number(closeDetection.fillPrice);
          let dedupKey = canonicalReconcilerFullCloseId({
            protocolFillId: closeDetection.protocolFillId,
            botId,
            market,
            positionEpochId: dbPosition!.lastTradeId,
          });
          if (dedupKey === pendingPartialFullClose.trade.protocolFillId) {
            dedupKey = DatabaseStorage.canonicalCloseFillId({
              signature: `reconciler-full-close|${closeDetection.protocolFillId}`,
              botId,
              side: 'close',
              size: Math.abs(dbBaseSize),
              market,
            });
          }
          if (!dedupKey) throw new Error('pending_partial_full_close_identity_unavailable');
          const closePayload = {
            reconciled: true,
            closeReason: closeDetection.reason,
            detectedAt: new Date().toISOString(),
            protocolFillId: closeDetection.protocolFillId,
            matchedFillIdsForDiagnostics: closeDetection.matchedFillIdsForDiagnostics,
            matchedOrderIdsForDiagnostics: closeDetection.matchedOrderIdsForDiagnostics,
            supersededPendingPartialMarkerId: pendingPartialFullClose.trade.id,
            recoveredSubscriberRouting: { attempted: false, routed: false, reason: null },
          };
          const atomic = await storage.recordCloseEventAtomic({
            botId,
            insert: {
              tradingBotId: botId,
              walletAddress,
              market,
              side: closeSide,
              size: String(Math.abs(dbBaseSize)),
              price: String(closeFillPrice),
              fee: String(closeFee),
              pnl: String(closePnl),
              pnlConvention: 'net_of_close_fee',
              feeTruthStatus: 'current_pipeline',
              status: closeDetection.reason === 'liquidation' ? 'liquidated' : 'executed',
              protocolFillId: dedupKey,
              webhookPayload: closePayload,
              executionMethod: 'on-chain-detected',
            },
            deltas: {
              totalPnlDelta: closePnl,
              totalVolumeDelta: closeFillPrice * Math.abs(dbBaseSize),
              lastTradeAt: new Date().toISOString(),
            },
            confirmedPositionClose: {
              walletAddress,
              market,
              realizedPnlDelta: closePnl,
              feeDelta: closeFee,
            },
            supersedePendingPartialTradeId: pendingPartialFullClose.trade.id,
          });

          let routed = false;
          let routingReason: string | null = null;
          if (atomic.isNew) {
            const routingSignal = buildRecoveredFullCloseRoutingSignal({
              preCloseBaseSize: dbBaseSize,
              price: closeFillPrice,
            });
            if (!routingSignal) routingReason = 'invalid_recovered_full_close_routing_payload';
            else if (!recoveredCloseRoutingCallback) routingReason = 'recovered_close_routing_callback_unregistered';
            else {
              try {
                await recoveredCloseRoutingCallback(botId, routingSignal);
                routed = true;
              } catch (error) {
                routingReason = error instanceof Error ? error.message : String(error);
              }
            }
            try {
              const botName = botRowForAdapter.name ?? 'Bot';
              sendTradeNotification(walletAddress, {
                type: 'position_closed',
                botName,
                market,
                side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
                size: Math.abs(dbBaseSize),
                price: closeFillPrice,
                pnl: closePnl,
                closeReason: getCloseReasonLabel(closeDetection.reason, closeDetection.tpslSubtype),
              }).catch((error) => console.error(`[Reconcile] Notification error for bot ${botId}:`, error));
            } catch (error) {
              console.error(`[Reconcile] Failed to dispatch close notification for bot ${botId}:`, error);
            }
          } else {
            routingReason = 'replay';
          }
          if (atomic.trade?.id) {
            await storage.updateBotTrade(atomic.trade.id, {
              webhookPayload: {
                ...closePayload,
                recoveredSubscriberRouting: { attempted: atomic.isNew, routed, reason: routingReason },
              },
            });
          }
          console.log(`[PartialCloseAuthorityOutcome] ${JSON.stringify({
            protocol: String(botRowForAdapter.activeProtocol),
            markerId: pendingPartialFullClose.trade.id,
            outcome: atomic.isNew ? 'superseded_by_fill_backed_full_close' : 'replay',
            attempts: 1,
            elapsedMs: 0,
            identityAuthority: 'fill_backed_full_close',
            incompleteReason: null,
            promotionPath: 'periodic_reconciler_full_close',
            externalEffectsRouted: routed,
            routingReason,
          })}`);
          if (botRowForAdapter.riskConfig) {
            const rc = botRowForAdapter.riskConfig as Record<string, unknown>;
            delete rc.takeProfitPercent;
            delete rc.stopLossPercent;
            delete rc.takeProfitPrice;
            delete rc.stopLossPrice;
            await storage.updateTradingBot(botId, { riskConfig: rc } as any);
          }
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: true, liquidation: closeDetection.reason === 'liquidation' };
        }

        const pendingClose = recentCloseTrades.find((trade) => {
          const executedAt = trade.executedAt ? new Date(trade.executedAt).getTime() : Number.NaN;
          return String(trade.status).toLowerCase() === 'pending'
            && String(trade.side).toUpperCase() === 'CLOSE'
            && normalizeMarket(trade.market) === normalizedMarket
            && (positionEpochFloor === null || (Number.isFinite(executedAt) && executedAt >= positionEpochFloor));
        });

        if (pendingClose) {
          // A pending order is finalized only from a venue fill identity. The
          // existing estimated-close fallback remains available for rows that
          // were never created by a signed close handler, but it must not turn
          // this pending row into invented fill truth.
          if (!closeDetection.protocolFillId) {
            console.log(
              `[Reconcile] Pending close ${pendingClose.id} for ${botId} ${market} `
              + 'still lacks venue fill identity; preserving it for a later fresh history read',
            );
            lastReconcileTime.set(botId, Date.now());
            return { synced: true, discrepancy: true };
          }

          const closeFee = closeDetection.fee ?? 0;
          const closePnl = (closeDetection.pnl ?? 0) - closeFee;
          const closeFillPrice = closeDetection.fillPrice ?? parseFloat(dbPosition!.avgEntryPrice);
          const closeNotional = closeFillPrice * Math.abs(dbBaseSize);
          const dedupKey = canonicalReconcilerFullCloseId({
            protocolFillId: closeDetection.protocolFillId,
            botId,
            market,
            positionEpochId: dbPosition!.lastTradeId,
          });
          if (!dedupKey) {
            console.error(`[Reconcile] Refusing pending close finalization for ${botId} ${market}: no canonical fill identity`);
            lastReconcileTime.set(botId, Date.now());
            return { synced: false, discrepancy: true };
          }

          const existingPayload = pendingClose.webhookPayload
            && typeof pendingClose.webhookPayload === 'object'
            ? pendingClose.webhookPayload as Record<string, unknown>
            : {};
          const { isNew } = await storage.recordCloseEventAtomic({
            botId,
            update: {
              tradeId: pendingClose.id,
              fields: {
                status: closeDetection.reason === 'liquidation' ? 'liquidated' : 'executed',
                price: String(closeFillPrice),
                fee: String(closeFee),
                pnl: String(closePnl),
                pnlConvention: 'net_of_close_fee',
                feeTruthStatus: 'current_pipeline',
                protocolFillId: dedupKey,
                webhookPayload: {
                  ...existingPayload,
                  reconciled: true,
                  closeReason: closeDetection.reason,
                  detectedAt: new Date().toISOString(),
                  protocolFillId: closeDetection.protocolFillId,
                  matchedFillIdsForDiagnostics: closeDetection.matchedFillIdsForDiagnostics,
                },
                executionMethod: 'on-chain-detected',
              },
            },
            deltas: {
              totalPnlDelta: closePnl,
              totalVolumeDelta: closeNotional,
              lastTradeAt: new Date().toISOString(),
            },
            confirmedPositionClose: {
              walletAddress,
              market,
              realizedPnlDelta: closePnl,
              feeDelta: closeFee,
            },
          });
          console.log(
            `[Reconcile] ${isNew ? 'Finalized' : 'Observed finalized'} pending close ${pendingClose.id} `
            + `for ${botId} ${market} from venue fill ${closeDetection.protocolFillId}`,
          );
          if (isNew) {
            try {
              const reasonLabel = getCloseReasonLabel(closeDetection.reason, closeDetection.tpslSubtype);
              const botName = botRowForAdapter.name ?? 'Bot';
              sendTradeNotification(walletAddress, {
                type: 'position_closed',
                botName,
                market,
                side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
                size: Math.abs(dbBaseSize),
                price: closeFillPrice,
                pnl: closePnl,
                closeReason: reasonLabel,
              }).catch(err => console.error(`[Reconcile] Notification error for bot ${botId}:`, err));
            } catch (notifErr) {
              console.error(`[Reconcile] Failed to dispatch close notification for bot ${botId}:`, notifErr);
            }
          }
          if (botRowForAdapter.riskConfig) {
            const rc = botRowForAdapter.riskConfig as Record<string, unknown>;
            delete rc.takeProfitPercent;
            delete rc.stopLossPercent;
            delete rc.takeProfitPrice;
            delete rc.stopLossPrice;
            await storage.updateTradingBot(botId, { riskConfig: rc } as any);
          }
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: true, liquidation: closeDetection.reason === 'liquidation' };
        }

        // Back-stop dedup: the webhook/manual/pause/subscriber close path may
        // have ALREADY booked this close under a different canonical id
        // (`tx-<close-tx-signature>` vs the reconciler's `tx-<exchange-fill-id>`),
        // which the protocolFillId unique index can't collapse. If a recent
        // canonical close from a non-reconciler path already exists for this
        // bot+market+approx size (at/after this position's last activity), the
        // close is already counted — skip the duplicate insert (which would
        // double-count realized PnL) but STILL flatten the stale DB position.
        const alreadyBooked = await storage.getRecentCanonicalCloseForBot({
          botId,
          market,
          // Wide window so delayed reconciliation (server restart / backlog)
          // still matches a close booked by another path; afterTimestamp keeps
          // the effective floor at this position's last activity.
          sinceMs: 60 * 60 * 1000,
          afterTimestamp: dbPosition!.lastTradeAt ?? null,
          sizeApprox: Math.abs(dbBaseSize),
          sizeTolerancePct: 0.10,
          excludeReconciled: true,
          // Close side opposite the open position; matches 'CLOSE' rows too.
          closeSide: dbBaseSize > 0 ? 'short' : 'long',
        });
        if (alreadyBooked) {
          console.log(`[Reconcile] Close for bot ${botId} ${market} already booked by another path (tradeId=${alreadyBooked.id}, fillId=${alreadyBooked.protocolFillId ?? 'null'}, status=${alreadyBooked.status}) — skipping duplicate insert, flattening stale position only`);
          // Flatten WITHOUT re-adding PnL/fees: the other path already booked
          // them into bot_trades + stats. Re-adding here would double-count.
          await storage.upsertBotPosition({
            tradingBotId: botId,
            walletAddress,
            market,
            baseSize: "0",
            avgEntryPrice: dbPosition!.avgEntryPrice,
            costBasis: "0",
            realizedPnl: dbPosition!.realizedPnl || "0",
            totalFees: dbPosition!.totalFees || "0",
            lastTradeId: dbPosition!.lastTradeId,
            lastTradeAt: new Date(),
          });
          {
            const botForClear = await storage.getTradingBotById(botId);
            if (botForClear?.riskConfig) {
              const rc = botForClear.riskConfig as Record<string, unknown>;
              delete rc.takeProfitPercent;
              delete rc.stopLossPercent;
              delete rc.takeProfitPrice;
              delete rc.stopLossPrice;
              await storage.updateTradingBot(botId, { riskConfig: rc } as any);
            }
          }
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: true };
        }

        // Canonical close-event ID. Protocol fill identity remains primary.
        // Without a fill, bind to the durable position-entry epoch rather than
        // mutable estimate price or activity time. The reconciler's flat and
        // venue-resync paths both preserve lastTradeId, so one continuously
        // open economic position cannot mint a second close identity after a
        // false flatten/reopen cycle.
        const closeFee = closeDetection.fee ?? 0;
        const closePnl = (closeDetection.pnl ?? 0) - closeFee;
        const closeFillPrice = closeDetection.fillPrice ?? parseFloat(dbPosition!.avgEntryPrice);
        const closeNotional = closeFillPrice * Math.abs(dbBaseSize);
        const dedupKey = canonicalReconcilerFullCloseId({
          protocolFillId: closeDetection.protocolFillId,
          botId,
          market,
          positionEpochId: dbPosition!.lastTradeId,
        });
        if (!dedupKey) {
          console.error(
            `[Reconcile] Refusing no-fill close accounting for bot ${botId} ${market} - ` +
            `database position has no durable lastTradeId epoch`,
          );
          lastReconcileTime.set(botId, Date.now());
          return { synced: false, discrepancy: true };
        }

        console.log(`[Reconcile] Position closed on-chain for bot ${botId} ${market}: reason=${closeDetection.reason}, fill=$${closeFillPrice.toFixed(4)}, pnl=$${closePnl.toFixed(4)}`);

        // Atomic: insert canonical close row + recompute stats in ONE
        // DB transaction (task #67 requirement). Idempotency hits skip
        // the recompute internally so racing reconciler/webhook/retry
        // writes converge without double-counting deltas.
        const { isNew } = await storage.recordCloseEventAtomic({
          botId,
          insert: {
            tradingBotId: botId,
            walletAddress,
            market,
            side: dbBaseSize > 0 ? 'short' : 'long',
            size: String(Math.abs(dbBaseSize)),
            price: String(closeFillPrice),
            fee: String(closeFee),
            // Canonical close: realized PnL is required (breakeven uses '0', never null).
            pnl: String(closePnl),
            pnlConvention: 'net_of_close_fee',
            feeTruthStatus: 'current_pipeline',
            status: closeDetection.reason === 'liquidation' ? 'liquidated' : 'executed',
            protocolFillId: dedupKey,
            webhookPayload: {
              reconciled: true,
              closeReason: closeDetection.reason,
              detectedAt: new Date().toISOString(),
              protocolFillId: closeDetection.protocolFillId,
              matchedFillIdsForDiagnostics: closeDetection.matchedFillIdsForDiagnostics,
            },
            executionMethod: 'on-chain-detected',
          },
          deltas: {
            totalPnlDelta: closePnl,
            totalVolumeDelta: closeNotional,
            lastTradeAt: new Date().toISOString(),
          },
        });

        if (!isNew) {
          console.log(`[Reconcile] Close already recorded for bot ${botId} ${market} (dedupKey=${dedupKey}), skipping duplicate stats update`);
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: false };
        }

        // Fire Telegram notification exactly once per detected close: gated on
        // `isNew=true` so racing reconciler ticks / cross-path replays
        // (manual-close already wrote the canonical row) never double-fire.
        // Fire-and-forget; never let a Telegram failure mask reconciliation.
        try {
          const reasonLabel = getCloseReasonLabel(closeDetection.reason, closeDetection.tpslSubtype);
          const botRow = await storage.getTradingBotById(botId);
          const botName = botRow?.name ?? 'Bot';
          sendTradeNotification(walletAddress, {
            type: 'position_closed',
            botName,
            market,
            side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(dbBaseSize),
            price: closeFillPrice,
            pnl: closePnl,
            closeReason: reasonLabel,
          }).catch(err => console.error(`[Reconcile] Notification error for bot ${botId}:`, err));
        } catch (notifErr) {
          console.error(`[Reconcile] Failed to dispatch close notification for bot ${botId}:`, notifErr);
        }

        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: "0",
          avgEntryPrice: dbPosition!.avgEntryPrice,
          costBasis: "0",
          realizedPnl: String(parseFloat(dbPosition!.realizedPnl || "0") + closePnl),
          totalFees: String(parseFloat(dbPosition!.totalFees || "0") + closeFee),
          lastTradeId: dbPosition!.lastTradeId,
          lastTradeAt: new Date(),
        });

        {
          const botForClear = await storage.getTradingBotById(botId);
          if (botForClear?.riskConfig) {
            const rc = botForClear.riskConfig as Record<string, unknown>;
            delete rc.takeProfitPercent;
            delete rc.stopLossPercent;
            delete rc.takeProfitPrice;
            delete rc.stopLossPrice;
            await storage.updateTradingBot(botId, { riskConfig: rc } as any);
          }
        }

        lastReconcileTime.set(botId, Date.now());
        return { synced: true, discrepancy: true, liquidation: closeDetection.reason === 'liquidation' };
      }

      console.log(`[Reconcile] On-chain empty but DB has ${dbBaseSize} ${market} — no closing trade found on-chain, preserving DB.`);
      lastReconcileTime.set(botId, Date.now());
      return { synced: true, discrepancy: false };
    }

    const hasDiscrepancy = Math.abs(dbBaseSize - onChainBaseSize) > 0.0001;
    
    if (hasDiscrepancy) {
      console.log(`[Reconcile] Bot ${botId}: DB=${dbBaseSize}, OnChain=${onChainBaseSize} - syncing`);

      if (onChainHasRealPosition) {
        // ── Partial-reduction detection ─────────────────────────────────────
        // Same sign but on-chain is meaningfully smaller → some contracts were
        // closed externally (partial TP/SL, manual partial reduce). Book PnL
        // for the closed slice using the average-entry price from the DB.
        // Guard: 3-minute propagation lag (same as full-close path) prevents
        // false positives right after an entry.
        const sameSide =
          (dbBaseSize > 0 && onChainBaseSize > 0) ||
          (dbBaseSize < 0 && onChainBaseSize < 0);
        const closedSlice = Math.abs(dbBaseSize) - Math.abs(onChainBaseSize);
        const isAnyPartialReduction = sameSide && closedSlice > PARTIAL_CLOSE_BASE_DUST;

        if (isAnyPartialReduction) {
          // Search for this unit's durable marker before the legacy 3%/3-minute
          // external-reduction gates. A signed slice can be smaller or newer;
          // without a marker, the established external path remains unchanged.
          const recentTrades = await storage.getBotTrades(botId, 200) as PendingPartialCloseTradeLike[];
          const hasPendingPartialMarker = recentTrades.some((trade) => {
            const payload = partialMarkerPayload(trade);
            return payload !== null
              && normalizeMarket(trade.market) === normalizedMarket
              && String(trade.side).toLowerCase() === (dbBaseSize > 0 ? 'short' : 'long');
          });
          const positionAgeMs = dbPosition?.lastTradeAt
            ? Date.now() - new Date(dbPosition.lastTradeAt).getTime()
            : Infinity;
          const allowExternalAccounting = closedSlice / Math.abs(dbBaseSize) > 0.03
            && positionAgeMs >= 3 * 60 * 1000;

          if (hasPendingPartialMarker || allowExternalAccounting) {
            const partialResult = await bookPartialReduction({
              botId,
              walletAddress,
              market,
              agentPublicKey,
              botSubaccountPublicKey,
              dbBaseSize,
              dbPosition: dbPosition!,
              closedSlice,
              onChainBaseSize,
              onChainEntryPrice: onChainPos!.entryPrice,
              adapter,
              recentTrades,
              allowExternalAccounting,
            });
            if (partialResult === 'unknown-symbol-refusal') {
              lastReconcileTime.set(botId, Date.now());
              return { synced: false, discrepancy: true };
            }
          } else {
            console.log(`[Reconcile] Partial reduction detected for bot ${botId} ${market} but no signed marker exists and the external-reduction gates are not met`);
          }
        }

        // Always sync position to on-chain state (with accumulated PnL from bookPartialReduction).
        const refreshedDbPos = await storage.getBotPosition(botId, market);
        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: String(onChainBaseSize),
          avgEntryPrice: String(onChainPos!.entryPrice),
          costBasis: String(Math.abs(onChainBaseSize) * onChainPos!.entryPrice),
          realizedPnl: refreshedDbPos?.realizedPnl ?? dbPosition?.realizedPnl ?? "0",
          totalFees: refreshedDbPos?.totalFees ?? dbPosition?.totalFees ?? "0",
          lastTradeId: refreshedDbPos?.lastTradeId ?? dbPosition?.lastTradeId ?? null,
          lastTradeAt: new Date(),
        });
      }
    }
    
    lastReconcileTime.set(botId, Date.now());
    return { synced: true, discrepancy: hasDiscrepancy };
  } catch (error) {
    if (isDbTimeout(error)) {
      // Single retry after 2s on connection-class failures only (Neon handshake
      // transient — prod 07:31:24Z: "Authentication timed out" hit several bots
      // simultaneously while the pool itself was healthy). Never retries on
      // query or constraint errors.
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const retryResult = await reconcileBotPosition(botId, walletAddress, agentPublicKey, subAccountId, market, botSubaccountPublicKey);
        console.log(`[Reconcile] Retry succeeded for bot ${botId} after connection error`);
        return retryResult;
      } catch (retryErr) {
        console.error(`[Reconcile] Error for bot ${botId} (after retry):`, retryErr);
        return { synced: false, discrepancy: false };
      }
    }
    console.error(`[Reconcile] Error for bot ${botId}:`, error);
    return { synced: false, discrepancy: false };
  }
}

export async function reconcileAllBotsForWallet(walletAddress: string): Promise<{
  botsChecked: number;
  discrepancies: number;
}> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.agentPublicKey) {
    return { botsChecked: 0, discrepancies: 0 };
  }
  
  const bots = await storage.getTradingBots(walletAddress);
  let discrepancies = 0;
  
  for (const bot of bots) {
    const subAccountId = bot.driftSubaccountId ?? 0;
    const botSubPubKey = (bot.subaccountAuthMode === 'external_key' && bot.subaccountStatus === 'active' && bot.protocolSubaccountId)
      ? bot.protocolSubaccountId
      : undefined;
    const result = await reconcileBotPosition(
      bot.id,
      walletAddress,
      wallet.agentPublicKey,
      subAccountId,
      bot.market,
      botSubPubKey
    );
    if (result.discrepancy) discrepancies++;
  }
  
  return { botsChecked: bots.length, discrepancies };
}

export function isPositionStale(botId: string): boolean {
  const lastTime = lastReconcileTime.get(botId);
  if (!lastTime) return true;
  return Date.now() - lastTime > STALE_THRESHOLD_MS;
}

export async function reconcileIfStale(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string
): Promise<void> {
  if (isPositionStale(botId)) {
    await reconcileBotPosition(botId, walletAddress, agentPublicKey, subAccountId, market);
  }
}

let consecutiveDbTimeouts = 0;

function isDbTimeout(error: any): boolean {
  const msg = error?.message || "";
  return msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated");
}

export function startPeriodicReconciliation(): void {
  if (reconcileInterval) return;
  
  console.log("[Reconcile] Starting periodic reconciliation (every 60s)");
  
  reconcileInterval = setInterval(async () => {
    if (periodicReconciliationCycleInFlight) {
      console.warn("[Reconcile] Skipping tick - previous cycle still running");
      return;
    }

    periodicReconciliationCycleInFlight = true;
    try {
      if (consecutiveDbTimeouts > 0) {
        consecutiveDbTimeouts--;
      console.log(`[Reconcile] DB pressure backoff — skipping cycle (${consecutiveDbTimeouts} remaining)`);
        return;
      }
      const allWallets = await storage.getWalletsWithActiveBots();
      
      for (const walletAddress of allWallets) {
        const wallet = await storage.getWallet(walletAddress);
        if (!wallet?.agentPublicKey) continue;
        
        const bots = await storage.getTradingBots(walletAddress);
        
        const botsWithPositions = await Promise.all(
          bots.map(async (bot) => {
            if (bot.isActive) return bot;
            const pos = await storage.getBotPosition(bot.id, bot.market);
            if (pos && Math.abs(parseFloat(pos.baseSize)) > 0.0001) return bot;
            return null;
          })
        );
        const botsToReconcile = botsWithPositions.filter((b): b is typeof bots[0] => b !== null);
        
        if (botsToReconcile.length === 0) continue;
        
        for (const bot of botsToReconcile) {
          const subAccountId = bot.driftSubaccountId ?? 0;
          const botSubPubKey = (bot.subaccountAuthMode === 'external_key' && bot.subaccountStatus === 'active' && bot.protocolSubaccountId)
            ? bot.protocolSubaccountId
            : undefined;
          await reconcileBotPosition(
            bot.id,
            walletAddress,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            botSubPubKey
          );
        }
      }
      consecutiveDbTimeouts = 0;
    } catch (error) {
      if (isDbTimeout(error)) {
        consecutiveDbTimeouts = Math.min(consecutiveDbTimeouts + 3, 10);
        console.warn(`[Reconcile] DB timeout — backing off ${consecutiveDbTimeouts} cycles`);
      } else {
        console.error("[Reconcile] Periodic reconciliation error:", error);
      }
    } finally {
      periodicReconciliationCycleInFlight = false;
    }
  }, RECONCILE_INTERVAL_MS);
}

export function stopPeriodicReconciliation(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    console.log("[Reconcile] Stopped periodic reconciliation");
  }
}
