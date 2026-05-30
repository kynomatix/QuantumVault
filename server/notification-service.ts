import { db } from "./db";
import { wallets } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface TradeNotification {
  type: 'trade_executed' | 'trade_failed' | 'position_closed' | 'partial_close';
  botName: string;
  market: string;
  side?: 'LONG' | 'SHORT';
  size?: number;
  price?: number;
  pnl?: number;
  error?: string;
  /** Human-readable close reason, only used for `position_closed`. */
  closeReason?: string;
  /** Fraction of position closed [0,1], only used for `partial_close`. */
  closedFraction?: number;
  /** Original full position size before partial close, only for `partial_close`. */
  originalPositionSize?: number;
  /** Number of coalesced stages (multi-stage exit), only for `partial_close`. */
  stageCount?: number;
}

/**
 * Pure helper: maps a reconciler close-detection reason (and optional TP/SL
 * subtype) to the user-facing string surfaced in Telegram alerts. Keep
 * exported so manual-close / reconciler / future callers stay consistent.
 */
export function getCloseReasonLabel(
  reason: 'tpsl' | 'liquidation' | 'external_close' | 'manual' | 'partial_tp' | 'partial_sl',
  tpslSubtype?: 'TP' | 'SL',
): string {
  switch (reason) {
    case 'tpsl':
      if (tpslSubtype === 'TP') return 'Closed by Take Profit';
      if (tpslSubtype === 'SL') return 'Closed by Stop Loss';
      return 'Closed by TP/SL';
    case 'partial_tp':
      return 'Partial Take Profit';
    case 'partial_sl':
      return 'Partial Stop Loss';
    case 'liquidation':
      return 'Liquidated';
    case 'manual':
      return 'Closed manually';
    case 'external_close':
    default:
      return 'Closed on exchange';
  }
}

/**
 * Build the standard inline keyboard attached to outbound notifications and
 * the /menu home screen. Only the 🚀 Open Mini App `web_app` button is
 * shipped — the previous 📊 Positions and 📈 Today callback_query buttons
 * timed out on tap (no handler) so they were removed at user request.
 * web_app buttons can only appear inside `inline_keyboard` (not
 * reply_keyboard) — keep the markup shape.
 */
export function buildDefaultInlineKeyboard(): Record<string, any> {
  const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || 'https://myquantumvault.com/tg';
  return {
    inline_keyboard: [
      [
        { text: '🚀 Open Mini App', web_app: { url: miniAppUrl } },
      ],
    ],
  };
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, any>,
): Promise<boolean> {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const body: Record<string, any> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`[Telegram] API error ${response.status}:`, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] Error sending message:', error);
    return false;
  }
}

export async function sendTradeNotification(
  walletAddress: string | undefined | null,
  notification: TradeNotification
): Promise<boolean> {
  try {
    if (!walletAddress) {
      console.log('[Notifications] Skipping notification - no wallet address provided');
      return false;
    }

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    if (!wallet) {
      console.log(`[Notifications] Wallet not found: ${walletAddress}`);
      return false;
    }

    if (!wallet.notificationsEnabled) {
      console.log(`[Notifications] Notifications disabled for ${walletAddress}`);
      return false;
    }

    const shouldNotify = 
      (notification.type === 'trade_executed' && wallet.notifyTradeExecuted) ||
      (notification.type === 'trade_failed' && wallet.notifyTradeFailed) ||
      (notification.type === 'position_closed' && wallet.notifyPositionClosed) ||
      // partial_close ties to the same flag as position_closed
      (notification.type === 'partial_close' && wallet.notifyPositionClosed);

    if (!shouldNotify) {
      console.log(`[Notifications] Notification type ${notification.type} disabled for ${walletAddress}`);
      return false;
    }

    if (!wallet.telegramChatId) {
      console.log(`[Notifications] No Telegram chat ID for ${walletAddress}`);
      return false;
    }

    const { title, body } = formatNotificationMessage(notification);
    const message = `<b>${title}</b>\n${body}`;
    
    console.log(`[Notifications] Sending Telegram to ${walletAddress}: ${title} - ${body}`);

    const success = await sendTelegramMessage(
      wallet.telegramChatId,
      message,
      buildDefaultInlineKeyboard(),
    );
    
    if (success) {
      console.log(`[Notifications] Successfully sent Telegram notification to ${walletAddress}`);
    }
    
    return success;
  } catch (error) {
    console.error('[Notifications] Error sending notification:', error);
    return false;
  }
}

function formatNotificationMessage(notification: TradeNotification): { title: string; body: string } {
  const { type, botName, market, side, size, price, pnl, error } = notification;
  
  switch (type) {
    case 'trade_executed': {
      const sizeStr = size ? `$${size.toFixed(2)}` : '';
      const priceStr = price ? `@ $${price.toFixed(2)}` : '';
      return {
        title: `✅ Trade Executed`,
        body: `${botName}: ${side} ${market} ${sizeStr} ${priceStr}`.trim()
      };
    }
    
    case 'trade_failed':
      return {
        title: `❌ Trade Failed`,
        body: `${botName}: ${market} - ${error || 'Unknown error'}`
      };
    
    case 'position_closed': {
      const pnlStr = pnl !== undefined 
        ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '';
      const reasonSuffix = notification.closeReason ? ` (${notification.closeReason})` : '';
      return {
        title: `📊 Position Closed`,
        body: `${emoji} ${botName}: ${market} ${pnlStr}${reasonSuffix}`.trim()
      };
    }

    case 'partial_close': {
      const fraction = notification.closedFraction ?? 0;
      const pctStr = `${Math.round(fraction * 100)}%`;
      const pnlStr = pnl !== undefined
        ? (pnl >= 0 ? ` +$${pnl.toFixed(2)}` : ` -$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '📉';
      const priceStr = price ? ` @ $${price.toFixed(2)}` : '';
      const stageNote = (notification.stageCount ?? 1) > 1
        ? ` (${notification.stageCount} stages)` : '';
      const sideStr = side ?? '';
      return {
        title: `📉 Partial Exit`,
        body: `${emoji} ${botName}: closed ${pctStr} of ${sideStr} ${market}${priceStr}${pnlStr}${stageNote}`.trim()
      };
    }
    
    default:
      return { title: 'QuantumVault', body: `${botName}: ${type}` };
  }
}

// ── Partial-close notification debouncer ────────────────────────────────────
// Multi-stage exits (e.g. 3 partials in 5 s) are coalesced into a single
// alert so the user doesn't get spammed. The window is ~20 s; any additional
// partial arriving within the window extends the timer and accumulates its PnL.

interface PendingPartialNotif {
  timer: ReturnType<typeof setTimeout>;
  walletAddress: string;
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  totalClosedFraction: number;
  totalRealizedPnl: number;
  lastPrice: number;
  stageCount: number;
}

const pendingPartialNotifs = new Map<string, PendingPartialNotif>();
const PARTIAL_DEBOUNCE_MS = 20_000;

/**
 * Schedule a partial-close Telegram notification, coalescing multiple stages
 * arriving within PARTIAL_DEBOUNCE_MS into a single message.
 *
 * Key: `${walletAddress}:${botId}:${market}` — each bot-market combo has its
 * own debounce bucket so concurrent bots don't interfere.
 */
export function schedulePartialCloseNotification(opts: {
  walletAddress: string;
  botId: string;
  botName: string;
  market: string;
  side: 'LONG' | 'SHORT';
  closedFraction: number;
  realizedPnl: number;
  price: number;
}): void {
  const key = `${opts.walletAddress}:${opts.botId}:${opts.market}`;
  const existing = pendingPartialNotifs.get(key);

  if (existing) {
    // Coalesce: accumulate and reset the timer.
    clearTimeout(existing.timer);
    existing.totalClosedFraction = Math.min(existing.totalClosedFraction + opts.closedFraction, 1);
    existing.totalRealizedPnl += opts.realizedPnl;
    existing.lastPrice = opts.price;
    existing.stageCount += 1;
    existing.timer = setTimeout(() => firePartialNotif(key), PARTIAL_DEBOUNCE_MS);
  } else {
    const pending: PendingPartialNotif = {
      walletAddress: opts.walletAddress,
      botName: opts.botName,
      market: opts.market,
      side: opts.side,
      totalClosedFraction: opts.closedFraction,
      totalRealizedPnl: opts.realizedPnl,
      lastPrice: opts.price,
      stageCount: 1,
      timer: setTimeout(() => firePartialNotif(key), PARTIAL_DEBOUNCE_MS),
    };
    pendingPartialNotifs.set(key, pending);
  }
}

function firePartialNotif(key: string): void {
  const pending = pendingPartialNotifs.get(key);
  if (!pending) return;
  pendingPartialNotifs.delete(key);

  sendTradeNotification(pending.walletAddress, {
    type: 'partial_close',
    botName: pending.botName,
    market: pending.market,
    side: pending.side,
    price: pending.lastPrice,
    pnl: pending.totalRealizedPnl,
    closedFraction: pending.totalClosedFraction,
    stageCount: pending.stageCount,
  }).catch(err => console.error('[Notifications] Partial-close notification error:', err));
}

export async function updateNotificationSettings(
  walletAddress: string,
  settings: {
    notificationsEnabled?: boolean;
    notifyTradeExecuted?: boolean;
    notifyTradeFailed?: boolean;
    notifyPositionClosed?: boolean;
    telegramConnected?: boolean;
    telegramChatId?: string | null;
  }
): Promise<boolean> {
  try {
    await db
      .update(wallets)
      .set(settings)
      .where(eq(wallets.address, walletAddress));
    
    return true;
  } catch (error) {
    console.error('[Notifications] Error updating settings:', error);
    return false;
  }
}

export async function getNotificationSettings(walletAddress: string) {
  try {
    const [wallet] = await db
      .select({
        notificationsEnabled: wallets.notificationsEnabled,
        notifyTradeExecuted: wallets.notifyTradeExecuted,
        notifyTradeFailed: wallets.notifyTradeFailed,
        notifyPositionClosed: wallets.notifyPositionClosed,
        telegramConnected: wallets.telegramConnected,
        telegramChatId: wallets.telegramChatId,
      })
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);

    return wallet || null;
  } catch (error) {
    console.error('[Notifications] Error getting settings:', error);
    return null;
  }
}
