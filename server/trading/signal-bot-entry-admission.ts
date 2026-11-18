import type { TradingBot } from '@shared/schema';
import type { AvailableFeeRateQuote } from '../protocol/adapter';
import { storage } from '../storage';
import { PositionService } from '../position-service';
import { sendTradeNotification } from '../notification-service';

interface SignalBotEntryResult {
  success: boolean;
  signature?: string;
  txSignature?: string;
  error?: string;
  fillPrice?: number;
  actualFee?: number;
  admissionFeeQuote?: AvailableFeeRateQuote;
  submissionUnconfirmed?: boolean;
  executionMethod?: string;
  swiftOrderId?: string | null;
  keyFailureKind?: import('@shared/signal-key-failures').SignalKeyFailureKind;
  signingKeyUsed?: boolean;
}

// One process, one queue per bot. Closes never acquire this lock.
const signalBotEntryLocks = new Map<string, Promise<void>>();
const signalBotAcceptedEntries = new Map<string, number>();
// Test isolation only; production callers never clear the invisible-fill guard.
export function resetSignalBotAcceptedEntriesForTests(): void {
  signalBotAcceptedEntries.clear();
}
async function acquireSignalBotEntryLock(botId: string): Promise<() => void> {
  const previous = signalBotEntryLocks.get(botId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  signalBotEntryLocks.set(botId, current);
  await previous;
  return () => {
    if (signalBotEntryLocks.get(botId) === current) signalBotEntryLocks.delete(botId);
    release();
  };
}
export async function executeSignalBotEntry(bot: Pick<TradingBot, 'id'>, submit: () => Promise<SignalBotEntryResult>): Promise<SignalBotEntryResult> {
  const release = await acquireSignalBotEntryLock(bot.id);
  try {
    const current = await storage.getTradingBotById(bot.id);
    if (!current?.isActive) return { success: false, error: 'Bot is paused' };
    const wallet = await storage.getWallet(current.walletAddress);
    if (!wallet) return { success: false, error: 'Wallet not found' };
    if (wallet.emergencyStopTriggered) return { success: false, error: 'Trade execution blocked: Emergency stop is active for this wallet' };
    if (!wallet.executionEnabled) return { success: false, error: 'Trade execution disabled. Please enable automated trading in the app.' };
    if (wallet.executionExpiresAt && Date.now() > new Date(wallet.executionExpiresAt).getTime()) {
      return { success: false, error: 'Trade execution authorization expired. Please re-enable automated trading.' };
    }
    const result = await submit();
    // Pacifica may acknowledge a submission before either position read sees it.
    if (result.success || result.submissionUnconfirmed) signalBotAcceptedEntries.set(bot.id, Date.now());
    return result;
  } finally { release(); }
}

// A sizing failure is permission to pause only after current DB and strict
// venue truth both prove flat. Never interpret unavailable authority as zero.
export async function pauseSignalBotIfFlat(
  bot: TradingBot, reason: string, agentPublicKey: string | null,
  botCtx: { botPublicKey: string } | null, notify = true, firstAt?: string, claimedAt?: string,
): Promise<'paused' | 'already_paused' | 'not_flat' | 'unavailable' | 'recently_accepted' | 'published_source'> {
  const release = await acquireSignalBotEntryLock(bot.id);
  try {
    const current = await storage.getTradingBotById(bot.id);
    if (!current?.isActive) return 'already_paused';
    bot = current;
    if (firstAt !== undefined && (bot.stats?.signalKeyFailures?.firstAt !== firstAt || bot.stats.signalKeyFailures.claimedAt !== claimedAt)) return 'already_paused';
    try {
      const position = await storage.getBotPosition(bot.id, bot.market);
      if (position && Number(position.baseSize) !== 0) return 'not_flat';
      const acceptedAt = signalBotAcceptedEntries.get(bot.id);
      if (acceptedAt !== undefined && Date.now() - acceptedAt < 120_000) return 'recently_accepted';
      const botPublicKey = bot.protocolSubaccountId ?? botCtx?.botPublicKey;
      const queryAccount = botPublicKey ?? (firstAt === undefined
        ? agentPublicKey : (await storage.getWallet(bot.walletAddress))?.agentPublicKey);
      if (!queryAccount) return 'unavailable';
      const venue = await PositionService.getPositionForCloseAuthority(
        bot.id, queryAccount,
        botPublicKey ? 0 : bot.driftSubaccountId ?? 0, bot.market, botPublicKey,
      );
      if (venue.side !== 'FLAT' || venue.size !== 0) return 'not_flat';
      signalBotAcceptedEntries.delete(bot.id);
    } catch (error) {
      console.error('[Signal Bot] Auto-pause skipped: position authority unavailable', error);
      return 'unavailable';
    }
    const paused = await storage.pauseActiveSignalBot(bot.id, reason, firstAt, claimedAt);
    if (!paused) {
      if (firstAt !== undefined && await storage.getPublishedBotByTradingBotId(bot.id)) return 'published_source';
      return 'already_paused';
    }
    if (notify) sendTradeNotification(bot.walletAddress, {
      type: 'trade_failed', botName: bot.name, market: bot.market, error: `Bot paused: ${reason}`,
    }).catch(error => console.error('[Signal Bot] Pause notification failed:', error));
    return 'paused';
  } finally { release(); }
}
