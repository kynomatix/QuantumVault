export type PhoenixSafetyAction = 'close' | 'replace' | 'cancel' | 'pause' | 'breakeven' | 'withdraw';

/** Retained response for surfaces outside the reviewed native safety routes. */
export function phoenixSafetyUnavailable(action: PhoenixSafetyAction) {
  return { code: 'PHOENIX_SAFETY_RUNTIME_UNAVAILABLE', action,
    error: 'Phoenix safety execution is not connected. The bot and its recovery records are retained.',
    allOrdersCancelled: false, positionClosed: false, protectionState: 'unknown' as const };
}

/** Owns all Phoenix outcomes before a generic protocol branch can decrypt a key. */
export async function phoenixSafetyDispatch(owner: string, botId: string, market: string,
  action: 'close' | 'replace' | 'cancel', input: Record<string, unknown>) {
  const { getPhoenixProduction } = await import('./production');
  const production = getPhoenixProduction();
  if (!production) return { status: 503, body: phoenixSafetyUnavailable(action) };
  try {
    return { status: 200, body: await production.execution.safety(owner, botId, market, action, input) };
  } catch {
    return { status: 409, body: { code: 'PHOENIX_SAFETY_AUTHORITY_UNAVAILABLE', action,
      error: 'Phoenix safety request could not establish its authoritative result. Retained attempts must be reconciled before retrying.',
      allOrdersCancelled: false, positionClosed: false, protectionState: 'unknown' as const } };
  }
}
