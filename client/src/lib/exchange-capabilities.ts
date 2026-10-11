import type { PhoenixReadCapabilities } from '@shared/phoenix-read-contract';

const LABELS: Record<string, string> = {
  pacifica: 'Pacifica', flash: 'Flash', drift: 'Drift', phoenix: 'Phoenix',
};

export function getExchangeLabel(protocol?: string | null): string {
  return protocol ? LABELS[protocol.toLowerCase()] ?? protocol : 'Unknown';
}

/** Display policy only. Server authorization remains authoritative.
 * U04 exposes public reads, not an accepted live rollout or account eligibility.
 * U08–U14 money routes are disabled. Public-read readiness cannot enable them.
 */
export function getExchangeUiCapabilities(protocol?: string | null) {
  const phoenix = protocol?.toLowerCase() === 'phoenix';
  return {
    moneyControls: !phoenix,
    create: !phoenix && protocol !== 'drift',
    subscribe: !phoenix,
    borrow: !phoenix,
    vault: !phoenix,
  };
}

export function phoenixPublicReadsReady(capabilities?: PhoenixReadCapabilities | null): boolean {
  return capabilities?.venue === 'phoenix' && capabilities.enabled
    && capabilities.mode === 'read-only' && capabilities.publicReads === 'ready';
}
