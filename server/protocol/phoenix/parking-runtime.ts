import type { TradingBot } from '../../../shared/schema';
import type { ParkingIntent } from './parking-contract';
import type { PhoenixParkingService } from './parking-service';

export const PHOENIX_PARKING_DISABLED = {
  code: 'PHOENIX_PARKING_DISABLED',
  error: 'Phoenix parking is disabled pending reviewed live queue and vault settlement proofs.',
} as const;

// Separate gate from Phoenix reads, funding and orders. An environment switch
// alone cannot supply the missing reviewed queue/vault production bindings.
export function phoenixParkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHOENIX_PARKING_ENABLED === 'true' && runtime !== null;
}
export interface PhoenixParkingRuntime {
  idle(bot: TradingBot): Promise<void>;
  recover(): Promise<void>;
}
/** Composition for a reviewed installation. idleIntent uses the persisted due
 * event for its request key and a fresh complete bot snapshot for its cash cap.
 * Recovery enumerates all active intents, including opt-out and archive. */
export function createPhoenixParkingRuntime(service: PhoenixParkingService, source: {
  idleIntent(bot: TradingBot): Promise<ParkingIntent | null>;
  pending(): Promise<ParkingIntent[]>;
  report(intent: ParkingIntent, error: unknown): void;
}): PhoenixParkingRuntime {
  return {
    async idle(bot) {
      if (bot.activeProtocol !== 'phoenix' || !bot.autoParkIdle) return;
      const intent = await source.idleIntent(bot);
      if (intent) {
        if (intent.botId !== bot.id || intent.ownerWallet !== bot.walletAddress || intent.action !== 'idle') throw new Error('Idle parking binding mismatch');
        await service.start(intent);
      }
    },
    async recover() {
      for (const intent of await source.pending()) {
        try { await service.resume(intent); } catch (error) { source.report(intent, error); }
      }
    },
  };
}
// Intentionally no production installation: live queue proofs remain unresolved.
const runtime: PhoenixParkingRuntime | null = null;
export async function dispatchPhoenixIdlePark(bot: TradingBot) {
  if (bot.activeProtocol !== 'phoenix' || !bot.autoParkIdle || !phoenixParkingEnabled()) return;
  await (runtime as PhoenixParkingRuntime | null)?.idle(bot);
}
export async function recoverPhoenixParking() {
  await (runtime as PhoenixParkingRuntime | null)?.recover();
}
