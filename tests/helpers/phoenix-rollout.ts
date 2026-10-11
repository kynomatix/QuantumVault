import { vi } from 'vitest';
import type { PhoenixCanaryPolicy } from '../../server/protocol/phoenix/rollout';

/** Explicit U16 authorization for synthetic successful-entry fixtures only. */
export function grantPhoenixAiCanary(ownerWallet: string, botIds: string[]): void {
  const policy: PhoenixCanaryPolicy = {
    version: 1, authorizationId: 'EXAMPLE-owner-launch', ownerWallet, botIds, maxBots: botIds.length,
    expiresAt: Date.now() + 60_000, stage: 'trading',
    acceptedUnits: Array.from({ length: 16 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`),
    reviewedDeployment: true, recoveryDrillPassed: true,
    caps: { maxRegistrationLamports: '100', maxTransferUsdcMicros: '1000000000',
      maxExposureUsdcMicros: '1000000000', maxDebtUsdcMicros: '100', maxParkUsdcMicros: '100',
      maxCollateralRaw: '100', collateralMint: 'EXAMPLE-mint', maxLeverage: '2' },
  };
  vi.stubEnv('PHOENIX_CANARY_POLICY', JSON.stringify(policy));
  vi.stubEnv('PHOENIX_NEW_RISK_ENABLED', 'true');
  vi.stubEnv('PHOENIX_OWNER_LAUNCH_AUTHORIZED', 'true');
  vi.stubEnv('PHOENIX_AI_LIVE_ENABLED', 'true');
}
