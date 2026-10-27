import type { CloseIntent } from './signal-bot-close-intent-types';

type Fanout = (botId: string, signal: {
  originId?: string; action: 'buy' | 'sell'; contracts: string; positionSize: string;
  price: string; isCloseSignal: boolean; strategyPositionSize: string | null; partialCloseFraction: number;
}) => Promise<unknown>;
let fanout: Fanout | undefined;
export function registerPartialCloseFanout(value: Fanout): void { fanout = value; }

// Live requests finish after confirmation. Durable flags are the restart backstop.
const scheduled = new Set<Promise<void>>();
export function scheduleCloseEffects(intent: CloseIntent): void {
  if (intent.last_evidence.effectsPending !== true && intent.last_evidence.notificationPending !== true) return;
  const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => dispatchConfirmedCloseEffects(intent));
  scheduled.add(task);
  void task.then(() => scheduled.delete(task), () => scheduled.delete(task));
}
/** Drain admitted local work, including subscriber completions, before shutdown or fixture teardown. */
export async function waitForCloseEffects(): Promise<void> {
  while (scheduled.size) await Promise.all([...scheduled]);
}

async function readOrUpdate(initial: CloseIntent, evidence?: Record<string, unknown>): Promise<CloseIntent> {
  const { closeIntentStore: store } = await import('./close-intent-store');
  return (await store.withScope(initial.environment, initial.original_account, initial.market, async scope => {
    const current = await store.byId(scope, initial.id);
    if (!current || current.status !== 'confirmed') throw new Error('close_effect_identity_missing');
    return evidence ? store.updateConfirmedEvidence(scope, current, evidence) : current;
  }))!;
}

/** Keep a spare pool connection for evidence writes and subscriber trading scopes. */
let deliveryQueue: Promise<void> = Promise.resolve();
export function dispatchConfirmedCloseEffects(initial: CloseIntent): Promise<void> {
  const task = deliveryQueue.then(() => deliverConfirmedCloseEffects(initial));
  deliveryQueue = task.catch(() => {});
  return task;
}

/** A separate execution lock serializes cross-process replays; trading locks cover only evidence writes. */
async function deliverConfirmedCloseEffects(initial: CloseIntent): Promise<void> {
  const { closeIntentStore: store } = await import('./close-intent-store');
  try {
    await store.withEffects(initial.id, async () => {
      let intent = await readOrUpdate(initial);
      if (intent.last_evidence.effectsPending === true) await dispatchPartialCloseEffects(intent);
      intent = await readOrUpdate(initial);
      const fill = intent.last_evidence.fill as import('./signal-bot-close-intent-accounting').IntentFill | null;
      if (fill) {
        const { notifyDurableClose } = await import('./signal-bot-close-intent-accounting');
        await notifyDurableClose(intent, fill);
      }
    });
  } catch {
    // The confirmed reply is independent of delivery. The due worker retries with bounded backoff.
    await store.withScope(initial.environment, initial.original_account, initial.market, async scope => {
      const current = await store.byId(scope, initial.id);
      if (current?.status === 'confirmed') await store.recordRepairFailure(scope, current);
    }).catch(() => {});
  }
}

/** Only source partials fan out. Subscriber partials had no fanout or notification before Slice B. */
export async function dispatchPartialCloseEffects(initial: CloseIntent): Promise<void> {
  const { storage } = await import('../storage');
  const { maybeScheduleAutoRepark } = await import('../vault/auto-repark');
  let intent = await readOrUpdate(initial);
  if (intent.close_kind !== 'partial' || intent.last_evidence.effectsPending !== true) return;
  if (intent.authority_ref.subscriberAccounting === true) {
    await readOrUpdate(intent, { effectsPending: false, notificationPending: false }); return;
  }
  const bot = await storage.getTradingBotById(intent.bot_id);
  if (!bot) throw new Error('close_effect_bot_missing');
  const published = await storage.getPublishedBotByTradingBotId(intent.bot_id);
  if (intent.last_evidence.fanoutDelivered !== true) {
    if (published?.isActive) {
      if (!fanout) throw new Error('close_fanout_not_registered');
      await fanout(intent.bot_id, {
        originId: intent.id, action: intent.position_side === 'long' ? 'sell' : 'buy',
        contracts: intent.requested_size_base, positionSize: String(Number(intent.original_position_size_base) - Number(intent.requested_size_base)),
        price: String((intent.last_evidence.fill as any)?.fillPrice ?? 0), isCloseSignal: false,
        strategyPositionSize: null, partialCloseFraction: Number(intent.requested_size_base) / Number(intent.original_position_size_base),
      });
    }
    intent = await readOrUpdate(intent, { fanoutDelivered: true });
  }
  if (intent.last_evidence.parkingDelivered !== true) {
    await maybeScheduleAutoRepark(bot);
    intent = await readOrUpdate(intent, { parkingDelivered: true });
  }
  await readOrUpdate(intent, { effectsPending: false });
}
