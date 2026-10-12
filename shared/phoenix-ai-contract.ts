import type { PhoenixTraderIdentity } from './phoenix-read-contract';

/** AI identity is a link to U03 custody, never a second copy of its encrypted key. */
export interface PhoenixAiBinding {
  version: 1;
  aiBotId: string;
  executionBotId: string;
  identity: PhoenixTraderIdentity;
  derivationIndex: number;
  derivationPathVersion: 1;
}
