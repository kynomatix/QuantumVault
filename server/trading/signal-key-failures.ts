import type { TradingBot } from '@shared/schema';
import { signalKeyFailurePauseReason, signalKeyFailureWarning, type SignalKeyFailureKind, type SignalKeyFailures } from '@shared/signal-key-failures';
import { storage } from '../storage';
import { sendTradeNotification } from '../notification-service';
import { pauseSignalBotIfFlat } from './signal-bot-entry-admission';

// Only structured venue auth or signing resolver metadata counts. Lock refusals are deliberately
// absent: their text also appears in unrelated, non-signing execution failures.
export function signingKeyFailure(error: { code?: string; message?: string; venue?: string; httpStatus?: number; keyFailureKind?: string }): SignalKeyFailureKind | undefined {
  if (error.venue === 'pacifica' && (error.httpStatus === 401 || error.httpStatus === 403)
    && error.keyFailureKind === 'venue_auth_rejected') return 'venue_auth_rejected';
  return error.code === 'EXECUTION_AUTHORIZATION_REQUIRED'
    || error.message?.startsWith('Cannot decrypt bot subaccount key for ')
    || error.message?.startsWith('Failed to decrypt bot subaccount key for ')
    ? 'subaccount_key' : undefined;
}

// Local preparation and unconfirmed dispatches provide no signing proof.
export function venueSigningKeyUsed(result: { success: boolean; status?: string; landingDisposition?: string;
  keyFailureKind?: string; signingKeyUsed?: boolean; constraintRejection?: unknown; error?: string }): boolean {
  return result.signingKeyUsed !== false && !result.keyFailureKind && !result.constraintRejection && !result.error?.includes('FEE_RATE_UNAVAILABLE')
    && (result.success || (result.status === 'rejected' && result.landingDisposition === 'terminal'));
}

type TransitionNoticeResult = 'completed' | 'superseded' | 'failed';

export function signalKeyFailureTracker(bot: TradingBot) {
  let counted = false;
  let transitionNotice: TransitionNoticeResult | undefined;
  const eligible = bot.isActive && bot.activeProtocol !== 'phoenix' && bot.activeProtocol !== 'flash';
  let pending = Promise.resolve<TransitionNoticeResult | undefined>(undefined);
  function isolated(work: () => Promise<TransitionNoticeResult | undefined>) {
    pending = pending.then(work).catch(error => {
      console.error('[SignalKeyFailures] Tracker failed for bot', bot.id, error);
      return transitionNotice;
    });
    return pending;
  }
  async function notice(streak: SignalKeyFailures,
    outcome: NonNullable<SignalKeyFailures['outcome']>): Promise<TransitionNoticeResult> {
    const requireActive = outcome !== 'paused';
    const claimedAt = await storage.refreshSignalKeyFailureAlert(bot.id, streak.firstAt, streak.claimedAt!, requireActive);
    if (!claimedAt) {
      if (requireActive) {
        const current = await storage.getTradingBotById(bot.id);
        const currentStreak = current?.stats?.signalKeyFailures;
        if (current && !current.isActive && currentStreak?.firstAt === streak.firstAt
          && currentStreak.claimedAt === streak.claimedAt && await storage.setSignalKeyFailurePauseOutcome(
          bot.id, streak.firstAt, 'already_paused', streak.claimedAt!,
        )) return transitionNotice = 'completed';
      }
      return transitionNotice = 'superseded';
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sendTradeNotification(bot.walletAddress, { type: 'bot_paused', botName: bot.name, market: bot.market,
          error: outcome === 'paused' ? signalKeyFailurePauseReason(streak.kind) : signalKeyFailureWarning({ ...streak, outcome }) },
          { signal: controller.signal, throwOnDeliveryError: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('key_failure_notice_timeout'));
        }, 10_000); }),
      ]);
      // false is a deliberate preference/recipient skip. Delivery and lookup failures throw.
      transitionNotice = 'completed';
    } finally { if (timer) clearTimeout(timer); }
    await storage.setSignalKeyFailurePauseOutcome(bot.id, streak.firstAt, outcome, claimedAt);
    return transitionNotice;
  }
  async function fail(kind: SignalKeyFailureKind): Promise<TransitionNoticeResult | undefined> {
    if (!eligible || counted) return transitionNotice;
    counted = true;
    const streak = await storage.incrementSignalKeyFailure(bot.id, kind);
    if (!streak || streak.count < 3) return;
    const claimedAt = await storage.claimSignalKeyFailureAlert(bot.id, streak.firstAt);
    if (!claimedAt) return;
    transitionNotice = 'failed';
    const listing = await storage.getPublishedBotByTradingBotId(bot.id);
    const result = listing ? 'published_source' : kind === 'agent_missing' ? 'unavailable'
      : await pauseSignalBotIfFlat(bot, signalKeyFailurePauseReason(kind), null, null, false, streak.firstAt, claimedAt);
    if (result !== 'paused') {
      const current = await storage.getTradingBotById(bot.id);
      const ownsLease = current?.stats?.signalKeyFailures?.firstAt === streak.firstAt
        && current.stats.signalKeyFailures.claimedAt === claimedAt;
      // A replacement generation or lease belongs entirely to its new claimant.
      if (!ownsLease) return transitionNotice = 'superseded';
      if (!current?.isActive || result === 'already_paused') {
        await storage.setSignalKeyFailurePauseOutcome(bot.id, streak.firstAt, 'already_paused', claimedAt);
        return transitionNotice = 'completed';
      }
    }
    // Refresh the lease at the send boundary, including a committed pause's owed notice.
    return notice({ ...streak, claimedAt }, result);
  }
  return {
    fail: (kind: SignalKeyFailureKind) => isolated(() => fail(kind)),
    // Kept for route cleanup compatibility. Decryption alone never clears a streak.
    async agentDecrypted() {},
    async finish() { await pending; },
    recover: () => isolated(async () => {
      if (bot.isActive || bot.activeProtocol === 'phoenix' || bot.activeProtocol === 'flash') return;
      const streak = await storage.reclaimPausedSignalKeyFailureNotice(bot.id);
      if (!streak) return;
      transitionNotice = 'failed';
      return notice(streak, 'paused');
    }),
    observe: (result: { keyFailureKind?: SignalKeyFailureKind; signingKeyUsed?: boolean }) => isolated(async () => {
      if (result.keyFailureKind) return fail(result.keyFailureKind);
      if (eligible && result.signingKeyUsed) await storage.clearSignalKeyFailures(bot.id);
    }),
  };
}
