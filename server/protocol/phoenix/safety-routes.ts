export type PhoenixSafetyAction = 'close' | 'replace' | 'cancel' | 'pause' | 'breakeven' | 'withdraw';

/** Explicit venue dispatch before generic wallet decryption. Production IO remains
 * uninstalled: availability of custody/RPC is distinct from the entry kill switch.
 * No HTTP value or environment flag can install a runtime or claim safety success. */
export function phoenixSafetyUnavailable(action: PhoenixSafetyAction) {
  return { code: 'PHOENIX_SAFETY_RUNTIME_UNAVAILABLE', action,
    error: 'Phoenix safety execution is not connected. The bot and its recovery records are retained.',
    allOrdersCancelled: false, positionClosed: false, protectionState: 'unknown' as const };
}
