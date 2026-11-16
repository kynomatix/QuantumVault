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
  bot: TradingBot, reason: string, agentPublicKey: string,
  botCtx: { botPublicKey: string } | null, notify = true,
): Promise<boolean> {
  const release = await acquireSignalBotEntryLock(bot.id);
  try {
    try {
      const position = await storage.getBotPosition(bot.id, bot.market);
      if (position && Number(position.baseSize) !== 0) return false;
      const acceptedAt = signalBotAcceptedEntries.get(bot.id);
      if (acceptedAt !== undefined && Date.now() - acceptedAt < 120_000) return false;
      const botPublicKey = bot.protocolSubaccountId ?? botCtx?.botPublicKey;
      const venue = await PositionService.getPositionForCloseAuthority(
        bot.id, botPublicKey ?? agentPublicKey,
        botPublicKey ? 0 : bot.driftSubaccountId ?? 0, bot.market, botPublicKey,
      );
      if (venue.side !== 'FLAT' || venue.size !== 0) return false;
      signalBotAcceptedEntries.delete(bot.id);
    } catch (error) {
      console.error('[Signal Bot] Auto-pause skipped: position authority unavailable', error);
      return false;
    }
    await storage.updateTradingBot(bot.id, { isActive: false, pauseReason: reason } as any);
    if (notify) sendTradeNotification(bot.walletAddress, {
      type: 'trade_failed', botName: bot.name, market: bot.market, error: `Bot paused: ${reason}`,
    }).catch(error => console.error('[Signal Bot] Pause notification failed:', error));
    return true;
  } finally { release(); }
}
