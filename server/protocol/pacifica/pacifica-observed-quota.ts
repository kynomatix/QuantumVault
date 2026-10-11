/** Grid authority uses observed deci-credits. The legacy adapter budget is not tier evidence. */
export interface QuotaObservation { quota: number; remaining: number; resetSeconds: number }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export function parseRestQuota(rate: string | null, policy: string | null): QuotaObservation | null {
  const r = /^"credits";r=(\d+);t=(\d+)$/.exec(rate ?? '');
  const p = /^"credits";q=(\d+);w=60$/.exec(policy ?? '');
  return r && p ? parseQuota({ r: Number(r[1]), q: Number(p[1]), t: Number(r[2]) }) : null;
}
export function parseQuota(raw: unknown): QuotaObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const { r, q, t } = raw as Record<string, unknown>;
  if (!integer(r) || !integer(q) || q === 0 || r > q || !integer(t) || t > 60) return null;
  return { quota: q, remaining: r, resetSeconds: t };
}
/** Action endpoint documentation defines WS reset-in in milliseconds, unlike REST. */
export function parseWsQuota(raw: unknown): QuotaObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const { r, q, t } = raw as Record<string, unknown>;
  if (!integer(t) || t > 60_000) return null;
  return parseQuota({ r, q, t: Math.floor(t / 1000) });
}
export const GRID_QUOTA_COST_DECI_CREDITS = Object.freeze({ heavyRead: 120, standard: 10, cancel: 5 });
export class ObservedPacificaQuota {
  private observation: (QuotaObservation & { observedAt: number; expiresAt: number }) | null = null;
  private reservations = new Map<string, { cost: number; at: number; settled: boolean }>();
  constructor(readonly domain: string, private now: () => number = Date.now) {
    if (!domain || domain.trim() !== domain) throw new Error('Invalid quota domain');
  }
  invalidate(): void { this.observation = null; }
  observe(raw: QuotaObservation | null): void {
    if (!raw || !parseQuota({ r: raw.remaining, q: raw.quota, t: raw.resetSeconds })) {
      this.invalidate(); return;
    }
    const at = this.now();
    const old = this.observation;
    // No reordered response or upgrade can mint budget within the current window.
    this.observation = { ...raw, observedAt: at, expiresAt: old && old.expiresAt > at ? Math.min(old.expiresAt, at + raw.resetSeconds * 1000) : at + raw.resetSeconds * 1000,
      quota: old && old.expiresAt > at ? Math.min(old.quota, raw.quota) : raw.quota,
      remaining: old && old.expiresAt > at ? Math.min(old.remaining, raw.remaining) : raw.remaining };
  }
  snapshot() {
    const now = this.now();
    for (const [id, r] of this.reservations) if (now - r.at >= 60_000) this.reservations.delete(id);
    const o = this.observation;
    const known = !!o && now < o.expiresAt && now - o.observedAt <= 60_000;
    const outstanding = [...this.reservations.values()].reduce((a, r) => a + r.cost, 0);
    const reserve = known ? Math.max(300, Math.ceil(o!.quota * .30)) : 300;
    return { domain: this.domain, availability: known ? 'observed' as const : 'unknown' as const,
      quotaDeciCredits: known ? o!.quota : null, remainingDeciCredits: known ? Math.max(0, o!.remaining - outstanding) : null,
      observedAt: known ? o!.observedAt : null, reserveDeciCredits: reserve, outstandingDeciCredits: outstanding,
      planningFallbackDeciCredits: 1000, tier: null,
      entryDeciCredits: known ? Math.max(0, Math.min(o!.remaining - outstanding - reserve, Math.floor(o!.quota * .60) - outstanding)) : 0 };
  }
  reserve(id: string, cost: number, priority: 'entry' | 'risk-reduction' = 'entry'): boolean {
    if (!id || !integer(cost) || cost === 0 || this.reservations.has(id)) return false;
    const s = this.snapshot();
    if (priority === 'entry' && (s.availability !== 'observed' || s.entryDeciCredits < cost)) return false;
    // Critical exits remain possible during quota trouble, and are still charged.
    this.reservations.set(id, { cost, at: this.now(), settled: false }); return true;
  }
  settle(id: string, disposition: 'not_sent' | 'sent' | 'uncertain'): boolean {
    const r = this.reservations.get(id);
    if (!r || r.settled) return false;
    if (disposition === 'not_sent') this.reservations.delete(id);
    else { r.settled = true; r.at = this.now(); }
    return true;
  }
}
