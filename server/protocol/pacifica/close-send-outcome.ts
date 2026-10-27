import type { CloseSendOutcome } from '../../trading/signal-bot-close-intent-types';

// Only errors that prove transport never entered the venue may authorize replay.
const PRE_ENTRY_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

export function classifyCloseFetchFailure(error: unknown): CloseSendOutcome {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' && PRE_ENTRY_CODES.has(cause)
    ? { kind: 'not_entered', cause }
    : { kind: 'ambiguous', cause: 'close_transport_unresolved' };
}
