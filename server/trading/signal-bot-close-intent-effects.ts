import type { CloseIntent, CloseScope } from './signal-bot-close-intent-types';

type Fanout = (botId: string, signal: {
  originId?: string; action: 'buy' | 'sell'; contracts: string; positionSize: string;
  price: string; isCloseSignal: boolean; strategyPositionSize: string | null; partialCloseFraction: number;
}) => Promise<unknown>;
let fanout: Fanout | undefined;
export function registerPartialCloseFanout(value: Fanout): void { fanout = value; }

/** Only confirmed execution dispatches effects. Subscriber source keys survive process restarts. */
export async function dispatchPartialCloseEffects(scope: CloseScope, initial: CloseIntent): Promise<void> {
  const { closeIntentStore: store } = await import('./close-intent-store');
  const { storage } = await import('../storage');
  const { maybeScheduleAutoRepark } = await import('../vault/auto-repark');
  let intent = (await store.byId(scope, initial.id))!;
  if (intent.status !== 'confirmed' || intent.close_kind !== 'partial' || intent.last_evidence.effectsPending !== true) return;
  if (!fanout) throw new Error('close_fanout_not_registered');
  const bot = await storage.getTradingBotById(intent.bot_id);
  if (!bot) throw new Error('close_effect_bot_missing');
  const published = await storage.getPublishedBotByTradingBotId(intent.bot_id);
  if (intent.last_evidence.fanoutDelivered !== true) {
    // Fanout is replayable: every subscriber uses this immutable execution id as
    // its source key, and admission coalesces it under that subscriber's own lock.
    if (published?.isActive) await fanout(intent.bot_id, {
      originId: intent.id, action: intent.position_side === 'long' ? 'sell' : 'buy',
      contracts: intent.requested_size_base, positionSize: String(Number(intent.original_position_size_base) - Number(intent.requested_size_base)),
      price: String((intent.last_evidence.fill as any)?.fillPrice ?? 0), isCloseSignal: false,
      strategyPositionSize: null, partialCloseFraction: Number(intent.requested_size_base) / Number(intent.original_position_size_base),
    });
    intent = await store.updateConfirmedEvidence(scope, intent, { fanoutDelivered: true });
  }
  if (intent.last_evidence.parkingDelivered !== true) {
    await maybeScheduleAutoRepark(bot);
    intent = await store.updateConfirmedEvidence(scope, intent, { parkingDelivered: true });
  }
  await store.updateConfirmedEvidence(scope, intent, { effectsPending: false });
}
