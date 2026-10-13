import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';

type Observation = { price: number; observedAt: number };

/** Planner-only observations; never mutate the trading adapter's price cache. */
export class PlannerReferences {
  private cache = new Map<string, Observation>();
  private jobs = new Map<string, Promise<void>>();
  private starts: number[] = [];
  constructor(private now = Date.now) {}
  cached(market: string) { return this.cache.get(market) ?? null; }
  async refresh(market: string, symbol: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let job = this.jobs.get(market);
    if (!job) {
      const startedAt = this.now();
      this.starts = this.starts.filter(t => startedAt - t < 60_000);
      if (this.jobs.size >= 10 || this.starts.length >= 30) {
        console.info(`[GridPlannerPrice] market=${market} reason=capacity`);
        throw Error('Price busy, retrying');
      }
      if (!/^[A-Z0-9]+$/.test(symbol)) throw Error('Invalid Pacifica price symbol');
      if (!pacificaQuota.tryClaimImmediate('/book', 'background')) {
        console.info(`[GridPlannerPrice] market=${market} reason=quota`);
        throw Error('Price busy, retrying');
      }
      this.starts.push(startedAt);
      // The shared physical read is bounded independently of any one HTTP caller.
      job = this.read(market, symbol, startedAt).finally(() => { this.jobs.delete(market); });
      this.jobs.set(market, job);
    }
    await job;
    signal.throwIfAborted();
  }
  private async read(market: string, symbol: string, startedAt: number) {
    try { await this.readBook(market, symbol, startedAt); }
    catch (error) {
      const reason = error instanceof Error && error.message.startsWith('Fresh Pacifica') ? 'validation'
        : error instanceof Error && error.message.startsWith('Pacifica book price') ? 'http' : 'transport';
      console.info(`[GridPlannerPrice] market=${market} reason=${reason}`);
      throw error;
    }
  }
  private async readBook(market: string, symbol: string, startedAt: number) {
    const response = await fetch(`https://api.pacifica.fi/api/v1/book?${new URLSearchParams({ symbol })}`,
      { signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw Error(`Pacifica book price unavailable (${response.status})`);
    let payload;
    try { payload = await response.json(); } catch { throw Error('Fresh Pacifica book price unavailable: invalid JSON'); }
    const book = payload?.data;
    const timestamp = typeof book?.t === 'string' && /^\d{13}$/.test(book.t) ? Number(book.t) : book?.t;
    const observedAt = Math.min(startedAt, timestamp);
    if (payload?.success !== true || book?.s !== symbol || !Array.isArray(book.l) || book.l.length !== 2
      || !book.l.every((levels: unknown) => Array.isArray(levels) && levels.length > 0 && levels.length <= 10)
      || !Number.isSafeInteger(timestamp) || timestamp > this.now() || observedAt + 60_000 <= this.now()) {
      throw Error('Fresh Pacifica book price unavailable: invalid or expired observation');
    }
    const prices = book.l.map((levels: { p: unknown }[]) => {
      const value = levels[0]?.p;
      return typeof value === 'string' && value.length <= 37 && /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value) ? Number(value) : NaN;
    });
    const [bid, ask] = prices, price = bid / 2 + ask / 2;
    if (!Number.isFinite(price) || bid <= 0 || ask <= 0 || bid > ask) throw Error('Fresh Pacifica book price unavailable: invalid bid or ask');
    this.cache.delete(market);
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(market, { price, observedAt });
  }
}
