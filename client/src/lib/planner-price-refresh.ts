import { clientObservationDeadline, isPlannerMarket, plannerRangeAround, PlannerRequestGeneration, type PlannerMarket } from './grid-planner-view';

export type PlannerMarketObservation = { markets: PlannerMarket[]; serverNow: number; startedAt: number };
type Range = NonNullable<ReturnType<typeof plannerRangeAround>>;

/** Owns both periodic reads and delayed shortcuts, so late responses cannot edit a newer form. */
export class PlannerPriceRefresh {
  private generation = new PlannerRequestGeneration();
  private pending: Promise<PlannerMarketObservation | null> | null = null;
  private observation: PlannerMarketObservation | null = null;
  private intent = 0;
  private disposed = false;
  private paused = false;
  constructor(private market: string, private read: (signal: AbortSignal) => Promise<unknown>,
    private onObservation: (value: PlannerMarketObservation) => void,
    private onStatus: (loading: boolean, error: string) => void, private now = Date.now) {}
  cancelShortcut() { this.intent++; }
  pause() { this.paused = true; this.cancelShortcut(); this.generation.invalidate(); this.pending = null; this.onStatus(false, ''); }
  dispose() { this.disposed = true; this.cancelShortcut(); this.generation.invalidate(); this.pending = null; }
  refresh(): Promise<PlannerMarketObservation | null> {
    if (this.disposed) return Promise.resolve(null);
    this.paused = false;
    if (this.pending) return this.pending;
    const request = this.generation.start(), startedAt = this.now();
    this.onStatus(true, '');
    const pending = Promise.resolve().then(() => this.read(AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])))
      .then(value => {
        if (!request.current()) return null;
        if (!value || typeof value !== 'object') throw Error('Invalid market response');
        const response = value as Record<string, any>;
        if (response.state !== 'available' || !Array.isArray(response.markets) || response.markets.length > 512
          || !response.markets.every(isPlannerMarket) || !Number.isSafeInteger(response.retrievedAt)
          || response.markets.some((m: PlannerMarket) => m.reference.state === 'available' && m.reference.value.observedAt > response.retrievedAt)) throw Error('Invalid market response');
        const observation = { markets: response.markets as PlannerMarket[], serverNow: response.retrievedAt, startedAt };
        this.observation = observation; this.onObservation(observation);
        const selected = observation.markets.find(m => m.market === this.market);
        const reason = !this.market ? '' : selected?.reference.state === 'unavailable' ? selected.reference.reason
          : this.range(observation, 1) ? '' : 'Fresh price unavailable: observation expired or market missing';
        this.onStatus(false, reason);
        return observation;
      }).catch(error => { if (request.current()) this.onStatus(false, error instanceof Error ? error.message : 'Fresh price unavailable'); return null; })
      .finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  async apply(percent: number, onRange: (range: Range) => void): Promise<boolean> {
    const intent = ++this.intent;
    if (this.disposed || this.paused || !this.market || !Number.isFinite(percent) || percent < 1 || percent > 40) return false;
    let range = this.range(this.observation, percent);
    if (!range) range = this.range(await this.refresh(), percent);
    if (!range || this.disposed || this.paused || intent !== this.intent) return false;
    onRange(range); return true;
  }
  private range(observation: PlannerMarketObservation | null, percent: number) {
    const selected = observation?.markets.find(m => m.market === this.market);
    const deadline = selected?.reference.state === 'available' && observation
      ? clientObservationDeadline(selected.reference.value.expiresAt, observation.serverNow, observation.startedAt) : 0;
    return plannerRangeAround(selected, deadline, this.now(), percent);
  }
}

export function watchPlannerPrice(controller: PlannerPriceRefresh,
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const wake = () => {
    clearInterval(timer); timer = undefined;
    if (visibility.hidden) { controller.pause(); return; }
    void controller.refresh();
    timer = setInterval(() => { void controller.refresh(); }, 20_000);
  };
  visibility.addEventListener('visibilitychange', wake); wake();
  return () => { clearInterval(timer); visibility.removeEventListener('visibilitychange', wake); controller.dispose(); };
}
