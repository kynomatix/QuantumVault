import { readPriceExcursion, validObservationTime, positiveObservationPrice,
  type PriceExcursion, type ExcursionObserved, type ExcursionUnavailableReason } from '@shared/ai-trader-excursion';

/** Operational bounds only: no trading parameter, timer, I/O or unbounded queue. */
const MAX_WINDOW_BARS = 20_000;
export class ExcursionObservations {
  private readonly entries = new Map<string, PriceExcursion>();
  constructor(private readonly bootId: string, private readonly maxEntries = 128) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(bootId) || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 512)
      throw new Error('Invalid observation store configuration');
  }
  private unavailable(reason: ExcursionUnavailableReason): PriceExcursion {
    return { version: 1, status: 'unavailable', bootId: this.bootId, reason };
  }
  private put(id: string, value: PriceExcursion) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return;
    this.entries.delete(id); this.entries.set(id, value);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  get size() { return this.entries.size; }
  forget(id: string) { this.entries.delete(id); }
  clear() { this.entries.clear(); }
  /** Recompute the fetched paper window; never retain later bars when an earlier hit is discovered. */
  paper(id: string, bars: readonly unknown[], decisionMs: number, timeframeMs: number,
    nowMs: number, hitCandleMs: number | null): void {
    try {
      if (!Array.isArray(bars) || !validObservationTime(decisionMs) || !validObservationTime(nowMs)
        || !Number.isSafeInteger(timeframeMs) || timeframeMs <= 0 || nowMs < decisionMs
        || (hitCandleMs !== null && (!validObservationTime(hitCandleMs) || hitCandleMs % timeframeMs !== 0))) {
        this.put(id,this.unavailable('malformed_window')); return;
      }
      const first = Math.floor(decisionMs / timeframeMs) * timeframeMs + timeframeMs;
      const end = Math.min(Math.floor(nowMs / timeframeMs) * timeframeMs, hitCandleMs ?? Infinity);
      const expected = Math.max(0, (end - first) / timeframeMs);
      if (bars.length > MAX_WINDOW_BARS || expected > MAX_WINDOW_BARS) {
        this.put(id,this.unavailable('window_limit')); return;
      }
      let snapshot: ExcursionObserved | null = null, previousTime = -1;
      for (const raw of bars) {
        const c = raw as any;
        if (!c || !validObservationTime(c.time)) { this.put(id,this.unavailable('malformed_window')); return; }
        if (c.time <= previousTime) { this.put(id,this.unavailable('malformed_window')); return; }
        previousTime = c.time;
        if (c.time < first || c.time >= end) continue;
        if (c.time % timeframeMs !== 0 || ![c.open,c.high,c.low,c.close].every(positiveObservationPrice)
          || c.low > Math.min(c.open,c.close) || c.high < Math.max(c.open,c.close)) {
          this.put(id,this.unavailable('malformed_window')); return;
        }
        const p = c.provenance;
        if (!p || p.finality !== 'finalized') continue; // unknown/unfinalized coverage stays missing
        const source = { provider: p.source, venue: p.venue, basis: p.basis, proxy: p.proxy, timeSemantic: p.timeSemantic };
        const one: ExcursionObserved = { version: 1, status: 'observed', bootId: this.bootId, coverage: 'partial',
          basis: 'paper_closed_candles', decisionStartedAtMs: decisionMs, fromMs: c.time, throughMs: c.time,
          sampleCount: 1, timeframeMs, expectedInteriorBars: expected, missingInteriorBars: expected - 1,
          high: { price: c.high, atMs: c.time }, low: { price: c.low, atMs: c.time }, source };
        if (!readPriceExcursion(one)) continue;
        if (!snapshot) snapshot = one;
        else {
          if (JSON.stringify(snapshot.source) !== JSON.stringify(source)) {
            this.put(id,this.unavailable('mixed_provenance')); return;
          }
          snapshot.throughMs = c.time;
          snapshot.sampleCount++;
          snapshot.missingInteriorBars = expected - snapshot.sampleCount;
          if (c.high > snapshot.high.price) snapshot.high = { price: c.high, atMs: c.time };
          if (c.low < snapshot.low.price) snapshot.low = { price: c.low, atMs: c.time };
        }
      }
      this.put(id, snapshot ?? this.unavailable('empty_window'));
    } catch { this.put(id,this.unavailable('malformed_window')); }
  }
  /** Marks are sparse polls, not candle extrema; collection resumes fresh after restart/eviction. */
  live(id: string, price: unknown, decisionMs: number, nowMs: number, protocol: string): void {
    try {
      if (!positiveObservationPrice(price) || !validObservationTime(decisionMs)
        || !validObservationTime(nowMs) || nowMs <= decisionMs) return;
      const previous = this.entries.get(id);
      const old = previous?.status === 'observed' && previous.basis === 'live_sampled_marks'
        && previous.decisionStartedAtMs === decisionMs && previous.source.provider === protocol ? previous : null;
      if (old && nowMs <= old.throughMs) return;
      const next: ExcursionObserved = old ? { ...old, high: { ...old.high }, low: { ...old.low },
        throughMs: nowMs, sampleCount: old.sampleCount + 1 } : {
        version: 1, status: 'observed', bootId: this.bootId, coverage: 'partial', basis: 'live_sampled_marks',
        decisionStartedAtMs: decisionMs, fromMs: nowMs, throughMs: nowMs, sampleCount: 1,
        timeframeMs: null, expectedInteriorBars: null, missingInteriorBars: null,
        high: { price, atMs: nowMs }, low: { price, atMs: nowMs },
        source: { provider: protocol, venue: protocol, basis: 'mark', proxy: 'direct', timeSemantic: 'monitor_read_time' },
      };
      if (price > next.high.price) next.high = { price, atMs: nowMs };
      if (price < next.low.price) next.low = { price, atMs: nowMs };
      const checked = readPriceExcursion(next);
      if (checked) this.put(id, checked);
    } catch { /* optional observation cannot block protective work */ }
  }
  forClose(id: string, decisionMs: number, closedMs: number): PriceExcursion {
    const value = this.entries.get(id);
    if (!value) return this.unavailable('no_retained_observation');
    const checked = readPriceExcursion(value, { decisionStartedAtMs: decisionMs, closedAtMs: closedMs });
    return checked ?? this.unavailable('terminal_precedes_sample');
  }
}
