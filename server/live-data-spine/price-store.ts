/**
 * In-memory price store for the Live-Data Spine (Phase 0, read-only).
 *
 * Keyed by `venue:internalSymbol`. Per symbol it keeps ONLY the latest tick plus
 * a fixed-capacity ring of |mark - oracle| / oracle deviations — never raw tick
 * history. Bounded by construction: the symbol set is the union of symbols the
 * venues stream, and each ring has a hard capacity.
 */

import { RingBuffer, computeBasisStats } from './ring-buffer.js';
import type { PriceTick, SymbolStatus, Venue } from './types.js';

/** Deviation samples retained per symbol for basis characterisation. */
const DEFAULT_BASIS_RING_CAPACITY = 600;
/** Hard cap on tracked symbols — defense-in-depth vs adversarial feed symbol churn. */
const DEFAULT_MAX_SYMBOLS = 5_000;

interface SymbolEntry {
  venue: Venue;
  internalSymbol: string;
  latest: PriceTick | null;
  lastSeenAt: number | null;
  tickCount: number;
  basisDeviations: RingBuffer<number>;
}

export class PriceStore {
  private entries = new Map<string, SymbolEntry>();
  /** Feed-level parse failures (cannot always be attributed to a symbol). */
  private parseErrorCount = 0;
  /** New symbols rejected because the symbol cap was reached. */
  private droppedSymbolCount = 0;

  constructor(
    private readonly basisRingCapacity: number = DEFAULT_BASIS_RING_CAPACITY,
    private readonly maxSymbols: number = DEFAULT_MAX_SYMBOLS,
  ) {}

  private static key(venue: Venue, internalSymbol: string): string {
    return `${venue}:${internalSymbol}`;
  }

  /**
   * Record a real-time tick. A non-finite mark is treated as a feed parse error
   * and does NOT overwrite the last good tick (fail-soft: keep last known good).
   * A brand-new symbol is dropped (and counted) once the symbol cap is reached,
   * so a misbehaving feed cannot grow the store without bound.
   */
  recordTick(tick: PriceTick): void {
    if (!Number.isFinite(tick.mark)) {
      this.parseErrorCount++;
      return;
    }
    const key = PriceStore.key(tick.venue, tick.internalSymbol);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxSymbols) {
        this.droppedSymbolCount++;
        return;
      }
      entry = {
        venue: tick.venue,
        internalSymbol: tick.internalSymbol,
        latest: null,
        lastSeenAt: null,
        tickCount: 0,
        basisDeviations: new RingBuffer<number>(this.basisRingCapacity),
      };
      this.entries.set(key, entry);
    }
    entry.latest = tick;
    entry.lastSeenAt = tick.receivedAt;
    entry.tickCount++;

    if (
      tick.oracle != null &&
      Number.isFinite(tick.oracle) &&
      tick.oracle > 0
    ) {
      const deviation = Math.abs(tick.mark - tick.oracle) / tick.oracle;
      if (Number.isFinite(deviation)) {
        entry.basisDeviations.push(deviation);
      }
    }
  }

  /** Record a feed-level parse failure that could not be attributed to a tick. */
  recordParseError(): void {
    this.parseErrorCount++;
  }

  getParseErrorCount(): number {
    return this.parseErrorCount;
  }

  getDroppedSymbolCount(): number {
    return this.droppedSymbolCount;
  }

  symbolCount(): number {
    return this.entries.size;
  }

  /** Latest tick for one symbol, or null if never seen. */
  getLatest(venue: Venue, internalSymbol: string): PriceTick | null {
    return this.entries.get(PriceStore.key(venue, internalSymbol))?.latest ?? null;
  }

  /** Per-symbol status snapshot (computes basis stats on demand). */
  getStatus(now: number = Date.now()): SymbolStatus[] {
    const out: SymbolStatus[] = [];
    for (const entry of this.entries.values()) {
      out.push({
        venue: entry.venue,
        internalSymbol: entry.internalSymbol,
        latest: entry.latest,
        lastSeenAt: entry.lastSeenAt,
        ageMs: entry.lastSeenAt == null ? null : now - entry.lastSeenAt,
        tickCount: entry.tickCount,
        basis: computeBasisStats(entry.basisDeviations.toArray()),
      });
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
    this.parseErrorCount = 0;
    this.droppedSymbolCount = 0;
  }
}
