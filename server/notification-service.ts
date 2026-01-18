import { db } from "./db";
import { wallets } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface TradeNotification {
  type: 'trade_executed' | 'trade_failed' | 'position_closed';
  botName: string;
  market: string;
  side?: 'LONG' | 'SHORT';
  size?: number;
  price?: number;
  pnl?: number;
  error?: string;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
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
      (notification.type === 'position_closed' && wallet.notifyPositionClosed);

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

    const success = await sendTelegramMessage(wallet.telegramChatId, message);
    
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
      return {
        title: `📊 Position Closed`,
        body: `${emoji} ${botName}: ${market} ${pnlStr}`.trim()
      };
    }
    
    default:
      return { title: 'QuantumVault', body: `${botName}: ${type}` };
  }
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
        dialectAddress: wallets.dialectAddress,
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
