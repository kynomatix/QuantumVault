/**
 * Live-Data & Monitoring Spine — singleton service (Phase 0, tracer bullet).
 *
 * Wires the bounded PriceStore to two real-time feeds (Pacifica public `prices`
 * WS + Flash Pyth Hermes SSE) and logs feed health + the mark-vs-oracle basis
 * distribution on an interval. READ-ONLY shadow mode: NO consumers, NO trading,
 * NO money path, NO DB writes, NO HTTP routes.
 *
 * Gated by the `SPINE_ENABLED` env flag (default OFF). When off, init is a no-op.
 * Mirrors the module-singleton lifecycle style of leverage-cache-service.ts.
 *
 * See docs/LIVE_DATA_SPINE_PLAN.md. STOP line: Phase 2 (risk engine / platform
 * stops) moves money and requires explicit owner go-ahead before being wired.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { PriceStore } from './price-store.js';
import { PacificaPricesWsManager } from './pacifica-prices-ws.js';
import { FlashPythSseManager } from './flash-pyth-sse.js';
import { FLASH_PYTH_PRICE_IDS } from '../protocol/flash/flash-constants.js';
import type { SymbolStatus } from './types.js';

const LOG_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 30_000;

/** Pacifica protocol→internal symbol map (mirrors symbol-registry special cases). */
const PACIFICA_SPECIAL: Record<string, string> = {
  KBONK: '1MBONK-PERP',
  KPEPE: '1MPEPE-PERP',
};

export function pacificaMapSymbol(protocolSymbol: string): string {
  const upper = protocolSymbol.toUpperCase();
  return PACIFICA_SPECIAL[upper] ?? `${upper}-PERP`;
}

/** Count symbols whose latest tick is older than the stale threshold. */
export function countStaleSymbols(
  statuses: SymbolStatus[],
  staleThresholdMs: number,
  now: number,
): number {
  let stale = 0;
  for (const s of statuses) {
    if (s.lastSeenAt != null && now - s.lastSeenAt > staleThresholdMs) stale++;
  }
  return stale;
}

export interface BasisSummaryRow {
  internalSymbol: string;
  p50: number;
  p99: number;
  count: number;
}

/** Worst-N symbols by basis p99 (|mark-oracle|/oracle), descending. */
export function topBasisDeviations(statuses: SymbolStatus[], n: number): BasisSummaryRow[] {
  return statuses
    .filter((s) => s.basis != null && s.basis.count > 0)
    .map((s) => ({
      internalSymbol: s.internalSymbol,
      p50: s.basis!.p50,
      p99: s.basis!.p99,
      count: s.basis!.count,
    }))
    .sort((a, b) => b.p99 - a.p99)
    .slice(0, Math.max(0, n));
}

interface SpineState {
  store: PriceStore;
  pacifica: PacificaPricesWsManager;
  flash: FlashPythSseManager;
  logTimer: ReturnType<typeof setInterval> | null;
  eld: IntervalHistogram | null;
  startedAt: number;
  lastTotalTicks: number;
  pacificaHealthy: boolean;
  flashHealthy: boolean;
}

let state: SpineState | null = null;

export function isLiveDataSpineEnabled(): boolean {
  return process.env.SPINE_ENABLED === 'true';
}

export function initLiveDataSpine(): void {
  if (!isLiveDataSpineEnabled()) {
    console.log('[Spine] SPINE_ENABLED!=true — Live-Data Spine disabled (Phase 0 shadow mode)');
    return;
  }
  if (state) {
    console.warn('[Spine] already initialized; ignoring duplicate init');
    return;
  }

  const store = new PriceStore();

  const pacifica = new PacificaPricesWsManager({
    mapSymbol: pacificaMapSymbol,
    onTick: (t) => store.recordTick(t),
    onHealth: (h) => {
      if (state) state.pacificaHealthy = h;
    },
    onParseError: (count) => {
      for (let i = 0; i < count; i++) store.recordParseError();
    },
  });

  const flash = new FlashPythSseManager({
    feedMap: FLASH_PYTH_PRICE_IDS,
    onTick: (t) => store.recordTick(t),
    onHealth: (h) => {
      if (state) state.flashHealthy = h;
    },
    onParseError: (count) => {
      for (let i = 0; i < count; i++) store.recordParseError();
    },
  });

  let eld: IntervalHistogram | null = null;
  try {
    eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
  } catch {
    eld = null;
  }

  state = {
    store,
    pacifica,
    flash,
    logTimer: null,
    eld,
    startedAt: Date.now(),
    lastTotalTicks: 0,
    pacificaHealthy: false,
    flashHealthy: false,
  };

  pacifica.connect();
  flash.connect();

  const timer = setInterval(() => {
    try {
      logSpineHealth();
    } catch (err) {
      console.error('[Spine] health log error:', err);
    }
  }, LOG_INTERVAL_MS);
  // Never let the log timer keep the process alive on shutdown.
  timer.unref?.();
  state.logTimer = timer;

  console.log(
    `[Spine] started — Pacifica prices WS + Flash Pyth SSE (${Object.keys(FLASH_PYTH_PRICE_IDS).length} Flash feeds). READ-ONLY shadow mode.`,
  );
}

function logSpineHealth(): void {
  if (!state) return;
  const now = Date.now();
  const statuses = state.store.getStatus(now);

  let totalTicks = 0;
  for (const s of statuses) totalTicks += s.tickCount;
  const ticksThisInterval = totalTicks - state.lastTotalTicks;
  state.lastTotalTicks = totalTicks;

  const stale = countStaleSymbols(statuses, STALE_THRESHOLD_MS, now);
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1048576).toFixed(0);
  const heapMb = (mem.heapUsed / 1048576).toFixed(0);
  let lagP99 = 'n/a';
  if (state.eld) {
    lagP99 = (state.eld.percentile(99) / 1e6).toFixed(1);
    state.eld.reset();
  }

  console.log(
    `[Spine] pacifica=${state.pacificaHealthy ? 'up' : 'down'}(r${state.pacifica.getStatus().reconnectCount}) ` +
      `flash=${state.flashHealthy ? 'up' : 'down'}(r${state.flash.getStatus().reconnectCount}) ` +
      `symbols=${state.store.symbolCount()} ticks/min=${ticksThisInterval} stale=${stale} ` +
      `parseErr=${state.store.getParseErrorCount()} dropped=${state.store.getDroppedSymbolCount()} rss=${rssMb}MB heap=${heapMb}MB loopLagP99=${lagP99}ms`,
  );

  const worst = topBasisDeviations(statuses, 5);
  if (worst.length > 0) {
    const parts = worst.map(
      (w) => `${w.internalSymbol} p50=${(w.p50 * 100).toFixed(3)}% p99=${(w.p99 * 100).toFixed(3)}% (n=${w.count})`,
    );
    console.log(`[Spine] basis |mark-oracle|/oracle worst: ${parts.join(' | ')}`);
  }
}

export function stopLiveDataSpine(): void {
  if (!state) return;
  if (state.logTimer) clearInterval(state.logTimer);
  try {
    state.eld?.disable();
  } catch {
    // ignore
  }
  try {
    state.pacifica.disconnect();
  } catch {
    // ignore
  }
  try {
    state.flash.disconnect();
  } catch {
    // ignore
  }
  console.log('[Spine] stopped');
  state = null;
}

export function getLiveDataSpineStatus() {
  if (!state) {
    return { enabled: isLiveDataSpineEnabled(), running: false };
  }
  return {
    enabled: true,
    running: true,
    startedAt: state.startedAt,
    pacifica: { healthy: state.pacificaHealthy, ...state.pacifica.getStatus() },
    flash: { healthy: state.flashHealthy, ...state.flash.getStatus() },
    symbolCount: state.store.symbolCount(),
    parseErrors: state.store.getParseErrorCount(),
    droppedSymbols: state.store.getDroppedSymbolCount(),
    symbols: state.store.getStatus(),
  };
}
