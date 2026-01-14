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

export async function sendTradeNotification(
  walletAddress: string | undefined | null,
  notification: TradeNotification
): Promise<boolean> {
  try {
    if (!walletAddress) {
      console.log('[Notifications] Skipping notification - no wallet address provided');
      return false;
    }

    const DIALECT_API_KEY = process.env.DIALECT_API_KEY;
    const DIALECT_APP_ID = process.env.DIALECT_APP_ID;

    if (!DIALECT_API_KEY || !DIALECT_APP_ID) {
      console.log('[Notifications] Dialect credentials not configured');
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

    const { title, body } = formatNotificationMessage(notification);
    
    console.log(`[Notifications] Sending to ${walletAddress}: ${title} - ${body}`);

    const response = await fetch(`https://alerts-api.dial.to/v2/${DIALECT_APP_ID}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dialect-api-key': DIALECT_API_KEY,
      },
      body: JSON.stringify({
        channels: ['TELEGRAM'],
        message: {
          title,
          body,
        },
        recipient: {
          type: 'subscriber',
          walletAddress: walletAddress,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Notifications] Dialect API error ${response.status}:`, errorText);
      return false;
    }

    console.log(`[Notifications] Successfully sent notification to ${walletAddress}`);
    return true;
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
        title: `Trade Executed`,
        body: `${botName}: ${side} ${market} ${sizeStr} ${priceStr}`.trim()
      };
    }
    
    case 'trade_failed':
      return {
        title: `Trade Failed`,
        body: `${botName}: ${market} - ${error || 'Unknown error'}`
      };
    
    case 'position_closed': {
      const pnlStr = pnl !== undefined 
        ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
        : '';
      const emoji = pnl !== undefined ? (pnl >= 0 ? '🟢' : '🔴') : '';
      return {
        title: `Position Closed`,
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
