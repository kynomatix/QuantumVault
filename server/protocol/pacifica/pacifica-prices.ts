/** Pacifica GET /info/prices: retain venue observations, never substitute mark/oracle for mid. */
export type PacificaPriceObservation = { price: number; observedAt: number };

export function freshPacificaPrice(observation: PacificaPriceObservation, now: number, maxAgeMs: number): boolean {
  return Number.isFinite(observation.price) && observation.price > 0
    && Number.isSafeInteger(observation.observedAt) && observation.observedAt > 0
    && observation.observedAt <= now && now - observation.observedAt < maxAgeMs;
}

export function parsePacificaPrices(payload: unknown, now: number, maxAgeMs: number): Map<string, PacificaPriceObservation> {
  const result = new Map<string, PacificaPriceObservation>();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result;
  const envelope = payload as { success?: unknown; data?: unknown };
  if (envelope.success !== true || !Array.isArray(envelope.data)) return result;
  const seen = new Set<string>();
  for (const row of envelope.data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { symbol, mid, timestamp } = row as Record<string, unknown>;
    if (typeof symbol !== 'string' || symbol.trim() !== symbol || !/^[A-Za-z0-9-]+$/.test(symbol)) continue;
    // Conflicting/duplicate observations are unavailable regardless of row order.
    if (seen.has(symbol)) { result.delete(symbol); continue; }
    seen.add(symbol);
    if (typeof mid !== 'string' || mid.length > 37 || !/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(mid)
      || typeof timestamp !== 'number') continue;
    const observation = { price: Number(mid), observedAt: timestamp };
    if (freshPacificaPrice(observation, now, maxAgeMs)) result.set(symbol, observation);
  }
  return result;
}
