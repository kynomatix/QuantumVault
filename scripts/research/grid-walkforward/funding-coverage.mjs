// Coverage indexing only: raw event timestamps and actual rates remain unchanged.
export const HOUR = 3600000;
export const SETTLEMENT_DELAY_MS = 60000;

export function assessFunding(rows, begin, end) {
  const slots = new Map(), invalid = [], conflicts = [], delays = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.time) || !Number.isFinite(row.rate)) {
      invalid.push({ time: row.time, reason: 'invalid-observed-event' }); continue;
    }
    if (row.time < begin || row.time >= end) continue;
    const slot = Math.floor(row.time / HOUR) * HOUR, delay = row.time - slot;
    if (delay > SETTLEMENT_DELAY_MS) {
      invalid.push({ time: row.time, reason: 'outside-one-minute-settlement-window' }); continue;
    }
    if (slots.has(slot) && (slots.get(slot).rate !== row.rate || slots.get(slot).time !== row.time)) {
      conflicts.push({ slot, first: slots.get(slot), second: row }); continue;
    }
    slots.set(slot, row);
    if (delay) delays.push(delay);
  }
  const missing = [], ambiguousDays = [];
  for (let t = begin; t < end; t += 8 * HOUR) if (!slots.has(t)) missing.push(new Date(t).toISOString());
  for (let t = begin; t < end; t += 24 * HOUR) {
    const daily = [...slots.keys()].filter(x => x >= t && x < Math.min(t + 24 * HOUR, end)).sort((a, b) => a - b);
    if (daily.some(x => x % (8 * HOUR) !== 0)) {
      const differences = daily.slice(1).map((x, i) => x - daily[i]);
      const cadence = Math.min(8 * HOUR, ...differences);
      if (![HOUR, 2 * HOUR, 4 * HOUR].includes(cadence) || daily.length !== Math.min(24 * HOUR, end - t) / cadence || daily.some((x, i) => x !== t + i * cadence)) ambiguousDays.push(new Date(t).toISOString());
    }
  }
  const events = [...slots.values()].sort((a, b) => a.time - b.time);
  return { rows: events.length, missingAnchors: missing.length, missing, ambiguousDays, invalid, conflicts, delayedSettlements: delays.length, maxSettlementDelayMs: Math.max(0, ...delays), first: events.length ? new Date(events[0].time).toISOString() : null, last: events.length ? new Date(events.at(-1).time).toISOString() : null, passed: missing.length === 0 && ambiguousDays.length === 0 && invalid.length === 0 && conflicts.length === 0 };
}
