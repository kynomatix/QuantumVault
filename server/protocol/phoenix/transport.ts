import { PHOENIX_PUBLIC_API } from './sdk-boundary';

export type PhoenixPublicPath = '/v1/view/exchange' | '/v1/view/exchange/status';
export interface PhoenixPublicTransport { get(path: PhoenixPublicPath): Promise<unknown> }

/** Fixed-origin, GET-only, bounded public transport. No credentials or RPC. */
export class PhoenixRestTransport implements PhoenixPublicTransport {
  private inFlight = false;
  private nextAllowedAt = 0;
  private readonly endpointBudgets = new Map<PhoenixPublicPath, number>();
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 5_000,
    private readonly minRequestIntervalMs = 1_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000
      || !Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 0) throw new Error('Invalid Phoenix read budget');
  }

  async get(path: PhoenixPublicPath): Promise<unknown> {
    if (!['/v1/view/exchange', '/v1/view/exchange/status'].includes(path)) throw new Error('Unsupported public path');
    if (this.inFlight || this.now() < this.nextAllowedAt
      || this.now() < (this.endpointBudgets.get(path) ?? 0)) throw new Error('Phoenix read budget exhausted');
    this.inFlight = true;
    this.endpointBudgets.set(path, this.now() + this.minRequestIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(PHOENIX_PUBLIC_API + path, {
        method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const date = retry ? Date.parse(retry) : NaN;
        const ms = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? date - this.now() : 60_000;
        // Never shorten a published Retry-After, including unusually long holds.
        this.nextAllowedAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + Math.max(60_000, ms));
      }
      if (!response.ok || !response.body) throw new Error(`Phoenix public HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) { controller.abort(); throw new Error('Phoenix response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { clearTimeout(timer); this.inFlight = false; }
  }
}
