import type { PhoenixAiTraderService } from './phoenix-live';
import { phoenixAiFlags } from './phoenix-capabilities';

// U03/U04/U05 require reviewed production pins and IO. An environment variable
// cannot install them. This is deliberately consistent with the shared core.
let installed: PhoenixAiTraderService | null = null;
/** Explicit composition with reviewed shared-core IO; never called by a flag. */
export function installPhoenixAiTrader(service: PhoenixAiTraderService | null) { installed = service; }
export function getPhoenixAiService(): PhoenixAiTraderService | null { return installed; }
export const getPhoenixAiTrader = getPhoenixAiService;
export function phoenixAiLiveAvailable() { return phoenixAiFlags().live && installed !== null; }
