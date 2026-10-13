import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';
import { freshPacificaPrice, parsePacificaPrices } from '../protocol/pacifica/pacifica-prices';

type Observation = { price: number; observedAt: number };

/** Planner-only observations; never mutate the trading adapter's price cache. */
export class PlannerReferences {
  private cache = new Map<string, Observation>();
  private jobs = new Map<string, Promise<void>>();
  private starts: number[] = [];
  private bulkJob: Promise<Map<string, Observation>> | null = null;
  constructor(private now = Date.now) {}
  cached(market: string) {
    const entry = this.cache.get(market);
    return entry && freshPacificaPrice(entry, this.now(), 60_000) ? entry : null;
  }
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
      if (!/^[A-Za-z0-9-]+$/.test(symbol)) throw Error('Invalid Pacifica price symbol');
      if (!this.bulkJob) {
        if (!pacificaQuota.tryClaimImmediate('/info/prices', 'background', 'grid-planner.reference')) {
          console.info(`[GridPlannerPrice] market=${market} reason=quota`);
          throw Error('Price busy, retrying');
        }
        this.bulkJob = this.readBulk().finally(() => { this.bulkJob = null; });
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
    let observation: Observation | undefined;
    try { observation = (await this.bulkJob!).get(symbol); }
    catch (error) {
      const reason = error instanceof Error && error.message.startsWith('Pacifica midpoint unavailable (') ? 'http' : 'transport';
      console.info(`[GridPlannerPrice] market=${market} reason=${reason}`);
      throw error;
    }
    // Different markets share one physical read without renewing any row.
    if (!observation) {
      console.info(`[GridPlannerPrice] market=${market} reason=validation`);
      throw Error('Fresh Pacifica midpoint unavailable: invalid, missing or expired observation');
    }
    // Retain the Planner's conservative transit-time limit as well as venue age.
    const { price } = observation, observedAt = Math.min(startedAt, observation.observedAt);
    if (!freshPacificaPrice({ price, observedAt }, this.now(), 60_000)) throw Error('Fresh Pacifica midpoint expired');
    this.cache.delete(market);
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(market, { price, observedAt });
  }
  private async readBulk(): Promise<Map<string, Observation>> {
    const response = await fetch('https://api.pacifica.fi/api/v1/info/prices',
      { signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw Error(`Pacifica midpoint unavailable (${response.status})`);
    return parsePacificaPrices(await response.json(), this.now(), 60_000);
  }
}
