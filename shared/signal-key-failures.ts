export type SignalKeyFailureKind = 'execution_disabled' | 'execution_expired' | 'umk_unwrap' | 'policy_hmac' | 'agent_decrypt' | 'agent_invalid' | 'agent_missing' | 'subaccount_key' | 'venue_auth_rejected';
export type SignalKeyPauseOutcome = 'not_flat' | 'unavailable' | 'recently_accepted' | 'published_source';
export interface SignalKeyFailures {
  count: number;
  kind: SignalKeyFailureKind;
  firstAt: string;
  lastAt: string;
  alertedAt: string | null;
  claimedAt?: string | null;
  outcome?: SignalKeyPauseOutcome | 'paused' | 'already_paused' | null;
}
export const SIGNAL_KEY_FAILURE_PAUSE_PREFIX = 'Paused after 3 signals in a row failed:';
export function signalKeyFailurePauseReason(kind: SignalKeyFailureKind): string {
  return `${SIGNAL_KEY_FAILURE_PAUSE_PREFIX} the bot's trading key could not be used (${kind}). Re-enable automated trading or reconnect the agent wallet, then resume.`;
}
export function signalKeyFailureWarning(streak: SignalKeyFailures): string {
  const cause = streak.outcome === 'not_flat' ? 'it holds a position'
    : streak.outcome === 'recently_accepted' ? 'a recently accepted entry may still be landing'
    : 'its position could not be checked';
  if (streak.outcome === 'published_source') {
    const detail = streak.kind === 'execution_disabled' || streak.kind === 'execution_expired'
      ? 'Not paused because it is a published source. Copy-traders still receive its signals, but this bot is not trading.'
      : 'Not paused because it is a published source. Its copy-traders may still receive some of its signals, but this bot is not trading.';
    return `3 signals in a row failed (${streak.kind}). ${detail} Re-enable automated trading or reconnect the agent wallet.`;
  }
  return `3 signals in a row failed (${streak.kind}). Not paused because ${cause}; its exits will also fail until this is fixed.`;
}
